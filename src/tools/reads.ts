// The read tools: subscription, deliveries (the canonical whats-on read),
// one delivery, a week's menu, box sizes and recent picks. Every record goes
// out through the normalize.ts allowlist projections — the raw subscription
// and delivery records carry the customer's name, email, addresses and
// payment token, none of which is ever returned.

import { z } from 'zod';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { minifiedResult, resolveView, todayIso, toolAnnotations } from '@chrischall/mcp-utils';
import {
  parseSku,
  projectDelivery,
  projectSubscription,
  type ProjectedDelivery,
  type ProjectedMeal,
  type ProjectedVariant,
} from '../normalize.js';
import { isoWeekOf, shiftWeek } from '../weeks.js';
import type { RawSubscription } from '../types.js';
import { LOOKUP, foodMeta } from './hints.js';
import {
  DEFAULT_NEXT_BOX_NUMBER,
  HF_VIEWS,
  attempt,
  boxNumbers,
  briefLine,
  byWeek,
  compactEstimate,
  compactSelection,
  dateOf,
  estimateFor,
  hfView,
  loadAccount,
  nextBoxNumberParam,
  readMenu,
  readPicks,
  weekParam,
} from './shared.js';
import type { ToolDeps } from './index.js';

const readOnly = (title: string) => toolAnnotations({ title, readOnly: true, idempotent: true, openWorld: true });

// ---- projections for the compact rung --------------------------------------------

function fullVoucher(v: RawSubscription['voucherInfo']) {
  if (!v) return undefined;
  const rules = v.discount_settings?.discount_rule?.box_rule ?? {};
  return {
    code: v.code,
    active: v.is_active === true,
    discountType: v.discount_type,
    boxCount: v.discount_settings?.box_count,
    boxRules: Object.entries(rules)
      .map(([box, rule]) => ({ box: Number(box), percent: (rule?.discount_value ?? 0) / 100, appliesTo: rule?.applicable_to }))
      .sort((a, b) => a.box - b.box),
  };
}

function compactDelivery(d: ProjectedDelivery) {
  return {
    week: d.week,
    deliveryDate: dateOf(d.deliveryDate),
    cutoffDate: d.cutoffDate,
    status: d.status,
    meals: d.meals,
    servings: d.servings,
    sku: d.sku,
    deliveryName: d.deliveryName,
  };
}

const premiumFields = (perServing: number, box: number) =>
  perServing > 0 || box > 0 ? { premiumPerServingCents: perServing, premiumBoxCents: box } : {};

function compactVariant(v: ProjectedVariant) {
  return {
    index: v.index,
    title: v.title,
    ...(v.seafoodKind ? { seafoodKind: v.seafoodKind } : {}),
    ...premiumFields(v.premiumPerServingCents, v.premiumBoxCents),
    ...(v.selectedQuantity > 0 ? { selected: v.selectedQuantity } : {}),
  };
}

function compactMeal(m: ProjectedMeal) {
  return {
    index: m.index,
    name: m.name,
    category: m.category,
    ...(m.seafoodKind ? { seafoodKind: m.seafoodKind } : {}),
    kidFriendly: m.kidFriendly,
    quick: m.quick,
    totalMinutes: m.totalMinutes,
    ...premiumFields(m.premiumPerServingCents, m.premiumBoxCents),
    ...(m.selectedQuantity > 0 ? { selected: m.selectedQuantity } : {}),
    ...(m.variants.length > 0 ? { variants: m.variants.map(compactVariant) } : {}),
  };
}

// ---- menu filters ------------------------------------------------------------------

interface MenuFilters {
  seafood_only?: boolean;
  kid_friendly?: boolean;
  max_minutes?: number;
  max_premium_per_serving?: number;
  selected_only?: boolean;
}

type Filtered = ProjectedMeal & { onlyVariantsMatch?: true };

/**
 * Kid-friendliness and time belong to the recipe, so they gate the course and
 * its swaps alike. Seafood, premium and selection are per dish: a course that
 * fails them is still listed when one of its swaps passes (with only the
 * passing swaps, and `onlyVariantsMatch`).
 */
