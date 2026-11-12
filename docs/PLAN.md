# hellofresh-mcp — implementation plan

Owner: chrischall. Built from the `band-mcp` skeleton (`~/git/band-mcp`, read
its files; copy workflow stubs from `gh api repos/chrischall/band-mcp/contents/.github/workflows/<f>`
i.e. origin/main, not the local tree). API facts: `docs/HELLOFRESH-API.md` — the
ONLY source of endpoint shapes; never invent one. Fleet conventions: the
`mcp-fleet-builder` skill (`~/.claude/skills/mcp-fleet-builder/SKILL.md`) —
read the sections named in your task.

## Product decisions (fixed)

- npm name `@chrischall/hellofresh-mcp`, bin `hellofresh-mcp`, repo `chrischall/hellofresh-mcp`,
  registry name `io.github.chrischall/hellofresh-mcp`, tool prefix `hf_`, version 0.0.0 seed +
  release-please `initial-version: 0.1.0`, `bump-minor-pre-major: true`. US market only (country `US`, locale `en-US`).
- Archetype: **fetchproxy bootstrap + Node fetch**. The bridge (`@fetchproxy/server` via
  `@chrischall/mcp-utils/fetchproxy`, serverName `hellofresh-mcp`, domain `hellofresh.com`,
  port `readPortEnv('HELLOFRESH_WS_PORT', 37149)`) is used ONLY to (a) read the
  `apiV2Auth` cookie on subdomain `www`, and (b) write a refreshed token set back to it.
  Every API call is a plain Node fetch with `Authorization: Bearer`.
  Declared scope (pairing grant — changing it later forces re-pair): cookies `apiV2Auth`, cookie WRITE allowed.
- Token lifecycle (`src/session.ts`): single-flight. Cached token valid if > 60 s left.
  Else: read the browser cookie; if ITS access token has > 60 s left, use it (browser refreshed itself).
  Else refresh from Node (`POST /gw/refresh`), then write the new set back to the cookie
  (same encoding as the site, see API doc) — if the write-back fails, still use the new
  tokens but surface a warning in healthcheck/next result ("browser session may be signed out; sign in again").
  On a 401 from any call: invalidate, re-run the lifecycle once, retry the call once.
  Never log or return token values; register them with `redactValues`.
- Writes are confirm-gated (`defineWrite`/`registerWrite` or `confirmWrite`, `confirmToken: confirmTokenParam`),
  each followed by a re-read that VERIFIES the effect (see API doc "verify by"), returning
  `status: verified | unverified` honestly. Cancel subscription is NOT exposed.
- Results `minifiedResult`; reads take `view: compact|full` (default compact). Subscription/delivery
  records are projected to an allowlist — never return address/email/payment/name fields.
- Hints (`_meta.mint`): domain `food` on every tool except `hf_healthcheck`. `hf_list_deliveries` is the
  canonical `whats-on` read with `view: 'brief'` (one line per week: `2026-W49 — 2026-11-30 — running, 2×6, cutoff 11-25`).
- Hosting: `mint.yaml` with no `perUserChild` auth fields (bridge-based), `state.dataDir: true`
  (reason: fetchproxy identity under `$HOME/.fetchproxy/identity/hellofresh-mcp.json`; without it every
  cold start re-prompts pairing), comment noting bridge registration (`bridge: true`, `bridgePortEnv: HELLOFRESH_WS_PORT`
  are set over the control API), `egress.allow: [www.hellofresh.com]`.

## Planner (drives the planner tools)

