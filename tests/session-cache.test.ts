import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSessionCache,
  sessionCachePath,
} from '../src/session-cache.js';
import { toPersistedSession, type AuthTokenSet } from '../src/session.js';

// Synthetic values only.
const SET: AuthTokenSet = {
  access_token: 'access-AAA',
  expires_in: 1800,
  refresh_token: 'refresh-RRR',
  token_type: 'Bearer',
  user_data: { id: '00000000-0000-4000-8000-000000000000', email: 'someone@example.com' },
  refresh_expires_in: 5_184_000,
  issued_at: 1_800_000_000,
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hf-session-cache-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('sessionCachePath', () => {
  it('HELLOFRESH_SESSION_FILE wins', () => {
    expect(sessionCachePath({ HELLOFRESH_SESSION_FILE: join(dir, 'x.json'), HOME: '/h' })).toBe(join(dir, 'x.json'));
  });

  it('else <MCP_DATA_DIR>/.hellofresh-mcp/session.json (the hosted data dir)', () => {
    expect(sessionCachePath({ MCP_DATA_DIR: dir, HOME: '/h' })).toBe(join(dir, '.hellofresh-mcp', 'session.json'));
  });

  it('else under HOME', () => {
    expect(sessionCachePath({ HOME: dir })).toBe(join(dir, '.hellofresh-mcp', 'session.json'));
  });
});

describe('toPersistedSession', () => {
  it('drops user_data (customer id + email never reach disk)', () => {
    const rec = toPersistedSession(SET, { own: true, writtenBack: false });
    expect(rec.set).not.toHaveProperty('user_data');
    expect(rec).toMatchObject({ own: true, writtenBack: false, set: { access_token: 'access-AAA', refresh_token: 'refresh-RRR' } });
    expect(SET.user_data).toBeDefined();
  });
});

describe('createSessionCache', () => {
  const env = () => ({ HELLOFRESH_SESSION_FILE: join(dir, 'session.json') });

  it('round-trips a record through a 0600 file', () => {
    const cache = createSessionCache(env())!;
    expect(cache.load()).toBeNull();
    cache.save(toPersistedSession(SET, { own: false, writtenBack: false }));
    expect(cache.load()).toEqual({ set: { ...SET, user_data: undefined }, own: false, writtenBack: false });
    expect(statSync(join(dir, 'session.json')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, 'session.json'), 'utf8')).not.toContain('someone@example.com');
    cache.clear();
    expect(cache.load()).toBeNull();
  });

  it('offers a cross-process lock', async () => {
    const cache = createSessionCache(env())!;
    await expect(cache.withLock!(async () => 7)).resolves.toBe(7);
  });

  it('rejects a record that is not a session (corrupt, or another format in the file)', () => {
    const cache = createSessionCache(env())!;
    for (const bad of [
      '{"accessToken":"x"}',
      '{"set":{"access_token":"a"},"own":false,"writtenBack":false}',
      '{"set":{"access_token":"a","refresh_token":"r","issued_at":1,"expires_in":1},"own":"yes","writtenBack":false}',
      '{"set":{"access_token":"a","refresh_token":"r","expires_in":1},"own":true,"writtenBack":false}',
      'not json',
      'null',
    ]) {
      writeFileSync(join(dir, 'session.json'), bad);
      expect(cache.load()).toBeNull();
    }
  });

  it('an unexpanded .mcpb placeholder means "unset" (default path, cache on)', () => {
    const env = {
      HOME: dir,
      HELLOFRESH_SESSION_FILE: '${user_config.session_file}',
      HELLOFRESH_SESSION_CACHE: '${user_config.session_cache}',
    };
    expect(sessionCachePath(env)).toBe(join(dir, '.hellofresh-mcp', 'session.json'));
    expect(createSessionCache(env)).not.toBeNull();
  });

  it('HELLOFRESH_SESSION_CACHE=false turns it off', () => {
    expect(createSessionCache({ ...env(), HELLOFRESH_SESSION_CACHE: 'false' })).toBeNull();
    expect(createSessionCache({ ...env(), HELLOFRESH_SESSION_CACHE: '0' })).toBeNull();
  });
});
