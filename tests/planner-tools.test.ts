import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createTestHarness, parseToolResult, type TestHarness } from '@chrischall/mcp-utils/test';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { HelloFreshClient, type ClientSession } from '../src/client.js';
import { registerPlannerTools } from '../src/tools/planner.js';
import type { ToolDeps } from '../src/tools/index.js';
import { ProfileConfigError, type LoadedProfiles } from '../src/profiles.js';
import { offlineDeps } from './helpers.js';

// Synthetic fixtures only (see tests/fixtures/*.json).
const fixture = <T = Any>(name: string): T =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as T;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const SUB = fixture('subscription');
const DELIVERIES = fixture('deliveries');
const MENU = fixture('menu-W49');
const W49 = DELIVERIES.items[0];
const W50 = DELIVERIES.items[1];

/** The fixture menu with exactly `indexes` selected. */
const menuSelecting = (...indexes: number[]) => ({
  ...MENU,
  meals: MENU.meals.map((m: Any) => ({
    ...m,
    selection: indexes.includes(m.index) ? { limit: 6, quantity: 1 } : { limit: 6 },
  })),
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Handler = (url: URL) => Response | Promise<Response>;
type Route = [RegExp, Handler | unknown];

/** A delivered earlier week (its menu read answers the fixture menu: 67 + 71 picked). */
const delivered = (id: string) => ({ ...W49, id, status: 'DELIVERED' });

function defaultRoutes(): Route[] {
  return [
    [/\/api\/customers\/me\/subscriptions$/, { count: 1, items: [SUB] }],
    [/\/api\/customers\/me\/deliveries$/, DELIVERIES],
    [/\/delivery_dates\/2026-W49$/, W49],
    [/\/delivery_dates\/2026-W50$/, W50],
    [/\/delivery_dates\/2026-W4[5-8]$/, (url: URL) => json(delivered(url.pathname.slice(-8)))],
    [/\/my-deliveries\/menu$/, MENU],
  ];
}

let harness: TestHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

/** 2026-11-20 noon UTC: before W49's cutoff (2026-11-25). */
const NOW = Date.parse('2026-11-20T12:00:00Z');

async function call(
  name: string,
  args: Record<string, unknown>,
  routes: Route[] = [],
  now = NOW,
  profiles: () => LoadedProfiles = () => PROFILES,
) {
  const urls: URL[] = [];
  const tabBodies: Any[] = [];
  const all = [...routes, ...defaultRoutes()];
  const route = async (url: URL): Promise<Response> => {
    const hit = all.find(([re]) => re.test(url.pathname));
    if (!hit) return json({ error: 'not found' }, 404);
    const [, h] = hit;
    return typeof h === 'function' ? (h as Handler)(url) : json(h);
  };
  const fetchImpl = (async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    urls.push(url);
    if ((init?.method ?? 'GET') !== 'GET') throw new Error(`planner sent a ${init?.method}`);
    return route(url);
  }) as unknown as typeof fetch;
  // The bridge's in-tab fetch — only the side-effect-free price calculator may come through it.
  const tabFetch = async (req: { method: string; url: string; body?: string }) => {
    const url = new URL(req.url);
    if (req.method !== 'POST' || url.pathname !== '/gw/calculate') throw new Error(`planner sent ${req.method} ${url.pathname} in-tab`);
    tabBodies.push(JSON.parse(req.body!));
    const res = await route(url);
    return { status: res.status, body: await res.text() };
  };
  const session: ClientSession = { withAuth: (c) => c('tok'), redact: (t) => t };
  const deps: ToolDeps = { ...offlineDeps(), client: new HelloFreshClient({ session, fetchImpl, tabFetch }), now: () => now, profiles };
  await harness?.close();
  harness = await createTestHarness((server) => registerPlannerTools(server, deps));
  const result = await harness.callTool(name, args);
  return { result, urls, tabBodies, text: (result.content as { text: string }[])[0]!.text, out: result.isError ? undefined : parseToolResult<Any>(result as CallToolResult) };
}

/** Test profiles: a 6-person kid-friendly seafood family (the fixture box is 2 × 6) and a 2-person adventurous couple. */
const PROFILES: LoadedProfiles = {
  source: 'HELLOFRESH_PROFILES',
  profiles: [
    { name: 'family', people: 6, meals: 2, categories: ['Seafood'], kidFriendly: true, maxMinutes: 30, premiumCapCents: 500, avoidRepeatWeeks: 4 },
    { name: 'couple', people: 2, meals: 2, categories: ['Seafood'], adventurous: true, premiumCapCents: 1500, avoidRepeatWeeks: 4 },
  ],
};

const menuWeeks = (urls: URL[]) =>
  urls.filter((u) => u.pathname.endsWith('/menu')).map((u) => u.searchParams.get('week')).sort();

describe('planner tools: registration', () => {
  it('registers three read-only tools in the food domain; the two planners take a profile', async () => {
    harness = await createTestHarness((server) => registerPlannerTools(server, offlineDeps()));
    const tools = (await harness.client.listTools()).tools;
    expect(tools.map((t) => t.name).sort()).toEqual(['hf_list_profiles', 'hf_suggest_meals', 'hf_weekly_plan']);
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint, t.name).toBe(true);
      if (t.name === 'hf_list_profiles') {
        expect(t.annotations?.openWorldHint).toBe(false);
        expect((t._meta as Any).mint).toMatchObject({ domain: 'food', intent: 'lookup' });
        continue;
      }
      expect(t.annotations?.openWorldHint, t.name).toBe(true);
      expect((t._meta as Any).mint).toMatchObject({ domain: 'food', intent: 'other' });
      expect(t.inputSchema.properties).toHaveProperty('profile');
      expect(t.inputSchema.properties).toHaveProperty('people');
    }
  });
});

