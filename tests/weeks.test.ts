import { describe, expect, it } from 'vitest';
import { isoWeekOf, mondayOf, shiftWeek, WEEK_PATTERN } from '../src/weeks.js';

describe('ISO week helpers', () => {
  it('names the ISO week of a calendar date', () => {
    expect(isoWeekOf('2026-11-30')).toBe('2026-W49'); // a Monday
    expect(isoWeekOf('2026-12-06')).toBe('2026-W49'); // its Sunday
    expect(isoWeekOf('2026-01-01')).toBe('2026-W01'); // Thursday: week 1 of 2026
    expect(isoWeekOf('2025-12-29')).toBe('2026-W01'); // Monday of 2026-W01
    expect(isoWeekOf('2027-01-01')).toBe('2026-W53'); // 2026 has 53 ISO weeks
  });

  it('gives the Monday of a week', () => {
    expect(mondayOf('2026-W49')).toBe('2026-11-30');
    expect(mondayOf('2026-W01')).toBe('2025-12-29');
    expect(mondayOf('2027-W01')).toBe('2027-01-04');
  });

  it('shifts across year boundaries', () => {
    expect(shiftWeek('2026-W49', -4)).toBe('2026-W45');
    expect(shiftWeek('2027-W02', -3)).toBe('2026-W52');
    expect(shiftWeek('2026-W52', 1)).toBe('2026-W53');
    expect(shiftWeek('2026-W53', 1)).toBe('2027-W01');
    expect(shiftWeek('2026-W49', 0)).toBe('2026-W49');
  });

  it('the week pattern accepts YYYY-Www only', () => {
    expect(WEEK_PATTERN.test('2026-W49')).toBe(true);
    expect(WEEK_PATTERN.test('2026-W5')).toBe(false);
    expect(WEEK_PATTERN.test('2026-W54')).toBe(false);
    expect(WEEK_PATTERN.test('2026-W00')).toBe(false);
    expect(WEEK_PATTERN.test('2026W49')).toBe(false);
  });
});
