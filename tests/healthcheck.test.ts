import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestHarness, parseToolResult, type TestHarness } from '@chrischall/mcp-utils/test';
import type { BridgeHealthcheckTransport } from '@chrischall/mcp-utils/fetchproxy';
import { PROBE_PATH, registerHealthcheckTool } from '../src/tools/healthcheck.js';
import { HelloFreshClient } from '../src/client.js';
import { HelloFreshSession, encodeAuthCookie, type AuthTokenSet } from '../src/session.js';
import type { HelloFreshBridge } from '../src/transport.js';
import type { ToolDeps } from '../src/tools/index.js';

const NOW_S = 1_800_000_000;

interface Result {
  ok: boolean;
  bridge?: { session_state?: string };
  probe: { url: string; status?: number; body_length?: number };
  error?: { kind: string; message: string };
  session: { expires_in_minutes?: number; warning?: string };
  hint: string;
}

function tokenSet(over: Partial<AuthTokenSet> = {}): AuthTokenSet {
  return {
    access_token: 'access-AAA',
    expires_in: 1800,
    refresh_token: 'refresh-RRR',
    token_type: 'Bearer',
    user_data: { id: '00000000-0000-4000-8000-000000000000', email: 'someone@example.com' },
    refresh_expires_in: 5_184_000,
    issued_at: NOW_S,
    ...over,
  };
}

/** A stand-in for FetchproxyServer.runProbe: run the probe, classify a throw, project bridge state. */
function fakeHealthTransport(): BridgeHealthcheckTransport {
  const health = { role: 'host', port: 37_149, session: { state: 'linked', pairCode: null, extensionConnected: true } };
  const bridge = {
    role: 'host',
    port: 37_149,
    server_version: 'test',
    fetch_timeout_ms: 30_000,
    last_success_at: null,
    last_failure_at: null,
    last_failure_reason: null,
    consecutive_failures: 0,
    session_state: 'linked',
    pending_pair_code: null,
    extension_connected: true,
    last_extension_message_at: null,
  };
  return {
    status: () => ({ ...health, lastExtensionMessageAt: null }) as unknown as ReturnType<BridgeHealthcheckTransport['status']>,
    runProbe: (async (fn: (p: string) => Promise<unknown>, path: string) => {
      try {
        await fn(path);
        return { ok: true, elapsed_ms: 1, bridge };
      } catch (e) {
        const kind = e instanceof Error && e.name === 'FetchproxyBridgeDownError' ? 'bridge_down' : 'other';
        return { ok: false, elapsed_ms: 1, bridge, error: { kind, message: (e as Error).message } };
      }
    }) as unknown as BridgeHealthcheckTransport['runProbe'],
  };
}

let harness: TestHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
  vi.restoreAllMocks();
});

async function run(opts: {
  cookie?: () => Promise<string | undefined>;
  write?: () => Promise<void>;
  api?: (auth: string | null) => Response;
  refresh?: () => Response;
}): Promise<{ result: Result; text: string; calls: { url: string; auth: string | null }[] }> {
  const calls: { url: string; auth: string | null }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const auth = new Headers(init.headers).get('authorization');
    calls.push({ url, auth });
    if (url.includes('/gw/refresh')) {
      if (!opts.refresh) throw new Error('unexpected refresh');
      return opts.refresh();
    }
    return (opts.api ?? (() => new Response(JSON.stringify({ count: 1, items: [{ id: 'sub-1' }] }), { status: 200 })))(auth);
  }) as unknown as typeof fetch;
  const bridge: HelloFreshBridge = {
    start: async () => {},
    close: async () => {},
    readAuthCookie: opts.cookie ?? (async () => encodeAuthCookie(tokenSet())),
    writeAuthCookie: opts.write ?? (async () => {}),
    healthTransport: async () => fakeHealthTransport(),
  };
  const session = new HelloFreshSession({ bridge, fetchImpl, now: () => NOW_S * 1000 });
  const deps: ToolDeps = { bridge, session, fetchImpl, client: new HelloFreshClient({ session, fetchImpl }) };
  harness = await createTestHarness((server) => registerHealthcheckTool(server, deps));
  const raw = await harness.callTool('hf_healthcheck');
  return { result: parseToolResult<Result>(raw), text: (raw.content as { text: string }[])[0]!.text, calls };
}

