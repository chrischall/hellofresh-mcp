// Favourites and ratings (docs/HELLOFRESH-API.md "Added 2026-11-12"):
//
//   hf_list_favorites    — read: the user's favourite recipe ids (never the
//                          customer uuid each item carries), named from a
//                          week's menu when one is given;
//   hf_list_ratings      — read: the user's own recipe ratings on the v2 and/or
//                          v3 (5-star) scale. The list's item shape is NOT yet
//                          observed, so items are parsed defensively and the
//                          unparseable ones are skipped and counted;
//   hf_favorite_recipe /
//   hf_unfavorite_recipe — confirm-gated writes (each the other's inverse, so
//                          neither is destructive), verified by re-reading the
//                          favourites list.
//
// There is deliberately NO rating write: the rate call is not verified live
// (it needs a delivered box), see the API doc.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { McpToolError, minifiedResult, toolAnnotations } from '@chrischall/mcp-utils';
import { addFavoriteRequest, removeFavoriteRequest, type HelloFreshClient } from '../client.js';
import { projectDelivery, projectFavorites, type ProjectedMenu, type RatingScaleName } from '../normalize.js';
import { foodMeta } from './hints.js';
import { RATING_SCALES, attempt, loadAccount, readMenu, readRatings, weekParam, type Account } from './shared.js';
import { CHANGE, registerGated, sendAndVerify, shown, type GateFields } from './writes/shared.js';
import type { ToolDeps } from './index.js';

const readOnly = (title: string) => toolAnnotations({ title, readOnly: true, idempotent: true, openWorld: true });

/** Every recipe on the menu (base courses and their protein swaps): recipe id → menu index + name. */
function recipesOf(menu: ProjectedMenu): Map<string, { index: number; name?: string }> {
  const recipes = new Map<string, { index: number; name?: string }>();
  for (const m of menu.meals) {
    if (m.recipeId) recipes.set(m.recipeId, { index: m.index, name: m.name });
    for (const v of m.variants) if (v.recipeId) recipes.set(v.recipeId, { index: v.index, name: v.name ?? v.title });
  }
  return recipes;
}

/** The week's menu, best effort: its recipes, or the reason it could not be read. */
async function weekRecipes(client: HelloFreshClient, week: string) {
  return attempt(async () => {
    const account = await loadAccount(client);
    const delivery = projectDelivery(await client.getDelivery(account.subscriptionId, week));
    return recipesOf(await readMenu(client, account, delivery, week));
  });
}

/** Name each item found on the week's menu (best effort); `menuError` when the menu could not be read. */
async function nameFromWeek<T extends { recipeId: string }>(client: HelloFreshClient, items: T[], week: string | undefined) {
  if (!week) return { items, extra: {} };
  const recipes = await weekRecipes(client, week);
  if (!recipes.ok) return { items, extra: { menuError: recipes.reason } };
  const named = items.map((item) => {
    const hit = recipes.value.get(item.recipeId);
    return hit ? { ...item, menuWeek: week, index: hit.index, ...(hit.name ? { name: hit.name } : {}) } : item;
  });
  return { items: named, extra: { onMenu: named.filter((i) => 'index' in i).length } };
}

const optionalWeek = weekParam
  .optional()
  .describe('A delivery week (ISO, e.g. 2026-W49): items on that week’s menu are named with their menu index.');

