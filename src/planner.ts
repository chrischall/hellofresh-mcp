// The weekly-planner scoring: pure functions over a projected menu, no I/O.
//
// Everything household-specific comes from a planner PROFILE (src/profiles.ts):
// how many people and meals, which recipe categories are allowed, and which
// traits to favour. The scoring, per dish (one per recipe: see dishes()):
//   - kidFriendly profiles: family-friendly recipes boosted, spicy marked down;
//   - maxMinutes: recipes within it boosted strongly, slower ones marked down
//     (without maxMinutes a mild preference for ≤ 30 min);
//   - adventurous profiles: less familiar cuisines boosted, and premiums within
//     the cap only lightly penalised;
//   - premiums over the profile's per-serving cap are excluded; under it they
//     cost points in proportion to the upcharge × servings.
//   - favourites: a recipe the user favourited (the dish's own recipe or, for
//     a protein swap, its base recipe) is boosted;
//   - ratings: a recipe the user rated 2 or lower (on either ratings scale) is
//     NEVER suggested (it is listed in `excluded` with the rating).
// HelloFresh's own `averageRating` is not used: the weekly menu does not carry
// it, and reading it means one recipe-detail call per dish — not cheap.
// Picks then favour protein diversity (distinct categories, and within
// Seafood distinct kinds — e.g. one shrimp + one fish) and never repeat a
// recently picked recipe. Each recipe is ONE dish: a base course in the allowed
// categories stands for itself (never an upgrade swap such as "2x Tilapia");
// only a base outside them is replaced by its cheapest allowed protein swap.
// Picks and alternates are always distinct recipes.

import type { ProjectedMeal, ProjectedMenu, ProjectedVariant, SeafoodKind } from './normalize.js';
import type { Profile } from './profiles.js';
import { profileLabel } from './profiles.js';

/** The bonus for a pick whose protein is not yet in the box. */
const DIVERSITY_BONUS = 15;
const QUICK_MINUTES = 30;
/** The bonus for a recipe the user favourited. */
const FAVORITE_BONUS = 25;
/** A user rating at or below this (either scale) means never suggest the recipe. */
export const LOW_RATING = 2;
/** Cuisines that do not count as adventurous. */
const FAMILIAR_CUISINES = new Set(['American', 'Italian', 'Irish', 'British']);

export interface Candidate {
  index: number;
  /** The dish's own recipe id (a swap's own, else the course's). */
  recipeId?: string;
  /** The user favourited this recipe (or, for a swap, its base recipe). */
  favorite?: true;
  /** Set when this dish is a protein swap of course `baseIndex`. */
  baseIndex?: number;
  name?: string;
  category: string | null;
  seafoodKind: SeafoodKind | null;
  /** The diversity key: the seafood kind for Seafood, otherwise the category. */
  protein: string;
  kidFriendly: boolean;
  quick: boolean;
  totalMinutes?: number;
  cuisine?: string;
  premiumPerServingCents: number;
  /** The upcharge for the week's servings. */
  premiumBoxCents: number;
  /** Already picked for the week. */
  selected: boolean;
  score: number;
  reasons: string[];
}

export interface Exclusion {
  index: number;
  name?: string;
  reason: string;
}

export interface SuggestOptions {
  profile: Profile;
  /** Servings override (default: the profile's people). */
  people?: number;
  /** Menu indexes never to suggest. */
  avoidIndexes?: readonly number[];
  /** Recipe names picked recently (matched case- and space-insensitively). */
  avoidNames?: readonly string[];
  /** Highest premium per serving, cents (default: the profile's cap). */
  maxPremiumPerServingCents?: number;
  /** Recipe ids the user favourited: boosted. */
  favoriteRecipeIds?: readonly string[];
  /** The user's own recipe ratings: a rating ≤ LOW_RATING means never suggest it. */
  ratings?: ReadonlyArray<{ recipeId: string; rating: number; scale: string }>;
}

