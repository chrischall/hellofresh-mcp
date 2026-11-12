import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createTestHarness, parseToolResult, type TestHarness } from '@chrischall/mcp-utils/test';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { HelloFreshClient, type ClientSession } from '../src/client.js';
import { registerReadTools } from '../src/tools/reads.js';
import { boxNumbering } from '../src/tools/shared.js';
import type { ToolDeps } from '../src/tools/index.js';
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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Handler = (url: URL) => Response | Promise<Response>;
type Route = [RegExp, Handler | unknown];

/** Default routes for the synthetic account; a test prepends overrides. */
function defaultRoutes(): Route[] {
  return [
    [/\/api\/customers\/me\/subscriptions$/, { count: 1, items: [SUB] }],
    [/\/api\/customers\/me\/deliveries$/, DELIVERIES],
    [/\/api\/subscriptions\/90000001\/delivery_dates\/2026-W49$/, W49],
    [/\/api\/subscriptions\/90000001\/delivery_dates\/2026-W50$/, W50],
    [/\/my-deliveries\/menu$/, MENU],
  ];
}

let harness: TestHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

/** 2026-11-26 (a Thursday in 2026-W48), noon UTC. */
const NOW = Date.parse('2026-11-26T17:00:00Z');

async function call(name: string, args: Record<string, unknown> = {}, routes: Route[] = [], now = NOW) {
  const urls: URL[] = [];
  const all = [...routes, ...defaultRoutes()];
  const fetchImpl = (async (input: string) => {
    const url = new URL(input);
    urls.push(url);
    const hit = all.find(([re]) => re.test(url.pathname));
    if (!hit) return json({ error: 'not found' }, 404);
    const [, h] = hit;
    return typeof h === 'function' ? (h as Handler)(url) : json(h);
  }) as unknown as typeof fetch;
  const session: ClientSession = { withAuth: (c) => c('tok'), redact: (t) => t };
  const deps: ToolDeps = {
    ...offlineDeps(),
    client: new HelloFreshClient({ session, fetchImpl }),
    now: () => now,
  };
  await harness?.close();
  harness = await createTestHarness((server) => registerReadTools(server, deps));
  const result = await harness.callTool(name, args);
  return { result, urls, text: textOf(result) };
}

const textOf = (r: CallToolResult) => (r.content as { text: string }[])[0]!.text;
const paths = (urls: URL[]) => urls.map((u) => u.pathname);

describe('read tools: registration', () => {
  it('registers six read-only, open-world tools in the food domain', async () => {
    harness = await createTestHarness((server) => registerReadTools(server, offlineDeps()));
    const tools = (await harness.client.listTools()).tools;
    expect(tools.map((t) => t.name).sort()).toEqual([
      'hf_get_delivery',
      'hf_get_menu',
      'hf_get_subscription',
      'hf_list_box_sizes',
      'hf_list_deliveries',
      'hf_recent_picks',
    ]);
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint, t.name).toBe(true);
      expect(t.annotations?.openWorldHint, t.name).toBe(true);
      expect((t._meta as Any).mint.domain, t.name).toBe('food');
    }
    const canonical = tools.filter((t) => (t._meta as Any).mint.canonical);
    expect(canonical.map((t) => t.name)).toEqual(['hf_list_deliveries']);
    expect((canonical[0]!._meta as Any).mint.intent).toBe('whats-on');
    expect(canonical[0]!.inputSchema.properties).toHaveProperty('view');
  });
});

