// The HelloFresh web-API client: every endpoint in docs/HELLOFRESH-API.md,
// through ONE private `request()`. Each call is a plain Node fetch with the
// session's Bearer (the session owns the token lifecycle and the 401 replay).
//
// Failure mapping:
//  - a Cloudflare (or other edge) page, as an error status or a 200 → EdgeBlockedError;
//  - a 2xx body that is not JSON → UpstreamFormatError (via parseJsonBody);
//  - a 4xx → McpToolError carrying the status (401/403: credential_rejected);
//  - a WRITE that was sent and then timed out, dropped, broke off mid-body or
//    was answered with a 5xx → WriteOutcomeUnknownError (the write may have
//    happened: check before retrying);
//  - a READ that timed out / could not connect → McpToolError kind timeout / transport.
// Every request is bounded by a timeout and honours the tool call's
// cancellation (`currentCallSignal()`, folded in by withAmbientCancellation).

import {
  EdgeBlockedError,
  McpToolError,
  UpstreamHttpError,
  WriteOutcomeUnknownError,
  apiPath,
  buildQueryString,
  currentCallSignal,
  describeTransportFailure,
  detectEdgeBlock,
  formatApiError,
  messageOf,
  parseJsonBody,
  truncateErrorMessage,
  withAmbientCancellation,
} from '@chrischall/mcp-utils';
import { WEB_ORIGIN, signInHint } from './session.js';
import type {
  CartMeal,
  CustomerPlan,
  ListOf,
  MenuWeeks,
  ProductOptions,
  RawDelivery,
  RawDeliveryMenu,
  RawFavorites,
  RawRatings,
  RawSubscription,
} from './types.js';

export const API_BASE = `${WEB_ORIGIN}/gw`;
export const SERVICE = 'HelloFresh';
/** US market only. */
export const COUNTRY = 'US';
export const LOCALE = 'en-US';
/** Bound on each request, headers AND body. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** The slice of HelloFreshSession the client needs. */
export interface ClientSession {
  withAuth(call: (accessToken: string) => Promise<Response>): Promise<Response>;
  /** Scrub token values out of text bound for an error message. */
  redact(text: string): string;
}