describe('hf_list_profiles', () => {
  it('lists the configured profiles, their SKUs and where they came from', async () => {
    const { out, urls } = await call('hf_list_profiles', {});
    expect(urls).toEqual([]);
    expect(out.source).toBe('HELLOFRESH_PROFILES');
    expect(out.profiles.map((p: Any) => [p.name, p.label, p.sku])).toEqual([
      ['family', 'Family', 'US-CBU-2-6-0'],
      ['couple', 'Couple', 'US-CBU-2-2-0'],
    ]);
    expect(out.profiles[0]).toMatchObject({ categories: ['Seafood'], kidFriendly: true, maxMinutes: 30, premiumCapCents: 500 });
    expect(out.configure).toMatch(/HELLOFRESH_PROFILES_FILE/);
  });

  it('a malformed config is a tool error naming the source, not a boot failure', async () => {
    const bad = () => {
      throw new ProfileConfigError('Planner profiles from HELLOFRESH_PROFILES are not valid JSON.');
    };
    const listed = await call('hf_list_profiles', {}, [], NOW, bad);
    expect(listed.result.isError).toBe(true);
    expect(listed.text).toMatch(/HELLOFRESH_PROFILES are not valid JSON/);
    const planned = await call('hf_weekly_plan', { week: '2026-W49', profile: 'family' }, [], NOW, bad);
    expect(planned.result.isError).toBe(true);
    expect(planned.urls).toEqual([]);
  });

  it('an unknown profile is a tool error listing the configured names, before any HelloFresh call', async () => {
    const { result, text, urls } = await call('hf_suggest_meals', { week: '2026-W49', profile: 'nobody' });
    expect(result.isError).toBe(true);
    expect(text).toMatch(/No profile "nobody"\. Configured profiles: family, couple\./);
    expect(urls).toEqual([]);
  });
});

