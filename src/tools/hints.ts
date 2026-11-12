// Context-group hints, published on each tool as `_meta.mint` (the mcp-host
// context-groups contract, `mintHintSchema`). Inert data: a host that does not
// read them sees an extra `_meta` key and nothing else. The shape is fixed by
// the host's contract, so it is restated here rather than imported — this
// server takes no dependency on mcp-host.
//
// Every tool but hf_healthcheck sits in the `food` domain. `aliases` are
// lowercase, at most 8, each ≤ 40 chars.

export type MintIntent = 'whats-new' | 'whats-due' | 'whats-on' | 'lookup' | 'turn-on-off' | 'send' | 'change' | 'other';

export interface MintHint {
  domain: 'food';
  intent: MintIntent;
  canonical?: true;
  subject?: string;
  when?: { start: string; end: string };
  aliases?: string[];
}

/** `_meta` for a HelloFresh tool. */
export function foodMeta(intent: MintIntent, extra: Omit<MintHint, 'domain' | 'intent'> = {}): { mint: MintHint } {
  return { mint: { domain: 'food', intent, ...extra } };
}

/** A read of one record or a reference list. */
export const LOOKUP = foodMeta('lookup');