describe('hf_get_subscription', () => {
  it('compact: the allowlisted projection, never name/email/address/payment', async () => {
    const { result, text, urls } = await call('hf_get_subscription');
    expect(paths(urls)).toEqual(['/gw/api/customers/me/subscriptions']);
    const out = parseToolResult<Any>(result);
    expect(out.subscription).toMatchObject({
      id: '90000001',
      sku: 'US-CBU-2-6-0',
      meals: 2,
      people: 6,
      deliveryInterval: 1,
      deliveryOption: 'US-1-0800-2000',
      nextDeliveryWeek: '2026-W49',
      voucher: { code: 'EXAMPLE65', active: true },
    });
    expect(out.subscription.customerPlanId).toBeUndefined();
    expect(text).not.toMatch(/Pat|Example St|pat@example|tok_synthetic|12345678/);
  });

  it('full: adds the plan id and the voucher’s per-box rules', async () => {
    const { result, text } = await call('hf_get_subscription', { view: 'full' });
    const out = parseToolResult<Any>(result);
    expect(out.subscription.customerPlanId).toBe('11111111-2222-4333-8444-555555555555');
    expect(out.subscription.voucher).toEqual({
      code: 'EXAMPLE65',
      active: true,
      discountType: 'percent',
      boxCount: 52,
      boxRules: [
        { box: 1, percent: 65, appliesTo: 'both' },
        { box: 2, percent: 15, appliesTo: 'products' },
        { box: 3, percent: 15, appliesTo: 'products' },
      ],
    });
    expect(text).not.toMatch(/Pat|Example St|pat@example|tok_synthetic/);
  });

  it('full without a voucher leaves it out', async () => {
    const { result } = await call('hf_get_subscription', { view: 'full' }, [
      [/subscriptions$/, { items: [{ ...SUB, voucherInfo: null }] }],
    ]);
    expect(parseToolResult<Any>(result).subscription.voucher).toBeUndefined();
  });

  it('a voucher with no rules lists none', async () => {
    const { result } = await call('hf_get_subscription', { view: 'full' }, [
      [/subscriptions$/, { items: [{ ...SUB, voucherInfo: { code: 'X', is_active: false } }] }],
    ]);
    expect(parseToolResult<Any>(result).subscription.voucher).toEqual({ code: 'X', active: false, boxRules: [] });
  });

  it('a rule with no value counts as 0 %', async () => {
    const voucherInfo = { code: 'X', is_active: true, discount_settings: { discount_rule: { box_rule: { '4': null, '5': {} } } } };
    const { result } = await call('hf_get_subscription', { view: 'full' }, [[/subscriptions$/, { items: [{ ...SUB, voucherInfo }] }]]);
    expect(parseToolResult<Any>(result).subscription.voucher.boxRules).toEqual([
      { box: 4, percent: 0 },
      { box: 5, percent: 0 },
    ]);
  });

  it('prefers the active subscription when there are several', async () => {
    const old = { ...SUB, id: '90000009', isActive: false, canceledAt: '2025-01-01' };
    const { result } = await call('hf_get_subscription', {}, [[/subscriptions$/, { items: [old, SUB] }]]);
    expect(parseToolResult<Any>(result).subscription.id).toBe('90000001');
  });

  it('falls back to the first subscription when none is active', async () => {
    const old = { ...SUB, id: '90000009', isActive: false };
    const { result } = await call('hf_get_subscription', {}, [[/subscriptions$/, { items: [old] }]]);
    expect(parseToolResult<Any>(result).subscription.id).toBe('90000009');
  });

  it('no subscription → an actionable error', async () => {
    const { result, text } = await call('hf_get_subscription', {}, [[/subscriptions$/, { count: 0 }]]);
    expect(result.isError).toBe(true);
    expect(text).toMatch(/no HelloFresh subscription/i);
  });

  it('an upstream failure surfaces as a tool error', async () => {
    const { result, text } = await call('hf_get_subscription', {}, [[/subscriptions$/, () => json({ x: 1 }, 404)]]);
    expect(result.isError).toBe(true);
    expect(text).toMatch(/404/);
  });
});

