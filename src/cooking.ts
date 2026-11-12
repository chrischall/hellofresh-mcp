// Cooking day: the recipe-detail projection (hf_get_recipe) and the cook-order
// ranking (hf_cooking_plan). Pure — the tools in src/tools/cooking.ts do the
// reads. Recipe text is third-party content: the tools frame it as untrusted.

import { parseDurationMinutes, type SeafoodKind } from './normalize.js';
import type { RawRecipeDetail } from './types.js';

// ---- text -------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: '&', nbsp: ' ', lt: '<', gt: '>', quot: '"', '#39': "'" };

/** HTML or multi-line text → one trimmed line (tags dropped, common entities decoded, whitespace collapsed). */
export function plainText(text: string): string {
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(amp|nbsp|lt|gt|quot|#39);/g, (_, e: string) => ENTITIES[e]!)
    .replace(/\s+/g, ' ')
    .trim();
}

/** The longer of `prepTime` / `totalTime` in minutes (as the menu projection reads it), or undefined. */
export function recipeMinutes(r: { prepTime?: string; totalTime?: string }): number | undefined {
  const times = [parseDurationMinutes(r.prepTime), parseDurationMinutes(r.totalTime)].filter((n): n is number => n !== undefined);
  return times.length > 0 ? Math.max(...times) : undefined;
}

// ---- recipe detail ------------------------------------------------------------------

type YieldEntry = NonNullable<RawRecipeDetail['yields']>[number];

/** The yield for `servings`, else the nearest one (the larger on a tie). */
export function nearestYield(
  yields: RawRecipeDetail['yields'],
  servings: number,
): { yields: number; exact: boolean; entry: YieldEntry } | undefined {
  const numbered = (yields ?? []).filter((y): y is YieldEntry & { yields: number } => typeof y.yields === 'number');
  if (numbered.length === 0) return undefined;
  const best = [...numbered].sort(
    (a, b) => Math.abs(a.yields - servings) - Math.abs(b.yields - servings) || b.yields - a.yields,
  )[0]!;
  return { yields: best.yields, exact: best.yields === servings, entry: best };
}

export interface RecipeIngredient {
  name: string;
  amount?: number;
  unit?: string;
  /** A pantry item HelloFresh does not ship. */
  notInBox?: true;
}

export interface ProjectedRecipe {
  name?: string;
  headline?: string;
  totalMinutes?: number;
  difficulty?: number | string;
  allergens: string[];
  nutritionPerServing: Array<{ name?: string; amount?: number; unit?: string }>;
  /** The servings the ingredient amounts are for. */
  amountsForServings?: number;
  /** Set when the amounts are not for the week's servings (or there are none). */
  yieldsNote?: string;
  ingredients: RecipeIngredient[];
  steps: Array<{ step: number; text: string }>;
  utensils: string[];
  cardLink?: string;
  websiteUrl?: string;
}

const trimmed = (s: string | undefined) => (s === undefined ? undefined : s.trim());

export function projectRecipe(detail: RawRecipeDetail, servings: number): ProjectedRecipe {
  const yieldFor = nearestYield(detail.yields, servings);
  const amounts = new Map((yieldFor?.entry.ingredients ?? []).map((i) => [i.id, i]));
  const ingredients = (detail.ingredients ?? []).filter((i) => !!i.name?.trim()).map((i): RecipeIngredient => {
    const a = i.id !== undefined ? amounts.get(i.id) : undefined;
    return {
      name: i.name!.trim(),
      ...(typeof a?.amount === 'number' ? { amount: a.amount } : {}),
      ...(a?.unit ? { unit: a.unit } : {}),
      ...(i.shipped === false ? { notInBox: true as const } : {}),
    };
  });
  const yieldsNote = !yieldFor
    ? 'HelloFresh lists no ingredient amounts for this recipe: names only.'
    : yieldFor.exact
      ? undefined
      : `HelloFresh lists no ${servings}-serving amounts for this recipe; these are for ${yieldFor.yields} servings (the nearest) — scale them.`;
  const totalMinutes = recipeMinutes(detail);
  const steps = [...(detail.steps ?? [])]
    .sort((a, b) => (a.index ?? Infinity) - (b.index ?? Infinity) || 0)
    .map((s) => plainText(s.instructions ?? s.instructionsHTML ?? ''))
    .filter((text) => text !== '')
    .map((text, i) => ({ step: i + 1, text }));
  return {
    name: trimmed(detail.name),
    headline: trimmed(detail.headline),
    ...(totalMinutes !== undefined ? { totalMinutes } : {}),
    ...(detail.difficulty !== undefined && detail.difficulty !== null ? { difficulty: detail.difficulty } : {}),
    allergens: [...new Set((detail.allergens ?? []).map((a) => a.name).filter((n): n is string => !!n))],
    nutritionPerServing: (detail.nutrition ?? []).map((n) => ({
      name: n.name,
      ...(typeof n.amount === 'number' ? { amount: n.amount } : {}),
      unit: n.unit,
    })),
    ...(yieldFor ? { amountsForServings: yieldFor.yields } : {}),
    ...(yieldsNote ? { yieldsNote } : {}),
    ingredients,
    steps,
    utensils: (detail.utensils ?? [])
      .map((u) => (typeof u === 'string' ? u : u.name))
      .filter((n): n is string => !!n),
    ...(detail.cardLink ? { cardLink: detail.cardLink } : {}),
    ...(detail.websiteUrl ? { websiteUrl: detail.websiteUrl } : {}),
  };
}

// ---- cook order -------------------------------------------------------------------------

export type PerishabilityGroup =
  | 'fish'
  | 'shellfish'
  | 'seafood'
  | 'poultry'
  | 'ground-meat'
  | 'other-meat'
  | 'red-meat'
  | 'veggie';

const GROUPS: Record<PerishabilityGroup, { rank: number; why: string }> = {
  fish: { rank: 1, why: 'Fish is the most perishable protein: cook it first.' },
  shellfish: { rank: 2, why: 'Shellfish keeps only a day or two: cook it early.' },
  seafood: { rank: 3, why: 'Seafood keeps only a couple of days: cook it early in the week.' },
  poultry: { rank: 4, why: 'Raw poultry keeps a few days: cook it before red meat.' },
  'ground-meat': { rank: 5, why: 'Ground meat and sausage spoil sooner than whole cuts.' },
  'other-meat': { rank: 5, why: 'No clear protein category: treated like ground or other meat, mid-week.' },
  'red-meat': { rank: 6, why: 'Whole cuts of beef, pork or lamb keep longest of the proteins.' },
  veggie: { rank: 7, why: 'Vegetarian: the most forgiving, so it goes last.' },
};

const SHELLFISH = /\b(scallops?|shrimps?|prawns?|mussels?|clams?)\b/i;
const POULTRY = /\b(chicken|turkey|duck)\b/i;
const GROUND = /\bground (beef|pork|lamb|meat|turkey|chicken)\b|\bsausages?\b|\bmeatballs?\b|\bburgers?\b|\bmeatloaf\b/i;
const RED = /\b(beef|steak|pork|lamb|brisket|ribs?)\b/i;
const VEGGIE = new Set(['veggie', 'vegetarian', 'vegan']);
const RED_CATEGORIES = new Set(['beef', 'pork', 'lamb']);

export interface Perishable {
  category: string | null;
  seafoodKind: SeafoodKind | null;
  /** Name, headline and ingredient names — what the protein is read from when the category is silent. */
  text: string;
}

export function perishabilityOf(d: Perishable): { group: PerishabilityGroup; rank: number; why: string } {
  const category = d.category?.toLowerCase() ?? null;
  const group = ((): PerishabilityGroup => {
    if (category === 'seafood' || d.seafoodKind) {
      if (d.seafoodKind === 'fish') return 'fish';
      if (d.seafoodKind === 'shrimp' || SHELLFISH.test(d.text)) return 'shellfish';
      return 'seafood';
    }
    if (category === 'poultry' || (category === null && POULTRY.test(d.text))) return 'poultry';
    if (category !== null && VEGGIE.has(category)) return 'veggie';
    if (GROUND.test(d.text)) return 'ground-meat';
    if ((category !== null && RED_CATEGORIES.has(category)) || (category === null && RED.test(d.text))) return 'red-meat';
    return 'other-meat';
  })();
  return { group, ...GROUPS[group] };
}

/** Most perishable first; ties by shorter total time (an unknown time last). Stable. */
export function cookOrder<T extends Perishable & { totalMinutes?: number }>(
  dishes: readonly T[],
): Array<T & { group: PerishabilityGroup; rank: number; why: string }> {
  return dishes
    .map((d) => ({ ...d, ...perishabilityOf(d) }))
    .sort((a, b) => a.rank - b.rank || (a.totalMinutes ?? Infinity) - (b.totalMinutes ?? Infinity));
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** The weekday and date `n` days after `date` (`YYYY-MM-DD`). */
export function dayFrom(date: string, n: number): { day: (typeof DAYS)[number]; date: string } {
  const d = new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000);
  return { day: DAYS[d.getUTCDay()]!, date: d.toISOString().slice(0, 10) };
}
