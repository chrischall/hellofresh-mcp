// The planner tools: hf_list_profiles (the configured planner profiles),
// hf_suggest_meals (ranked picks for a week and a profile) and hf_weekly_plan
// (everything to approve in one read — box size needed, picks, estimated
// total, the approval line and the exact confirm-gated write calls to make
// next). All are READ-ONLY: they never change the box. The scoring itself is
// pure and lives in src/planner.ts; profiles load from local config
// (src/profiles.ts) on first use.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { minifiedResult, toolAnnotations } from '@chrischall/mcp-utils';
import { projectDelivery, type ProjectedDelivery, type ProjectedMenu } from '../normalize.js';
import { LOW_RATING, suggestMeals, summaryText, type Candidate, type Suggestion } from '../planner.js';
import {
  BUILTIN_PROFILES,
  DEFAULT_PROFILES_FILE,
  PROFILES_ENV,
  PROFILES_FILE_ENV,
  createProfileStore,
  profileLabel,
  profileSku,
  resolveProfile,
  type LoadedProfiles,
  type Profile,
} from '../profiles.js';
import { shiftWeek } from '../weeks.js';
import type { HelloFreshClient } from '../client.js';
import { foodMeta } from './hints.js';
import {
  attempt,
  boxNumbering,
  boxNumbers,
  compactEstimate,
  compactSelection,
  dateOf,
  estimateFor,
  hellofreshPrice,
  isUnresizableFirstBox,
  loadAccount,
  nextBoxNumberParam,
  premiumCentsOf,
  readMenu,
  readPersonal,
  readPicks,
  weekParam,
  type Account,
} from './shared.js';
import type { ToolDeps } from './index.js';

const readOnly = (title: string) => toolAnnotations({ title, readOnly: true, idempotent: true, openWorld: true });

// ---- parameters -----------------------------------------------------------------------

const builtinNames = BUILTIN_PROFILES.map((p) => `"${p.name}"`).join(', ');

const profileParam = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .describe(
    `The planner profile to plan for, by name (hf_list_profiles lists them; the built-ins are ${builtinNames}). ` +
      'A profile sets the servings and meal count, the allowed recipe categories, and what to favour ' +
      '(kid friendly, quick, adventurous) and the premium cap. Decide which profile applies to the week before calling.',
  );
const suggestInput = {
  week: weekParam,
  profile: profileParam,
  people: z
    .union([z.literal(2), z.literal(3), z.literal(4), z.literal(6)])
    .optional()
    .describe('Servings for this week only, overriding the profile’s people (2, 3, 4 or 6).'),
  avoid_indexes: z
    .array(z.number().int().positive())
    .max(50)
    .optional()
    .describe('Menu indexes never to suggest (e.g. a recipe someone dislikes).'),
  avoid_recent_weeks: z
    .number()
    .int()
    .min(0)
    .max(12)
    .optional()
    .describe(
      'Skip recipes picked in this many weeks before the week (default: the profile’s avoidRepeatWeeks, usually 4; ' +
        '0 allows repeats). ' +
        'Read best effort, like hf_recent_picks.',
    ),
  max_premium_per_serving_cents: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Highest premium upcharge per serving, in US cents (default: the profile’s premiumCapCents; 0 = no premiums).'),
};

interface SuggestArgs {
  week: string;
  profile: string;
  people?: 2 | 3 | 4 | 6;
  avoid_indexes?: number[];
  avoid_recent_weeks?: number;
  max_premium_per_serving_cents?: number;
}

// ---- the shared suggestion read ----------------------------------------------------------

interface Planned {
  menu: ProjectedMenu;
  suggestion: Suggestion;
  /** What the user's favourites and ratings contributed (best effort). */
  personal: Record<string, unknown>;
  recent?: { weeks: string[]; avoidedNames: string[]; unreadable?: Array<{ week: string; reason: string }> };
}

