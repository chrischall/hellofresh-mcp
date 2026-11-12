import { describe, expect, it, vi } from 'vitest';
import {
  EdgeBlockedError,
  McpToolError,
  UpstreamFormatError,
  WriteOutcomeUnknownError,
  withCallSignal,
  writeOutcomeStatus,
} from '@chrischall/mcp-utils';
import { API_BASE, HelloFreshClient, type ClientSession } from '../src/client.js';
import { HelloFreshSession, encodeAuthCookie, type SessionBridge } from '../src/session.js';

// Synthetic ids only.
const SUB = '90000001';
const PLAN = '11111111-2222-4333-8444-555555555555';
const WEEK = '2026-W49';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal | undefined;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function setup(responses: Array<Response | Error | ((init: RequestInit) => Promise<Response>)>, opts: { timeoutMs?: number } = {}) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      signal: init.signal ?? undefined,
    });
    const next = responses.shift();
    if (next === undefined) throw new Error('unexpected request');
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next(init);
    return next;
  });
  // Stub session: one token, replays once on a 401 like the real one.
  const session: ClientSession = {
    async withAuth(call) {
      const res = await call('tok-1');
      return res.status === 401 ? call('tok-2') : res;
    },
    redact: (text) => text.replaceAll('tok-1', '[redacted]'),
  };
  const client = new HelloFreshClient({ session, fetchImpl: fetchImpl as unknown as typeof fetch, ...opts });
  return { client, calls, fetchImpl };
}

