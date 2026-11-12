# HelloFresh (US) web API — verified shapes

Everything here was captured on 2026-11-12 from the signed-in www.hellofresh.com
web app (bundle read + live calls). "VERIFIED" = a real request returned the
documented status from Node with a bearer token. Never commit tokens, cookies,
customer ids, addresses or emails — fixtures use synthetic placeholders.

Base: `https://www.hellofresh.com/gw` — every path below is relative to it.
Most calls take `country=US&locale=en-US` query params (case as shown).

## Auth

- The web app keeps its session in the cookie **`apiV2Auth`** on host
  **www.hellofresh.com** (host-only, NOT HttpOnly). Value = URL-encoded JSON:
  `{access_token, expires_in, refresh_token, token_type, user_data, refresh_expires_in, issued_at}`.
  - `access_token`: Auth0 RS256 JWT, **30 min** (`expires_in: 1800`).
  - `refresh_token`: opaque, **60 days** (`refresh_expires_in: 5184000`).
  - `issued_at`: unix seconds. `user_data`: `{id (customer uuid), email, country, ...}`.
  - Encoding (js-cookie v3): `encodeURIComponent(json)` then DE-code
    `%(2[346BF]|3[AC-F]|40|5[BDE]|60|7[BCD])` back to literals — so `"`→`%22`,
    `,`→`%2C`, while `{ } : [ ]` stay literal. Key order as listed above.
- Requests: `Authorization: Bearer <access_token>` from plain Node fetch WORKS
  (VERIFIED) — no Cloudflare wall when a bearer is present. Unauthenticated
  `/gw` POSTs get a Cloudflare "Just a moment…" challenge (`_cf_chl_opt`).
- Missing/expired bearer → `401 {"errorMessage":"no Bearer token"}` (or 401 on expiry).
- **Refresh** (VERIFIED): `POST /gw/refresh?country=us&locale=en-US`
  body `{"refresh_token": "<rt>"}` → 200, same JSON shape as the cookie value.
  **The refresh token ROTATES on every refresh and the response sets NO cookie.**
  So the MCP MUST write the new token set back into the browser's `apiV2Auth`
  cookie (fetchproxy cookie-write), or the browser keeps a superseded refresh
  token and the two sessions fork. Stale/revoked RT → `400 {"error":"invalid_grant"}`.
  VERIFIED: refresh from Node + `fpx write-cookies apiV2Auth=@file` → browser
  stays signed in with the new tokens.
- Login itself (`/gw/login`) is reCAPTCHA/Turnstile + Cloudflare walled — no
  server-side login. The bridge (ContextMint Bridge, fetchproxy) is the only way
  to obtain the first token set.

## Reads (all VERIFIED 200)

| Purpose | Request |
|---|---|
| Subscriptions | `GET /api/customers/me/subscriptions?country=US&locale=en-US` → `{count, items:[Subscription]}` |
| One subscription | `GET /api/subscriptions/{subscriptionId}?country=US&locale=en-US` → Subscription |
| Upcoming deliveries | `GET /api/customers/me/deliveries?country=US&locale=en-US` → `{count, items:[Delivery]}` (next ~7 weeks) |
| One delivery | `GET /api/subscriptions/{id}/delivery_dates/{week}?country=US&locale=en-US` → Delivery |
| Box sizes | `GET /api/subscriptions/{id}/product_options?country=US&locale=en-US` → `{items:[{handle:'classic-box-unified', name, products:[{handle:'US-CBU-{meals}-{people}-0', specs:{meals,size}}]}]}` |
| Customer plan | `GET /api/plans?country=US&locale=en-US` → `[{id (customerPlanId uuid), planType, planItems:[{productHandle, priceSetId}], legacySubscriptionId}]` |
| Menu weeks | `GET /menus-service/weeks?country=US&locale=en-US` → `{weeks:['2026-W46', …]}` |
| Delivery menu | `GET /my-deliveries/menu?subscription={id}&week={week}&locale=en-US&servings={people}&product-sku={sku}&customerPlanId={planId}&exclude-feedback=true` → DeliveryMenu |

