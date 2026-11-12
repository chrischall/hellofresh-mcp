// hf_healthcheck — the bridge is on the auth path (it holds the session cookie),
// so this reports the bridge state AND probes the API from Node with the
// session's bearer: `GET /api/customers/me/subscriptions`, returning only the
// status (never the body, which carries the customer's name and address).
// The body is the library's bridge healthcheck; this adds the session block
// (minutes to expiry, the write-back warning) and HelloFresh's error kinds.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  EdgeBlockedError,
  McpToolError,
  detectEdgeBlock,
  errorKindOf,
  minifiedResult,
  toolAnnotations,
} from '@chrischall/mcp-utils';
import { HelloFreshBridgeError, HelloFreshSessionError, WEB_ORIGIN, signInHint } from '../session.js';
import type { ToolDeps } from './index.js';

export const PROBE_PATH = '/gw/api/customers/me/subscriptions?country=US&locale=en-US';
const HOST_LABEL = 'www.hellofresh.com';
const PROBE_TIMEOUT_MS = 30_000;

/** GET the subscriptions list with the session's bearer; resolve to '' (status only) or throw. */
async function probe(deps: ToolDeps): Promise<string> {
  const res = await deps.session.withAuth((token) =>
    deps.fetchImpl(`${WEB_ORIGIN}${PROBE_PATH}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    }),
  );
  const body = await res.text();
  if (res.ok) return '';
  const edge = detectEdgeBlock({ status: res.status, headers: res.headers, body });
  if (edge) throw new EdgeBlockedError(res.status, edge.vendor, { service: 'HelloFresh', method: 'GET', path: PROBE_PATH });
  throw new McpToolError(`HelloFresh answered HTTP ${res.status} for the subscriptions probe.`, {
    status: res.status,
    kind: res.status === 401 ? 'credential_rejected' : 'http',
  });
}

function classify(err: unknown): { kind: string; hint?: string } | undefined {
  if (err instanceof HelloFreshSessionError) return { kind: 'session_expired', hint: err.hint };
  if (err instanceof HelloFreshBridgeError) return { kind: 'bridge', hint: err.hint };
  if (errorKindOf(err) === 'credential_rejected') return { kind: 'credential_rejected', hint: signInHint() };
  return undefined;
}

export function registerHealthcheckTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'hf_healthcheck',
    {
      description:
        'Check the HelloFresh connection end to end: the ContextMint Bridge link to your signed-in ' +
        'www.hellofresh.com tab (which holds the session), the session token (minutes to expiry, and a warning ' +
        'if a refreshed session could not be written back to the browser), and a probe of the HelloFresh ' +
        'subscriptions endpoint that returns only its status. Call it when another hf_ tool fails, to learn ' +
        'which hop broke (bridge, sign-in, or HelloFresh itself).',
      annotations: toolAnnotations({ title: 'HelloFresh: healthcheck', readOnly: true, idempotent: true, openWorld: true }),
      inputSchema: z.object({}),
    },
    async () => {
      // Lazy, like transport.ts: the fetchproxy subpath eagerly loads @fetchproxy/server.
      const { runBridgeHealthcheck } = await import('@chrischall/mcp-utils/fetchproxy');
      const raw = await runBridgeHealthcheck({
        server,
        prefix: 'hf',
        hostLabel: HOST_LABEL,
        probePath: PROBE_PATH,
        transport: await deps.bridge.healthTransport(),
        probeFn: () => probe(deps),
        classifyThrown: classify,
      });
      const result = JSON.parse(raw.content[0]!.text) as { ok: boolean; hint: string } & Record<string, unknown>;
      const minutes = deps.session.expiresInMinutes();
      const warning = deps.session.warning();
      result['session'] = {
        ...(minutes !== undefined ? { expires_in_minutes: minutes } : {}),
        ...(warning !== undefined ? { warning } : {}),
      };
      if (result.ok && warning !== undefined) result.hint = warning;
      return minifiedResult(result);
    },
  );
}
