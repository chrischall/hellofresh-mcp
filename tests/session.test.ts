import { describe, expect, it, vi } from 'vitest';
import { EdgeBlockedError, McpToolError } from '@chrischall/mcp-utils';
import {
  EXPIRY_SKEW_MS,
  HelloFreshBridgeError,
  HelloFreshSession,
  HelloFreshSessionError,
  REFRESH_URL,
  WRITE_BACK_WARNING,
  decodeAuthCookie,
  encodeAuthCookie,
  tokenExpiresAtMs,
  type AuthTokenSet,
  type SessionBridge,
} from '../src/session.js';

// Synthetic values only — never a real token, customer id or email.
const NOW_S = 1_800_000_000;
const NOW_MS = NOW_S * 1000;

function tokenSet(over: Partial<AuthTokenSet> = {}): AuthTokenSet {
  return {
    access_token: 'access-AAA',
    expires_in: 1800,
    refresh_token: 'refresh-RRR',
    token_type: 'Bearer',
    user_data: { id: '00000000-0000-4000-8000-000000000000', email: 'someone@example.com', country: 'US' },
    refresh_expires_in: 5_184_000,
    issued_at: NOW_S,
    ...over,
  };
}

/** A cookie value as the site's js-cookie would store it. */
const cookieOf = (set: AuthTokenSet) => encodeAuthCookie(set);

interface Harness {
  session: HelloFreshSession;
  bridge: { readAuthCookie: ReturnType<typeof vi.fn>; writeAuthCookie: ReturnType<typeof vi.fn> };
  fetchImpl: ReturnType<typeof vi.fn>;
  clock: { now: number };
}

function harness(opts: {
  cookie?: string | undefined | (() => Promise<string | undefined>);
  refresh?: (body: string) => Response | Promise<Response>;
  write?: (value: string) => Promise<void>;
}): Harness {
  const clock = { now: NOW_MS };
  const cookieState = { value: 'cookie' in opts ? opts.cookie : cookieOf(tokenSet()) };
  const bridge = {
    readAuthCookie: vi.fn(async () => {
      const c = cookieState.value;
      return typeof c === 'function' ? c() : c;
    }),
    writeAuthCookie: vi.fn(
      opts.write ??
        (async (value: string) => {
          cookieState.value = value;
        }),
    ),
  };
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    if (!opts.refresh) throw new Error('unexpected refresh');
    return opts.refresh(String(init.body));
  });
  const session = new HelloFreshSession({
    bridge: bridge as unknown as SessionBridge,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now: () => clock.now,
  });
  return { session, bridge, fetchImpl, clock };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const refreshed = (over: Partial<AuthTokenSet> = {}) =>
  json(tokenSet({ access_token: 'access-NEW', refresh_token: 'refresh-NEW', issued_at: NOW_S + 10, ...over }));

