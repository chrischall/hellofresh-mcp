/**
 * Context-group hints (`_meta.mint`, the mcp-host `mintHintSchema` contract),
 * asserted against the SERVED tool list — a new tool cannot skip the decision,
 * because the intent table below is the assertion.
 */

import { describe, expect, it } from 'vitest';
import { registeredTools, type ListedTool } from './helpers.js';

const KEYS = ['domain', 'intent', 'canonical', 'subject', 'when', 'aliases'];
const CANONICAL_INTENTS = ['whats-new', 'whats-due', 'whats-on'];

/** The intent every tool declares (hf_healthcheck joins no group). */
const EXPECTED: Record<string, string> = {
  hf_get_subscription: 'lookup',
  hf_list_deliveries: 'whats-on',
  hf_get_delivery: 'lookup',
  hf_get_menu: 'lookup',
  hf_list_box_sizes: 'lookup',
  hf_recent_picks: 'lookup',
  hf_select_meals: 'change',
  hf_set_week_size: 'change',
  hf_set_week_delivery_day: 'change',
  hf_skip_week: 'change',
  hf_unskip_week: 'change',
  hf_change_plan_size: 'change',
  hf_change_delivery_schedule: 'change',
  hf_list_profiles: 'lookup',
  hf_suggest_meals: 'other',
  hf_weekly_plan: 'other',
  hf_plan_weeks: 'other',
  hf_get_recipe: 'lookup',
  hf_cooking_plan: 'whats-on',
  hf_list_favorites: 'lookup',
  hf_list_ratings: 'lookup',
  hf_favorite_recipe: 'change',
  hf_unfavorite_recipe: 'change',
  hf_promo_status: 'lookup',
};

type Served = ListedTool & { inputSchema: { properties?: Record<string, { enum?: string[] }> } };

const served = async () => (await registeredTools()) as Served[];

describe('context-group hints', () => {
  it('every served tool but the healthcheck is hinted per the contract', async () => {
    const tools = await served();
    expect(tools.find((t) => t.name === 'hf_healthcheck')?._meta?.mint).toBeUndefined();
    const hinted = tools.filter((t) => t.name !== 'hf_healthcheck');
    expect(hinted.map((t) => t.name).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const t of hinted) {
      const m = t._meta?.mint as Record<string, unknown> | undefined;
      expect(m, t.name).toBeDefined();
      expect(Object.keys(m!).filter((k) => !KEYS.includes(k)), t.name).toEqual([]);
      expect(m!.domain, t.name).toBe('food');
      expect(m!.intent, t.name).toBe(EXPECTED[t.name]);
      if (m!.canonical) {
        expect(t.annotations?.readOnlyHint, t.name).toBe(true);
        expect(CANONICAL_INTENTS).toContain(m!.intent);
        expect(t.inputSchema.properties, t.name).toHaveProperty('view');
      }
      // Nothing here is listable per person, and no read takes a date range.
      expect(m!.subject, t.name).toBeUndefined();
      expect(m!.when, t.name).toBeUndefined();
      const aliases = (m!.aliases as string[] | undefined) ?? [];
      expect(aliases.length, t.name).toBeLessThanOrEqual(8);
      for (const a of aliases) {
        expect(a, t.name).toBe(a.toLowerCase());
        expect(a.length, t.name).toBeLessThanOrEqual(40);
      }
    }
  });

  it('hf_list_deliveries is the one canonical read, for whats-on, with a brief view', async () => {
    const canonical = (await served()).filter((t) => t._meta?.mint?.canonical === true);
    expect(canonical.map((t) => t.name)).toEqual(['hf_list_deliveries']);
    expect(canonical[0]._meta?.mint?.intent).toBe('whats-on');
    expect(canonical[0].inputSchema.properties?.view?.enum).toContain('brief');
  });

  it('no write is canonical, and every write is a "change"', async () => {
    for (const t of await served()) {
      if (t.annotations?.readOnlyHint !== false) continue;
      expect(t._meta?.mint?.canonical, t.name).toBeUndefined();
      expect(t._meta?.mint?.intent, t.name).toBe('change');
    }
  });
});