async function plan(
  client: HelloFreshClient,
  account: Account,
  delivery: ProjectedDelivery,
  profile: Profile,
  args: SuggestArgs,
): Promise<Planned> {
  const back = args.avoid_recent_weeks ?? profile.avoidRepeatWeeks;
  const weeks = Array.from({ length: back }, (_, i) => shiftWeek(args.week, i - back));
  const [menu, picks, mine] = await Promise.all([
    readMenu(client, account, delivery, args.week),
    back > 0 ? readPicks(client, account, weeks) : undefined,
    readPersonal(client),
  ]);
  const suggestion = suggestMeals(menu, {
    profile,
    people: args.people,
    avoidIndexes: args.avoid_indexes,
    avoidNames: picks?.recipeNames,
    maxPremiumPerServingCents: args.max_premium_per_serving_cents,
    favoriteRecipeIds: mine.favoriteRecipeIds,
    ratings: mine.ratings,
  });
  const lowRated = mine.ratings.filter((r) => r.rating <= LOW_RATING).length;
  return {
    menu,
    suggestion,
    personal: {
      ...(mine.favoriteRecipeIds ? { favorites: mine.favoriteRecipeIds.length } : {}),
      ratings: mine.ratings.length,
      ...(mine.ratingsSkipped > 0 ? { ratingsSkipped: mine.ratingsSkipped } : {}),
      ...(lowRated > 0 ? { lowRated } : {}),
      ...(mine.unreadable.length > 0 ? { unreadable: mine.unreadable } : {}),
    },
    ...(picks
      ? {
          recent: {
            weeks,
            avoidedNames: picks.recipeNames,
            ...(picks.unreadable.length > 0 ? { unreadable: picks.unreadable } : {}),
          },
        }
      : {}),
  };
}

function compactCandidate(c: Candidate) {
  return {
    index: c.index,
    name: c.name,
    category: c.category,
    protein: c.protein,
    ...(c.baseIndex !== undefined ? { baseIndex: c.baseIndex } : {}),
    ...(c.favorite ? { favorite: true } : {}),
    kidFriendly: c.kidFriendly,
    totalMinutes: c.totalMinutes,
    ...(c.premiumPerServingCents > 0 ? { premiumPerServingCents: c.premiumPerServingCents, premiumBoxCents: c.premiumBoxCents } : {}),
    ...(c.selected ? { selected: true } : {}),
    score: c.score,
    reasons: c.reasons,
  };
}

function suggestionFields(s: Suggestion) {
  return {
    maxPremiumPerServingCents: s.maxPremiumPerServingCents,
    picks: s.picks.map(compactCandidate),
    alternates: s.alternates.map((a) => ({ slot: a.slot, for: a.for, options: a.options.map(compactCandidate) })),
    ...(s.excluded.length > 0 ? { excluded: s.excluded } : {}),
    ...(s.warning ? { warning: s.warning } : {}),
  };
}

// ---- weekly-plan helpers ---------------------------------------------------------------------

/** The product price/fees for `sku`: this week's own, another upcoming week's at that size, or the plan's unit price. */
function priceFor(
  sku: string,
  delivery: ProjectedDelivery,
  upcoming: readonly ProjectedDelivery[],
  account: Account,
): { priceCents: number; feeCents?: number; shippingCents?: number; priceFrom: string } | undefined {
  const fees = { feeCents: delivery.feeCents, shippingCents: delivery.shippingCents };
  if (delivery.sku === sku && delivery.priceCents !== undefined) return { priceCents: delivery.priceCents, ...fees, priceFrom: 'this week' };
  const other = upcoming.find((d) => d.sku === sku && d.priceCents !== undefined);
  if (other) return { priceCents: other.priceCents!, ...fees, priceFrom: `${other.week} (same box size)` };
  const product = account.subscription.product;
  if (product?.sku === sku && product.unitPrice !== undefined) return { priceCents: product.unitPrice, ...fees, priceFrom: 'the plan price' };
  return undefined;
}

/**
 * The local estimate for `sku` (the fallback when HelloFresh's price cannot be
 * read): the upcoming list prices the size and numbers the box, as if the week
 * runs (an unskip makes it count).
 */
