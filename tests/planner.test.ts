import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { projectMenu, type ProjectedMeal, type ProjectedMenu } from '../src/normalize.js';
import { dayLabel, dollars, suggestMeals, summaryText } from '../src/planner.js';
import type { Profile } from '../src/profiles.js';
import type { RawDeliveryMenu } from '../src/types.js';

const MENU: ProjectedMenu = projectMenu(
  JSON.parse(readFileSync(new URL('./fixtures/menu-W49.json', import.meta.url), 'utf8')) as RawDeliveryMenu,
);

/** A 6-person seafood family week (the fixture box is 2 × 6). */
const FAMILY: Profile = {
  name: 'family',
  people: 6,
  meals: 2,
  categories: ['Seafood'],
  kidFriendly: true,
  maxMinutes: 30,
  premiumCapCents: 500,
  avoidRepeatWeeks: 4,
};
/** A 2-person adventurous seafood week. */
const COUPLE: Profile = {
  name: 'couple',
  people: 2,
  meals: 2,
  categories: ['seafood'],
  adventurous: true,
  premiumCapCents: 1500,
  avoidRepeatWeeks: 4,
};
/** No category allowlist, three meals, no boosts. */
const ANY: Profile = { name: 'any', people: 4, meals: 3, premiumCapCents: 500, avoidRepeatWeeks: 4 };

const meal = (over: Partial<ProjectedMeal> & { index: number }): ProjectedMeal => ({
  name: `Meal ${over.index}`,
  category: 'Seafood',
  isSeafood: true,
  seafoodKind: 'fish',
  kidFriendly: false,
  quick: false,
  totalMinutes: 25,
  premiumPerServingCents: 0,
  premiumBoxCents: 0,
  selectedQuantity: 0,
  tags: [],
  variants: [],
  ...over,
});
const menuOf = (...meals: ProjectedMeal[]): ProjectedMenu => ({ meals, selected: [] });

describe('suggestMeals on the fixture menu', () => {
  it('kid-friendly + quick profile: a kid-friendly shrimp + a quick fish, premiums priced for 6 servings', () => {
    const s = suggestMeals(MENU, { profile: FAMILY });
    expect(s.profile).toBe('family');
    expect(s.people).toBe(6);
    expect(s.maxPremiumPerServingCents).toBe(500);
    expect(s.picks.map((p) => p.index)).toEqual([53, 558]);
    expect(s.picks.map((p) => p.protein).sort()).toEqual(['fish', 'shrimp']);
    const [shrimp, fish] = s.picks;
    expect(shrimp!.reasons).toEqual(['kid friendly', 'ready in 25 min']);
    expect(fish!.baseIndex).toBe(67);
    expect(fish!.name).toBe('Pesto Salmon Linguine with Spinach');
    // Only Seafood is considered; only the over-cap premiums are excluded.
    expect(s.ranked.every((c) => c.category === 'Seafood')).toBe(true);
    const excluded = Object.fromEntries(s.excluded.map((e) => [e.index, e.reason]));
    expect(excluded[47]).toMatch(/\$14\.99\/serving over the \$5\.00 cap/);
    expect(excluded[560]).toBeUndefined(); // +$4.99 is under the cap
    // Two alternates per slot, none repeating a pick or each other.
    expect(s.alternates).toHaveLength(2);
    const alt = s.alternates.flatMap((a) => a.options.map((o) => o.index));
    expect(alt).toHaveLength(4);
    expect(new Set(alt).size).toBe(4);
    expect(alt.some((i) => [53, 558].includes(i))).toBe(false);
    // An alternate never shares a course with the OTHER slot's pick.
    expect(s.alternates[0]!.options.some((o) => o.index === 67 || o.baseIndex === 67)).toBe(false);
    // The slot's own protein first.
    expect(s.alternates[0]!.options[0]!.protein).toBe('shrimp');
    expect(s.alternates[1]!.options[0]!.protein).toBe('fish');
  });

  it('kid-friendly profile: premium penalised by the 6-serving upcharge, slow and spicy recipes marked down', () => {
    const s = suggestMeals(MENU, { profile: FAMILY, maxPremiumPerServingCents: 2000 });
    const by = (i: number) => s.ranked.find((c) => c.index === i)!;
    expect(s.maxPremiumPerServingCents).toBe(2000);
    expect(by(560).premiumBoxCents).toBe(2994);
    expect(by(560).reasons).toContain('premium +$4.99/serving (+$29.94 for 6 servings)');
    expect(by(43).reasons).toContain('takes 45 min (over 30)');
    expect(by(30).reasons).toContain('spicy');
    expect(by(560).score).toBeLessThan(by(67).score);
  });

  it('adventurous profile: unfamiliar cuisines boosted, premiums allowed up to the cap and lightly penalised', () => {
    const s = suggestMeals(MENU, { profile: COUPLE });
    expect(s.people).toBe(2);
    expect(s.maxPremiumPerServingCents).toBe(1500);
    expect(s.picks.map((p) => p.index)).toEqual([13, 30]);
    expect(s.picks.map((p) => p.protein).sort()).toEqual(['fish', 'shrimp']);
    for (const p of s.picks) expect(p.reasons.some((r) => r.startsWith('adventurous: '))).toBe(true);
    const seaBass = s.ranked.find((c) => c.index === 47)!;
    expect(seaBass.premiumBoxCents).toBe(2998);
    expect(seaBass.reasons).toContain('premium +$14.99/serving (+$29.98 for 2 servings)');
    expect(seaBass.reasons).toContain('ready in 20 min');
    expect(s.excluded).toEqual([]);
  });

  it('a people override reprices premiums', () => {
    const s = suggestMeals(MENU, { profile: COUPLE, people: 4 });
    expect(s.people).toBe(4);
    expect(s.ranked.find((c) => c.index === 47)!.premiumBoxCents).toBe(5996);
  });

  it('no category allowlist: any protein, three meals, diverse proteins', () => {
    const s = suggestMeals(MENU, { profile: ANY });
    expect(s.picks).toHaveLength(3);
    expect(new Set(s.picks.map((p) => p.protein)).size).toBe(3);
    expect(s.ranked.some((c) => c.category === 'Poultry')).toBe(true);
    expect(s.warning).toBeUndefined();
  });

  it('avoids requested indexes and recently picked recipes by name', () => {
    const s = suggestMeals(MENU, {
      profile: FAMILY,
      avoidIndexes: [53],
      avoidNames: ['  pesto salmon linguine with SPINACH '],
    });
    const reasons = Object.fromEntries(s.excluded.map((e) => [e.index, e.reason]));
    expect(reasons[53]).toBe('avoided by request');
    expect(reasons[558]).toBe('picked in a recent week');
    expect(s.picks.map((p) => p.index)).not.toContain(53);
    expect(s.picks.map((p) => p.index)).not.toContain(558);
  });

  it('marks the dishes already picked for the week', () => {
    const s = suggestMeals(MENU, { profile: COUPLE, maxPremiumPerServingCents: 0 });
    expect(s.ranked.find((c) => c.index === 67)!.selected).toBe(true);
    expect(s.ranked.find((c) => c.index === 53)!.selected).toBe(false);
  });
});

