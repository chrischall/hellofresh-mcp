// Cooking day: one recipe's detail (hf_get_recipe) and the week's picks in a
// recommended cook order (hf_cooking_plan), and the pantry staples HelloFresh does
// not ship (hf_pantry_check). Read-only. Recipe text (names,
// ingredients, steps) is written by HelloFresh — third-party content — so both
// answer inside the untrusted-content envelope.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  McpToolError,
  UNTRUSTED_CONTENT_RULE,
  UNTRUSTED_DESCRIPTION_SUFFIX,
  resolveView,
  toolAnnotations,
  untrustedResult,
} from '@chrischall/mcp-utils';
import { cookOrder, dayFrom, pantryItems, pantryLine, projectRecipe, recipeMinutes } from '../cooking.js';
import { projectDelivery, projectMenu, type ProjectedMenu } from '../normalize.js';
import type { RawDeliveryMenu, RawMeal } from '../types.js';
import { foodMeta } from './hints.js';
import { HF_VIEWS, attempt, dateOf, hfView, loadAccount, readRawMenu, weekParam } from './shared.js';
import type { ToolDeps } from './index.js';

const readOnly = (title: string) => toolAnnotations({ title, readOnly: true, idempotent: true, openWorld: true });

const RECIPE_NOTE = `Recipe names, headlines, ingredients and steps below are written by HelloFresh (third-party content), not the user. ${UNTRUSTED_CONTENT_RULE}`;
/** `note` is reserved by the envelope (a payload carrying one is nested under `data`): say `summary` instead. */
const fenced = (payload: Record<string, unknown>) => untrustedResult(payload, { note: RECIPE_NOTE });

/** How many ingredient names a cooking-plan dish lists. */
const SHORT_INGREDIENTS = 8;

/** Where a menu index sits: its raw meal and, for a protein swap, the base course and the swap's title. */
function locate(raw: RawDeliveryMenu, menu: ProjectedMenu, index: number) {
  const meal = (raw.meals ?? []).find((m) => m.index === index);
  for (const base of menu.meals) {
    const variant = base.variants.find((v) => v.index === index);
    if (variant) return { meal, base, variant };
  }
  return { meal, base: menu.meals.find((m) => m.index === index), variant: undefined };
}

/** A protein swap as hf_get_recipe names it: what it swaps in is the swap's title, else its own recipe name, else unsaid. */
function swapOf(base: { index: number; name?: string }, variant: { title?: string; name?: string }) {
  const swapsIn = variant.title?.trim() || variant.name?.trim();
  return {
    baseIndex: base.index,
    baseName: base.name,
    ...(variant.title ? { protein: variant.title } : {}),
    note: `Protein swap of #${base.index} ${base.name}${swapsIn ? `: swaps in ${swapsIn}` : ''}.`,
  };
}

function recipeIdOf(meal: RawMeal | undefined, index: number, week: string): string {
  const id = meal?.recipe?.id;
  if (!id) throw new McpToolError(`HelloFresh returned no recipe id for menu index ${index} in ${week}, so its recipe cannot be read.`);
  return id;
}

