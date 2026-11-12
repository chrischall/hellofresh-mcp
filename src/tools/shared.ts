// Shared bits for the hf_ tools: the account context every call starts from
// (the subscription and its plan id), the `week` / `view` parameters, the
// box-number and estimate helpers, and the brief line.

import { z } from 'zod';
import { McpToolError, messageOf, viewParam, type View } from '@chrischall/mcp-utils';
import type { HelloFreshClient } from '../client.js';
import {
  estimateBoxTotal,
  projectDelivery,
  projectMenu,
  type BoxEstimate,
  type ProjectedDelivery,
  type ProjectedMenu,
  type SelectedMeal,
} from '../normalize.js';
import type { RawDeliveryMenu, RawSubscription } from '../types.js';
import { WEEK_PATTERN } from '../weeks.js';

// ---- parameters -----------------------------------------------------------------

export const HF_VIEWS = ['compact', 'full'] as const satisfies readonly View[];

/** The `view` parameter. `note` says what compact leaves out. */
export const hfView = (note: string) => viewParam(HF_VIEWS, { note });

export const weekParam = z
  .string()
  .trim()
  .regex(WEEK_PATTERN, 'an ISO week like 2026-W49')
  .describe('The delivery week as an ISO week, e.g. 2026-W49 (from hf_list_deliveries).');

/**
 * The ASSUMED box number of the next running delivery when HelloFresh says the
 * first box was delivered (or does not say) but not how many boxes since:
 * an established subscription is past its first box. Never used when the
 * first box is not yet delivered — then the next running box is box 1.
 */
export const ASSUMED_NEXT_BOX_NUMBER = 2;

export const nextBoxNumberParam = z
  .number()
  .int()
  .min(1)
  .max(1000)
  .optional()
  .describe(
    'Which box this account’s NEXT running delivery will be, counting every box ever delivered (1 = the first ' +
      'box). The voucher’s discount depends on it. Default: 1 when HelloFresh says the first box is not delivered ' +
      `yet; otherwise an assumed ${ASSUMED_NEXT_BOX_NUMBER} (HelloFresh does not say how many boxes were delivered).`,
  );

// ---- the account ------------------------------------------------------------------

export interface Account {
  subscription: RawSubscription;
  subscriptionId: string;
}

/** The account's subscription: the active one, else the first. */
export async function loadAccount(client: HelloFreshClient): Promise<Account> {
  const items = (await client.listSubscriptions()).items ?? [];
  const subscription = items.find((s) => s.isActive !== false && !s.canceledAt) ?? items[0];
  if (!subscription?.id) {
    throw new McpToolError('This account has no HelloFresh subscription.', {
      hint: 'Check that the browser is signed in to the HelloFresh account that holds the meal-kit plan.',
    });
  }
  return { subscription, subscriptionId: subscription.id };
}

/** Wait `ms` milliseconds (the default ToolDeps.sleep). */
export const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether `week` is the subscription's first box, not yet delivered — HelloFresh will not resize it. */
export function isUnresizableFirstBox(subscription: Pick<RawSubscription, 'firstDeliveryWeek' | 'firstBoxDelivered'>, week: string): boolean {
  return subscription.firstBoxDelivered === false && subscription.firstDeliveryWeek === week;
}

/** The customer plan id the menu read needs: the subscription's, else the plan whose legacy id matches. */
export async function customerPlanIdOf(client: HelloFreshClient, account: Account): Promise<string> {
  if (account.subscription.customerPlanId) return account.subscription.customerPlanId;
  const plans = await client.listPlans();
  const plan = plans.find((p) => p.legacySubscriptionId === account.subscriptionId) ?? plans[0];
  if (!plan?.id) throw new McpToolError('HelloFresh returned no customer plan for this subscription.');
  return plan.id;
}

/** The week's RAW menu for the delivery's box size (recipe ids included). */
export async function readRawMenu(
  client: HelloFreshClient,
  account: Account,
  delivery: Pick<ProjectedDelivery, 'week' | 'sku' | 'servings'>,
  week: string,
): Promise<RawDeliveryMenu> {
  if (!delivery.sku || !delivery.servings) {
    throw new McpToolError(`HelloFresh returned no box size for ${week}, so its menu cannot be read.`);
  }
  const customerPlanId = await customerPlanIdOf(client, account);
  return client.getDeliveryMenu({
    subscriptionId: account.subscriptionId,
    week,
    servings: delivery.servings,
    sku: delivery.sku,
    customerPlanId,
  });
}

/** The week's menu for the delivery's box size. */
export async function readMenu(
  client: HelloFreshClient,
  account: Account,
  delivery: Pick<ProjectedDelivery, 'week' | 'sku' | 'servings'>,
  week: string,
): Promise<ProjectedMenu> {
  return projectMenu(await readRawMenu(client, account, delivery, week));
}

/** One week's picks, as hf_recent_picks lists them. */
export interface WeekPicks {
  week: string;
  status: ProjectedDelivery['status'];
  deliveryDate?: string;
  picks: ReturnType<typeof compactSelection>[];
}

/**
 * The picks of each week, best effort: a skipped week has none (and reads no
 * menu); a week whose delivery or menu cannot be read is listed in
 * `unreadable` with the reason. `recipeNames` are the distinct picked names.
 */
