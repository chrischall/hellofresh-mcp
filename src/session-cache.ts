// Where the HelloFresh session is kept between runs (lifecycle step 6 in
// src/session.ts). One small 0600 JSON file, replaced atomically, with a
// cross-process lock beside it — the fleet's createFileStatePersistence.
//
// It holds the token set WITHOUT `user_data` (the customer id and email). On
// mcp-host it lands in the registration's persistent data dir (MCP_DATA_DIR;
// mint.yaml declares `state.dataDir: true`), elsewhere under $HOME.

import { parseBoolEnv } from '@chrischall/mcp-utils';
import {
  createFileStatePersistence,
  resolveStateFile,
  type SyncStatePersistence,
} from '@chrischall/mcp-utils/session';
import { isTokenSet, type PersistedSession } from './session.js';

type Env = Record<string, string | undefined>;

/** `HELLOFRESH_SESSION_FILE`, else `<MCP_DATA_DIR or HOME>/.hellofresh-mcp/session.json`. */
export function sessionCachePath(env: Env = process.env): string {
  return resolveStateFile({ env, envVar: 'HELLOFRESH_SESSION_FILE', subdir: '.hellofresh-mcp', fileName: 'session.json' });
}

function asPersistedSession(raw: unknown): PersistedSession | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!isTokenSet(r['set']) || typeof r['set'].issued_at !== 'number') return null;
  if (typeof r['own'] !== 'boolean' || typeof r['writtenBack'] !== 'boolean') return null;
  return { set: r['set'], own: r['own'], writtenBack: r['writtenBack'] };
}

/** The session store, or `null` when `HELLOFRESH_SESSION_CACHE` turns it off. */
export function createSessionCache(env: Env = process.env): SyncStatePersistence<PersistedSession> | null {
  if (!parseBoolEnv('HELLOFRESH_SESSION_CACHE', { env, default: true })) return null;
  return createFileStatePersistence<PersistedSession>({
    filePath: sessionCachePath(env),
    validate: asPersistedSession,
  });
}
