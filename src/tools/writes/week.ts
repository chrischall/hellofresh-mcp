// The one-week writes: hf_select_meals, hf_set_week_size,
// hf_set_week_delivery_day, hf_skip_week and hf_unskip_week.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { McpToolError } from '@chrischall/mcp-utils';
import {
  deliveryStatusRequest,
  oneOffRequest,
  selectMealsRequest,
  weekSizeRequest,
  type HelloFreshClient,
} from '../../client.js';
import { projectDelivery, type ProjectedDelivery } from '../../normalize.js';
import type { CartMeal } from '../../types.js';
import { attempt, compactSelection, dateOf, isUnresizableFirstBox, loadAccount, readMenu, sleepMs, weekParam, type Account } from '../shared.js';
import type { ToolDeps } from '../index.js';
import {
  CHANGE,
  SIZE_VERIFY_DELAY_MS,
  SIZE_VERIFY_READS,
  SLOT,
  boxOf,
  mealsCountParam,
  namesOf,
  openWeek,
  peopleParam,
  registerGated,
  requireAllowed,
  requireOfferedSku,
  requireRunning,
  sendAndVerify,
  shown,
  skuOf,
  slotOf,
  type GateFields,
} from './shared.js';

export function registerWeekWrites(server: McpServer, deps: ToolDeps): void {
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
        throw new McpToolError(`${week} is this subscription’s first box, and HelloFresh does not allow resizing the first box.`, {
          hint: 'It keeps the size it was ordered with; every later week can be resized with hf_set_week_size.',
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
}