Without `servings` + `product-sku` the menu call answers 400.

### Subscription (fields used)
`id` (string, e.g. "90000001"), `customer.id` (int — the numeric customer id the
cart PUT needs), `customer.uuid`, `product.sku` (e.g. `US-CBU-2-6-0`),
`product.unitPrice` (cents), `preset` ("pescatarian"…), `deliveryWeekday`
(1=Mon), `deliveryInterval` (weeks), `deliveryTime` / `deliveryOption.handle`
(e.g. `US-1-0800-2000` = Mondays 8AM–8PM), `nextDeliveryWeek`, `nextCutoffDate`,
`nextModifiableDeliveryWeek`, `customerPlanId`, `couponCode`, `pausedAt`,
`canceledAt`, `isActive`, `voucherInfo` (see Pricing). Also carries name, email,
shipping/billing address, payment token — NEVER return those unprojected.

### Delivery
`id` = week (`2026-W49`), `deliveryDate`, `cutoffDate` (ISO with offset),
`status` (`RUNNING` | `PAUSED` = skipped | `DELIVERED` | `DONATED` | …),
`subStatus`, `actionable`, `allowedActions{mealSwap, pause, oneOffChange, updateDeliveryWeekday, …}`,
`product{handle, specs{meals,size}, productName, price (cents, product only), shippingPrice, specialFee (cents)}`,
`deliveryOption{handle, deliveryName, deliveryDay}`,
`availableOneOffOptions[{handle, deliveryDate}]` (alternative delivery-day slots for that week),
`subscriptionId`, `orderId`, `tracking`.

### DeliveryMenu
`{id, week, meals:[Meal], mealsReady, addOns:{selectionLimit, groups[]}, modularity:[…], menuCollections[]}`
- `Meal = {recipeFamily, index (int), recipe, selection?, charge?}`
  - `selection = {limit, quantity?}` — `quantity` present ⇒ CURRENTLY SELECTED (e.g. 1).
  - `charge = {label:'+6.99/serving', unitAmount:699 (cents/serving), totalAmount:4194 (for the box size), reason:'premium', strategy:'per_meal'}` — premium upcharge.
  - `recipe = {id, name, headline, prepTime:'PT10M', totalTime:'PT20M', image, websiteURL, label{text,handle}, tags:[{name,type,…}], nutrition, cuisines:[{name,type}], category}`
    - `category` ∈ `Seafood | Poultry | Beef | Pork | Veggie | Lamb | null` — **seafood = `category === 'Seafood'`**.
    - kid friendly = a tag with `type === 'family-friendly'` (name "Kid Friendly"); quick = tag `quick` / `easy-prep`, or `totalTime` ≤ 30 min.