async function localEstimate(
  client: HelloFreshClient,
  account: Account,
  delivery: ProjectedDelivery,
  sku: string,
  picks: ReadonlyArray<{ premiumBoxCents: number }>,
  args: { week: string; box_number?: number; next_box_number?: number },
) {
  const upcoming = ((await client.listDeliveries()).items ?? []).map(projectDelivery);
  const numbering = boxNumbering(account.subscription, args.next_box_number);
  const boxNumber =
    args.box_number ??
    boxNumbers(
      upcoming.map((d) => (d.week === args.week ? { ...d, status: 'running' as const } : d)),
      numbering.next,
    ).get(args.week);
  const price = priceFor(sku, delivery, upcoming, account);
  const estimate = price
    ? estimateFor(
        { ...delivery, ...price },
        picks.map((p) => ({ premiumBoxCents: p.premiumBoxCents, quantity: 1 })),
        account,
        boxNumber,
      )
    : undefined;
  return { estimate, priceFrom: price?.priceFrom, numberingNote: numbering.note, boxNumber };
}

/** Why the week can no longer be changed, if it cannot. */
function lockedReason(delivery: ProjectedDelivery, week: string, now: number): string | undefined {
  if (delivery.status !== 'running' && delivery.status !== 'skipped') return `${week} is ${delivery.status}: it can no longer be changed.`;
  if (delivery.cutoffDate && Date.parse(delivery.cutoffDate) <= now) {
    return `The cutoff for ${week} passed at ${delivery.cutoffDate}: its box and picks can no longer be changed.`;
  }
  return undefined;
}

// ---- registration ------------------------------------------------------------------------------

