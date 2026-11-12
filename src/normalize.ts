// Projections of the raw HelloFresh shapes into what tools return, plus the
// box-total estimate. Subscription and delivery records are projected to an
// ALLOWLIST: the raw records carry the customer's name, email, shipping and
// billing addresses and payment token, none of which may ever be returned.

import type {
  RawDelivery,
  RawDeliveryMenu,
  RawMeal,
  RawModularity,
  RawRecipe,
  RawSubscription,
  VoucherInfo,
} from './types.js';

// ---- small parsers ----------------------------------------------------------

/** `US-CBU-{meals}-{people}-0` → `{meals, people}`. */
export function parseSku(sku: string | undefined): { meals: number; people: number } | undefined {
  const m = /^[A-Z]+-[A-Z]+-(\d+)-(\d+)-\d+$/.exec(sku ?? '');
  return m ? { meals: Number(m[1]), people: Number(m[2]) } : undefined;
}

/** ISO-8601 `PT1H5M` → 65 (minutes, seconds rounded up). */
export function parseDurationMinutes(iso: string | undefined): number | undefined {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso ?? '');
  if (!m || (m[1] === undefined && m[2] === undefined && m[3] === undefined)) return undefined;
  return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0) + Math.ceil(Number(m[3] ?? 0) / 60);
}

export type SeafoodKind = 'shrimp' | 'fish' | 'other';

const SHRIMP = /\b(shrimps?|prawns?)\b/i;
const FISH = /\b(salmon|cod|tilapia|trout|tuna|halibut|haddock|pollock|barramundi|catfish|mahi(?:[- ]mahi)?|branzino|sea bass|swordfish|fish)\b/i;

/** `shrimp` / `fish` from text, or undefined when it names neither (scallops, lobster, crab → the caller's `other`). */
export function seafoodKindOf(text: string): Exclude<SeafoodKind, 'other'> | undefined {
  if (SHRIMP.test(text)) return 'shrimp';
  if (FISH.test(text)) return 'fish';
  return undefined;
}

function toNumber(value: number | string | undefined): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

// ---- subscription -------------------------------------------------------------

export interface ProjectedSubscription {
  id?: string;
  sku?: string;
  meals?: number;
  people?: number;
  unitPriceCents?: number;
  preset?: string;
  /** 1 = Monday. */
  deliveryWeekday?: number;
  /** Weeks between boxes. */
  deliveryInterval?: number;
  deliveryOption?: string;
  deliveryName?: string;
  nextDeliveryWeek?: string;
  nextCutoffDate?: string;
  nextModifiableDeliveryWeek?: string;
  couponCode?: string | null;
  isActive?: boolean;
  pausedAt: string | null;
  canceledAt: string | null;
  voucher?: { code?: string; active: boolean };
}

export function projectSubscription(s: RawSubscription): ProjectedSubscription {
  const size = parseSku(s.product?.sku);
  return {
    id: s.id,
    sku: s.product?.sku,
    meals: size?.meals,
    people: size?.people,
    unitPriceCents: s.product?.unitPrice,
    preset: s.preset,
    deliveryWeekday: s.deliveryWeekday,
    deliveryInterval: s.deliveryInterval,
    deliveryOption: s.deliveryOption?.handle ?? s.deliveryTime,
    deliveryName: s.deliveryOption?.deliveryName,
    nextDeliveryWeek: s.nextDeliveryWeek,
    nextCutoffDate: s.nextCutoffDate,
    nextModifiableDeliveryWeek: s.nextModifiableDeliveryWeek,
    couponCode: s.couponCode,
    isActive: s.isActive,
    pausedAt: s.pausedAt ?? null,
    canceledAt: s.canceledAt ?? null,
    voucher: s.voucherInfo ? { code: s.voucherInfo.code, active: s.voucherInfo.is_active === true } : undefined,
  };
}

// ---- delivery -----------------------------------------------------------------

export type DeliveryStatus = 'running' | 'skipped' | 'delivered' | 'donated' | 'unknown' | (string & {});

