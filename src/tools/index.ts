// The one list of tool registrars. `src/index.ts` registers exactly these, and
// the manifest-roster and annotation tests drive the same list, so a registrar
// can never be wired into the server but missed by the tests (or vice versa).

import type { McpServer } from '@modelcontextprotocol/server';
import type { HelloFreshClient } from '../client.js';
import type { HelloFreshSession } from '../session.js';
import type { HelloFreshBridge } from '../transport.js';
import type { LoadedProfiles } from '../profiles.js';
import { registerCookingTools } from './cooking.js';
import { registerFavoriteTools } from './favorites.js';
import { registerHealthcheckTool } from './healthcheck.js';
import { registerPlannerTools } from './planner.js';
import { registerPromoTools } from './promo.js';
import { registerReadTools } from './reads.js';
import { registerWriteTools } from './writes/index.js';

/** The dependencies every registrar receives (built once, outside the registrars). */
export interface ToolDeps {
  bridge: HelloFreshBridge;
  /** The token lifecycle (bridge cookie read, Node refresh, write-back, 401 replay). */
  session: HelloFreshSession;
  /** The fetch every API call uses (the global fetch in production; a mock in tests). */
  fetchImpl: typeof fetch;
  /** The HelloFresh API client (built on `session` + `fetchImpl`). */
  client: HelloFreshClient;
  /** The clock (epoch ms) — "this week" for hf_recent_picks, the cutoff check for writes. Defaults to Date.now. */
  now?: () => number;
  /** Wait `ms` (the re-read back-off after a write). Defaults to a timer; tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
  /** The planner profiles (loaded once, on first use). Defaults to a store over the env / profiles file / built-ins. */
  profiles?: () => LoadedProfiles;
}

export type ToolRegistrar = (server: McpServer, deps: ToolDeps) => void;

export const TOOL_REGISTRARS: readonly ToolRegistrar[] = [
  registerHealthcheckTool,
  registerReadTools,
  registerWriteTools,
  registerPlannerTools,
  registerCookingTools,
  registerFavoriteTools,
  registerPromoTools,
];
