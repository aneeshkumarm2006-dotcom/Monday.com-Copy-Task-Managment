/**
 * Days off — a calendar day this tracker never expected work on, and the reason.
 *
 * THE PROBLEM THIS SOLVES: the grid paints a whole column red when the team was
 * at a client event, on a public holiday, or pulled onto other work. Nobody
 * missed anything, but twenty-two red squares say they did — and a grid that
 * accuses people wrongly is one they stop reading.
 *
 * There was already a way to say "not a working day": `Tracker.skipDates`, a
 * bare list of day keys. It works, and `periodsBetween` still takes exactly that
 * shape. What it cannot do is say WHY, and the reason is the whole point — "14
 * Aug, red, no explanation" and "14 Aug, off, Independence Day" are different
 * documents six months later. So `Tracker.daysOff` carries the same dates plus a
 * tag and a label, and this module is the one place that reconciles the two:
 *
 *   skipDayKeysOf(tracker)   → the flat day-key list periodsBetween wants
 *   annotateDaysOff(periods) → hangs the labelled entries off the periods so the
 *                              grid header can render the tag without ever doing
 *                              date arithmetic of its own
 *
 * INVARIANT 1 in trackerPeriods.js still holds and is unaffected: these dates
 * change which days are WORKING days, never where a period starts or ends. A
 * holiday added retroactively must not renumber periods and orphan somebody's
 * TrackerEntry.
 *
 * Scope is deliberately per-tracker. A board can run "Daily activity" and
 * "Monthly report" side by side, and a day the team was at an event is a day off
 * for the first and irrelevant to the second — the month is still owed.
 */

const { isDayKey, parseDayKey, compareDayKeys } = require('./tzDay');

/**
 * Why the day was off. An enum rather than free text so the badge has a colour
 * and the grid can be filtered later; the free-text `label` next to it is what
 * actually names the day.
 */
const DAY_OFF_TAGS = ['holiday', 'event', 'other_work', 'other'];

const MAX_DAYS_OFF = 200;
const MAX_DAY_OFF_LABEL = 60;

/**
 * One day off, cleaned. Returns { value } or { error }, matching the sanitizer
 * convention in the controllers.
 */
const sanitizeDayOff = (raw) => {
  const d = raw && typeof raw === 'object' ? raw : {};

  if (!isDayKey(d.date) || !parseDayKey(d.date)) {
    return { error: 'Invalid date' };
  }

  const tag = DAY_OFF_TAGS.includes(d.tag) ? d.tag : 'other';
  const label = String(d.label == null ? '' : d.label).trim().slice(0, MAX_DAY_OFF_LABEL);

  return { value: { date: d.date, tag, label } };
};

/** Sanitize a whole list, de-duplicated by date (last one wins) and sorted. */
const sanitizeDaysOff = (raw) => {
  if (raw === undefined || raw === null) return { value: [] };
  if (!Array.isArray(raw)) return { error: 'Days off must be a list' };
  if (raw.length > MAX_DAYS_OFF) {
    return { error: `At most ${MAX_DAYS_OFF} days off` };
  }

  const byDate = new Map();
  for (const item of raw) {
    const one = sanitizeDayOff(item);
    if (one.error) return { error: one.error };
    byDate.set(one.value.date, one.value);
  }

  return {
    value: [...byDate.values()].sort((a, b) => compareDayKeys(a.date, b.date)),
  };
};

/** Map<'YYYY-MM-DD', {date, tag, label}> for the tracker's labelled days off. */
const dayOffIndex = (tracker) => {
  const out = new Map();
  for (const d of (tracker && tracker.daysOff) || []) {
    if (isDayKey(d.date)) out.set(d.date, d);
  }
  return out;
};

/**
 * Every day key this tracker treats as non-working, from BOTH sources.
 *
 * `skipDates` predates `daysOff` and never had a UI, so in practice it is empty
 * — but unioning costs one line and means an old row cannot silently start
 * counting as a miss the day this ships.
 */
const skipDayKeysOf = (tracker) => {
  const out = new Set();
  for (const d of (tracker && tracker.skipDates) || []) {
    if (isDayKey(d)) out.add(d);
  }
  for (const d of (tracker && tracker.daysOff) || []) {
    if (isDayKey(d.date)) out.add(d.date);
  }
  return [...out].sort();
};

/**
 * Hang each period's labelled days off onto it as `daysOff: [{date, tag, label}]`.
 *
 * The client renders this verbatim. It never derives the list itself, for the
 * same reason DeliveryGrid never inspects cadence: a daily period holds at most
 * one of these, a monthly period may hold ten, and the grid should not have to
 * know which kind it is looking at.
 */
const annotateDaysOff = (periods, tracker) => {
  const index = dayOffIndex(tracker);
  if (index.size === 0) return periods;

  const entries = [...index.values()];

  return periods.map((period) => {
    const inside = entries.filter(
      (d) =>
        compareDayKeys(d.date, period.startDayKey) >= 0
        && compareDayKeys(d.date, period.endDayKey) <= 0
    );
    if (inside.length === 0) return period;
    return {
      ...period,
      daysOff: inside
        .sort((a, b) => compareDayKeys(a.date, b.date))
        .map((d) => ({ date: d.date, tag: d.tag || 'other', label: d.label || '' })),
    };
  });
};

module.exports = {
  DAY_OFF_TAGS,
  MAX_DAYS_OFF,
  MAX_DAY_OFF_LABEL,
  sanitizeDayOff,
  sanitizeDaysOff,
  dayOffIndex,
  skipDayKeysOf,
  annotateDaysOff,
};