describe('suggestMeals edge cases', () => {
  it('prefers a diverse pair over two higher-scoring fish only when the bonus covers it', () => {
    const s = suggestMeals(
      menuOf(
        meal({ index: 1, kidFriendly: true }),
        meal({ index: 2, kidFriendly: true }),
        meal({ index: 3, seafoodKind: 'shrimp', kidFriendly: true, totalMinutes: 40 }),
      ),
      { profile: FAMILY },
    );
    // 1+2 (two fish) beat 1+3 (shrimp, but slow): diversity does not override everything.
    expect(s.picks.map((p) => p.index)).toEqual([1, 2]);
    const close = suggestMeals(
      menuOf(meal({ index: 1, kidFriendly: true }), meal({ index: 2 }), meal({ index: 3, seafoodKind: 'shrimp' })),
      { profile: FAMILY },
    );
    expect(close.picks.map((p) => p.index)).toEqual([1, 3]);
  });

  it('never pairs a course with its own protein swap', () => {
    const base = meal({
      index: 10,
      seafoodKind: 'shrimp',
      variants: [
        {
          index: 11,
          title: 'Salmon',
          name: 'Salmon swap',
          category: 'Seafood',
          isSeafood: true,
          seafoodKind: 'fish',
          premiumPerServingCents: 0,
          premiumBoxCents: 0,
          selectedQuantity: 0,
        },
        {
          index: 12,
          title: 'Chicken',
          category: 'Poultry',
          isSeafood: false,
          seafoodKind: null,
          premiumPerServingCents: 0,
          premiumBoxCents: 0,
          selectedQuantity: 0,
        },
      ],
    });
    const s = suggestMeals(menuOf(base), { profile: COUPLE });
    expect(s.picks).toHaveLength(1);
    expect(s.ranked.map((c) => c.index).sort()).toEqual([10, 11]);
    expect(s.warning).toMatch(/Only 1 of the 2 meals.*\(seafood\)/);
    expect(s.alternates[0]!.options.map((o) => o.index)).toEqual([11]);
  });

  it('nothing in the allowed categories → no picks and a warning', () => {
    const s = suggestMeals(menuOf(meal({ index: 1, isSeafood: false, seafoodKind: null, category: 'Beef' })), {
      profile: FAMILY,
    });
    expect(s.picks).toEqual([]);
    expect(s.alternates).toEqual([]);
    expect(s.warning).toMatch(/Only 0 of the 2 meals/);
  });

  it('an uncategorised dish is outside any allowlist but fine without one; unknown minutes and cuisine score neutrally', () => {
    const odd = menuOf(meal({ index: 1, category: null, isSeafood: false, seafoodKind: null, totalMinutes: undefined, cuisine: undefined }));
    expect(suggestMeals(odd, { profile: FAMILY }).ranked).toEqual([]);
    const s = suggestMeals(odd, { profile: { ...ANY, adventurous: true } });
    expect(s.picks[0]!.protein).toBe('unknown');
    expect(s.picks[0]!.reasons).toEqual([]);
    expect(s.picks[0]!.score).toBe(0);
    expect(s.warning).toMatch(/Only 1 of the 3 meals could be suggested: the menu has too few distinct courses matching the profile within/);
  });

  it('without maxMinutes, a mild preference for ≤ 30 minutes', () => {
    const s = suggestMeals(menuOf(meal({ index: 1, totalMinutes: 20 }), meal({ index: 2, totalMinutes: 50 })), { profile: ANY });
    expect(s.ranked.map((c) => [c.index, c.score, c.reasons])).toEqual([
      [1, 5, ['ready in 20 min']],
      [2, -5, ['takes 50 min (over 30)']],
    ]);
  });

  it('a nameless protein swap goes by its swap title', () => {
    const base = meal({
      index: 10,
      isSeafood: false,
      seafoodKind: null,
      category: 'Poultry',
      variants: [
        {
          index: 11,
          title: '2x Shrimp',
          category: 'Seafood',
          isSeafood: true,
          seafoodKind: 'shrimp',
          premiumPerServingCents: 0,
          premiumBoxCents: 0,
          selectedQuantity: 1,
        },
      ],
    });
    const s = suggestMeals(menuOf(base), { profile: FAMILY });
    expect(s.picks).toMatchObject([{ index: 11, baseIndex: 10, name: '2x Shrimp', selected: true }]);
  });
});

