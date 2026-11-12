// The weekly-planner scoring: pure functions over a projected menu, no I/O.
//
// Everything household-specific comes from a planner PROFILE (src/profiles.ts):
// how many people and meals, which recipe categories are allowed, and which
// traits to favour. The scoring, per dish (base course or protein swap):
//   - kidFriendly profiles: family-friendly recipes boosted, spicy marked down;
//   - maxMinutes: recipes within it boosted strongly, slower ones marked down
//     (without maxMinutes a mild preference for ≤ 30 min);
//   - adventurous profiles: less familiar cuisines boosted, and premiums within
//     the cap only lightly penalised;
//   - premiums over the profile's per-serving cap are excluded; under it they
//     cost points in proportion to the upcharge × servings.
// Picks then favour protein diversity (distinct categories, and within
// Seafood distinct kinds — e.g. one shrimp + one fish), never repeat a recently
// picked recipe, and never pair a course with its own protein swap.

import type { ProjectedMeal, ProjectedMenu, SeafoodKind } from './normalize.js';
import type { Profile } from './profiles.js';
import { profileLabel } from './profiles.js';

/** The bonus for a pick whose protein is not yet in the box. */
const DIVERSITY_BONUS = 15;
const QUICK_MINUTES = 30;
/** Cuisines that do not count as adventurous. */
const FAMILIAR_CUISINES = new Set(['American', 'Italian', 'Irish', 'British']);

export interface Candidate {
  index: number;
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

type Dish = Pick<Candidate, 'index' | 'baseIndex' | 'name' | 'category' | 'seafoodKind' | 'premiumPerServingCents' | 'selected'>;

/** Every dish on the menu: base courses and protein swaps (which share their course's recipe traits). */
function dishes(menu: ProjectedMenu): Array<{ dish: Dish; course: ProjectedMeal }> {
  return menu.meals.flatMap((course) => [
    {
      dish: {
        index: course.index,
        name: course.name,
        category: course.category,
        seafoodKind: course.seafoodKind,
        premiumPerServingCents: course.premiumPerServingCents,
        selected: course.selectedQuantity > 0,
      },
      course,
    },
    ...course.variants.map((v) => ({
      dish: {
        index: v.index,
        baseIndex: course.index,
        name: v.name ?? v.title,
        category: v.category,
        seafoodKind: v.seafoodKind,
        premiumPerServingCents: v.premiumPerServingCents,
        selected: v.selectedQuantity > 0,
      },
      course,
    })),
  ]);
}

const proteinOf = (d: Pick<Dish, 'category' | 'seafoodKind'>) => d.seafoodKind ?? d.category ?? 'unknown';

function score(dish: Dish, course: ProjectedMeal, profile: Profile, people: number): Candidate {
  const reasons: string[] = [];
  let points = 0;
  const add = (n: number, why: string) => {
    points += n;
    reasons.push(why);
  };
  const minutes = course.totalMinutes;
  const premiumBoxCents = dish.premiumPerServingCents * people;

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

  return {
    ...dish,
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

  const excluded: Exclusion[] = [];
  const eligible: Candidate[] = [];
  for (const { dish, course } of dishes(menu)) {
    if (categories && !categories.has((dish.category ?? '').toLowerCase())) continue;
    const reason = avoidIndexes.has(dish.index)
      ? 'avoided by request'
      : dish.name && avoidNames.has(normalName(dish.name))
        ? 'picked in a recent week'
        : dish.premiumPerServingCents > cap
          ? `premium ${dollars(dish.premiumPerServingCents)}/serving over the ${dollars(cap)} cap`
          : undefined;
    if (reason) excluded.push({ index: dish.index, name: dish.name, reason });
    else eligible.push(score(dish, course, profile, people));
  }
  const ranked = eligible.sort((a, b) => b.score - a.score || a.index - b.index);

  const picks = choose(ranked, profile.meals);
  const used = new Set(picks.map((p) => p.index));
  const alternates = picks.map((pick, slot) => {
    const otherCourses = new Set(picks.filter((p) => p !== pick).map(courseOf));
    const options = ranked
      .filter((c) => !used.has(c.index) && !otherCourses.has(courseOf(c)))
      .sort((a, b) => Number(b.protein === pick.protein) - Number(a.protein === pick.protein))
      .slice(0, 2);
    for (const o of options) used.add(o.index);
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
}

/**
 * The approval line:
 * `Family week (4 servings) — delivering Mon 11/30: <A> + <B>. Est. box total $X (−$Y CODE).`
 */
export function summaryText({ profile, people, deliveryDate, picks, estimate }: SummaryInput): string {
  const meals = picks.length > 0 ? picks.map((p) => p.name ?? '(unnamed meal)').join(' + ') : 'no picks fit';
  let total = 'Box total not estimated.';
  if (estimate) {
    const discount =
      estimate.discountCents > 0
        ? `−${dollars(estimate.discountCents)}${estimate.voucher?.code ? ` ${estimate.voucher.code}` : ''}`
        : 'no voucher discount';
    total = `Est. box total ${dollars(estimate.totalCents)} (${discount}).`;
  }
  return `${profileLabel(profile)} week (${people ?? profile.people} servings) — delivering ${dayLabel(deliveryDate) ?? '(date unknown)'}: ${meals}. ${total}`;
}
