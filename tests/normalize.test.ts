import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  estimateBoxTotal,
  parseDurationMinutes,
  parseSku,
  projectDelivery,
  projectMenu,
  projectSubscription,
  seafoodKindOf,
  type ProjectedDelivery,
} from '../src/normalize.js';
import type { ListOf, RawDelivery, RawDeliveryMenu, RawSubscription, VoucherInfo } from '../src/types.js';

const fixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as T;

// menu-W49.json: a trimmed REAL public W49 menu. subscription/deliveries: SYNTHETIC.
const menu = fixture<RawDeliveryMenu>('menu-W49.json');
const sub = fixture<RawSubscription>('subscription.json');
const deliveries = fixture<ListOf<RawDelivery>>('deliveries.json').items!;

describe('parseSku / parseDurationMinutes / seafoodKindOf', () => {
  it('parses box handles', () => {
    expect(parseSku('US-CBU-2-6-0')).toEqual({ meals: 2, people: 6 });
    expect(parseSku('US-CBU-3-4-0')).toEqual({ meals: 3, people: 4 });
    expect(parseSku('garbage')).toBeUndefined();
    expect(parseSku(undefined)).toBeUndefined();
  });

  it('parses ISO-8601 durations to minutes', () => {
    expect(parseDurationMinutes('PT10M')).toBe(10);
    expect(parseDurationMinutes('PT1H')).toBe(60);
    expect(parseDurationMinutes('PT1H5M')).toBe(65);
    expect(parseDurationMinutes('PT0S')).toBe(0);
    expect(parseDurationMinutes('PT90S')).toBe(2);
    expect(parseDurationMinutes('ten minutes')).toBeUndefined();
    expect(parseDurationMinutes('PT')).toBeUndefined();
    expect(parseDurationMinutes(undefined)).toBeUndefined();
  });

  it('classifies seafood: shrimp/prawn, the fish list, everything else other', () => {
    expect(seafoodKindOf('Pesto Shrimp Linguine')).toBe('shrimp');
    expect(seafoodKindOf('Garlic Prawns')).toBe('shrimp');
    expect(seafoodKindOf('Chesapeake Tilapia & Corn Chowder')).toBe('fish');
    for (const fish of ['salmon', 'cod', 'trout', 'tuna', 'halibut', 'haddock', 'pollock', 'barramundi', 'catfish', 'mahi', 'branzino', 'sea bass', 'swordfish']) {
      expect(seafoodKindOf(`Seared ${fish} bowls`)).toBe('fish');
    }
    expect(seafoodKindOf('Seared Scallops')).toBeUndefined();
    expect(seafoodKindOf('Thai Lobster Coconut Curry')).toBeUndefined();
    expect(seafoodKindOf('Steak au Poivre & Garlic Herb Shrimp')).toBe('shrimp');
    expect(seafoodKindOf('Codfather')).toBeUndefined();
  });
});

describe('projectSubscription', () => {
  it('projects to the allowlist (no name, email, address, payment, customer ids)', () => {
    const p = projectSubscription(sub);
    expect(p).toEqual({
      id: '90000001',
      sku: 'US-CBU-2-6-0',
      meals: 2,
      people: 6,
      unitPriceCents: 14748,
      preset: 'pescatarian',
      deliveryWeekday: 1,
      deliveryInterval: 1,
      deliveryOption: 'US-1-0800-2000',
      deliveryName: 'Monday 8AM-8PM',
      nextDeliveryWeek: '2026-W49',
      nextCutoffDate: '2026-11-25T23:59:59-05:00',
      nextModifiableDeliveryWeek: '2026-W49',
      couponCode: 'EXAMPLE65',
      isActive: true,
      pausedAt: null,
      canceledAt: null,
      voucher: { code: 'EXAMPLE65', active: true },
    });
    const text = JSON.stringify(p);
    for (const secret of ['Pat', 'Example St', 'pat@example.com', 'tok_synthetic', '12345678', '00000000-0000', '11111111-2222']) {
      expect(text).not.toContain(secret);
    }
  });

  it('copes with a sparse subscription', () => {
    expect(projectSubscription({ id: '1', deliveryTime: 'US-2-0800-2000' })).toEqual({
      id: '1',
      deliveryOption: 'US-2-0800-2000',
      pausedAt: null,
      canceledAt: null,
    });
  });
});

