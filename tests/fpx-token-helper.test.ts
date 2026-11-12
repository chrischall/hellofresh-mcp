/**
 * skills/hellofresh-fpx/scripts/hf-token.mjs — the fpx skill's token helper —
 * EXECUTED (not just read): it must decode the cookie exactly as the server
 * does, encode a refreshed set exactly as the site does (so the write-back
 * keeps the browser signed in), and never print a token value. Synthetic
 * tokens only.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeAuthCookie, encodeAuthCookie, type AuthTokenSet } from '../src/session.js';

const SCRIPT = new URL('../skills/hellofresh-fpx/scripts/hf-token.mjs', import.meta.url).pathname;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'hf-token-'));
  dirs.push(d);
  return d;
}

function run(cmd: string, dir?: string) {
  const r = spawnSync('node', [SCRIPT, cmd, ...(dir ? [dir] : [])], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const nowS = () => Math.floor(Date.now() / 1000);

function tokenSet(over: Partial<AuthTokenSet> = {}): AuthTokenSet {
  return {
    access_token: 'synthetic-access-token-aaaa',
    expires_in: 1800,
    refresh_token: 'synthetic-refresh-token-bbbb',
    token_type: 'Bearer',
    user_data: { id: '00000000-0000-4000-8000-000000000000', email: 'someone@example.com', country: 'US' },
    refresh_expires_in: 5184000,
    issued_at: nowS(),
    ...over,
  };
}

const SECRETS = ['synthetic-access-token', 'synthetic-refresh-token', 'fresh-access', 'fresh-refresh'];
const noSecrets = (text: string) => SECRETS.filter((s) => text.includes(s));

describe('hf-token.mjs load', () => {
  it('decodes the fpx cookie read into auth.json + a curl header file (mode 600), printing no token', () => {
    const dir = tempDir();
    const set = tokenSet();
    writeFileSync(join(dir, 'cookie.json'), JSON.stringify({ apiV2Auth: encodeAuthCookie(set) }));
    const r = run('load', dir);
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8'))).toEqual(set);
    expect(readFileSync(join(dir, 'auth.header'), 'utf8')).toBe(`Authorization: Bearer ${set.access_token}\n`);
    expect(statSync(join(dir, 'auth.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'auth.header')).mode & 0o777).toBe(0o600);
    expect(r.out).toBe('');
    expect(noSecrets(r.err)).toEqual([]);
    expect(r.err).toMatch(/valid for (29|30) min/);
  });

  it('says the token has expired (refresh or reload the tab) without failing', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'cookie.json'), JSON.stringify({ apiV2Auth: encodeAuthCookie(tokenSet({ issued_at: nowS() - 7200 })) }));
    const r = run('load', dir);
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/expired/);
  });

  it('a missing or empty cookie (signed out) exits 4 with the sign-in remedy', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'cookie.json'), JSON.stringify({}));
    const r = run('load', dir);
    expect(r.code).toBe(4);
    expect(r.err).toMatch(/sign in at https:\/\/www\.hellofresh\.com/i);
  });
});

describe('hf-token.mjs store', () => {
  it('stores a refreshed set and encodes the write-back cookie exactly as the site does', () => {
    const dir = tempDir();
    const old = tokenSet({ issued_at: nowS() - 7200 });
    writeFileSync(join(dir, 'auth.json'), JSON.stringify(old));
    // The refresh response: same shape, rotated tokens; user_data may be absent.
    const fresh = { access_token: 'fresh-access', expires_in: 1800, refresh_token: 'fresh-refresh', token_type: 'Bearer', refresh_expires_in: 5184000, issued_at: nowS() };
    writeFileSync(join(dir, 'refreshed.json'), JSON.stringify(fresh));
    const r = run('store', dir);
    expect(r.code).toBe(0);
    expect(r.out).toBe('');
    expect(noSecrets(r.err)).toEqual([]);
    const stored = JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8')) as AuthTokenSet;
    expect(stored).toEqual({ ...fresh, user_data: old.user_data });
    const cookie = readFileSync(join(dir, 'cookie.txt'), 'utf8');
    expect(cookie).toBe(encodeAuthCookie(stored));
    expect(decodeAuthCookie(cookie)).toEqual(stored);
    expect(readFileSync(join(dir, 'auth.header'), 'utf8')).toBe('Authorization: Bearer fresh-access\n');
    expect(statSync(join(dir, 'cookie.txt')).mode & 0o777).toBe(0o600);
  });

  it('stamps issued_at when the response has none', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'auth.json'), JSON.stringify(tokenSet()));
    writeFileSync(join(dir, 'refreshed.json'), JSON.stringify({ access_token: 'fresh-access', expires_in: 1800, refresh_token: 'fresh-refresh' }));
    expect(run('store', dir).code).toBe(0);
    const stored = JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8')) as AuthTokenSet;
    expect(Math.abs(stored.issued_at - nowS())).toBeLessThanOrEqual(5);
  });

  it('an error body (invalid_grant) exits 4, names only the error code, and keeps the old files', () => {
    const dir = tempDir();
    const old = tokenSet();
    writeFileSync(join(dir, 'auth.json'), JSON.stringify(old));
    writeFileSync(join(dir, 'refreshed.json'), JSON.stringify({ error: 'invalid_grant' }));
    const r = run('store', dir);
    expect(r.code).toBe(4);
    expect(r.err).toMatch(/invalid_grant/);
    expect(r.err).toMatch(/sign in/i);
    expect(JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8'))).toEqual(old);
  });
});

describe('hf-token.mjs usage', () => {
  it('no command or no directory exits 64', () => {
    expect(run('nope').code).toBe(64);
    expect(run('load').code).toBe(64);
  });
});