const STATUS: Record<string, DeliveryStatus> = {
  RUNNING: 'running',
  PAUSED: 'skipped',
  DELIVERED: 'delivered',
  DONATED: 'donated',
};

export interface ProjectedDelivery {
  /** ISO week, e.g. `2026-W49`. */
  week?: string;
  deliveryDate?: string;
  cutoffDate?: string;
  status: DeliveryStatus;
  subStatus?: string;
  actionable?: boolean;
  meals?: number;
  servings?: number;
  sku?: string;
  productName?: string;
  /** Product only, cents. */
  priceCents?: number;
  /** `specialFee`, cents. */
  feeCents?: number;
  shippingCents?: number;
  deliveryOption?: string;
  deliveryName?: string;
  deliveryDay?: string;
  /** The `allowedActions` that are `true`. */
  allowedActions: string[];
  /** Alternative delivery-day slots for this week (`hf_set_week_delivery_day`). */
  oneOffDaySlots: Array<{ handle?: string; deliveryDate?: string }>;
}

export function projectDelivery(d: RawDelivery): ProjectedDelivery {
  const fromSku = parseSku(d.product?.handle);
  return {
    week: d.id,
    deliveryDate: d.deliveryDate,
    cutoffDate: d.cutoffDate,
    status: d.status ? (STATUS[d.status] ?? d.status.toLowerCase()) : 'unknown',
    subStatus: d.subStatus,
    actionable: d.actionable,
    meals: toNumber(d.product?.specs?.meals) ?? fromSku?.meals,
    servings: toNumber(d.product?.specs?.size) ?? fromSku?.people,
    sku: d.product?.handle,
    productName: d.product?.productName,
    priceCents: d.product?.price,
    feeCents: d.product?.specialFee,
    shippingCents: d.product?.shippingPrice,
    deliveryOption: d.deliveryOption?.handle,
    deliveryName: d.deliveryOption?.deliveryName,
    deliveryDay: d.deliveryOption?.deliveryDay,
    allowedActions: Object.entries(d.allowedActions ?? {})
      .filter(([, allowed]) => allowed === true)
      .map(([name]) => name),
    oneOffDaySlots: (d.availableOneOffOptions ?? []).map((o) => ({ handle: o.handle, deliveryDate: o.deliveryDate })),
  };
}

// ---- menu -----------------------------------------------------------------------

export interface ProjectedVariant {
  index: number;
  /** The swap as the site names it, e.g. `2x Shrimp`. */
  title?: string;
  name?: string;
  category: string | null;
  isSeafood: boolean;
  seafoodKind: SeafoodKind | null;
  premiumPerServingCents: number;
  premiumBoxCents: number;
  selectedQuantity: number;
}

export interface ProjectedMeal {
  index: number;
  name?: string;
  headline?: string;
  category: string | null;
  isSeafood: boolean;
  seafoodKind: SeafoodKind | null;
  kidFriendly: boolean;
  quick: boolean;
  /**
   * The longer of the API's `prepTime` / `totalTime` (its `totalTime` is often
   * the SHORTER of the two, so either alone under-reports).
   */
  totalMinutes?: number;
  premiumPerServingCents: number;
  /** The upcharge for this box size. */
  premiumBoxCents: number;
  selectedQuantity: number;
  tags: string[];
  cuisine?: string;
  label?: string;
  url?: string;
  variants: ProjectedVariant[];
}

export interface SelectedMeal {
  index: number;
  quantity: number;
  name?: string;
  premiumBoxCents: number;
  /** Set when the selected meal is a protein-swap variant of this base course. */
  baseIndex?: number;
}

export interface ProjectedMenu {
  week?: string;
  mealsReady?: boolean;
  /** Base courses (not variants), in menu order. */
  meals: ProjectedMeal[];
  /** Every currently selected meal, variants included. */
  selected: SelectedMeal[];
}