describe('projectDelivery', () => {
  it('projects a running week', () => {
    const p = projectDelivery(deliveries[0]!);
    expect(p).toEqual({
      week: '2026-W49',
      deliveryDate: '2026-11-30T00:00:00-05:00',
      cutoffDate: '2026-11-25T23:59:59-05:00',
      status: 'running',
      subStatus: 'MEALS_SELECTED',
      actionable: true,
      meals: 2,
      servings: 6,
      sku: 'US-CBU-2-6-0',
      productName: '2 meals for 6 people',
      priceCents: 14748,
      feeCents: 1299,
      shippingCents: 0,
      deliveryOption: 'US-1-0800-2000',
      deliveryName: 'Monday 8AM-8PM',
      deliveryDay: 'Monday',
      allowedActions: ['mealSwap', 'pause', 'oneOffChange', 'updateDeliveryWeekday'],
      oneOffDaySlots: [
        { handle: 'US-2-0800-2000', deliveryDate: '2026-12-01T00:00:00-05:00' },
        { handle: 'US-7-0800-2000', deliveryDate: '2026-11-29T00:00:00-05:00' },
      ],
    });
    const text = JSON.stringify(p);
    for (const hidden of ['Example St', 'ORDER-SYNTHETIC', 'tracking', '90000001']) expect(text).not.toContain(hidden);
  });

  it('maps statuses (PAUSED → skipped) and string specs', () => {
    const skipped = projectDelivery(deliveries[1]!);
    expect(skipped.status).toBe('skipped');
    expect(skipped.meals).toBe(2);
    expect(skipped.servings).toBe(2);
    expect(skipped.allowedActions).toEqual(['pause']);
    expect(skipped.oneOffDaySlots).toEqual([]);
    expect(projectDelivery(deliveries[2]!).status).toBe('delivered');
    expect(projectDelivery({ status: 'DONATED' }).status).toBe('donated');
    expect(projectDelivery({ status: 'SOMETHING_NEW' }).status).toBe('something_new');
    expect(projectDelivery({}).status).toBe('unknown');
  });

  it('falls back to the sku for meals/servings when specs are missing', () => {
    const p = projectDelivery(deliveries[2]!);
    expect(p.meals).toBe(2);
    expect(p.servings).toBe(6);
    expect(projectDelivery({ product: { specs: { meals: 'x' } } }).meals).toBeUndefined();
  });
});

