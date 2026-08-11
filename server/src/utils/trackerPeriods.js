/**
 * Tracker period math — turning a cadence into the columns of the delivery grid.
 *
 * A tracker never says "daily" or "monthly" in code. It says: bucket the
 * calendar this way, treat these weekdays as working, and allow this much grace.
 * "Daily activity" and "Monthly report" are two rows in a database that happen
 * to use those settings; the words appear nowhere below.
 *
 * ---------------------------------------------------------------------------
 * INVARIANT 1 — periodKeyFor() is pure in (cadence, dayKey).
 *
 * It MUST NOT read `skipDates`, groups, tasks, or anything stored. If holidays
 * could shift bucket boundaries, then adding one holiday retroactively would
 * renumber every later period and orphan every TrackerEntry after it — someone's
 * "report delivered, here's the link" record would silently detach from its
 * month. Skipping therefore affects RENDERING and SCORING only: a period whose
 * every day is non-working renders `off` and leaves the ratio, and a period with
 * at least one working day is scored across its whole span.
 *
 * There is a test that calls periodKeyFor() twice under different skipDates and
 * asserts identical output. That test is the guard on this whole design.
 *
 * ---------------------------------------------------------------------------
 * INVARIANT 2 — a period key is 'typePrefix:firstDayOfPeriod'.
 *
 *   d:2026-08-11   w:2026-08-10   m:2026-08-01
 *
 * Always the first day's calendar date, never an ISO week number — `2027-W01`
 * begins in December 2026 and that ambiguity costs a day of debugging the first
 * time it bites. The type prefix means that if someone changes a tracker's
 * cadence, the old entries stay identifiably orphaned instead of colliding with
 * new keys that happen to share a date.
 *
 * ---------------------------------------------------------------------------
 * everyNDays anchoring
 *
 * "Every 2 days" is meaningless without saying which days. Day D belongs to
 * bucket k = floor(calendarDaysBetween(anchorDate, D) / n), counting calendar
 * days rather than 24-hour spans, and the key is anchorDate + k*n. Days before
 * anchorDate belong to no bucket at all. The anchor is explicit and
 * user-visible so the team can choose Mon/Wed/Fri over Tue/Thu/Sat.
 */

const {
  isDayKey,
  parseDayKey,
  makeDayKey,
  addDays,
  daysBetween,
  weekdayOfDayKey,
  dayKeysBetween,
  compareDayKeys,
  getLastDayOfMonth,
} = require('./tzDay');

const CADENCE_TYPES = ['everyNDays', 'weekly', 'monthly'];

const KEY_PREFIX = { everyNDays: 'd', weekly: 'w', monthly: 'm' };

const MAX_EVERY_N = 365;
const MAX_GRACE_DAYS = 90;

// Belt-and-braces against a cadence that somehow generates unbounded columns.
// The controller enforces the real limit (groups x periods); this is the guard
// that stops a malformed cadence from spinning here first.
const MAX_PERIODS = 400;

const WEEKDAY_SHORT = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const WEEKDAY_LONG = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
];
const MONTH_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];
const MONTH_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const ALL_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

/**
 * Normalise a cadence into the shape the rest of this module assumes, so every
 * function below can stop writing `?? default` on every line. Assumes the
 * cadence already passed validateCadence.
 */
const normaliseCadence = (cadence) => {
  const raw = cadence || {};
  const weekdays =
    Array.isArray(raw.weekdays) && raw.weekdays.length > 0
      ? [...new Set(raw.weekdays.map(Number))].filter((d) => ALL_WEEKDAYS.includes(d)).sort()
      : ALL_WEEKDAYS;
  return {
    type: raw.type,
    n: Number.isInteger(raw.n) && raw.n > 0 ? raw.n : 1,
    anchorDate: isDayKey(raw.anchorDate) ? raw.anchorDate : null,
    weekStartsOn: raw.weekStartsOn === 0 ? 0 : 1,
    graceDays: Number.isInteger(raw.graceDays) && raw.graceDays > 0 ? raw.graceDays : 0,
    weekdays,
  };
};

/**
 * Validate a cadence object. Mirrors validateSchedule's { valid, error? } shape
 * so controller sanitizers can treat the two identically.
 */
