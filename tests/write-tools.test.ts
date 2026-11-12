import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createTestHarness, parseToolResult, type TestHarness } from '@chrischall/mcp-utils/test';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { HelloFreshClient, type ClientSession } from '../src/client.js';
import { registerWriteTools } from '../src/tools/writes/index.js';
import { sleepMs } from '../src/tools/shared.js';
import type { ToolDeps } from '../src/tools/index.js';
import { offlineDeps } from './helpers.js';

// Synthetic fixtures only (see tests/fixtures/*.json) — never a real account.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const fixture = (name: string): Any => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));

const SUB = fixture('subscription');
const DELIVERIES = fixture('deliveries');
const MENU = fixture('menu-W49');
const W49 = DELIVERIES.items[0];
const W50 = DELIVERIES.items[1];
const PLAN_ID = '11111111-2222-4333-8444-555555555555';
const PLANS = [{ id: PLAN_ID, planType: 'regular', planItems: [{ productHandle: 'US-CBU-2-6-0' }], legacySubscriptionId: '90000001' }];
const SIZES = ['US-CBU-2-2-0', 'US-CBU-2-4-0', 'US-CBU-2-6-0', 'US-CBU-3-2-0', 'US-CBU-3-4-0'];
const OPTIONS = {
  items: [{ handle: 'classic-box-unified', name: 'Classic', products: SIZES.map((handle) => ({ handle })) }],
};

/** 2026-11-20 (before W49's cutoff on 11-25), noon UTC. */
const BEFORE_CUTOFF = Date.parse('2026-11-20T12:00:00Z');
const AFTER_CUTOFF = Date.parse('2026-11-26T17:00:00Z');

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The menu with exactly `picks` (index → quantity) selected. */
function menuWith(picks: Record<number, number>) {
  const menu = structuredClone(MENU);
  for (const m of menu.meals) {
    if (m.selection) delete m.selection.quantity;
    const q = picks[m.index];
    if (q) m.selection = { ...(m.selection ?? { limit: 2 }), quantity: q };
  }
  return menu;
}

type Handler = (url: URL, body: unknown) => Response | Promise<Response>;
/** `[METHOD path-regex, body-or-handler]`. */
type Route = [string, RegExp, Handler | unknown];

interface Sent {
  method: string;
  url: URL;
  body: unknown;
}

