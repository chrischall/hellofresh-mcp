import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createTestHarness, parseToolResult, type TestHarness } from '@chrischall/mcp-utils/test';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { HelloFreshClient, type ClientSession } from '../src/client.js';
import { registerFavoriteTools } from '../src/tools/favorites.js';
import type { ToolDeps } from '../src/tools/index.js';
import { offlineDeps } from './helpers.js';

// Synthetic fixtures only (the menu is public data); never a real account.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const fixture = (name: string): Any => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));

const SUB = fixture('subscription');
const DELIVERIES = fixture('deliveries');
const MENU = fixture('menu-W49');
const W49 = DELIVERIES.items[0];
const RECIPE_OF = (index: number): string => MENU.meals.find((m: Any) => m.index === index).recipe.id;
const NAME_OF = (index: number): string => MENU.meals.find((m: Any) => m.index === index).recipe.name;
const UUID = 'synthetic-customer-uuid';

const favoritesOf = (...recipeIds: string[]) => ({
  skip: 0,
  take: 50,
  total: recipeIds.length,
  count: recipeIds.length,
  items: recipeIds.map((id, i) => ({
    id: `fav-${i}`,
    customer_uuid: UUID,
    customer_country: 'US',
    object_type: 'recipe',
    object_id: id,
    created_at: '2026-11-01T10:00:00Z',
  })),
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const noContent = () => new Response(null, { status: 204 });

type Handler = (url: URL) => Response | Promise<Response>;
type Route = [string, RegExp, Handler | unknown];

interface Sent {
  method: string;
  url: URL;
}

function baseRoutes(): Route[] {
  return [
    ['GET', /\/api\/customers\/me\/subscriptions$/, { count: 1, items: [SUB] }],
    ['GET', /\/delivery_dates\/2026-W49$/, W49],
    ['GET', /\/my-deliveries\/menu$/, MENU],
    ['GET', /\/cfs\/v2\/favorites\/recipe$/, favoritesOf()],
    ['GET', /\/cfs\/v[23]\/ratings\/recipe$/, { skip: 0, take: 50, total: 0, count: 0, items: [] }],
    ['PUT', /\/cfs\/v2\/favorites\/recipe\/[0-9a-f]+$/, noContent],
    ['DELETE', /\/cfs\/v2\/favorites\/recipe\/[0-9a-f]+$/, noContent],
  ];
}

let harness: TestHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function setup(opts: { routes?: Route[]; after?: Route[] } = {}) {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const method = init?.method ?? 'GET';
    const written = sent.some((s) => s.method !== 'GET');
    sent.push({ method, url });
    const all = [...(written ? (opts.after ?? []) : []), ...(opts.routes ?? []), ...baseRoutes()];
    const hit = all.find(([m, re]) => m === method && re.test(url.pathname));
    if (!hit) return json({ error: 'not found' }, 404);
    const h = hit[2];
    return typeof h === 'function' ? (h as Handler)(url) : json(h);
  }) as unknown as typeof fetch;
  const session: ClientSession = { withAuth: (c) => c('tok'), redact: (t) => t };
  const deps: ToolDeps = { ...offlineDeps(), client: new HelloFreshClient({ session, fetchImpl }) };
  harness = await createTestHarness((server) => registerFavoriteTools(server, deps));
  const h = harness;
  return {
    sent,
    writes: () => sent.filter((s) => s.method !== 'GET'),
    call: (name: string, args: Record<string, unknown>) => h.callTool(name, args),
    async twoPhase(name: string, args: Record<string, unknown>) {
      const first = await h.callTool(name, args);
      const preview = parseToolResult<Any>(first);
      const phase1Writes = sent.filter((s) => s.method !== 'GET').length;
      const result = await h.callTool(name, { ...args, confirmToken: preview.confirmToken });
      return { preview, phase1Writes, result, out: result.isError ? undefined : parseToolResult<Any>(result) };
    },
  };
}

const textOf = (r: CallToolResult) => (r.content as { text: string }[])[0]!.text;
const outOf = (r: CallToolResult): Any => parseToolResult<Any>(r);

