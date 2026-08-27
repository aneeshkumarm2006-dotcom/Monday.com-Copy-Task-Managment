/**
 * Company holidays — the workspace-wide calendar of days nobody was expected to
 * work, shared by every board, tracker, calendar and scheduler in the org.
 *
 * THE PROBLEM THIS SOLVES: `Tracker.daysOff` already knew how to say "this day
 * was off, and here is why", but it knew it one tracker at a time. Marking
 * Independence Day meant opening the Delivery grid for every tracker on every
 * board and clicking the same column — and a weekly or monthly tracker had no
 * column to click, because the header control only appears on a single-day
 * period. Meanwhile the calendar page, the date pickers and the automation
 * scheduler had no idea the office was shut.
 *
 * So there are now TWO LAYERS, and they mean different things:
 *
 *   Organisation.holidays  — "the office was closed". One list, one editor,
 *                            applies everywhere. No `tag`: an entry here IS a
 *                            holiday, which is exactly what distinguishes it
 *                            from the per-tracker reasons below.
 *   Tracker.daysOff        — "this particular commitment was not owed, because
 *                            <event | other_work | other>". Stays per-tracker,
 *                            stays the override.
 *
 * They are unioned in ONE place — utils/trackerDaysOff.js — and nowhere else.
 *
 * WHY WIDENING THE SCOPE IS SAFE. trackerDaysOff.js used to argue that a shared
 * calendar could not work because "a day the team was at an event is a day off
 * for the daily tracker and irrelevant to the monthly one — the month is still
 * owed". True, and already handled: trackerPeriods.js computes
 * `isOff = workingDays.length === 0`, so a holiday empties a one-day period but
 * leaves a monthly period holding thirty other working days. The engine draws
 * that line for free. The old objection was about shared EVENTS, not about a
 * shared HOLIDAY calendar.
 *
 * INVARIANT 1 in trackerPeriods.js is untouched and must stay that way: these
 * dates change which days are WORKING days, never where a period starts or
 * ends. A holiday added retroactively must not renumber periods and orphan
 * somebody's TrackerEntry.
 */

const { isDayKey, parseDayKey, compareDayKeys } = require('./tzDay');

/**
 * Generous enough for several years entered in advance, small enough that the
 * array stays cheap to ship with the org on every read. Years are entered one at
 * a time, so this is roughly a decade of headroom.
 */
const MAX_HOLIDAYS = 400;

/** Matches MAX_DAY_OFF_LABEL in trackerDaysOff.js — same field, same budget. */
const MAX_HOLIDAY_NAME = 60;

const YEAR_RE = /^\d{4}$/;

/**
 * One holiday, cleaned. Returns { value } or { error }, matching the sanitizer
 * convention in the controllers.
 *
 * A blank name is allowed. "15 Aug, off" is worth strictly more than nothing,
 * and forcing a name would just get us "holiday" typed 40 times.
 */
const sanitizeHoliday = (raw) => {
  const h = raw && typeof raw === 'object' ? raw : {};

  if (!isDayKey(h.date) || !parseDayKey(h.date)) {
    return { error: 'Invalid date' };
  }

  const name = String(h.name == null ? '' : h.name)
    .trim()
    .slice(0, MAX_HOLIDAY_NAME);

  return { value: { date: h.date, name } };
};

/** Sanitize a whole list, de-duplicated by date (last one wins) and sorted. */
const sanitizeHolidays = (raw) => {
  if (raw === undefined || raw === null) return { value: [] };
  if (!Array.isArray(raw)) return { error: 'Holidays must be a list' };
  if (raw.length > MAX_HOLIDAYS) {
    return { error: `At most ${MAX_HOLIDAYS} holidays` };
  }

  const byDate = new Map();
  for (const item of raw) {
    const one = sanitizeHoliday(item);
    if (one.error) return { error: one.error };
    byDate.set(one.value.date, one.value);
  }

  return {
    value: [...byDate.values()].sort((a, b) => compareDayKeys(a.date, b.date)),
  };
};

/** A four-digit year string, or { error }. The bulk save is scoped by one. */
const sanitizeYear = (raw) => {
  const y = String(raw == null ? '' : raw).trim();
  if (!YEAR_RE.test(y)) return { error: 'Invalid year' };
  return { value: y };
};

/**
 * The org's holidays as a plain, sorted, de-duplicated list of {date, name}.
 *
 * Takes the org document OR a bare array, because half the callers hold a
 * populated Organisation and half hold the list they just read off one.
 */
const holidayListOf = (orgOrList) => {
  const raw = Array.isArray(orgOrList)
    ? orgOrList
    : (orgOrList && orgOrList.holidays) || [];

  const byDate = new Map();
  for (const h of raw) {
    if (h && isDayKey(h.date)) {
      byDate.set(h.date, { date: h.date, name: h.name || '' });
    }
  }
  return [...byDate.values()].sort((a, b) => compareDayKeys(a.date, b.date));
};

/** Map<'YYYY-MM-DD', {date, name}> for fast per-day lookup. */
const holidayIndex = (orgOrList) => {
  const out = new Map();
  for (const h of holidayListOf(orgOrList)) out.set(h.date, h);
  return out;
};

/** Every day key the org treats as a holiday, sorted. */
const holidayDayKeysOf = (orgOrList) => holidayListOf(orgOrList).map((h) => h.date);

/** A Set of the same, for the schedulers that only ever ask "is this day one?". */
const holidayDayKeySetOf = (orgOrList) => new Set(holidayDayKeysOf(orgOrList));

/**
 * Just the entries in one year. A day key starts with its year, so this is a
 * prefix test rather than date parsing — and it cannot drift from the sort
 * order, which is lexical for the same reason.
 */
const holidaysInYear = (orgOrList, year) => {
  const y = String(year);
  if (!YEAR_RE.test(y)) return [];
  return holidayListOf(orgOrList).filter((h) => h.date.startsWith(`${y}-`));
};

module.exports = {
  MAX_HOLIDAYS,
  MAX_HOLIDAY_NAME,
  sanitizeHoliday,
  sanitizeHolidays,
  sanitizeYear,
  holidayListOf,
  holidayIndex,
  holidayDayKeysOf,
  holidayDayKeySetOf,
  holidaysInYear,
};