describe('hf_list_deliveries', () => {
  it('brief: one line per week, in week order', async () => {
    const { result, text } = await call('hf_list_deliveries', { view: 'brief' });
    expect(result.isError).toBeFalsy();
    expect(text.split('\n')).toEqual([
      '2026-W46 — 2026-11-09 — delivered, 2×6, cutoff 11-04',
      '2026-W49 — 2026-11-30 — running, 2×6, cutoff 11-25',
      '2026-W50 — 2026-12-07 — skipped, 2×2, cutoff 12-02',
    ]);
    for (const line of text.split('\n')) expect(line.length).toBeLessThanOrEqual(120);
  });

  it('brief: no deliveries → "-- none"; missing fields degrade, never throw', async () => {
    const empty = await call('hf_list_deliveries', { view: 'brief' }, [[/deliveries$/, { count: 0 }]]);
    expect(empty.text).toBe('-- none');
    const bare = await call('hf_list_deliveries', { view: 'brief' }, [[/deliveries$/, { items: [{ id: '2026-W51' }] }]]);
    expect(bare.text).toBe('2026-W51 — no date — unknown');
    const nameless = await call('hf_list_deliveries', { view: 'brief' }, [[/deliveries$/, { items: [{}, { status: 'RUNNING' }] }]]);
    expect(nameless.text.split('\n')).toEqual(['unknown week — no date — unknown', 'unknown week — no date — running']);
  });

  it('compact: running weeks carry an estimate (box 2 by default), skipped/delivered weeks do not', async () => {
    const { result, urls } = await call('hf_list_deliveries');
    expect(paths(urls)).toEqual(['/gw/api/customers/me/subscriptions', '/gw/api/customers/me/deliveries']);
    const out = parseToolResult<Any>(result);
    expect(out.deliveries.map((d: Any) => d.week)).toEqual(['2026-W46', '2026-W49', '2026-W50']);
    const w49 = out.deliveries[1];
    expect(w49).toMatchObject({
      week: '2026-W49',
      deliveryDate: '2026-11-30',
      cutoffDate: '2026-11-25T23:59:59-05:00',
      status: 'running',
      meals: 2,
      servings: 6,
      sku: 'US-CBU-2-6-0',
      deliveryName: 'Monday 8AM-8PM',
    });
    // 14748 + 1299 fee; 15 % of the product only (box 2: applicable_to products) = 2212.
    expect(w49.estimate).toEqual({ boxNumber: 2, subtotalCents: 16047, discountCents: 2212, totalCents: 13835 });
    expect(out.deliveries[0].estimate).toBeUndefined();
    expect(out.deliveries[2].estimate).toBeUndefined();
    expect(out.estimateNote).toMatch(/premium/);
    expect(out.estimateNote).toMatch(/next_box_number/);
    // The fixture subscription does not say whether its first box was delivered.
    expect(out.estimateNote).toMatch(/does not say whether the first box was delivered.*ASSUMES.*box 2/);
  });

  it('next_box_number moves the voucher rule; a box past the voucher is flagged', async () => {
    const first = parseToolResult<Any>((await call('hf_list_deliveries', { next_box_number: 1 })).result);
    // Box 1: 65 % of product + fee + shipping (applicable_to both) = round(16047 × 0.65) = 10431.
    expect(first.deliveries[1].estimate).toMatchObject({ boxNumber: 1, discountCents: 10431, totalCents: 5616 });
    const late = parseToolResult<Any>((await call('hf_list_deliveries', { next_box_number: 60 })).result);
    expect(late.deliveries[1].estimate).toMatchObject({ boxNumber: 60, discountCents: 0 });
    expect(late.deliveries[1].estimate.warning).toMatch(/boxes 1–52/);
  });

  it('numbers consecutive running weeks', async () => {
    const two = { items: [W49, { ...W49, id: '2026-W51', deliveryDate: '2026-12-14T00:00:00-05:00' }] };
    const out = parseToolResult<Any>((await call('hf_list_deliveries', {}, [[/deliveries$/, two]])).result);
    expect(out.deliveries.map((d: Any) => d.estimate.boxNumber)).toEqual([2, 3]);
  });

  it('first box not yet delivered: the earliest running week is box 1, skipped weeks take no number', async () => {
    const W51 = { ...W49, id: '2026-W51', deliveryDate: '2026-12-14T00:00:00-05:00' };
    const W52 = { ...W49, id: '2026-W52', deliveryDate: '2026-12-21T00:00:00-05:00' };
    const fresh = { ...SUB, firstDeliveryWeek: '2026-W49', firstBoxDelivered: false };
    const routes: Route[] = [
      [/\/api\/customers\/me\/subscriptions$/, { count: 1, items: [fresh] }],
      [/deliveries$/, { items: [W52, W50, W51, W49] }],
    ];
    const out = parseToolResult<Any>((await call('hf_list_deliveries', {}, routes)).result);
    expect(out.deliveries.map((d: Any) => [d.week, d.estimate?.boxNumber])).toEqual([
      ['2026-W49', 1],
      ['2026-W50', undefined],
      ['2026-W51', 2],
      ['2026-W52', 3],
    ]);
    // Box 1: 65 % of product + fee + shipping.
    expect(out.deliveries[0].estimate).toMatchObject({ discountCents: 10431 });
    expect(out.estimateNote).toMatch(/first box is not delivered yet.*box 1/);
    expect(out.estimateNote).not.toMatch(/assum/i);
    // hf_get_delivery numbers the same way.
    const one = parseToolResult<Any>((await call('hf_get_delivery', { week: '2026-W51' }, [
      ...routes,
      [/\/delivery_dates\/2026-W51$/, W51],
    ])).result);
    expect(one.estimate.boxNumber).toBe(2);
    expect(one.boxNumberNote).toMatch(/first box is not delivered yet/);
    // An explicit next_box_number still wins.
    const forced = parseToolResult<Any>((await call('hf_list_deliveries', { next_box_number: 5 }, routes)).result);
    expect(forced.deliveries[0].estimate.boxNumber).toBe(5);
    expect(forced.estimateNote).toMatch(/next_box_number 5/);
  });

  it('first box already delivered: box 2 is an explicit assumption', async () => {
    const established = { ...SUB, firstDeliveryWeek: '2026-W40', firstBoxDelivered: true };
    const out = parseToolResult<Any>(
      (await call('hf_list_deliveries', {}, [[/\/api\/customers\/me\/subscriptions$/, { count: 1, items: [established] }]])).result,
    );
    expect(out.deliveries[1].estimate.boxNumber).toBe(2);
    expect(out.estimateNote).toMatch(/first box was delivered in 2026-W40.*not how many.*ASSUMES.*box 2.*next_box_number/);
  });

  it('full: the whole allowlisted projection and the whole estimate', async () => {
    const { result, text } = await call('hf_list_deliveries', { view: 'full' });
    const w49 = parseToolResult<Any>(result).deliveries[1];
    expect(w49.allowedActions).toEqual(['mealSwap', 'pause', 'oneOffChange', 'updateDeliveryWeekday']);
    expect(w49.oneOffDaySlots).toHaveLength(2);
    expect(w49.estimate).toMatchObject({ estimate: true, productCents: 14748, feeCents: 1299, boxNumber: 2 });
    expect(text).not.toMatch(/Example St|ORDER-SYNTHETIC|tracking/);
  });
});

