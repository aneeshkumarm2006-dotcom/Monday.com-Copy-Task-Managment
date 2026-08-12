/**
 * Calendar-MONTH math, for monthly boards.
 *
 * This is the month-level companion to [tzDay.js](./tzDay.js) and it inherits
 * that file's rule wholesale: "which month did this happen in?" is a question
 * about somebody's wall clock, not about UTC. A task created at 2026-08-01
 * 02:00 in Asia/Kolkata is an August task; read as UTC it is 2026-07-31 20:30
 * and lands in July. Every month boundary in this codebase goes through
 * `monthKeyOf()` and `monthKeyToUtcRange()` and nothing else.
 *
 * NEVER use `.toISOString().slice(0, 7)`. It is the UTC month, it is a very
 * tempting one-liner, and it is wrong everywhere except UTC — exactly the trap
 * tzDay.js documents for days.
 *
 * A "month key" throughout this codebase is the string 'YYYY-MM'. Like a day
 * key it is a calendar label, not an instant: no day, no time, no zone. Lexical
 * order is chronological order by construction, which is why sorting and
 * range-comparing them as plain strings is safe.
 *
 * RELATIONSHIP TO TRACKER PERIOD KEYS. `trackerPeriods.js` already has a notion
 * of a monthly period, keyed `'m:2026-08-01'` — prefix plus the period's first
 * day. That format is deliberately about a tracker CADENCE (it has to coexist
 * with 'd:' and 'w:' keys in the same column), whereas a task's month is not a
 * cadence and carries no prefix. `monthKeyToPeriodKey` / `periodKeyToMonthKey`
 * are the bridge between the two, so Delivery and Goals can talk about the same
 * August without either side adopting the other's format.
 *
 * This module depends on trackerPeriods only for the month-NAME tables, so the
 * dependency runs one way (monthKey → trackerPeriods → tzDay) and there is no
 * cycle. Do not require this file from trackerPeriods.
 */

const {
  getTzParts,
  getLastDayOfMonth,
  makeDayKey,
  dayKeyOf,
  dayKeyToUtcRange,
  parseDayKey,
} = require('./tzDay');
const { MONTH_SHORT, MONTH_LONG } = require('./trackerPeriods');

const MONTH_KEY_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const pad2 = (n) => String(n).padStart(2, '0');

const isMonthKey = (value) => typeof value === 'string' && MONTH_KEY_RE.test(value);

/** 'YYYY-MM' → { year, month } (month 1-based), or null if malformed. */
const parseMonthKey = (monthKey) => {
  if (!isMonthKey(monthKey)) return null;
  return {
    year: parseInt(monthKey.slice(0, 4), 10),
    month: parseInt(monthKey.slice(5, 7), 10),
  };
};

const makeMonthKey = (year, month) => `${year}-${pad2(month)}`;

/**
 * Which calendar month does this instant fall in, as seen in `timeZone`?
 * THE function for "which month does this task belong to".
 *
 * Routed through `dayKeyOf` rather than reading `getTzParts` directly so there
 * is exactly one place in the codebase that turns an instant into a calendar
 * label — if that conversion is ever wrong, it is wrong in one file.
 *
 * The nullish guard is not redundant: `new Date(null)` is the epoch, not an
 * invalid date, so `dayKeyOf(null, tz)` cheerfully returns '1970-01-01'. Without
 * this, a task whose `createdAt` was somehow missing would be filed in January
 * 1970 — a bucket that looks like data and sorts to the top of every month list.
 * Failing loudly with null is the only safe answer.
 */
const monthKeyOf = (instant, timeZone) => {
  if (instant === null || instant === undefined || instant === '') return null;
  const dayKey = dayKeyOf(instant, timeZone);
  return dayKey ? dayKey.slice(0, 7) : null;
};

/** The month containing a day key. Pure string math — no zone involved. */
const monthKeyOfDayKey = (dayKey) => (parseDayKey(dayKey) ? dayKey.slice(0, 7) : null);

/** First calendar day of the month, as a day key. */
const firstDayKeyOf = (monthKey) => {
  const p = parseMonthKey(monthKey);
  return p ? makeDayKey(p.year, p.month, 1) : null;
};