describe('favourite tools: registration', () => {
  it('two reads and two gated, non-destructive writes, all in the food domain', async () => {
    harness = await createTestHarness((server) => registerFavoriteTools(server, offlineDeps()));
    const tools = (await harness.client.listTools()).tools;
    expect(tools.map((t) => t.name).sort()).toEqual(['hf_favorite_recipe', 'hf_list_favorites', 'hf_list_ratings', 'hf_unfavorite_recipe']);
    for (const t of tools) {
      expect(t.annotations?.openWorldHint, t.name).toBe(true);
      const write = t.name.endsWith('favorite_recipe');
      expect(t.annotations?.readOnlyHint, t.name).toBe(!write);
      if (write) {
        expect(t.annotations?.destructiveHint, t.name).toBe(false);
        expect(t.inputSchema.properties, t.name).toHaveProperty('confirmToken');
        expect((t._meta as Any).mint, t.name).toMatchObject({ domain: 'food', intent: 'change' });
      } else {
        expect((t._meta as Any).mint, t.name).toMatchObject({ domain: 'food', intent: 'lookup' });
      }
    }
  });
});

describe('hf_list_favorites', () => {
  it('lists recipe ids and dates, never the customer uuid', async () => {
    const t = await setup({ routes: [['GET', /\/favorites\/recipe$/, favoritesOf(RECIPE_OF(63), 'ffffffffffffffffffffffff')]] });
    const result = await t.call('hf_list_favorites', {});
    const out = outOf(result);
    expect(out).toEqual({
      total: 2,
      favorites: [
        { recipeId: RECIPE_OF(63), favoritedAt: '2026-11-01T10:00:00Z' },
        { recipeId: 'ffffffffffffffffffffffff', favoritedAt: '2026-11-01T10:00:00Z' },
      ],
    });
    expect(textOf(result)).not.toContain(UUID);
    expect(t.sent.map((s) => s.url.pathname)).toEqual(['/gw/cfs/v2/favorites/recipe']);
  });

  it('with a week: names the favourites on that week’s menu (swaps included)', async () => {
    const t = await setup({ routes: [['GET', /\/favorites\/recipe$/, favoritesOf(RECIPE_OF(63), RECIPE_OF(560), 'ffffffffffffffffffffffff')]] });
    const out = outOf(await t.call('hf_list_favorites', { week: '2026-W49' }));
    expect(out.favorites).toEqual([
      { recipeId: RECIPE_OF(63), favoritedAt: '2026-11-01T10:00:00Z', menuWeek: '2026-W49', index: 63, name: NAME_OF(63) },
      { recipeId: RECIPE_OF(560), favoritedAt: '2026-11-01T10:00:00Z', menuWeek: '2026-W49', index: 560, name: NAME_OF(560) },
      { recipeId: 'ffffffffffffffffffffffff', favoritedAt: '2026-11-01T10:00:00Z' },
    ]);
    expect(out.onMenu).toBe(2);
  });

  it('an unreadable menu still lists the favourites, with the reason', async () => {
    const t = await setup({
      routes: [
        ['GET', /\/favorites\/recipe$/, favoritesOf(RECIPE_OF(63))],
        ['GET', /\/menu$/, () => json({ error: 'nope' }, 500)],
      ],
    });
    const out = outOf(await t.call('hf_list_favorites', { week: '2026-W49' }));
    expect(out.favorites).toEqual([{ recipeId: RECIPE_OF(63), favoritedAt: '2026-11-01T10:00:00Z' }]);
    expect(out.menuError).toMatch(/500/);
  });
});

describe('nameless recipes', () => {
  const nameless = () => {
    const menu = structuredClone(MENU);
    delete menu.meals.find((m: Any) => m.index === 63).recipe.name;
    delete menu.meals.find((m: Any) => m.index === 560).recipe.name;
    // A swap with no recipe id cannot be favourited or matched.
    delete menu.meals.find((m: Any) => m.index === 565).recipe.id;
    return menu;
  };

  it('a swap without a recipe name is named by its title; a nameless course has no name; no total is no total', async () => {
    const { total: _t, ...noTotal } = favoritesOf(RECIPE_OF(63), RECIPE_OF(560));
    const t = await setup({ routes: [['GET', /\/favorites\/recipe$/, noTotal], ['GET', /\/menu$/, nameless()]] });
    const out = outOf(await t.call('hf_list_favorites', { week: '2026-W49' }));
    expect(out.total).toBeUndefined();
    expect(out.favorites[0]).toEqual({ recipeId: RECIPE_OF(63), favoritedAt: '2026-11-01T10:00:00Z', menuWeek: '2026-W49', index: 63 });
    expect(out.favorites[1].name).toBe('2x Shrimp');
  });

  it('the write preview names a nameless recipe by its id', async () => {
    const t = await setup({ routes: [['GET', /\/menu$/, nameless()]] });
    const preview = outOf(await t.call('hf_favorite_recipe', { week: '2026-W49', index: 63 }));
    expect(JSON.stringify(preview)).toContain(`“${RECIPE_OF(63)}” (menu #63, 2026-W49)`);
    const swap = await t.call('hf_favorite_recipe', { week: '2026-W49', index: 565 });
    expect(textOf(swap)).toMatch(/no recipe id for meal 565/);
  });
});

