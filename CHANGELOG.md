# Changelog

## [0.4.0](https://github.com/chrischall/hellofresh-mcp/compare/v0.3.0...v0.4.0) (2026-11-12)


### Features

* **session:** keep the HelloFresh session across restarts ([#8](https://github.com/chrischall/hellofresh-mcp/issues/8)) ([e345475](https://github.com/chrischall/hellofresh-mcp/commit/e345475d4a8e31933b98b2a4e296df8beafa372c))

## [0.3.0](https://github.com/chrischall/hellofresh-mcp/compare/v0.2.0...v0.3.0) (2026-11-12)


### Features

* pantry check — what to have on hand that HelloFresh doesn't ship ([#6](https://github.com/chrischall/hellofresh-mcp/issues/6)) ([a38d548](https://github.com/chrischall/hellofresh-mcp/commit/a38d548900f2bff062ee44b12b15e68af93a79de))

## [0.2.0](https://github.com/chrischall/hellofresh-mcp/compare/v0.1.0...v0.2.0) (2026-11-12)


### ⚠ BREAKING CHANGES

* hf_list_deliveries, hf_get_delivery and hf_weekly_plan renamed their price keys — `estimate` → `price`, `estimateNote` → `priceNote`, `estimateWarning` → `priceWarning` — and every price is now US dollars (`subTotal`, `discount`, `grandTotal`, `totalWithPremiums`); the cent fields `subtotalCents`, `discountCents` and `totalCents` are gone.

### Features

* real box prices, cooking-day plan, favorites, multi-week planning and promo tracker ([8a2012b](https://github.com/chrischall/hellofresh-mcp/commit/8a2012bce5d02b7702cb3d76a6e3156449f90bc6))

## 0.1.0 (2026-11-12)


### Features

* initial hellofresh-mcp — HelloFresh subscription, menus and weekly planner via the ContextMint Bridge ([d543e88](https://github.com/chrischall/hellofresh-mcp/commit/d543e88f72d830fb3fe7ee49a2923596aedfca93))


### Bug Fixes

* **planner:** one dish per recipe, base-course choice, box numbering from the first box, summary label ([10e4f75](https://github.com/chrischall/hellofresh-mcp/commit/10e4f75fe34b588914cd6ea425f2a7b5e9622b0f))
* **writes:** clearer first-box refusal; plan-size preview skips the un-resizable first box ([7103cd9](https://github.com/chrischall/hellofresh-mcp/commit/7103cd930c28a20926e89a3bef75324b68e20430))
* **writes:** resize one week via carts/size, refuse the first box, report plan-size override resets ([ae95d51](https://github.com/chrischall/hellofresh-mcp/commit/ae95d51f5eddb6ea3dd3438f8855de7886914862))
