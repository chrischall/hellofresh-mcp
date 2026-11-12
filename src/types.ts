// Raw HelloFresh web-API shapes, as documented in docs/HELLOFRESH-API.md.
// Only the fields this server reads are typed; everything is optional because
// the API is undocumented and may drop a field at any time. Subscriptions also
// carry the customer's name, email, addresses and payment token — those are
// deliberately NOT typed here, and src/normalize.ts projects to an allowlist.

/** `US-CBU-{meals}-{people}-0` box handle. */
export type ProductSku = string;

export interface VoucherBoxRule {
  /** `'products'` = product price only; `'both'` = product + shipping/fees. */
  applicable_to?: string;
  /** Hundredths of a percent: 6500 = 65 %. */
  discount_value?: number;
}

export interface VoucherInfo {
  code?: string;
  is_active?: boolean;
  discount_type?: string;
  discount_settings?: {
    box_count?: number;
    discount_rule?: { box_rule?: Record<string, VoucherBoxRule | undefined> };
  };
}

export interface RawSubscription {
  id?: string;
  customer?: { id?: number; uuid?: string };
  product?: { sku?: ProductSku; unitPrice?: number; name?: string };
  preset?: string;
  deliveryWeekday?: number;
  deliveryInterval?: number;
  deliveryTime?: string;
  deliveryOption?: { handle?: string; deliveryName?: string };
  nextDeliveryWeek?: string;
  nextCutoffDate?: string;
  nextModifiableDeliveryWeek?: string;
  /** The ISO week of the account's first box. */
  firstDeliveryWeek?: string;
  /** Whether that first box has been delivered (false on a new account: the next running box is box 1). */
  firstBoxDelivered?: boolean;
  customerPlanId?: string;
  couponCode?: string | null;
  pausedAt?: string | null;
  canceledAt?: string | null;
  isActive?: boolean;
  voucherInfo?: VoucherInfo | null;
  /** Only the postcode is typed: the price calculator needs it. It is never returned. */
  shippingAddress?: { postcode?: string } | null;
}

export interface RawDelivery {
  id?: string;
  deliveryDate?: string;
  cutoffDate?: string;
  status?: string;
  subStatus?: string;
  actionable?: boolean;
  allowedActions?: Record<string, unknown>;
  product?: {
    handle?: ProductSku;
    specs?: { meals?: number | string; size?: number | string };
    productName?: string;
    price?: number;
    shippingPrice?: number;
    specialFee?: number;
  };
  deliveryOption?: { handle?: string; deliveryName?: string; deliveryDay?: string };
  availableOneOffOptions?: Array<{ handle?: string; deliveryDate?: string }>;
  subscriptionId?: string;
}

export interface ListOf<T> {
  count?: number;
  items?: T[];
}

export interface ProductOptions {
  items?: Array<{
    handle?: string;
    name?: string;
    products?: Array<{ handle?: ProductSku; specs?: { meals?: number | string; size?: number | string } }>;
  }>;
}

export interface CustomerPlan {
  id?: string;
  planType?: string;
  planItems?: Array<{ productHandle?: ProductSku; priceSetId?: string }>;
  legacySubscriptionId?: string;
}

export interface MenuWeeks {
  weeks?: string[];
}

export interface RawTag {
  name?: string;
  type?: string;
}

export interface RawRecipe {
  id?: string;
  name?: string;
  headline?: string;
  prepTime?: string;
  totalTime?: string;
  websiteURL?: string;
  label?: { text?: string; handle?: string } | null;
  tags?: RawTag[];
  cuisines?: Array<{ name?: string; type?: string }> | null;
  category?: string | null;
}

export interface RawMeal {
  recipeFamily?: string;
  index: number;
  recipe?: RawRecipe;
  selection?: { limit?: number; quantity?: number } | null;
  charge?: { label?: string; unitAmount?: number; totalAmount?: number; reason?: string; strategy?: string } | null;
}

export interface RawModularity {
  defaultCourseIndex?: number;
  defaultCategory?: string | null;
  noVariationsDefaultTitle?: string;
  variations?: Array<{ index: number; title?: string; category?: string | null }>;
}

export interface RawDeliveryMenu {
  id?: string;
  week?: string;
  meals?: RawMeal[];
  mealsReady?: boolean;
  modularity?: RawModularity[];
}

/** One meal line of a cart PUT. */
export interface CartMeal {
  index: number;
  quantity: number;
}

/**
 * `POST /gw/calculate`'s answer (US dollars). It also carries the customer and
 * subscription ids and the shipping address — deliberately NOT typed here:
 * `projectCalculation` keeps only the money fields.
 */
export interface RawCalculation {
  grandTotal?: number;
  subTotal?: number;
  taxAmount?: number;
  shippingAmount?: number;
  shippingDiscountAmount?: number;
  discountAmount?: number;
  couponCode?: string | null;
  currency?: string;
  products?: Array<{ couponPercent?: number; couponCode?: string | null }> | null;
}