export async function readPicks(
  client: HelloFreshClient,
  account: Account,
  weeks: readonly string[],
): Promise<{ weeks: WeekPicks[]; recipeNames: string[]; unreadable: Array<{ week: string; reason: string }> }> {
  const results = await Promise.all(
    weeks.map(async (week) => {
      const read = await attempt(async () => {
        const delivery = projectDelivery(await client.getDelivery(account.subscriptionId, week));
        if (delivery.status === 'skipped') return { delivery, picks: [] as WeekPicks['picks'] };
        const menu = await readMenu(client, account, delivery, week);
        return { delivery, picks: menu.selected.map(compactSelection) };
      });
      return { week, read };
    }),
  );
  const read = results.flatMap(({ week, read: r }): WeekPicks[] =>
    r.ok ? [{ week, status: r.value.delivery.status, deliveryDate: dateOf(r.value.delivery.deliveryDate), picks: r.value.picks }] : [],
  );
  return {
    weeks: read,
    recipeNames: [...new Set(read.flatMap((w) => w.picks.map((p) => p.name)).filter((n): n is string => !!n))],
    unreadable: results.flatMap(({ week, read: r }) => (r.ok ? [] : [{ week, reason: r.reason }])),
  };
}

// ---- estimates --------------------------------------------------------------------

/** Box number per running week (in week order), starting at `next`; skipped weeks take no number. */
export function boxNumbers(deliveries: readonly ProjectedDelivery[], next: number): Map<string, number> {
  const numbers = new Map<string, number>();
  for (const d of [...deliveries].sort(byWeek)) {
    if (d.status === 'running' && d.week) numbers.set(d.week, next + numbers.size);
  }
  return numbers;
}

/** Where the box numbering starts, and the note saying how that was decided. */
export function boxNumbering(
  subscription: Pick<RawSubscription, 'firstBoxDelivered' | 'firstDeliveryWeek'>,
  nextBoxNumber: number | undefined,
): { next: number; note: string } {
  const counting = 'each later running week counts up by one (skipped weeks take no box number)';
  if (nextBoxNumber !== undefined) {
    return { next: nextBoxNumber, note: `Box numbers start at next_box_number ${nextBoxNumber} for the next running delivery; ${counting}.` };
  }
  if (subscription.firstBoxDelivered === false) {
    const first = subscription.firstDeliveryWeek ? ` (first delivery week ${subscription.firstDeliveryWeek})` : '';
    return {
      next: 1,
      note: `HelloFresh says this account’s first box is not delivered yet${first}, so the earliest running delivery is box 1 and ${counting}.`,
    };
  }
  const known =
    subscription.firstBoxDelivered === true
      ? `HelloFresh says the first box was delivered${subscription.firstDeliveryWeek ? ` in ${subscription.firstDeliveryWeek}` : ''} but not how many boxes since`
      : 'HelloFresh does not say whether the first box was delivered';
  return {
    next: ASSUMED_NEXT_BOX_NUMBER,
    note: `${known}, so this ASSUMES the next running delivery is box ${ASSUMED_NEXT_BOX_NUMBER} and ${counting}. Pass next_box_number to correct it.`,
  };
}

export const byWeek = (a: { week?: string }, b: { week?: string }) => (a.week ?? '').localeCompare(b.week ?? '');

export type NumberedEstimate = BoxEstimate & { boxNumber?: number };

/** The estimate for a box; an unknown box number gives an undiscounted estimate that says why. */
export function estimateFor(
  delivery: ProjectedDelivery,
  selection: ReadonlyArray<{ premiumBoxCents?: number; quantity?: number }>,
  account: Account,
  boxNumber: number | undefined,
): NumberedEstimate {
  if (boxNumber === undefined) {
    return {
      ...estimateBoxTotal(delivery, selection, null, 1),
      warning: 'This week is not among the upcoming deliveries, so its box number (and voucher discount) is unknown: the estimate is undiscounted. Pass box_number to apply the voucher.',
    };
  }
  return { boxNumber, ...estimateBoxTotal(delivery, selection, account.subscription.voucherInfo, boxNumber) };
}

/** The few estimate fields a compact answer keeps. */
export function compactEstimate(e: NumberedEstimate) {
  return {
    ...(e.boxNumber !== undefined ? { boxNumber: e.boxNumber } : {}),
    subtotalCents: e.subtotalCents,
    discountCents: e.discountCents,
    totalCents: e.totalCents,
    ...(e.warning ? { warning: e.warning } : {}),
  };
}

/** A selection line without its zero-valued fields. */
export function compactSelection(s: SelectedMeal) {
  return {
    index: s.index,
    quantity: s.quantity,
    name: s.name,
    ...(s.premiumBoxCents > 0 ? { premiumBoxCents: s.premiumBoxCents } : {}),
    ...(s.baseIndex !== undefined ? { baseIndex: s.baseIndex } : {}),
  };
}

/** A best-effort read: the value, or the reason it could not be read. */
export async function attempt<T>(run: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
  try {
    return { ok: true, value: await run() };
  } catch (err) {
    return { ok: false, reason: messageOf(err) };
  }
}

// ---- brief ----------------------------------------------------------------------------

/** `YYYY-MM-DD` of an ISO timestamp as HelloFresh wrote it (its own offset), or undefined. */
export const dateOf = (iso: string | undefined) => iso?.slice(0, 10);

/**
 * One delivery as one brief line (≤ 120 chars):
 * `2026-W49 — 2026-11-30 — running, 2×6, cutoff 11-25`.
 */
export function briefLine(d: ProjectedDelivery): string {
  const tail = [
    d.status,
    ...(d.meals && d.servings ? [`${d.meals}×${d.servings}`] : []),
    ...(d.cutoffDate ? [`cutoff ${d.cutoffDate.slice(5, 10)}`] : []),
  ].join(', ');
  return `${d.week ?? 'unknown week'} — ${dateOf(d.deliveryDate) ?? 'no date'} — ${tail}`.slice(0, 120);
}