describe('summary text', () => {
  const picks = [{ name: 'Garlicky Shrimp Couscous Bowls' }, { name: 'Pesto Salmon Linguine' }];

  it('formats the approval line from the profile label', () => {
    expect(
      summaryText({
        profile: FAMILY,
        deliveryDate: '2026-11-30T00:00:00-05:00',
        picks,
        estimate: { totalCents: 13846, discountCents: 2212, voucher: { code: 'EXAMPLE65' } },
      }),
    ).toBe(
      'Family week (6 servings) — delivering Mon 11/30: Garlicky Shrimp Couscous Bowls + Pesto Salmon Linguine. ' +
        'Est. box total $138.46 (−$22.12 EXAMPLE65).',
    );
    expect(summaryText({ profile: { ...COUPLE, label: 'Date night' }, people: 4, deliveryDate: undefined, picks, estimate: undefined })).toMatch(
      /^Date night week \(4 servings\)/,
    );
  });

  it('says when no discount applies, no estimate exists, or nothing fits', () => {
    expect(
      summaryText({ profile: COUPLE, deliveryDate: undefined, picks: [], estimate: { totalCents: 7295, discountCents: 0 } }),
    ).toBe('Couple week (2 servings) — delivering (date unknown): no picks fit. Est. box total $72.95 (no voucher discount).');
    expect(summaryText({ profile: COUPLE, deliveryDate: '2026-12-07', picks: [{}], estimate: undefined })).toBe(
      'Couple week (2 servings) — delivering Mon 12/7: (unnamed meal). Box total not estimated.',
    );
    expect(
      summaryText({ profile: COUPLE, deliveryDate: '2026-12-07', picks: [{ name: 'A' }], estimate: { totalCents: 100, discountCents: 5 } }),
    ).toBe('Couple week (2 servings) — delivering Mon 12/7: A. Est. box total $1.00 (−$0.05).');
  });

  it('helpers', () => {
    expect(dollars(0)).toBe('$0.00');
    expect(dollars(14748)).toBe('$147.48');
    expect(dayLabel('2026-11-29T00:00:00-05:00')).toBe('Sun 11/29');
    expect(dayLabel('nonsense')).toBeUndefined();
    expect(dayLabel(undefined)).toBeUndefined();
  });
});