describe('hf_suggest_meals', () => {
  it('a family profile: reads its 4 avoid-repeat weeks before, skips their recipes, and suggests shrimp + fish with alternates', async () => {
    const { out, text, urls } = await call('hf_suggest_meals', { week: '2026-W49', profile: 'family' });
    expect(out).toMatchObject({
      week: '2026-W49',
      profile: 'family',
      servings: 6,
      box: { current: 'US-CBU-2-6-0', required: 'US-CBU-2-6-0' },
      maxPremiumPerServingCents: 500,
    });
    expect(out.picks.map((p: Any) => p.index)).toEqual([53, 30]);
    expect(out.picks[1]).toMatchObject({ index: 30, category: 'Seafood', protein: 'fish', name: 'Air-Fried Gochujang Salmon ' });
    expect(out.picks[1].baseIndex).toBeUndefined();
    expect(out.alternates).toHaveLength(2);
    expect(out.alternates[0].options).toHaveLength(2);
    // The recent weeks' picks (67 and 71) are not suggested again.
    const excluded = Object.fromEntries(out.excluded.map((e: Any) => [e.index, e.reason]));
    expect(excluded[67]).toBe('picked in a recent week');
    expect(excluded[71]).toBe('picked in a recent week');
    expect(out.recentPicks.weeks).toEqual(['2026-W45', '2026-W46', '2026-W47', '2026-W48']);
    expect(out.recentPicks.avoidedNames).toHaveLength(2);
    expect(out.recentPicks.unreadable).toBeUndefined();
    expect(menuWeeks(urls)).toEqual(['2026-W45', '2026-W46', '2026-W47', '2026-W48', '2026-W49']);
    expect(text).not.toMatch(/Example St|pat@example|Pat /);
  });

  it('avoid_recent_weeks: 0 reads no other week; avoid_indexes and the premium cap apply', async () => {
    const { out, urls } = await call('hf_suggest_meals', {
      week: '2026-W49',
      profile: 'couple',
      avoid_recent_weeks: 0,
      avoid_indexes: [13],
      max_premium_per_serving_cents: 0,
    });
    expect(urls.filter((u) => u.pathname.includes('/delivery_dates/')).map((u) => u.pathname.slice(-8))).toEqual(['2026-W49']);
    expect(out.recentPicks).toBeUndefined();
    expect(out.maxPremiumPerServingCents).toBe(0);
    const excluded = Object.fromEntries(out.excluded.map((e: Any) => [e.index, e.reason]));
    expect(excluded[13]).toBe('avoided by request');
    expect(excluded[47]).toMatch(/over the \$0\.00 cap/);
    expect(out.picks.every((p: Any) => p.premiumPerServingCents === undefined)).toBe(true);
    // 67 is picked for the week already and is marked so.
    const all = [...out.picks, ...out.alternates.flatMap((a: Any) => a.options)];
    expect(all.find((c: Any) => c.index === 67)?.selected).toBe(true);
  });

  it('a couple week shows premiums for 2 servings and names unreadable recent weeks', async () => {
    const { out } = await call('hf_suggest_meals', { week: '2026-W49', profile: 'couple', avoid_recent_weeks: 2 }, [
      [/\/delivery_dates\/2026-W47$/, () => json({ errorMessage: 'nope' }, 404)],
    ]);
    expect(out.recentPicks.unreadable.map((u: Any) => u.week)).toEqual(['2026-W47']);
    const all = [...out.picks, ...out.alternates.flatMap((a: Any) => a.options)];
    const premium = all.find((c: Any) => c.premiumPerServingCents);
    expect(premium.premiumBoxCents).toBe(premium.premiumPerServingCents * 2);
  });

  it('recent weeks before the first delivery week had no box: not read, not unreadable', async () => {
    const { out, urls } = await call('hf_suggest_meals', { week: '2026-W49', profile: 'couple', avoid_recent_weeks: 2 }, [
      [/\/api\/customers\/me\/subscriptions$/, { count: 1, items: [{ ...SUB, firstDeliveryWeek: '2026-W49', firstBoxDelivered: false }] }],
      [/\/delivery_dates\/2026-W4[78]$/, () => json({ errorMessage: 'nope' }, 404)],
    ]);
    expect(out.recentPicks.weeks).toEqual(['2026-W47', '2026-W48']);
    expect(out.recentPicks.unreadable).toBeUndefined();
    expect(out.recentPicks.avoidedNames).toEqual([]);
    expect(urls.some((u: URL) => /delivery_dates\/2026-W4[78]$/.test(u.pathname))).toBe(false);
  });

  it('a protein swap that fits where its course does not carries its base course index', async () => {
    const poultry: LoadedProfiles = { source: 'x', profiles: [{ ...PROFILES.profiles[0]!, name: 'poultry', categories: ['Poultry'] }] };
    const { out } = await call('hf_suggest_meals', { week: '2026-W49', profile: 'poultry', avoid_recent_weeks: 0 }, [], NOW, () => poultry);
    const all = [...out.picks, ...out.alternates.flatMap((a: Any) => a.options)];
    expect(all.find((c: Any) => c.index === 565)).toMatchObject({ baseIndex: 67, category: 'Poultry' });
    expect(all.find((c: Any) => c.index === 1)?.baseIndex).toBeUndefined();
  });

  it('a menu with no eligible seafood answers a warning and no picks', async () => {
    const { out } = await call('hf_suggest_meals', { week: '2026-W49', profile: 'family', avoid_recent_weeks: 0 }, [
      [/\/menu$/, { ...MENU, meals: MENU.meals.filter((m: Any) => m.recipe.category !== 'Seafood'), modularity: [] }],
    ]);
    expect(out.picks).toEqual([]);
    expect(out.excluded).toBeUndefined();
    expect(out.warning).toMatch(/Only 0 of the 2 meals/);
  });

  it('an unreadable week is a tool error', async () => {
    const { result, text } = await call('hf_suggest_meals', { week: '2026-W49', profile: 'family' }, [
      [/\/delivery_dates\/2026-W49$/, { ...W49, product: {} }],
    ]);
    expect(result.isError).toBe(true);
    expect(text).toMatch(/box size/);
  });
});