The planner is generic: it plans one delivery week for a named **profile** loaded from local config
(`HELLOFRESH_PROFILES` inline JSON → `HELLOFRESH_PROFILES_FILE`, default
`~/.config/hellofresh-mcp/profiles.json` → built-in `couple` / `family`; see `src/profiles.ts`).
A profile sets people (2/3/4/6), meals (2–6, default 2), an optional recipe-category allowlist
(e.g. `["Seafood"]`), preferences (`kidFriendly`, `maxMinutes`, `adventurous`), a per-serving premium
cap and `avoidRepeatWeeks` (default 4). Which profile applies to a given week is the caller's
decision (from the user's own calendar, or by asking) — this server never reads any calendar.
Picks favour varied proteins (distinct categories; within Seafood distinct kinds, e.g. one shrimp +
one fish), never repeat a recipe picked within `avoidRepeatWeeks`, and keep premium upcharges in
check (they multiply by servings). Summary for approval, e.g.
`Family week (4 servings) — delivering Mon 11/30: <A> + <B>. Est. box total $X (−$Y CODE).`
with 1–2 alternates per pick; flag if the voucher stops applying. Skips are explicit actions.

## Tasks (sequential)

### T1 — Scaffold
Copy band-mcp's skeleton into this repo, renamed: package.json (name/bin/description/repository/
publishConfig/files incl `skills`, `mint.yaml`, `allowScripts` deny esbuild/fsevents, deps
`@chrischall/mcp-utils` + `@fetchproxy/server` + zod at band's ranges), tsconfig(+test), vitest config,
`.gitignore` (incl coverage/), `.mcpbignore`, LICENSE, `src/version.ts`, `src/index.ts` (runMcp, client
built outside, `await bridge.start()` before runMcp), `manifest.json`, `server.json` (desc ≤ 100 chars),
`.claude-plugin/plugin.json` + `marketplace.json`, `.mcp.json`, `release-please-config.json`
(extra-files for every versioned file) + `.release-please-manifest.json` (0.0.0), `.github/workflows/*`
and `dependabot.yml` from band-mcp origin/main verbatim, tests: version-sync, packaging (repository.url,
scoped name, publishConfig.access, files incl skills+mint.yaml), server-boot (bundle w/o node_modules +
bin), manifest-roster, tool-annotations meta-test. Only tool so far: `hf_healthcheck` (stub OK until T2).
`npm install`, `npm run build`, `npm run typecheck`, `npm run test:coverage` (or the repo's CI test command) green. Commit.

### T2 — Bridge + session
`src/transport.ts` (bridge: start/close, `readAuthCookie()`, `writeAuthCookie(value)`; lazy import of
`@chrischall/mcp-utils/fetchproxy`; check the installed `.d.ts` for the cookie-write API and the
bootstrap-opts field that declares cookie write), `src/session.ts` (lifecycle above; cookie parse/encode
helpers with a round-trip test against the documented encoding), `hf_healthcheck` via
`registerBridgeHealthcheckTool` or adaptive — bridge is on the auth path, so report bridge state +
a probe `GET /api/customers/me/subscriptions` returning only status. TDD with a mocked bridge
(`createServer` seam) and mocked fetch: fresh cookie, browser-fresher cookie, refresh+write-back,
write-back failure warning, 401 retry-once, invalid_grant → actionable "sign in at hellofresh.com in
the browser with ContextMint Bridge" error, bridge down → hinted error passthrough (`fetchproxyHintOf` pattern).

### T3 — Client + normalizers
`src/client.ts`: one private `request()` (bearer, query country/locale, `parseJsonBody`, CF challenge →
`EdgeBlockedError`, 4xx → `McpToolError` with status, 5xx/transport failure after a write was sent →
`WriteOutcomeUnknownError`), timeouts via mcp-utils, `currentCallSignal()`. Methods for every endpoint in the
API doc (all reads, writes 1–5). `src/normalize.ts`: projectSubscription, projectDelivery (week,
deliveryDate, cutoffDate, status→`running|skipped|delivered|…`, meals, servings, sku, productName,
priceCents, feeCents, allowedActions, oneOffDaySlots), projectMenu (base courses vs variants;
per meal: index, name, headline, category, isSeafood, seafoodKind ('shrimp'|'fish'|'other' from name/
headline/variation titles: shrimp/prawn → shrimp; salmon/cod/tilapia/trout/tuna/halibut/haddock/pollock/
barramundi/catfish/mahi/branzino/sea bass/swordfish/scallop? (scallop→other)), kidFriendly, quick, totalMinutes,
premiumPerServingCents, premiumBoxCents, selectedQuantity, tags, cuisine, url, variants[]),
`estimateBoxTotal(delivery, menuSelection, voucherInfo, boxNumber)`. Fixtures: a trimmed real menu capture
(recipes are public; keep ~15 meals incl #67, #71, a premium, a family-friendly, a variant)
and SYNTHETIC subscription/delivery fixtures (fake ids/names/addresses — `git grep` for the real
customer id, customer uuid, subscription id, plan id and the account email must find nothing tracked).

### T4 — Read tools
`hf_get_subscription`, `hf_list_deliveries` (canonical whats-on, brief view, est. totals),
`hf_get_delivery(week)`, `hf_get_menu(week, filters: seafood_only, kid_friendly, max_minutes,
max_premium_per_serving, selected_only; view)`, `hf_list_box_sizes`, `hf_recent_picks(weeks_back=4)`
(selected meals of past/current deliveries — read each week's menu `selection.quantity`; best effort,
say which weeks could not be read). Annotated read-only, described for search, hinted, tested via
`createTestHarness` against the served list.

### T5 — Write tools (confirm-gated, verify by re-read)
`hf_select_meals(week, meals:[index|{index,quantity}])` (validate count == box meal count, all indexes on
that week's menu, before cutoff; destructive:false), `hf_set_week_size(week, people:2|3|4|6, meals?)`
(one-off sku `US-CBU-{meals}-{people}-0`, keeps the week's delivery_option; warns selection may reset;
destructive:false), `hf_set_week_delivery_day(week, slot handle from oneOffDaySlots)`, `hf_skip_week`,
`hf_unskip_week` (destructive:false — inverse exists), `hf_change_plan_size(meals, people)` (permanent, write 4), `hf_change_delivery_schedule(delivery_option?, interval_weeks? 1|2|3|4)`
(permanent, write 5 — send BOTH fields, filling the unchanged one from the current subscription). No meal-preference tool (write 6 unsupported). Each write: plan → confirmWrite (preview shows the exact request)
→ execute → re-read → `{status:'verified'|'unverified', before, after}`. Tests per tool: gate w/o token makes no
network call; token path sends exactly the documented request; verification mismatch reports unverified.

### T6 — Planner tools
`hf_list_profiles` → the configured profiles and where they were loaded from (local config only).
`hf_suggest_meals(week, profile, people?, avoid_indexes?, avoid_recent_weeks?, max_premium_per_serving_cents?)` →
ranked picks in the profile's categories: kid-friendly / quick / adventurous boosts per the profile, premiums over
the cap excluded and under it penalised ×servings, protein diversity; returns the top picks + 2 alternates per slot
with reasons. `hf_weekly_plan(week, profile)` → read-only: required sku (`US-CBU-{meals}-{people}-0`) vs current,
size change needed?, suggested picks, estimated total + discount, voucher warning, the summary text, and the exact
follow-up write calls to make (`hf_set_week_size` then `hf_select_meals`). Pure scoring in `src/planner.ts`,
unit-tested on the fixture menu.

### T7 — Docs, skills, hints, packaging truth
README (setup: install ContextMint Bridge, sign in at hellofresh.com in Chrome, approve pair code;
env vars incl `HELLOFRESH_WS_PORT`, `MCP_CONFIRM_*`; tool table), CLAUDE.md (repo-specific only),
`skills/hellofresh/SKILL.md` (weekly flow: decide which profile applies to the week, unclear weeks → ask the
user, holiday weeks → ask about skipping, a weekly planning reminder; profiles config; "In context groups"
section), `skills/hellofresh-fpx/SKILL.md` + `references/requests.md` (the fpx shell tier: profile add
`hellofresh --domain hellofresh.com`, declare `--cookie apiV2Auth --allow-cookie-write`, read token with
`fpx cookies apiV2Auth --storage-subdomain www` INTO A FILE never stdout, curl recipes with jq for every read,
refresh + write-back recipe, the "second browser prints a pair code" note), `mint.yaml`, manifest tools roster ==
served list, hints test per the skill's template. Final: build, typecheck, full CI test command, `node
scripts/audit-annotations.mjs` from `~/git/mcp-utils` if present against `dist/bundle.js --strict`.
