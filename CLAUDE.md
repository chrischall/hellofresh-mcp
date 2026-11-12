# hellofresh-mcp

Unofficial HelloFresh (US) MCP (`@chrischall/hellofresh-mcp`): subscription,
delivery weeks, menus and meal picks, plus confirm-gated writes (pick meals,
one-week size / delivery day, skip / unskip, permanent plan size and schedule,
favourite / un-favourite a recipe), favourites and ratings reads, and three
read-only planner tools (profiles, suggest, weekly plan). stdio
transport, tool prefix `hf_`.

## Commands

```bash
npm run build          # tsc → dist/, then esbuild → dist/bundle.js (the .mcpb entry, runs with NO node_modules)
npm test               # typecheck (src + tests) + vitest (server-boot spawns the built artifacts — build first)
npm run test:coverage  # 100% thresholds, run by CI
```

## How it talks to HelloFresh (fetchproxy *bootstrap*)

- The bridge (serverName `hellofresh-mcp`, port `HELLOFRESH_WS_PORT`, default
  37149) is used ONLY to read the `apiV2Auth` cookie on `www.hellofresh.com`
  and to write a refreshed token set back to it. Every API call is plain Node
  `fetch` to `https://www.hellofresh.com/gw` with `Authorization: Bearer`.
- The refresh token ROTATES on every `POST /gw/refresh` and the response sets
  no cookie: a Node-side refresh MUST be written back (js-cookie v3 encoding,
  `encodeAuthCookie` in `src/session.ts`) or the browser is signed out. The
  lifecycle (cache → browser cookie → refresh + write-back, 401 replay once) is
  in `src/session.ts`; read its header before touching it.
- Changing the bridge's declared scope (cookie `apiV2Auth`, cookie write)
  forces every user to re-pair.
- No token value may appear in an error, result or log (`redactValues`).
  Subscription / delivery records are projected to an allowlist: never return
  name, email, address or payment fields.

## Layout

- `src/tools/index.ts` — `TOOL_REGISTRARS`, the ONE registrar list.
  `src/index.ts` registers it; the roster, annotation and hints tests drive it.
  A new tool also needs a `manifest.json` `tools` entry, a README row, a line
  in `skills/hellofresh/SKILL.md` and an intent in `tests/hints.test.ts` (all
  tested), and `tests/server-boot.test.ts` `MIN_TOOLS` raised.
- `src/tools/writes.ts` — every write is plan → `confirmWrite` → execute →
  re-read, answering `status: verified | unverified`. Its own `registerGated`
  wraps the flow because `registerWrite` cannot carry `_meta`.
- `src/tools/favorites.ts` — favourites (list + confirm-gated add/remove,
  verified by re-reading the list) and the ratings list. The planner reads both
  best effort (`readPersonal` in `src/tools/shared.ts`).
- `src/planner.ts` — pure scoring for `hf_suggest_meals` / `hf_weekly_plan`,
  driven by a planner profile (`src/profiles.ts`: `HELLOFRESH_PROFILES` →
  `HELLOFRESH_PROFILES_FILE` → built-in `couple` / `family`, parsed once, a bad
  config is a tool error). No household-specific rules belong in the repo:
  personal profiles live in the user's local config.
- `docs/HELLOFRESH-API.md` — the ONLY source of endpoint shapes. Never code an
  endpoint or body that isn't in it; add it there (live-verified) first.
- `skills/hellofresh/` — the MCP-usage skill; `skills/hellofresh-fpx/` — the
  standalone shell tier (its `scripts/hf-token.mjs` is executed by
  `tests/fpx-token-helper.test.ts`).
- Env vars: a new one goes in `mint.yaml`, `server.json`, the README
  configuration table and a `manifest.json` `user_config` setting (all tested
  against `mint.yaml`).

## Rules specific to this repo

- The repo is public: no real customer, subscription or plan ids, customer
  uuids, emails or addresses anywhere — fixtures are synthetic. `git grep` any
  value captured from a live session before committing. Recipes on the menu
  fixture are public and fine.
- Out of scope, by decision: cancelling the subscription (irreversible — the
  website only), the meal-preference preset (the API refuses it), add-ons, and
  RATING a recipe: the rate call (`PUT /cfs/{v2|v3}/ratings/recipe/{id}`) is not
  live-verified — it needs a delivered box — so only the ratings LIST is read
  (`hf_list_ratings`, item shape unobserved: parsed defensively). Add the write
  only after it is verified in docs/HELLOFRESH-API.md.
- US market only (`country=US`, `locale=en-US`).
- Tests make no network calls.