const QUICK_TAGS = new Set(['quick', 'easy-prep']);
const QUICK_MINUTES = 30;

function isSeafoodCategory(category: string | null | undefined): boolean {
  return category === 'Seafood';
}

function kindFor(isSeafood: boolean, ...texts: Array<string | undefined>): SeafoodKind | null {
  if (!isSeafood) return null;
  for (const text of texts) {
    const kind = seafoodKindOf(text ?? '');
    if (kind) return kind;
  }
  return 'other';
}

function premium(meal: RawMeal | undefined): { perServing: number; box: number } {
  return { perServing: meal?.charge?.unitAmount ?? 0, box: meal?.charge?.totalAmount ?? 0 };
}

function minutesOf(recipe: RawRecipe): number | undefined {
  const times = [parseDurationMinutes(recipe.prepTime), parseDurationMinutes(recipe.totalTime)].filter(
    (n): n is number => n !== undefined,
  );
  return times.length > 0 ? Math.max(...times) : undefined;
}

function projectVariant(
  variation: NonNullable<RawModularity['variations']>[number],
  meal: RawMeal | undefined,
): ProjectedVariant {
  const recipe = meal?.recipe ?? {};
  const category = variation.category ?? recipe.category ?? null;
  const isSeafood = isSeafoodCategory(category);
  const charge = premium(meal);
  return {
    index: variation.index,
    title: variation.title,
    name: recipe.name,
    category,
    isSeafood,
    seafoodKind: kindFor(isSeafood, variation.title, `${recipe.name ?? ''} ${recipe.headline ?? ''}`),
    premiumPerServingCents: charge.perServing,
    premiumBoxCents: charge.box,
    selectedQuantity: meal?.selection?.quantity ?? 0,
  };
}

function projectMeal(meal: RawMeal, variants: ProjectedVariant[]): ProjectedMeal {
  const recipe = meal.recipe ?? {};
  const category = recipe.category ?? null;
  const isSeafood = isSeafoodCategory(category);
  const tags = recipe.tags ?? [];
  const totalMinutes = minutesOf(recipe);
  const charge = premium(meal);
  return {
    index: meal.index,
    name: recipe.name,
    headline: recipe.headline,
    category,
    isSeafood,
    seafoodKind: kindFor(isSeafood, `${recipe.name ?? ''} ${recipe.headline ?? ''}`),
    kidFriendly: tags.some((t) => t.type === 'family-friendly'),
    quick: tags.some((t) => QUICK_TAGS.has(t.type ?? '')) || (totalMinutes !== undefined && totalMinutes <= QUICK_MINUTES),
    totalMinutes,
    premiumPerServingCents: charge.perServing,
    premiumBoxCents: charge.box,
    selectedQuantity: meal.selection?.quantity ?? 0,
    tags: [...new Set(tags.map((t) => t.name).filter((n): n is string => typeof n === 'string' && n !== ''))],
    cuisine: recipe.cuisines?.[0]?.name,
    label: recipe.label?.text,
    url: recipe.websiteURL,
    variants,
  };
}

/**
 * Split the week's menu into base courses (with their protein-swap variants
 * nested) and the current selection. A meal whose index appears in another
 * course's `modularity[].variations` is a variant, not a base course.
 */
export function projectMenu(menu: RawDeliveryMenu): ProjectedMenu {
  const meals = menu.meals ?? [];
  const byIndex = new Map(meals.map((m) => [m.index, m]));
  const variationsOf = new Map<number, NonNullable<RawModularity['variations']>>();
  const baseOf = new Map<number, number>();
  for (const mod of menu.modularity ?? []) {
    if (mod.defaultCourseIndex === undefined) continue;
    const variations = (mod.variations ?? []).filter((v) => v.index !== mod.defaultCourseIndex);
    variationsOf.set(mod.defaultCourseIndex, variations);
    for (const v of variations) baseOf.set(v.index, mod.defaultCourseIndex);
  }

  const projected = meals
    .filter((m) => !baseOf.has(m.index))
    .map((m) => projectMeal(m, (variationsOf.get(m.index) ?? []).map((v) => projectVariant(v, byIndex.get(v.index)))));

  const selected: SelectedMeal[] = meals
    .filter((m) => (m.selection?.quantity ?? 0) > 0)
    .map((m) => ({
      index: m.index,
      quantity: m.selection!.quantity!,
      name: m.recipe?.name,
      premiumBoxCents: premium(m).box,
      ...(baseOf.has(m.index) ? { baseIndex: baseOf.get(m.index) } : {}),
    }));

  return { week: menu.week, mealsReady: menu.mealsReady, meals: projected, selected };
}