describe('HelloFreshClient reads', () => {
  it('lists subscriptions with bearer + country/locale', async () => {
    const { client, calls } = setup([json({ count: 1, items: [{ id: SUB }] })]);
    await expect(client.listSubscriptions()).resolves.toEqual({ count: 1, items: [{ id: SUB }] });
    expect(calls[0]!.url).toBe(`${API_BASE}/api/customers/me/subscriptions?country=US&locale=en-US`);
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.headers['authorization']).toBe('Bearer tok-1');
    expect(calls[0]!.headers['accept']).toBe('application/json');
    expect(calls[0]!.headers['content-type']).toBeUndefined();
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  it('reads one subscription, deliveries, one delivery, product options, plans and menu weeks', async () => {
    const { client, calls } = setup([
      json({ id: SUB }),
      json({ count: 0, items: [] }),
      json({ id: WEEK }),
      json({ items: [] }),
      json([{ id: PLAN }]),
      json({ weeks: [WEEK] }),
    ]);
    await client.getSubscription(SUB);
    await client.listDeliveries();
    await client.getDelivery(SUB, WEEK);
    await client.getProductOptions(SUB);
    await expect(client.listPlans()).resolves.toEqual([{ id: PLAN }]);
    await expect(client.listMenuWeeks()).resolves.toEqual({ weeks: [WEEK] });
    const q = '?country=US&locale=en-US';
    expect(calls.map((c) => c.url)).toEqual([
      `${API_BASE}/api/subscriptions/${SUB}${q}`,
      `${API_BASE}/api/customers/me/deliveries${q}`,
      `${API_BASE}/api/subscriptions/${SUB}/delivery_dates/${WEEK}${q}`,
      `${API_BASE}/api/subscriptions/${SUB}/product_options${q}`,
      `${API_BASE}/api/plans${q}`,
      `${API_BASE}/menus-service/weeks${q}`,
    ]);
  });

  it('reads the delivery menu with exactly the documented query', async () => {
    const { client, calls } = setup([json({ week: WEEK, meals: [] })]);
    await client.getDeliveryMenu({ subscriptionId: SUB, week: WEEK, servings: 6, sku: 'US-CBU-2-6-0', customerPlanId: PLAN });
    expect(calls[0]!.url).toBe(
      `${API_BASE}/my-deliveries/menu?subscription=${SUB}&week=${WEEK}&locale=en-US&servings=6&product-sku=US-CBU-2-6-0&customerPlanId=${PLAN}&exclude-feedback=true`,
    );
  });

  it('encodes path values as one segment', async () => {
    const { client, calls } = setup([json({})]);
    await client.getSubscription('a/b?c');
    expect(calls[0]!.url).toBe(`${API_BASE}/api/subscriptions/a%2Fb%3Fc?country=US&locale=en-US`);
  });
});

describe('HelloFreshClient writes', () => {
  it('select meals: PUT the cart with the complete selection', async () => {
    const { client, calls } = setup([json({ hasSeamlessDowngraded: false })]);
    await expect(
      client.selectMeals({
        week: WEEK,
        subscriptionId: SUB,
        customerId: 12345678,
        sku: 'US-CBU-2-6-0',
        preference: 'pescatarian',
        meals: [
          { index: 67, quantity: 1 },
          { index: 71, quantity: 1 },
        ],
      }),
    ).resolves.toEqual({ hasSeamlessDowngraded: false });
    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.url).toBe(
      `${API_BASE}/v1/carts/${WEEK}?subscription=${SUB}&customer=12345678&week=${WEEK}&product-sku=US-CBU-2-6-0&preference=pescatarian&update_quantity=false&ignore_addons=false`,
    );
    expect(calls[0]!.headers['content-type']).toBe('application/json');
    expect(calls[0]!.body).toEqual({ extras: [], meals: [{ index: 67, quantity: 1 }, { index: 71, quantity: 1 }] });
  });

  it('skip / unskip: PATCH the delivery status', async () => {
    const { client, calls } = setup([json({ count: 1, items: [] }, 201), json({ count: 1, items: [] }, 201)]);
    const base = { subscriptionId: SUB, week: WEEK, deliveryDate: '2026-11-30T00:00:00-05:00', cutoffDate: '2026-11-25T23:59:59-05:00' };
    await client.setDeliveryStatus({ ...base, status: 'PAUSED' });
    await client.setDeliveryStatus({ ...base, status: 'RUNNING' });
    expect(calls[0]!.method).toBe('PATCH');
    expect(calls[0]!.url).toBe(`${API_BASE}/api/subscriptions/${SUB}/delivery_dates/${WEEK}?country=US&locale=en-US`);
    expect(calls[0]!.body).toEqual({
      delivery: { id: WEEK, subscriptionId: SUB, deliveryDate: base.deliveryDate, cutoffDate: base.cutoffDate, status: 'PAUSED' },
    });
    expect((calls[1]!.body as { delivery: { status: string } }).delivery.status).toBe('RUNNING');
  });

  it('one-off change: POST sku + delivery_option for one week', async () => {
    const { client, calls } = setup([json({ count: 1, items: [] }, 201)]);
    await client.changeOneOff({ subscriptionId: SUB, week: WEEK, sku: 'US-CBU-2-2-0', deliveryOption: 'US-1-0800-2000' });
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe(`${API_BASE}/api/subscriptions/${SUB}/oneoff?country=US&locale=en-US`);
    expect(calls[0]!.body).toEqual({ id: SUB, week: WEEK, sku: 'US-CBU-2-2-0', delivery_option: 'US-1-0800-2000', source: 'one-off' });
  });

  it('one-week box size: PUT carts/{week}/size with the subscription in the query, no "source"', async () => {
    const { client, calls } = setup([new Response(null, { status: 204 })]);
    await expect(client.setWeekSize({ subscriptionId: SUB, week: WEEK, sku: 'US-CBU-2-2-0' })).resolves.toBeUndefined();
    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.url).toBe(`${API_BASE}/carts/${WEEK}/size?country=US&locale=en-US&subscription=${SUB}`);
    expect(calls[0]!.headers['content-type']).toBe('application/json');
    expect(calls[0]!.headers.authorization).toBe('Bearer tok-1');
    expect(calls[0]!.body).toEqual({ productHandle: 'US-CBU-2-2-0', hfMarketCode: 'US' });
  });

  it('one-week box size: any 2xx body (JSON, text or empty) is success', async () => {
    const { client } = setup([json({ ok: true }), new Response('OK', { status: 200 }), new Response('', { status: 201 })]);
    for (let i = 0; i < 3; i++) {
      await expect(client.setWeekSize({ subscriptionId: SUB, week: WEEK, sku: 'US-CBU-2-2-0' })).resolves.toBeUndefined();
    }
  });

  it('one-week box size: a Cloudflare page answered 200 is still EdgeBlockedError', async () => {
    const page = '<html><title>Just a moment...</title><script>window._cf_chl_opt={}</script></html>';
    const { client } = setup([new Response(page, { status: 200, headers: { 'content-type': 'text/html', 'cf-mitigated': 'challenge' } })]);
    const err = await client.setWeekSize({ subscriptionId: SUB, week: WEEK, sku: 'US-CBU-2-2-0' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EdgeBlockedError);
  });

  it('permanent box size: PATCH the plan (204, no body)', async () => {
    const { client, calls } = setup([new Response(null, { status: 204 })]);
    await expect(client.setPlanProduct(PLAN, 'US-CBU-2-6-0')).resolves.toBeUndefined();
    expect(calls[0]!.method).toBe('PATCH');
    expect(calls[0]!.url).toBe(`${API_BASE}/api/plans/${PLAN}?country=US&locale=en-US`);
    expect(calls[0]!.body).toEqual({ productHandle: 'US-CBU-2-6-0' });
  });

  it('permanent delivery details: POST both fields with country only', async () => {
    const { client, calls } = setup([new Response('', { status: 200 })]);
    await expect(
      client.changePlanDeliveryDetails(PLAN, { deliveryOption: 'US-1-0800-2000', deliveryInterval: 2 }),
    ).resolves.toBeUndefined();
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe(`${API_BASE}/api/plans/${PLAN}/changePlanDeliveryDetails?country=US`);
    expect(calls[0]!.body).toEqual({ deliveryOption: 'US-1-0800-2000', deliveryInterval: 2 });
  });
});