describe('projectMenu (real W49 menu, trimmed)', () => {
  const p = projectMenu(menu);
  const meal = (index: number) => p.meals.find((m) => m.index === index)!;

  it('lists base courses only, with protein-swap variants nested', () => {
    expect(p.week).toBe('2026-W49');
    expect(p.mealsReady).toBe(true);
    expect(p.meals).toHaveLength(15);
    expect(p.meals.map((m) => m.index)).not.toContain(560);
    expect(meal(67).variants.map((v) => v.index)).toEqual([560, 558, 565, 567]);
    expect(meal(71).variants).toEqual([]);
  });

  it('projects #67 (selected shrimp)', () => {
    expect(meal(67)).toMatchObject({
      index: 67,
      name: 'Pesto Shrimp Linguine with Lemony Panko Topping',
      category: 'Seafood',
      isSeafood: true,
      seafoodKind: 'shrimp',
      kidFriendly: false,
      quick: true,
      totalMinutes: 20,
      premiumPerServingCents: 0,
      premiumBoxCents: 0,
      selectedQuantity: 1,
      cuisine: 'Italian',
      label: 'GLP-1 Support',
      url: 'https://www.hellofresh.com/recipes/pesto-shrimp-linguine-with-lemony-panko-topping-6aa7ffd387970cc2cf3bf1f9',
    });
    expect(meal(67).tags).toContain('Quick');
  });

  it('projects #71 (selected fish, no cuisine)', () => {
    expect(meal(71)).toMatchObject({ isSeafood: true, seafoodKind: 'fish', selectedQuantity: 1, cuisine: undefined });
  });

  it('projects a premium seafood meal and a family-friendly one', () => {
    expect(meal(47)).toMatchObject({ seafoodKind: 'fish', premiumPerServingCents: 1499, premiumBoxCents: 8994, selectedQuantity: 0 });
    expect(meal(12)).toMatchObject({ seafoodKind: 'shrimp', kidFriendly: true, premiumPerServingCents: 1299 });
    expect(meal(78).seafoodKind).toBe('other');
    expect(meal(16).seafoodKind).toBe('other');
  });

  it('marks non-seafood meals and a missing category', () => {
    expect(meal(1)).toMatchObject({ isSeafood: false, seafoodKind: null, kidFriendly: true, category: 'Poultry' });
    expect(meal(14)).toMatchObject({ isSeafood: false, seafoodKind: null, category: null });
  });

  it('projects variants with their own premium and seafood kind', () => {
    const [shrimp2x, salmon, chicken, lobster] = meal(67).variants;
    expect(shrimp2x).toEqual({
      index: 560,
      title: '2x Shrimp',
      name: 'Pesto 2x Shrimp Linguine with Lemony Panko Topping',
      category: 'Seafood',
      isSeafood: true,
      seafoodKind: 'shrimp',
      premiumPerServingCents: 499,
      premiumBoxCents: 2994,
      selectedQuantity: 0,
    });
    expect(salmon!.seafoodKind).toBe('fish');
    expect(chicken).toMatchObject({ isSeafood: false, seafoodKind: null });
    expect(lobster!.seafoodKind).toBe('other');
  });

  it('lists the current selection', () => {
    expect(p.selected).toEqual([
      { index: 67, quantity: 1, name: 'Pesto Shrimp Linguine with Lemony Panko Topping', premiumBoxCents: 0 },
      { index: 71, quantity: 1, name: 'Chesapeake Tilapia & Corn Chowder', premiumBoxCents: 0 },
    ]);
  });

  it('reports a selected variant against its base course', () => {
    const m: RawDeliveryMenu = {
      week: '2026-W49',
      meals: [
        { index: 1, recipe: { name: 'Base', category: 'Seafood' } },
        { index: 2, recipe: { name: 'Base 2x Shrimp', category: 'Seafood' }, selection: { quantity: 2 }, charge: { unitAmount: 100, totalAmount: 600 } },
      ],
      modularity: [
        { defaultCourseIndex: 1, variations: [{ index: 2, title: '2x Shrimp' }, { index: 3, title: 'Ghost', category: 'Poultry' }, { index: 4 }, { index: 5, category: 'Seafood' }] },
        { variations: [{ index: 1 }] },
        { defaultCourseIndex: 2 },
      ],
    };
    const out = projectMenu(m);
    expect(out.meals).toHaveLength(1);
    expect(out.meals[0]!.variants[2]).toMatchObject({ index: 4, category: null, isSeafood: false });
    expect(out.meals[0]!.variants[3]).toMatchObject({ index: 5, isSeafood: true, seafoodKind: 'other' });
    expect(out.meals[0]!.variants[1]).toEqual({
      index: 3,
      title: 'Ghost',
      name: undefined,
      category: 'Poultry',
      isSeafood: false,
      seafoodKind: null,
      premiumPerServingCents: 0,
      premiumBoxCents: 0,
      selectedQuantity: 0,
    });
    expect(out.selected).toEqual([{ index: 2, quantity: 2, name: 'Base 2x Shrimp', premiumBoxCents: 600, baseIndex: 1 }]);
  });

  it('tolerates an empty menu and meals without a recipe', () => {
    expect(projectMenu({})).toEqual({ week: undefined, mealsReady: undefined, meals: [], selected: [] });
    const bare = projectMenu({ meals: [{ index: 9 }, { index: 10, recipe: { tags: [{ name: 'Untyped' }] } }] });
    expect(bare.meals[1]).toMatchObject({ quick: false, tags: ['Untyped'] });
    expect(bare.meals[0]).toMatchObject({ index: 9, isSeafood: false, seafoodKind: null, tags: [], quick: false, totalMinutes: undefined });
  });
});