- `modularity[]`: one per base course: `{defaultCourseIndex, defaultCategory, noVariationsDefaultTitle, variations:[{index, title:'2x Shrimp', category}], addOns:[{index,title}]}`.
  Indexes listed in some `variations[].index` are protein-swap VARIANTS of a base course
  (e.g. #560 "2x Shrimp" of #67); the base menu is the meals that are NOT variants.
  The W49 menu had 536 meal entries (base + variants).

## Writes

Writes 1–5 VERIFIED live on 2026-11-12 with idempotent re-saves (same values), each followed by a re-read confirming no change.

1. **Select meals for a week** — `PUT /v1/carts/{week}?subscription={id}&customer={customer.id (int)}&week={week}&product-sku={sku}&preference={subscription.preset}&update_quantity=false&ignore_addons=false`
   body `{"extras": [], "meals": [{"index": 67, "quantity": 1}, {"index": 71, "quantity": 1}]}`
   → 200 `{"hasSeamlessDowngraded": false}`. The meals list is the COMPLETE selection
   (replace, not add). Number of meals must equal the box's meal count. Verify by
   re-reading the delivery menu (`selection.quantity`). Only before `cutoffDate`.
2. **Skip / unskip a week** — `PATCH /api/subscriptions/{id}/delivery_dates/{week}?country=US&locale=en-US`
   body `{"delivery": {"id": "{week}", "subscriptionId": "{id}", "deliveryDate": "<from delivery>", "cutoffDate": "<from delivery>", "status": "PAUSED"}}`
   (`"RUNNING"` = unskip) → 201 `{count, items:[Delivery]}`.
3. **Change size / day for ONE week (one-off)** — `POST /api/subscriptions/{id}/oneoff?country=US&locale=en-US`
   body `{"id": "{id}", "week": "{week}", "sku": "US-CBU-2-2-0", "delivery_option": "US-1-0800-2000", "source": "one-off"}`
   → 201 `{count, items:[Delivery]}`. Changing `sku` changes that week's box size;
   changing `delivery_option` to one of `availableOneOffOptions[].handle` moves that week's day.
   (A one-week size change earlier in the session took W50 from US-CBU-2-6-0 $147.48 to US-CBU-2-2-0 $59.96.)
   After a size change re-read the menu with the new `servings`/`product-sku` — selections may be reset.

4. **Permanent box size** — `PATCH /api/plans/{customerPlanId}?country=US&locale=en-US`
   body `{"productHandle": "US-CBU-2-6-0"}` → 204 (no body). VERIFIED (same-value re-save; week-only
   one-off overrides such as a 2-person week and existing meal picks SURVIVED). Verify by re-reading
   `GET /api/plans` → `planItems[0].productHandle`.
5. **Permanent delivery day/slot + frequency** — `POST /api/plans/{customerPlanId}/changePlanDeliveryDetails?country=US`
   body `{"deliveryOption": "US-1-0800-2000", "deliveryInterval": 1}` → 200 (empty body). VERIFIED (same-value re-save,
   overrides survived). `deliveryInterval` is in weeks (the site uses `0` for "on demand" — do NOT expose 0).
   Valid `deliveryOption` handles: `US-<weekday 1=Mon..7=Sun>-<from HHMM>-<to HHMM>`, e.g. the subscription's
   current one, or handles seen in deliveries' `availableOneOffOptions`. Verify via `GET /api/subscriptions/{id}`
   (`deliveryOption.handle`, `deliveryInterval`, `deliveryWeekday`).
   The legacy `PATCH /api/subscriptions/{id}/delivery_interval {interval,startDate}` exists but is NOT used.
6. **Meal-preference preset** — NOT supported in v1. `PATCH /api/subscriptions/{id} {"subscription":{"preset":…}}`
   → 400 `VALIDATION_ERROR … only deliveryTime and deliveryInterval are accepted` (VERIFIED, no change).
   Meals are always picked explicitly, so the preset does not matter to this MCP.
7. **Cancel** — `POST /api/plans/{planId}/cancel` — deliberately NOT exposed (irreversible; do it on the website).

Other endpoints seen (not in scope v1): favorites `PUT|DELETE /cfs/v2/favorites/recipe/{recipeId}?country&locale[&weekId]`, ratings `PUT /cfs/v2|v3/ratings/recipe/{id}`, cart price `POST /v1/carts/{week}/price`, past deliveries, wallet/balance `/payments/customers/{uuid}/balance`.

## Pricing (estimate — no single "box total" read)

Box total ≈ `product.price + product.specialFee + product.shippingPrice + Σ premium charge.totalAmount` (cents)
minus the voucher discount for that box number:
`subscription.voucherInfo` → `{code, is_active, discount_type:'percent', discount_settings:{box_count:52, discount_rule:{box_rule:{"1":{applicable_to:'both', discount_value:6500}, "2":{applicable_to:'products', discount_value:1500}, …}}}}`
— `discount_value` is in hundredths of a percent (6500 = 65%, 1500 = 15%);
`applicable_to: 'products'` = product price only, `'both'` = product + shipping/fees.
Box number = count of delivered boxes + upcoming position (first box = 1).
Checked: a 6-person box $147.48 + $12.99 fee = $160.47; 15% of $147.48 = $22.12 off. A 2-person box $59.96 + $12.99 = $72.95.
Always label it an estimate and flag when `voucherInfo` is missing/inactive.