export interface Suggestion {
  profile: string;
  meals: number;
  people: number;
  maxPremiumPerServingCents: number;
  /** The best set (fewer when the menu has fewer eligible courses). */
  picks: Candidate[];
  /** Up to 2 alternates per pick, each keeping the set valid. */
  alternates: Array<{ slot: number; for?: string; options: Candidate[] }>;
  /** Every eligible dish, best first. */
  ranked: Candidate[];
  excluded: Exclusion[];
  warning?: string;
}

export const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

const normalName = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ');

const courseOf = (c: Candidate) => c.baseIndex ?? c.index;

type Dish = Pick<
  Candidate,
  'index' | 'baseIndex' | 'recipeId' | 'name' | 'category' | 'seafoodKind' | 'premiumPerServingCents' | 'selected'
> & { double?: boolean };

const proteinOf = (d: Pick<Dish, 'category' | 'seafoodKind'>) => d.seafoodKind ?? d.category ?? 'unknown';

const titledDouble = (v: Pick<ProjectedVariant, 'title' | 'name'>) => /\b2x\b/i.test(`${v.title ?? ''} ${v.name ?? ''}`);

/**
 * A double-protein swap — an upgrade, not a swap: "2x" in its title or name
 * ("2x Shrimp", "… with 2x Tilapia"), OR a premium above the cheapest
 * single-protein swap of the SAME protein on the same base course (e.g.
 * "Extra Shrimp" at +$3.99 next to "Shrimp" at +$0). A different protein at a
 * premium (Salmon next to Shrimp) is an ordinary swap.
 */
export function isDoubleProtein(variant: ProjectedVariant, siblings: readonly ProjectedVariant[]): boolean {
  if (titledDouble(variant)) return true;
  const protein = proteinOf(variant);
  const singles = siblings.filter((s) => !titledDouble(s) && proteinOf(s) === protein).map((s) => s.premiumPerServingCents);
  return singles.length > 0 && variant.premiumPerServingCents > Math.min(...singles);
}

/**
 * One dish per recipe (a base course and its protein swaps are ONE recipe):
 * the base course itself when it is in the allowed categories (or there is no
 * allowlist) — never an upgrade swap of it; otherwise the cheapest swap that
 * IS allowed (e.g. a shrimp swap of a chicken dish), a double-protein swap
 * only when no single-protein swap qualifies; none when nothing qualifies.
 */
function dishes(menu: ProjectedMenu, allowed: (category: string | null) => boolean): Array<{ dish: Dish; course: ProjectedMeal }> {
  return menu.meals.flatMap((course) => {
    if (allowed(course.category)) {
      return [
        {
          dish: {
            index: course.index,
            recipeId: course.recipeId,
            name: course.name,
            category: course.category,
            seafoodKind: course.seafoodKind,
            premiumPerServingCents: course.premiumPerServingCents,
            selected: course.selectedQuantity > 0,
          },
          course,
        },
      ];
    }
    const double = (v: ProjectedVariant) => isDoubleProtein(v, course.variants);
    const [swap] = course.variants
      .filter((v) => allowed(v.category))
      .sort((a, b) => Number(double(a)) - Number(double(b)) || a.premiumPerServingCents - b.premiumPerServingCents || a.index - b.index);
    if (!swap) return [];
    return [
      {
        dish: {
          index: swap.index,
          baseIndex: course.index,
          recipeId: swap.recipeId ?? course.recipeId,
          ...(double(swap) ? { double: true } : {}),
          name: swap.name ?? swap.title,
          category: swap.category,
          seafoodKind: swap.seafoodKind,
          premiumPerServingCents: swap.premiumPerServingCents,
          selected: swap.selectedQuantity > 0,
        },
        course,
      },
    ];
  });
}

/** The recipe ids a dish stands for: its own and, for a swap, its base course's. */
const recipeIdsOf = (dish: Dish, course: ProjectedMeal) => [dish.recipeId, course.recipeId].filter((id): id is string => !!id);

