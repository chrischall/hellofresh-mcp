import type { McpServer } from '@modelcontextprotocol/server';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import { HelloFreshClient } from '../src/client.js';
import { HelloFreshSession } from '../src/session.js';
import { TOOL_REGISTRARS, type ToolDeps } from '../src/tools/index.js';

/** Registration-only deps: a bridge that refuses everything, so nothing can reach the network. */
export function offlineDeps(): ToolDeps {
  const offline = () => Promise.reject(new Error('offline'));
  const bridge = {
    start: offline,
    close: async () => {},
    readAuthCookie: offline,
    writeAuthCookie: offline,
    fetchInTab: offline,
    healthTransport: offline,
  };
  const fetchImpl = offline as unknown as typeof fetch;
  const session = new HelloFreshSession({ bridge, fetchImpl });
  return { bridge, session, fetchImpl, client: new HelloFreshClient({ session, fetchImpl }) };
}

export interface ListedTool {
  name: string;
  description?: string;
  annotations?: { readOnlyHint?: unknown; destructiveHint?: unknown; openWorldHint?: unknown; title?: unknown };
  _meta?: { mint?: Record<string, unknown> };
}

/** The tools the REAL registrar list serves (the same list src/index.ts registers). */
export async function registeredTools(): Promise<ListedTool[]> {
  const deps = offlineDeps();
  const harness = await createTestHarness((server: McpServer) => {
    for (const register of TOOL_REGISTRARS) register(server, deps);
  });
  try {
    return (await harness.client.listTools()).tools as ListedTool[];
  } finally {
    await harness.close();
  }
}
