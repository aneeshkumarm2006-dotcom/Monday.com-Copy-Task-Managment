/**
 * Timezone-aware calendar-day math.
 *
 * The lower half of this file (getTzParts / getTzWeekday / isValidTimezone /
 * localToUtcMs / getLastDayOfMonth) was extracted verbatim from
 * services/automationSchedule.js, which is still its only other consumer and
 * still owns computeNextRunAt. It moved here because it is pure calendar math
 * with no side effects, and `services/` is for side effects; trackers need the
 * same helpers and a second copy would have drifted.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: "which day did this happen on?" is a
 * question about someone's wall clock, not about UTC. `Task.createdAt` is a UTC
 * instant. If the team is in Asia/Kolkata and the host runs UTC, every task
 * created before 05:30 local lands on the previous day unless you convert
 * properly. `startOfDay` in productivityController and `parseDay` in
 * boardExportController are both server-local and both already subtly wrong for
 * this reason — do not add a third. Every conversion in the tracker feature goes
 * through dayKeyOf() and dayKeyToUtcRange() and nothing else.
 *
 * In particular: NEVER use `.toISOString().slice(0, 10)` to get "the day". That
 * is the UTC day, it is a very tempting one-liner, and it is wrong everywhere
 * except UTC.
 *
 * A "day key" throughout this codebase is the string 'YYYY-MM-DD'. It is a
 * calendar date, not an instant — it deliberately carries no time and no zone.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

// Intl.DateTimeFormat construction is the expensive part of every call below —
// roughly a microsecond each, which is free at the few-per-minute rate the
// automation runner needs and emphatically not free when a tracker window
// buckets thousands of tasks. Formatters are immutable and thread-safe, so we
// build one per timezone and keep it. The map is bounded by the number of
// distinct IANA zones actually configured, i.e. a handful.
const partsFormatters = new Map();
const weekdayFormatters = new Map();

const partsFormatterFor = (timeZone) => {
  let fmt = partsFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    partsFormatters.set(timeZone, fmt);
  }
  return fmt;
};

const weekdayFormatterFor = (timeZone) => {
  let fmt = weekdayFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' });
    weekdayFormatters.set(timeZone, fmt);
  }
  return fmt;
};

/**
 * Break a UTC instant into wall-clock components in `timeZone`.
 * @returns {{ year, month, day, hour, minute, second }} month is 1-based.
 */
const getTzParts = (date, timeZone) => {
  const map = {};
  for (const p of partsFormatterFor(timeZone).formatToParts(date)) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  return {
    year: parseInt(map.year, 10),
    month: parseInt(map.month, 10),
    day: parseInt(map.day, 10),
    hour: parseInt(map.hour, 10),
    minute: parseInt(map.minute, 10),
    second: parseInt(map.second, 10),
  };
};

/** Day of week (0=Sun … 6=Sat) of an instant, as seen in `timeZone`. */
const getTzWeekday = (date, timeZone) => {
  const str = weekdayFormatterFor(timeZone).format(date);
  return WEEKDAY_INDEX[str] ?? 0;
};

