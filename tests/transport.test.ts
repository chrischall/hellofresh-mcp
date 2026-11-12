import { describe, expect, it, vi } from 'vitest';
import type { FetchproxyServer, FetchproxyServerOpts } from '@chrischall/mcp-utils/fetchproxy';
import { AUTH_COOKIE, AUTH_SUBDOMAIN, BRIDGE_DOMAIN, createHelloFreshBridge } from '../src/transport.js';

function fakeServer(listen: () => Promise<void> = async () => {}) {
  return {
    listen: vi.fn(listen),
    close: vi.fn(async () => {}),
    bridgeHealth: vi.fn(() => ({ port: 37_149 })),
    readCookies: vi.fn(async (_opts?: unknown) => ''),
    writeCookies: vi.fn(async (_opts: unknown): Promise<string[]> => ['apiV2Auth']),
    runProbe: vi.fn(async () => ({ ok: true, elapsed_ms: 1, bridge: {} })),
    request: vi.fn(async (_method: string, _path: string, _opts?: unknown) => ({ status: 200, body: '{"a":1}', url: '' })),
    role: null,
  };
}

function bridgeWith(server: ReturnType<typeof fakeServer>, captured: FetchproxyServerOpts[] = []) {
  return createHelloFreshBridge({
    port: 41_000,
    version: '9.9.9',
    createServer: (opts) => {
      captured.push(opts);
      return server as unknown as FetchproxyServer;
    },
  });
}

describe('createHelloFreshBridge', () => {
  it('declares hellofresh.com and ONLY the apiV2Auth cookie, on the configured port', async () => {
    const captured: FetchproxyServerOpts[] = [];
    const server = fakeServer();
    const bridge = bridgeWith(server, captured);
    await bridge.start();
    expect(server.listen).toHaveBeenCalledTimes(1);
    const opts = captured[0]!;
    expect(opts.serverName).toBe('hellofresh-mcp');
    expect(opts.version).toBe('9.9.9');
    expect(opts.port).toBe(41_000);
    expect(BRIDGE_DOMAIN).toBe('hellofresh.com');
    expect(AUTH_COOKIE).toBe('apiV2Auth');
    expect(opts.domains).toEqual(['hellofresh.com']);
    expect(opts.cookieKeys).toEqual(['apiV2Auth']);
    expect(opts.capabilities).toContain('read_cookies');
    // The refresh token rotates: the refreshed set must be written back, so the
    // write verb is declared at pair time alongside the read.
    expect(opts.capabilities).toContain('write_cookies');
    // The in-tab fetch (hf price) rides the `fetch` capability the bootstrap already declares.
    expect(opts.capabilities).toContain('fetch');
  });

  it('fetchInTab relays the request through the www.hellofresh.com tab and returns status + body', async () => {
    const server = fakeServer();
    server.request.mockResolvedValueOnce({ status: 403, body: '<html>', url: 'https://www.hellofresh.com/gw/calculate' });
    const bridge = bridgeWith(server);
    await expect(
      bridge.fetchInTab({
        method: 'POST',
        url: 'https://www.hellofresh.com/gw/calculate',
        headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
        body: '{"x":1}',
        retryOnTimeout: true,
      }),
    ).resolves.toEqual({ status: 403, body: '<html>' });
    expect(server.request).toHaveBeenCalledWith('POST', 'https://www.hellofresh.com/gw/calculate', {
      headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
      body: '{"x":1}',
      retryOnTimeout: true,
    });
  });

  it('fetchInTab without a body or retry flag sends neither', async () => {
    const server = fakeServer();
    const bridge = bridgeWith(server);
    await expect(bridge.fetchInTab({ method: 'GET', url: 'https://www.hellofresh.com/x', headers: {} })).resolves.toEqual({
      status: 200,
      body: '{"a":1}',
    });
    expect(server.request).toHaveBeenCalledWith('GET', 'https://www.hellofresh.com/x', { headers: {} });
  });

  it('readAuthCookie reads ONLY apiV2Auth on www.hellofresh.com and returns its raw value', async () => {
    const server = fakeServer();
    server.readCookies.mockResolvedValue('other=1; apiV2Auth={%22access_token%22:%22a%22}');
    const bridge = bridgeWith(server);
    await expect(bridge.readAuthCookie()).resolves.toBe('{%22access_token%22:%22a%22}');
    expect(AUTH_SUBDOMAIN).toBe('www');
    expect(server.readCookies).toHaveBeenCalledWith({ domain: 'hellofresh.com', subdomain: 'www', keys: ['apiV2Auth'] });
    expect(server.listen).toHaveBeenCalledTimes(1);
  });

  it('readAuthCookie is undefined when the cookie is absent or empty', async () => {
    const server = fakeServer();
    const bridge = bridgeWith(server);
    server.readCookies.mockResolvedValueOnce('');
    await expect(bridge.readAuthCookie()).resolves.toBeUndefined();
    server.readCookies.mockResolvedValueOnce('apiV2Auth=');
    await expect(bridge.readAuthCookie()).resolves.toBeUndefined();
  });

  it('writeAuthCookie writes ONLY apiV2Auth on www.hellofresh.com', async () => {
    const server = fakeServer();
    const bridge = bridgeWith(server);
    await bridge.writeAuthCookie('{%22x%22:1}');
    expect(server.writeCookies).toHaveBeenCalledWith({
      domain: 'hellofresh.com',
      subdomain: 'www',
      cookies: { apiV2Auth: '{%22x%22:1}' },
    });
  });

  it('writeAuthCookie fails when the extension did not confirm the write', async () => {
    const server = fakeServer();
    server.writeCookies.mockResolvedValueOnce([]);
    const bridge = bridgeWith(server);
    await expect(bridge.writeAuthCookie('v')).rejects.toThrow(/did not confirm/);
  });

  it('healthTransport exposes the probe + status surface without starting the bridge', async () => {
    const server = fakeServer();
    const bridge = bridgeWith(server);
    const transport = await bridge.healthTransport();
    expect(typeof transport.runProbe).toBe('function');
    expect(transport.status().serverVersion).toBe('9.9.9');
    expect(server.listen).not.toHaveBeenCalled();
  });

  it('starts once however often start() is called', async () => {
    const server = fakeServer();
    const bridge = bridgeWith(server);
    await bridge.start();
    await bridge.start();
    expect(server.listen).toHaveBeenCalledTimes(1);
  });

  it('a failed start rejects, and the next start retries', async () => {
    let fail = true;
    const server = fakeServer(async () => {
      if (fail) throw new Error('identity unreadable');
    });
    const bridge = bridgeWith(server);
    await expect(bridge.start()).rejects.toThrow('identity unreadable');
    fail = false;
    await expect(bridge.start()).resolves.toBeUndefined();
    expect(server.listen).toHaveBeenCalledTimes(2);
  });

  it('close() closes a started transport', async () => {
    const server = fakeServer();
    const bridge = bridgeWith(server);
    await bridge.start();
    await bridge.close();
    expect(server.close).toHaveBeenCalledTimes(1);
  });

  it('close() before start, or after a failed start, is a no-op', async () => {
    const server = fakeServer(async () => {
      throw new Error('boom');
    });
    const bridge = bridgeWith(server);
    await bridge.close();
    await bridge.start().catch(() => {});
    await bridge.close();
    expect(server.close).not.toHaveBeenCalled();
  });
});
