import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../src/version.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const readText = (p: string) => readFileSync(join(ROOT, p), 'utf8');

// These only fail once a tag exists (npm provenance validates repository.url,
// the registry validates the scoped name), so assert them up front.
describe('packaging', () => {
  const pkg = read('package.json');

  it('publishes under the @chrischall scope, publicly, with a provenance-checkable repository.url', () => {
    expect(pkg.name).toBe('@chrischall/hellofresh-mcp');
    expect(pkg.publishConfig?.access).toBe('public');
    expect(pkg.repository?.url).toBe('git+https://github.com/chrischall/hellofresh-mcp.git');
  });

  it('ships dist, skills, the plugin, manifests and mint.yaml in the published tarball', () => {
    for (const f of ['dist', 'skills', '.claude-plugin', '.mcp.json', 'manifest.json', 'server.json', 'mint.yaml']) {
      expect(pkg.files).toContain(f);
    }
  });

  it('denies install scripts for esbuild and fsevents', () => {
    expect(pkg.allowScripts).toEqual({ esbuild: false, fsevents: false });
  });

  it('mint.yaml is bridge-based: no per-user credential fields', () => {
    expect(readText('mint.yaml')).not.toMatch(/perUserChild/);
  });

  it('exposes a single unscoped bin pointing at the tsc entry', () => {
    expect(pkg.bin).toEqual({ 'hellofresh-mcp': 'dist/index.js' });
  });

  it('the Claude plugin launches the published package, not the gitignored dist/', () => {
    const server = read('.mcp.json').mcpServers.hellofresh;
    expect(server.command).toBe('npx');
    expect(server.args).toEqual(['-y', pkg.name]);
    expect(JSON.stringify(server)).not.toMatch(/dist\//);
  });

  it('plugin.json declares its MCP config under mcpServers, the key Claude Code reads', () => {
    // Claude Code ignores an `mcp` key ("Unknown field"); it only appeared to
    // work because ./.mcp.json is also the default location.
    const plugin = read('.claude-plugin/plugin.json');
    expect(plugin).not.toHaveProperty('mcp');
    expect(plugin.mcpServers).toBe('./.mcp.json');
    expect(plugin.skills).toBe('./skills/');
    expect(existsSync(join(ROOT, plugin.mcpServers))).toBe(true);
  });

  it('server.json description is within the 100-char registry limit', () => {
    expect(read('server.json').description.length).toBeLessThanOrEqual(100);
  });

  it('server.json and release-please name the scoped package', () => {
    expect(read('server.json').packages[0].identifier).toBe(pkg.name);
    expect(read('release-please-config.json').packages['.']['package-name']).toBe(pkg.name);
  });

  it('a brand-new package starts at 0.1.0, not 1.0.0, and stays 0.x on breaking changes', () => {
    // Config only — never pin the manifest version here: release PRs bump it.
    const cfg = read('release-please-config.json').packages['.'];
    expect(cfg['initial-version']).toBe('0.1.0');
    expect(cfg['bump-minor-pre-major']).toBe(true);
  });

  it('release-please bumps every version-bearing file', () => {
    const extra = read('release-please-config.json').packages['.']['extra-files'] as (
      | string
      | { path: string; jsonpath: string }
    )[];
    const keys = extra.map((e) => (typeof e === 'string' ? e : `${e.path}#${e.jsonpath}`));
    expect(keys).toEqual(
      expect.arrayContaining([
        'manifest.json#$.version',
        'server.json#$.version',
        'server.json#$.packages[*].version',
        '.claude-plugin/plugin.json#$.version',
        '.claude-plugin/marketplace.json#$.plugins[*].version',
        '.claude-plugin/marketplace.json#$.metadata.version',
        'src/version.ts',
      ]),
    );
  });

  it('all version-bearing manifests agree with package.json', () => {
    const v = pkg.version;
    expect(VERSION).toBe(v);
    expect(read('manifest.json').version).toBe(v);
    expect(read('server.json').version).toBe(v);
    expect(read('server.json').packages[0].version).toBe(v);
    expect(read('.claude-plugin/plugin.json').version).toBe(v);
    expect(read('.claude-plugin/marketplace.json').metadata.version).toBe(v);
    expect(read('.claude-plugin/marketplace.json').plugins[0].version).toBe(v);
    expect(read('.release-please-manifest.json')['.']).toBe(v);
  });

  it('mint.yaml keeps the bridge identity across restarts and declares the env it reads', () => {
    const mint = readText('mint.yaml');
    expect(mint).toMatch(/slug: hellofresh\n/);
    expect(mint).toMatch(/dataDir:\s*true/);
    for (const name of ['HELLOFRESH_WS_PORT', 'HELLOFRESH_DEBUG', 'MCP_CONFIRM_MODE', 'MCP_CONFIRM_ELICITATION']) {
      expect(mint, name).toMatch(new RegExp(`- name: ${name}\\n`));
    }
    // The process dials only the HelloFresh API host (www.hellofresh.com).
    expect(mint).toMatch(/^egress:\n\s+allow:\n\s+- www\.hellofresh\.com\n/m);
  });

  it('the .mcpb exposes every env var mint.yaml declares as an optional user_config setting', () => {
    const manifest = read('manifest.json');
    const env = manifest.server.mcp_config.env as Record<string, string>;
    const declared = [...readText('mint.yaml').matchAll(/^ {2}- name: (\w+)$/gm)].map((m) => m[1]!);
    expect(declared.length).toBeGreaterThan(0);
    expect(Object.keys(env).sort()).toEqual([...declared].sort());
    for (const [name, value] of Object.entries(env)) {
      const key = /^\$\{user_config\.(\w+)\}$/.exec(value)?.[1];
      expect(key, name).toBeDefined();
      const setting = manifest.user_config[key!];
      expect(setting, `${name} → user_config.${key}`).toBeDefined();
      expect(setting.required, name).toBe(false);
      expect(String(setting.description), name).toMatch(/\S/);
    }
  });

  it('mint.yaml summary fits the catalog limit (200 UTF-16 units) and ends a sentence', () => {
    // `summary: >-` is a folded scalar: its indented lines join with spaces.
    const block = readText('mint.yaml').match(/^summary: >-\n((?: {2}.*\n)+)/m);
    expect(block, 'summary must be a folded >- scalar').not.toBeNull();
    const summary = block![1]
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .join(' ');
    expect(summary.length).toBeLessThanOrEqual(200);
    expect(summary).toMatch(/[.!?]$/);
  });

  it('the vitest pair is grouped first in dependabot so a major never splits it', () => {
    const dependabot = readText('.github/dependabot.yml');
    const groups = dependabot.slice(dependabot.indexOf('groups:'));
    expect(groups.indexOf('vitest:')).toBeGreaterThan(-1);
    expect(groups.indexOf('vitest:')).toBeLessThan(groups.indexOf('dev-dependencies:'));
    expect(groups).toMatch(/- "@vitest\/coverage-v8"/);
  });
});