describe('estimateBoxTotal', () => {
  const sixPerson = projectDelivery(deliveries[0]!);
  const twoPerson = projectDelivery(deliveries[1]!);
  const voucher = sub.voucherInfo!;

  it('a 6-person box, box 2: product + fee, 15% off products only', () => {
    expect(estimateBoxTotal(sixPerson, [], voucher, 2)).toEqual({
      estimate: true,
      productCents: 14748,
      feeCents: 1299,
      shippingCents: 0,
      premiumCents: 0,
      subtotalCents: 16047,
      discountCents: 2212,
      totalCents: 13835,
      voucher: { code: 'EXAMPLE65', boxNumber: 2, percent: 15, appliesTo: 'products' },
    });
  });

  it('a 2-person box: $59.96 + $12.99', () => {
    expect(estimateBoxTotal(twoPerson, [], voucher, 3).subtotalCents).toBe(7295);
  });

  it("adds premium upcharges ×quantity; 'both' discounts product + fees", () => {
    const e = estimateBoxTotal(sixPerson, [{ premiumBoxCents: 8994 }, { premiumBoxCents: 600, quantity: 2 }, { premiumBoxCents: null }], voucher, 1);
    expect(e.premiumCents).toBe(10194);
    expect(e.subtotalCents).toBe(16047 + 10194);
    expect(e.discountCents).toBe(Math.round(16047 * 0.65));
    expect(e.totalCents).toBe(e.subtotalCents - e.discountCents);
    expect(e.voucher?.appliesTo).toBe('both');
  });

  it('warns when there is no voucher, it is inactive, not a percent, past its box count, or has no rule', () => {
    expect(estimateBoxTotal(sixPerson, [], undefined, 2)).toMatchObject({ discountCents: 0, warning: expect.stringMatching(/no voucher/i) });
    expect(estimateBoxTotal(sixPerson, [], null, 2).warning).toMatch(/no voucher/i);
    expect(estimateBoxTotal(sixPerson, [], { ...voucher, is_active: false }, 2).warning).toMatch(/not active/);
    expect(estimateBoxTotal(sixPerson, [], { ...voucher, discount_type: 'fixed' }, 2).warning).toMatch(/fixed/);
    const past = estimateBoxTotal(sixPerson, [], voucher, 53);
    expect(past.discountCents).toBe(0);
    expect(past.warning).toMatch(/boxes 1–52.*box 53/);
    expect(estimateBoxTotal(sixPerson, [], voucher, 4).warning).toMatch(/no discount for box 4/);
    const noCount: VoucherInfo = { code: 'X', is_active: true, discount_type: 'percent', discount_settings: {} };
    expect(estimateBoxTotal(sixPerson, [], noCount, 1).warning).toMatch(/no discount for box 1/);
    expect(estimateBoxTotal(sixPerson, [], { code: 'Y', is_active: true }, 1).warning).toMatch(/no discount for box 1/);
    const noValue: VoucherInfo = { is_active: true, discount_settings: { discount_rule: { box_rule: { '1': {} } } } };
    expect(estimateBoxTotal(sixPerson, [], noValue, 1)).toMatchObject({ discountCents: 0, voucher: { code: undefined, percent: 0, appliesTo: 'products' } });
  });

  it('treats missing prices as zero', () => {
    const empty: ProjectedDelivery = projectDelivery({});
    expect(estimateBoxTotal(empty, [], undefined, 1)).toMatchObject({ productCents: 0, feeCents: 0, shippingCents: 0, totalCents: 0 });
  });
});