const validateCadence = (cadence) => {
  if (!cadence || typeof cadence !== 'object') {
    return { valid: false, error: 'Cadence is required' };
  }
  if (!CADENCE_TYPES.includes(cadence.type)) {
    return { valid: false, error: 'Invalid cadence type' };
  }

  if (cadence.weekdays !== undefined && cadence.weekdays !== null) {
    if (!Array.isArray(cadence.weekdays) || cadence.weekdays.length === 0) {
      return { valid: false, error: 'At least one weekday must be a working day' };
    }
    for (const d of cadence.weekdays) {
      if (!Number.isInteger(d) || d < 0 || d > 6) {
        return { valid: false, error: 'Weekday values must be 0–6' };
      }
    }
  }

  if (cadence.graceDays !== undefined && cadence.graceDays !== null) {
    const g = Number(cadence.graceDays);
    if (!Number.isInteger(g) || g < 0 || g > MAX_GRACE_DAYS) {
      return { valid: false, error: `Grace days must be between 0 and ${MAX_GRACE_DAYS}` };
    }
  }

  if (cadence.type === 'everyNDays') {
    const n = Number(cadence.n);
    if (!Number.isInteger(n) || n < 1 || n > MAX_EVERY_N) {
      return { valid: false, error: `Repeat every N days requires N between 1 and ${MAX_EVERY_N}` };
    }
    // The anchor is what makes "every 2 days" mean a specific set of days rather
    // than an arbitrary phase. It is required for n > 1 and harmless for n = 1.
    if (n > 1 && !isDayKey(cadence.anchorDate)) {
      return { valid: false, error: 'Repeating every N days requires a start day to count from' };
    }
    if (cadence.anchorDate && !parseDayKey(cadence.anchorDate)) {
      return { valid: false, error: 'Invalid anchor date' };
    }
  }

  if (cadence.type === 'weekly') {
    if (
      cadence.weekStartsOn !== undefined
      && cadence.weekStartsOn !== null
      && cadence.weekStartsOn !== 0
      && cadence.weekStartsOn !== 1
    ) {
      return { valid: false, error: 'Weeks must start on Sunday (0) or Monday (1)' };
    }
  }

  return { valid: true };
};

/** Is this calendar day a working day for the cadence, given the holiday set? */
const isWorkingDay = (dayKey, cadence, skipSet) => {
  const c = normaliseCadence(cadence);
  if (skipSet && skipSet.has(dayKey)) return false;
  const wd = weekdayOfDayKey(dayKey);
  if (wd === null) return false;
  return c.weekdays.includes(wd);
};

/** The first day of the week containing `dayKey`, per weekStartsOn. */
const startOfWeek = (dayKey, weekStartsOn) => {
  const wd = weekdayOfDayKey(dayKey);
  if (wd === null) return null;
  const back = (wd - weekStartsOn + 7) % 7;
  return addDays(dayKey, -back);
};

/** The first day of the month containing `dayKey`. */
const startOfMonth = (dayKey) => {
  const p = parseDayKey(dayKey);
  if (!p) return null;
  return makeDayKey(p.year, p.month, 1);
};

/** The last day of the month containing `dayKey`. */
const endOfMonth = (dayKey) => {
  const p = parseDayKey(dayKey);
  if (!p) return null;
  return makeDayKey(p.year, p.month, getLastDayOfMonth(p.year, p.month));
};

/**
 * The first calendar day of the period containing `dayKey`, or null if the day
 * belongs to no period (only possible for everyNDays before its anchor).
 *
 * PURE in (cadence, dayKey). See INVARIANT 1 at the top of this file.
 */
const periodStartFor = (dayKey, cadence) => {
  if (!isDayKey(dayKey) || !parseDayKey(dayKey)) return null;
  const c = normaliseCadence(cadence);

  if (c.type === 'weekly') return startOfWeek(dayKey, c.weekStartsOn);
  if (c.type === 'monthly') return startOfMonth(dayKey);

  if (c.type === 'everyNDays') {
    if (c.n === 1) return dayKey;
    const anchor = c.anchorDate;
    if (!anchor) return null;
    const delta = daysBetween(anchor, dayKey);
    if (delta === null || delta < 0) return null;
    return addDays(anchor, Math.floor(delta / c.n) * c.n);
  }

  return null;
};

/**
 * The period key for the period containing `dayKey`: 'd:…' | 'w:…' | 'm:…'.
 * PURE in (cadence, dayKey). See INVARIANT 1.
 */
const periodKeyFor = (dayKey, cadence) => {
  const start = periodStartFor(dayKey, cadence);
  if (!start) return null;
  const prefix = KEY_PREFIX[normaliseCadence(cadence).type];
  if (!prefix) return null;
  return `${prefix}:${start}`;
};

/** The last calendar day of the period starting at `startDayKey`. */
const periodEndFor = (startDayKey, cadence) => {
  const c = normaliseCadence(cadence);
  if (c.type === 'weekly') return addDays(startDayKey, 6);
  if (c.type === 'monthly') return endOfMonth(startDayKey);
  if (c.type === 'everyNDays') return addDays(startDayKey, c.n - 1);
  return null;
};

/** The first day of the period after the one starting at `startDayKey`. */
const nextPeriodStart = (startDayKey, cadence) => {
  const c = normaliseCadence(cadence);
  if (c.type === 'monthly') {
    const p = parseDayKey(startDayKey);
    if (!p) return null;
    return p.month === 12 ? makeDayKey(p.year + 1, 1, 1) : makeDayKey(p.year, p.month + 1, 1);
  }
  const end = periodEndFor(startDayKey, cadence);
  return end ? addDays(end, 1) : null;
};