describe('hf_get_delivery', () => {
  it('compact: the week, its selection and an estimate including the premium of picked meals', async () => {
    const { result, urls } = await call('hf_get_delivery', { week: '2026-W49' });
    expect(paths(urls).sort()).toEqual(
      [
        '/gw/api/customers/me/subscriptions',
        '/gw/api/subscriptions/90000001/delivery_dates/2026-W49',
        '/gw/api/customers/me/deliveries',
        '/gw/my-deliveries/menu',
      ].sort(),
    );
    const menuUrl = urls.find((u) => u.pathname.endsWith('/menu'))!;
    expect(Object.fromEntries(menuUrl.searchParams)).toMatchObject({
      subscription: '90000001',
      week: '2026-W49',
      servings: '6',
      'product-sku': 'US-CBU-2-6-0',
      customerPlanId: '11111111-2222-4333-8444-555555555555',
    });
    const out = parseToolResult<Any>(result);
    expect(out).toMatchObject({ week: '2026-W49', status: 'running', meals: 2, servings: 6, deliveryDate: '2026-11-30' });
    expect(out.selection).toEqual([
      { index: 67, quantity: 1, name: 'Pesto Shrimp Linguine with Lemony Panko Topping' },
      { index: 71, quantity: 1, name: 'Chesapeake Tilapia & Corn Chowder' },
    ]);
    expect(out.estimate).toEqual({ boxNumber: 2, subtotalCents: 16047, discountCents: 2212, totalCents: 13835 });
  });

  it('a premium pick adds its box upcharge; an explicit box_number wins', async () => {
    const menu = structuredClone(MENU);
    for (const m of menu.meals) if (m.index === 47) m.selection = { limit: 1, quantity: 1 };
    const { result } = await call('hf_get_delivery', { week: '2026-W49', box_number: 3, view: 'full' }, [
      [/\/menu$/, menu],
    ]);
    const out = parseToolResult<Any>(result);
    expect(out.selection.find((s: Any) => s.index === 47)).toMatchObject({ premiumBoxCents: 8994 });
    expect(out.estimate).toMatchObject({ boxNumber: 3, premiumCents: 8994, subtotalCents: 16047 + 8994 });
    expect(out.allowedActions).toBeDefined();
  });

  it('a variant pick names its base course', async () => {
    const menu = structuredClone(MENU);
    for (const m of menu.meals) {
      if (m.index === 67) delete m.selection.quantity;
      if (m.index === 560) m.selection = { limit: 1, quantity: 1 };
    }
    const out = parseToolResult<Any>((await call('hf_get_delivery', { week: '2026-W49' }, [[/\/menu$/, menu]])).result);
    expect(out.selection.find((s: Any) => s.index === 560)).toMatchObject({ baseIndex: 67, premiumBoxCents: 2994 });
  });

  it('a skipped week: no menu read, no estimate', async () => {
    const { result, urls } = await call('hf_get_delivery', { week: '2026-W50' });
    expect(paths(urls)).not.toContain('/gw/my-deliveries/menu');
    const out = parseToolResult<Any>(result);
    expect(out.status).toBe('skipped');
    expect(out.selection).toBeUndefined();
    expect(out.estimate).toBeUndefined();
  });

  it('a week outside the upcoming list: estimate undiscounted, saying why', async () => {
    const { result } = await call('hf_get_delivery', { week: '2026-W49' }, [[/deliveries$/, { count: 0 }]]);
    const out = parseToolResult<Any>(result);
    expect(out.estimate.discountCents).toBe(0);
    expect(out.estimate.warning).toMatch(/box number/);
  });

  it('next_box_number shifts the derived box number', async () => {
    const out = parseToolResult<Any>((await call('hf_get_delivery', { week: '2026-W49', next_box_number: 1 })).result);
    expect(out.estimate).toMatchObject({ boxNumber: 1, discountCents: 10431 });
  });

  it('an unknown box number and an unreadable menu: both reasons are given', async () => {
    const { result } = await call('hf_get_delivery', { week: '2026-W49' }, [
      [/deliveries$/, { items: [] }],
      [/\/menu$/, () => json({ e: 1 }, 400)],
    ]);
    const warning = parseToolResult<Any>(result).estimate.warning;
    expect(warning).toMatch(/box number/);
    expect(warning).toMatch(/premium upcharges are not included/);
  });

  it('a menu that cannot be read is reported, not fatal', async () => {
    const { result } = await call('hf_get_delivery', { week: '2026-W49' }, [[/\/menu$/, () => json({ e: 1 }, 400)]]);
    const out = parseToolResult<Any>(result);
    expect(result.isError).toBeFalsy();
    expect(out.selection).toBeUndefined();
    expect(out.selectionError).toMatch(/400/);
    expect(out.estimate.warning).toMatch(/premium/);
  });

  it('falls back to /api/plans when the subscription has no customerPlanId', async () => {
    const sub = { ...SUB, customerPlanId: undefined };
    const plans = [
      { id: 'aaaaaaaa-0000-4000-8000-000000000000', legacySubscriptionId: '90000002' },
      { id: 'bbbbbbbb-0000-4000-8000-000000000000', legacySubscriptionId: '90000001' },
    ];
    const { urls } = await call('hf_get_delivery', { week: '2026-W49' }, [
      [/subscriptions$/, { items: [sub] }],
      [/\/api\/plans$/, plans],
    ]);
    const menuUrl = urls.find((u) => u.pathname.endsWith('/menu'))!;
    expect(menuUrl.searchParams.get('customerPlanId')).toBe('bbbbbbbb-0000-4000-8000-000000000000');
  });

  it('no plan at all → the selection reports why', async () => {
    const sub = { ...SUB, customerPlanId: undefined };
    const { result } = await call('hf_get_delivery', { week: '2026-W49' }, [
      [/subscriptions$/, { items: [sub] }],
      [/\/api\/plans$/, []],
    ]);
    expect(parseToolResult<Any>(result).selectionError).toMatch(/plan/);
  });

  it('a malformed week is rejected before any call', async () => {
    const { result, urls } = await call('hf_get_delivery', { week: '2026-49' });
    expect(result.isError).toBe(true);
    expect(urls).toEqual([]);
  });
});

