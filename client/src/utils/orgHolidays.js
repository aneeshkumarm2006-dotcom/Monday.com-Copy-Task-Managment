/**
 * Company holidays, client side.
 *
 * The server owns the calendar (see server/src/utils/orgHolidays.js) and the
 * DECISIONS that follow from it — which Delivery cells were owed, when an
 * automation fires next. Nothing in this file re-derives any of that. All it
 * does is answer "is this day a holiday, and what is it called" so the calendar
 * grid, the date pickers and the Settings editor can paint it.
 *
 * A day key here is the same 'YYYY-MM-DD' string the server uses, read in LOCAL
 * time. That is deliberate and it is not the server's tz-aware `dayKeyOf`: a
 * date picker showing a grid of local calendar days should shade the cell the
 * user is looking at. The client has no timezone-aware day math anywhere and
 * this does not introduce the first — see client/src/utils/monthKeys.js.
 *
 * THIS FILE IS THE DURABLE HALF. The calendar page and its theme styles are
 * rewritten wholesale on the phase-2/automation-engine branch, so anything that
 * would be expensive to re-do after that merge lives here rather than there.
 */

export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export const MONTH_ABBR = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

export const WEEKDAY_ABBR = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Is this a well-formed day key? Shape only — the server validates the rest. */
export const isDayKey = (v) => typeof v === 'string' && DAY_KEY_RE.test(v);

/**
 * A Date to its LOCAL calendar day key.
 *
 * Never `.toISOString().slice(0, 10)` — that is the UTC day, and east of
 * Greenwich it is yesterday for the first hours of every morning, which would
 * shade the wrong cell.
 */
export const toDayKey = (date) => {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

/** Build a day key from parts. `month` is 0-based, matching Date. */
export const makeDayKey = (year, monthIndex, day) =>
  `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

/** Shared month-grid math, so the pickers and the year grid cannot disagree. */
export const getDaysInMonth = (year, monthIndex) =>
  new Date(year, monthIndex + 1, 0).getDate();

export const getFirstDayOfMonth = (year, monthIndex) =>
  new Date(year, monthIndex, 1).getDay();

/**
 * WHAT A HOLIDAY STOPS. Mirrors normaliseAffects in server/src/utils/orgHolidays.js
 * — `!== false`, so a row saved before these flags existed stops everything,
 * which is what "holiday" means unqualified.
 */
export const HOLIDAY_EFFECTS = [
  {
    key: 'delivery',
    label: 'Pause tracker scoring',
    hint: 'Columns go grey instead of red. Nobody is marked missed, and the day leaves the ratio.',
  },
  {
    key: 'automations',
    label: 'Pause scheduled automations',
    hint: 'Anything scheduled for this day runs on the next working day instead.',
  },
];

export const normaliseAffects = (raw) => ({
  delivery: raw?.delivery !== false,
  automations: raw?.automations !== false,
});

/**
 * Map<'YYYY-MM-DD', {date, name, affects}> from whatever the API handed back.
 *
 * Every consumer wants the map, not the list, so this is the single conversion
 * and the components just look days up.
 */
export const holidayIndex = (holidays) => {
  const out = new Map();
  for (const h of holidays || []) {
    if (h && isDayKey(h.date)) {
      out.set(h.date, {
        date: h.date,
        name: h.name || '',
        affects: normaliseAffects(h.affects),
      });
    }
  }
  return out;
};

/** Just the holidays in one year, sorted — what the Settings editor renders. */
export const holidaysInYear = (holidays, year) => {
  const prefix = `${year}-`;
  return (holidays || [])
    .filter((h) => h && isDayKey(h.date) && h.date.startsWith(prefix))
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));
};

/** "Independence Day" or, when it has no name, "Holiday". */
export const describeHoliday = (holiday) =>
  (holiday && holiday.name) ? holiday.name : 'Holiday';

/** "15 Aug 2026" — for list rows and tooltips. */
export const formatDayKey = (dayKey) => {
  if (!isDayKey(dayKey)) return '';
  const [y, m, d] = dayKey.split('-').map(Number);
  return `${d} ${MONTH_ABBR[m - 1]} ${y}`;
};

/**
 * The same day in another year, for the copy-a-year button.
 *
 * Returns null when the date does not exist there — 29 February is the only
 * case, and inventing a 28th or a 1st March for somebody would be worse than
 * telling them one day did not carry over.
 */
export const sameDayInYear = (dayKey, targetYear) => {
  if (!isDayKey(dayKey)) return null;
  const [, m, d] = dayKey.split('-').map(Number);
  const probe = new Date(targetYear, m - 1, d);
  if (probe.getMonth() !== m - 1 || probe.getDate() !== d) return null;
  return makeDayKey(targetYear, m - 1, d);
};