export function registerFavoriteTools(server: McpServer, deps: ToolDeps): void {
  const { client } = deps;

  server.registerTool(
    'hf_list_favorites',
    {
      description:
        'List the recipes the user favourited on HelloFresh (recipe ids and when). Give a week to name the ones on ' +
        'that week’s menu with their menu index (hf_favorite_recipe / hf_unfavorite_recipe take that index). ' +
        'hf_suggest_meals and hf_weekly_plan already favour these recipes.',
      annotations: readOnly('HelloFresh: list favourite recipes'),
      _meta: foodMeta('lookup', { aliases: ['hellofresh favorites', 'favourite recipes', 'saved recipes'] }),
      inputSchema: z.object({ week: optionalWeek }),
    },
    async ({ week }) => {
      const { total, favorites } = projectFavorites(await client.listFavorites());
      const { items, extra } = await nameFromWeek(client, favorites, week);
      return minifiedResult({ ...(total !== undefined ? { total } : {}), favorites: items, ...extra });
    },
  );

  server.registerTool(
    'hf_list_ratings',
    {
      description:
        'List the user’s own HelloFresh recipe ratings (both rating scales by default: v2, and v3 = 5 stars). Give a ' +
        'week to name the rated recipes on that week’s menu. The planner never suggests a recipe rated 2 or lower. ' +
        'The ratings list’s item shape has not been observed yet, so items without a recipe id and a numeric rating ' +
        'are skipped and counted, not guessed at. Read-only: rating a recipe is not supported.',
      annotations: readOnly('HelloFresh: list recipe ratings'),
      _meta: foodMeta('lookup', { aliases: ['hellofresh ratings', 'rated recipes', 'my recipe ratings'] }),
      inputSchema: z.object({
        week: optionalWeek,
        scale: z.enum(['v2', 'v3']).optional().describe('One rating scale only (v3 = 5 stars). Default: both.'),
      }),
    },
    async ({ week, scale }) => {
      const scales: readonly RatingScaleName[] = scale ? [scale] : RATING_SCALES;
      const read = await readRatings(client, scales);
      if (read.unreadable.length === scales.length) {
        throw new McpToolError(
          `Could not read your HelloFresh ratings: ${read.unreadable.map((u) => `${u.source}: ${u.reason}`).join('; ')}`,
        );
      }
      const { items, extra } = await nameFromWeek(client, read.ratings, week);
      return minifiedResult({
        ratings: items,
        ...(read.skipped > 0 ? { skipped: read.skipped } : {}),
        ...(read.unreadable.length > 0 ? { unreadable: read.unreadable } : {}),
        ...extra,
        note:
          'The ratings item shape is not yet observed live: an item counts when it has a recipe id (object_id) and ' +
          'a numeric rating; any other item is skipped and counted.',
      });
    },
  );

  // ---- hf_favorite_recipe / hf_unfavorite_recipe ----

  interface FavoriteState {
    recipeId: string;
    week: string;
  }

  const favoriteWrite = (add: boolean) => {
    const name = add ? 'hf_favorite_recipe' : 'hf_unfavorite_recipe';
    registerGated(server, {
      name,
      title: add ? 'HelloFresh: favourite a recipe' : 'HelloFresh: un-favourite a recipe',
      description: add
        ? 'Add a recipe from a week’s menu to the user’s HelloFresh favourites (the planner then favours it). Give ' +
          'the week and the menu index from hf_get_menu (a protein swap favourites the swap’s own recipe). Undo with ' +
          'hf_unfavorite_recipe. Re-reads the favourites to verify.'
        : 'Remove a recipe on a week’s menu from the user’s HelloFresh favourites. Give the week and the menu index ' +
          '(hf_list_favorites with the week shows which are favourites). Undo with hf_favorite_recipe. Re-reads the ' +
          'favourites to verify.',
      destructive: false,
      meta: CHANGE(add ? ['favorite hellofresh recipe', 'save recipe', 'like this recipe'] : ['unfavorite hellofresh recipe', 'remove favorite']),
      input: {
        week: weekParam,
        index: z.number().int().positive().describe('The recipe’s menu index for that week (from hf_get_menu).'),
      },
      async plan({ week, index }): Promise<{ gate: GateFields; state: FavoriteState }> {
        const account: Account = await loadAccount(client);
        const delivery = projectDelivery(await client.getDelivery(account.subscriptionId, week));
        const menu = await readMenu(client, account, delivery, week);
        const entry = [...recipesOf(menu)].find(([, r]) => r.index === index);
        if (!entry) {
          const listed = menu.meals.some((m) => m.index === index || m.variants.some((v) => v.index === index));
          throw new McpToolError(
            listed ? `HelloFresh returned no recipe id for meal ${index} on the ${week} menu.` : `Meal ${index} is not on the ${week} menu.`,
            { hint: `hf_get_menu {week: "${week}"} lists the indexes.` },
          );
        }
        const [recipeId, recipe] = entry;
        const favorites = projectFavorites(await client.listFavorites()).favorites;
        const isFavorite = favorites.some((f) => f.recipeId === recipeId);
        const label = `“${recipe.name ?? recipeId}” (menu #${index}, ${week})`;
        if (add && isFavorite) throw new McpToolError(`${label} is already one of your favorites.`);
        if (!add && !isFavorite) throw new McpToolError(`${label} is not one of your favorites.`);
        const request = add ? addFavoriteRequest(recipeId, week) : removeFavoriteRequest(recipeId);
        return {
          gate: {
            action: add ? 'hellofresh.recipe.favorite' : 'hellofresh.recipe.unfavorite',
            summary: add ? `Add ${label} to your HelloFresh favorites` : `Remove ${label} from your HelloFresh favorites`,
            account: account.subscriptionId,
            target: recipeId,
            request: shown(request),
            preview: { recipe: { index, name: recipe.name, recipeId }, favoritesNow: favorites.length },
          },
          state: { recipeId, week },
        };
      },
      execute: (s) =>
        sendAndVerify({
          send: () => (add ? client.addFavorite(s.recipeId, s.week) : client.removeFavorite(s.recipeId)),
          before: { favorite: !add },
          checkWith: `hf_list_favorites {week: "${s.week}"}`,
          mismatch: `HelloFresh accepted the request, but the re-read favourites ${add ? 'do not include' : 'still include'} the recipe.`,
          verify: async () => {
            const favorite = projectFavorites(await client.listFavorites()).favorites.some((f) => f.recipeId === s.recipeId);
            return { ok: favorite === add, after: { favorite } };
          },
        }),
    });
  };
  favoriteWrite(true);
  favoriteWrite(false);
}