export function registerPlannerTools(server: McpServer, deps: ToolDeps): void {
  const { client } = deps;
  const now = deps.now ?? Date.now;
  const profiles = deps.profiles ?? createProfileStore();
  /** The named profile — loading the config on first use, so a bad config is a tool error, never a boot failure. */
  const profileFor = (name: string) => resolveProfile(profiles(), name);

  server.registerTool(
    'hf_list_profiles',
    {
      description:
        'List the meal-planner profiles hf_suggest_meals and hf_weekly_plan accept (e.g. a 2-person adventurous ' +
        'week, a 4-person kid-friendly week): each one’s servings, meals, box SKU, allowed recipe categories, ' +
        'preferences and premium cap, and where the profiles were loaded from (HELLOFRESH_PROFILES, a profiles ' +
        'file, or the built-in defaults). Local config only: no HelloFresh call.',
      annotations: toolAnnotations({ title: 'HelloFresh: list planner profiles', readOnly: true, idempotent: true, openWorld: false }),
      _meta: foodMeta('lookup', { aliases: ['hellofresh profiles', 'meal plan profiles', 'who is the box for'] }),
      inputSchema: z.object({}),
    },
    async () => {
      const loaded: LoadedProfiles = profiles();
      return minifiedResult({
        source: loaded.source,
        profiles: loaded.profiles.map((p) => ({ ...p, label: profileLabel(p), sku: profileSku(p) })),
        configure:
          `Set ${PROFILES_ENV} to a JSON array of profiles, or point ${PROFILES_FILE_ENV} at a JSON file ` +
          `(default ${DEFAULT_PROFILES_FILE}). Each: name, people (2/3/4/6), premiumCapCents; optional label, meals ` +
          '(2–6), categories, kidFriendly, maxMinutes, adventurous, avoidRepeatWeeks. Restart the server after a change.',
      });
    },
  );

  server.registerTool(
    'hf_suggest_meals',
    {
      description:
        'Suggest the dinners to pick for a HelloFresh delivery week for a planner profile (hf_list_profiles): ranks ' +
        'every dish and protein swap on the week’s menu in the profile’s allowed categories by its preferences ' +
        '(kid friendly, quick, adventurous) and premium cap, skips recipes picked in recent weeks, prefers varied ' +
        'proteins (e.g. one shrimp + one fish), favours the user’s favourite recipes, never suggests one they rated 2 ' +
        'or lower, and returns the top picks plus 2 alternates per slot, each with its reasons. Read-only: pick with ' +
        'hf_select_meals.',
      annotations: readOnly('HelloFresh: suggest meals'),
      _meta: foodMeta('other', { aliases: ['what should we have', 'hellofresh suggestions', 'seafood dinners', 'pick dinners'] }),
      inputSchema: z.object(suggestInput),
    },
    async (args) => {
      const profile = profileFor(args.profile);
      const account = await loadAccount(client);
      const delivery = projectDelivery(await client.getDelivery(account.subscriptionId, args.week));
      const { suggestion, recent, personal } = await plan(client, account, delivery, profile, args);
      return minifiedResult({
        week: args.week,
        profile: profile.name,
        servings: suggestion.people,
        box: { current: delivery.sku, required: profileSku(profile, suggestion.people) },
        ...suggestionFields(suggestion),
        personal,
        ...(recent ? { recentPicks: recent } : {}),
        next: `hf_weekly_plan {week: "${args.week}", profile: "${profile.name}"} prices it and lists the writes; hf_select_meals picks.`,
      });
    },
  );

  server.registerTool(
    'hf_weekly_plan',
    {
      description:
        'Plan one HelloFresh delivery week for a planner profile (hf_list_profiles — e.g. a 4-person family week) in ' +
        'one read: the box size the week needs versus what it has, suggested picks with alternates, the box price ' +
        '(HelloFresh’s own checkout total for that size plus the picks’ premium upcharge, or a labelled local ' +
        'estimate when that cannot be read), a one-line summary ' +
        'for the user to approve, and the exact follow-up write calls (hf_unskip_week, hf_set_week_size, ' +
        'hf_select_meals) in order. The subscription’s first box cannot be resized, so for it no size change is ' +
        'proposed (notes say so). Read-only: it changes nothing.',
      annotations: readOnly('HelloFresh: weekly plan'),
      _meta: foodMeta('other', { aliases: ['plan hellofresh week', 'weekly meal plan', 'hellofresh plan this week'] }),
      inputSchema: z.object({
        ...suggestInput,
        box_number: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe(
            'This box’s number, counting every box ever delivered — overrides the number derived from next_box_number. ' +
              'Only used by the local estimate (when HelloFresh’s price cannot be read).',
          ),
        next_box_number: nextBoxNumberParam,
      }),
    },
    async (args) => {
      const { week } = args;
      const profile = profileFor(args.profile);
      const account = await loadAccount(client);
      const delivery = projectDelivery(await client.getDelivery(account.subscriptionId, week));
      // The first box cannot be resized (a HelloFresh rule): plan for the box as it is, and say so.
      const wanted = profileSku(profile, args.people ?? profile.people);
      const firstBox = isUnresizableFirstBox(account.subscription, week);
      const firstBoxKnown = !!delivery.sku && !!delivery.servings && !!delivery.meals;
      const firstBoxFixed = firstBox && firstBoxKnown;
      /** The first box with no full size read: it cannot be resized, and its size cannot be compared. */
      const firstBoxUnknown = firstBox && !firstBoxKnown;
      const firstBoxDiffers = firstBoxFixed && delivery.sku !== wanted;
      const planProfile = firstBoxDiffers ? { ...profile, meals: delivery.meals! } : profile;
      const planArgs = firstBoxDiffers || firstBoxUnknown ? { ...args, people: delivery.servings as SuggestArgs['people'] } : args;
      const { menu, suggestion, recent, personal } = await plan(client, account, delivery, planProfile, planArgs);
      const { picks, people } = suggestion;
      // A first box keeps its size; the menu read above needs `delivery.sku`, so it is set here.
      const sku = firstBoxDiffers || firstBoxUnknown ? delivery.sku! : profileSku(profile, people);
      const notes = firstBoxDiffers
        ? [
            `${week} is the first box of this subscription, which HelloFresh says cannot be resized: it keeps ` +
              `${delivery.sku} (the ${profile.name} profile would want ${wanted}), so the picks and estimate are for it as it is.`,
          ]
        : firstBoxUnknown
          ? [
              `${week} is the first box of this subscription, which HelloFresh says cannot be resized, and HelloFresh ` +
                `returned no full box size for it (box ${delivery.sku} for ${delivery.servings} people, no meal count): no size ` +
                `change is proposed (hf_set_week_size would refuse it), and the picks follow the ${profile.name} profile’s meal count for the box’s ${delivery.servings} servings.`,
            ]
          : [];

      const sizeChangeNeeded = delivery.sku !== sku;
      const skipped = delivery.status === 'skipped';
      const locked = lockedReason(delivery, week, now());

      // HelloFresh's own price for the box the plan needs, with the picks; else the local estimate.
      const real = await attempt(() =>
        hellofreshPrice(
          client,
          account,
          {
            week,
            sku,
            people,
            deliveryOption: delivery.deliveryOption,
            deliveryDate: delivery.deliveryDate,
            recipeIndexes: picks.map((p) => p.index),
            premiumCents: premiumCentsOf(picks),
          },
          now(),
        ),
      );
      let estimate: Awaited<ReturnType<typeof localEstimate>>['estimate'];
      let priceFields: Record<string, unknown>;
      if (real.ok) {
        priceFields = { price: real.value };
      } else {
        const local = await localEstimate(client, account, delivery, sku, picks, args);
        estimate = local.estimate;
        const why = `HelloFresh’s price calculator could not be used (${real.reason})`;
        priceFields = estimate
          ? {
              price: {
                source: 'estimate' as const,
                reason: `${why}, so this is a local estimate.`,
                ...compactEstimate(estimate),
                ...(estimate.voucher ? { voucher: estimate.voucher.code } : {}),
                priceFrom: local.priceFrom,
              },
              ...(args.box_number === undefined
                ? {
                    boxNumberNote:
                      skipped && local.boxNumber !== undefined
                        ? `${local.numberingNote} ${week} is skipped, but it was counted as a running box (box ${local.boxNumber}) because the plan unskips it; later weeks shift up by one once it is unskipped.`
                        : local.numberingNote,
                  }
                : {}),
            }
          : { priceWarning: `${why}, and HelloFresh shows no price for ${sku} on this account, so the box total is not estimated.` };
      }

      const chosen = new Set(picks.map((p) => p.index));
      const alreadyPicked =
        !sizeChangeNeeded &&
        !skipped &&
        picks.length > 0 &&
        menu.selected.length === picks.length &&
        menu.selected.every((s) => chosen.has(s.index));

      const followUp = locked
        ? []
        : [
            ...(skipped ? [{ tool: 'hf_unskip_week', arguments: { week }, why: `${week} is skipped.` }] : []),
            ...(sizeChangeNeeded
              ? [
                  {
                    tool: 'hf_set_week_size',
                    arguments: { week, people, meals: profile.meals },
                    why: `${week} is ${delivery.sku}; the ${profile.name} profile needs ${sku}.`,
                  },
                ]
              : []),
            ...(picks.length > 0 && !alreadyPicked
              ? [{ tool: 'hf_select_meals', arguments: { week, meals: picks.map((p) => p.index) }, why: 'Pick the suggested meals.' }]
              : []),
          ];

      return minifiedResult({
        week,
        profile: profile.name,
        servings: people,
        delivery: { deliveryDate: dateOf(delivery.deliveryDate), cutoffDate: delivery.cutoffDate, status: delivery.status },
        box: { current: delivery.sku, required: sku, sizeChangeNeeded },
        currentPicks: menu.selected.map(compactSelection),
        ...suggestionFields(suggestion),
        ...priceFields,
        summary: summaryText({
          profile,
          people,
          deliveryDate: delivery.deliveryDate,
          picks,
          estimate,
          ...(real.ok ? { price: { ...real.value, grandTotal: real.value.grandTotal! } } : {}),
        }),
        ...(locked ? { locked } : {}),
        ...(alreadyPicked ? { note: 'The suggested meals are already picked for this week; nothing to change.' } : {}),
        ...(notes.length > 0 ? { notes } : {}),
        followUp,
        personal,
        ...(followUp.length > 0
          ? {
              followUpNote:
                'Run these in order once the user approves the summary. Each is confirm-gated: call it without ' +
                'confirmToken to preview, then again with the token. A size change may reset the picks, so pick last.',
            }
          : {}),
        ...(recent ? { recentPicks: recent } : {}),
      });
    },
  );
}