describe('hf_get_menu', () => {
  const menuOf = async (args: Record<string, unknown>, routes: Route[] = []) => {
    const r = await call('hf_get_menu', { week: '2026-W49', ...args }, routes);
    return { ...r, out: parseToolResult<Any>(r.result) };
  };

  it('compact: base courses with variants nested, the box, and the selection', async () => {
    const { out, urls } = await menuOf({});
    expect(paths(urls)).toEqual([
      '/gw/api/customers/me/subscriptions',
      '/gw/api/subscriptions/90000001/delivery_dates/2026-W49',
      '/gw/my-deliveries/menu',
    ]);
    expect(out.box).toEqual({ sku: 'US-CBU-2-6-0', meals: 2, servings: 6 });
    expect(out.cutoffDate).toBe('2026-11-25T23:59:59-05:00');
    expect(out.total).toBe(15);
    expect(out.shown).toBe(15);
    expect(out.selected.map((s: Any) => s.index)).toEqual([67, 71]);
    const m67 = out.meals.find((m: Any) => m.index === 67);
    expect(m67).toEqual({
      index: 67,
      name: 'Pesto Shrimp Linguine with Lemony Panko Topping',
      category: 'Seafood',
      seafoodKind: 'shrimp',
      kidFriendly: false,
      quick: true,
      totalMinutes: 20,
      selected: 1,
      variants: [
        { index: 560, title: '2x Shrimp', seafoodKind: 'shrimp', premiumPerServingCents: 499, premiumBoxCents: 2994 },
        { index: 558, title: 'Salmon', seafoodKind: 'fish' },
        { index: 565, title: 'Chopped Chicken Breast' },
        { index: 567, title: 'Lobster Tails', seafoodKind: 'other', premiumPerServingCents: 1199, premiumBoxCents: 7194 },
      ],
    });
    const m47 = out.meals.find((m: Any) => m.index === 47);
    expect(m47).toMatchObject({ premiumPerServingCents: 1499, premiumBoxCents: 8994 });
    expect(m47.selected).toBeUndefined();
    expect(m47.variants).toBeUndefined();
  });

  it('full: every projected field', async () => {
    const { out } = await menuOf({ view: 'full' });
    const m1 = out.meals.find((m: Any) => m.index === 1);
    expect(m1).toMatchObject({ headline: expect.any(String), tags: expect.any(Array), url: expect.any(String), premiumBoxCents: 0 });
  });

  it('seafood_only keeps seafood courses, and a non-seafood course only for a seafood swap', async () => {
    const menu = structuredClone(MENU);
    // Make #1 (chicken) offer a shrimp swap via #560's slot.
    menu.modularity.find((m: Any) => m.defaultCourseIndex === 1).variations = [{ index: 13, title: 'Shrimp', category: 'Seafood' }];
    const { out } = await menuOf({ seafood_only: true }, [[/\/menu$/, menu]]);
    const indexes = out.meals.map((m: Any) => m.index);
    expect(indexes).not.toContain(2);
    expect(indexes).not.toContain(81);
    expect(indexes).toContain(1);
    expect(out.meals.find((m: Any) => m.index === 1)).toMatchObject({ onlyVariantsMatch: true, variants: [{ index: 13 }] });
    expect(out.meals.find((m: Any) => m.index === 67).variants.map((v: Any) => v.index)).toEqual([560, 558, 567]);
    expect(out.total).toBe(14);
  });

  it('kid_friendly + max_minutes filter on the base recipe', async () => {
    const { out } = await menuOf({ kid_friendly: true, max_minutes: 25 });
    expect(out.meals.map((m: Any) => m.index).sort((a: number, b: number) => a - b)).toEqual([1, 53]);
    expect(out.filters).toEqual({ kid_friendly: true, max_minutes: 25 });
  });

  it('max_minutes skips meals with no time', async () => {
    const menu = structuredClone(MENU);
    for (const m of menu.meals) {
      delete m.recipe.prepTime;
      delete m.recipe.totalTime;
    }
    const { out } = await menuOf({ max_minutes: 60 }, [[/\/menu$/, menu]]);
    expect(out.meals).toEqual([]);
  });

  it('max_premium_per_serving drops premium courses and premium swaps', async () => {
    const { out } = await menuOf({ seafood_only: true, max_premium_per_serving: 500 });
    const indexes = out.meals.map((m: Any) => m.index);
    expect(indexes).not.toContain(47);
    expect(indexes).not.toContain(78);
    expect(out.meals.find((m: Any) => m.index === 67).variants.map((v: Any) => v.index)).toEqual([560, 558]);
  });

  it('selected_only: the picked courses (or a course whose swap is picked)', async () => {
    const menu = structuredClone(MENU);
    for (const m of menu.meals) {
      if (m.index === 67) delete m.selection.quantity;
      if (m.index === 560) m.selection = { limit: 1, quantity: 1 };
    }
    const { out } = await menuOf({ selected_only: true }, [[/\/menu$/, menu]]);
    expect(out.meals.map((m: Any) => m.index)).toEqual([67, 71]);
    expect(out.meals[0]).toMatchObject({ onlyVariantsMatch: true, variants: [{ index: 560, selected: 1 }] });
  });

  it('a delivery with no box size cannot be read', async () => {
    const { result, text } = await call('hf_get_menu', { week: '2026-W49' }, [
      [/delivery_dates\/2026-W49$/, { ...W49, product: {} }],
    ]);
    expect(result.isError).toBe(true);
    expect(text).toMatch(/box size/);
  });

  it('a menu that is not ready says so', async () => {
    const { out } = await menuOf({}, [[/\/menu$/, { week: '2026-W49', mealsReady: false }]]);
    expect(out).toMatchObject({ mealsReady: false, total: 0, meals: [] });
  });
});