function baseRoutes(): Route[] {
  return [
    ['GET', /\/api\/customers\/me\/subscriptions$/, { count: 1, items: [SUB] }],
    ['GET', /\/api\/subscriptions\/90000001$/, SUB],
    ['GET', /\/api\/customers\/me\/deliveries$/, DELIVERIES],
    ['GET', /\/delivery_dates\/2026-W49$/, W49],
    ['GET', /\/delivery_dates\/2026-W50$/, W50],
    ['GET', /\/my-deliveries\/menu$/, MENU],
    ['GET', /\/product_options$/, OPTIONS],
    ['GET', /\/api\/plans$/, PLANS],
    ['PUT', /\/v1\/carts\//, { hasSeamlessDowngraded: false }],
    ['PATCH', /\/delivery_dates\//, () => json({ count: 1, items: [] }, 201)],
    ['POST', /\/oneoff$/, () => json({ count: 1, items: [] }, 201)],
    ['PUT', /\/carts\/[^/]+\/size$/, () => new Response(null, { status: 204 })],
    ['PATCH', /\/api\/plans\//, () => new Response(null, { status: 204 })],
    ['POST', /\/changePlanDeliveryDetails$/, () => new Response('', { status: 200 })],
  ];
}

let harness: TestHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

interface SetupOptions {
  /** Routes answered before any write was sent. */
  routes?: Route[];
  /** Routes answered once a write has been sent (the re-read). */
  after?: Route[];
  now?: number;
}

async function setup(opts: SetupOptions = {}) {
  const sent: Sent[] = [];
  const sleeps: number[] = [];
  const fetchImpl = (async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const written = sent.some((s) => s.method !== 'GET');
    sent.push({ method, url, body });
    const all = [...(written ? (opts.after ?? []) : []), ...(opts.routes ?? []), ...baseRoutes()];
    const hit = all.find(([m, re]) => m === method && re.test(url.pathname));
    if (!hit) return json({ error: 'not found' }, 404);
    const h = hit[2];
    return typeof h === 'function' ? (h as Handler)(url, body) : json(h);
  }) as unknown as typeof fetch;
  const session: ClientSession = { withAuth: (c) => c('tok'), redact: (t) => t };
  const deps: ToolDeps = {
    ...offlineDeps(),
    client: new HelloFreshClient({ session, fetchImpl }),
    now: () => opts.now ?? BEFORE_CUTOFF,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  };
  harness = await createTestHarness((server) => registerWriteTools(server, deps));
  const h = harness;
  return {
    sent,
    sleeps,
    writes: () => sent.filter((s) => s.method !== 'GET'),
    call: (name: string, args: Record<string, unknown>) => h.callTool(name, args),
    /** Phase 1 (preview) then phase 2 with its token. */
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

async function expectRefused(name: string, args: Record<string, unknown>, pattern: RegExp, opts: SetupOptions = {}) {
  const t = await setup(opts);
  const result = await t.call(name, args);
  expect(result.isError, textOf(result)).toBe(true);
  expect(textOf(result)).toMatch(pattern);
  expect(t.writes()).toEqual([]);
}

describe('write tools: registration', () => {
  it('registers seven gated, annotated write tools in the food domain', async () => {
    harness = await createTestHarness((server) => registerWriteTools(server, offlineDeps()));
    const tools = (await harness.client.listTools()).tools;
    expect(tools.map((t) => t.name).sort()).toEqual([
      'hf_change_delivery_schedule',
      'hf_change_plan_size',
      'hf_select_meals',
      'hf_set_week_delivery_day',
      'hf_set_week_size',
      'hf_skip_week',
      'hf_unskip_week',
    ]);
    const destructive: Record<string, boolean> = {
      hf_select_meals: false,
      hf_set_week_size: false,
      hf_set_week_delivery_day: false,
      hf_skip_week: false,
      hf_unskip_week: false,
      hf_change_plan_size: true,
      hf_change_delivery_schedule: true,
    };
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint, t.name).toBe(false);
      expect(t.annotations?.destructiveHint, t.name).toBe(destructive[t.name]);
      expect(t.annotations?.openWorldHint, t.name).toBe(true);
      expect(t.inputSchema.properties, t.name).toHaveProperty('confirmToken');
      expect(t.description, t.name).toMatch(/confirmToken/);
      expect(t.description, t.name).toMatch(/Never make this write/);
      expect((t._meta as Any).mint, t.name).toMatchObject({ domain: 'food', intent: 'change' });
    }
  });
});

describe('sleepMs (the default re-read back-off)', () => {
  it('resolves after the given time', async () => {
    vi.useFakeTimers();
    try {
      let done = false;
      const p = sleepMs(1500).then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(1499);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await p;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('write tools: descriptions', () => {
  it('hf_change_plan_size warns that it resets week-only sizes; hf_set_week_size names the first-box rule', async () => {
    harness = await createTestHarness((server) => registerWriteTools(server, offlineDeps()));
    const tools = (await harness.client.listTools()).tools;
    const desc = (n: string) => tools.find((t) => t.name === n)!.description!;
    expect(desc('hf_change_plan_size')).toMatch(/resets?.*one-week size.*hf_set_week_size/i);
    expect(desc('hf_set_week_size')).toMatch(/first box/i);
    expect(desc('hf_set_week_size')).toMatch(/meal picks/i);
  });
});

describe('hf_select_meals', () => {
  const args = { week: '2026-W49', meals: [30, { index: 13, quantity: 1 }] };

  it('phase 1 previews the exact cart PUT and sends nothing', async () => {
    const t = await setup();
    const preview = parseToolResult<Any>(await t.call('hf_select_meals', args));
    expect(preview.status).toBe('confirmation-required');
    expect(typeof preview.confirmToken).toBe('string');
    expect(t.writes()).toEqual([]);
    expect(preview.preview).toMatchObject({
      method: 'PUT',
      path: '/gw/v1/carts/2026-W49',
      willSendQuery: {
        subscription: '90000001',
        customer: 12345678,
        week: '2026-W49',
        'product-sku': 'US-CBU-2-6-0',
        preference: 'pescatarian',
        update_quantity: 'false',
        ignore_addons: 'false',
      },
      willSend: { extras: [], meals: [{ index: 30, quantity: 1 }, { index: 13, quantity: 1 }] },
    });
    const shown = JSON.stringify(preview.preview);
    expect(shown).toContain('Pesto Shrimp Linguine'); // the current picks
    expect(shown).not.toMatch(/Pat|pat@example|Example St|tok_synthetic/);
  });

  it('phase 2 sends exactly the documented request and verifies by re-reading the menu', async () => {
    const t = await setup({ after: [['GET', /\/my-deliveries\/menu$/, menuWith({ 30: 1, 13: 1 })]] });
    const { phase1Writes, out } = await t.twoPhase('hf_select_meals', args);
    expect(phase1Writes).toBe(0);
    const [put] = t.writes();
    expect(t.writes()).toHaveLength(1);
    expect(put!.method).toBe('PUT');
    expect(put!.url.pathname).toBe('/gw/v1/carts/2026-W49');
    expect(put!.url.search).toBe(
      '?subscription=90000001&customer=12345678&week=2026-W49&product-sku=US-CBU-2-6-0&preference=pescatarian&update_quantity=false&ignore_addons=false',
    );
    expect(put!.body).toEqual({ extras: [], meals: [{ index: 30, quantity: 1 }, { index: 13, quantity: 1 }] });
    expect(out.status).toBe('verified');
    expect(out.before.map((p: Any) => p.index)).toEqual([67, 71]);
    expect(out.after.map((p: Any) => p.index).sort()).toEqual([13, 30]);
  });

  it('a re-read that does not show the picks reports unverified', async () => {
    const t = await setup();
    const { out } = await t.twoPhase('hf_select_meals', args);
    expect(out.status).toBe('unverified');
    expect(out.warning).toMatch(/does not show/);
  });

  it('a re-read that fails reports unverified with the reason', async () => {
    const t = await setup({ after: [['GET', /\/my-deliveries\/menu$/, () => json({ e: 1 }, 500)]] });
    const { out } = await t.twoPhase('hf_select_meals', args);
    expect(out.status).toBe('unverified');
    expect(out.verifyError).toMatch(/500/);
  });

  it('reports a seamless downgrade when HelloFresh flags one', async () => {
    const t = await setup({
      routes: [['PUT', /\/v1\/carts\//, { hasSeamlessDowngraded: true }]],
      after: [['GET', /\/my-deliveries\/menu$/, menuWith({ 30: 1, 13: 1 })]],
    });
    const { out } = await t.twoPhase('hf_select_meals', args);
    expect(out.hasSeamlessDowngraded).toBe(true);
  });

  it('merges a repeated index into one line with the summed quantity, and accepts a protein swap', async () => {
    const t = await setup({ after: [['GET', /\/my-deliveries\/menu$/, menuWith({ 560: 2 })]] });
    const { out } = await t.twoPhase('hf_select_meals', { week: '2026-W49', meals: [560, 560] });
    expect(t.writes()[0]!.body).toEqual({ extras: [], meals: [{ index: 560, quantity: 2 }] });
    expect(out.status).toBe('verified');
  });

  it('the confirmation summary counts meals by total quantity, not by distinct index', async () => {
    const t = await setup();
    const preview = parseToolResult<Any>(await t.call('hf_select_meals', { week: '2026-W49', meals: [560, 560] }));
    expect(JSON.stringify(preview)).toContain('Pick 2 meal(s) for the 2026-W49 box (2×6)');
  });

  it('names a protein swap by its title when the recipe has no name', async () => {
    const menu = structuredClone(MENU);
    for (const m of menu.meals) if (m.index === 560) delete m.recipe.name;
    const t = await setup({ routes: [['GET', /\/my-deliveries\/menu$/, menu]] });
    const preview = parseToolResult<Any>(await t.call('hf_select_meals', { week: '2026-W49', meals: [560, 30] }));
    expect(preview.preview.newPicks[0]).toEqual({ index: 560, quantity: 1, name: '2x Shrimp' });
  });

  it('a 5xx after the PUT was sent is an unknown outcome, not an error', async () => {
    const t = await setup({ routes: [['PUT', /\/v1\/carts\//, () => json({ e: 1 }, 502)]] });
    const { result, out } = await t.twoPhase('hf_select_meals', args);
    expect(result.isError).toBeFalsy();
    expect(out.status).toBe('unknown');
    expect(out.warning).toMatch(/502/);
    expect(out.warning).toMatch(/hf_get_delivery/);
  });

  it('a 4xx from the PUT is a plain error', async () => {
    const t = await setup({ routes: [['PUT', /\/v1\/carts\//, () => json({ e: 'bad' }, 400)]] });
    const { result } = await t.twoPhase('hf_select_meals', args);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/400/);
  });

  it('a token minted for other meals does not write', async () => {
    const t = await setup();
    const preview = parseToolResult<Any>(await t.call('hf_select_meals', args));
    const result = await t.call('hf_select_meals', { week: '2026-W49', meals: [30, 12], confirmToken: preview.confirmToken });
    expect(t.writes()).toEqual([]);
    expect(result.isError ?? JSON.parse(textOf(result)).status === 'confirmation-required').toBeTruthy();
  });

  it('refuses the wrong number of meals', () =>
    expectRefused('hf_select_meals', { week: '2026-W49', meals: [30] }, /takes 2 meals.*picked 1/));

  it('refuses an index that is not on the week’s menu', () =>
    expectRefused('hf_select_meals', { week: '2026-W49', meals: [30, 999] }, /999.*not on the 2026-W49 menu/));

  it('refuses after the cutoff', () =>
    expectRefused('hf_select_meals', args, /cutoff.*passed/i, { now: AFTER_CUTOFF }));

  it('refuses a skipped week, pointing at hf_unskip_week', () =>
    expectRefused('hf_select_meals', { week: '2026-W50', meals: [30, 13] }, /skipped.*hf_unskip_week/));

  it('refuses a delivered week', () =>
    expectRefused('hf_select_meals', args, /delivered/, { routes: [['GET', /delivery_dates\/2026-W49$/, { ...W49, status: 'DELIVERED' }]] }));

  it('refuses when HelloFresh does not allow a meal swap', () =>
    expectRefused('hf_select_meals', args, /does not allow/, {
      routes: [['GET', /delivery_dates\/2026-W49$/, { ...W49, allowedActions: { mealSwap: false } }]],
    }));

  it('refuses when the delivery has no meal count', () =>
    expectRefused('hf_select_meals', args, /meal count/, {
      routes: [['GET', /delivery_dates\/2026-W49$/, { ...W49, product: { ...W49.product, handle: 'X', specs: {} } }]],
    }));

  it('refuses when the subscription lacks the customer id or preset the cart needs', async () => {
    await expectRefused('hf_select_meals', args, /customer id/, {
      routes: [['GET', /subscriptions$/, { items: [{ ...SUB, customer: {} }] }]],
    });
    await harness?.close();
    await expectRefused('hf_select_meals', args, /preset/, {
      routes: [['GET', /subscriptions$/, { items: [{ ...SUB, preset: undefined }] }]],
    });
  });

  it('rejects an empty selection before any call', async () => {
    const t = await setup();
    const result = await t.call('hf_select_meals', { week: '2026-W49', meals: [] });
    expect(result.isError).toBe(true);
    expect(t.sent).toEqual([]);
  });
});

describe('hf_set_week_size', () => {
  const args = { week: '2026-W49', people: 2 };
  const resized = { ...W49, product: { ...W49.product, handle: 'US-CBU-2-2-0', specs: { meals: 2, size: 2 } } };

  it('phase 1 previews the carts/size PUT (not the one-off) and warns about picks', async () => {
    const t = await setup();
    const preview = parseToolResult<Any>(await t.call('hf_set_week_size', args));
    expect(t.writes()).toEqual([]);
    expect(preview.preview).toMatchObject({
      method: 'PUT',
      path: '/gw/carts/2026-W49/size',
      willSendQuery: { country: 'US', locale: 'en-US', subscription: '90000001' },
      willSend: { productHandle: 'US-CBU-2-2-0', hfMarketCode: 'US' },
      from: { sku: 'US-CBU-2-6-0', meals: 2, people: 6 },
      to: { sku: 'US-CBU-2-2-0', meals: 2, people: 2 },
    });
    expect(preview.preview.willSend).not.toHaveProperty('source');
    expect(preview.preview.warning).toMatch(/reset/);
  });

  it('phase 2 sends the documented size PUT and verifies the new size by re-reading the week', async () => {
    const t = await setup({
      after: [
        ['GET', /delivery_dates\/2026-W49$/, resized],
        ['GET', /\/my-deliveries\/menu$/, menuWith({})],
      ],
    });
    const { out } = await t.twoPhase('hf_set_week_size', args);
    const [put] = t.writes();
    expect(t.writes()).toHaveLength(1);
    expect(put!.method).toBe('PUT');
    expect(put!.url.pathname).toBe('/gw/carts/2026-W49/size');
    expect(put!.url.search).toBe('?country=US&locale=en-US&subscription=90000001');
    expect(put!.body).toEqual({ productHandle: 'US-CBU-2-2-0', hfMarketCode: 'US' });
    expect(t.sent.some((s) => s.url.pathname.endsWith('/oneoff'))).toBe(false);
    expect(out.status).toBe('verified');
    expect(out.before).toMatchObject({ sku: 'US-CBU-2-6-0' });
    expect(out.after).toMatchObject({ sku: 'US-CBU-2-2-0', deliveryOption: 'US-1-0800-2000' });
    const menuAfter = t.sent.filter((s) => s.url.pathname.endsWith('/menu')).at(-1)!;
    expect(menuAfter.url.searchParams.get('product-sku')).toBe('US-CBU-2-2-0');
    expect(out.picksAfter).toEqual([]);
    expect(out.warning).toMatch(/picks were reset.*hf_select_meals/);
  });

  it('an empty / non-JSON 2xx answer to the size PUT is fine', async () => {
    const t = await setup({
      routes: [['PUT', /\/carts\/2026-W49\/size$/, () => new Response('OK', { status: 200 })]],
      after: [['GET', /delivery_dates\/2026-W49$/, resized]],
    });
    const { out } = await t.twoPhase('hf_set_week_size', args);
    expect(out.status).toBe('verified');
  });

  it('re-reads up to 3 times, ~1.5 s apart, before reporting unverified', async () => {
    let reads = 0;
    const t = await setup({
      after: [['GET', /delivery_dates\/2026-W49$/, () => json(++reads >= 3 ? resized : W49)]],
    });
    const { out } = await t.twoPhase('hf_set_week_size', args);
    expect(out.status).toBe('verified');
    expect(reads).toBe(3);
    expect(t.sleeps).toEqual([1500, 1500]);
  });

  it('a week still at the old size after 3 re-reads reports unverified', async () => {
    const t = await setup();
    const { out } = await t.twoPhase('hf_set_week_size', args);
    expect(out.status).toBe('unverified');
    const reads = t.sent.filter((s, i) => s.url.pathname.endsWith('/delivery_dates/2026-W49') && i > t.sent.findIndex((x) => x.method === 'PUT'));
    expect(reads).toHaveLength(3);
    expect(t.sleeps).toEqual([1500, 1500]);
  });

  it('refuses the subscription’s first box while it is undelivered (HelloFresh will not resize it), sending nothing', () =>
    expectRefused('hf_set_week_size', args, /first box.*does not allow resizing the first box/i, {
      routes: [['GET', /\/api\/customers\/me\/subscriptions$/, { count: 1, items: [{ ...SUB, firstDeliveryWeek: '2026-W49', firstBoxDelivered: false }] }]],
    }));

  it('a first box already delivered does not block a later week', async () => {
    const t = await setup({
      routes: [['GET', /\/api\/customers\/me\/subscriptions$/, { count: 1, items: [{ ...SUB, firstDeliveryWeek: '2026-W49', firstBoxDelivered: true }] }]],
    });
    const preview = parseToolResult<Any>(await t.call('hf_set_week_size', args));
    expect(preview.preview.willSend.productHandle).toBe('US-CBU-2-2-0');
  });

  it('picks that survive are reported without a reset warning', async () => {
    const t = await setup({ after: [['GET', /delivery_dates\/2026-W49$/, resized]] });
    const { out } = await t.twoPhase('hf_set_week_size', args);
    expect(out.status).toBe('verified');
    expect(out.picksAfter.map((p: Any) => p.index)).toEqual([67, 71]);
    expect(out.warning).toBeUndefined();
  });

  it('an unreadable menu after the change is noted, not fatal', async () => {
    const t = await setup({
      after: [
        ['GET', /delivery_dates\/2026-W49$/, resized],
        ['GET', /\/my-deliveries\/menu$/, () => json({ e: 1 }, 400)],
      ],
    });
    const { out } = await t.twoPhase('hf_set_week_size', args);
    expect(out.status).toBe('verified');
    expect(out.picksError).toMatch(/400/);
  });

  it('meals changes the meal count too', async () => {
    const t = await setup();
    const preview = parseToolResult<Any>(await t.call('hf_set_week_size', { week: '2026-W49', people: 4, meals: 3 }));
    expect(preview.preview.willSend.productHandle).toBe('US-CBU-3-4-0');
  });

  it('a menu that cannot be read before the change leaves the current picks out of the preview', async () => {
    const t = await setup({ routes: [['GET', /\/my-deliveries\/menu$/, () => json({ e: 1 }, 400)]] });
    const preview = parseToolResult<Any>(await t.call('hf_set_week_size', args));
    expect(preview.preview.currentPicks).toBeUndefined();
  });

  it('picks unknown before the change and empty after: no reset claimed', async () => {
    const t = await setup({
      routes: [['GET', /\/my-deliveries\/menu$/, () => json({ e: 1 }, 400)]],
      after: [
        ['GET', /delivery_dates\/2026-W49$/, resized],
        ['GET', /\/my-deliveries\/menu$/, menuWith({})],
      ],
    });
    const { out } = await t.twoPhase('hf_set_week_size', args);
    expect(out.status).toBe('verified');
    expect(out.picksAfter).toEqual([]);
    expect(out.warning).toBeUndefined();
  });

  it('box-size options with missing groups or handles offer nothing', async () => {
    await expectRefused('hf_set_week_size', args, /cannot switch to US-CBU-2-2-0/, {
      routes: [['GET', /\/product_options$/, { items: [{ products: [{ specs: {} }] }, {}] }]],
    });
    await harness?.close();
    await expectRefused('hf_set_week_size', args, /cannot switch to US-CBU-2-2-0/, { routes: [['GET', /\/product_options$/, {}]] });
  });

  it('refuses a size the subscription cannot switch to, listing the ones it can', () =>
    expectRefused('hf_set_week_size', { week: '2026-W49', people: 6, meals: 4 }, /US-CBU-4-6-0.*US-CBU-2-2-0/));

  it('refuses the size the week already has', () =>
    expectRefused('hf_set_week_size', { week: '2026-W49', people: 6 }, /already/));

  it('refuses after the cutoff and on a skipped week', async () => {
    await expectRefused('hf_set_week_size', args, /cutoff/i, { now: AFTER_CUTOFF });
    await harness?.close();
    await expectRefused('hf_set_week_size', { week: '2026-W50', people: 4 }, /skipped/);
  });

  it('refuses when HelloFresh does not allow a one-off change', () =>
    expectRefused('hf_set_week_size', args, /does not allow/, {
      routes: [['GET', /delivery_dates\/2026-W49$/, { ...W49, allowedActions: { oneOffChange: false } }]],
    }));

  it('refuses when the week has no meal count', async () => {
    await expectRefused('hf_set_week_size', args, /meal count/, {
      routes: [['GET', /delivery_dates\/2026-W49$/, { ...W49, product: { handle: 'X' } }]],
    });
  });

  it('rejects an unsupported people count before any call', async () => {
    const t = await setup();
    const result = await t.call('hf_set_week_size', { week: '2026-W49', people: 5 });
    expect(result.isError).toBe(true);
    expect(t.sent).toEqual([]);
  });
});

describe('hf_set_week_delivery_day', () => {
  const args = { week: '2026-W49', slot: 'US-2-0800-2000' };
  const moved = {
    ...W49,
    deliveryDate: '2026-12-01T00:00:00-05:00',
    deliveryOption: { handle: 'US-2-0800-2000', deliveryName: 'Tuesday 8AM-8PM', deliveryDay: 'Tuesday' },
  };

  it('phase 1 previews the one-off POST keeping the box size', async () => {
    const t = await setup();
    const preview = parseToolResult<Any>(await t.call('hf_set_week_delivery_day', args));
    expect(t.writes()).toEqual([]);
    expect(preview.preview).toMatchObject({
      method: 'POST',
      path: '/gw/api/subscriptions/90000001/oneoff',
      willSend: { id: '90000001', week: '2026-W49', sku: 'US-CBU-2-6-0', delivery_option: 'US-2-0800-2000', source: 'one-off' },
      from: { deliveryOption: 'US-1-0800-2000', deliveryDate: '2026-11-30' },
      to: { deliveryOption: 'US-2-0800-2000', deliveryDate: '2026-12-01' },
    });
  });

  it('phase 2 sends it and verifies the new slot by re-reading the week', async () => {
    const t = await setup({ after: [['GET', /delivery_dates\/2026-W49$/, moved]] });
    const { out } = await t.twoPhase('hf_set_week_delivery_day', args);
    expect(t.writes()).toHaveLength(1);
    expect(t.writes()[0]!.body).toEqual({ id: '90000001', week: '2026-W49', sku: 'US-CBU-2-6-0', delivery_option: 'US-2-0800-2000', source: 'one-off' });
    expect(out.status).toBe('verified');
    expect(out.after).toMatchObject({ deliveryOption: 'US-2-0800-2000', deliveryDate: '2026-12-01' });
  });

  it('an unchanged slot on re-read reports unverified', async () => {
    const t = await setup();
    expect((await t.twoPhase('hf_set_week_delivery_day', args)).out.status).toBe('unverified');
  });

  it('refuses a slot that is not offered for the week, listing the ones that are', () =>
    expectRefused('hf_set_week_delivery_day', { week: '2026-W49', slot: 'US-5-0800-2000' }, /US-2-0800-2000 \(2026-12-01\)/));

  it('refuses the slot the week already has', () =>
    expectRefused('hf_set_week_delivery_day', { week: '2026-W49', slot: 'US-1-0800-2000' }, /already/));

  it('a week with no alternative days says so', () =>
    expectRefused('hf_set_week_delivery_day', args, /no alternative/, {
      routes: [['GET', /delivery_dates\/2026-W49$/, { ...W49, availableOneOffOptions: [] }]],
    }));

  it('refuses when the week has no box size to keep', () =>
    expectRefused('hf_set_week_delivery_day', args, /box size/, {
      routes: [['GET', /delivery_dates\/2026-W49$/, { ...W49, product: {} }]],
    }));

  it('rejects a malformed slot handle before any call', async () => {
    const t = await setup();
    expect((await t.call('hf_set_week_delivery_day', { week: '2026-W49', slot: 'Tuesday' })).isError).toBe(true);
    expect(t.sent).toEqual([]);
  });
});

describe('hf_skip_week / hf_unskip_week', () => {
  it('skip: previews the PATCH with the week’s dates, then sends it and verifies "skipped"', async () => {
    const t = await setup({ after: [['GET', /delivery_dates\/2026-W49$/, { ...W49, status: 'PAUSED' }]] });
    const { preview, phase1Writes, out } = await t.twoPhase('hf_skip_week', { week: '2026-W49' });
    expect(phase1Writes).toBe(0);
    const body = {
      delivery: {
        id: '2026-W49',
        subscriptionId: '90000001',
        deliveryDate: '2026-11-30T00:00:00-05:00',
        cutoffDate: '2026-11-25T23:59:59-05:00',
        status: 'PAUSED',
      },
    };
    expect(preview.preview).toMatchObject({ method: 'PATCH', path: '/gw/api/subscriptions/90000001/delivery_dates/2026-W49', willSend: body });
    const [patch] = t.writes();
    expect(patch!.method).toBe('PATCH');
    expect(patch!.url.search).toBe('?country=US&locale=en-US');
    expect(patch!.body).toEqual(body);
    expect(out).toMatchObject({ status: 'verified', before: { status: 'running' }, after: { status: 'skipped' } });
  });

  it('unskip: sends RUNNING and verifies "running"', async () => {
    const t = await setup({ after: [['GET', /delivery_dates\/2026-W50$/, { ...W50, status: 'RUNNING' }]] });
    const { out } = await t.twoPhase('hf_unskip_week', { week: '2026-W50' });
    expect((t.writes()[0]!.body as Any).delivery).toMatchObject({ id: '2026-W50', status: 'RUNNING', deliveryDate: W50.deliveryDate });
    expect(out).toMatchObject({ status: 'verified', after: { status: 'running' } });
  });

  it('a status that did not change reports unverified', async () => {
    const t = await setup();
    expect((await t.twoPhase('hf_skip_week', { week: '2026-W49' })).out.status).toBe('unverified');
  });

  it('a dropped connection after the PATCH is an unknown outcome', async () => {
    const t = await setup({ routes: [['PATCH', /delivery_dates\//, () => Promise.reject(new TypeError('fetch failed'))]] });
    const { out } = await t.twoPhase('hf_skip_week', { week: '2026-W49' });
    expect(out.status).toBe('unknown');
  });

  it('refuses to skip a skipped week or unskip a running one', async () => {
    await expectRefused('hf_skip_week', { week: '2026-W50' }, /already skipped/);
    await harness?.close();
    await expectRefused('hf_unskip_week', { week: '2026-W49' }, /not skipped/);
  });

  it('refuses after the cutoff, or when HelloFresh does not allow a pause', async () => {
    await expectRefused('hf_skip_week', { week: '2026-W49' }, /cutoff/i, { now: AFTER_CUTOFF });
    await harness?.close();
    await expectRefused('hf_skip_week', { week: '2026-W49' }, /does not allow/, {
      routes: [['GET', /delivery_dates\/2026-W49$/, { ...W49, allowedActions: { pause: false } }]],
    });
  });

  it('refuses a week without its delivery or cutoff date', () =>
    expectRefused('hf_skip_week', { week: '2026-W49' }, /dates/, {
      routes: [['GET', /delivery_dates\/2026-W49$/, { ...W49, deliveryDate: undefined }]],
    }));
});

describe('hf_change_plan_size', () => {
  const args = { meals: 2, people: 2 };
  const changed = [{ ...PLANS[0], planItems: [{ productHandle: 'US-CBU-2-2-0' }] }];

  it('phase 1 previews the permanent PATCH; phase 2 sends it and verifies via /api/plans', async () => {
    const t = await setup({ after: [['GET', /\/api\/plans$/, changed]] });
    const { preview, phase1Writes, out } = await t.twoPhase('hf_change_plan_size', args);
    expect(phase1Writes).toBe(0);
    expect(preview.preview).toMatchObject({
      method: 'PATCH',
      path: `/gw/api/plans/${PLAN_ID}`,
      willSendQuery: { country: 'US', locale: 'en-US' },
      willSend: { productHandle: 'US-CBU-2-2-0' },
      from: { sku: 'US-CBU-2-6-0' },
      to: { sku: 'US-CBU-2-2-0' },
    });
    expect(preview.preview.note).toMatch(/every future week/);
    const [patch] = t.writes();
    expect(patch!.method).toBe('PATCH');
    expect(patch!.url.pathname).toBe(`/gw/api/plans/${PLAN_ID}`);
    expect(patch!.body).toEqual({ productHandle: 'US-CBU-2-2-0' });
    expect(out).toMatchObject({ status: 'verified', before: { sku: 'US-CBU-2-6-0' }, after: { sku: 'US-CBU-2-2-0' } });
  });

  describe('week-only size overrides (a plan change resets them)', () => {
    const sized = (d: Any, sku: string) => ({ ...d, product: { ...d.product, handle: sku } });
    // W49 carries a one-week 2×2 override on a 2×6 plan; W50 is skipped; W51 is at the plan size;
    // W52 is overridden but past its cutoff (locked: not listed).
    const W51 = { ...W49, id: '2026-W51', cutoffDate: '2026-12-09T23:59:59-05:00' };
    const W52 = { ...sized(W49, 'US-CBU-3-2-0'), id: '2026-W52', cutoffDate: '2026-11-19T23:59:59-05:00' };
    const overridden = { count: 4, items: [sized(W49, 'US-CBU-2-2-0'), W50, W51, W52] };
    const toPlan = { meals: 2, people: 4 };
    const changed4 = [{ ...PLANS[0], planItems: [{ productHandle: 'US-CBU-2-4-0' }] }];

    it('the preview lists each upcoming running week whose size differs from the plan, and warns it will revert', async () => {
      const t = await setup({ routes: [['GET', /\/api\/customers\/me\/deliveries$/, overridden]] });
      const preview = parseToolResult<Any>(await t.call('hf_change_plan_size', toPlan));
      expect(preview.preview.overriddenWeeks).toEqual([{ week: '2026-W49', sku: 'US-CBU-2-2-0', revertsTo: 'US-CBU-2-4-0' }]);
      expect(preview.preview.warning).toMatch(/2026-W49.*revert.*US-CBU-2-4-0.*hf_set_week_size/);
    });

    it('does not list the not-yet-delivered first box as an override (it cannot be resized)', async () => {
      const t = await setup({
        routes: [
          ['GET', /\/api\/customers\/me\/deliveries$/, overridden],
          ['GET', /\/api\/customers\/me\/subscriptions$/, { count: 1, items: [{ ...SUB, firstDeliveryWeek: '2026-W49', firstBoxDelivered: false }] }],
        ],
      });
      const preview = parseToolResult<Any>(await t.call('hf_change_plan_size', toPlan));
      expect(preview.preview.overriddenWeeks).toBeUndefined();
    });

    it('an override already at the new plan size is not said to revert: the preview lists it apart, and why', async () => {
      // Plan 2×6 → 2×2: W49 is already a one-week 2×2 (unchanged by the plan change); W51 is a one-week 2×4 (reverts).
      const mixed = { items: [sized(W49, 'US-CBU-2-2-0'), sized(W51, 'US-CBU-2-4-0')] };
      const t = await setup({
        routes: [['GET', /\/api\/customers\/me\/deliveries$/, mixed]],
        after: [
          ['GET', /\/api\/plans$/, [{ ...PLANS[0], planItems: [{ productHandle: 'US-CBU-2-2-0' }] }]],
          ['GET', /\/api\/customers\/me\/deliveries$/, { items: [sized(W49, 'US-CBU-2-2-0'), sized(W51, 'US-CBU-2-2-0')] }],
        ],
      });
      const { preview, out } = await t.twoPhase('hf_change_plan_size', { meals: 2, people: 2 });
      expect(preview.preview.overriddenWeeks).toEqual([{ week: '2026-W51', sku: 'US-CBU-2-4-0', revertsTo: 'US-CBU-2-2-0' }]);
      expect(preview.preview.warning).not.toMatch(/2026-W49/);
      expect(preview.preview.alreadyAtNewSize).toEqual([{ week: '2026-W49', sku: 'US-CBU-2-2-0' }]);
      expect(preview.preview.alreadyAtNewSizeNote).toMatch(/2026-W49.*already.*US-CBU-2-2-0.*unchanged/);
      expect(out.overridesReverted).toEqual([{ week: '2026-W51', from: 'US-CBU-2-4-0', to: 'US-CBU-2-2-0' }]);
      expect(out.overridesNote).not.toMatch(/2026-W49/);
    });

    it('when every override is already at the new plan size, nothing is said to revert and nothing is re-read', async () => {
      const t = await setup({
        routes: [['GET', /\/api\/customers\/me\/deliveries$/, { items: [sized(W49, 'US-CBU-2-2-0')] }]],
        after: [['GET', /\/api\/plans$/, [{ ...PLANS[0], planItems: [{ productHandle: 'US-CBU-2-2-0' }] }]]],
      });
      const { preview, out } = await t.twoPhase('hf_change_plan_size', { meals: 2, people: 2 });
      expect(preview.preview.overriddenWeeks).toBeUndefined();
      expect(preview.preview.warning).toBeUndefined();
      expect(preview.preview.alreadyAtNewSize).toEqual([{ week: '2026-W49', sku: 'US-CBU-2-2-0' }]);
      expect(out.status).toBe('verified');
      expect(out).not.toHaveProperty('overridesNote');
    });

    it('after execute, reports which overridden weeks reverted (and which kept their size)', async () => {
      const t = await setup({
        routes: [['GET', /\/api\/customers\/me\/deliveries$/, overridden]],
        after: [
          ['GET', /\/api\/plans$/, changed4],
          ['GET', /\/api\/customers\/me\/deliveries$/, { items: [sized(W49, 'US-CBU-2-4-0'), W50, sized(W51, 'US-CBU-2-4-0')] }],
        ],
      });
      const { out } = await t.twoPhase('hf_change_plan_size', toPlan);
      expect(out.status).toBe('verified');
      expect(out.overridesReverted).toEqual([{ week: '2026-W49', from: 'US-CBU-2-2-0', to: 'US-CBU-2-4-0' }]);
      expect(out.overridesKept).toBeUndefined();
      expect(out.overridesNote).toMatch(/hf_set_week_size/);
    });

    it('an override that survived the change is reported as kept', async () => {
      const t = await setup({
        routes: [['GET', /\/api\/customers\/me\/deliveries$/, overridden]],
        after: [['GET', /\/api\/plans$/, changed4]],
      });
      const { out } = await t.twoPhase('hf_change_plan_size', toPlan);
      expect(out.overridesReverted).toBeUndefined();
      expect(out.overridesKept).toEqual([{ week: '2026-W49', sku: 'US-CBU-2-2-0' }]);
    });

    it('a week missing from the re-read is reported unread; a failed re-read is noted, not fatal', async () => {
      const t = await setup({
        routes: [['GET', /\/api\/customers\/me\/deliveries$/, overridden]],
        after: [
          ['GET', /\/api\/plans$/, changed4],
          ['GET', /\/api\/customers\/me\/deliveries$/, {}],
        ],
      });
      const { out } = await t.twoPhase('hf_change_plan_size', toPlan);
      expect(out.overridesUnread).toEqual(['2026-W49']);
      await harness?.close();
      const t2 = await setup({
        routes: [['GET', /\/api\/customers\/me\/deliveries$/, overridden]],
        after: [
          ['GET', /\/api\/plans$/, changed4],
          ['GET', /\/api\/customers\/me\/deliveries$/, () => json({ e: 1 }, 400)],
        ],
      });
      const { out: out2 } = await t2.twoPhase('hf_change_plan_size', toPlan);
      expect(out2.status).toBe('verified');
      expect(out2.overridesError).toMatch(/400/);
    });

    it('a deliveries list with no items, or a week without an id or size, lists no override', async () => {
      const t = await setup({ routes: [['GET', /\/api\/customers\/me\/deliveries$/, { items: [{ ...W49, id: undefined, product: { handle: 'US-CBU-2-2-0' } }, { ...W49, product: undefined }] }]] });
      const preview = parseToolResult<Any>(await t.call('hf_change_plan_size', toPlan));
      expect(preview.preview.overriddenWeeks).toBeUndefined();
      await harness?.close();
      const t2 = await setup({ routes: [['GET', /\/api\/customers\/me\/deliveries$/, {}]] });
      expect(parseToolResult<Any>(await t2.call('hf_change_plan_size', toPlan)).preview.overriddenWeeks).toBeUndefined();
    });

    it('no overrides: nothing listed, no deliveries re-read', async () => {
      const t = await setup({ after: [['GET', /\/api\/plans$/, changed4]] });
      const { preview, out } = await t.twoPhase('hf_change_plan_size', toPlan);
      expect(preview.preview.overriddenWeeks).toBeUndefined();
      expect(preview.preview.warning).toBeUndefined();
      expect(out).not.toHaveProperty('overridesReverted');
      expect(out).not.toHaveProperty('overridesNote');
    });

    it('an unreadable deliveries list before the change is a preview caveat, not a refusal', async () => {
      const t = await setup({ routes: [['GET', /\/api\/customers\/me\/deliveries$/, () => json({ e: 1 }, 400)]] });
      const preview = parseToolResult<Any>(await t.call('hf_change_plan_size', toPlan));
      expect(preview.preview.overridesUnknown).toMatch(/400/);
    });
  });

  it('a plan that still shows the old size reports unverified', async () => {
    const t = await setup();
    expect((await t.twoPhase('hf_change_plan_size', args)).out.status).toBe('unverified');
  });

  it('a plan missing from the re-read reports unverified', async () => {
    const t = await setup({ after: [['GET', /\/api\/plans$/, []]] });
    expect((await t.twoPhase('hf_change_plan_size', args)).out.status).toBe('unverified');
  });

  it('falls back to the subscription’s SKU when the plan lists no item', async () => {
    const t = await setup({ routes: [['GET', /\/api\/plans$/, [{ id: PLAN_ID }]]] });
    const preview = parseToolResult<Any>(await t.call('hf_change_plan_size', args));
    expect(preview.preview.from).toEqual({ sku: 'US-CBU-2-6-0', meals: 2, people: 6 });
  });

  it('with no current size anywhere, the preview says so', async () => {
    const t = await setup({
      routes: [
        ['GET', /\/api\/plans$/, [{ id: PLAN_ID }]],
        ['GET', /subscriptions$/, { items: [{ ...SUB, product: undefined }] }],
      ],
    });
    const preview = parseToolResult<Any>(await t.call('hf_change_plan_size', args));
    expect(preview.preview.from).toEqual({});
  });

  it('refuses the current size and a size not offered', async () => {
    await expectRefused('hf_change_plan_size', { meals: 2, people: 6 }, /already/);
    await harness?.close();
    await expectRefused('hf_change_plan_size', { meals: 4, people: 2 }, /cannot switch to US-CBU-4-2-0/);
  });
});

describe('hf_change_delivery_schedule', () => {
  it('fills the unchanged field from the subscription, sends both and verifies via the subscription', async () => {
    const after = { ...SUB, deliveryInterval: 2 };
    const t = await setup({ after: [['GET', /\/api\/subscriptions\/90000001$/, after]] });
    const { preview, phase1Writes, out } = await t.twoPhase('hf_change_delivery_schedule', { interval_weeks: 2 });
    expect(phase1Writes).toBe(0);
    expect(preview.preview).toMatchObject({
      method: 'POST',
      path: `/gw/api/plans/${PLAN_ID}/changePlanDeliveryDetails`,
      willSendQuery: { country: 'US' },
      willSend: { deliveryOption: 'US-1-0800-2000', deliveryInterval: 2 },
      from: { deliveryOption: 'US-1-0800-2000', deliveryInterval: 1 },
      to: { deliveryOption: 'US-1-0800-2000', deliveryInterval: 2 },
    });
    const [post] = t.writes();
    expect(post!.url.search).toBe('?country=US');
    expect(post!.body).toEqual({ deliveryOption: 'US-1-0800-2000', deliveryInterval: 2 });
    expect(out).toMatchObject({ status: 'verified', after: { deliveryOption: 'US-1-0800-2000', deliveryInterval: 2 } });
  });

  it('a new slot keeps the frequency; a slot seen on a delivery carries no caveat', async () => {
    const after = { ...SUB, deliveryOption: { handle: 'US-2-0800-2000' } };
    const t = await setup({ after: [['GET', /\/api\/subscriptions\/90000001$/, after]] });
    const { preview, out } = await t.twoPhase('hf_change_delivery_schedule', { delivery_option: 'US-2-0800-2000' });
    expect(preview.preview.willSend).toEqual({ deliveryOption: 'US-2-0800-2000', deliveryInterval: 1 });
    expect(preview.preview.caveat).toBeUndefined();
    expect(out.status).toBe('verified');
  });

  it('a slot never seen on this account gets a caveat in the preview', async () => {
    const t = await setup();
    const preview = parseToolResult<Any>(await t.call('hf_change_delivery_schedule', { delivery_option: 'US-4-1200-2000' }));
    expect(preview.preview.caveat).toMatch(/not one this account/);
  });

  it('an empty deliveries list gives the caveat too', async () => {
    const t = await setup({ routes: [['GET', /\/api\/customers\/me\/deliveries$/, {}]] });
    const preview = parseToolResult<Any>(await t.call('hf_change_delivery_schedule', { delivery_option: 'US-2-0800-2000' }));
    expect(preview.preview.caveat).toMatch(/not one this account/);
  });

  it('verifies from deliveryTime when the re-read subscription has no deliveryOption', async () => {
    const after = { ...SUB, deliveryOption: undefined, deliveryInterval: 2 };
    const t = await setup({ after: [['GET', /\/api\/subscriptions\/90000001$/, after]] });
    const { out } = await t.twoPhase('hf_change_delivery_schedule', { interval_weeks: 2 });
    expect(out).toMatchObject({ status: 'verified', after: { deliveryOption: 'US-1-0800-2000', deliveryInterval: 2 } });
  });

  it('reads the current slot from deliveryTime when deliveryOption is missing', async () => {
    const t = await setup({ routes: [['GET', /subscriptions$/, { items: [{ ...SUB, deliveryOption: undefined }] }]] });
    const preview = parseToolResult<Any>(await t.call('hf_change_delivery_schedule', { interval_weeks: 3 }));
    expect(preview.preview.willSend).toEqual({ deliveryOption: 'US-1-0800-2000', deliveryInterval: 3 });
  });

  it('an unchanged subscription on re-read reports unverified', async () => {
    const t = await setup();
    expect((await t.twoPhase('hf_change_delivery_schedule', { interval_weeks: 2 })).out.status).toBe('unverified');
  });

  it('refuses no change, and nothing to change', async () => {
    await expectRefused('hf_change_delivery_schedule', { interval_weeks: 1, delivery_option: 'US-1-0800-2000' }, /already/);
    await harness?.close();
    await expectRefused('hf_change_delivery_schedule', {}, /delivery_option or interval_weeks/);
  });

  it('refuses when the current value it must resend is unknown', async () => {
    await expectRefused('hf_change_delivery_schedule', { interval_weeks: 2 }, /current delivery slot/, {
      routes: [['GET', /subscriptions$/, { items: [{ ...SUB, deliveryOption: undefined, deliveryTime: undefined }] }]],
    });
    await harness?.close();
    await expectRefused('hf_change_delivery_schedule', { delivery_option: 'US-2-0800-2000' }, /current delivery frequency/, {
      routes: [['GET', /subscriptions$/, { items: [{ ...SUB, deliveryInterval: undefined }] }]],
    });
  });

  it('rejects interval 0 (on demand) and a malformed slot before any call', async () => {
    const t = await setup();
    expect((await t.call('hf_change_delivery_schedule', { interval_weeks: 0 })).isError).toBe(true);
    expect((await t.call('hf_change_delivery_schedule', { delivery_option: 'monday' })).isError).toBe(true);
    expect(t.sent).toEqual([]);
  });
});
