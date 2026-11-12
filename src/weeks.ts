// ISO-8601 week arithmetic. HelloFresh names every delivery and menu by ISO
// week (`2026-W49` = the week whose Monday is 2026-11-30), so "the last four
// weeks" is week arithmetic, not date arithmetic.

const DAY_MS = 86_400_000;

/** `YYYY-Www`, week 01–53. */
export const WEEK_PATTERN = /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/;

const pad = (n: number) => String(n).padStart(2, '0');

function weekOfUtcMs(ms: number): string {
  const weekday = (new Date(ms).getUTCDay() + 6) % 7; // Monday = 0
  const thursday = ms + (3 - weekday) * DAY_MS;
  const year = new Date(thursday).getUTCFullYear();
  const week = Math.floor((thursday - Date.UTC(year, 0, 1)) / DAY_MS / 7) + 1;
  return `${year}-W${pad(week)}`;
}

function mondayMs(week: string): number {
  const year = Number(week.slice(0, 4));
  const n = Number(week.slice(6));
  const jan4 = Date.UTC(year, 0, 4);
  const firstMonday = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY_MS;
  return firstMonday + (n - 1) * 7 * DAY_MS;
}

/** The ISO week a calendar date (`YYYY-MM-DD`) falls in. */
export function isoWeekOf(date: string): string {
  return weekOfUtcMs(Date.parse(`${date.slice(0, 10)}T00:00:00Z`));
}

/** The Monday (`YYYY-MM-DD`) of an ISO week. */
export function mondayOf(week: string): string {
  return new Date(mondayMs(week)).toISOString().slice(0, 10);
}

/** `week` moved by `n` weeks (negative = earlier). */
export function shiftWeek(week: string, n: number): string {
  return weekOfUtcMs(mondayMs(week) + n * 7 * DAY_MS);
}