const isValidTimezone = (tz) => {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/**
 * Convert wall-clock time in a target tz to a UTC instant. We first guess the
 * instant by treating the components as UTC, then measure how that guess
 * renders in the target tz to derive the offset, and shift by it.
 */
const localToUtcMs = (year, month, day, hour, minute, second, timeZone) => {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const guessParts = getTzParts(new Date(guess), timeZone);
  const localAsUtc = Date.UTC(
    guessParts.year,
    guessParts.month - 1,
    guessParts.day,
    guessParts.hour,
    guessParts.minute,
    guessParts.second
  );
  const offset = localAsUtc - guess;
  return guess - offset;
};

/** monthOneBased is 1–12. */
const getLastDayOfMonth = (year, monthOneBased) =>
  new Date(Date.UTC(year, monthOneBased, 0)).getUTCDate();

// ---------------------------------------------------------------------------
// Day keys
// ---------------------------------------------------------------------------

const pad2 = (n) => String(n).padStart(2, '0');

const isDayKey = (value) => typeof value === 'string' && DAY_KEY_RE.test(value);

/** 'YYYY-MM-DD' → { year, month, day } (month 1-based), or null if malformed. */
const parseDayKey = (dayKey) => {
  if (!isDayKey(dayKey)) return null;
  const year = parseInt(dayKey.slice(0, 4), 10);
  const month = parseInt(dayKey.slice(5, 7), 10);
  const day = parseInt(dayKey.slice(8, 10), 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Reject impossible dates like 2026-02-30, which would otherwise roll over
  // silently and put a cell on the wrong day.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return { year, month, day };
};

const makeDayKey = (year, month, day) => `${year}-${pad2(month)}-${pad2(day)}`;

/**
 * Which calendar day does this instant fall on, as seen in `timeZone`?
 * This is THE function for "what day did this task get created on".
 */
const dayKeyOf = (instant, timeZone) => {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) return null;
  const { year, month, day } = getTzParts(date, timeZone);
  return makeDayKey(year, month, day);
};

/**
 * The UTC instants bounding one wall-clock day in `timeZone`.
 * `start` is inclusive, `end` exclusive — i.e. `{ $gte: start, $lt: end }`.
 *
 * Computed as the boundary between this day and the next rather than as
 * 23:59:59, so DST days that are 23 or 25 hours long stay exact.
 */
const dayKeyToUtcRange = (dayKey, timeZone) => {
  const parsed = parseDayKey(dayKey);
  if (!parsed) return null;
  const next = parseDayKey(addDays(dayKey, 1));
  return {
    start: new Date(localToUtcMs(parsed.year, parsed.month, parsed.day, 0, 0, 0, timeZone)),
    end: new Date(localToUtcMs(next.year, next.month, next.day, 0, 0, 0, timeZone)),
  };
};

/**
 * Shift a day key by whole calendar days. Uses UTC arithmetic deliberately: a
 * day key has no timezone, and UTC has no DST, so "+1 day" can never land on
 * the same date twice or skip one — which is exactly the bug that appears if
 * you do this with local-time Dates.
 */
const addDays = (dayKey, delta) => {
  const parsed = parseDayKey(dayKey);
  if (!parsed) return null;
  const ms = Date.UTC(parsed.year, parsed.month - 1, parsed.day) + delta * DAY_MS;
  const d = new Date(ms);
  return makeDayKey(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
};

/** Whole calendar days from `fromDayKey` to `toDayKey`. Negative if `to` is earlier. */
const daysBetween = (fromDayKey, toDayKey) => {
  const a = parseDayKey(fromDayKey);
  const b = parseDayKey(toDayKey);
  if (!a || !b) return null;
  const ms = Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day);
  return Math.round(ms / DAY_MS);
};

/** Day of week (0=Sun … 6=Sat) of a calendar date. No timezone involved. */
const weekdayOfDayKey = (dayKey) => {
  const parsed = parseDayKey(dayKey);
  if (!parsed) return null;
  return new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day)).getUTCDay();
};

/** Inclusive list of day keys from `fromDayKey` to `toDayKey`. */
const dayKeysBetween = (fromDayKey, toDayKey) => {
  const span = daysBetween(fromDayKey, toDayKey);
  if (span === null || span < 0) return [];
  const out = new Array(span + 1);
  let cursor = fromDayKey;
  for (let i = 0; i <= span; i++) {
    out[i] = cursor;
    cursor = addDays(cursor, 1);
  }
  return out;
};

/** Lexical comparison works on day keys by construction; named for readability. */
const compareDayKeys = (a, b) => (a === b ? 0 : a < b ? -1 : 1);

const minDayKey = (a, b) => {
  if (!a) return b;
  if (!b) return a;
  return compareDayKeys(a, b) <= 0 ? a : b;
};

const maxDayKey = (a, b) => {
  if (!a) return b;
  if (!b) return a;
  return compareDayKeys(a, b) >= 0 ? a : b;
};

module.exports = {
  DAY_MS,
  WEEKDAY_INDEX,
  getTzParts,
  getTzWeekday,
  isValidTimezone,
  localToUtcMs,
  getLastDayOfMonth,
  isDayKey,
  parseDayKey,
  makeDayKey,
  dayKeyOf,
  dayKeyToUtcRange,
  addDays,
  daysBetween,
  weekdayOfDayKey,
  dayKeysBetween,
  compareDayKeys,
  minDayKey,
  maxDayKey,
};