export function registerCookingTools(server: McpServer, deps: ToolDeps): void {
  const { client } = deps;

  server.registerTool(
    'hf_get_recipe',
    {
      description:
        'Read the full HelloFresh recipe for one meal on a week’s menu (by menu index, a protein swap included): ' +
        'total time, difficulty, allergens, nutrition per serving, ingredients with amounts for the week’s servings ' +
        '(nearest listed yield otherwise, said so), the cooking steps as plain text, utensils, the printable recipe ' +
        `card and web page. Answers "how do I cook this?". ${UNTRUSTED_DESCRIPTION_SUFFIX}`,
      annotations: readOnly('HelloFresh: get recipe'),
      _meta: foodMeta('lookup', { aliases: ['hellofresh recipe', 'recipe card', 'how to cook'] }),
      inputSchema: z.object({
        week: weekParam,
        index: z.number().int().min(0).describe('The meal’s menu index (from hf_get_menu or hf_get_delivery; a protein swap has its own).'),
      }),
    },
    async ({ week, index }) => {
      const account = await loadAccount(client);
      const delivery = projectDelivery(await client.getDelivery(account.subscriptionId, week));
      const raw = await readRawMenu(client, account, delivery, week);
      const { meal, base, variant } = locate(raw, projectMenu(raw), index);
      if (!meal) {
        throw new McpToolError(`There is no meal with index ${index} on the ${week} menu.`, {
          hint: 'hf_get_menu lists the week’s menu indexes (protein swaps under each course).',
        });
      }
      const detail = await client.getRecipe(recipeIdOf(meal, index, week));
      const servings = delivery.servings!;
      const quantity = meal.selection?.quantity ?? 0;
      return fenced({
        week,
        index,
        servings,
        ...(quantity > 0 ? { selectedQuantity: quantity } : {}),
        ...(quantity > 1
          ? { quantityNote: `This meal is picked ${quantity}× this week: multiply the amounts by ${quantity}.` }
          : {}),
        ...(variant && base ? { swap: swapOf(base, variant) } : {}),
        recipe: projectRecipe(detail, servings),
      });
    },
  );

  server.registerTool(
    'hf_cooking_plan',
    {
      description:
        'Plan cooking for a HelloFresh delivery week: the picked meals in a recommended cook order, most perishable ' +
        'first (fish, then shellfish, other seafood, poultry, ground meat, whole cuts of beef/pork/lamb, vegetarian ' +
        'last; ties by shorter total time), each with a suggested day counted from the delivery date, why, total ' +
        'time, a short ingredient list, the pantry staples HelloFresh does not ship (salt, oil…) and the recipe card. ' +
        `${UNTRUSTED_DESCRIPTION_SUFFIX}`,
      annotations: readOnly('HelloFresh: cooking plan'),
      _meta: foodMeta('whats-on', { aliases: ['what to cook', 'cooking order', 'dinner this week'] }),
      inputSchema: z.object({ week: weekParam }),
    },
    async ({ week }) => {
      const account = await loadAccount(client);
      const delivery = projectDelivery(await client.getDelivery(account.subscriptionId, week));
      const deliveryDate = dateOf(delivery.deliveryDate);
      const head = { week, ...(deliveryDate ? { deliveryDate } : {}), status: delivery.status };
      if (delivery.status === 'skipped') {
        return fenced({ ...head, dishes: [], summary: `${week} is skipped: nothing is delivered, so there is nothing to cook.` });
      }
      const raw = await readRawMenu(client, account, delivery, week);
      const menu = projectMenu(raw);
      if (menu.selected.length === 0) {
        return fenced({ ...head, dishes: [], summary: `No meals are picked for ${week} yet — pick them with hf_select_meals.` });
      }

      const servings = delivery.servings!; // readRawMenu refuses a week without it
      const dishes = await Promise.all(
        menu.selected.map(async (s) => {
          const { meal, base, variant } = locate(raw, menu, s.index);
          const recipe = meal?.recipe ?? {};
          const read = await attempt(async () => projectRecipe(await client.getRecipe(recipeIdOf(meal, s.index, week)), servings));
          const shipped = read.ok ? read.value.ingredients.filter((i) => !i.notInBox).map((i) => i.name) : [];
          const pantry = read.ok ? read.value.ingredients.filter((i) => i.notInBox).map((i) => i.name) : [];
          const dish = variant ?? base;
          return {
            index: s.index,
            name: recipe.name,
            quantity: s.quantity,
            ...(s.quantity > 1
              ? {
                  dinners: s.quantity,
                  quantityNote: `Picked ${s.quantity}× this week: this covers ${s.quantity} dinners (cook it on ${s.quantity} nights, or once at ${s.quantity}× the amounts).`,
                }
              : {}),
            ...(variant ? { swapOf: s.baseIndex } : {}),
            category: dish?.category ?? recipe.category ?? null,
            seafoodKind: dish?.seafoodKind ?? null,
            totalMinutes: recipeMinutes(recipe),
            text: [recipe.name, recipe.headline, ...shipped].join(' '),
            ...(read.ok
              ? {
                  ingredients: shipped.slice(0, SHORT_INGREDIENTS),
                  ...(shipped.length > SHORT_INGREDIENTS ? { moreIngredients: shipped.length - SHORT_INGREDIENTS } : {}),
                  pantry,
                  ...(read.value.cardLink ? { cardLink: read.value.cardLink } : {}),
                }
              : { ingredientsError: read.reason }),
          };
        }),
      );

      const ordered = cookOrder(dishes);
      return fenced({
        ...head,
        dishes: ordered.map(({ text: _text, category: _category, seafoodKind: _kind, rank, why, ...d }, i) => {
          const tied = ordered.filter((o) => o.rank === rank && o.index !== d.index).map((o) => `#${o.index}`);
          return {
            order: i + 1,
            ...(deliveryDate ? dayFrom(deliveryDate, i) : {}),
            ...d,
            why: tied.length > 0 ? `${why} Same perishability as ${tied.join(', ')}: shorter total time first.` : why,
          };
        }),
        ...(deliveryDate
          ? { dayNote: 'Days count from the delivery day (the most perishable dish that evening); shift them to fit your week.' }
          : {}),
      });
    },
  );
  server.registerTool(
    'hf_pantry_check',
    {
      description:
        'Check what to have in the pantry for a HelloFresh delivery week: the staples HelloFresh does NOT ship (salt, ' +
        'pepper, cooking oil, often butter, eggs, sugar or flour) across the week’s picked meals, at the week’s servings ' +
        '(nearest listed yield otherwise, said so) and × each meal’s quantity — summed per ingredient and unit, ' +
        '"to taste" when no amount is listed, with the dishes that use each — plus a one-line summary. Answers ' +
        `"what do I need from my pantry for HelloFresh this week?". ${UNTRUSTED_DESCRIPTION_SUFFIX}`,
      annotations: readOnly('HelloFresh: pantry check'),
      _meta: foodMeta('lookup', { aliases: ['pantry check', 'pantry staples', 'what do i need on hand', 'not in the box'] }),
      inputSchema: z.object({
        week: weekParam,
        view: hfView('compact is the summed pantry list and summary; full adds each dish’s staples with their own amounts.'),
      }),
    },
    async ({ week, view }) => {
      const account = await loadAccount(client);
      const delivery = projectDelivery(await client.getDelivery(account.subscriptionId, week));
      const head = { week, status: delivery.status };
      if (delivery.status === 'skipped') {
        return fenced({ ...head, items: [], summary: `${week} is skipped: nothing is delivered, so nothing is needed from the pantry.` });
      }
      const raw = await readRawMenu(client, account, delivery, week);
      const menu = projectMenu(raw);
      if (menu.selected.length === 0) {
        return fenced({ ...head, items: [], summary: `No meals are picked for ${week} yet — pick them with hf_select_meals, then check the pantry.` });
      }

      const servings = delivery.servings!; // readRawMenu refuses a week without it
      const reads = await Promise.all(
        menu.selected.map(async (s) => ({
          s,
          read: await attempt(async () => projectRecipe(await client.getRecipe(recipeIdOf(locate(raw, menu, s.index).meal, s.index, week)), servings)),
        })),
      );
      const dishes = reads.flatMap(({ s, read }) => {
        if (!read.ok) return [];
        const name = s.name ?? read.value.name ?? `#${s.index}`;
        return [{ index: s.index, name, quantity: s.quantity, recipe: read.value }];
      });
      const unread = reads.flatMap(({ s, read }) => (read.ok ? [] : [{ index: s.index, reason: read.reason }]));
      const items = pantryItems(dishes.map((d) => ({ name: d.name, quantity: d.quantity, ingredients: d.recipe.ingredients })));
      const notes = dishes.flatMap((d) =>
        d.recipe.yieldsNote ? [`${d.name === `#${d.index}` ? d.name : `#${d.index} ${d.name}`}: ${d.recipe.yieldsNote}`] : [],
      );
      const unreadLine =
        unread.length === 0
          ? ''
          : ` ${unread.length} recipe${unread.length === 1 ? '' : 's'} could not be read (${unread.map((u) => `#${u.index}`).join(', ')}): their staples are missing.`;
      const full = resolveView(view, HF_VIEWS) === 'full';
      return fenced({
        ...head,
        servings,
        items,
        summary: pantryLine(week, items) + unreadLine,
        ...(notes.length > 0 ? { notes } : {}),
        ...(unread.length > 0 ? { unread } : {}),
        ...(full
          ? {
              dishes: dishes.map((d) => ({
                index: d.index,
                name: d.name,
                quantity: d.quantity,
                ...(d.recipe.amountsForServings !== undefined ? { amountsForServings: d.recipe.amountsForServings } : {}),
                pantry: d.recipe.ingredients.filter((i) => i.notInBox).map(({ notInBox: _n, ...i }) => i),
              })),
            }
          : {}),
      });
    },
  );
}
