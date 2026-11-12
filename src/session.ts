// The HelloFresh session: the `apiV2Auth` token set the web app keeps in a
// cookie on www.hellofresh.com, read (and, after a refresh, written back)
// through ContextMint Bridge. Every API call is a plain Node fetch with the
// access token as a Bearer.
//
// Lifecycle (single-flight, see docs/PLAN.md):
//  1. A cached access token with > 60 s left is used as is.
//  2. Otherwise read the browser cookie; if ITS access token has > 60 s left
//     (the browser refreshed itself), use it.
//  3. Otherwise refresh from Node (`POST /gw/refresh`). The refresh token
//     ROTATES and the response sets no cookie, so the new set is written back
//     into the browser's cookie — or the browser keeps a spent refresh token
//     and is signed out. A failed write-back still uses the new tokens, but
//     surfaces WRITE_BACK_WARNING.
//  4. A 401 from any call invalidates the token, re-runs the lifecycle once
//     (never trusting the rejected token again) and retries the call once.
//  5. When the browser cookie read FAILS (bridge down, tab closed, pairing
//     pending) but the newest set this process knows is one it refreshed
//     itself, it may stand in — how far depends on its write-back:
//     - the write-back FAILED: the browser never received that refresh token,
//       so only this process can have spent it. While it has not expired it
//       is used, refreshed (and written back) as in 3 when stale.
//     - the write-back SUCCEEDED: the browser holds that refresh token and
//       may already have rotated it (POSTing a spent one can sign the browser
//       out). Only its ACCESS token is used, while still valid (and not
//       rejected); otherwise the original bridge error is rethrown, its
//       pairing hint intact. /gw/refresh is never called.
//     A set read from the browser is never a fallback: its refresh token may
//     already be spent by the browser. A missing cookie (signed out) is NOT a
//     read failure and still fails.
//
// No token value is ever logged, put in an error message or returned.

import {
  EdgeBlockedError,
  McpToolError,
  SessionNotAuthenticatedError,
  createCachedTokenSource,
  decodeJwtClaim,
  detectEdgeBlock,
  messageOf,
  parseJsonBody,
  redactValues,
  truncateErrorMessage,
  type CachedTokenSource,
  type ReactiveTokenSource,
} from '@chrischall/mcp-utils';
import { AUTH_COOKIE } from './transport.js';

export const WEB_ORIGIN = 'https://www.hellofresh.com';

/** Refresh endpoint (VERIFIED). Note the lower-case `country=us` the web app sends. */
export const REFRESH_URL = `${WEB_ORIGIN}/gw/refresh?country=us&locale=en-US`;

/** A token with this little life left is treated as expired. */
export const EXPIRY_SKEW_MS = 60_000;

/** Bound on the refresh POST. Never tied to the caller's cancellation: the refresh token rotates in flight. */
export const REFRESH_TIMEOUT_MS = 30_000;

export const WRITE_BACK_WARNING =
  'HelloFresh session was refreshed, but the new tokens could not be written back to the browser: ' +
  'the browser session may be signed out; sign in again at https://www.hellofresh.com if it is.';

/**
 * The `apiV2Auth` JSON. `user_data` carries the customer's id and email: it is
 * kept only to write the set back, and never returned.
 */
export interface AuthTokenSet {
  access_token: string;
  expires_in: number;
  refresh_token: string;
  token_type?: string;
  user_data?: unknown;
  refresh_expires_in?: number;
  /** Unix seconds. */
  issued_at: number;
  [key: string]: unknown;
}

/** The documented key order of the cookie JSON. */
const KEY_ORDER = [
  'access_token',
  'expires_in',
  'refresh_token',
  'token_type',
  'user_data',
  'refresh_expires_in',
  'issued_at',
] as const;

export function signInHint(): string {
  return `Sign in at ${WEB_ORIGIN} in the browser running ContextMint Bridge, then retry.`;
}