// ---- box total estimate ------------------------------------------------------------

export interface BoxEstimate {
  /** Always true: there is no single "box total" read; this is computed. */
  estimate: true;
  productCents: number;
  feeCents: number;
  shippingCents: number;
  /** Σ premium upcharge for the box size × quantity. */
  premiumCents: number;
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  voucher?: { code?: string; boxNumber: number; percent: number; appliesTo: string };
  /** Why no (or a reduced) discount was applied. */
  warning?: string;
}

/**
 * Estimate a box total (docs/HELLOFRESH-API.md "Pricing"): product + special
 * fee + shipping + Σ premium upcharges, minus the voucher's percentage for this
 * box number (`applicable_to: 'products'` = product price only, `'both'` =
 * product + shipping + fees). `boxNumber` is 1-based.
 */
export function estimateBoxTotal(
  delivery: Pick<ProjectedDelivery, 'priceCents' | 'feeCents' | 'shippingCents'>,
  selection: ReadonlyArray<{ premiumBoxCents?: number | null; quantity?: number }>,
  voucherInfo: VoucherInfo | null | undefined,
  boxNumber: number,
): BoxEstimate {
  const productCents = delivery.priceCents ?? 0;
  const feeCents = delivery.feeCents ?? 0;
  const shippingCents = delivery.shippingCents ?? 0;
  const premiumCents = selection.reduce((sum, s) => sum + (s.premiumBoxCents ?? 0) * (s.quantity ?? 1), 0);
  const subtotalCents = productCents + feeCents + shippingCents + premiumCents;
  const base: BoxEstimate = {
    estimate: true,
    productCents,
    feeCents,
    shippingCents,
    premiumCents,
    subtotalCents,
    discountCents: 0,
    totalCents: subtotalCents,
  };

  const undiscounted = (warning: string): BoxEstimate => ({ ...base, warning });
  if (!voucherInfo) return undiscounted('No voucher on the subscription: the estimate is undiscounted.');
  const name = voucherInfo.code ?? 'the voucher';
  if (voucherInfo.is_active !== true) return undiscounted(`Voucher ${name} is not active: the estimate is undiscounted.`);
  const type = voucherInfo.discount_type ?? 'percent';
  if (type !== 'percent') return undiscounted(`Voucher ${name} is a "${type}" discount, which is not estimated: the total is undiscounted.`);
  const settings = voucherInfo.discount_settings ?? {};
  const boxCount = settings.box_count;
  if (boxCount !== undefined && boxNumber > boxCount) {
    return undiscounted(`Voucher ${name} covers boxes 1–${boxCount}; this is box ${boxNumber}, so no discount applies.`);
  }
  const rule = settings.discount_rule?.box_rule?.[String(boxNumber)];
  if (!rule) return undiscounted(`Voucher ${name} has no discount for box ${boxNumber}: the estimate is undiscounted.`);

  const appliesTo = rule.applicable_to ?? 'products';
  const percent = (rule.discount_value ?? 0) / 100;
  const discountable = appliesTo === 'both' ? productCents + feeCents + shippingCents : productCents;
  const discountCents = Math.round((discountable * percent) / 100);
  return {
    ...base,
    discountCents,
    totalCents: subtotalCents - discountCents,
    voucher: { code: voucherInfo.code, boxNumber, percent, appliesTo },
  };
}
