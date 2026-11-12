// The promo tracker (hf_promo_status): the subscription's voucher, how many of
// its discounted boxes are used and left, and — for each upcoming running week
// — the REAL discount from HelloFresh's own price calculator (POST /gw/calculate,
// in-tab), with warnings for the things that silently cost money: a running
// week with no discount, a coupon percent that changes week to week, an
// inactive voucher, few discounted boxes left. Read-only. The coupon code is
// the user's own data and is returned; ids and the address never are.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { mapWithConcurrency, minifiedResult, toolAnnotations } from '@chrischall/mcp-utils';
import { projectDelivery, type ProjectedDelivery } from '../normalize.js';
import { foodMeta } from './hints.js';
import {
  PRICE_CONCURRENCY,
  attempt,
  boxNumbering,
  boxNumbers,
  byWeek,
  calculatorGate,
  dateOf,
  hellofreshPrice,
  loadAccount,
  nextBoxNumberParam,
  readMenu,
} from './shared.js';
import type { ToolDeps } from './index.js';

/** Fewer discounted boxes left than this is worth a warning. */
export const LOW_BOXES_LEFT = 4;

interface WeekPrice {
  couponPercent?: number;
  discount?: number;
  grandTotal?: number;
}

type PerWeek = {
  week: string;
  deliveryDate?: string;
  boxNumber: number;
  pastVoucherLimit?: true;
} & ({ price: WeekPrice } | { price: 'unavailable'; reason: string });

export function registerPromoTools(server: McpServer, deps: ToolDeps): void {
  const { client } = deps;
  const now = deps.now ?? Date.now;

  server.registerTool(
    'hf_promo_status',
    {
      description:
        'Track the HelloFresh promo/voucher: the coupon code, whether it is active, its box limit, boxes used and ' +
        'left, and for each upcoming running week the REAL discount from HelloFresh’s own price calculator (coupon ' +
        'percent, discount and grand total, US dollars) — with warnings when a running week gets no discount, the ' +
        'coupon percent changes from the week before, the voucher is inactive, or fewer than 4 discounted boxes are ' +
        'left. Answers "is my HelloFresh discount still applying?".',
      annotations: toolAnnotations({ title: 'HelloFresh: promo status', readOnly: true, idempotent: true, openWorld: true }),
      _meta: foodMeta('lookup', { aliases: ['hellofresh promo', 'hellofresh voucher', 'hellofresh discount', 'coupon'] }),
      inputSchema: z.object({ next_box_number: nextBoxNumberParam }),
    },
    async ({ next_box_number }) => {
      const account = await loadAccount(client);
      const { subscription } = account;
      const voucher = subscription.voucherInfo ?? undefined;
      const active = voucher?.is_active === true;
      const boxLimit = voucher?.discount_settings?.box_count;

      // Boxes used = every box before the next running one (the documented numbering).
      const numbering = boxNumbering(subscription, next_box_number);
      const boxesUsed = numbering.next - 1;
      const boxesUsedBasis =
        next_box_number !== undefined ? 'given' : subscription.firstBoxDelivered === false ? 'exact' : 'assumed';
      const boxesRemaining = boxLimit !== undefined ? Math.max(0, boxLimit - boxesUsed) : undefined;

      const deliveries = ((await client.listDeliveries()).items ?? []).map(projectDelivery).sort(byWeek);
      const numbers = boxNumbers(deliveries, numbering.next);
      const runningWeeks = deliveries.filter((d): d is ProjectedDelivery & { week: string } => d.status === 'running' && !!d.week);

      const gate = calculatorGate();
      const perWeek: PerWeek[] = await mapWithConcurrency(runningWeeks, PRICE_CONCURRENCY, async (d): Promise<PerWeek> => {
        // Every running week is numbered (boxNumbers numbers exactly these).
        const boxNumber = numbers.get(d.week)!;
        const head = {
          week: d.week,
          deliveryDate: dateOf(d.deliveryDate),
          boxNumber,
          ...(boxLimit !== undefined && boxNumber > boxLimit ? { pastVoucherLimit: true as const } : {}),
        };
        // The calculator is sent the week's picks, as the site does; an unreadable menu sends none.
        const menu = await attempt(() => readMenu(client, account, d, d.week));
        const priced = await gate(() =>
          hellofreshPrice(
            client,
            account,
            {
              week: d.week,
              sku: d.sku,
              people: d.servings,
              deliveryOption: d.deliveryOption,
              deliveryDate: d.deliveryDate,
              recipeIndexes: menu.ok ? menu.value.selected.map((m) => m.index) : [],
              premiumCents: undefined,
            },
            now(),
          ),
        );
        if (!priced.ok) return { ...head, price: 'unavailable', reason: priced.reason };
        const { couponPercent, discount, grandTotal } = priced.value;
        const price: WeekPrice = Object.fromEntries(
          Object.entries({ couponPercent, discount, grandTotal }).filter(([, v]) => v !== undefined),
        );
        return { ...head, price };
      });

      const warnings: string[] = [];
      if (!voucher) warnings.push('This subscription has no voucher, so no discount should be expected.');
      else if (!active) warnings.push('The voucher is not active, so no discount should be expected.');
      let previous: { week: string; percent: number } | undefined;
      for (const w of perWeek) {
        if (w.price === 'unavailable') continue;
        const box = ` (box ${w.boxNumber})`;
        if (!((w.price.discount ?? 0) > 0)) {
          const past = w.pastVoucherLimit ? ` — box ${w.boxNumber} is past the voucher’s ${boxLimit}-box limit` : '';
          warnings.push(`${w.week}${box}: HelloFresh’s calculator applies no discount to this running week${past}.`);
        }
        const percent = w.price.couponPercent;
        if (percent === undefined) continue;
        if (previous && previous.percent !== percent) {
          warnings.push(`${w.week}: the coupon percent changes from ${previous.percent}% (${previous.week}) to ${percent}%.`);
        }
        previous = { week: w.week, percent };
      }
      if (boxesRemaining !== undefined && boxesRemaining < LOW_BOXES_LEFT) {
        const assumed = boxesUsedBasis === 'assumed' ? ' (boxes used is an assumption — see boxesUsedNote)' : '';
        warnings.push(`Only ${boxesRemaining} discounted boxes left on the voucher, of ${boxLimit}${assumed}.`);
      }

      return minifiedResult({
        couponCode: subscription.couponCode || voucher?.code || undefined,
        active,
        boxLimit,
        boxesUsed,
        boxesUsedBasis,
        boxesUsedNote: numbering.note,
        boxesRemaining,
        perWeek,
        warnings,
        priceNote:
          'perWeek prices come from HelloFresh’s own price calculator (its checkout price, US dollars; premium recipe ' +
          'upcharges are not part of it). "unavailable" means the calculator could not be read for that week (reason given).',
      });
    },
  );
}
