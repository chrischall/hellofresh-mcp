import { describe, expect, it } from 'vitest';
import { cookOrder, dayFrom, nearestYield, perishabilityOf, plainText, projectRecipe } from '../src/cooking.js';
import type { RawRecipeDetail } from '../src/types.js';

// Synthetic recipe detail (docs/HELLOFRESH-API.md "Recipe detail" shape).
const DETAIL: RawRecipeDetail = {
  name: '  Synthetic Shrimp Linguine ',
  headline: 'with Lemony Panko',
  difficulty: 1,
  prepTime: 'PT10M',
  totalTime: 'PT25M',
  allergens: [{ name: 'Shellfish' }, { name: 'Wheat' }, { name: 'Shellfish' }, {}],
  nutrition: [
    { name: 'Calories', amount: 640, unit: 'kcal' },
    { name: 'Fat', amount: null, unit: 'g' },
  ],
  ingredients: [
    { id: 'i1', name: 'Shrimp', shipped: true },
    { id: 'i2', name: 'Linguine', shipped: true },
    { id: 'i3', name: 'Olive Oil', shipped: false },
    { id: 'i4', name: 'Pesto', shipped: true },
    { id: 'i5' },
  ],
  yields: [
    { yields: 2, ingredients: [{ id: 'i1', amount: 10, unit: 'ounce' }, { id: 'i2', amount: 6, unit: 'ounce' }] },
    {
      yields: 4,
      ingredients: [
        { id: 'i1', amount: 20, unit: 'ounce' },
        { id: 'i2', amount: 12, unit: 'ounce' },
        { id: 'i3', amount: 2, unit: 'teaspoon' },
        { id: 'i4', amount: null, unit: 'unit' },
      ],
    },
  ],
  steps: [
    { index: 2, instructions: '  • Cook the linguine.\n\n  • Drain.  ' },
    { index: 1, instructionsHTML: '<ul><li>Boil water &amp; salt it.</li><li>Zest&nbsp;the lemon.</li></ul>' },
    { instructions: 'Serve.' },
    { instructionsHTML: '<p>Enjoy!</p>' },
    { index: 3 },
  ],
  utensils: ['Large pot', { name: 'Strainer' }, {}],
  cardLink: 'https://example.invalid/card.pdf',
  websiteUrl: 'https://www.hellofresh.com/recipes/synthetic',
};

describe('plainText', () => {
  it('strips tags, decodes the common entities and collapses whitespace', () => {
    expect(plainText('<p>A &amp; B&nbsp;&lt;c&gt; &quot;d&quot; &#39;e&#39;</p>\n\n<b>f</b>')).toBe('A & B <c> "d" \'e\' f');
  });
});

describe('nearestYield', () => {
  const ys = [{ yields: 2 }, { yields: 4 }, { yields: 6 }, {}];
  it('takes the exact yield when there is one', () => {
    expect(nearestYield(ys, 4)).toEqual({ yields: 4, exact: true, entry: ys[1] });
  });
  it('falls back to the nearest, the larger on a tie', () => {
    expect(nearestYield(ys, 3)).toMatchObject({ yields: 4, exact: false });
    expect(nearestYield(ys, 1)).toMatchObject({ yields: 2, exact: false });
    expect(nearestYield(ys, 12)).toMatchObject({ yields: 6, exact: false });
  });
  it('none without a numeric yield', () => {
    expect(nearestYield([{}], 2)).toBeUndefined();
    expect(nearestYield(undefined, 2)).toBeUndefined();
  });
});

describe('projectRecipe', () => {
  it('projects name, time, allergens, nutrition, amounts for the servings, steps in order and utensils', () => {
    const r = projectRecipe(DETAIL, 4);
    expect(r).toEqual({
      name: 'Synthetic Shrimp Linguine',
      headline: 'with Lemony Panko',
      totalMinutes: 25,
      difficulty: 1,
      allergens: ['Shellfish', 'Wheat'],
      nutritionPerServing: [{ name: 'Calories', amount: 640, unit: 'kcal' }, { name: 'Fat', unit: 'g' }],
      amountsForServings: 4,
      ingredients: [
        { name: 'Shrimp', amount: 20, unit: 'ounce' },
        { name: 'Linguine', amount: 12, unit: 'ounce' },
        { name: 'Olive Oil', amount: 2, unit: 'teaspoon', notInBox: true },
        { name: 'Pesto', unit: 'unit' },
      ],
      steps: [
        { step: 1, text: 'Boil water & salt it. Zest the lemon.' },
        { step: 2, text: '• Cook the linguine. • Drain.' },
        { step: 3, text: 'Serve.' },
        { step: 4, text: 'Enjoy!' },
      ],
      utensils: ['Large pot', 'Strainer'],
      cardLink: 'https://example.invalid/card.pdf',
      websiteUrl: 'https://www.hellofresh.com/recipes/synthetic',
    });
  });

  it('falls back to the nearest yield and says so', () => {
    const r = projectRecipe(DETAIL, 6);
    expect(r.amountsForServings).toBe(4);
    expect(r.yieldsNote).toMatch(/no 6-serving amounts.*4 servings/);
    const r3 = projectRecipe(DETAIL, 3);
    expect(r3.amountsForServings).toBe(4);
  });

  it('names the ingredients without amounts when HelloFresh lists no yields', () => {
    const r = projectRecipe({ ingredients: [{ id: 'a', name: 'Rice' }], yields: [] }, 2);
    expect(r.ingredients).toEqual([{ name: 'Rice' }]);
    expect(r.amountsForServings).toBeUndefined();
    expect(r.yieldsNote).toMatch(/no ingredient amounts/);
    expect(r.allergens).toEqual([]);
    expect(r.steps).toEqual([]);
    expect(r.utensils).toEqual([]);
  });

  it('a yield entry without ingredients leaves names only; an empty detail projects to empty lists', () => {
    const r = projectRecipe({ ingredients: [{ id: 'a', name: 'Rice' }, { name: 'Salt' }], yields: [{ yields: 2 }] }, 2);
    expect(r.ingredients).toEqual([{ name: 'Rice' }, { name: 'Salt' }]);
    expect(projectRecipe({}, 2)).toMatchObject({ ingredients: [], nutritionPerServing: [], yieldsNote: expect.any(String) });
  });
});

