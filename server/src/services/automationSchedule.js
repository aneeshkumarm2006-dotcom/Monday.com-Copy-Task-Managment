// The timezone primitives below used to live in this file. They moved to
// utils/tzDay.js when the tracker feature needed the same wall-clock day math —
// they are pure calendar helpers, and `services/` is for side effects. Behaviour
// is unchanged; tzDay additionally memoizes the Intl formatters.
const {
  DAY_MS,
  getTzParts,
  getTzWeekday,
  isValidTimezone,
  localToUtcMs,
  getLastDayOfMonth,
  makeDayKey,
} = require('../utils/tzDay');

const VALID_FREQUENCIES = ['daily', 'weekly', 'monthly'];

/**
 * Validate a schedule object. Returns { valid, error? }.
 */
const validateSchedule = (schedule) => {
  if (!schedule || typeof schedule !== 'object') {
    return { valid: false, error: 'Schedule is required' };
  }
  if (!VALID_FREQUENCIES.includes(schedule.frequency)) {
    return { valid: false, error: 'Invalid frequency' };
  }
  if (schedule.hour !== undefined && schedule.hour !== null) {
    const h = Number(schedule.hour);
    if (!Number.isInteger(h) || h < 0 || h > 23) {
      return { valid: false, error: 'Hour must be between 0 and 23' };
    }
  }
  if (schedule.timezone && !isValidTimezone(schedule.timezone)) {
    return { valid: false, error: 'Invalid timezone' };
  }
  if (schedule.frequency === 'weekly') {
    const days = schedule.daysOfWeek;
    if (!Array.isArray(days) || days.length === 0) {
      return { valid: false, error: 'Weekly schedule requires daysOfWeek' };
    }
    for (const d of days) {
      if (!Number.isInteger(d) || d < 0 || d > 6) {
        return { valid: false, error: 'daysOfWeek values must be 0–6' };
      }
    }
  }
  if (schedule.frequency === 'monthly') {
    if (schedule.useLastDayOfMonth === true) {
      // Valid — last day sentinel takes precedence over dayOfMonth.
    } else {
      const d = schedule.dayOfMonth;
      if (!Number.isInteger(d) || d < 1 || d > 28) {
        return {
          valid: false,
          error:
            'Monthly schedule requires dayOfMonth 1–28, or use the "Last day of the month" option',
        };
      }
    }
  }
  return { valid: true };
};

/**
 * Compute the next Date strictly after `fromDate` matching the schedule.
 * Walks forward day-by-day in the schedule's timezone.
 *
 * `holidayKeys` is an optional Set of 'YYYY-MM-DD' day keys — the workspace
 * holiday calendar, from utils/orgHolidays.js. It is consulted only when the
 * schedule opted in with `skipHolidays`, and a holiday makes the candidate day
 * fail to match rather than aborting: the walk continues, so a daily automation
 * due on a holiday lands on the next working day and a weekly one whose only
 * weekday is a holiday rolls a full week. The existing 366-iteration bound
 * already guarantees this terminates.
 */
const computeNextRunAt = (schedule, fromDate = new Date(), holidayKeys = null) => {
  const v = validateSchedule(schedule);
  if (!v.valid) return null;

  const tz = schedule.timezone || 'UTC';
  const hour = Number.isInteger(schedule.hour) ? schedule.hour : 9;
  const fromMs = fromDate.getTime();

  const startParts = getTzParts(fromDate, tz);
  let y = startParts.year;
  let m = startParts.month;
  let d = startParts.day;

  for (let i = 0; i < 366; i++) {
    const candidateMs = localToUtcMs(y, m, d, hour, 0, 0, tz);
    const candidate = new Date(candidateMs);
    const candParts = getTzParts(candidate, tz);

    let matches = false;
    if (schedule.frequency === 'daily') {
      matches = true;
    } else if (schedule.frequency === 'weekly') {
      const days = schedule.daysOfWeek || [];
      if (days.length > 0) {
        const wd = getTzWeekday(candidate, tz);
        matches = days.includes(wd);
      }
    } else if (schedule.frequency === 'monthly') {
      if (schedule.useLastDayOfMonth === true) {
        const lastDay = getLastDayOfMonth(candParts.year, candParts.month);
        matches = candParts.day === lastDay;
      } else {
        matches = candParts.day === schedule.dayOfMonth;
      }
    }

    // The day matched the pattern, but the office was shut. Fall through and
    // keep walking rather than returning it.
    if (matches && schedule.skipHolidays && holidayKeys && holidayKeys.size > 0) {
      const dayKey = makeDayKey(candParts.year, candParts.month, candParts.day);
      if (holidayKeys.has(dayKey)) matches = false;
    }

    if (matches && candidateMs > fromMs) {
      return candidate;
    }

    // Step forward one calendar day in the local timezone. We use a UTC midnight
    // anchor so DST transitions don't cause us to repeat or skip a day.
    const nextAnchor = new Date(Date.UTC(y, m - 1, d) + DAY_MS);
    y = nextAnchor.getUTCFullYear();
    m = nextAnchor.getUTCMonth() + 1;
    d = nextAnchor.getUTCDate();
  }

  return null;
};

module.exports = {
  computeNextRunAt,
  validateSchedule,
};
