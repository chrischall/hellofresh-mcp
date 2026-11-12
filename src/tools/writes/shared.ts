// The write tools (docs/HELLOFRESH-API.md "Writes" 1–5), each confirm-gated:
//
//   plan    — validate the arguments against a FRESH read (status, cutoff,
//             allowed actions, menu indexes, offered sizes/slots) and build the
//             exact request with the client's own builder, so the preview IS
//             what is sent;
//   gate    — `confirmWrite` (elicitation, or a phase-1 preview + confirmToken);
//   execute — send it, then RE-READ and compare, answering
//             `{status: 'verified' | 'unverified', before, after}` honestly.
//
// A write that was sent and then timed out / dropped / got a 5xx answers
// `status: 'unknown'` (not an error), so the model checks before repeating it.
// Cancelling the subscription and the meal-preference preset are deliberately
// not exposed (see the API doc).
//
// `registerWrite` from mcp-utils cannot carry `_meta`, which the context-group
// hints need, so `registerGated` below is the same plan → confirmWrite →
// execute flow with `_meta`.
//
// This file holds the shared gate (`registerGated`), the send → re-read
// helper and the week/plan checks; `week.ts` and `plan.ts` register the tools.

import { z } from 'zod';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import {
  CONFIRM_FLOW_SENTENCE,
  CONFIRM_INJECTION_RULE,
  McpToolError,
  confirmTokenParam,
  confirmWrite,
  minifiedResult,
  toolAnnotations,
  writeOrUnknown,
  type ConfirmWriteOptions,
} from '@chrischall/mcp-utils';
import type { HelloFreshClient, WriteRequest } from '../../client.js';
import type { ProjectedDelivery, ProjectedMenu } from '../../normalize.js';
import { projectDelivery } from '../../normalize.js';
import type { RawDelivery } from '../../types.js';
import { foodMeta, type MintHint } from '../hints.js';
import { attempt, dateOf, type Account } from '../shared.js';

export type GateFields = Omit<ConfirmWriteOptions, 'tool' | 'confirmToken' | 'args'>;

export interface GatedWrite<Shape extends z.ZodRawShape, State> {
  name: string;
  title: string;
  description: string;
  destructive: boolean;
  meta: { mint: MintHint };
  input: Shape;
  plan(args: z.infer<z.ZodObject<Shape>>): Promise<{ gate: GateFields; state: State }>;
  execute(state: State): Promise<CallToolResult>;
}

export function registerGated<Shape extends z.ZodRawShape, State>(server: McpServer, def: GatedWrite<Shape, State>): void {
  server.registerTool(
    def.name,
    {
      description: `${def.description} ${CONFIRM_FLOW_SENTENCE} ${CONFIRM_INJECTION_RULE}`,
      annotations: toolAnnotations({ title: def.title, readOnly: false, destructive: def.destructive, idempotent: true, openWorld: true }),
      _meta: def.meta,
      inputSchema: z.object({ ...def.input, confirmToken: confirmTokenParam }),
    },
    async (input: Record<string, unknown>, ctx) => {
      const { confirmToken, ...args } = input as { confirmToken?: string } & z.infer<z.ZodObject<Shape>>;
      const { gate, state } = await def.plan(args as z.infer<z.ZodObject<Shape>>);
      const blocked = await confirmWrite(ctx, { ...gate, tool: def.name, confirmToken, args });
      if (blocked) return blocked;
      return def.execute(state);
    },
  );
}

/** A write as `confirmWrite` previews and binds it: the path as sent on www.hellofresh.com. */
export const shown = (w: WriteRequest) => ({ method: w.method, path: `/gw${w.path}`, query: w.query, body: w.body });

export const CHANGE = (aliases: string[]) => foodMeta('change', { aliases });

/**
 * Send `send`, then re-read with `verify`. A send whose outcome is unknown
 * answers `status: 'unknown'`; a re-read that fails answers `unverified` with
 * the reason.
 */
