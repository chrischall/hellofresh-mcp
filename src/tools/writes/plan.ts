// The permanent plan writes: hf_change_plan_size and hf_change_delivery_schedule.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { McpToolError } from '@chrischall/mcp-utils';
import { planDeliveryDetailsRequest, planProductRequest } from '../../client.js';
import { projectDelivery, type ProjectedDelivery } from '../../normalize.js';
import { attempt, customerPlanIdOf, isUnresizableFirstBox, loadAccount, type Account } from '../shared.js';
import type { ToolDeps } from '../index.js';
import {
  CHANGE,
  SLOT,
  mealsCountParam,
  peopleParam,
  registerGated,
  requireOfferedSku,
  sendAndVerify,
  shown,
  skuOf,
  type GateFields,
} from './shared.js';

export function registerPlanWrites(server: McpServer, deps: ToolDeps): void {
  const { client } = deps;
  const now = deps.now ?? Date.now;

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
  const overridesOf = (
    deliveries: readonly ProjectedDelivery[],
    planSku: string | undefined,
    at: number,
    subscription: Parameters<typeof isUnresizableFirstBox>[0],
  ): Override[] =>
    deliveries.flatMap((d) =>
      d.status === 'running' &&
      !(d.week && isUnresizableFirstBox(subscription, d.week)) &&
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
      const overrides = upcoming.ok ? overridesOf(upcoming.value, current, now(), account.subscription) : [];
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