function applyFilters(meals: ProjectedMeal[], f: MenuFilters): Filtered[] {
  const dish = (d: { isSeafood: boolean; premiumPerServingCents: number; selectedQuantity: number }) =>
    (!f.seafood_only || d.isSeafood) &&
    (f.max_premium_per_serving === undefined || d.premiumPerServingCents <= f.max_premium_per_serving) &&
    (!f.selected_only || d.selectedQuantity > 0);
  return meals.flatMap((m): Filtered[] => {
    const recipeOk =
      (!f.kid_friendly || m.kidFriendly) &&
      (f.max_minutes === undefined || (m.totalMinutes !== undefined && m.totalMinutes <= f.max_minutes));
    if (!recipeOk) return [];
    const variants = m.variants.filter(dish);
    if (dish(m)) return [{ ...m, variants }];
    return variants.length > 0 ? [{ ...m, variants, onlyVariantsMatch: true }] : [];
  });
}

// ---- registration -------------------------------------------------------------------

export function registerReadTools(server: McpServer, deps: ToolDeps): void {
  const { client } = deps;
  const now = deps.now ?? Date.now;

  server.registerTool(
    'hf_get_subscription',
    {
      description:
        'Read the HelloFresh meal-kit subscription: the plan’s box size (meals × people, SKU), price per box, ' +
        'meal-preference preset, delivery weekday/slot and frequency, the next delivery week and its cutoff, ' +
        'pause/cancel state and the voucher (discount code). Never returns name, email, address or payment details.',
      annotations: readOnly('HelloFresh: get subscription'),
      _meta: foodMeta('lookup', { aliases: ['hellofresh plan', 'meal kit subscription'] }),
      inputSchema: z.object({
        view: hfView('compact keeps the plan, schedule and voucher code; full adds the plan id and the voucher’s per-box discount rules.'),
      }),
    },
    async ({ view }) => {
      const { subscription } = await loadAccount(client);
      const projected = projectSubscription(subscription);
      if (resolveView(view, HF_VIEWS) === 'compact') return minifiedResult({ subscription: projected });
      return minifiedResult({
        subscription: { ...projected, customerPlanId: subscription.customerPlanId, voucher: fullVoucher(subscription.voucherInfo) },
      });
    },
  );

  server.registerTool(
    'hf_list_deliveries',
    {
      description:
        'List upcoming HelloFresh deliveries (about the next 7 weeks): each week’s delivery date, meal-pick cutoff, ' +
        'status (running, skipped, delivered), box size and an estimated box total with the voucher discount. ' +
        'Answers "what HelloFresh boxes are coming?" — view "brief" gives one line per week.',
      annotations: readOnly('HelloFresh: list deliveries'),
      _meta: foodMeta('whats-on', {
        canonical: true,
        aliases: ['hellofresh', 'meal kit', 'meal delivery', 'dinner box', 'hellofresh box'],
      }),
      inputSchema: z.object({
        view: z
          .enum(['brief', 'compact', 'full'])
          .optional()
          .describe(
            '"compact" (default): week, dates, status, box size and a short estimate. "brief": one line per week, ' +
              '`2026-W49 — 2026-11-30 — running, 2×6, cutoff 11-25`. "full": every allowlisted delivery field ' +
              '(allowed actions, alternative delivery-day slots) and the whole estimate.',
          ),
        next_box_number: nextBoxNumberParam,
      }),
    },
    async ({ view, next_box_number }) => {
      const account = await loadAccount(client);
      const deliveries = ((await client.listDeliveries()).items ?? []).map(projectDelivery).sort(byWeek);
      if (view === 'brief') {
        const lines = deliveries.map(briefLine);
        return { content: [{ type: 'text', text: (lines.length > 0 ? lines : ['-- none']).join('\n') }] } satisfies CallToolResult;
      }
      const numbers = boxNumbers(deliveries, next_box_number ?? DEFAULT_NEXT_BOX_NUMBER);
      const full = view === 'full';
      return minifiedResult({
        deliveries: deliveries.map((d) => {
          const boxNumber = numbers.get(d.week!);
          const estimate = boxNumber !== undefined ? estimateFor(d, [], account, boxNumber) : undefined;
          const base = full ? d : compactDelivery(d);
          if (!estimate) return base;
          return { ...base, estimate: full ? estimate : compactEstimate(estimate) };
        }),
        estimateNote:
          'Estimates (running weeks only) are product + fees + shipping minus the voucher, WITHOUT premium meal ' +
          'upcharges (hf_get_delivery adds those). Box numbers assume the next running box is box ' +
          `${next_box_number ?? DEFAULT_NEXT_BOX_NUMBER}; pass next_box_number to correct it.`,
      });
    },
  );

  server.registerTool(
    'hf_get_delivery',
    {
      description:
        'Read one HelloFresh delivery week: delivery date and slot, meal-pick cutoff, status, box size, the meals ' +
        'currently picked (with any premium upcharge), allowed actions, alternative delivery days, and an estimated ' +
        'box total including premium upcharges and the voucher discount.',
      annotations: readOnly('HelloFresh: get delivery'),
      _meta: LOOKUP,
      inputSchema: z.object({
        week: weekParam,
        box_number: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe('This box’s number, counting every box ever delivered — overrides the number derived from next_box_number.'),
        next_box_number: nextBoxNumberParam,
        view: hfView('compact keeps the essentials; full adds every allowlisted field (prices, slot handle, sub-status) and the whole estimate.'),
      }),
    },
    async ({ week, box_number, next_box_number, view }) => {
      const account = await loadAccount(client);
      const [rawDelivery, upcoming] = await Promise.all([
        client.getDelivery(account.subscriptionId, week),
        client.listDeliveries(),
      ]);
      const delivery = projectDelivery(rawDelivery);
      const running = delivery.status === 'running';
      const menu = delivery.status === 'skipped' ? undefined : await attempt(() => readMenu(client, account, delivery, week));
      const selection = menu?.ok ? menu.value.selected.map(compactSelection) : undefined;

      let estimate;
      if (running) {
        const boxNumber =
          box_number ??
          boxNumbers((upcoming.items ?? []).map(projectDelivery), next_box_number ?? DEFAULT_NEXT_BOX_NUMBER).get(week);
        estimate = estimateFor(delivery, selection ?? [], account, boxNumber);
        if (!selection) {
          const note = 'The menu could not be read, so premium upcharges are not included.';
          estimate.warning = estimate.warning ? `${estimate.warning} ${note}` : note;
        }
      }

      const full = resolveView(view, HF_VIEWS) === 'full';
      return minifiedResult({
        ...(full
          ? delivery
          : {
              ...compactDelivery(delivery),
              week,
              productName: delivery.productName,
              deliveryDay: delivery.deliveryDay,
              allowedActions: delivery.allowedActions,
              oneOffDaySlots: delivery.oneOffDaySlots,
            }),
        ...(selection ? { selection } : {}),
        ...(menu && !menu.ok ? { selectionError: menu.reason } : {}),
        ...(estimate ? { estimate: full ? estimate : compactEstimate(estimate) } : {}),
      });
    },
  );

  server.registerTool(
    'hf_get_menu',
    {
      description:
        'Read the HelloFresh menu for a delivery week at that week’s box size: every recipe with its index (used to ' +
        'pick meals), category, seafood kind (shrimp/fish/other), kid-friendly, quick, total minutes, premium ' +
        'upcharge per serving and per box, protein swaps (variants) and what is currently picked. Filters: ' +
        'seafood_only, kid_friendly, max_minutes, max_premium_per_serving, selected_only.',
      annotations: readOnly('HelloFresh: get menu'),
      _meta: foodMeta('lookup', { aliases: ['hellofresh menu', 'hellofresh recipes', 'meal options'] }),
      inputSchema: z.object({
        week: weekParam,
        seafood_only: z.boolean().optional().describe('Only seafood dishes (a course is kept for a seafood protein swap).'),
        kid_friendly: z.boolean().optional().describe('Only recipes HelloFresh tags kid friendly.'),
        max_minutes: z.number().int().positive().optional().describe('Only recipes that take at most this many minutes in total.'),
        max_premium_per_serving: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Highest premium upcharge per serving, in US cents (0 = no premium meals; 699 = up to $6.99).'),
        selected_only: z.boolean().optional().describe('Only the meals currently picked for the week.'),
        view: hfView(
          'compact keeps index, name, category, seafood kind, kid-friendly, quick, minutes, premiums (only when non-zero), ' +
            'selection and swaps; full adds headline, tags, cuisine, label and recipe URL.',
        ),
      }),
    },
    async ({ week, view, ...filters }) => {
      const account = await loadAccount(client);
      const delivery = projectDelivery(await client.getDelivery(account.subscriptionId, week));
      const menu = await readMenu(client, account, delivery, week);
      const meals = applyFilters(menu.meals, filters);
      const active = Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== undefined));
      const full = resolveView(view, HF_VIEWS) === 'full';
      return minifiedResult({
        week,
        box: { sku: delivery.sku, meals: delivery.meals, servings: delivery.servings },
        cutoffDate: delivery.cutoffDate,
        status: delivery.status,
        mealsReady: menu.mealsReady,
        selected: menu.selected.map(compactSelection),
        ...(Object.keys(active).length > 0 ? { filters: active } : {}),
        total: menu.meals.length,
        shown: meals.length,
        meals: meals.map((m) =>
          full ? m : { ...compactMeal(m), ...(m.onlyVariantsMatch ? { onlyVariantsMatch: true } : {}) },
        ),
      });
    },
  );

  server.registerTool(
    'hf_list_box_sizes',
    {
      description:
        'List the HelloFresh box sizes this subscription can switch to — meals per week × people (servings), with ' +
        'the SKU that names it — and mark the current plan size.',
      annotations: readOnly('HelloFresh: list box sizes'),
      _meta: foodMeta('lookup', { aliases: ['box size', 'servings', 'how many meals'] }),
      inputSchema: z.object({
        view: hfView('compact is one flat list sorted by meals then people; full keeps HelloFresh’s product groups.'),
      }),
    },
    async ({ view }) => {
      const account = await loadAccount(client);
      const current = account.subscription.product?.sku;
      const options = await client.getProductOptions(account.subscriptionId);
      const groups = (options.items ?? []).map((g) => ({
        handle: g.handle,
        name: g.name,
        products: (g.products ?? []).flatMap((p) => {
          const size = parseSku(p.handle);
          if (!p.handle || !size) return [];
          const meals = Number(p.specs?.meals ?? size.meals);
          const people = Number(p.specs?.size ?? size.people);
          return [{ sku: p.handle, meals, people, ...(p.handle === current ? { current: true as const } : {}) }];
        }),
      }));
      if (resolveView(view, HF_VIEWS) === 'full') return minifiedResult({ current, groups });
      const sizes = groups.flatMap((g) => g.products).sort((a, b) => a.meals - b.meals || a.people - b.people);
      return minifiedResult({ current, sizes });
    },
  );

  server.registerTool(
    'hf_recent_picks',
    {
      description:
        'List the HelloFresh meals picked in recent weeks — the current week and the weeks_back weeks before it — ' +
        'to avoid repeating a recipe. Best effort: each week’s menu is read separately, and weeks that cannot be ' +
        'read are listed with the reason.',
      annotations: readOnly('HelloFresh: recent picks'),
      _meta: foodMeta('lookup', { aliases: ['recent hellofresh meals', 'what did we have'] }),
      inputSchema: z.object({
        weeks_back: z.number().int().min(0).max(12).optional().describe('How many weeks before through_week to include (default 4).'),
        through_week: weekParam
          .optional()
          .describe('The last week to include, as an ISO week (default: the current week).'),
      }),
    },
    async ({ weeks_back, through_week }) => {
      const account = await loadAccount(client);
      const through = through_week ?? isoWeekOf(todayIso({ now: new Date(now()) }));
      const back = weeks_back ?? 4;
      const weeks = Array.from({ length: back + 1 }, (_, i) => shiftWeek(through, i - back));
      const { weeks: read, recipeNames, unreadable } = await readPicks(client, account, weeks);
      return minifiedResult({
        throughWeek: through,
        weeks: read,
        recipeNames,
        ...(unreadable.length > 0 ? { unreadable } : {}),
      });
    },
  );
}