describe('hf_list_ratings', () => {
  it('reads both scales by default; parses defensively and says so', async () => {
    const t = await setup({
      routes: [
        ['GET', /\/cfs\/v3\/ratings\/recipe$/, { items: [{ object_id: RECIPE_OF(53), rating: 2, hellofresh_week: '2026-W45', customer_uuid: UUID }, { odd: 1 }] }],
      ],
    });
    const result = await t.call('hf_list_ratings', { week: '2026-W49' });
    const out = outOf(result);
    expect(out.ratings).toEqual([{ recipeId: RECIPE_OF(53), rating: 2, scale: 'v3', week: '2026-W45', menuWeek: '2026-W49', index: 53, name: NAME_OF(53) }]);
    expect(out.skipped).toBe(1);
    expect(out.note).toMatch(/not yet observed/);
    expect(textOf(result)).not.toContain(UUID);
    expect(t.sent.filter((s) => s.url.pathname.includes('/ratings/')).map((s) => s.url.pathname).sort()).toEqual([
      '/gw/cfs/v2/ratings/recipe',
      '/gw/cfs/v3/ratings/recipe',
    ]);
  });

  it('one scale on request; a rating off the week’s menu is listed without a name', async () => {
    const t = await setup({ routes: [['GET', /\/cfs\/v2\/ratings\/recipe$/, { items: [{ object_id: 'ffffffffffffffffffffffff', rating: 3 }] }]] });
    const out = outOf(await t.call('hf_list_ratings', { scale: 'v2' }));
    expect(out.ratings).toEqual([{ recipeId: 'ffffffffffffffffffffffff', rating: 3, scale: 'v2' }]);
    expect(out.skipped).toBeUndefined();
    expect(t.sent.map((s) => s.url.pathname)).toEqual(['/gw/cfs/v2/ratings/recipe']);
  });

  it('one unreadable scale is named; every scale unreadable is an error', async () => {
    const t = await setup({ routes: [['GET', /\/cfs\/v2\/ratings\/recipe$/, () => json({ error: 'nope' }, 404)]] });
    const out = outOf(await t.call('hf_list_ratings', {}));
    expect(out.ratings).toEqual([]);
    expect(out.unreadable.map((u: Any) => u.source)).toEqual(['ratings v2']);
    const all = await setup({ routes: [['GET', /\/ratings\/recipe$/, () => json({ error: 'nope' }, 404)]] });
    const result = await all.call('hf_list_ratings', {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Could not read your HelloFresh ratings/);
  });

  it('an unreadable menu still lists the ratings, with the reason', async () => {
    const t = await setup({
      routes: [
        ['GET', /\/cfs\/v2\/ratings\/recipe$/, { items: [{ object_id: RECIPE_OF(53), rating: 4 }] }],
        ['GET', /\/menu$/, () => json({ error: 'nope' }, 500)],
      ],
    });
    const out = outOf(await t.call('hf_list_ratings', { week: '2026-W49', scale: 'v2' }));
    expect(out.ratings).toEqual([{ recipeId: RECIPE_OF(53), rating: 4, scale: 'v2' }]);
    expect(out.menuError).toMatch(/500/);
  });
});

describe('hf_favorite_recipe', () => {
  it('previews, then PUTs the recipe id with the week and verifies by re-reading the favourites', async () => {
    const t = await setup({ after: [['GET', /\/favorites\/recipe$/, favoritesOf(RECIPE_OF(63))]] });
    const { preview, phase1Writes, out } = await t.twoPhase('hf_favorite_recipe', { week: '2026-W49', index: 63 });
    expect(phase1Writes).toBe(0);
    expect(preview.confirmToken).toBeTruthy();
    expect(JSON.stringify(preview)).toContain(NAME_OF(63));
    expect(JSON.stringify(preview)).toContain(`/gw/cfs/v2/favorites/recipe/${RECIPE_OF(63)}`);
    expect(out).toMatchObject({ status: 'verified', before: { favorite: false }, after: { favorite: true } });
    const [write] = t.writes();
    expect(write!.method).toBe('PUT');
    expect(write!.url.pathname).toBe(`/gw/cfs/v2/favorites/recipe/${RECIPE_OF(63)}`);
    expect(write!.url.searchParams.get('weekId')).toBe('2026-W49');
  });

  it('a protein swap favourites the swap’s own recipe', async () => {
    const t = await setup({ after: [['GET', /\/favorites\/recipe$/, favoritesOf(RECIPE_OF(560))]] });
    const { out } = await t.twoPhase('hf_favorite_recipe', { week: '2026-W49', index: 560 });
    expect(out.status).toBe('verified');
    expect(t.writes()[0]!.url.pathname).toBe(`/gw/cfs/v2/favorites/recipe/${RECIPE_OF(560)}`);
  });

  it('a re-read that does not show it reports unverified; a failed re-read says so', async () => {
    const t = await setup();
    const { out } = await t.twoPhase('hf_favorite_recipe', { week: '2026-W49', index: 63 });
    expect(out.status).toBe('unverified');
    expect(out.warning).toMatch(/hf_list_favorites/);
    const broken = await setup({ after: [['GET', /\/favorites\/recipe$/, () => json({ error: 'x' }, 500)]] });
    const r = await broken.twoPhase('hf_favorite_recipe', { week: '2026-W49', index: 63 });
    expect(r.out.status).toBe('unverified');
    expect(r.out.verifyError).toMatch(/500/);
  });

  it('a 5xx on the write answers status unknown', async () => {
    const t = await setup({ routes: [['PUT', /\/favorites\/recipe\//, () => json({ error: 'x' }, 502)]] });
    const { out } = await t.twoPhase('hf_favorite_recipe', { week: '2026-W49', index: 63 });
    expect(out.status).toBe('unknown');
  });

  it('refuses a recipe already a favourite, an index not on the menu, and a meal with no recipe id', async () => {
    const already = await setup({ routes: [['GET', /\/favorites\/recipe$/, favoritesOf(RECIPE_OF(63))]] });
    const r1 = await already.call('hf_favorite_recipe', { week: '2026-W49', index: 63 });
    expect(r1.isError).toBe(true);
    expect(textOf(r1)).toMatch(/already one of your favorites/);
    const missing = await setup();
    const r2 = await missing.call('hf_favorite_recipe', { week: '2026-W49', index: 999 });
    expect(textOf(r2)).toMatch(/999 is not on the 2026-W49 menu/);
    const noId = structuredClone(MENU);
    delete noId.meals.find((m: Any) => m.index === 63).recipe.id;
    const anon = await setup({ routes: [['GET', /\/menu$/, noId]] });
    const r3 = await anon.call('hf_favorite_recipe', { week: '2026-W49', index: 63 });
    expect(textOf(r3)).toMatch(/no recipe id/);
    for (const t of [already, missing, anon]) expect(t.writes()).toEqual([]);
  });
});

describe('hf_unfavorite_recipe', () => {
  it('previews, then DELETEs and verifies it is gone', async () => {
    const t = await setup({
      routes: [['GET', /\/favorites\/recipe$/, favoritesOf(RECIPE_OF(63))]],
      after: [['GET', /\/favorites\/recipe$/, favoritesOf()]],
    });
    const { out } = await t.twoPhase('hf_unfavorite_recipe', { week: '2026-W49', index: 63 });
    expect(out).toMatchObject({ status: 'verified', before: { favorite: true }, after: { favorite: false } });
    const [write] = t.writes();
    expect(write!.method).toBe('DELETE');
    expect(write!.url.pathname).toBe(`/gw/cfs/v2/favorites/recipe/${RECIPE_OF(63)}`);
    expect(write!.url.searchParams.get('weekId')).toBeNull();
  });

  it('refuses a recipe that is not a favourite', async () => {
    const t = await setup();
    const r = await t.call('hf_unfavorite_recipe', { week: '2026-W49', index: 63 });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/not one of your favorites/);
    expect(t.writes()).toEqual([]);
  });
});
