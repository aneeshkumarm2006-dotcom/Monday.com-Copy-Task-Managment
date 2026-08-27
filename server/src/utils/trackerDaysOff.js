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
 * TWO LAYERS, merged HERE and nowhere else:
 *
 *   Organisation.holidays — "the office was closed". One workspace-wide list,
 *                           edited once in Settings, applying to every tracker
 *                           on every board. See utils/orgHolidays.js.
 *   Tracker.daysOff       — "this particular commitment was not owed, and here
 *                           is why". Per-tracker, and the override: if a day
 *                           appears in both, the tracker's own reason wins,
 *                           because somebody typed it on purpose.
 *
 * This file used to argue that a shared calendar could not work, on the grounds
 * that "a day the team was at an event is a day off for the daily tracker and
 * irrelevant to the monthly one — the month is still owed". That is true, and it
 * was never this module's job: trackerPeriods.js computes
 * `isOff = workingDays.length === 0`, so a holiday empties a one-day period
 * while leaving a monthly period holding thirty other working days. The engine
 * already draws that line. The objection was about shared EVENTS — which is why
 * `Organisation.holidays` carries no tag and cannot express one — not about a
 * shared HOLIDAY calendar.
 *
 * A tracker that genuinely runs through public holidays sets
 * `observesOrgHolidays: false` and sees only its own list.

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

/**
 * Does this tracker follow the workspace holiday calendar?
 *
 * `undefined !== false`, deliberately: every tracker that existed before the
 * calendar did starts observing it, which is the whole point of the feature.
 * Opting out has to be a decision somebody made.
 */
const observesOrgHolidays = (tracker) =>
  !tracker || tracker.observesOrgHolidays !== false;

/**
 * The labelled days off this tracker sees, per date, from both layers.
 *
 * Org holidays surface with `tag: 'holiday'` and the holiday's name as the
 * label, so the grid header renders them through the same icon and copy tables
 * as a hand-marked day and learns nothing new. A per-tracker entry on the same
 * date REPLACES the org one — "we were at a client shoot" is more specific than
 * "public holiday", and the person who typed it meant it.
 */
const dayOffIndex = (tracker, orgHolidays = []) => {
  const out = new Map();

  if (observesOrgHolidays(tracker)) {
    for (const h of orgHolidays || []) {
      if (h && isDayKey(h.date)) {
        out.set(h.date, {
          date: h.date,
          tag: 'holiday',
          label: h.name || '',
          source: 'org',
        });
      }
    }
  }

  for (const d of (tracker && tracker.daysOff) || []) {
    if (isDayKey(d.date)) {
      out.set(d.date, { date: d.date, tag: d.tag, label: d.label, source: 'tracker' });
    }
  }

  return out;
};


/**
 * Every day key this tracker treats as non-working, from ALL THREE sources.
 *
 * `skipDates` predates `daysOff` and never had a UI, so in practice it is empty
 * — but unioning costs one line and means an old row cannot silently start
 * counting as a miss the day this ships.
 *
 * `orgHolidays` is the workspace calendar. It is skipped entirely when the
 * tracker opts out, which is the ONLY thing `observesOrgHolidays` does — the
 * flag never filters individual dates, because "observe the holiday calendar,
 * but not that holiday" is a per-tracker day off and already has a UI.
 */
const skipDayKeysOf = (tracker, orgHolidays = []) => {
  const out = new Set();
  for (const d of (tracker && tracker.skipDates) || []) {
    if (isDayKey(d)) out.add(d);
  }
  for (const d of (tracker && tracker.daysOff) || []) {
    if (isDayKey(d.date)) out.add(d.date);
  }
  if (observesOrgHolidays(tracker)) {
    for (const h of orgHolidays || []) {
      if (h && isDayKey(h.date)) out.add(h.date);
    }
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
const annotateDaysOff = (periods, tracker, orgHolidays = []) => {
  const index = dayOffIndex(tracker, orgHolidays);
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
        .map((d) => ({
          date: d.date,
          tag: d.tag || 'other',
          label: d.label || '',
          // WHERE it came from, so the grid can offer the right action. A day
          // that is off because of the workspace calendar has nothing for the
          // per-tracker Undo to remove, and a button that does nothing is worse
          // than no button.
          source: d.source === 'org' ? 'org' : 'tracker',
        })),
    };
  });
};

module.exports = {
  DAY_OFF_TAGS,
  observesOrgHolidays,
  MAX_DAYS_OFF,
  MAX_DAY_OFF_LABEL,
  sanitizeDayOff,
  sanitizeDaysOff,
  dayOffIndex,
  skipDayKeysOf,
  annotateDaysOff,
};