describe('apiV2Auth cookie encoding (js-cookie v3)', () => {
  it('encodes exactly as the site does: " and , escaped; { } : [ ] @ literal; keys in documented order', () => {
    const encoded = encodeAuthCookie(
      tokenSet({ user_data: { id: 'u-1', email: 'a@example.com', roles: ['x', 'y'] }, extra: 'z' }),
    );
    expect(encoded.startsWith('{%22access_token%22:%22access-AAA%22%2C%22expires_in%22:1800%2C%22refresh_token%22:')).toBe(true);
    expect(encoded).toContain('%22user_data%22:{%22id%22:%22u-1%22%2C%22email%22:%22a@example.com%22%2C%22roles%22:[%22x%22%2C%22y%22]}');
    expect(encoded.endsWith('%22issued_at%22:1800000000%2C%22extra%22:%22z%22}')).toBe(true);
    expect(encoded).not.toMatch(/[" ,;]/);
  });

  it('omits an absent field rather than writing undefined', () => {
    const set = tokenSet({ token_type: undefined });
    expect(encodeAuthCookie(set)).not.toContain('token_type');
  });

  it('round-trips through decode', () => {
    const set = tokenSet();
    expect(decodeAuthCookie(encodeAuthCookie(set))).toEqual(set);
  });

  it('decodes a fully percent-encoded or quoted value too', () => {
    const set = tokenSet();
    expect(decodeAuthCookie(encodeURIComponent(JSON.stringify(set)))).toEqual(set);
    expect(decodeAuthCookie(`"${encodeAuthCookie(set)}"`)).toEqual(set);
  });

  it('a value that is not the token JSON is a session error (never echoing the value)', () => {
    for (const raw of ['not-json-secret', '%E0%A4%A', '[]', JSON.stringify({ access_token: 'secret-only' })]) {
      let err: unknown;
      try {
        decodeAuthCookie(raw);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(HelloFreshSessionError);
      expect((err as Error).message).not.toContain('secret');
    }
  });

  it('expiry: issued_at + expires_in, else the JWT exp claim, else already expired', () => {
    expect(tokenExpiresAtMs(tokenSet())).toBe((NOW_S + 1800) * 1000);
    const payload = Buffer.from(JSON.stringify({ exp: NOW_S + 99 })).toString('base64url');
    const jwt = `e30.${payload}.sig`;
    expect(tokenExpiresAtMs(tokenSet({ access_token: jwt, issued_at: undefined as unknown as number }))).toBe((NOW_S + 99) * 1000);
    expect(tokenExpiresAtMs(tokenSet({ issued_at: undefined as unknown as number }))).toBe(0);
  });
});

describe('HelloFreshSession token lifecycle', () => {
  it('uses a fresh browser cookie, and caches it (one bridge read for two calls)', async () => {
    const h = harness({});
    await expect(h.session.getToken()).resolves.toBe('access-AAA');
    await expect(h.session.getToken()).resolves.toBe('access-AAA');
    expect(h.bridge.readAuthCookie).toHaveBeenCalledTimes(1);
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(h.session.expiresInMinutes()).toBe(30);
    expect(h.session.warning()).toBeUndefined();
  });

  it('single-flights concurrent callers', async () => {
    const h = harness({});
    const [a, b] = await Promise.all([h.session.getToken(), h.session.getToken()]);
    expect(a).toBe(b);
    expect(h.bridge.readAuthCookie).toHaveBeenCalledTimes(1);
  });

  it('within 60 s of expiry it re-reads the cookie, and uses the browser\'s fresher token without refreshing', async () => {
    let cookie = cookieOf(tokenSet());
    const h = harness({ cookie: async () => cookie });
    await h.session.getToken();
    h.clock.now = NOW_MS + 1800 * 1000 - EXPIRY_SKEW_MS + 1;
    cookie = cookieOf(tokenSet({ access_token: 'access-BROWSER', refresh_token: 'refresh-BROWSER', issued_at: NOW_S + 1700 }));
    await expect(h.session.getToken()).resolves.toBe('access-BROWSER');
    expect(h.bridge.readAuthCookie).toHaveBeenCalledTimes(2);
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it('a stale cookie is refreshed from Node, and the rotated set is written back to the browser', async () => {
    const h = harness({
      cookie: cookieOf(tokenSet({ issued_at: NOW_S - 1800 })),
      refresh: () => refreshed(),
    });
    await expect(h.session.getToken()).resolves.toBe('access-NEW');
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetchImpl.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(REFRESH_URL);
    expect(REFRESH_URL).toBe('https://www.hellofresh.com/gw/refresh?country=us&locale=en-US');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ refresh_token: 'refresh-RRR' });
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(h.bridge.writeAuthCookie).toHaveBeenCalledTimes(1);
    const written = decodeAuthCookie(h.bridge.writeAuthCookie.mock.calls[0]![0] as string);
    expect(written.access_token).toBe('access-NEW');
    expect(written.refresh_token).toBe('refresh-NEW');
    expect(written.user_data).toEqual(tokenSet().user_data);
    expect(h.session.warning()).toBeUndefined();
  });

  it('fills issued_at and user_data when the refresh answer omits them', async () => {
    const h = harness({
      cookie: cookieOf(tokenSet({ issued_at: NOW_S - 1800 })),
      refresh: () => json({ access_token: 'access-NEW', refresh_token: 'refresh-NEW', expires_in: 1800 }),
    });
    await h.session.getToken();
    const written = decodeAuthCookie(h.bridge.writeAuthCookie.mock.calls[0]![0] as string);
    expect(written.issued_at).toBe(NOW_S);
    expect(written.user_data).toEqual(tokenSet().user_data);
    expect(h.session.expiresInMinutes()).toBe(30);
  });

  it('a failed write-back still returns the new token, warns, and the next refresh spends OUR rotated token', async () => {
    const bodies: string[] = [];
    let n = 0;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness({
      cookie: cookieOf(tokenSet({ issued_at: NOW_S - 1800 })),
      refresh: (body) => {
        bodies.push(body);
        n++;
        return refreshed({ access_token: `access-${n}`, refresh_token: `refresh-${n}`, issued_at: NOW_S + n });
      },
      write: async () => {
        throw new Error('extension offline');
      },
    });
    await expect(h.session.getToken()).resolves.toBe('access-1');
    expect(h.session.warning()).toBe(WRITE_BACK_WARNING);
    expect(WRITE_BACK_WARNING).toMatch(/browser session may be signed out; sign in again/);
    expect(errors.mock.calls.flat().join(' ')).not.toMatch(/access-1|refresh-1/);

    h.clock.now = NOW_MS + 1800 * 1000;
    await expect(h.session.getToken()).resolves.toBe('access-2');
    // The browser still holds the spent refresh-RRR; ours is newer.
    expect(bodies.map((b) => JSON.parse(b).refresh_token)).toEqual(['refresh-RRR', 'refresh-1']);
    errors.mockRestore();
  });

  it('a successful write-back clears an earlier warning', async () => {
    let fail = true;
    let n = 0;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness({
      cookie: cookieOf(tokenSet({ issued_at: NOW_S - 1800 })),
      refresh: () => {
        n++;
        return refreshed({ access_token: `access-${n}`, refresh_token: `refresh-${n}`, issued_at: NOW_S + n });
      },
      write: async () => {
        if (fail) throw new Error('offline');
      },
    });
    await h.session.getToken();
    expect(h.session.warning()).toBeDefined();
    fail = false;
    h.clock.now = NOW_MS + 1800 * 1000;
    await h.session.getToken();
    expect(h.session.warning()).toBeUndefined();
    vi.restoreAllMocks();
  });

  it('a revoked refresh token (invalid_grant) is an actionable sign-in error', async () => {
    const h = harness({
      cookie: cookieOf(tokenSet({ issued_at: NOW_S - 1800 })),
      refresh: () => json({ error: 'invalid_grant' }, 400),
    });
    const err = await h.session.getToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HelloFreshSessionError);
    expect((err as HelloFreshSessionError).hint).toMatch(/sign in at https:\/\/www\.hellofresh\.com/i);
    expect((err as HelloFreshSessionError).hint).toMatch(/ContextMint Bridge/);
    expect(h.bridge.writeAuthCookie).not.toHaveBeenCalled();
  });

  it('a 401 from the refresh endpoint is also a sign-in error', async () => {
    const h = harness({
      cookie: cookieOf(tokenSet({ issued_at: NOW_S - 1800 })),
      refresh: () => json({ errorMessage: 'nope' }, 401),
    });
    await expect(h.session.getToken()).rejects.toBeInstanceOf(HelloFreshSessionError);
  });

  it('a refresh outage is an http error with the status, never echoing a token', async () => {
    const h = harness({
      cookie: cookieOf(tokenSet({ issued_at: NOW_S - 1800 })),
      refresh: () => new Response('upstream broke while handling refresh-RRR', { status: 502 }),
    });
    const err = (await h.session.getToken().catch((e: unknown) => e)) as McpToolError;
    expect(err).toBeInstanceOf(McpToolError);
    expect(err).not.toBeInstanceOf(HelloFreshSessionError);
    expect(err.status).toBe(502);
    expect(err.message).toMatch(/HTTP 502/);
    expect(err.message).not.toContain('refresh-RRR');
  });

  it('a Cloudflare challenge on the refresh is an edge block, not a sign-in error', async () => {
    const h = harness({
      cookie: cookieOf(tokenSet({ issued_at: NOW_S - 1800 })),
      refresh: () =>
        new Response('<html><title>Just a moment...</title><script>window._cf_chl_opt={}</script></html>', {
          status: 403,
          headers: { 'content-type': 'text/html', 'cf-mitigated': 'challenge' },
        }),
    });
    await expect(h.session.getToken()).rejects.toBeInstanceOf(EdgeBlockedError);
  });

  it('a network failure on the refresh is a transport error', async () => {
    const h = harness({
      cookie: cookieOf(tokenSet({ issued_at: NOW_S - 1800 })),
      refresh: () => {
        throw new TypeError('fetch failed');
      },
    });
    const err = (await h.session.getToken().catch((e: unknown) => e)) as McpToolError;
    expect(err).toBeInstanceOf(McpToolError);
    expect(err.kind).toBe('transport');
    expect(err.message).toMatch(/fetch failed/);
  });

  describe('the browser cookie read fails after this process refreshed', () => {
    /** A session that refreshed once (written back), then the bridge read starts failing. */
    function refreshedThenBridgeDown(
      over: { cookie?: Partial<AuthTokenSet>; refresh?: Partial<AuthTokenSet>; write?: (value: string) => Promise<void> } = {},
    ) {
      const bodies: string[] = [];
      let n = 0;
      const read = { fail: false };
      const h = harness({
        cookie: async () => {
          if (read.fail) throw new Error('tab closed');
          return cookieOf(tokenSet({ issued_at: NOW_S - 1800, ...over.cookie }));
        },
        refresh: (body) => {
          bodies.push(body);
          n++;
          return refreshed({ access_token: `access-${n}`, refresh_token: `refresh-${n}`, issued_at: NOW_S + n, ...over.refresh });
        },
        // Accept the write-back without replacing the (scripted) cookie read.
        write: over.write ?? (async () => {}),
      });
      return { h, bodies, read };
    }

    it('refreshes from its OWN rotated token set instead of failing, and still writes the new set back', async () => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { h, bodies, read } = refreshedThenBridgeDown();
      await expect(h.session.getToken()).resolves.toBe('access-1');
      read.fail = true;
      h.clock.now = NOW_MS + 1800 * 1000;
      await expect(h.session.getToken()).resolves.toBe('access-2');
      expect(bodies.map((b) => JSON.parse(b).refresh_token)).toEqual(['refresh-RRR', 'refresh-1']);
      expect(h.bridge.writeAuthCookie).toHaveBeenCalledTimes(2);
      expect(decodeAuthCookie(h.bridge.writeAuthCookie.mock.calls[1]![0] as string).refresh_token).toBe('refresh-2');
      expect(h.session.warning()).toBeUndefined();
      const logged = errors.mock.calls.flat().join(' ');
      expect(logged).toMatch(/could not read the browser session/);
      expect(logged).not.toMatch(/access-|refresh-/);
      errors.mockRestore();
    });

    it('a 401 replay while the bridge is down refreshes past the rejected token from our own set', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const { h, bodies, read } = refreshedThenBridgeDown();
      const token = await h.session.getToken();
      read.fail = true;
      h.session.invalidate(token);
      await expect(h.session.getToken()).resolves.toBe('access-2');
      expect(bodies.map((b) => JSON.parse(b).refresh_token)).toEqual(['refresh-RRR', 'refresh-1']);
      vi.restoreAllMocks();
    });

    it('a failed write-back on that refresh still returns the new token and warns', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      let writes = 0;
      const { h, read } = refreshedThenBridgeDown({
        write: async () => {
          writes++;
          if (writes > 1) throw new Error('extension offline');
        },
      });
      await h.session.getToken();
      read.fail = true;
      h.clock.now = NOW_MS + 1800 * 1000;
      await expect(h.session.getToken()).resolves.toBe('access-2');
      expect(h.session.warning()).toBe(WRITE_BACK_WARNING);
      vi.restoreAllMocks();
    });

    it('an expired refresh token is not used: the bridge error surfaces', async () => {
      const { h, read } = refreshedThenBridgeDown();
      await h.session.getToken();
      read.fail = true;
      // refreshed() keeps refresh_expires_in 5_184_000 s from issued_at NOW_S + 1.
      h.clock.now = (NOW_S + 1 + 5_184_000) * 1000;
      const err = await h.session.getToken().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HelloFreshBridgeError);
      expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('a refresh token with no stated lifetime is tried', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const { h, read } = refreshedThenBridgeDown({ cookie: { refresh_expires_in: undefined }, refresh: { refresh_expires_in: undefined } });
      await h.session.getToken();
      read.fail = true;
      h.clock.now = NOW_MS + 1800 * 1000;
      await expect(h.session.getToken()).resolves.toBe('access-2');
      vi.restoreAllMocks();
    });

    it('a set that came from the browser (not our own refresh) is never used as a fallback', async () => {
      let fail = false;
      const h = harness({
        cookie: async () => {
          if (fail) throw new Error('tab closed');
          return cookieOf(tokenSet());
        },
        refresh: () => refreshed(),
      });
      const token = await h.session.getToken();
      fail = true;
      h.session.invalidate(token);
      await expect(h.session.getToken()).rejects.toBeInstanceOf(HelloFreshBridgeError);
      expect(h.fetchImpl).not.toHaveBeenCalled();
    });

    it('once the browser holds a newer set again, our older one is no longer a fallback', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      let cookie: string = cookieOf(tokenSet({ issued_at: NOW_S - 1800 }));
      let fail = false;
      const h = harness({
        cookie: async () => {
          if (fail) throw new Error('tab closed');
          return cookie;
        },
        refresh: () => refreshed(),
        write: async () => {},
      });
      await expect(h.session.getToken()).resolves.toBe('access-NEW');
      // The browser refreshed itself past ours.
      cookie = cookieOf(tokenSet({ access_token: 'access-B', refresh_token: 'refresh-B', issued_at: NOW_S + 1000 }));
      h.clock.now = NOW_MS + 1800 * 1000;
      await expect(h.session.getToken()).resolves.toBe('access-B');
      fail = true;
      h.session.invalidate('access-B');
      await expect(h.session.getToken()).rejects.toBeInstanceOf(HelloFreshBridgeError);
      expect(h.fetchImpl).toHaveBeenCalledTimes(1);
      vi.restoreAllMocks();
    });
  });

  it('a 200 refresh without tokens is a format error', async () => {
    const h = harness({
      cookie: cookieOf(tokenSet({ issued_at: NOW_S - 1800 })),
      refresh: () => json({ ok: true }),
    });
    await expect(h.session.getToken()).rejects.toThrow(/did not return a token/);
  });

  it('no cookie in the browser → not signed in, with the sign-in hint', async () => {
    const h = harness({ cookie: undefined });
    const err = (await h.session.getToken().catch((e: unknown) => e)) as HelloFreshSessionError;
    expect(err).toBeInstanceOf(HelloFreshSessionError);
    expect(err.message).toMatch(/Not signed in to HelloFresh/);
    expect(err.hint).toMatch(/ContextMint Bridge/);
  });

  it('a hinted bridge error passes through unchanged (fetchproxyHintOf rule)', async () => {
    const hinted = Object.assign(new Error('bridge down'), { name: 'FetchproxyBridgeDownError', hint: 'start the bridge' });
    const h = harness({ cookie: async () => Promise.reject(hinted) });
    await expect(h.session.getToken()).rejects.toBe(hinted);
  });

  it('a pending pairing becomes an approve-the-code error', async () => {
    const h = harness({
      cookie: async () => Promise.reject(new Error('pairing required — pair code is: 1234-5678')),
    });
    const err = (await h.session.getToken().catch((e: unknown) => e)) as HelloFreshBridgeError;
    expect(err).toBeInstanceOf(HelloFreshBridgeError);
    expect(err.hint).toMatch(/approve pair code 1234-5678/);
  });

  it('any other bridge failure is a bridge error with the sign-in hint', async () => {
    const h = harness({ cookie: async () => Promise.reject(new Error('tab closed')) });
    const err = (await h.session.getToken().catch((e: unknown) => e)) as HelloFreshBridgeError;
    expect(err).toBeInstanceOf(HelloFreshBridgeError);
    expect(err.message).toMatch(/tab closed/);
    expect(err.hint).toMatch(/hellofresh\.com/);
  });

  it('a non-Error bridge rejection is handled too', async () => {
    const h = harness({ cookie: async () => Promise.reject('weird') });
    await expect(h.session.getToken()).rejects.toBeInstanceOf(HelloFreshBridgeError);
  });

  it('redacts every token value it has seen', async () => {
    const h = harness({
      cookie: cookieOf(tokenSet({ issued_at: NOW_S - 1800 })),
      refresh: () => refreshed(),
    });
    await h.session.getToken();
    expect(h.session.redact('a access-AAA b refresh-RRR c access-NEW d refresh-NEW')).not.toMatch(/access-|refresh-/);
  });

  it('defaults to the global fetch and clock', () => {
    const session = new HelloFreshSession({ bridge: { readAuthCookie: vi.fn(), writeAuthCookie: vi.fn() } });
    expect(session.warning()).toBeUndefined();
  });

  it('reports no expiry before any token', () => {
    expect(harness({}).session.expiresInMinutes()).toBeUndefined();
  });
});