/** No usable HelloFresh session in the browser. */
export class HelloFreshSessionError extends SessionNotAuthenticatedError {
  constructor(reason: string, hint: string = signInHint()) {
    super('HelloFresh', 'www.hellofresh.com');
    this.message = `Not signed in to HelloFresh: ${reason}.`;
    Object.defineProperty(this, 'hint', { value: hint, enumerable: true, configurable: true });
  }
}

/** Reading through the bridge failed for an unclassified reason. */
export class HelloFreshBridgeError extends McpToolError {
  constructor(message: string, cause: unknown, hint: string = signInHint()) {
    super(message, { hint, cause });
    this.name = 'HelloFreshBridgeError';
  }
}

/**
 * The fleet's `fetchproxyHintOf` rule: a `Fetchproxy*` error carrying a typed
 * hint (pairing pending, no tab, bridge down) already names its remedy, so it is
 * surfaced unmodified. Duck-typed — a duplicated package breaks `instanceof`.
 */
export function isHintedFetchproxyError(err: unknown): boolean {
  if (!(err instanceof Error) || !err.name.startsWith('Fetchproxy')) return false;
  const hint = (err as Error & { hint?: unknown }).hint;
  return typeof hint === 'string' && hint.length > 0;
}

/**
 * @fetchproxy/server rejects calls while a pairing is pending with an error
 * carrying no `.hint` — only the code in its message. Pull the code out so the
 * user is told to approve it, not to sign in.
 */
export function pendingPairCode(err: unknown): string | undefined {
  const msg = messageOf(err);
  if (!/pairing required/i.test(msg)) return undefined;
  return /pair code is:?\s*(\d{4}-\d{4})/i.exec(msg)?.[1];
}

export function approvePairHint(code: string): string {
  return `Open the ContextMint Bridge extension popup in the browser signed in to ${WEB_ORIGIN}, approve pair code ${code} for hellofresh-mcp, then retry.`;
}

/**
 * Encode a token set exactly as the site's js-cookie v3 does:
 * `encodeURIComponent`, then DE-code `# $ & + / : < = > ? @ [ ] ^ \` { | }`
 * back to literals — so `"` → `%22` and `,` → `%2C` while `{ } : [ ]` stay.
 */
export function encodeAuthCookie(set: AuthTokenSet): string {
  const ordered: Record<string, unknown> = {};
  for (const key of KEY_ORDER) if (set[key] !== undefined) ordered[key] = set[key];
  for (const [key, value] of Object.entries(set)) if (!(key in ordered)) ordered[key] = value;
  return encodeURIComponent(JSON.stringify(ordered)).replace(
    /%(2[346BF]|3[AC-F]|40|5[BDE]|60|7[BCD])/g,
    decodeURIComponent,
  );
}

/** Decode a raw `apiV2Auth` value (js-cookie v3 read semantics). Never echoes the value. */
export function decodeAuthCookie(raw: string): AuthTokenSet {
  let parsed: unknown;
  try {
    const unquoted = raw.startsWith('"') ? raw.slice(1, -1) : raw;
    parsed = JSON.parse(unquoted.replace(/(%[\dA-F]{2})+/gi, decodeURIComponent));
  } catch {
    throw new HelloFreshSessionError(`the ${AUTH_COOKIE} cookie could not be read`);
  }
  if (!isTokenSet(parsed)) {
    throw new HelloFreshSessionError(`the ${AUTH_COOKIE} cookie holds no token set`);
  }
  return parsed;
}

function isTokenSet(value: unknown): value is AuthTokenSet {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return typeof v['access_token'] === 'string' && v['access_token'] !== '' &&
    typeof v['refresh_token'] === 'string' && v['refresh_token'] !== '';
}

/** Absolute access-token expiry, epoch ms: `issued_at + expires_in`, else the JWT `exp`, else 0 (expired). */
export function tokenExpiresAtMs(set: AuthTokenSet): number {
  if (typeof set.issued_at === 'number' && typeof set.expires_in === 'number') {
    return (set.issued_at + set.expires_in) * 1000;
  }
  const exp = decodeJwtClaim(set.access_token, 'exp');
  return typeof exp === 'number' ? exp * 1000 : 0;
}