function score(dish: Dish, course: ProjectedMeal, profile: Profile, people: number, favorite: boolean): Candidate {
  const reasons: string[] = [];
  let points = 0;
  const add = (n: number, why: string) => {
    points += n;
    reasons.push(why);
  };
  const minutes = course.totalMinutes;
  const premiumBoxCents = dish.premiumPerServingCents * people;

  if (dish.double) reasons.push('double-protein upgrade (no single-protein swap fits)');
  if (favorite) add(FAVORITE_BONUS, 'one of your favorites');
  if (profile.kidFriendly) {
    if (course.kidFriendly) add(30, 'kid friendly');
    if (course.tags.some((t) => /spicy/i.test(t))) add(-10, 'spicy');
  }
  if (minutes !== undefined) {
    const limit = profile.maxMinutes ?? QUICK_MINUTES;
    const [bonus, penalty] = profile.maxMinutes !== undefined ? [20, -15] : [5, -5];
    if (minutes <= limit) add(bonus, `ready in ${minutes} min`);
    else add(penalty, `takes ${minutes} min (over ${limit})`);
  }
  if (profile.adventurous && course.cuisine && !FAMILIAR_CUISINES.has(course.cuisine)) add(15, `adventurous: ${course.cuisine}`);
  if (premiumBoxCents > 0) {
    const why = `premium +${dollars(dish.premiumPerServingCents)}/serving (+${dollars(premiumBoxCents)} for ${people} servings)`;
    add(profile.adventurous ? 5 - Math.round(premiumBoxCents / 200) : -Math.round(premiumBoxCents / 100), why);
  }

  const { double: _double, ...rest } = dish;
  return {
    ...rest,
    ...(favorite ? { favorite: true as const } : {}),
    protein: proteinOf(dish),
    kidFriendly: course.kidFriendly,
    quick: course.quick,
    totalMinutes: minutes,
    cuisine: course.cuisine,
    premiumBoxCents,
    score: points,
    reasons,
  };
}

/** Greedy: each next pick is the best score (+ the diversity bonus for a new protein) from a course not yet used. */
function choose(ranked: Candidate[], count: number): Candidate[] {
  const picks: Candidate[] = [];
  while (picks.length < count) {
    const courses = new Set(picks.map(courseOf));
    const proteins = new Set(picks.map((p) => p.protein));
    let best: { c: Candidate; total: number } | undefined;
    for (const c of ranked) {
      if (courses.has(courseOf(c))) continue;
      const total = c.score + (picks.length > 0 && !proteins.has(c.protein) ? DIVERSITY_BONUS : 0);
      if (!best || total > best.total) best = { c, total };
    }
    if (!best) break;
    picks.push(best.c);
  }
  return picks;
}

/** Rank the week's menu for a profile and choose its meals plus 2 alternates per slot. */
export function suggestMeals(menu: ProjectedMenu, opts: SuggestOptions): Suggestion {
  const { profile } = opts;
  const people = opts.people ?? profile.people;
  const cap = opts.maxPremiumPerServingCents ?? profile.premiumCapCents;
  const categories = profile.categories ? new Set(profile.categories.map((c) => c.toLowerCase())) : undefined;
  const avoidIndexes = new Set(opts.avoidIndexes ?? []);
  const avoidNames = new Set((opts.avoidNames ?? []).map(normalName));

  const allowed = (category: string | null) => !categories || categories.has((category ?? '').toLowerCase());
  const favorites = new Set(opts.favoriteRecipeIds ?? []);
  const lowRated = new Map<string, { rating: number; scale: string }>();
  for (const r of opts.ratings ?? []) if (r.rating <= LOW_RATING && !lowRated.has(r.recipeId)) lowRated.set(r.recipeId, r);

  const excluded: Exclusion[] = [];
  const eligible: Candidate[] = [];
  for (const { dish, course } of dishes(menu, allowed)) {
    const ids = recipeIdsOf(dish, course);
    const low = ids.map((id) => lowRated.get(id)).find((r) => r !== undefined);
    const reason = low
      ? `you rated it ${low.rating} (${low.scale} scale): low-rated recipes are never suggested`
      : avoidIndexes.has(dish.index)
        ? 'avoided by request'
      : dish.name && avoidNames.has(normalName(dish.name))
        ? 'picked in a recent week'
        : dish.premiumPerServingCents > cap
          ? `premium ${dollars(dish.premiumPerServingCents)}/serving over the ${dollars(cap)} cap`
          : undefined;
    if (reason) excluded.push({ index: dish.index, name: dish.name, reason });
    else eligible.push(score(dish, course, profile, people, ids.some((id) => favorites.has(id))));
  }
  const ranked = eligible.sort((a, b) => b.score - a.score || a.index - b.index);

  const picks = choose(ranked, profile.meals);
  // Every pick and alternate is a distinct RECIPE (a swap shares its base course's recipe).
  const usedRecipes = new Set(picks.map(courseOf));
  const alternates = picks.map((pick, slot) => {
    const options = ranked
      .filter((c) => !usedRecipes.has(courseOf(c)))
      .sort((a, b) => Number(b.protein === pick.protein) - Number(a.protein === pick.protein))
      .slice(0, 2);
    for (const o of options) usedRecipes.add(courseOf(o));
    return { slot: slot + 1, for: pick.name, options };
  });

  const scope = profile.categories ? ` (${profile.categories.join(', ')})` : '';
  return {
    profile: profile.name,
    meals: profile.meals,
    people,
    maxPremiumPerServingCents: cap,
    picks,
    alternates,
    ranked,
    excluded,
    ...(picks.length < profile.meals
      ? {
          warning:
            `Only ${picks.length} of the ${profile.meals} meals could be suggested: the menu has too few distinct courses ` +
            `matching the profile${scope} within the premium cap and not recently picked. Raise the cap, allow repeats, ` +
            'or pick the rest by hand.',
        }
      : {}),
  };
}