/** Last calendar day of the month, as a day key. Leap-year safe. */
const lastDayKeyOf = (monthKey) => {
  const p = parseMonthKey(monthKey);
  return p ? makeDayKey(p.year, p.month, getLastDayOfMonth(p.year, p.month)) : null;
};

/**
 * The UTC instants bounding one wall-clock month in `timeZone`.
 * `start` inclusive, `end` exclusive — i.e. `{ $gte: start, $lt: end }`.
 *
 * `end` is the start of the FOLLOWING month rather than the last day's 23:59,
 * for the same reason `dayKeyToUtcRange` does it that way: it stays exact
 * across a DST transition inside the month, and it cannot drop an event that
 * happened in the final second.
 */
const monthKeyToUtcRange = (monthKey, timeZone) => {
  const first = firstDayKeyOf(monthKey);
  if (!first) return null;
  const nextFirst = firstDayKeyOf(addMonths(monthKey, 1));
  const startRange = dayKeyToUtcRange(first, timeZone);
  const endRange = dayKeyToUtcRange(nextFirst, timeZone);
  if (!startRange || !endRange) return null;
  return { start: startRange.start, end: endRange.start };
};

/**
 * Shift a month key by whole calendar months. Handles year rollover in both
 * directions, and never produces an invalid date the way day-based arithmetic
 * does (adding a month to 31 Jan has no "31 Feb" problem here — months have no
 * day component at all, which is half the reason this type exists).
 */
const addMonths = (monthKey, delta) => {
  const p = parseMonthKey(monthKey);
  if (!p) return null;
  const total = p.year * 12 + (p.month - 1) + delta;
  if (total < 0) return null;
  return makeMonthKey(Math.floor(total / 12), (total % 12) + 1);
};

/** Whole calendar months from `fromMonthKey` to `toMonthKey`. Negative if earlier. */
const monthsBetween = (fromMonthKey, toMonthKey) => {
  const a = parseMonthKey(fromMonthKey);
  const b = parseMonthKey(toMonthKey);
  if (!a || !b) return null;
  return (b.year - a.year) * 12 + (b.month - a.month);
};

/** Lexical comparison works on month keys by construction; named for readability. */
const compareMonthKeys = (a, b) => (a === b ? 0 : a < b ? -1 : 1);

/** Inclusive, ascending list of month keys. Empty if `to` precedes `from`. */
const monthKeysBetween = (fromMonthKey, toMonthKey) => {
  const span = monthsBetween(fromMonthKey, toMonthKey);
  if (span === null || span < 0) return [];
  const out = new Array(span + 1);
  let cursor = fromMonthKey;
  for (let i = 0; i <= span; i++) {
    out[i] = cursor;
    cursor = addMonths(cursor, 1);
  }
  return out;
};

/**
 * Human label for a month key: 'Aug 2026', or 'August 2026' with `long`.
 * Month names come from trackerPeriods so the Delivery grid and the month
 * dropdown can never disagree about what to call August.
 */
const formatMonth = (monthKey, { long = false } = {}) => {
  const p = parseMonthKey(monthKey);
  if (!p) return '';
  const names = long ? MONTH_LONG : MONTH_SHORT;
  return `${names[p.month - 1]} ${p.year}`;
};

/** 'YYYY-MM' → the tracker monthly period key 'm:YYYY-MM-01'. */
const monthKeyToPeriodKey = (monthKey) => {
  const first = firstDayKeyOf(monthKey);
  return first ? `m:${first}` : null;
};

/** 'm:YYYY-MM-01' → 'YYYY-MM'. Returns null for any other cadence's key. */
const periodKeyToMonthKey = (periodKey) => {
  if (typeof periodKey !== 'string' || !periodKey.startsWith('m:')) return null;
  return monthKeyOfDayKey(periodKey.slice(2));
};

module.exports = {
  MONTH_KEY_RE,
  isMonthKey,
  parseMonthKey,
  makeMonthKey,
  monthKeyOf,
  monthKeyOfDayKey,
  firstDayKeyOf,
  lastDayKeyOf,
  monthKeyToUtcRange,
  addMonths,
  monthsBetween,
  compareMonthKeys,
  monthKeysBetween,
  formatMonth,
  monthKeyToPeriodKey,
  periodKeyToMonthKey,
  // Re-exported so callers computing a board's "current month" have one import
  // and cannot reach for `new Date().getMonth()`, which is server-local.
  getTzParts,
};