/** The slice of the bridge the session needs. */
export interface SessionBridge {
  readAuthCookie(): Promise<string | undefined>;
  writeAuthCookie(value: string): Promise<void>;
}

export interface HelloFreshSessionOptions {
  bridge: SessionBridge;
  fetchImpl?: typeof fetch;
  /** Clock in ms (test seam). */
  now?: () => number;
}

/** How many token values to remember for redaction. */
const REDACT_HISTORY = 8;

export class HelloFreshSession implements ReactiveTokenSource {
  private readonly source: CachedTokenSource;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  /** The newest token set this process knows of (browser's or our own refresh). */
  private latest: AuthTokenSet | undefined;
  /** The access token the cache currently holds. */
  private current: string | undefined;
  /** An access token the API rejected: never trusted again, even if the cookie still holds it. */
  private rejected: string | undefined;
  private writeBackWarning: string | undefined;
  /** The refresh token of this process's own latest refresh (the fallback when the cookie read fails). */
  private ownRefreshToken: string | undefined;
  /** Whether that refresh was written back to the browser (which may then rotate it on its own). */
  private ownWrittenBack = false;
  private readonly seen: string[] = [];

  constructor(private readonly opts: HelloFreshSessionOptions) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.now = opts.now ?? Date.now;
    this.source = createCachedTokenSource({
      mint: async () => {
        const set = await this.lifecycle();
        this.current = set.access_token;
        return { token: set.access_token, expiresAt: tokenExpiresAtMs(set) };
      },
      bufferMs: EXPIRY_SKEW_MS,
      now: this.now,
    });
  }

  /** A valid access token (cached, the browser's, or freshly refreshed). */
  getToken(): Promise<string> {
    return this.source.getToken();
  }

  /** Drop `token` (the API rejected it). A no-op when it is no longer the current token. */
  invalidate(token: string): void {
    if (token !== this.current) return;
    this.rejected = token;
    this.current = undefined;
    this.source.invalidate();
  }

  /**
   * Run `call` with a valid token; on a 401, re-run the lifecycle once and
   * replay once. A 401 that is a CDN/WAF page is returned as is (no credential
   * was judged), and a 401 for a token a concurrent caller already replaced
   * replays with the current one without a second refresh.
   */
  async withAuth(call: (accessToken: string) => Promise<Response>): Promise<Response> {
    const token = await this.getToken();
    const res = await call(token);
    if (res.status !== 401) return res;
    const body = await res.clone().text();
    if (detectEdgeBlock({ status: 401, headers: res.headers, body })) return res;
    this.invalidate(token);
    return call(await this.getToken());
  }

  /** The write-back warning, while the browser may hold a spent refresh token. */
  warning(): string | undefined {
    return this.writeBackWarning;
  }

  /** Minutes left on the newest known access token, or undefined before any. */
  expiresInMinutes(): number | undefined {
    if (!this.latest) return undefined;
    return Math.floor((tokenExpiresAtMs(this.latest) - this.now()) / 60_000);
  }

  /** Scrub every token value this session has seen out of `text`. */
  redact(text: string): string {
    return redactValues(text, this.seen);
  }

  private remember(set: AuthTokenSet): void {
    this.seen.unshift(set.access_token, set.refresh_token);
    this.seen.length = Math.min(this.seen.length, REDACT_HISTORY);
  }

  private fresh(set: AuthTokenSet): boolean {
    return set.access_token !== this.rejected && tokenExpiresAtMs(set) - this.now() > EXPIRY_SKEW_MS;
  }

  /** Whether `set`'s refresh token is still usable: its stated lifetime has not run out (unstated = try it). */
  private refreshable(set: AuthTokenSet): boolean {
    if (typeof set.refresh_expires_in !== 'number') return true;
    return (set.issued_at + set.refresh_expires_in) * 1000 > this.now();
  }

  /** The newest token set: the browser cookie's or our own (lifecycle steps 2 and 5). */
  private async newestSet(): Promise<AuthTokenSet> {
    let raw: string | undefined;
    try {
      raw = await this.bridged(() => this.opts.bridge.readAuthCookie());
    } catch (err) {
      const ours = this.latest;
      if (!ours || ours.refresh_token !== this.ownRefreshToken) throw err;
      // Written back: the browser may have rotated (spent) its refresh token — use the access token only.
      if (this.ownWrittenBack ? !this.fresh(ours) : !this.refreshable(ours)) throw err;
      console.error(
        `[hellofresh-mcp] could not read the browser session (${truncateErrorMessage(this.redact(messageOf(err)), 200)}); using this process's own refreshed session`,
      );
      return ours;
    }
    if (!raw) throw new HelloFreshSessionError(`no ${AUTH_COOKIE} cookie was found on www.hellofresh.com`);
    const browser = decodeAuthCookie(raw);
    this.remember(browser);

    // Our own refresh is newer than the cookie only when its write-back failed:
    // then the cookie's refresh token is already spent and ours must be used.
    const ours = this.latest;
    const browserIsNewest = !ours || browser.issued_at >= ours.issued_at;
    if (browserIsNewest) this.writeBackWarning = undefined;
    return browserIsNewest ? browser : ours;
  }

  private async lifecycle(): Promise<AuthTokenSet> {
    const newest = await this.newestSet();
    if (this.fresh(newest)) {
      this.latest = newest;
      return newest;
    }

    const next = await this.refresh(newest);
    this.latest = next;
    this.ownRefreshToken = next.refresh_token;
    this.ownWrittenBack = false;
    this.remember(next);
    try {
      await this.opts.bridge.writeAuthCookie(encodeAuthCookie(next));
      this.ownWrittenBack = true;
      this.writeBackWarning = undefined;
    } catch (err) {
      this.writeBackWarning = WRITE_BACK_WARNING;
      console.error(
        `[hellofresh-mcp] could not write the refreshed session back to the browser: ${truncateErrorMessage(this.redact(messageOf(err)), 200)}`,
      );
    }
    return next;
  }

  private async bridged<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (isHintedFetchproxyError(err)) throw err;
      const code = pendingPairCode(err);
      if (code) {
        throw new HelloFreshBridgeError(
          `HelloFresh pairing is pending: approve pair code ${code} in ContextMint Bridge.`,
          err,
          approvePairHint(code),
        );
      }
      throw new HelloFreshBridgeError(
        `Could not read the HelloFresh session from the browser: ${truncateErrorMessage(messageOf(err), 200)}`,
        err,
      );
    }
  }

  private async refresh(from: AuthTokenSet): Promise<AuthTokenSet> {
    const where = { service: 'HelloFresh', method: 'POST', path: '/gw/refresh' };
    let res: Response;
    let text: string;
    try {
      res = await this.fetchImpl(REFRESH_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ refresh_token: from.refresh_token }),
        signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      });
      text = await res.text();
    } catch (err) {
      throw new McpToolError(
        `Could not refresh the HelloFresh session: ${truncateErrorMessage(this.redact(messageOf(err)), 200)}`,
        { kind: 'transport', cause: err },
      );
    }

    if (!res.ok) {
      const edge = detectEdgeBlock({ status: res.status, headers: res.headers, body: text });
      if (edge) throw new EdgeBlockedError(res.status, edge.vendor, where);
      if (res.status === 401 || /"error"\s*:\s*"invalid_grant"/.test(text)) {
        throw new HelloFreshSessionError('the browser session has expired or was signed out (the refresh was rejected)');
      }
      throw new McpToolError(
        `HelloFresh session refresh failed: HTTP ${res.status}: ${truncateErrorMessage(this.redact(text), 200)}`,
        { status: res.status, kind: 'http' },
      );
    }

    const body = parseJsonBody<Record<string, unknown>>(text, { ...where, expect: 'object', status: res.status, headers: res.headers });
    if (!isTokenSet(body)) {
      throw new McpToolError('HelloFresh session refresh did not return a token set.', { status: res.status });
    }
    return {
      ...from,
      ...body,
      issued_at: typeof body.issued_at === 'number' ? body.issued_at : Math.floor(this.now() / 1000),
      user_data: body.user_data ?? from.user_data,
    };
  }
}