describe('hf_list_box_sizes', () => {
  const OPTIONS = {
    items: [
      {
        handle: 'classic-box-unified',
        name: 'Classic',
        products: [
          { handle: 'US-CBU-3-4-0', specs: { meals: 3, size: 4 } },
          { handle: 'US-CBU-2-6-0', specs: { meals: '2', size: '6' } },
          { handle: 'US-CBU-2-2-0' },
          { specs: { meals: 4, size: 2 } },
        ],
      },
      { handle: 'empty' },
    ],
  };

  it('compact: every size, sorted, the current one marked', async () => {
    const { result, urls } = await call('hf_list_box_sizes', {}, [[/product_options$/, OPTIONS]]);
    expect(paths(urls)).toEqual(['/gw/api/customers/me/subscriptions', '/gw/api/subscriptions/90000001/product_options']);
    expect(parseToolResult<Any>(result)).toEqual({
      current: 'US-CBU-2-6-0',
      sizes: [
        { sku: 'US-CBU-2-2-0', meals: 2, people: 2 },
        { sku: 'US-CBU-2-6-0', meals: 2, people: 6, current: true },
        { sku: 'US-CBU-3-4-0', meals: 3, people: 4 },
      ],
    });
  });

  it('full: the groups as HelloFresh names them', async () => {
    const out = parseToolResult<Any>((await call('hf_list_box_sizes', { view: 'full' }, [[/product_options$/, OPTIONS]])).result);
    expect(out.groups[0]).toMatchObject({ handle: 'classic-box-unified', name: 'Classic' });
    expect(out.groups[0].products).toHaveLength(3);
    expect(out.groups[1]).toEqual({ handle: 'empty', products: [] });
  });

  it('no options → an empty list', async () => {
    const out = parseToolResult<Any>((await call('hf_list_box_sizes', {}, [[/product_options$/, {}]])).result);
    expect(out.sizes).toEqual([]);
  });
});