describe('perishabilityOf', () => {
  const p = (category: string | null, seafoodKind: 'fish' | 'shrimp' | 'other' | null, text = '') =>
    perishabilityOf({ category, seafoodKind, text }).group;
  it('ranks fish > shellfish > other seafood > poultry > ground/other meat > beef/pork/lamb > veggie', () => {
    expect(p('Seafood', 'fish')).toBe('fish');
    expect(p('Seafood', 'shrimp')).toBe('shellfish');
    expect(p('Seafood', 'other', 'Seared Scallops')).toBe('shellfish');
    expect(p('Seafood', 'other', 'Lobster Tails')).toBe('seafood');
    expect(p(null, 'fish')).toBe('fish');
    expect(p('Poultry', null)).toBe('poultry');
    expect(p(null, null, 'Turkey Chili')).toBe('poultry');
    expect(p('Veggie', null, 'Veggie Sausage')).toBe('veggie');
    expect(p('Vegetarian', null)).toBe('veggie');
    expect(p('Beef', null, 'Shepherd’s Pie Ground Beef')).toBe('ground-meat');
    expect(p('Pork', null, 'Pork Sausage Rigatoni')).toBe('ground-meat');
    expect(p('Beef', null, 'Steak au Poivre')).toBe('red-meat');
    expect(p('Lamb', null)).toBe('red-meat');
    expect(p(null, null, 'Steak Salad')).toBe('red-meat');
    expect(p(null, null, 'Mystery Bowl')).toBe('other-meat');
    const ranks = ['fish', 'shellfish', 'seafood', 'poultry', 'ground-meat', 'red-meat', 'veggie'].map(
      (g) => ({ fish: 1, shellfish: 2, seafood: 3, poultry: 4, 'ground-meat': 5, 'red-meat': 6, veggie: 7 })[g],
    );
    expect(ranks).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(perishabilityOf({ category: null, seafoodKind: null, text: 'x' }).rank).toBe(5);
    expect(perishabilityOf({ category: 'Seafood', seafoodKind: 'fish', text: '' }).why).toMatch(/most perishable/);
  });
});

describe('cookOrder', () => {
  it('sorts by perishability, then shorter total time first (unknown time last)', () => {
    const dish = (name: string, category: string | null, seafoodKind: 'fish' | 'shrimp' | 'other' | null, totalMinutes?: number) => ({
      name,
      category,
      seafoodKind,
      text: name,
      totalMinutes,
    });
    const order = cookOrder([
      dish('Farrotto', 'Veggie', null, 40),
      dish('Steak', 'Beef', null, 30),
      dish('Chicken B', 'Poultry', null),
      dish('Chicken A', 'Poultry', null, 25),
      dish('Chicken C', 'Poultry', null),
      dish('Shrimp', 'Seafood', 'shrimp', 20),
      dish('Tilapia', 'Seafood', 'fish', 50),
    ]);
    expect(order.map((d) => d.name)).toEqual(['Tilapia', 'Shrimp', 'Chicken A', 'Chicken B', 'Chicken C', 'Steak', 'Farrotto']);
    expect(order[0]).toMatchObject({ group: 'fish', rank: 1 });
  });
});

describe('dayFrom', () => {
  it('names the weekday n days after a date', () => {
    expect(dayFrom('2026-11-30', 0)).toEqual({ day: 'Mon', date: '2026-11-30' });
    expect(dayFrom('2026-11-30', 1)).toEqual({ day: 'Tue', date: '2026-12-01' });
    expect(dayFrom('2026-11-30', 6)).toEqual({ day: 'Sun', date: '2026-12-06' });
  });
});