describe('hf_weekly_plan', () => {
  /** A synthetic calculator answer (ids + address included, as the real one). */
  const CALC = {
    grandTotal: 21.41,
    subTotal: 59.96,
    taxAmount: 0.42,
    shippingAmount: 12.99,
    shippingDiscountAmount: 12.99,
    discountAmount: 51.96,
    couponCode: 'EXAMPLE65',
    currency: 'USD',
    customerID: 12345678,
    subscriptionID: 90000001,
    shippingAddress: { postcode: '00000', address1: '123 Example St' },
    products: [{ handle: 'US-CBU-2-2-0', couponPercent: 65, couponCode: 'EXAMPLE65', charges: null }],
  };
  const CALC_ROUTE: Route = [/\/gw\/calculate$/, CALC];

  it('HelloFresh’s price for the size the plan NEEDS with the suggested picks, premiums added; no upcoming-list read', async () => {
    const { out, urls, tabBodies, text } = await call('hf_weekly_plan', { week: '2026-W49', profile: 'couple', avoid_recent_weeks: 0 }, [
      CALC_ROUTE,
    ]);
    expect(urls.some((u) => u.pathname.endsWith('/customers/me/deliveries'))).toBe(false);
    expect(tabBodies).toHaveLength(1);
    expect(tabBodies[0]).toMatchObject({
      boxSize: 2,
      weekId: '2026-W49',
      products: [{ handle: 'US-CBU-2-2-0', hfWeek: '2026-W49', recipeIndexes: out.picks.map((p: Any) => String(p.index)) }],
    });
    const premiums = out.picks.reduce((sum: number, p: Any) => sum + (p.premiumBoxCents ?? 0), 0) / 100;
    expect(out.price).toEqual({
      source: 'hellofresh',
      grandTotal: 21.41,
      subTotal: 59.96,
      discount: 51.96,
      shipping: 12.99,
      shippingDiscount: 12.99,
      tax: 0.42,
      couponPercent: 65,
      couponCode: 'EXAMPLE65',
      currency: 'USD',
      premiumUpcharge: premiums,
      totalWithPremiums: Math.round((21.41 + premiums) * 100) / 100,
      note: expect.stringMatching(/leaves premium recipe charges out/),
    });
    expect(out.boxNumberNote).toBeUndefined();
    expect(out.summary).toMatch(/Box total \$\d+\.\d\d \(HelloFresh price.*−\$51\.96 EXAMPLE65\)\.$/);
    expect(text).not.toMatch(/12345678|Example St|"00000"/);
  });

  it('a family week at the right size, calculator unavailable: picks, a labelled estimate, the summary and one select call', async () => {
    const { out, urls } = await call('hf_weekly_plan', { week: '2026-W49', profile: 'family' });
    expect(out.box).toEqual({ current: 'US-CBU-2-6-0', required: 'US-CBU-2-6-0', sizeChangeNeeded: false });
    expect(out.delivery).toEqual({ deliveryDate: '2026-11-30', cutoffDate: '2026-11-25T23:59:59-05:00', status: 'running' });
    expect(out.currentPicks.map((p: Any) => p.index)).toEqual([67, 71]);
    expect(out.picks.map((p: Any) => p.index)).toEqual([53, 30]);
    // 14748 + 1299 fee; box 2 = 15 % of the product price (2212).
    expect(out.price).toEqual({
      source: 'estimate',
      reason: expect.stringMatching(/price calculator could not be used \(.*404.*\), so this is a local estimate/),
      boxNumber: 2,
      subtotalCents: 16047,
      discountCents: 2212,
      totalCents: 13835,
      voucher: 'EXAMPLE65',
      priceFrom: 'this week',
    });
    expect(out.summary).toBe(
      'Family week (6 servings) — delivering Mon 11/30: Garlicky Shrimp Couscous Bowls + Air-Fried Gochujang Salmon. ' +
        'Est. box total $138.35 (−$22.12 EXAMPLE65).',
    );
    expect(out.followUp).toEqual([
      { tool: 'hf_select_meals', arguments: { week: '2026-W49', meals: [53, 30] }, why: 'Pick the suggested meals.' },
    ]);
    expect(out.followUpNote).toMatch(/confirm-gated/);
    expect(out.locked).toBeUndefined();
    expect(out.recentPicks.weeks).toHaveLength(4);
    expect(urls.some((u) => u.pathname.endsWith('/customers/me/deliveries'))).toBe(true);
  });

  it('a couple week on a 6-serving box: a size change first, priced from an upcoming 2-person week', async () => {
    const { out } = await call('hf_weekly_plan', { week: '2026-W49', profile: 'couple', avoid_recent_weeks: 0 });
    expect(out.box).toEqual({ current: 'US-CBU-2-6-0', required: 'US-CBU-2-2-0', sizeChangeNeeded: true });
    expect(out.followUp.map((f: Any) => f.tool)).toEqual(['hf_set_week_size', 'hf_select_meals']);
    expect(out.followUp[0]).toEqual({
      tool: 'hf_set_week_size',
      arguments: { week: '2026-W49', people: 2, meals: 2 },
      why: '2026-W49 is US-CBU-2-6-0; the couple profile needs US-CBU-2-2-0.',
    });
    const premiums = out.picks.reduce((sum: number, p: Any) => sum + (p.premiumBoxCents ?? 0), 0);
    expect(out.price).toMatchObject({ subtotalCents: 5996 + 1299 + premiums, discountCents: 899, priceFrom: '2026-W50 (same box size)' });
    expect(out.summary).toMatch(/^Couple week \(2 servings\) — delivering Mon 11\/30: .+ \+ .+\. Est\. box total \$\d+\.\d\d \(−\$8\.99 EXAMPLE65\)\.$/);
  });

  describe('the subscription’s first box (HelloFresh will not resize it)', () => {
    const firstBox: Route = [/\/api\/customers\/me\/subscriptions$/, { count: 1, items: [{ ...SUB, firstDeliveryWeek: '2026-W49', firstBoxDelivered: false }] }];

    it('proposes no size change: the box keeps its size, said in notes, and picks are planned for the box as it is', async () => {
      const { out } = await call('hf_weekly_plan', { week: '2026-W49', profile: 'couple', avoid_recent_weeks: 0 }, [firstBox]);
      expect(out.box).toEqual({ current: 'US-CBU-2-6-0', required: 'US-CBU-2-6-0', sizeChangeNeeded: false });
      expect(out.servings).toBe(6);
      expect(out.followUp.map((f: Any) => f.tool)).toEqual(['hf_select_meals']);
      expect(out.notes).toHaveLength(1);
      expect(out.notes[0]).toMatch(/2026-W49 is the first box.*cannot be resized.*keeps US-CBU-2-6-0.*couple profile.*US-CBU-2-2-0/);
    });

    it('a first box with a different meal count gets that many picks', async () => {
      const three = { ...W49, product: { ...W49.product, handle: 'US-CBU-3-6-0', specs: { meals: 3, size: 6 } } };
      const { out } = await call('hf_weekly_plan', { week: '2026-W49', profile: 'family', avoid_recent_weeks: 0 }, [
        firstBox,
        [/\/delivery_dates\/2026-W49$/, three],
        [/deliveries$/, { items: [three] }],
      ]);
      expect(out.box.sizeChangeNeeded).toBe(false);
      expect(out.picks.length).toBe(3);
      expect(out.followUp.map((f: Any) => f.tool)).toEqual(['hf_select_meals']);
      expect(out.notes[0]).toMatch(/keeps US-CBU-3-6-0/);
    });

    it('a first box already the profile’s size, or already delivered, adds no note', async () => {
      const same = await call('hf_weekly_plan', { week: '2026-W49', profile: 'family', avoid_recent_weeks: 0 }, [firstBox]);
      expect(same.out.notes).toBeUndefined();
      const delivered = await call('hf_weekly_plan', { week: '2026-W49', profile: 'couple', avoid_recent_weeks: 0 }, [
        [/\/api\/customers\/me\/subscriptions$/, { count: 1, items: [{ ...SUB, firstDeliveryWeek: '2026-W49', firstBoxDelivered: true }] }],
      ]);
      expect(delivered.out.notes).toBeUndefined();
      expect(delivered.out.followUp[0].tool).toBe('hf_set_week_size');
    });
  });

  it('a skipped week: unskip, then resize, then pick — priced as a running box', async () => {
    const { out } = await call('hf_weekly_plan', { week: '2026-W50', profile: 'family', avoid_recent_weeks: 0 }, [
      [/deliveries$/, { items: [W50] }],
    ]);
    expect(out.delivery.status).toBe('skipped');
    expect(out.followUp.map((f: Any) => f.tool)).toEqual(['hf_unskip_week', 'hf_set_week_size', 'hf_select_meals']);
    expect(out.followUp[0]).toEqual({ tool: 'hf_unskip_week', arguments: { week: '2026-W50' }, why: '2026-W50 is skipped.' });
    // No upcoming 6-person week: the plan's own unit price.
    expect(out.price).toMatchObject({ boxNumber: 2, subtotalCents: 14748 + 1299, priceFrom: 'the plan price' });
  });

  it('no price for the needed size → no estimate, said plainly', async () => {
    const { out } = await call('hf_weekly_plan', { week: '2026-W49', profile: 'couple', avoid_recent_weeks: 0 }, [
      [/deliveries$/, { items: [W49] }],
    ]);
    expect(out.price).toBeUndefined();
    expect(out.priceWarning).toMatch(/price calculator could not be used.*no price for US-CBU-2-2-0/);
    expect(out.summary).toMatch(/Box total not estimated\.$/);
  });

  it('a week outside the upcoming list: undiscounted unless box_number is given', async () => {
    const routes: Route[] = [[/deliveries$/, { count: 0 }]];
    const plain = await call('hf_weekly_plan', { week: '2026-W49', profile: 'family', avoid_recent_weeks: 0 }, routes);
    expect(plain.out.price.discountCents).toBe(0);
    expect(plain.out.price.warning).toMatch(/box number/);
    expect(plain.out.summary).toMatch(/\(no voucher discount\)\.$/);
    const numbered = await call('hf_weekly_plan', { week: '2026-W49', profile: 'family', avoid_recent_weeks: 0, box_number: 1 }, routes);
    expect(numbered.out.price).toMatchObject({ boxNumber: 1, discountCents: Math.round((14748 + 1299) * 0.65) });
  });

  it('next_box_number shifts the voucher’s box', async () => {
    const { out } = await call('hf_weekly_plan', { week: '2026-W49', profile: 'family', avoid_recent_weeks: 0, next_box_number: 60 });
    expect(out.price.boxNumber).toBe(60);
    expect(out.price.warning).toMatch(/covers boxes 1–52/);
    expect(out.price.voucher).toBeUndefined();
  });

  it('first box not yet delivered: numbered from box 1 over running weeks, a planned skipped week counting as running', async () => {
    const W51 = { ...W49, id: '2026-W51', deliveryDate: '2026-12-14T00:00:00-05:00' };
    const routes: Route[] = [
      [/\/api\/customers\/me\/subscriptions$/, { count: 1, items: [{ ...SUB, firstDeliveryWeek: '2026-W49', firstBoxDelivered: false }] }],
      [/deliveries$/, { items: [W49, W50, W51] }],
      [/\/delivery_dates\/2026-W51$/, W51],
    ];
    const w49 = await call('hf_weekly_plan', { week: '2026-W49', profile: 'family', avoid_recent_weeks: 0 }, routes);
    expect(w49.out.price).toMatchObject({ boxNumber: 1, discountCents: Math.round((14748 + 1299) * 0.65) });
    expect(w49.out.boxNumberNote).toMatch(/first box is not delivered yet/);
    // W50 is skipped, so W51 is box 2 …
    const w51 = await call('hf_weekly_plan', { week: '2026-W51', profile: 'family', avoid_recent_weeks: 0 }, routes);
    expect(w51.out.price.boxNumber).toBe(2);
    // … unless the plan unskips W50, which then is box 2.
    const w50 = await call('hf_weekly_plan', { week: '2026-W50', profile: 'family', avoid_recent_weeks: 0 }, routes);
    expect(w50.out.price.boxNumber).toBe(2);
    // An explicit box_number needs no note.
    const given = await call('hf_weekly_plan', { week: '2026-W51', profile: 'family', avoid_recent_weeks: 0, box_number: 7 }, routes);
    expect(given.out.price.boxNumber).toBe(7);
    expect(given.out.boxNumberNote).toBeUndefined();
  });

  it('the suggested meals already picked → nothing to do', async () => {
    const { out } = await call('hf_weekly_plan', { week: '2026-W49', profile: 'family', avoid_recent_weeks: 0 }, [
      [/\/menu$/, menuSelecting(53, 30)],
    ]);
    expect(out.picks.map((p: Any) => p.index)).toEqual([53, 30]);
    expect(out.followUp).toEqual([]);
    expect(out.followUpNote).toBeUndefined();
    expect(out.note).toMatch(/already picked/);
  });

  it('a different selection of the same size still needs a select call', async () => {
    const { out } = await call('hf_weekly_plan', { week: '2026-W49', profile: 'family', avoid_recent_weeks: 0 }, [
      [/\/menu$/, menuSelecting(53)],
    ]);
    expect(out.followUp.map((f: Any) => f.tool)).toEqual(['hf_select_meals']);
  });

  it('past the cutoff: still suggests, but locked with no follow-up writes', async () => {
    const { out } = await call('hf_weekly_plan', { week: '2026-W49', profile: 'family', avoid_recent_weeks: 0 }, [], Date.parse('2026-11-27T00:00:00Z'));
    expect(out.locked).toMatch(/cutoff for 2026-W49 passed/);
    expect(out.followUp).toEqual([]);
    expect(out.picks).toHaveLength(2);
  });

  it('a delivered week is locked', async () => {
    const { out } = await call('hf_weekly_plan', { week: '2026-W49', profile: 'family', avoid_recent_weeks: 0 }, [
      [/\/delivery_dates\/2026-W49$/, { ...W49, status: 'DELIVERED' }],
    ]);
    expect(out.locked).toBe('2026-W49 is delivered: it can no longer be changed.');
    expect(out.followUp).toEqual([]);
  });

  it('no seafood fits → no select call; a week with no cutoff still plans', async () => {
    const noSeafood = { ...MENU, meals: MENU.meals.filter((m: Any) => m.recipe.category !== 'Seafood'), modularity: [] };
    const { out } = await call('hf_weekly_plan', { week: '2026-W49', profile: 'family', avoid_recent_weeks: 0 }, [
      [/\/menu$/, noSeafood],
      [/\/delivery_dates\/2026-W49$/, { ...W49, cutoffDate: undefined, product: { ...W49.product, handle: 'US-CBU-3-4-0', specs: { meals: 3, size: 4 } } }],
      [/deliveries$/, { items: [] }],
    ]);
    expect(out.picks).toEqual([]);
    expect(out.locked).toBeUndefined();
    expect(out.followUp).toEqual([
      {
        tool: 'hf_set_week_size',
        arguments: { week: '2026-W49', people: 6, meals: 2 },
        why: '2026-W49 is US-CBU-3-4-0; the family profile needs US-CBU-2-6-0.',
      },
    ]);
    expect(out.summary).toMatch(/: no picks fit\./);
  });

  it('a people override sizes the box and reprices: the 6-person family on a 4-person week', async () => {
    const { out } = await call('hf_weekly_plan', { week: '2026-W49', profile: 'family', people: 4, avoid_recent_weeks: 0 });
    expect(out.servings).toBe(4);
    expect(out.box).toEqual({ current: 'US-CBU-2-6-0', required: 'US-CBU-2-4-0', sizeChangeNeeded: true });
    expect(out.followUp[0]).toMatchObject({ tool: 'hf_set_week_size', arguments: { week: '2026-W49', people: 4, meals: 2 } });
    expect(out.summary).toMatch(/^Family week \(4 servings\)/);
  });

  it('the profile’s avoidRepeatWeeks sets how far back recent picks are read', async () => {
    const two: LoadedProfiles = { source: 'x', profiles: [{ ...PROFILES.profiles[0]!, avoidRepeatWeeks: 2 }] };
    const { out } = await call('hf_suggest_meals', { week: '2026-W49', profile: 'family' }, [], NOW, () => two);
    expect(out.recentPicks.weeks).toEqual(['2026-W47', '2026-W48']);
  });
});
