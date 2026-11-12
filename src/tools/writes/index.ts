// The write tools, registered in roster order: the one-week writes, then the
// permanent plan writes. See `shared.ts` for the confirm-gated flow they share.

import type { McpServer } from '@modelcontextprotocol/server';
import type { ToolDeps } from '../index.js';
import { registerPlanWrites } from './plan.js';
import { registerWeekWrites } from './week.js';

export { SIZE_VERIFY_DELAY_MS, SIZE_VERIFY_READS } from './shared.js';

export function registerWriteTools(server: McpServer, deps: ToolDeps): void {
  registerWeekWrites(server, deps);
  registerPlanWrites(server, deps);
}