// ---- the approval line -------------------------------------------------------------

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** `Mon 11/30` from an ISO date/timestamp as HelloFresh wrote it (its own offset), or undefined. */
export function dayLabel(iso: string | undefined): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
  if (!m) return undefined;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return `${WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]} ${month}/${day}`;
}

export interface SummaryInput {
  profile: Profile;
  /** Servings (default: the profile's people). */
  people?: number;
  deliveryDate: string | undefined;
  picks: ReadonlyArray<{ name?: string }>;
  estimate: { totalCents: number; discountCents: number; voucher?: { code?: string } } | undefined;
  /** HelloFresh's own price (US dollars) — wins over `estimate` when present. */
  price?: { grandTotal: number; discount?: number; couponCode?: string; premiumUpcharge?: number; totalWithPremiums?: number };
}

const usd = (amount: number) => `$${amount.toFixed(2)}`;

function priceLine(p: NonNullable<SummaryInput['price']>): string {
  const discount = p.discount ? `−${usd(p.discount)}${p.couponCode ? ` ${p.couponCode}` : ''}` : 'no discount';
  if (p.totalWithPremiums === undefined) return `Box total ${usd(p.grandTotal)} (HelloFresh price, premiums not included; ${discount}).`;
  const source = p.premiumUpcharge ? `HelloFresh price ${usd(p.grandTotal)} + ${usd(p.premiumUpcharge)} premiums` : 'HelloFresh price';
  return `Box total ${usd(p.totalWithPremiums)} (${source}; ${discount}).`;
}

/**
 * The approval line:
 * `Family week (4 servings) — delivering Mon 11/30: <A> + <B>. Est. box total $X (−$Y CODE).`
 */
export function summaryText({ profile, people, deliveryDate, picks, estimate, price }: SummaryInput): string {
  const meals = picks.length > 0 ? picks.map((p) => p.name?.trim() || '(unnamed meal)').join(' + ') : 'no picks fit';
  let total = 'Box total not estimated.';
  if (price) {
    total = priceLine(price);
  } else if (estimate) {
    const discount =
      estimate.discountCents > 0
        ? `−${dollars(estimate.discountCents)}${estimate.voucher?.code ? ` ${estimate.voucher.code}` : ''}`
        : 'no voucher discount';
    total = `Est. box total ${dollars(estimate.totalCents)} (${discount}).`;
  }
  const label = profileLabel(profile);
  const week = /week$/i.test(label.trim()) ? label.trim() : `${label} week`;
  return `${week} (${people ?? profile.people} servings) — delivering ${dayLabel(deliveryDate) ?? '(date unknown)'}: ${meals}. ${total}`;
}