describe('hf_recent_picks', () => {
  const week = (id: string, extra: Record<string, unknown> = {}) => ({ ...W49, id, ...extra });

  it('reads each week from weeks_back before through_week, reporting picks, skips and unreadable weeks', async () => {
    const routes: Route[] = [
      [/delivery_dates\/2026-W46$/, week('2026-W46', { status: 'DELIVERED' })],
      [/delivery_dates\/2026-W47$/, week('2026-W47', { status: 'PAUSED' })],
      [/delivery_dates\/2026-W48$/, () => json({ errorMessage: 'not found' }, 404)],
      [/\/menu$/, (url: URL) => (url.searchParams.get('week') === '2026-W49' ? json({ e: 1 }, 500) : json(MENU))],
    ];
    const { result, urls } = await call('hf_recent_picks', { weeks_back: 3, through_week: '2026-W49' }, routes);
    const out = parseToolResult<Any>(result);
    expect(out.weeks.map((w: Any) => [w.week, w.status])).toEqual([
      ['2026-W46', 'delivered'],
      ['2026-W47', 'skipped'],
    ]);
    expect(out.weeks[0].picks).toEqual([
      { index: 67, quantity: 1, name: 'Pesto Shrimp Linguine with Lemony Panko Topping' },
      { index: 71, quantity: 1, name: 'Chesapeake Tilapia & Corn Chowder' },
    ]);
    expect(out.weeks[1].picks).toEqual([]);
    expect(out.unreadable.map((u: Any) => u.week)).toEqual(['2026-W48', '2026-W49']);
    expect(out.unreadable[0].reason).toMatch(/404/);
    expect(out.recipeNames).toEqual([
      'Pesto Shrimp Linguine with Lemony Panko Topping',
      'Chesapeake Tilapia & Corn Chowder',
    ]);
    // Skipped weeks never read a menu.
    expect(urls.filter((u) => u.pathname.endsWith('/menu')).map((u) => u.searchParams.get('week')).sort()).toEqual([
      '2026-W46',
      '2026-W49',
    ]);
  });

  it('defaults: the current ISO week (from the clock) and the 4 before it', async () => {
    const { result, urls } = await call('hf_recent_picks', {}, [[/delivery_dates\//, () => json({ status: 'PAUSED' })]]);
    const out = parseToolResult<Any>(result);
    expect(out.throughWeek).toBe('2026-W48');
    expect(out.weeks.map((w: Any) => w.week)).toEqual(['2026-W44', '2026-W45', '2026-W46', '2026-W47', '2026-W48']);
    expect(out.unreadable).toBeUndefined();
    expect(urls.filter((u) => u.pathname.includes('/delivery_dates/'))).toHaveLength(5);
  });

  it('weeks before the subscription\'s first delivery week are "no box" (never read), not unreadable', async () => {
    const { result, urls } = await call('hf_recent_picks', { weeks_back: 3, through_week: '2026-W49' }, [
      [/\/api\/customers\/me\/subscriptions$/, { count: 1, items: [{ ...SUB, firstDeliveryWeek: '2026-W48' }] }],
      [/delivery_dates\/2026-W48$/, week('2026-W48', { status: 'PAUSED' })],
    ]);
    const out = parseToolResult<Any>(result);
    expect(out.weeks.map((w: Any) => [w.week, w.status])).toEqual([
      ['2026-W46', 'no_box'],
      ['2026-W47', 'no_box'],
      ['2026-W48', 'skipped'],
      ['2026-W49', 'running'],
    ]);
    expect(out.weeks[0].picks).toEqual([]);
    expect(out.firstDeliveryWeek).toBe('2026-W48');
    expect(out.unreadable).toBeUndefined();
    const read = urls.filter((u) => u.pathname.includes('/delivery_dates/')).map((u) => u.pathname.slice(-8)).sort();
    expect(read).toEqual(['2026-W48', '2026-W49']);
  });

  it('a genuine failure ON or after the first delivery week is still unreadable', async () => {
    const { result } = await call('hf_recent_picks', { weeks_back: 1, through_week: '2026-W49' }, [
      [/\/api\/customers\/me\/subscriptions$/, { count: 1, items: [{ ...SUB, firstDeliveryWeek: '2026-W48' }] }],
      [/delivery_dates\/2026-W48$/, () => json({ errorMessage: 'not found' }, 404)],
    ]);
    const out = parseToolResult<Any>(result);
    expect(out.unreadable.map((u: Any) => u.week)).toEqual(['2026-W48']);
    expect(out.weeks.map((w: Any) => w.week)).toEqual(['2026-W49']);
  });

  it('the current week honours MCP_USER_TZ (the user\'s wall-clock date, not UTC)', async () => {
    // Monday 2026-11-30 03:00 UTC is still Sunday evening in New York: 2026-W48 there, 2026-W49 in UTC.
    const instant = Date.parse('2026-11-30T03:00:00Z');
    const routes: Route[] = [[/delivery_dates\//, () => json({ status: 'PAUSED' })]];
    try {
      vi.stubEnv('MCP_USER_TZ', 'America/New_York');
      expect(parseToolResult<Any>((await call('hf_recent_picks', { weeks_back: 0 }, routes, instant)).result).throughWeek).toBe('2026-W48');
      vi.stubEnv('MCP_USER_TZ', 'UTC');
      expect(parseToolResult<Any>((await call('hf_recent_picks', { weeks_back: 0 }, routes, instant)).result).throughWeek).toBe('2026-W49');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('a week with no box size is unreadable', async () => {
    const { result } = await call('hf_recent_picks', { weeks_back: 0, through_week: '2026-W49' }, [
      [/delivery_dates\/2026-W49$/, { ...W49, product: {} }],
    ]);
    expect(parseToolResult<Any>(result).unreadable[0].reason).toMatch(/box size/);
  });

  it('a failed subscription read fails the call', async () => {
    const { result } = await call('hf_recent_picks', {}, [[/subscriptions$/, () => json({}, 500)]]);
    expect(result.isError).toBe(true);
  });
});

describe('boxNumbering', () => {
  it('names the first delivery week only when HelloFresh gives it', () => {
    expect(boxNumbering({ firstBoxDelivered: false }, undefined)).toEqual({
      next: 1,
      note: expect.stringMatching(/first box is not delivered yet, so the earliest running delivery is box 1/),
    });
    expect(boxNumbering({ firstBoxDelivered: true }, undefined)).toEqual({
      next: 2,
      note: expect.stringMatching(/^HelloFresh says the first box was delivered but not how many boxes since, so this ASSUMES/),
    });
  });
});
