/**
 * Truthful annotations on every tool, read off the REGISTERED config (the
 * wire), not a hand-kept list. Context-group hints: tests/hints.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { registeredTools } from './helpers.js';

describe('tool annotations', () => {
  it('every tool: hf_ prefix, explicit readOnly, and a searchable description', async () => {
    for (const t of await registeredTools()) {
      expect(t.name).toMatch(/^hf_[a-z_]+$/);
      expect(typeof t.annotations?.readOnlyHint, t.name).toBe('boolean');
      expect(typeof t.annotations?.title, t.name).toBe('string');
      expect(t.description?.length ?? 0, t.name).toBeGreaterThan(40);
      // Local-only tools (the healthcheck probe aside, hf_list_profiles reads local config) are closed-world.
      const local = ['hf_healthcheck', 'hf_list_profiles'];
      if (!local.includes(t.name)) expect(t.annotations?.openWorldHint, t.name).toBe(true);
      if (t.name === 'hf_list_profiles') expect(t.annotations?.openWorldHint).toBe(false);
    }
  });

  it('every non-read sets destructiveHint explicitly; no read claims to destroy', async () => {
    for (const t of await registeredTools()) {
      if (t.annotations?.readOnlyHint === false) expect(typeof t.annotations.destructiveHint, t.name).toBe('boolean');
      else expect(t.annotations?.destructiveHint, t.name).not.toBe(true);
    }
  });
});
