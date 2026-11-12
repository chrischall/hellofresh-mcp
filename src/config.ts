// Environment config. Read lazily so the server always boots.

import { readPortEnv, type EnvSource } from '@chrischall/mcp-utils';

/** The fleet-wide ContextMint Bridge concentrator port — never change it. */
export const DEFAULT_WS_PORT = 37_149;

/** `HELLOFRESH_WS_PORT`, defaulting to the shared concentrator port. */
export function readWsPort(env: EnvSource = process.env): number {
  return readPortEnv('HELLOFRESH_WS_PORT', DEFAULT_WS_PORT, { env });
}
