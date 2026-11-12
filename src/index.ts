#!/usr/bin/env node
import { runMcp } from '@chrischall/mcp-utils';
import { HelloFreshClient } from './client.js';
import { readWsPort } from './config.js';
import { TOOL_REGISTRARS, type ToolDeps } from './tools/index.js';
import { createProfileStore } from './profiles.js';
import { HelloFreshSession } from './session.js';
import { createSessionCache } from './session-cache.js';
import { createHelloFreshBridge } from './transport.js';
import { VERSION } from './version.js';

// The bridge bootstraps the session: it reads (and refreshes) the apiV2Auth
// cookie through the signed-in www.hellofresh.com tab. Every API call is a
// plain Node fetch with a Bearer token — except the price calculator, which
// Cloudflare refuses from Node, so it runs as an in-tab fetch (`tabFetch`).
const bridge = createHelloFreshBridge({ port: readWsPort(), version: VERSION });
// start() loads the fetchproxy identity (no port bind — that is lazy). A
// failure is NOT fatal: the next use retries the start (and throws its error
// if it still fails), so the server still boots and answers tools/list.
await bridge.start().catch(() => {});

// Built ONCE, outside the registrars (runMcp builds a server per connection).
// Nothing here resolves a credential at boot (deferred-config-error pattern).
const fetchImpl: typeof fetch = (input, init) => fetch(input, init);
// The session survives a restart through a 0600 file (HELLOFRESH_SESSION_FILE;
// HELLOFRESH_SESSION_CACHE=false keeps it in memory only). Opening it touches no disk.
const session = new HelloFreshSession({ bridge, fetchImpl, persistence: createSessionCache() });
const deps: ToolDeps = {
  bridge,
  session,
  fetchImpl,
  client: new HelloFreshClient({ session, fetchImpl, tabFetch: (req) => bridge.fetchInTab(req) }),
  // Planner profiles load on first use: a malformed config is a tool error, never a boot failure.
  profiles: createProfileStore(),
};

await runMcp({
  name: 'hellofresh-mcp',
  version: VERSION,
  deps,
  tools: [...TOOL_REGISTRARS],
  shutdown: { onSignal: () => bridge.close() },
  banner:
    '[hellofresh-mcp] Unofficial HelloFresh (US) MCP. HelloFresh has no public API for this; it uses the web app\'s ' +
    'internal one and may break or violate their ToS. Developed and maintained by AI (Claude). Use at your own discretion.',
});