/** Human-readable column labels. The client renders these verbatim. */
const describePeriod = (startDayKey, endDayKey, cadence) => {
  const c = normaliseCadence(cadence);
  const s = parseDayKey(startDayKey);
  if (!s) return { label: '', sublabel: null, band: '', ariaLabel: '' };

  if (c.type === 'monthly') {
    return {
      label: MONTH_SHORT[s.month - 1],
      sublabel: null,
      band: String(s.year),
      ariaLabel: `${MONTH_LONG[s.month - 1]} ${s.year}`,
    };
  }

  if (c.type === 'weekly') {
    return {
      label: String(s.day),
      sublabel: 'Wk',
      band: MONTH_SHORT[s.month - 1],
      ariaLabel:
        `Week of ${WEEKDAY_LONG[weekdayOfDayKey(startDayKey)]} `
        + `${s.day} ${MONTH_LONG[s.month - 1]} ${s.year}`,
    };
  }

  // everyNDays
  if (c.n === 1) {
    return {
      label: String(s.day),
      sublabel: WEEKDAY_SHORT[weekdayOfDayKey(startDayKey)],
      band: MONTH_SHORT[s.month - 1],
      ariaLabel:
        `${WEEKDAY_LONG[weekdayOfDayKey(startDayKey)]} `
        + `${s.day} ${MONTH_LONG[s.month - 1]} ${s.year}`,
    };
  }

  const e = parseDayKey(endDayKey);
  return {
    label: String(s.day),
    sublabel: WEEKDAY_SHORT[weekdayOfDayKey(startDayKey)],
    band: MONTH_SHORT[s.month - 1],
    ariaLabel: e
      ? `${s.day} ${MONTH_LONG[s.month - 1]} to ${e.day} ${MONTH_LONG[e.month - 1]} ${e.year}`
      : `${s.day} ${MONTH_LONG[s.month - 1]} ${s.year}`,
  };
};

/**
 * Every period whose nominal span intersects [fromDayKey, toDayKey], oldest
 * first. Each carries everything the grid and the evaluator need, so neither of
 * them ever does date arithmetic of its own.
 *
 * `dueDayKey` is the last day evidence may land — the period end plus the
 * cadence's grace. A monthly report for August with graceDays 5 is still on
 * time if it goes out on 3 September, and stays `pending` rather than `missed`
 * until then.
 *
 * @param {object} cadence
 * @param {string} fromDayKey  'YYYY-MM-DD'
 * @param {string} toDayKey    'YYYY-MM-DD'
 * @param {{ skipDates?: string[] }} [options]
 */
const periodsBetween = (cadence, fromDayKey, toDayKey, options = {}) => {
  const v = validateCadence(cadence);
  if (!v.valid) return [];
  if (!isDayKey(fromDayKey) || !isDayKey(toDayKey)) return [];
  if (compareDayKeys(fromDayKey, toDayKey) > 0) return [];

  const c = normaliseCadence(cadence);
  const skipSet = new Set(options.skipDates || []);

  // Clamp to the anchor: days before it belong to no bucket at all.
  let cursorDay = fromDayKey;
  if (c.type === 'everyNDays' && c.n > 1 && c.anchorDate) {
    if (compareDayKeys(cursorDay, c.anchorDate) < 0) cursorDay = c.anchorDate;
    if (compareDayKeys(cursorDay, toDayKey) > 0) return [];
  }

  let start = periodStartFor(cursorDay, cadence);
  if (!start) return [];

  const out = [];
  while (start && compareDayKeys(start, toDayKey) <= 0 && out.length < MAX_PERIODS) {
    const end = periodEndFor(start, cadence);
    if (!end) break;

    const days = dayKeysBetween(start, end);
    const workingDays = days.filter((d) => isWorkingDay(d, cadence, skipSet));

    out.push({
      key: `${KEY_PREFIX[c.type]}:${start}`,
      startDayKey: start,
      endDayKey: end,
      dueDayKey: c.graceDays > 0 ? addDays(end, c.graceDays) : end,
      workingDayCount: workingDays.length,
      // A period nobody was ever due to work is not a miss — it is not a period.
      isOff: workingDays.length === 0,
      ...describePeriod(start, end, cadence),
    });

    start = nextPeriodStart(start, cadence);
  }

  return out;
};

/**
 * Was this period entirely non-working? Exposed for callers that hold a period
 * from elsewhere; periodsBetween already sets `isOff` on what it returns.
 */
const isOffPeriod = (period, cadence, skipDates = []) => {
  if (!period || !period.startDayKey || !period.endDayKey) return false;
  const skipSet = skipDates instanceof Set ? skipDates : new Set(skipDates);
  return !dayKeysBetween(period.startDayKey, period.endDayKey).some((d) =>
    isWorkingDay(d, cadence, skipSet)
  );
};

module.exports = {
  CADENCE_TYPES,
  KEY_PREFIX,
  MAX_EVERY_N,
  MAX_GRACE_DAYS,
  MAX_PERIODS,
  WEEKDAY_SHORT,
  WEEKDAY_LONG,
  MONTH_SHORT,
  MONTH_LONG,
  normaliseCadence,
  validateCadence,
  isWorkingDay,
  startOfWeek,
  startOfMonth,
  endOfMonth,
  periodStartFor,
  periodKeyFor,
  periodEndFor,
  nextPeriodStart,
  describePeriod,
  periodsBetween,
  isOffPeriod,
};
