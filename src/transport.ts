// The ContextMint Bridge, used ONLY to bootstrap the session (the fleet's
// "bootstrap" archetype): it reads the `apiV2Auth` cookie from the user's
// signed-in www.hellofresh.com tab, and writes a refreshed token set back to
// it (HelloFresh ROTATES the refresh token on every refresh and sets no cookie,
// so without the write-back the browser keeps a spent refresh token and is
// signed out). Every API call is a plain Node fetch with a Bearer token —
// except the few Cloudflare's WAF refuses from Node (`POST /gw/calculate`),
// which run as an in-tab fetch (`fetchInTab`) over the `fetch` capability the
// bootstrap declaration already carries (no new pairing scope).
//
// `@chrischall/mcp-utils/fetchproxy` eagerly imports `@fetchproxy/server`, so it
// is imported lazily here (type imports are erased): nothing on the boot path
// depends on the bridge package resolving.

import { parseCookieHeader } from '@chrischall/mcp-utils';
import type {
  BridgeHealthcheckTransport,
  FetchproxyServer,
  FetchproxyServerOpts,
  FetchproxyTransport,
  LazyTransport,
} from '@chrischall/mcp-utils/fetchproxy';

/** The cookie domain the bridge is scoped to. */
export const BRIDGE_DOMAIN = 'hellofresh.com';

/**
 * The one cookie this MCP reads, declared up front: the pair grant is
 * per-scope, so changing it strands every paired user until they re-approve.
 */
export const AUTH_COOKIE = 'apiV2Auth';

/** The cookie is host-only on www.hellofresh.com. */
export const AUTH_SUBDOMAIN = 'www';

/** One request run as a fetch inside the signed-in www.hellofresh.com tab. */
export interface TabFetchRequest {
  method: string;
  /** Absolute URL, inside the declared domain. */
  url: string;
  headers: Record<string, string>;
  body?: string;
  /** Re-send once after a bridge timeout — only for a request with no side effects. */
  retryOnTimeout?: boolean;
}

/** The tab's answer: any upstream status (the caller maps it). */
export interface TabFetchResponse {
  status: number;
  body: string;
}

export interface HelloFreshBridge {
  /** Load the fetchproxy identity (no port bind — that is lazy). */
  start(): Promise<void>;
  close(): Promise<void>;
  /** The RAW (js-cookie encoded) `apiV2Auth` value, or undefined when absent. A secret. */
  readAuthCookie(): Promise<string | undefined>;
  /** Overwrite `apiV2Auth` in the browser with an encoded value. Throws unless the write is confirmed. */
  writeAuthCookie(value: string): Promise<void>;
  /** Run one request as a fetch in the signed-in tab. Throws only when the bridge could not deliver it. */
  fetchInTab(req: TabFetchRequest): Promise<TabFetchResponse>;
  /** The probe + status surface the healthcheck drives (built, NOT started). */
  healthTransport(): Promise<BridgeHealthcheckTransport>;
}

export interface HelloFreshBridgeOptions {
  port: number;
  version: string;
  /** Test seam: build the underlying FetchproxyServer (inject a mock). */
  createServer?: (opts: FetchproxyServerOpts) => FetchproxyServer;
}

export function createHelloFreshBridge(opts: HelloFreshBridgeOptions): HelloFreshBridge {
  // The library's build-once / start-once wrapper. `ready()` single-flights the
  // start and FORGETS a rejected one, so a start failure surfaces from the next
  // use instead of crashing boot — and that use retries it.
  let lazy: Promise<LazyTransport<FetchproxyTransport>> | undefined;
  let lastReady: Promise<FetchproxyTransport> | undefined;

  const lazyTransport = (): Promise<LazyTransport<FetchproxyTransport>> =>
    (lazy ??= import('@chrischall/mcp-utils/fetchproxy').then((fp) =>
      fp.createLazyTransport(() =>
        fp.createFetchproxyTransport({
          serverName: 'hellofresh-mcp',
          version: opts.version,
          port: opts.port,
          ...withCookieWrite(
            fp.createBootstrapOpts({
              domains: [BRIDGE_DOMAIN],
              bootstrap: { cookieKeys: [AUTH_COOKIE] },
            }),
          ),
          debugEnvVar: 'HELLOFRESH_DEBUG',
          logListening: true,
          createServer: opts.createServer,
        }),
      ),
    ));

  const ensureStarted = (): Promise<FetchproxyTransport> => (lastReady = lazyTransport().then((l) => l.ready()));

  return {
    async start() {
      await ensureStarted();
    },
    async close() {
      const transport = await lastReady?.catch(() => undefined);
      await transport?.close();
    },
    async readAuthCookie() {
      const transport = await ensureStarted();
      const header = await transport.server.readCookies({
        domain: BRIDGE_DOMAIN,
        subdomain: AUTH_SUBDOMAIN,
        keys: [AUTH_COOKIE],
      });
      return parseCookieHeader(header)[AUTH_COOKIE] || undefined;
    },
    async writeAuthCookie(value) {
      const transport = await ensureStarted();
      const written = await transport.server.writeCookies({
        domain: BRIDGE_DOMAIN,
        subdomain: AUTH_SUBDOMAIN,
        cookies: { [AUTH_COOKIE]: value },
      });
      if (!written.includes(AUTH_COOKIE)) {
        throw new Error(`the browser did not confirm writing the ${AUTH_COOKIE} cookie`);
      }
    },
    async fetchInTab(req) {
      const transport = await ensureStarted();
      const res = await transport.server.request(req.method, req.url, {
        headers: req.headers,
        ...(req.body !== undefined ? { body: req.body } : {}),
        ...(req.retryOnTimeout !== undefined ? { retryOnTimeout: req.retryOnTimeout } : {}),
      });
      return { status: res.status, body: res.body };
    },
    async healthTransport() {
      return (await lazyTransport()).transport();
    },
  };
}

/**
 * `createBootstrapOpts` derives the READ capabilities from the declarations;
 * the write verb is declared here, on top. It is approved at pair time as its
 * own line, so adding or dropping it later forces every user to re-pair.
 */
function withCookieWrite<T extends Pick<FetchproxyServerOpts, 'capabilities'>>(opts: T): T {
  // Always set here: a cookie declaration yields ['fetch', 'read_cookies'].
  return { ...opts, capabilities: [...opts.capabilities!, 'write_cookies'] };
}