export interface HelloFreshClientOptions {
  session: ClientSession;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

type Method = 'GET' | 'PUT' | 'PATCH' | 'POST' | 'DELETE';

/** The ratings scales (`v3` is the 5-star one). */
export type RatingScale = 'v2' | 'v3';

interface RequestOptions {
  /** Query params; `country`/`locale` are added unless `locale: false`. */
  query?: Record<string, unknown>;
  /** Skip the default `country=US&locale=en-US` (endpoints with their own query). */
  locale?: false;
  body?: unknown;
  /** The path as named in errors, ids replaced by placeholders (subscription/plan ids are never echoed). */
  route?: string;
  /** Accept any 2xx body (empty, text or JSON) and return undefined — an edge page is still refused. */
  discardBody?: boolean;
}

export interface DeliveryMenuQuery {
  subscriptionId: string;
  week: string;
  /** People (the box's `specs.size`). */
  servings: number;
  sku: string;
  customerPlanId: string;
}

export interface SelectMealsRequest {
  week: string;
  subscriptionId: string;
  /** `subscription.customer.id` — the numeric customer id. */
  customerId: number;
  sku: string;
  /** `subscription.preset`. */
  preference: string;
  /** The COMPLETE selection (replaces, does not add). */
  meals: CartMeal[];
}

export interface DeliveryStatusRequest {
  subscriptionId: string;
  week: string;
  deliveryDate: string;
  cutoffDate: string;
  /** `PAUSED` = skip, `RUNNING` = unskip. */
  status: 'PAUSED' | 'RUNNING';
}

export interface WeekSizeRequest {
  subscriptionId: string;
  week: string;
  /** The new box handle, `US-CBU-{meals}-{people}-0`. */
  sku: string;
}

export interface OneOffRequest {
  subscriptionId: string;
  week: string;
  /** The week's CURRENT box handle: a different one is silently ignored (size changes go through setWeekSize). */
  sku: string;
  deliveryOption: string;
}

export interface PlanDeliveryDetails {
  deliveryOption: string;
  /** Weeks between boxes (1–4). */
  deliveryInterval: number;
}

export class HelloFreshClient {
  private readonly session: ClientSession;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: HelloFreshClientOptions) {
    this.session = opts.session;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  // ---- reads ---------------------------------------------------------------

  listSubscriptions(): Promise<ListOf<RawSubscription>> {
    return this.request('GET', '/api/customers/me/subscriptions');
  }

  getSubscription(subscriptionId: string): Promise<RawSubscription> {
    return this.request('GET', apiPath`/api/subscriptions/${subscriptionId}`, { route: '/api/subscriptions/{id}' });
  }

  /** Upcoming deliveries (about the next 7 weeks). */
  listDeliveries(): Promise<ListOf<RawDelivery>> {
    return this.request('GET', '/api/customers/me/deliveries');
  }

  getDelivery(subscriptionId: string, week: string): Promise<RawDelivery> {
    return this.request('GET', apiPath`/api/subscriptions/${subscriptionId}/delivery_dates/${week}`, {
      route: `/api/subscriptions/{id}/delivery_dates/${week}`,
    });
  }

  getProductOptions(subscriptionId: string): Promise<ProductOptions> {
    return this.request('GET', apiPath`/api/subscriptions/${subscriptionId}/product_options`, {
      route: '/api/subscriptions/{id}/product_options',
    });
  }

  listPlans(): Promise<CustomerPlan[]> {
    return this.request('GET', '/api/plans');
  }

  listMenuWeeks(): Promise<MenuWeeks> {
    return this.request('GET', '/menus-service/weeks');
  }

  /** The week's menu for a box size (without `servings` + `product-sku` the API answers 400). */
  getDeliveryMenu(q: DeliveryMenuQuery): Promise<RawDeliveryMenu> {
    return this.request('GET', '/my-deliveries/menu', {
      locale: false,
      query: {
        subscription: q.subscriptionId,
        week: q.week,
        locale: LOCALE,
        servings: q.servings,
        'product-sku': q.sku,
        customerPlanId: q.customerPlanId,
        'exclude-feedback': 'true',
      },
    });
  }

  /** The customer's favourite recipes (items carry the customer uuid: project before returning). */
  listFavorites(): Promise<RawFavorites> {
    return this.request('GET', '/cfs/v2/favorites/recipe');
  }

  /** The customer's recipe ratings on one scale. The item shape is not yet observed: parse defensively. */
  listRatings(scale: RatingScale): Promise<RawRatings> {
    // The documented query uses a lowercase country here.
    return this.request('GET', `/cfs/${scale}/ratings/recipe`, { locale: false, query: { country: 'us', locale: LOCALE } });
  }

  // ---- writes (docs/HELLOFRESH-API.md "Writes" 1–5, 3 split into 3a size / 3b day) -------------------------
  // Each write is built by an exported pure builder (below), so the confirm
  // preview of a write and the request actually sent are the same object.

  /** Write 1: replace the week's meal selection. */
  selectMeals(r: SelectMealsRequest): Promise<{ hasSeamlessDowngraded?: boolean }> {
    return this.send(selectMealsRequest(r));
  }

  /** Write 2: skip (`PAUSED`) or unskip (`RUNNING`) one week. */
  setDeliveryStatus(r: DeliveryStatusRequest): Promise<ListOf<RawDelivery>> {
    return this.send(deliveryStatusRequest(r));
  }

  /** Write 3a: one week's box size. Any 2xx is success (the body may be empty or not JSON). */
  async setWeekSize(r: WeekSizeRequest): Promise<void> {
    await this.send(weekSizeRequest(r), { discardBody: true });
  }

  /** Write 3b: one week's delivery slot (`deliveryOption`). Does NOT change the size: a new `sku` is ignored. */
  changeOneOff(r: OneOffRequest): Promise<ListOf<RawDelivery>> {
    return this.send(oneOffRequest(r));
  }

  /** Write 4: permanent box size. 204, no body. */
  async setPlanProduct(customerPlanId: string, productHandle: string): Promise<void> {
    await this.send(planProductRequest(customerPlanId, productHandle));
  }

  /** Write 5: permanent delivery slot + frequency (send BOTH). 200, empty body. */
  async changePlanDeliveryDetails(customerPlanId: string, details: PlanDeliveryDetails): Promise<void> {
    await this.send(planDeliveryDetailsRequest(customerPlanId, details));
  }

  /** Favourite a recipe (`recipe.id`). 204, no body. */
  async addFavorite(recipeId: string, week?: string): Promise<void> {
    await this.send(addFavoriteRequest(recipeId, week), { discardBody: true });
  }

  /** Un-favourite a recipe (`recipe.id`). 204, no body. */
  async removeFavorite(recipeId: string): Promise<void> {
    await this.send(removeFavoriteRequest(recipeId), { discardBody: true });
  }

  private send<T>(w: WriteRequest, opts: Pick<RequestOptions, 'discardBody'> = {}): Promise<T> {
    return this.request(w.method, w.path, { locale: false, query: w.query, body: w.body, route: w.route, ...opts });
  }

  // ---- the one request -------------------------------------------------------

  private async request<T>(method: Method, path: string, opts: RequestOptions = {}): Promise<T> {
    const query = { ...(opts.locale === false ? {} : { country: COUNTRY, locale: LOCALE }), ...opts.query };
    const url = `${API_BASE}${path}${buildQueryString(query)}`;
    const isWrite = method !== 'GET';
    // One timer per request, armed until the body is read (each 401 replay gets a fresh one).
    let timer = AbortSignal.timeout(this.timeoutMs);
    const fail = (err: unknown) => this.transportError(err, method, url, isWrite, timer.aborted);

    const res = await this.session.withAuth(async (token) => {
      timer = AbortSignal.timeout(this.timeoutMs);
      const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json' };
      if (opts.body !== undefined) headers['content-type'] = 'application/json';
      try {
        return await this.fetchImpl(url, {
          method,
          headers,
          ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
          signal: withAmbientCancellation(timer),
        });
      } catch (err) {
        throw fail(err);
      }
    });

    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      throw fail(err);
    }

    const where = { service: SERVICE, method, path: opts.route ?? path };
    if (!res.ok) {
      const edge = detectEdgeBlock({ status: res.status, headers: res.headers, body: text });
      if (edge) throw new EdgeBlockedError(res.status, edge.vendor, where);
      const message = formatApiError(res.status, method, where.path, this.session.redact(text), { service: SERVICE, max: 300 });
      if (isWrite && res.status >= 500) {
        throw new WriteOutcomeUnknownError(SERVICE, method, { cause: new UpstreamHttpError(res.status, message) });
      }
      const rejected = res.status === 401 || res.status === 403;
      throw new McpToolError(message, {
        status: res.status,
        kind: rejected ? 'credential_rejected' : 'http',
        ...(res.status === 401 ? { hint: signInHint() } : {}),
      });
    }
    if (opts.discardBody) {
      const edge = detectEdgeBlock({ status: res.status, headers: res.headers, body: text });
      if (edge) throw new EdgeBlockedError(res.status, edge.vendor, where);
      return undefined as T;
    }
    return parseJsonBody<T>(text, { ...where, status: res.status, headers: res.headers });
  }

