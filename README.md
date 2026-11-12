# HelloFresh MCP

[![CI](https://github.com/chrischall/hellofresh-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/chrischall/hellofresh-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@chrischall/hellofresh-mcp)](https://www.npmjs.com/package/@chrischall/hellofresh-mcp)
[![license](https://img.shields.io/npm/l/@chrischall/hellofresh-mcp)](LICENSE)

A [Model Context Protocol](https://modelcontextprotocol.io) server that connects Claude to your [HelloFresh](https://www.hellofresh.com) (US) meal-kit subscription. It reads the subscription, upcoming delivery weeks, weekly menus and your current meal picks, suggests dinners for a configurable planner profile (e.g. a 2-person adventurous week or a 4-person kid-friendly week), and can pick meals, change one week's box size or delivery day, skip or unskip a week, and change the plan's permanent size or schedule. Every change is confirmation-gated and verified by re-reading HelloFresh.

> [!WARNING]
> **AI-developed project.** [Claude](https://www.anthropic.com/claude) built this codebase and maintains it. No human has audited the implementation. Review all code and tool permissions before use.

> [!CAUTION]
> **Unofficial and unsupported.** HelloFresh has no public API for this. The server calls the internal API the hellofresh.com web app uses, authenticated with your own signed-in browser session. It may break without notice, and automated use may conflict with HelloFresh's terms. Use it only for your own account, at your own discretion.

## What you can do

Ask Claude things like:

- *"What HelloFresh boxes are coming up, and when is the next cutoff?"*
- *"Show me the seafood meals on next week's menu that take 30 minutes or less."*
- *"Plan next week's HelloFresh box for the family profile."*
- *"Switch next week's box to 2 people and pick the shrimp linguine and the tilapia chowder."*
- *"Skip my HelloFresh delivery for Thanksgiving week."*

## Requirements

- [Claude Desktop](https://claude.ai/download), Claude Code, or any MCP host
- [Node.js](https://nodejs.org) 22.5 or later
- The [ContextMint Bridge](https://github.com/nullnet-app/contextmint-bridge/releases) browser extension in Chrome, and a tab signed in at `https://www.hellofresh.com/`
- A US HelloFresh account

## Installation

### Claude Code plugin

```bash
claude plugin marketplace add chrischall/hellofresh-mcp
claude plugin install hellofresh@chrischall
```

The plugin also installs the [`hellofresh` skill](skills/hellofresh/SKILL.md), which teaches Claude the weekly planning flow and the confirmation flow.

### Any MCP host (npx)

```json
{
  "mcpServers": {
    "hellofresh": {
      "command": "npx",
      "args": ["-y", "@chrischall/hellofresh-mcp"]
    }
  }
}
```

### Claude Desktop (.mcpb)

Install the `.mcpb` bundle from the [latest release](https://github.com/chrischall/hellofresh-mcp/releases). Its optional settings (bridge port, time zone, write confirmation mode, confirmation prompts, debug logging) set the environment variables in [Configuration](#configuration); leave them blank for the defaults.

## Setup: sign in and pair (once)

1. Install [ContextMint Bridge](https://github.com/nullnet-app/contextmint-bridge/releases) in Chrome.
2. In that browser, sign in at `https://www.hellofresh.com/` and leave a hellofresh.com tab open.
3. Ask Claude to run `hf_healthcheck`. The first call answers with a **pair code**.
4. Open the ContextMint Bridge popup, check the code matches, and approve it. The trust persists across restarts in `~/.fetchproxy/identity/hellofresh-mcp.json`.
5. Run `hf_healthcheck` again: it reports the bridge link, minutes left on the session token, and whether HelloFresh's API answers.

**More than one browser?** Approve the code in the browser that holds your HelloFresh session. The server pins whichever extension approved it; a pair code on stderr while calls still succeed is the *other* browser being turned away, and is harmless — don't approve it.

**Paired the wrong browser?** Revoke `hellofresh-mcp` in the ContextMint Bridge popup, run `fpx trust clear hellofresh-mcp` (from [`@fetchproxy/cli`](https://www.npmjs.com/package/@fetchproxy/cli)), restart the server, and pair again.

## How it signs in

The web app keeps its session in the `apiV2Auth` cookie on `www.hellofresh.com`: a 30-minute access token plus a refresh token. HelloFresh's sign-in page is bot-walled, so the server never signs in itself and never sees your password. Instead the bridge reads that cookie from your signed-in tab, and every API call is then a plain request from Node to `https://www.hellofresh.com/gw` with the access token as a Bearer.

When the access token is about to expire, the server first re-reads the cookie (your browser may have refreshed it already). Only if the browser's token is also stale does it refresh from Node. HelloFresh rotates the refresh token on every refresh, so the server then writes the new token set back into your browser's cookie — otherwise your browser would be left holding a spent token and be signed out. If that write-back fails, the call still succeeds and `hf_healthcheck` warns that the browser session may be signed out. A rejected token (`401`) is re-resolved and the call retried once.

Tokens stay in memory only. They never appear in an error, a result or a log. Results never include your name, email, addresses or payment details. The only thing written under your home directory is the bridge's pairing identity.

If calls fail with "Not signed in to HelloFresh", sign in again at hellofresh.com in the paired browser.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `HELLOFRESH_WS_PORT` | `37149` | The fetchproxy bridge port. The whole fetchproxy fleet and ContextMint Bridge share `37149`. Override it only for local testing, or when a host injects a per-registration port. |
| `MCP_USER_TZ` | the system zone | Your IANA time zone, for example `America/New_York`. It decides "this week" in `hf_recent_picks`. Set it when hosted, because a hosted server runs in UTC. |
| `HELLOFRESH_DEBUG` | off | Log the bridge's role and lifecycle to stderr. |
| `MCP_CONFIRM_MODE` | `ask-user` | What a write does on a client that cannot show a confirmation prompt. See below. |
| `MCP_CONFIRM_ELICITATION` | `on` | `off` never shows a confirmation prompt, so every client takes the `MCP_CONFIRM_MODE` path. Use it for clients that declare prompts but never render them. |
| `HELLOFRESH_PROFILES` | unset | The meal-planner profiles as an inline JSON array (wins over the file). See [Planner profiles](#planner-profiles). |
| `HELLOFRESH_PROFILES_FILE` | `~/.config/hellofresh-mcp/profiles.json` | A JSON file of planner profiles, read when it exists. With neither set, the built-in `couple` and `family` profiles apply. |

### Planner profiles

`hf_suggest_meals`, `hf_weekly_plan` and `hf_plan_weeks` plan a week for a named **profile**: who the box feeds and how to rank the menu. Each profile is:

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Lowercase slug you pass as `profile` (e.g. `family`). |
| `label` | no | Display name in the summary line (default: the capitalised name). |
| `people` | yes | Servings: `2`, `3`, `4` or `6`. |
| `meals` | no | Meals per week, `2`–`6` (default `2`). The box SKU is `US-CBU-{meals}-{people}-0`. |
| `categories` | no | Allowed recipe categories, e.g. `["Seafood"]` (default: any). |
| `kidFriendly` | no | Favour family-friendly recipes, mark spicy ones down. |
| `maxMinutes` | no | Favour recipes ready within this many minutes, mark slower ones down. |
| `premiumCapCents` | yes | Highest premium upcharge per serving, in cents; premiums under it cost points in proportion to the box upcharge. |
| `adventurous` | no | Favour less familiar cuisines; premiums within the cap are only lightly penalised. |
| `avoidRepeatWeeks` | no | Skip recipes picked in this many previous weeks (default `4`). |

Picks favour varied proteins (distinct categories; within Seafood, e.g. one shrimp + one fish). Example `~/.config/hellofresh-mcp/profiles.json`:

```json
[
  { "name": "family", "label": "Family", "people": 4, "kidFriendly": true, "maxMinutes": 30, "premiumCapCents": 500 },
  { "name": "date-night", "label": "Date night", "people": 2, "categories": ["Seafood"], "adventurous": true, "premiumCapCents": 1500 }
]
```

The config is read once, on first use; restart the server after editing it. A malformed config never stops the server booting — the planner tools answer with an error naming the variable or file. `hf_list_profiles` shows what was loaded.

## Confirming writes

Every write is confirmation-gated:

- **Clients that support MCP elicitation** show a real confirmation prompt describing the change.
- **Other clients (claude.ai, Claude Desktop)** make **no** change on the first call. It returns a preview of the exact request plus a single-use, short-lived `confirmToken`. Only a repeat call carrying that token writes. If anything in the request changed in between, the token is refused.

`MCP_CONFIRM_MODE` decides who may use that token:

| Value | Behaviour |
|---|---|
| `ask-user` (default) | The model must show you the preview and get your approval in chat before reusing the token. |
| `auto` | The model may use the token itself after seeing the preview. |
| `refuse` | Writes are refused on clients without a confirmation prompt. An unrecognised value is treated as `refuse`. |

After sending, each write re-reads HelloFresh and reports `status: "verified"` or `"unverified"` with `before` / `after` — never a success it didn't see. Recipe names and descriptions come from HelloFresh and are treated as untrusted data; they can never authorise a write.

## Tools

Read tools take `view: compact | full` (default `compact`). A box `price` with `source: "hellofresh"` is HelloFresh's own checkout total (US dollars: voucher, shipping and tax applied) from its price calculator, read through the browser tab; that calculator leaves premium recipe charges out, so `premiumUpcharge` reports them separately and `totalWithPremiums` adds them. When the calculator cannot be read, `price` falls back to a local estimate (`source: "estimate"`, with the `reason`) in the same unit and field names: every `price` amount is US dollars whichever the source — `grandTotal` (premiums left out), `premiumUpcharge` and `totalWithPremiums`. A browser bridge that is down is tried once per call: later weeks in the same call go straight to the estimate with the same reason. Menu premiums (`premium*Cents` fields on meals and picks) are US cents and multiply by servings.


| Tool | What it does |
| --- | --- |
| `hf_healthcheck` | Check the ContextMint Bridge link, the HelloFresh session token and a subscriptions probe (status only). |
| `hf_get_subscription` | The subscription: box size, price, preset, delivery slot and frequency, next delivery and cutoff, voucher. Never name, email, address or payment. |
| `hf_list_deliveries` | Upcoming delivery weeks: dates, cutoff, status, box size and each running week's box price (HelloFresh's checkout total + premiums, or a labelled estimate). `view: "brief"` gives one line per week. |
| `hf_get_delivery` | One delivery week: dates, status, box size, current meal picks, allowed actions, alternative days, and the box price (HelloFresh's checkout total + premiums, or a labelled estimate). |
| `hf_get_menu` | A week's menu at its box size, with `seafood_only`, `kid_friendly`, `max_minutes`, `max_premium_per_serving` and `selected_only` filters and protein swaps. |
| `hf_list_box_sizes` | The box sizes (meals × people) the subscription can switch to, the current one marked. |
| `hf_recent_picks` | Meals picked in recent weeks (best effort; unreadable weeks are named, weeks before the first delivery are `no_box`), to avoid repeating a recipe. |
| `hf_select_meals` | Pick a week's meals by menu index (replaces the current picks; count must match the box). Confirm-gated, verified by re-reading the menu. |
| `hf_set_week_size` | Change ONE week's box size (people, optionally meals), keeping its delivery day; picks may reset. Refuses the subscription's first box (HelloFresh won't resize it). Confirm-gated, verified by re-reading the week. |
| `hf_set_week_delivery_day` | Move ONE week to another offered delivery day/slot, keeping its box size. Confirm-gated, verified. |
| `hf_skip_week` | Skip a week before its cutoff (nothing delivered or charged). Confirm-gated, verified. |
| `hf_unskip_week` | Unskip a skipped week before its cutoff. Confirm-gated, verified. |
| `hf_change_plan_size` | Permanently change the plan's box size. **Resets every one-week size** (`hf_set_week_size`) to the new plan size: the preview lists those weeks and the result says which reverted, to re-apply. Confirm-gated, verified by re-reading the plan. |
| `hf_change_delivery_schedule` | Permanently change the regular delivery slot and/or frequency (every 1–4 weeks). Confirm-gated, verified. |
| `hf_list_profiles` | The meal-planner profiles (servings, meals, allowed categories, preferences, premium cap) and where they were loaded from. Local config only. |
| `hf_suggest_meals` | Ranked picks for a week and a planner profile (e.g. a 4-person kid-friendly week), skipping recent repeats and recipes you rated 2 or lower, favouring your favourites and varied proteins: the top picks plus 2 alternates per slot, with reasons. Read-only. |
| `hf_get_recipe` | One meal's full recipe by week + menu index (protein swaps say which protein they swap in): time, difficulty, allergens, nutrition per serving, ingredient amounts for the week's servings (nearest listed yield otherwise, flagged), plain-text steps, utensils, recipe card PDF and web page. Recipe text is framed as untrusted third-party content. Read-only. |
| `hf_cooking_plan` | A week's picked meals in a recommended cook order — fish, shellfish, other seafood, poultry, ground meat, whole cuts of beef/pork/lamb, vegetarian last; ties by shorter time — each with a suggested day from the delivery date, why, total time, key ingredients, the pantry staples to have on hand and recipe card. Read-only. |
| `hf_pantry_check` | What to have in the pantry for a week: the staples HelloFresh does not ship (salt, pepper, oil, often butter/eggs/sugar/flour) across the picked meals, summed per ingredient and unit at the week's servings (× quantity; "to taste" when unmeasured), with the dishes using each and a one-line summary. Read-only. |
| `hf_weekly_plan` | One read to approve a week: box size needed vs current, suggested picks, the box price for the size it needs (HelloFresh's checkout total + premiums, or a labelled estimate), a one-line summary, and the exact follow-up write calls in order (never a resize of the first box, which keeps its size — see `notes`). Read-only. |
| `hf_plan_weeks` | Plan 1–6 weeks at once, each `{week, profile}` (which profile applies to which week is your call — it reads no calendar): each week's `hf_weekly_plan` answer, never suggesting a recipe already planned for an earlier week, a combined summary (one line per week), the total of HelloFresh's own box prices (estimate-only weeks named, not added) and the follow-up writes per week. Skipped weeks are reported as skipped. Read-only. |
| `hf_promo_status` | The promo/voucher tracker: coupon code, active, box limit, boxes used (exact for a new account, else assumed — `next_box_number` corrects it) and left, and each upcoming running week's real discount from HelloFresh's price calculator (coupon percent, discount, grand total — or `unavailable` with the reason), with warnings: a running week with no discount, a coupon percent change from the week before, an inactive voucher, fewer than 4 discounted boxes left. Read-only. |
| `hf_list_favorites` | The recipes you favourited (recipe ids and dates; never your customer id); give a week to name the ones on its menu. The planner favours them. |
| `hf_list_ratings` | Your own recipe ratings (v2 and/or the 5-star v3 scale); give a week to name them. Parsed defensively — the item shape isn't observed live yet, so unreadable items are skipped and counted. The planner never suggests a recipe you rated 2 or lower. |
| `hf_favorite_recipe` | Favourite a recipe from a week's menu by index (a protein swap favourites its own recipe). Confirm-gated, verified by re-reading the favourites. Undo with `hf_unfavorite_recipe`. |
| `hf_unfavorite_recipe` | Remove a recipe on a week's menu from your favourites. Confirm-gated, verified. Undo with `hf_favorite_recipe`. |

## Limits

- **No cancel.** Cancelling the subscription is deliberately not exposed — do it on the website.
- **No preferences or extras.** The meal-preference preset, add-ons and payments are out of scope.
- **Ratings are read-only.** Rating a recipe isn't supported: HelloFresh's rate call hasn't been verified live (it needs a delivered box).
- **US only.** Every call uses `country=US` and `locale=en-US`.
- **Picks before the cutoff only.** HelloFresh refuses changes to a week after its cutoff.

## Shell access without the MCP

[`skills/hellofresh-fpx/`](skills/hellofresh-fpx/SKILL.md) is a standalone, read-only skill that reads the same data from a shell: `fpx` reads the session cookie once, then `curl` + `jq` do the rest.

## Development

```bash
npm install
npm run build        # tsc → dist/, then esbuild → dist/bundle.js (the .mcpb entry)
npm test             # typecheck + vitest
npm run test:coverage
```

[`docs/HELLOFRESH-API.md`](docs/HELLOFRESH-API.md) describes the API this server is built on: auth and the token lifecycle, every endpoint used, and the pricing estimate.

## License

MIT
