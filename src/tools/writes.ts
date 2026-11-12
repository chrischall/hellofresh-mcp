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
import {
  deliveryStatusRequest,
  oneOffRequest,
  weekSizeRequest,
  planDeliveryDetailsRequest,
  planProductRequest,
  selectMealsRequest,
  type HelloFreshClient,
  type WriteRequest,
} from '../client.js';
import { projectDelivery, type ProjectedDelivery, type ProjectedMenu } from '../normalize.js';
import type { CartMeal, RawDelivery } from '../types.js';
import { foodMeta, type MintHint } from './hints.js';
import {
  attempt,
  compactSelection,
  customerPlanIdOf,
  dateOf,
  isUnresizableFirstBox,
  loadAccount,
  readMenu,
  sleepMs,
  weekParam,
  type Account,
} from './shared.js';
import type { ToolDeps } from './index.js';

type GateFields = Omit<ConfirmWriteOptions, 'tool' | 'confirmToken' | 'args'>;

interface GatedWrite<Shape extends z.ZodRawShape, State> {
  name: string;
  title: string;
  description: string;
  destructive: boolean;
  meta: { mint: MintHint };
  input: Shape;
  plan(args: z.infer<z.ZodObject<Shape>>): Promise<{ gate: GateFields; state: State }>;
  execute(state: State): Promise<CallToolResult>;
}