  private transportError(err: unknown, method: Method, url: string, isWrite: boolean, timedOut: boolean): unknown {
    if (isWrite) {
      return new WriteOutcomeUnknownError(SERVICE, method, {
        cause: err,
        ...(timedOut ? { timeoutMs: this.timeoutMs } : {}),
      });
    }
    if (timedOut) {
      return new McpToolError(`${SERVICE} did not answer ${method} in time (${this.timeoutMs} ms).`, { kind: 'timeout', cause: err });
    }
    // The caller cancelled: surface its own abort reason, unchanged.
    if (currentCallSignal()?.aborted) return err;
    return (
      describeTransportFailure(err, url, SERVICE) ??
      new McpToolError(`Could not reach ${SERVICE}: ${truncateErrorMessage(messageOf(err), 200)}`, { kind: 'transport', cause: err })
    );
  }
}

// ---- write builders ---------------------------------------------------------------

/** One write exactly as it is sent: `path` is relative to API_BASE, `query` is complete. */
export interface WriteRequest {
  method: Exclude<Method, 'GET'>;
  path: string;
  query: Record<string, string | number>;
  body: unknown;
  /** The path as named in errors (subscription/plan ids replaced by placeholders). */
  route: string;
}

const LOCALE_QUERY = { country: COUNTRY, locale: LOCALE } as const;

