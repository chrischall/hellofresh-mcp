/**
 * `manifest.json`'s `tools` array is what an `.mcpb` host shows the user — and
 * nothing else reads it, so a tool missing from it is callable by name, boots
 * fine, and is simply never offered. Guard the roster in BOTH directions
 * against the REAL registrars (the same list `src/index.ts` registers), and
 * keep the README's tools table honest the same way.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { registeredTools } from './helpers.js';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('manifest.json')) as {
  tools: { name: string; description: string }[];
} & Record<string, unknown>;

describe('manifest.json tool roster', () => {
  it('lists exactly the registered tools — none missing, none stale', async () => {
    const registered = (await registeredTools()).map((t) => t.name).sort();
    const listed = manifest.tools.map((t) => t.name).sort();
    expect(registered.filter((n) => !listed.includes(n)), 'registered but not in manifest.json').toEqual([]);
    expect(listed.filter((n) => !registered.includes(n)), 'in manifest.json but not registered').toEqual([]);
    expect(new Set(listed).size, 'duplicate manifest entries').toBe(listed.length);
  });

  it('gives every manifest tool a non-blank description', () => {
    expect(manifest.tools.filter((t) => !t.description?.trim()).map((t) => t.name)).toEqual([]);
  });

  it('has no top-level key the mcpb schema would reject', () => {
    // additionalProperties: false — one stray key fails `mcpb pack` outright.
    const allowed = new Set([
      '$schema', 'dxt_version', 'manifest_version', 'name', 'display_name', 'version',
      'description', 'long_description', 'author', 'repository', 'homepage', 'documentation',
      'support', 'icon', 'screenshots', 'server', 'tools', 'tools_generated', 'prompts',
      'prompts_generated', 'keywords', 'license', 'privacy_policies', 'compatibility', 'user_config',
    ]);
    expect(Object.keys(manifest).filter((k) => !allowed.has(k))).toEqual([]);
  });
});

describe('README tools table', () => {
  it('names every registered tool', async () => {
    const readme = read('README.md');
    const missing = (await registeredTools()).map((t) => t.name).filter((n) => !readme.includes(`\`${n}\``));
    expect(missing).toEqual([]);
  });

  // Any `hf_`-prefixed identifier in the README counts as a tool name here.
  it('names no tool that is not registered', async () => {
    const registered = new Set((await registeredTools()).map((t) => t.name));
    const mentioned = new Set(read('README.md').match(/\bhf_[a-z_]+\b/g) ?? []);
    expect([...mentioned].filter((n) => !registered.has(n))).toEqual([]);
  });
});