describe('HelloFreshClient errors', () => {
  it('a 4xx is an McpToolError with the status and a redacted body', async () => {
    const { client } = setup([json({ errorMessage: 'bad week tok-1' }, 400)]);
    const err = await client.getDelivery(SUB, WEEK).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpToolError);
    expect(err).not.toBeInstanceOf(WriteOutcomeUnknownError);
    expect((err as McpToolError).status).toBe(400);
    expect((err as McpToolError).kind).toBe('http');
    expect((err as Error).message).toContain('400');
    expect((err as Error).message).toContain('bad week');
    expect((err as Error).message).not.toContain('tok-1');
    expect((err as Error).message).not.toContain(SUB);
  });

  it('a 401 after the replay is credential_rejected with a sign-in hint', async () => {
    const { client, fetchImpl } = setup([json({ errorMessage: 'no Bearer token' }, 401), json({ errorMessage: 'no Bearer token' }, 401)]);
    const err = (await client.listSubscriptions().catch((e: unknown) => e)) as McpToolError;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(err.status).toBe(401);
    expect(err.kind).toBe('credential_rejected');
    expect(err.hint).toMatch(/sign in/i);
  });

  it('a 403 is credential_rejected', async () => {
    const { client } = setup([json({}, 403)]);
    const err = (await client.listSubscriptions().catch((e: unknown) => e)) as McpToolError;
    expect(err.kind).toBe('credential_rejected');
    expect(err.hint).toBeUndefined();
  });

  it('a 5xx on a read is an http error', async () => {
    const { client } = setup([new Response('oops', { status: 502 })]);
    const err = (await client.listDeliveries().catch((e: unknown) => e)) as McpToolError;
    expect(err).not.toBeInstanceOf(WriteOutcomeUnknownError);
    expect(err.status).toBe(502);
  });

  it('a 5xx after a write was sent is WriteOutcomeUnknownError carrying the status', async () => {
    const { client } = setup([new Response('gateway', { status: 503 })]);
    const err = await client.setPlanProduct(PLAN, 'US-CBU-2-6-0').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WriteOutcomeUnknownError);
    expect(writeOutcomeStatus(err as WriteOutcomeUnknownError)).toBe(503);
    expect((err as WriteOutcomeUnknownError).method).toBe('PATCH');
  });

  it('a 4xx on a write is a plain error (nothing was applied)', async () => {
    const { client } = setup([json({ error: 'VALIDATION_ERROR' }, 400)]);
    const err = await client.changeOneOff({ subscriptionId: SUB, week: WEEK, sku: 'x', deliveryOption: 'y' }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(WriteOutcomeUnknownError);
    expect((err as McpToolError).status).toBe(400);
  });

  it('a Cloudflare challenge is EdgeBlockedError (error status and 200)', async () => {
    const page = '<html><title>Just a moment...</title><script>window._cf_chl_opt={}</script></html>';
    const { client } = setup([
      new Response(page, { status: 403, headers: { 'content-type': 'text/html', 'cf-mitigated': 'challenge' } }),
      new Response(page, { status: 200, headers: { 'content-type': 'text/html', 'cf-mitigated': 'challenge' } }),
    ]);
    await expect(client.listSubscriptions()).rejects.toBeInstanceOf(EdgeBlockedError);
    await expect(client.listSubscriptions()).rejects.toBeInstanceOf(EdgeBlockedError);
  });

  it('a non-JSON 200 is an UpstreamFormatError', async () => {
    const { client } = setup([new Response('<html>hi</html>', { status: 200 })]);
    await expect(client.listSubscriptions()).rejects.toBeInstanceOf(UpstreamFormatError);
  });

  it('a transport failure on a read is a transport error', async () => {
    const failed = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) });
    const { client } = setup([failed, new Error('weird')]);
    const err = (await client.listSubscriptions().catch((e: unknown) => e)) as McpToolError;
    expect(err).toBeInstanceOf(McpToolError);
    expect(err.kind).toBe('transport');
    expect(err.message).not.toContain('/api/');
    const other = (await client.listSubscriptions().catch((e: unknown) => e)) as McpToolError;
    expect(other.kind).toBe('transport');
    expect(other.message).toContain('weird');
  });

  it('a transport failure after a write was sent is WriteOutcomeUnknownError', async () => {
    const { client } = setup([new TypeError('fetch failed')]);
    const err = (await client.setPlanProduct(PLAN, 'US-CBU-2-6-0').catch((e: unknown) => e)) as WriteOutcomeUnknownError;
    expect(err).toBeInstanceOf(WriteOutcomeUnknownError);
    expect(err.timedOut).toBe(false);
  });

  const hang = (init: RequestInit) =>
    new Promise<Response>((_, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
    });

  it('a read that times out is a timeout error', async () => {
    const { client } = setup([hang], { timeoutMs: 5 });
    const err = (await client.listSubscriptions().catch((e: unknown) => e)) as McpToolError;
    expect(err).toBeInstanceOf(McpToolError);
    expect(err.kind).toBe('timeout');
    expect(err.message).toContain('5 ms');
  });

  it('a write that times out is WriteOutcomeUnknownError with timedOut', async () => {
    const { client } = setup([hang], { timeoutMs: 5 });
    const err = (await client.setPlanProduct(PLAN, 'x').catch((e: unknown) => e)) as WriteOutcomeUnknownError;
    expect(err).toBeInstanceOf(WriteOutcomeUnknownError);
    expect(err.timedOut).toBe(true);
    expect(err.timeoutMs).toBe(5);
  });

  it('a body that breaks off is a transport error on a read and unknown on a write', async () => {
    const broken = () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.error(new Error('socket hang up'));
          },
        }),
        { status: 200 },
      );
    const { client } = setup([broken(), broken()]);
    const read = (await client.listSubscriptions().catch((e: unknown) => e)) as McpToolError;
    expect(read.kind).toBe('transport');
    await expect(client.setPlanProduct(PLAN, 'x')).rejects.toBeInstanceOf(WriteOutcomeUnknownError);
  });

  it('honours the caller cancellation: a cancelled read rethrows the abort', async () => {
    const { client, calls } = setup([hang]);
    const controller = new AbortController();
    const pending = withCallSignal(controller.signal, () => client.listSubscriptions());
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    controller.abort(new Error('cancelled by caller'));
    await expect(pending).rejects.toThrow('cancelled by caller');
  });

  it('uses the global fetch and default timeout when none is given', async () => {
    const globalFetch = vi.fn(async () => json({ weeks: [] }));
    vi.stubGlobal('fetch', globalFetch);
    try {
      const session: ClientSession = { withAuth: (call) => call('t'), redact: (t) => t };
      const client = new HelloFreshClient({ session });
      await expect(client.listMenuWeeks()).resolves.toEqual({ weeks: [] });
      expect(globalFetch).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('HelloFreshClient with the real session', () => {
  it('replays once with a fresh token after a 401', async () => {
    const now = 1_800_000_000;
    const set = (access: string, refresh: string, issued: number) => ({
      access_token: access,
      expires_in: 1800,
      refresh_token: refresh,
      token_type: 'Bearer',
      refresh_expires_in: 5_184_000,
      issued_at: issued,
    });
    let cookie = encodeAuthCookie(set('access-OLD', 'refresh-OLD', now));
    const bridge: SessionBridge = {
      readAuthCookie: async () => cookie,
      writeAuthCookie: async (value) => {
        cookie = value;
      },
    };
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes('/gw/refresh')) return json(set('access-NEW', 'refresh-NEW', now + 5));
      const auth = new Headers(init.headers).get('authorization')!;
      seen.push(auth);
      return auth === 'Bearer access-OLD' ? json({ errorMessage: 'expired' }, 401) : json({ count: 0, items: [] });
    });
    const session = new HelloFreshSession({ bridge, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => now * 1000 });
    const client = new HelloFreshClient({ session, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.listDeliveries()).resolves.toEqual({ count: 0, items: [] });
    expect(seen).toEqual(['Bearer access-OLD', 'Bearer access-NEW']);
  });
});