export function selectMealsRequest(r: SelectMealsRequest): WriteRequest {
  return {
    method: 'PUT',
    path: apiPath`/v1/carts/${r.week}`,
    route: `/v1/carts/${r.week}`,
    query: {
      subscription: r.subscriptionId,
      customer: r.customerId,
      week: r.week,
      'product-sku': r.sku,
      preference: r.preference,
      update_quantity: 'false',
      ignore_addons: 'false',
    },
    body: { extras: [], meals: r.meals },
  };
}

export function deliveryStatusRequest(r: DeliveryStatusRequest): WriteRequest {
  return {
    method: 'PATCH',
    path: apiPath`/api/subscriptions/${r.subscriptionId}/delivery_dates/${r.week}`,
    route: `/api/subscriptions/{id}/delivery_dates/${r.week}`,
    query: { ...LOCALE_QUERY },
    body: {
      delivery: {
        id: r.week,
        subscriptionId: r.subscriptionId,
        deliveryDate: r.deliveryDate,
        cutoffDate: r.cutoffDate,
        status: r.status,
      },
    },
  };
}

export function weekSizeRequest(r: WeekSizeRequest): WriteRequest {
  return {
    method: 'PUT',
    path: apiPath`/carts/${r.week}/size`,
    route: `/carts/${r.week}/size`,
    query: { ...LOCALE_QUERY, subscription: r.subscriptionId },
    body: { productHandle: r.sku, hfMarketCode: COUNTRY },
  };
}

export function oneOffRequest(r: OneOffRequest): WriteRequest {
  return {
    method: 'POST',
    path: apiPath`/api/subscriptions/${r.subscriptionId}/oneoff`,
    route: '/api/subscriptions/{id}/oneoff',
    query: { ...LOCALE_QUERY },
    body: { id: r.subscriptionId, week: r.week, sku: r.sku, delivery_option: r.deliveryOption, source: 'one-off' },
  };
}

export function planProductRequest(customerPlanId: string, productHandle: string): WriteRequest {
  return {
    method: 'PATCH',
    path: apiPath`/api/plans/${customerPlanId}`,
    route: '/api/plans/{planId}',
    query: { ...LOCALE_QUERY },
    body: { productHandle },
  };
}

export function planDeliveryDetailsRequest(customerPlanId: string, details: PlanDeliveryDetails): WriteRequest {
  return {
    method: 'POST',
    path: apiPath`/api/plans/${customerPlanId}/changePlanDeliveryDetails`,
    route: '/api/plans/{planId}/changePlanDeliveryDetails',
    query: { country: COUNTRY },
    body: { deliveryOption: details.deliveryOption, deliveryInterval: details.deliveryInterval },
  };
}

export function addFavoriteRequest(recipeId: string, week?: string): WriteRequest {
  return {
    method: 'PUT',
    path: apiPath`/cfs/v2/favorites/recipe/${recipeId}`,
    route: `/cfs/v2/favorites/recipe/${recipeId}`,
    query: { ...LOCALE_QUERY, ...(week ? { weekId: week } : {}) },
    body: undefined,
  };
}

export function removeFavoriteRequest(recipeId: string): WriteRequest {
  return {
    method: 'DELETE',
    path: apiPath`/cfs/v2/favorites/recipe/${recipeId}`,
    route: `/cfs/v2/favorites/recipe/${recipeId}`,
    query: { ...LOCALE_QUERY },
    body: undefined,
  };
}