export async function sendAndVerify<After>(opts: {
  send: () => Promise<unknown>;
  verify: () => Promise<{ ok: boolean; after: After; extra?: Record<string, unknown> }>;
  before: unknown;
  checkWith: string;
  mismatch: string;
  extra?: (sent: unknown) => Record<string, unknown>;
}): Promise<CallToolResult> {
  const sent = await writeOrUnknown(opts.send, (_err, reason) =>
    minifiedResult({
      status: 'unknown',
      before: opts.before,
      warning:
        `HelloFresh did not confirm this change (${reason}), so it may already have happened. ` +
        `Check with ${opts.checkWith} before repeating it; do not repeat it blindly.`,
    }),
  );
  if (!sent.ok) return sent.result;
  const extra = opts.extra?.(sent.value) ?? {};
  const check = await attempt(opts.verify);
  if (!check.ok) {
    return minifiedResult({
      status: 'unverified',
      before: opts.before,
      ...extra,
      verifyError: check.reason,
      warning: `HelloFresh accepted the request, but re-reading it failed. Check with ${opts.checkWith}.`,
    });
  }
  return minifiedResult({
    status: check.value.ok ? 'verified' : 'unverified',
    before: opts.before,
    after: check.value.after,
    ...extra,
    ...check.value.extra,
    ...(check.value.ok ? {} : { warning: `${opts.mismatch} Check with ${opts.checkWith} before trying again.` }),
  });
}

// ---- week checks ------------------------------------------------------------------

export type ActionName = 'mealSwap' | 'oneOffChange' | 'pause';

/** The week, refused when its cutoff has passed. */
export async function openWeek(
  client: HelloFreshClient,
  account: Account,
  week: string,
  now: number,
): Promise<{ raw: RawDelivery; delivery: ProjectedDelivery }> {
  const raw = await client.getDelivery(account.subscriptionId, week);
  const delivery = projectDelivery(raw);
  if (delivery.cutoffDate && Date.parse(delivery.cutoffDate) <= now) {
    throw new McpToolError(`The cutoff for ${week} passed at ${delivery.cutoffDate}; HelloFresh no longer accepts changes to it.`);
  }
  return { raw, delivery };
}

/** Refuse a change HelloFresh marks as not allowed for the week. */
export function requireAllowed(raw: RawDelivery, week: string, action: ActionName): void {
  if (raw.allowedActions?.[action] === false) {
    throw new McpToolError(`HelloFresh does not allow this change for ${week} (${action} is not allowed for it).`);
  }
}

/** Refuse a week that is not running (skipped → unskip first). */
export function requireRunning(delivery: ProjectedDelivery, week: string, what: string): void {
  if (delivery.status === 'skipped') {
    throw new McpToolError(`${week} is skipped, so you cannot ${what}. Unskip it first with hf_unskip_week.`);
  }
  if (delivery.status !== 'running') throw new McpToolError(`${week} is ${delivery.status}, so you cannot ${what}.`);
}

/** The SKUs this subscription can switch to; refuses one not among them. */
export async function requireOfferedSku(client: HelloFreshClient, account: Account, sku: string): Promise<void> {
  const options = await client.getProductOptions(account.subscriptionId);
  const offered = (options.items ?? []).flatMap((g) => (g.products ?? []).flatMap((p) => (p.handle ? [p.handle] : [])));
  if (!offered.includes(sku)) {
    throw new McpToolError(`This subscription cannot switch to ${sku}. Sizes offered: ${offered.join(', ')}.`, {
      hint: 'hf_list_box_sizes lists them as meals × people.',
    });
  }
}

/** Re-reads after a one-week size change before calling it unverified, and the wait between them. */
export const SIZE_VERIFY_READS = 3;
export const SIZE_VERIFY_DELAY_MS = 1500;

export const skuOf = (meals: number, people: number) => `US-CBU-${meals}-${people}-0`;

export const boxOf = (d: Pick<ProjectedDelivery, 'sku' | 'meals' | 'servings' | 'deliveryOption'>) => ({
  sku: d.sku,
  meals: d.meals,
  people: d.servings,
  deliveryOption: d.deliveryOption,
});

export const peopleParam = z
  .union([z.literal(2), z.literal(3), z.literal(4), z.literal(6)])
  .describe('People (servings per meal): 2, 3, 4 or 6.');

export const mealsCountParam = (what: string) => z.number().int().min(1).max(6).describe(`Meals per week ${what}.`);

export const SLOT = /^US-[1-7]-\d{4}-\d{4}$/;

/** Every index on the menu (base courses and their protein swaps) → its name. */
export function namesOf(menu: ProjectedMenu): Map<number, string | undefined> {
  const names = new Map<number, string | undefined>();
  for (const m of menu.meals) {
    names.set(m.index, m.name);
    for (const v of m.variants) names.set(v.index, v.name ?? v.title);
  }
  return names;
}

export const slotOf = (d: ProjectedDelivery) => ({ deliveryOption: d.deliveryOption, deliveryDate: dateOf(d.deliveryDate), sku: d.sku });
