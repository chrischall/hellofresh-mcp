/**
 * The docs that ship with the package must stay in step with the code: the
 * MCP-usage skill names exactly the registered tools and carries the weekly
 * flow; the fpx skill keeps the token off stdout and covers every read; the
 * README is a real setup guide; every env var mint.yaml declares is documented
 * in the README, server.json and manifest.json.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { registeredTools } from './helpers.js';

const url = (p: string) => new URL(`../${p}`, import.meta.url);
const read = (p: string) => readFileSync(url(p), 'utf8');

const registeredNames = async () => (await registeredTools()).map((t) => t.name);

/** Every `hf_`-prefixed identifier in a text. */
const hfNames = (text: string) => new Set(text.match(/\bhf_[a-z_]+\b/g) ?? []);

describe('skills/hellofresh/SKILL.md (the MCP-usage skill)', () => {
  const path = 'skills/hellofresh/SKILL.md';

  it('exists with name + description frontmatter', () => {
    expect(existsSync(url(path))).toBe(true);
    expect(read(path)).toMatch(/^---\nname: hellofresh\ndescription: .+\n---\n/);
  });

  it('names every registered tool, and no tool that is not registered', async () => {
    const text = read(path);
    const registered = await registeredNames();
    expect(registered.filter((n) => !text.includes(`\`${n}\``))).toEqual([]);
    expect([...hfNames(text)].filter((n) => !registered.includes(n))).toEqual([]);
  });

  it('carries the generic weekly flow: choose a profile, unclear and holiday weeks, a Monday reminder', () => {
    const text = read(path);
    expect(text).toMatch(/which profile applies/i);
    expect(text).toMatch(/unclear/i);
    expect(text).toMatch(/holiday/i);
    expect(text).toMatch(/Monday/);
    expect(text).toContain('hf_weekly_plan` `{week, profile}');
  });

  it('documents the profiles config with a generic example', () => {
    const text = read(path);
    expect(text).toContain('HELLOFRESH_PROFILES');
    expect(text).toContain('HELLOFRESH_PROFILES_FILE');
    expect(text).toContain('~/.config/hellofresh-mcp/profiles.json');
    expect(text).toMatch(/"premiumCapCents"/);
  });

  it('explains the confirmation flow and what is deliberately not exposed', () => {
    const text = read(path);
    expect(text).toMatch(/confirmToken/);
    expect(text).toMatch(/verified/);
    expect(text).toMatch(/cancel/i);
  });

  it('has an "In context groups" section naming the group, the canonical read and the browser caveat', () => {
    const text = read(path);
    const section = text.split(/^## In context groups$/m)[1]?.split(/^## /m)[0] ?? '';
    expect(section, 'missing "## In context groups"').not.toBe('');
    expect(section).toMatch(/\bfood\b/);
    expect(section).toContain('`hf_list_deliveries`');
    expect(section).toMatch(/what's on|whats-on/i);
    expect(section).toMatch(/browser/i);
  });

  it('"In context groups" states each tool’s intent exactly as tests/hints.test.ts declares it', () => {
    const section = read(path).split(/^## In context groups$/m)[1]?.split(/^## /m)[0] ?? '';
    const hints = read('tests/hints.test.ts');
    const declared = [...hints.matchAll(/^ {2}(hf_[a-z_]+): '([a-z-]+)',$/gm)].map((m) => [m[1]!, m[2]!] as const);
    expect(declared.length).toBeGreaterThan(10);
    const byIntent = new Map<string, string[]>();
    for (const [tool, intent] of declared) byIntent.set(intent, [...(byIntent.get(intent) ?? []), tool]);
    for (const [intent, tools] of byIntent) {
      const line = section.split('\n').find((l) => l.includes(`**${intent}**`));
      expect(line, `no line for intent ${intent}`).toBeDefined();
      const named = [...(line!.match(/`hf_[a-z_]+`/g) ?? [])].map((t) => t.slice(1, -1)).sort();
      expect(named, intent).toEqual([...tools].sort());
    }
  });
});

describe('skills/hellofresh-fpx (the shell tier)', () => {
  const skill = 'skills/hellofresh-fpx/SKILL.md';
  const requests = 'skills/hellofresh-fpx/references/requests.md';

  it('exists with name + description frontmatter, and a requests reference', () => {
    expect(read(skill)).toMatch(/^---\nname: hellofresh-fpx\ndescription: .+\n---\n/);
    expect(existsSync(url(requests))).toBe(true);
  });

  it('declares the profile and its full scope before pairing', () => {
    const text = read(skill);
    expect(text).toContain('fpx profile add hellofresh --domain hellofresh.com');
    expect(text).toMatch(/fpx profile declare hellofresh .*--cookie apiV2Auth/);
    expect(text).toMatch(/fpx profile declare hellofresh .*--allow-cookie-write/);
  });

  it('reads the token cookie from www INTO A FILE, never to stdout', () => {
    const all = `${read(skill)}\n${read(requests)}`;
    const reads = all.split('\n').filter((l) => /fpx cookies\b/.test(l) && !l.trimStart().startsWith('|'));
    expect(reads.length).toBeGreaterThan(0);
    for (const line of reads) {
      expect(line).toContain('--storage-subdomain www');
      expect(line, line).toMatch(/>\s*"?\$/);
    }
    expect(all).not.toMatch(/fpx cookies[^\n]*\|/);
  });

  it('notes the second-browser pair code', () => {
    expect(read(skill)).toMatch(/second browser|more than one browser/i);
    expect(read(skill)).toMatch(/trust clear/);
  });

  it('has a curl recipe for every documented read, plus refresh and write-back', () => {
    const text = read(requests);
    for (const path of [
      '/api/customers/me/subscriptions',
      '/api/subscriptions/',
      '/api/customers/me/deliveries',
      '/delivery_dates/',
      '/product_options',
      '/api/plans',
      '/menus-service/weeks',
      '/my-deliveries/menu',
      '/gw/refresh',
    ]) {
      expect(text, path).toContain(path);
    }
    expect(text).toMatch(/fpx write-cookies apiV2Auth=@/);
    expect(text).toMatch(/\bjq\b/);
  });

  it('keeps the bearer off argv: curl reads the Authorization header from a file', () => {
    const text = read(requests);
    expect(text).not.toMatch(/-H ['"]Authorization: Bearer \$/);
    expect(text).toMatch(/-H @/);
  });
});

describe('README', () => {
  const readme = () => read('README.md');

  it('is a setup guide: bridge install, sign-in, pair code; no work-in-progress note', () => {
    const text = readme();
    expect(text).toMatch(/ContextMint Bridge/);
    expect(text).toMatch(/hellofresh\.com/);
    expect(text).toMatch(/pair code/i);
    expect(text).not.toMatch(/work in progress/i);
  });

  it('links the skills and the API notes', () => {
    const text = readme();
    expect(text).toContain('skills/hellofresh/');
    expect(text).toContain('skills/hellofresh-fpx/');
    expect(text).toContain('docs/HELLOFRESH-API.md');
  });
});

describe('CLAUDE.md', () => {
  it('exists and carries only what is true of this repo', () => {
    const text = read('CLAUDE.md');
    expect(text).toMatch(/hellofresh/i);
    expect(text).toMatch(/apiV2Auth/);
    expect(text).not.toMatch(/fleet-wide convention/i);
    expect(text).not.toMatch(/auto-review follow-ups?/i);
  });
});

describe('env var docs', () => {
  const mintEnv = [...read('mint.yaml').matchAll(/^ {2}- name: ([A-Z_]+)$/gm)].map((m) => m[1]);

  it('mint.yaml declares the env the server reads', () => {
    expect(mintEnv).toEqual(
      expect.arrayContaining([
        'HELLOFRESH_WS_PORT',
        'HELLOFRESH_DEBUG',
        'MCP_CONFIRM_MODE',
        'MCP_CONFIRM_ELICITATION',
        'HELLOFRESH_PROFILES',
        'HELLOFRESH_PROFILES_FILE',
      ]),
    );
  });

  it('the README configuration table names every mint.yaml env var', () => {
    const text = read('README.md');
    expect(mintEnv.filter((n) => !text.includes(`\`${n}\``))).toEqual([]);
  });

  it('server.json declares every mint.yaml env var', () => {
    const server = JSON.parse(read('server.json')) as {
      packages: { environmentVariables: { name: string }[] }[];
    };
    const declared = server.packages[0].environmentVariables.map((e) => e.name);
    expect(mintEnv.filter((n) => !declared.includes(n))).toEqual([]);
  });

  it('manifest.json passes every mint.yaml env var from a user_config setting', () => {
    const manifest = JSON.parse(read('manifest.json')) as {
      server: { mcp_config: { env: Record<string, string> } };
      user_config: Record<string, unknown>;
    };
    const env = manifest.server.mcp_config.env;
    expect(mintEnv.filter((n) => !(n in env))).toEqual([]);
    for (const [name, value] of Object.entries(env)) {
      const key = /^\$\{user_config\.([a-z_]+)\}$/.exec(value)?.[1];
      expect(key, name).toBeDefined();
      expect(manifest.user_config, name).toHaveProperty(key!);
    }
  });

  it('mint.yaml carries examples for reading and for the writes', () => {
    const mint = read('mint.yaml');
    expect((mint.match(/^ {2}- prompt: /gm) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(mint).toMatch(/- prompt: .*\bskip\b/i);
    expect(mint).toMatch(/- prompt: .*\bpick\b/i);
  });
});