describe('HelloFreshSession.withAuth (401 replay)', () => {
  it('sends the bearer and returns a non-401 response untouched', async () => {
    const h = harness({});
    const call = vi.fn(async (_t: string) => new Response('ok', { status: 200 }));
    const res = await h.session.withAuth(call);
    expect(res.status).toBe(200);
    expect(call).toHaveBeenCalledWith('access-AAA');
  });

  it('on a 401: invalidates, re-runs the lifecycle (refreshing past the rejected token) and retries ONCE', async () => {
    const h = harness({ refresh: () => refreshed() });
    const call = vi.fn(async (t: string) => new Response(null, { status: t === 'access-NEW' ? 200 : 401 }));
    const res = await h.session.withAuth(call);
    expect(res.status).toBe(200);
    expect(call.mock.calls.map((c) => c[0])).toEqual(['access-AAA', 'access-NEW']);
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('a second 401 is returned, not retried again', async () => {
    const h = harness({ refresh: () => refreshed() });
    const call = vi.fn(async () => new Response(null, { status: 401 }));
    const res = await h.session.withAuth(call);
    expect(res.status).toBe(401);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('a 401 for a token another caller already replaced just replays with the current token', async () => {
    const h = harness({ refresh: () => refreshed() });
    const call = vi.fn(async (t: string) => {
      if (t === 'access-AAA') {
        h.session.invalidate('access-AAA');
        await h.session.getToken();
        return new Response(null, { status: 401 });
      }
      return new Response(null, { status: 200 });
    });
    const res = await h.session.withAuth(call);
    expect(res.status).toBe(200);
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('a 401 that is a Cloudflare page is returned as-is (no credential was judged)', async () => {
    const h = harness({});
    const call = vi.fn(
      async () =>
        new Response('<title>Just a moment...</title>', { status: 401, headers: { 'cf-mitigated': 'challenge' } }),
    );
    const res = await h.session.withAuth(call);
    expect(res.status).toBe(401);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('invalidate() with a token that is no longer current is a no-op', async () => {
    const h = harness({});
    await h.session.getToken();
    h.session.invalidate('something-else');
    await h.session.getToken();
    expect(h.bridge.readAuthCookie).toHaveBeenCalledTimes(1);
  });
});