function registerGated<Shape extends z.ZodRawShape, State>(server: McpServer, def: GatedWrite<Shape, State>): void {
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
const shown = (w: WriteRequest) => ({ method: w.method, path: `/gw${w.path}`, query: w.query, body: w.body });

const CHANGE = (aliases: string[]) => foodMeta('change', { aliases });

/**
 * Send `send`, then re-read with `verify`. A send whose outcome is unknown
 * answers `status: 'unknown'`; a re-read that fails answers `unverified` with
 * the reason.
 */
async function sendAndVerify<After>(opts: {
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

type ActionName = 'mealSwap' | 'oneOffChange' | 'pause';

/** The week, refused when its cutoff has passed. */
async function openWeek(
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
function requireAllowed(raw: RawDelivery, week: string, action: ActionName): void {
  if (raw.allowedActions?.[action] === false) {
    throw new McpToolError(`HelloFresh does not allow this change for ${week} (${action} is not allowed for it).`);
  }
}

/** Refuse a week that is not running (skipped → unskip first). */
function requireRunning(delivery: ProjectedDelivery, week: string, what: string): void {
  if (delivery.status === 'skipped') {
    throw new McpToolError(`${week} is skipped, so you cannot ${what}. Unskip it first with hf_unskip_week.`);
  }
  if (delivery.status !== 'running') throw new McpToolError(`${week} is ${delivery.status}, so you cannot ${what}.`);
}

/** The SKUs this subscription can switch to; refuses one not among them. */
async function requireOfferedSku(client: HelloFreshClient, account: Account, sku: string): Promise<void> {
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

const skuOf = (meals: number, people: number) => `US-CBU-${meals}-${people}-0`;

const boxOf = (d: Pick<ProjectedDelivery, 'sku' | 'meals' | 'servings' | 'deliveryOption'>) => ({
  sku: d.sku,
  meals: d.meals,
  people: d.servings,
  deliveryOption: d.deliveryOption,
});

const peopleParam = z
  .union([z.literal(2), z.literal(3), z.literal(4), z.literal(6)])
  .describe('People (servings per meal): 2, 3, 4 or 6.');

const mealsCountParam = (what: string) => z.number().int().min(1).max(6).describe(`Meals per week ${what}.`);

const SLOT = /^US-[1-7]-\d{4}-\d{4}$/;

// ---- registration ---------------------------------------------------------------------

export function registerWriteTools(server: McpServer, deps: ToolDeps): void {
  const { client } = deps;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? sleepMs;

  // ---- hf_select_meals (write 1) ----

  interface SelectState {
    account: Account;
    delivery: ProjectedDelivery;
    week: string;
    meals: CartMeal[];
    request: Parameters<HelloFreshClient['selectMeals']>[0];
    before: ReturnType<typeof compactSelection>[];
  }

  registerGated(server, {
    name: 'hf_select_meals',
    title: 'HelloFresh: pick meals for a week',
    description:
      'Pick the meals for one HelloFresh delivery week, replacing the current picks. Give the menu indexes from ' +
      'hf_get_menu (a protein swap’s index works too); the count (with quantities) must equal the box’s meals per ' +
      'week, and only before the week’s cutoff. Re-reads the menu afterwards to verify the picks.',
    destructive: false,
    meta: CHANGE(['pick hellofresh meals', 'choose meals', 'select recipes']),
    input: {
      week: weekParam,
      meals: z
        .array(
          z.union([
            z.number().int().positive(),
            z.object({ index: z.number().int().positive(), quantity: z.number().int().min(1).max(6) }),
          ]),
        )
        .min(1)
        .max(12)
        .describe('The COMPLETE selection: menu indexes, or {index, quantity} for more than one of a meal. A repeated index adds up.'),
    },
    async plan({ week, meals }): Promise<{ gate: GateFields; state: SelectState }> {
      const account = await loadAccount(client);
      const { raw, delivery } = await openWeek(client, account, week, now());
      requireRunning(delivery, week, 'pick its meals');
      requireAllowed(raw, week, 'mealSwap');
      if (!delivery.meals || !delivery.sku) throw new McpToolError(`HelloFresh returned no meal count for ${week}'s box.`);
      const menu = await readMenu(client, account, delivery, week);

      const quantities = new Map<number, number>();
      for (const m of meals) {
        const { index, quantity } = typeof m === 'number' ? { index: m, quantity: 1 } : m;
        quantities.set(index, (quantities.get(index) ?? 0) + quantity);
      }
      const cart = [...quantities].map(([index, quantity]) => ({ index, quantity }));
      const names = namesOf(menu);
      const unknown = cart.filter((m) => !names.has(m.index)).map((m) => m.index);
      if (unknown.length > 0) {
        throw new McpToolError(`Meal ${unknown.join(', ')} is not on the ${week} menu.`, { hint: `hf_get_menu {week: "${week}"} lists the indexes.` });
      }
      const total = cart.reduce((n, m) => n + m.quantity, 0);
      if (total !== delivery.meals) {
        throw new McpToolError(`The ${week} box takes ${delivery.meals} meals; you picked ${total}.`, {
          hint: 'Pick exactly that many (quantities count), or change the box with hf_set_week_size first.',
        });
      }
      const customerId = account.subscription.customer?.id;
      if (customerId === undefined) throw new McpToolError('HelloFresh returned no customer id on the subscription, which the cart needs.');
      const preference = account.subscription.preset;
      if (!preference) throw new McpToolError('HelloFresh returned no meal-preference preset on the subscription, which the cart needs.');

      const request = { week, subscriptionId: account.subscriptionId, customerId, sku: delivery.sku, preference, meals: cart };
      const before = menu.selected.map(compactSelection);
      return {
        gate: {
          action: 'hellofresh.meals.select',
          summary: `Pick ${total} meal(s) for the ${week} box (${delivery.meals}×${delivery.servings}), replacing the current picks`,
          account: account.subscriptionId,
          target: week,
          revision: JSON.stringify(before.map((s) => [s.index, s.quantity])),
          request: shown(selectMealsRequest(request)),
          preview: {
            currentPicks: before.map((s) => s.name),
            newPicks: cart.map((m) => ({ ...m, name: names.get(m.index) })),
          },
        },
        state: { account, delivery, week, meals: cart, request, before },
      };
    },
    execute: (s) =>
      sendAndVerify({
        send: () => client.selectMeals(s.request),
        before: s.before,
        checkWith: `hf_get_delivery {week: "${s.week}"}`,
        mismatch: 'HelloFresh accepted the request, but the re-read menu does not show exactly these picks.',
        extra: (r) => ((r as { hasSeamlessDowngraded?: boolean }).hasSeamlessDowngraded ? { hasSeamlessDowngraded: true } : {}),
        verify: async () => {
          const menu = await readMenu(client, s.account, s.delivery, s.week);
          const after = menu.selected.map(compactSelection);
          const key = (l: Array<{ index: number; quantity: number }>) =>
            JSON.stringify([...l].sort((a, b) => a.index - b.index).map((m) => [m.index, m.quantity]));
          return { ok: key(after) === key(s.meals), after };
        },
      }),
  });

  // ---- hf_set_week_size (write 3a: PUT carts/{week}/size) ----

  interface WeekSizeState {
    account: Account;
    week: string;
    request: Parameters<HelloFreshClient['setWeekSize']>[0];
    before: Record<string, unknown>;
    beforePicks?: number;
  }

  registerGated(server, {
    name: 'hf_set_week_size',
    title: 'HelloFresh: change one week’s box size',
    description:
      'Change the box size (people, and optionally meals) of ONE HelloFresh delivery week only — the plan stays as it ' +
      'is (hf_change_plan_size changes it for good, and resets these one-week sizes). Keeps the week’s delivery day. ' +
      'The subscription’s first box cannot be resized (a HelloFresh rule) and is refused. HelloFresh may reset that ' +
      'week’s meal picks; the result says so, and hf_select_meals re-picks.',
    destructive: false,
    meta: CHANGE(['hellofresh box size this week', 'servings this week', 'change people']),
    input: {
      week: weekParam,
      people: peopleParam,
      meals: mealsCountParam('for this week (default: the week’s current count)').optional(),
    },
    async plan({ week, people, meals }): Promise<{ gate: GateFields; state: WeekSizeState }> {
      const account = await loadAccount(client);
      if (isUnresizableFirstBox(account.subscription, week)) {
        throw new McpToolError(`${week} is this subscription’s first box, which HelloFresh does not let you resize: it cannot be resized.`, {
          hint: 'Its size stays as ordered; later weeks can be resized once it is scheduled.',
        });
      }
      const { raw, delivery } = await openWeek(client, account, week, now());
      requireRunning(delivery, week, 'change its box size');
      requireAllowed(raw, week, 'oneOffChange');
      const count = meals ?? delivery.meals;
      if (!count) throw new McpToolError(`HelloFresh returned no meal count for ${week}'s box; pass meals.`);
      const sku = skuOf(count, people);
      if (sku === delivery.sku) throw new McpToolError(`${week} is already a ${count}-meal box for ${people}.`);
      await requireOfferedSku(client, account, sku);
      const picks = await attempt(() => readMenu(client, account, delivery, week));
      const currentPicks = picks.ok ? picks.value.selected.map(compactSelection) : undefined;

      const request = { subscriptionId: account.subscriptionId, week, sku };
      const from = { sku: delivery.sku, meals: delivery.meals, people: delivery.servings };
      return {
        gate: {
          action: 'hellofresh.week.size',
          summary: `Change the ${week} box to ${count} meals for ${people} people (this week only)`,
          account: account.subscriptionId,
          target: week,
          request: shown(weekSizeRequest(request)),
          preview: {
            from,
            to: { sku, meals: count, people },
            ...(currentPicks ? { currentPicks: currentPicks.map((p) => p.name) } : {}),
            warning: 'HelloFresh may reset this week’s meal picks when the size changes; re-pick with hf_select_meals if so.',
          },
        },
        state: { account, week, request, before: boxOf(delivery), beforePicks: currentPicks?.length },
      };
    },
    execute: (s) =>
      sendAndVerify({
        send: () => client.setWeekSize(s.request),
        before: s.before,
        checkWith: `hf_get_delivery {week: "${s.week}"}`,
        mismatch: `HelloFresh accepted the request, but ${SIZE_VERIFY_READS} re-reads of the week do not show the new box size.`,
        verify: async () => {
          // The new size can take a moment to show: re-read a few times before calling it unverified.
          let delivery = projectDelivery(await client.getDelivery(s.account.subscriptionId, s.week));
          for (let read = 1; read < SIZE_VERIFY_READS && delivery.sku !== s.request.sku; read++) {
            await sleep(SIZE_VERIFY_DELAY_MS);
            delivery = projectDelivery(await client.getDelivery(s.account.subscriptionId, s.week));
          }
          const ok = delivery.sku === s.request.sku;
          const picks = await attempt(() => readMenu(client, s.account, delivery, s.week));
          const extra: Record<string, unknown> = picks.ok
            ? { picksAfter: picks.value.selected.map(compactSelection) }
            : { picksError: picks.reason };
          if (picks.ok && picks.value.selected.length === 0 && (s.beforePicks ?? 0) > 0) {
            extra.warning = 'The meal picks were reset by the size change; pick again with hf_select_meals.';
          }
          return { ok, after: boxOf(delivery), extra };
        },
      }),
  });

  // ---- hf_set_week_delivery_day (write 3b: the one-off, delivery_option only) ----

  interface OneOffState {
    account: Account;
    week: string;
    request: Parameters<HelloFreshClient['changeOneOff']>[0];
    before: Record<string, unknown>;
  }

  registerGated(server, {
    name: 'hf_set_week_delivery_day',
    title: 'HelloFresh: move one week’s delivery day',
    description:
      'Move ONE HelloFresh delivery week to another delivery day/slot offered for that week (the week’s ' +
      'oneOffDaySlots from hf_get_delivery). Keeps the box size; the plan’s regular day is unchanged ' +
      '(hf_change_delivery_schedule changes it for good).',
    destructive: false,
    meta: CHANGE(['hellofresh delivery day', 'move delivery', 'deliver on another day']),
    input: {
      week: weekParam,
      slot: z
        .string()
        .trim()
        .regex(SLOT, 'a slot handle like US-2-0800-2000')
        .describe('The slot handle from the week’s oneOffDaySlots, e.g. US-2-0800-2000 (weekday 1=Mon…7=Sun, then from/to HHMM).'),
    },
    async plan({ week, slot }): Promise<{ gate: GateFields; state: OneOffState }> {
      const account = await loadAccount(client);
      const { raw, delivery } = await openWeek(client, account, week, now());
      requireRunning(delivery, week, 'move its delivery day');
      requireAllowed(raw, week, 'oneOffChange');
      if (slot === delivery.deliveryOption) throw new McpToolError(`${week} is already delivered in slot ${slot}.`);
      const offered = delivery.oneOffDaySlots;
      const target = offered.find((o) => o.handle === slot);
      if (!target) {
        const list = offered.map((o) => `${o.handle} (${dateOf(o.deliveryDate)})`).join(', ');
        throw new McpToolError(
          list ? `${slot} is not offered for ${week}. Offered: ${list}.` : `HelloFresh offers no alternative delivery day for ${week}.`,
        );
      }
      if (!delivery.sku) throw new McpToolError(`HelloFresh returned no box size for ${week}, which the change must keep.`);
      const request = { subscriptionId: account.subscriptionId, week, sku: delivery.sku, deliveryOption: slot };
      return {
        gate: {
          action: 'hellofresh.week.day',
          summary: `Deliver the ${week} box in slot ${slot} on ${dateOf(target.deliveryDate)} (this week only)`,
          account: account.subscriptionId,
          target: week,
          request: shown(oneOffRequest(request)),
          preview: {
            from: { deliveryOption: delivery.deliveryOption, deliveryDate: dateOf(delivery.deliveryDate) },
            to: { deliveryOption: slot, deliveryDate: dateOf(target.deliveryDate) },
          },
        },
        state: { account, week, request, before: slotOf(delivery) },
      };
    },
    execute: (s) =>
      sendAndVerify({
        send: () => client.changeOneOff(s.request),
        before: s.before,
        checkWith: `hf_get_delivery {week: "${s.week}"}`,
        mismatch: 'HelloFresh accepted the request, but the re-read week does not show the new delivery slot.',
        verify: async () => {
          const delivery = projectDelivery(await client.getDelivery(s.account.subscriptionId, s.week));
          return { ok: delivery.deliveryOption === s.request.deliveryOption && delivery.sku === s.request.sku, after: slotOf(delivery) };
        },
      }),
  });

  // ---- hf_skip_week / hf_unskip_week (write 2) ----

  const statusWrite = (skip: boolean) => {
    interface StatusState {
      account: Account;
      week: string;
      request: Parameters<HelloFreshClient['setDeliveryStatus']>[0];
      before: { status: string };
    }
    const name = skip ? 'hf_skip_week' : 'hf_unskip_week';
    registerGated(server, {
      name,
      title: skip ? 'HelloFresh: skip a week' : 'HelloFresh: unskip a week',
      description: skip
        ? 'Skip one HelloFresh delivery week: no box is delivered or charged that week. Only before the week’s cutoff; ' +
          'undo with hf_unskip_week.'
        : 'Unskip one skipped HelloFresh delivery week, so its box is delivered and charged again. Only before the week’s ' +
          'cutoff; HelloFresh may pick meals for it — check with hf_get_delivery and pick with hf_select_meals.',
      destructive: false,
      meta: CHANGE(skip ? ['skip hellofresh', 'pause hellofresh week', 'no box this week'] : ['unskip hellofresh', 'resume hellofresh week']),
      input: { week: weekParam },
      async plan({ week }): Promise<{ gate: GateFields; state: StatusState }> {
        const account = await loadAccount(client);
        const { raw, delivery } = await openWeek(client, account, week, now());
        if (skip && delivery.status === 'skipped') throw new McpToolError(`${week} is already skipped.`);
        if (skip) requireRunning(delivery, week, 'skip it');
        if (!skip && delivery.status !== 'skipped') throw new McpToolError(`${week} is not skipped (it is ${delivery.status}).`);
        requireAllowed(raw, week, 'pause');
        if (!delivery.deliveryDate || !delivery.cutoffDate) {
          throw new McpToolError(`HelloFresh returned no delivery/cutoff dates for ${week}, which the change must send back.`);
        }
        const request = {
          subscriptionId: account.subscriptionId,
          week,
          deliveryDate: delivery.deliveryDate,
          cutoffDate: delivery.cutoffDate,
          status: skip ? ('PAUSED' as const) : ('RUNNING' as const),
        };
        return {
          gate: {
            action: skip ? 'hellofresh.week.skip' : 'hellofresh.week.unskip',
            summary: skip
              ? `Skip the ${week} box (delivery ${dateOf(delivery.deliveryDate)}): nothing delivered or charged`
              : `Unskip the ${week} box (delivery ${dateOf(delivery.deliveryDate)}): it will be delivered and charged`,
            account: account.subscriptionId,
            target: week,
            request: shown(deliveryStatusRequest(request)),
          },
          state: { account, week, request, before: { status: delivery.status } },
        };
      },
      execute: (s) =>
        sendAndVerify({
          send: () => client.setDeliveryStatus(s.request),
          before: s.before,
          checkWith: `hf_get_delivery {week: "${s.week}"}`,
          mismatch: `HelloFresh accepted the request, but the re-read week is not ${skip ? 'skipped' : 'running'}.`,
          verify: async () => {
            const delivery = projectDelivery(await client.getDelivery(s.account.subscriptionId, s.week));
            return { ok: delivery.status === (skip ? 'skipped' : 'running'), after: { status: delivery.status } };
          },
        }),
    });
  };
  statusWrite(true);
  statusWrite(false);

  // ---- hf_change_plan_size (write 4) ----

  interface Override {
    week: string;
    sku: string;
  }

  interface PlanSizeState {
    planId: string;
    sku: string;
    before: { sku?: string };
    overrides: Override[];
  }

  /** Upcoming running weeks still open for changes whose size differs from the plan's: week-only overrides. */
  const overridesOf = (deliveries: readonly ProjectedDelivery[], planSku: string | undefined, at: number): Override[] =>
    deliveries.flatMap((d) =>
      d.status === 'running' &&
      d.week &&
      d.sku &&
      d.sku !== planSku &&
      !(d.cutoffDate && Date.parse(d.cutoffDate) <= at)
        ? [{ week: d.week, sku: d.sku }]
        : [],
    );

  /** Which overrides the plan change reverted to `sku` (re-read best effort). */
  const overrideReport = async (overrides: Override[], sku: string): Promise<Record<string, unknown>> => {
    if (overrides.length === 0) return {};
    const read = await attempt(async () => ((await client.listDeliveries()).items ?? []).map(projectDelivery));
    if (!read.ok) return { overridesError: read.reason, overridesNote: overridesNote(overrides) };
    const now = new Map(read.value.map((d) => [d.week, d.sku]));
    const reverted = overrides.filter((o) => now.get(o.week) === sku && o.sku !== sku).map((o) => ({ week: o.week, from: o.sku, to: sku }));
    const kept = overrides.filter((o) => now.has(o.week) && now.get(o.week) !== sku).map((o) => ({ week: o.week, sku: now.get(o.week) }));
    const unread = overrides.filter((o) => !now.has(o.week)).map((o) => o.week);
    return {
      ...(reverted.length > 0 ? { overridesReverted: reverted } : {}),
      ...(kept.length > 0 ? { overridesKept: kept } : {}),
      ...(unread.length > 0 ? { overridesUnread: unread } : {}),
      overridesNote: overridesNote(overrides),
    };
  };
  const overridesNote = (overrides: Override[]) =>
    'A plan size change resets one-week sizes. To keep one, re-apply it with hf_set_week_size ' +
    `(the weeks were: ${overrides.map((o) => `${o.week} ${o.sku}`).join(', ')}).`;

  registerGated(server, {
    name: 'hf_change_plan_size',
    title: 'HelloFresh: change the plan’s box size',
    description:
      'Permanently change the HelloFresh plan’s box size (meals per week × people) for every future week. Warning: ' +
      'this RESETS every one-week size set with hf_set_week_size — those weeks revert to the new plan size. The ' +
      'preview lists them, and the result says which reverted so they can be re-applied with hf_set_week_size. ' +
      'Re-reads the plan to verify.',
    destructive: true,
    meta: CHANGE(['hellofresh plan size', 'change hellofresh plan', 'permanent box size']),
    input: { meals: mealsCountParam('on the plan'), people: peopleParam },
    async plan({ meals, people }): Promise<{ gate: GateFields; state: PlanSizeState }> {
      const account = await loadAccount(client);
      const planId = await customerPlanIdOf(client, account);
      const plans = await client.listPlans();
      const current = plans.find((p) => p.id === planId)?.planItems?.[0]?.productHandle ?? account.subscription.product?.sku;
      const sku = skuOf(meals, people);
      if (sku === current) throw new McpToolError(`The plan is already ${meals} meals for ${people} people (${sku}).`);
      await requireOfferedSku(client, account, sku);
      const size = current ? /-(\d+)-(\d+)-\d+$/.exec(current) : null;
      const upcoming = await attempt(async () => ((await client.listDeliveries()).items ?? []).map(projectDelivery));
      const overrides = upcoming.ok ? overridesOf(upcoming.value, current, now()) : [];
      return {
        gate: {
          action: 'hellofresh.plan.size',
          summary: `Permanently change the plan to ${meals} meals for ${people} people (${sku})`,
          account: account.subscriptionId,
          target: planId,
          request: shown(planProductRequest(planId, sku)),
          preview: {
            from: { sku: current, ...(size ? { meals: Number(size[1]), people: Number(size[2]) } : {}) },
            to: { sku, meals, people },
            note: 'Permanent: applies to every future week, and resets any one-week size (hf_set_week_size) to the new plan size.',
            ...(overrides.length > 0
              ? {
                  overriddenWeeks: overrides.map((o) => ({ ...o, revertsTo: sku })),
                  warning:
                    `${overrides.map((o) => `${o.week} (now ${o.sku})`).join(', ')} will revert to ${sku}: a plan size change ` +
                    'resets one-week sizes. Re-apply any you want to keep with hf_set_week_size afterwards.',
                }
              : {}),
            ...(upcoming.ok
              ? {}
              : { overridesUnknown: `Could not read the upcoming weeks (${upcoming.reason}), so one-week sizes that would revert are not listed.` }),
          },
        },
        state: { planId, sku, before: { sku: current }, overrides },
      };
    },
    execute: (s) =>
      sendAndVerify({
        send: () => client.setPlanProduct(s.planId, s.sku),
        before: s.before,
        checkWith: 'hf_get_subscription',
        mismatch: 'HelloFresh accepted the request, but the re-read plan does not show the new box size.',
        verify: async () => {
          const sku = (await client.listPlans()).find((p) => p.id === s.planId)?.planItems?.[0]?.productHandle;
          return { ok: sku === s.sku, after: { sku }, extra: await overrideReport(s.overrides, s.sku) };
        },
      }),
  });

  // ---- hf_change_delivery_schedule (write 5) ----

  interface ScheduleState {
    account: Account;
    planId: string;
    details: { deliveryOption: string; deliveryInterval: number };
    before: { deliveryOption: string; deliveryInterval: number };
  }

  registerGated(server, {
    name: 'hf_change_delivery_schedule',
    title: 'HelloFresh: change the delivery schedule',
    description:
      'Permanently change the HelloFresh plan’s regular delivery slot (day + time window) and/or frequency (every 1–4 ' +
      'weeks). Give either or both; the other keeps its current value. Re-reads the subscription to verify.',
    destructive: true,
    meta: CHANGE(['hellofresh delivery schedule', 'delivery frequency', 'every other week']),
    input: {
      delivery_option: z
        .string()
        .trim()
        .regex(SLOT, 'a slot handle like US-1-0800-2000')
        .optional()
        .describe('The regular slot handle, e.g. US-1-0800-2000 = Mondays 8AM–8PM (weekday 1=Mon…7=Sun, then from/to HHMM).'),
      interval_weeks: z.number().int().min(1).max(4).optional().describe('Deliver every N weeks (1–4).'),
    },
    async plan({ delivery_option, interval_weeks }): Promise<{ gate: GateFields; state: ScheduleState }> {
      if (delivery_option === undefined && interval_weeks === undefined) {
        throw new McpToolError('Give delivery_option or interval_weeks (or both).');
      }
      const account = await loadAccount(client);
      const sub = account.subscription;
      const currentOption = sub.deliveryOption?.handle ?? sub.deliveryTime;
      const currentInterval = sub.deliveryInterval;
      if (!currentOption) throw new McpToolError('HelloFresh returned no current delivery slot, which must be sent with the change.');
      if (currentInterval === undefined) {
        throw new McpToolError('HelloFresh returned no current delivery frequency, which must be sent with the change.');
      }
      const details = { deliveryOption: delivery_option ?? currentOption, deliveryInterval: interval_weeks ?? currentInterval };
      const before = { deliveryOption: currentOption, deliveryInterval: currentInterval };
      if (details.deliveryOption === currentOption && details.deliveryInterval === currentInterval) {
        throw new McpToolError(`The schedule is already slot ${currentOption}, every ${currentInterval} week(s).`);
      }
      const planId = await customerPlanIdOf(client, account);
      let caveat: string | undefined;
      if (details.deliveryOption !== currentOption) {
        const seen = ((await client.listDeliveries()).items ?? []).flatMap((d) => (d.availableOneOffOptions ?? []).map((o) => o.handle));
        if (!seen.includes(details.deliveryOption)) {
          caveat = `${details.deliveryOption} is not one this account has been offered (not among the upcoming weeks’ alternative slots); HelloFresh may refuse it.`;
        }
      }
      return {
        gate: {
          action: 'hellofresh.plan.schedule',
          summary: `Permanently deliver in slot ${details.deliveryOption}, every ${details.deliveryInterval} week(s)`,
          account: account.subscriptionId,
          target: planId,
          request: shown(planDeliveryDetailsRequest(planId, details)),
          preview: { from: before, to: details, ...(caveat ? { caveat } : {}) },
        },
        state: { account, planId, details, before },
      };
    },
    execute: (s) =>
      sendAndVerify({
        send: () => client.changePlanDeliveryDetails(s.planId, s.details),
        before: s.before,
        checkWith: 'hf_get_subscription',
        mismatch: 'HelloFresh accepted the request, but the re-read subscription does not show the new schedule.',
        verify: async () => {
          const sub = await client.getSubscription(s.account.subscriptionId);
          const after = { deliveryOption: sub.deliveryOption?.handle ?? sub.deliveryTime, deliveryInterval: sub.deliveryInterval };
          return { ok: after.deliveryOption === s.details.deliveryOption && after.deliveryInterval === s.details.deliveryInterval, after };
        },
      }),
  });
}

/** Every index on the menu (base courses and their protein swaps) → its name. */
function namesOf(menu: ProjectedMenu): Map<number, string | undefined> {
  const names = new Map<number, string | undefined>();
  for (const m of menu.meals) {
    names.set(m.index, m.name);
    for (const v of m.variants) names.set(v.index, v.name ?? v.title);
  }
  return names;
}

const slotOf = (d: ProjectedDelivery) => ({ deliveryOption: d.deliveryOption, deliveryDate: dateOf(d.deliveryDate), sku: d.sku });
