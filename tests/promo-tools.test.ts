import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createTestHarness, parseToolResult, type TestHarness } from '@chrischall/mcp-utils/test';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { HelloFreshClient, type ClientSession } from '../src/client.js';
import { registerPromoTools } from '../src/tools/promo.js';
import { PRICE_CONCURRENCY } from '../src/tools/shared.js';
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

/** A running week like W49, `n` weeks on. */
const running = (week: string, date: string) => ({ ...W49, id: week, deliveryDate: `${date}T00:00:00-05:00` });
const skipped = (week: string, date: string) => ({ ...running(week, date), status: 'PAUSED' });

/** W49, W51, W52 running; W50 skipped; a delivered W46 (listed, never priced). */
const UPCOMING = {
  items: [
    running('2026-W52', '2026-12-21'),
    running('2026-W49', '2026-11-30'),
    skipped('2026-W50', '2026-12-07'),
    running('2026-W51', '2026-12-14'),
    DELIVERIES.items[2],
  ],
};

/** A synthetic calculator answer (ids and the address included, as the real one — they must never pass). */
const calc = (couponPercent: number | undefined, discountAmount: number | undefined, grandTotal = 52.65) => ({
  grandTotal,
  subTotal: 147.48,
  taxAmount: 1.03,
  shippingAmount: 12.99,
  shippingDiscountAmount: 12.99,
  ...(discountAmount !== undefined ? { discountAmount } : {}),
  couponCode: 'EXAMPLE65',
  currency: 'USD',
  customerID: 12345678,
  subscriptionID: 90000001,
  shippingAddress: { postcode: '00000', address1: '123 Example St' },
  products: [{ handle: 'US-CBU-2-6-0', ...(couponPercent !== undefined ? { couponPercent } : {}), charges: null }],
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Route = [RegExp, unknown];
/** A route body that answers 404. */
const NOT_FOUND = Symbol('404');
/** Calculator answers by week; a missing week answers 404. */
type Calcs = Record<string, unknown>;

const DEFAULT_CALCS: Calcs = {
  '2026-W49': calc(65, 108.85),
  '2026-W51': calc(65, 108.85),
  '2026-W52': calc(65, 108.85),
};

let harness: TestHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const NOW = Date.parse('2026-11-26T17:00:00Z');

interface CallOpts {
  routes?: Route[];
  calcs?: Calcs;
  /** Hold every calculator call until this resolves (to observe concurrency). */
  gate?: Promise<void>;
}

async function call(args: Record<string, unknown> = {}, opts: CallOpts = {}) {
  const urls: URL[] = [];
  const tabBodies: Any[] = [];
  const calcs = opts.calcs ?? DEFAULT_CALCS;
  const routes: Route[] = [
    ...(opts.routes ?? []),
    [/\/api\/customers\/me\/subscriptions$/, { count: 1, items: [SUB] }],
    [/\/api\/customers\/me\/deliveries$/, UPCOMING],
    [/\/my-deliveries\/menu$/, MENU],
  ];
  const fetchImpl = (async (input: string) => {
    const url = new URL(input);
    urls.push(url);
    const hit = routes.find(([re]) => re.test(url.pathname));
    return hit && hit[1] !== NOT_FOUND ? json(hit[1]) : json({ error: 'not found' }, 404);
  }) as unknown as typeof fetch;
  let inFlight = 0;
  let maxInFlight = 0;
  const tabFetch = async (req: { url: string; body?: string }) => {
    const body = JSON.parse(req.body!);
    tabBodies.push(body);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (opts.gate) await opts.gate;
      const answer = calcs[body.weekId];
      return answer ? { status: 200, body: JSON.stringify(answer) } : { status: 404, body: '{"error":"nope"}' };
    } finally {
      inFlight -= 1;
    }
  };
  const session: ClientSession = { withAuth: (c) => c('tok'), redact: (t) => t };
  const deps: ToolDeps = { ...offlineDeps(), client: new HelloFreshClient({ session, fetchImpl, tabFetch }), now: () => NOW };
  await harness?.close();
  harness = await createTestHarness((server) => registerPromoTools(server, deps));
  const result = await harness.callTool('hf_promo_status', args);
  return { result, urls, tabBodies, text: textOf(result), maxInFlight: () => maxInFlight };
}

const textOf = (r: CallToolResult) => (r.content as { text: string }[])[0]!.text;

const withVoucher = (voucherInfo: unknown, extra: Record<string, unknown> = {}): Route => [
  /\/api\/customers\/me\/subscriptions$/,
  { items: [{ ...SUB, voucherInfo, ...extra }] },
];

describe('hf_promo_status: registration', () => {
  it('registers one read-only, open-world lookup in the food domain', async () => {
    harness = await createTestHarness((server) => registerPromoTools(server, offlineDeps()));
    const tools = (await harness.client.listTools()).tools;
    expect(tools.map((t) => t.name)).toEqual(['hf_promo_status']);
    const t = tools[0]!;
    expect(t.annotations?.readOnlyHint).toBe(true);
    expect(t.annotations?.openWorldHint).toBe(true);
    expect((t._meta as Any).mint).toMatchObject({ domain: 'food', intent: 'lookup' });
    expect((t._meta as Any).mint.canonical).toBeUndefined();
  });
});

describe('hf_promo_status', () => {
  it('reports the voucher, the boxes used/left and each running week’s real discount', async () => {
    const { result, text, tabBodies } = await call();
    const out = parseToolResult<Any>(result);
    expect(out).toMatchObject({
      couponCode: 'EXAMPLE65',
      active: true,
      boxLimit: 52,
      boxesUsed: 1,
      boxesUsedBasis: 'assumed',
      boxesRemaining: 51,
    });
    expect(out.boxesUsedNote).toMatch(/ASSUMES/);
    expect(out.perWeek).toEqual([
      { week: '2026-W49', deliveryDate: '2026-11-30', boxNumber: 2, price: { couponPercent: 65, discount: 108.85, grandTotal: 52.65 } },
      { week: '2026-W51', deliveryDate: '2026-12-14', boxNumber: 3, price: { couponPercent: 65, discount: 108.85, grandTotal: 52.65 } },
      { week: '2026-W52', deliveryDate: '2026-12-21', boxNumber: 4, price: { couponPercent: 65, discount: 108.85, grandTotal: 52.65 } },
    ]);
    expect(out.warnings).toEqual([]);
    expect(out.priceNote).toMatch(/calculator/);
    // Skipped and delivered weeks are never priced; the picks are sent.
    expect(tabBodies.map((b) => b.weekId).sort()).toEqual(['2026-W49', '2026-W51', '2026-W52']);
    expect(tabBodies[0].products[0].recipeIndexes).toEqual(['67', '71']);
    expect(text).not.toMatch(/Pat|Example St|pat@example|tok_synthetic|12345678|00000000-0000/);
  });

  it('a first box not yet delivered: boxesUsed is exactly 0', async () => {
    const { result } = await call({}, { routes: [withVoucher(SUB.voucherInfo, { firstBoxDelivered: false, firstDeliveryWeek: '2026-W49' })] });
    const out = parseToolResult<Any>(result);
    expect(out).toMatchObject({ boxesUsed: 0, boxesUsedBasis: 'exact', boxesRemaining: 52 });
    expect(out.perWeek.map((w: Any) => w.boxNumber)).toEqual([1, 2, 3]);
    expect(out.boxesUsedNote).toMatch(/not delivered yet/);
  });

  it('next_box_number sets the numbering (basis "given")', async () => {
    const { result } = await call({ next_box_number: 50 });
    const out = parseToolResult<Any>(result);
    expect(out).toMatchObject({ boxesUsed: 49, boxesUsedBasis: 'given', boxesRemaining: 3 });
    expect(out.perWeek.map((w: Any) => w.boxNumber)).toEqual([50, 51, 52]);
    expect(out.warnings).toEqual([expect.stringMatching(/Only 3 discounted boxes left/)]);
  });

  it('few boxes left on an assumed count says the count is assumed', async () => {
    const { result } = await call({}, { routes: [withVoucher({ ...SUB.voucherInfo, discount_settings: { box_count: 3 } })] });
    expect(parseToolResult<Any>(result).warnings).toContain(
      'Only 2 discounted boxes left on the voucher, of 3 (boxes used is an assumption — see boxesUsedNote).',
    );
  });

  it('boxesRemaining never goes below zero; weeks past the limit are flagged', async () => {
    const calcs = { '2026-W49': calc(0, 0, 160.47), '2026-W51': calc(0, 0, 160.47), '2026-W52': calc(0, 0, 160.47) };
    const { result } = await call({ next_box_number: 60 }, { calcs });
    const out = parseToolResult<Any>(result);
    expect(out.boxesRemaining).toBe(0);
    expect(out.perWeek[0].pastVoucherLimit).toBe(true);
    expect(out.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/2026-W49 \(box 60\).*no discount.*past the voucher’s 52-box limit/),
        expect.stringMatching(/Only 0 discounted boxes left/),
      ]),
    );
  });

  it('warns on a running week with a missing or zero discount', async () => {
    const calcs = { '2026-W49': calc(65, 108.85), '2026-W51': calc(undefined, undefined, 160.47), '2026-W52': calc(65, 0) };
    const { result } = await call({}, { calcs });
    const out = parseToolResult<Any>(result);
    expect(out.perWeek[1].price).toEqual({ grandTotal: 160.47 });
    expect(out.warnings).toEqual([
      expect.stringMatching(/2026-W51 \(box 3\): HelloFresh’s calculator applies no discount/),
      expect.stringMatching(/2026-W52 \(box 4\): HelloFresh’s calculator applies no discount/),
    ]);
    expect(out.warnings[0]).not.toMatch(/past the voucher/);
  });

  it('warns when the coupon percent changes from the previous priced week', async () => {
    const calcs = { '2026-W49': calc(65, 108.85), '2026-W51': calc(15, 22.12), '2026-W52': calc(15, 22.12) };
    const { result } = await call({}, { calcs });
    expect(parseToolResult<Any>(result).warnings).toEqual([expect.stringMatching(/2026-W51: the coupon percent changes from 65% \(2026-W49\) to 15%/)]);
  });

  it('a week the calculator cannot price is "unavailable" with the reason, and the percent comparison skips it', async () => {
    const calcs = { '2026-W49': calc(65, 108.85), '2026-W52': calc(65, 108.85) };
    const { result } = await call({}, { calcs });
    const out = parseToolResult<Any>(result);
    expect(out.perWeek[1]).toMatchObject({ week: '2026-W51', boxNumber: 3, price: 'unavailable' });
    expect(out.perWeek[1].reason).toMatch(/404/);
    expect(out.warnings).toEqual([]);
  });

  it('an unreadable menu still prices the week (no picks sent)', async () => {
    const { result, tabBodies } = await call({}, { routes: [[/\/my-deliveries\/menu$/, NOT_FOUND]] });
    expect(parseToolResult<Any>(result).perWeek).toHaveLength(3);
    expect(tabBodies.map((b) => b.products[0].recipeIndexes)).toEqual([[], [], []]);
  });

  it('an inactive voucher is flagged', async () => {
    const { result } = await call({}, { routes: [withVoucher({ ...SUB.voucherInfo, is_active: false })] });
    const out = parseToolResult<Any>(result);
    expect(out.active).toBe(false);
    expect(out.warnings).toContain('The voucher is not active, so no discount should be expected.');
  });

  it('no voucher at all: inactive, no limit, the coupon code from the subscription, flagged', async () => {
    const { result } = await call({}, { routes: [withVoucher(null, { couponCode: null })] });
    const out = parseToolResult<Any>(result);
    expect(out.couponCode).toBeUndefined();
    expect(out.active).toBe(false);
    expect(out.boxLimit).toBeUndefined();
    expect(out.boxesRemaining).toBeUndefined();
    expect(out.warnings).toContain('This subscription has no voucher, so no discount should be expected.');
    expect(out.warnings.some((w: string) => /discounted boxes left/.test(w))).toBe(false);
  });

  it('the coupon code falls back to the voucher’s code', async () => {
    const { result } = await call({}, { routes: [withVoucher({ ...SUB.voucherInfo, code: 'EXAMPLEV' }, { couponCode: '' })] });
    expect(parseToolResult<Any>(result).couponCode).toBe('EXAMPLEV');
  });

  it('a voucher without a box limit leaves the remaining count out', async () => {
    const { result } = await call({}, { routes: [withVoucher({ code: 'EXAMPLE65', is_active: true })] });
    const out = parseToolResult<Any>(result);
    expect(out.boxLimit).toBeUndefined();
    expect(out.boxesRemaining).toBeUndefined();
    expect(out.perWeek[0].pastVoucherLimit).toBeUndefined();
  });

  it('no running weeks: an empty perWeek, nothing priced', async () => {
    const { result, tabBodies } = await call({}, { routes: [[/\/api\/customers\/me\/deliveries$/, { items: [skipped('2026-W50', '2026-12-07')] }]] });
    expect(parseToolResult<Any>(result).perWeek).toEqual([]);
    expect(tabBodies).toEqual([]);
  });

  it('a delivery list with no items prices nothing', async () => {
    const { result } = await call({}, { routes: [[/\/api\/customers\/me\/deliveries$/, {}]] });
    expect(parseToolResult<Any>(result).perWeek).toEqual([]);
  });

  it('prices with bounded concurrency', async () => {
    const many = {
      items: Array.from({ length: 7 }, (_, i) => running(`2027-W0${i + 1}`, `2027-01-0${i + 1}`)),
    };
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    setTimeout(() => release(), 20);
    const { result, maxInFlight } = await call({}, { routes: [[/\/api\/customers\/me\/deliveries$/, many]], gate, calcs: {} });
    expect(parseToolResult<Any>(result).perWeek).toHaveLength(7);
    expect(maxInFlight()).toBeLessThanOrEqual(PRICE_CONCURRENCY);
    expect(maxInFlight()).toBeGreaterThan(1);
  });

  it('assumes 2 when HelloFresh does not say whether the first box was delivered', async () => {
    const { result } = await call({}, { routes: [withVoucher(SUB.voucherInfo, { firstBoxDelivered: true, firstDeliveryWeek: '2026-W40' })] });
    const out = parseToolResult<Any>(result);
    expect(out).toMatchObject({ boxesUsed: 1, boxesUsedBasis: 'assumed' });
    expect(out.boxesUsedNote).toMatch(/first box was delivered in 2026-W40/);
  });
});
