# HelloFresh read recipes (curl + jq)

Prerequisite (SKILL.md § Core pattern): the token loaded into `~/.hellofresh-fpx`
and the `hf` function defined.

```sh
S=~/.hellofresh-fpx; T=~/.claude/skills/hellofresh-fpx/scripts/hf-token.mjs
(umask 077; fpx cookies apiV2Auth -p hellofresh --storage-subdomain www > "$S/cookie.json") && node "$T" load "$S"
hf() { curl -sS --fail-with-body -H @"$S/auth.header" -H 'accept: application/json' "https://www.hellofresh.com/gw$1"; }
Q='country=US&locale=en-US'
```

Records carry the account holder's name, email, addresses and payment token.
Every recipe below projects to the fields it needs; never dump a whole
subscription or delivery into a chat.

Money is in US **cents**. Weeks are ISO weeks (`2026-W49`). `deliveryOption`
handles read `US-<weekday 1=Mon..7=Sun>-<from HHMM>-<to HHMM>`.

## Subscription

```sh
hf "/api/customers/me/subscriptions?$Q" | jq '.items[] | {id, sku: .product.sku, unitPriceCents: .product.unitPrice,
  preset, deliveryOption: .deliveryOption.handle, deliveryWeekday, deliveryInterval, nextDeliveryWeek,
  nextCutoffDate, nextModifiableDeliveryWeek, customerPlanId, isActive, pausedAt,
  voucher: (.voucherInfo | if . then {code, is_active} else null end)}'
SUB=$(hf "/api/customers/me/subscriptions?$Q" | jq -r '.items[0].id')
PLAN=$(hf "/api/customers/me/subscriptions?$Q" | jq -r '.items[0].customerPlanId')
```

One subscription by id (same shape):

```sh
hf "/api/subscriptions/$SUB?$Q" | jq '{id, sku: .product.sku, deliveryOption: .deliveryOption.handle, deliveryInterval}'
```

## Upcoming deliveries (about 7 weeks)

```sh
hf "/api/customers/me/deliveries?$Q" | jq '.items | sort_by(.id)[] | {week: .id, deliveryDate, cutoffDate, status,
  sku: .product.handle, meals: .product.specs.meals, people: .product.specs.size,
  priceCents: .product.price, feeCents: .product.specialFee, shippingCents: .product.shippingPrice}'
```

`status`: `RUNNING` = coming, `PAUSED` = skipped, `DELIVERED`, `DONATED`.
One line per week:

```sh
hf "/api/customers/me/deliveries?$Q" | jq -r '.items | sort_by(.id)[] |
  "\(.id) — \(.deliveryDate[0:10]) — \(.status | ascii_downcase), \(.product.specs.meals)×\(.product.specs.size), cutoff \(.cutoffDate[5:10])"'
```

## One delivery week

```sh
W=2026-W49
hf "/api/subscriptions/$SUB/delivery_dates/$W?$Q" | jq '{week: .id, deliveryDate, cutoffDate, status, subStatus,
  sku: .product.handle, productName: .product.productName, allowedActions,
  deliveryOption: .deliveryOption.handle, otherDays: [.availableOneOffOptions[]? | {handle, deliveryDate}]}'
```

## Box sizes on offer

```sh
hf "/api/subscriptions/$SUB/product_options?$Q" | jq -r '.items[].products[] | "\(.handle)\t\(.specs.meals) meals × \(.specs.size) people"'
```

## Customer plan (the permanent box size)

```sh
hf "/api/plans?$Q" | jq '.[] | {id, planType, productHandle: .planItems[0].productHandle}'
```

## Menu weeks

```sh
hf "/menus-service/weeks?$Q" | jq -r '.weeks[]'
```

## A week's menu (with the current picks)

`servings` and `product-sku` are REQUIRED (400 without them) — take both from
that week's delivery, so a one-week size change is respected:

```sh
W=2026-W49
SKU=$(hf "/api/subscriptions/$SUB/delivery_dates/$W?$Q" | jq -r .product.handle)
PEOPLE=$(hf "/api/subscriptions/$SUB/delivery_dates/$W?$Q" | jq -r .product.specs.size)
hf "/my-deliveries/menu?subscription=$SUB&week=$W&locale=en-US&servings=$PEOPLE&product-sku=$SKU&customerPlanId=$PLAN&exclude-feedback=true" > "$S/menu-$W.json"
```

The menu lists base courses AND protein-swap variants (`modularity[].variations[].index`).
Base courses only, seafood first, with the premium per serving:

```sh
jq '([.modularity[]?.variations[]?.index]) as $variants | .meals[] | select(.index as $i | $variants | index($i) | not)
  | {index, name: .recipe.name, headline: .recipe.headline, category: .recipe.category,
     totalTime: .recipe.totalTime, kidFriendly: ([.recipe.tags[]? | .type] | index("family-friendly") != null),
     premiumPerServingCents: (.charge.unitAmount // 0), picked: (.selection.quantity // 0)}' "$S/menu-$W.json"
```

Seafood only (`category == "Seafood"`), or the swaps offered on a course:

```sh
jq '.meals[] | select(.recipe.category == "Seafood") | {index, name: .recipe.name, premium: .charge.label}' "$S/menu-$W.json"
jq '.modularity[] | select(.variations | length > 0) | {course: .defaultCourseIndex, swaps: [.variations[] | {index, title}]}' "$S/menu-$W.json"
```

The current picks (a `selection.quantity` means picked):

```sh
jq '.meals[] | select(.selection.quantity) | {index, name: .recipe.name, quantity: .selection.quantity}' "$S/menu-$W.json"
```

## Estimated box total

There is no single "box total" read. Product price + fee + shipping + premiums,
before any voucher discount:

```sh
D=$(hf "/api/subscriptions/$SUB/delivery_dates/$W?$Q")
jq -n --argjson d "$D" --slurpfile m "$S/menu-$W.json" '
  ($d.product.price + ($d.product.specialFee // 0) + ($d.product.shippingPrice // 0)
   + ([$m[0].meals[] | select(.selection.quantity) | (.charge.totalAmount // 0)] | add // 0)) / 100'
```

The voucher (`voucherInfo.discount_settings.discount_rule.box_rule`) gives a
per-box-number percentage in hundredths (`6500` = 65 %); `applicable_to:
"products"` discounts the product price only. Label any figure an estimate.

## Refresh (only when reloading the tab didn't help)

The refresh token **rotates** on every refresh and the response sets no
cookie, so the new set MUST be written back into the browser right away, or
the browser keeps a spent refresh token and is signed out. If the
hellofresh-mcp server is running too, prefer reloading the tab: two refreshers
fork the session.

```sh
code=$(curl -sS -o "$S/refreshed.json" -w '%{http_code}' -X POST \
  'https://www.hellofresh.com/gw/refresh?country=us&locale=en-US' \
  -H 'content-type: application/json' --data-binary @<(jq -c '{refresh_token}' "$S/auth.json"))
echo "refresh: HTTP $code" >&2
node "$T" store "$S" && fpx write-cookies apiV2Auth=@"$S/cookie.txt" -p hellofresh --storage-subdomain www
```

`store` writes `auth.json`, `auth.header` and `cookie.txt` (the value encoded
exactly as the site's js-cookie does); `fpx write-cookies` prints the cookie
name once it landed. `400 {"error":"invalid_grant"}` → the refresh token was
already spent: sign in again at hellofresh.com, then `load`.