describe('hf_healthcheck', () => {
  it('is registered read-only, idempotent and open-world, and says what it checks', async () => {
    const bridge = { healthTransport: vi.fn() } as unknown as HelloFreshBridge;
    const deps = { bridge, session: {} as HelloFreshSession } as ToolDeps;
    harness = await createTestHarness((server) => registerHealthcheckTool(server, deps));
    const tool = (await harness.client.listTools()).tools.find((t) => t.name === 'hf_healthcheck');
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tool?.annotations?.idempotentHint).toBe(true);
    expect(tool?.annotations?.openWorldHint).toBe(true);
    expect(tool?.description).toMatch(/ContextMint Bridge/);
    expect(tool?.description).toMatch(/subscriptions/);
  });

  it('probes the subscriptions endpoint with the bearer and reports ONLY status + bridge + session state', async () => {
    const { result, text, calls } = await run({});
    expect(result.ok).toBe(true);
    expect(PROBE_PATH).toBe('/gw/api/customers/me/subscriptions?country=US&locale=en-US');
    expect(calls).toEqual([
      { url: 'https://www.hellofresh.com/gw/api/customers/me/subscriptions?country=US&locale=en-US', auth: 'Bearer access-AAA' },
    ]);
    expect(result.probe).toMatchObject({ url: `https://www.hellofresh.com${PROBE_PATH}`, status: 200, body_length: 0 });
    expect(result.bridge?.session_state).toBe('linked');
    expect(result.session).toEqual({ expires_in_minutes: 30 });
    expect(text).not.toMatch(/access-AAA|refresh-RRR|sub-1|someone@example/);
  });

  it('surfaces the write-back warning as the hint when the refreshed set could not reach the browser', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result } = await run({
      cookie: async () => encodeAuthCookie(tokenSet({ issued_at: NOW_S - 1800 })),
      refresh: () =>
        new Response(JSON.stringify(tokenSet({ access_token: 'access-NEW', refresh_token: 'refresh-NEW' })), { status: 200 }),
      write: async () => {
        throw new Error('offline');
      },
    });
    expect(result.ok).toBe(true);
    expect(result.session.warning).toMatch(/sign in again/);
    expect(result.hint).toBe(result.session.warning);
  });

  it('not signed in → session_expired with the sign-in hint, no API call', async () => {
    const { result, calls } = await run({ cookie: async () => undefined });
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('session_expired');
    expect(result.hint).toMatch(/Sign in at https:\/\/www\.hellofresh\.com/);
    expect(calls).toEqual([]);
    expect(result.session).toEqual({});
  });

  it('an unclassified bridge failure → kind bridge with its hint', async () => {
    const { result } = await run({ cookie: async () => Promise.reject(new Error('tab gone')) });
    expect(result.error?.kind).toBe('bridge');
    expect(result.hint).toMatch(/ContextMint Bridge/);
  });

  it('a hinted bridge error keeps the library classification (bridge_down)', async () => {
    const down = Object.assign(new Error('bridge is down'), { name: 'FetchproxyBridgeDownError', hint: 'start it' });
    const { result } = await run({ cookie: async () => Promise.reject(down) });
    expect(result.error?.kind).toBe('bridge_down');
  });

  it('the API rejecting even the refreshed token → credential_rejected with the sign-in hint', async () => {
    const { result } = await run({
      api: () => new Response('{"errorMessage":"no Bearer token"}', { status: 401 }),
      refresh: () =>
        new Response(JSON.stringify(tokenSet({ access_token: 'access-NEW', refresh_token: 'refresh-NEW' })), { status: 200 }),
    });
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('credential_rejected');
    expect(result.error?.message).toMatch(/HTTP 401/);
    expect(result.hint).toMatch(/Sign in at/);
  });

  it('a server error is reported with its status', async () => {
    const { result } = await run({ api: () => new Response('boom', { status: 503 }) });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/HTTP 503/);
  });

  it('a Cloudflare page on the probe is an edge block, not a sign-in problem', async () => {
    const { result } = await run({
      api: () =>
        new Response('<title>Just a moment...</title>', { status: 403, headers: { 'cf-mitigated': 'challenge' } }),
    });
    expect(result.error?.kind).toBe('edge_blocked');
  });
});
