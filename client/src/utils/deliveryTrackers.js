import {
  BadgeCheck,
  Check,
  CircleSlash2,
  ListChecks,
  MessageSquare,
  Minus,
  X,
} from 'lucide-react';

/**
 * The vocabulary of the Delivery view — one table per axis, each with several
 * consumers, so adding a state or a requirement is a data edit rather than a
 * hunt through JSX.
 *
 *   CELL_STATES       → the cell, the legend swatch, the list view, every
 *                       `title` and every `aria-label`
 *   REQUIREMENT_TYPES → the form's requirement rows, the describer sentence,
 *                       and the drill-down checklist
 *   CADENCE_TYPES     → the form's "how often" control and the describer
 *   STARTER_TRACKERS  → the first-run template cards
 *
 * The describers matter more than they look. describeTracker() renders both the
 * live preview in the form AND the subtitle in the list, so the English sentence
 * a user approves while building a tracker is byte-identical to the one they
 * read a month later. That is what "anybody should be able to understand it"
 * cashes out to.
 */

// ---------------------------------------------------------------------------
// Cell states
// ---------------------------------------------------------------------------

/**
 * Three redundant channels per state — fill, glyph and border style — so hue is
 * never load-bearing. `met` and `missed` are distinguishable by glyph at
 * identical luminance; `partial` is the only diagonally split cell in the grid;
 * `pending` is the only dashed one; `off` is the only one with no box at all.
 */
export const CELL_STATES = {
  met: {
    label: 'Met',
    glyph: Check,
    fill: 'var(--color-status-done)',
    ink: 'var(--color-text-inverse)',
    border: 'transparent',
    pattern: 'solid',
  },
  partial: {
    label: 'Partial',
    glyph: CircleSlash2,
    fill: 'var(--color-status-working-bg)',
    ink: 'var(--color-status-working)',
    border: 'var(--color-status-working)',
    pattern: 'half',
  },
  missed: {
    label: 'Missed',
    glyph: X,
    fill: 'var(--color-status-stuck)',
    ink: 'var(--color-text-inverse)',
    border: 'transparent',
    pattern: 'solid',
  },
  pending: {
    label: 'Not due yet',
    glyph: null,
    fill: 'var(--color-bg-input)',
    ink: 'var(--color-text-muted)',
    border: 'var(--color-border-strong)',
    pattern: 'dashed',
  },
  excused: {
    label: 'Excused',
    glyph: Minus,
    fill: 'var(--color-bg-subtle)',
    ink: 'var(--color-text-secondary)',
    border: 'var(--color-border-strong)',
    pattern: 'solid',
  },
  off: {
    label: 'Day off',
    glyph: null,
    fill: 'transparent',
    ink: 'var(--color-border-strong)',
    border: 'transparent',
    pattern: 'dot',
  },
};

/** `na` is real but never shown in the legend — it means "not this client's problem". */
export const NA_STATE = {
  label: 'Not applicable',
  fill: 'transparent',
  ink: 'var(--color-border)',
  border: 'transparent',
  pattern: 'dot',
  glyph: null,
};

export const cellStateMeta = (state) => CELL_STATES[state] || NA_STATE;

/** Legend order — worst-to-best reads oddly; this reads as a story. */
export const LEGEND_ORDER = ['met', 'partial', 'missed', 'pending', 'excused', 'off'];

// ---------------------------------------------------------------------------
// Requirements
// ---------------------------------------------------------------------------

/**
 * `short` is the fragment the describer joins with " + ", so the sentence reads
 * "needs a task created + an update posted". `scope` distinguishes the
 * requirements one task can answer from the one the period answers as a whole —
 * see the occurrence rule in server/src/utils/trackerEvaluate.js.
 */
export const REQUIREMENT_TYPES = [
  {
    value: 'TASK_EXISTS',
    label: 'A task exists for the period',
    short: 'a task created',
    icon: ListChecks,
    scope: 'task',
  },
  {
    value: 'UPDATE_POSTED',
    label: 'An update was posted on it',
    short: 'an update posted',
    icon: MessageSquare,
    scope: 'task',
  },
  {
    value: 'TASK_DONE',
    // Named honestly: there is no completion timestamp in this codebase, so this
    // reads the task's status right now rather than on the day.
    label: "It's marked Done (as things stand now)",
    short: 'it marked Done',
    icon: Check,
    scope: 'task',
  },
  {
    value: 'MANUAL_CONFIRM',
    label: 'Someone confirms it by hand',
    short: 'a manual confirmation',
    icon: BadgeCheck,
    scope: 'period',
  },
];

export const requirementMeta = (value) =>
  REQUIREMENT_TYPES.find((r) => r.value === value) || null;

// ---------------------------------------------------------------------------
// Cadence
// ---------------------------------------------------------------------------

export const CADENCE_TYPES = [
  { value: 'everyNDays', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
];

/** Window presets, per cadence. Presets not a free range — see the plan. */
export const WINDOW_OPTIONS = {
  everyNDays: [
    { value: '2w', label: '2w' },
    { value: '4w', label: '4w' },
    { value: '8w', label: '8w' },
  ],
  weekly: [
    { value: '8w', label: '8w' },
    { value: '13w', label: '13w' },
    { value: '26w', label: '26w' },
  ],
  monthly: [
    { value: '6m', label: '6m' },
    { value: '12m', label: '12m' },
    { value: '24m', label: '24m' },
  ],
};

export const DEFAULT_WINDOW = { everyNDays: '4w', weekly: '13w', monthly: '12m' };

export const windowOptionsFor = (cadenceType) =>
  WINDOW_OPTIONS[cadenceType] || WINDOW_OPTIONS.everyNDays;

// ---------------------------------------------------------------------------
// Describers
// ---------------------------------------------------------------------------

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** "Mon–Sat", "Mon, Wed, Fri", "Every day" — collapses contiguous runs. */
export const describeDays = (days = []) => {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  if (sorted.length === 0) return '—';
  if (sorted.length === 7) return 'Every day';

  const runs = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (const d of sorted.slice(1)) {
    if (d === prev + 1) {
      prev = d;
      continue;
    }
    runs.push([start, prev]);
    start = d;
    prev = d;
  }
  runs.push([start, prev]);

  return runs
    .map(([a, b]) => {
      if (b - a >= 2) return `${WEEKDAY_SHORT[a]}–${WEEKDAY_SHORT[b]}`;
      if (a === b) return WEEKDAY_SHORT[a];
      return `${WEEKDAY_SHORT[a]}, ${WEEKDAY_SHORT[b]}`;
    })
    .join(', ');
};

export const describeCadence = (cadence) => {
  if (!cadence) return '';
  const grace = cadence.graceDays > 0
    ? `, due within ${cadence.graceDays} day${cadence.graceDays === 1 ? '' : 's'}`
    : '';

  if (cadence.type === 'everyNDays') {
    const n = cadence.n || 1;
    if (n === 1) return `${describeDays(cadence.weekdays)}${grace}`;
    return `Every ${n} days${grace}`;
  }
  if (cadence.type === 'weekly') {
    const startsOn = cadence.weekStartsOn === 0 ? 'Sunday' : 'Monday';
    return `Every week, from ${startsOn}${grace}`;
  }
  if (cadence.type === 'monthly') return `Every month${grace}`;
  return '';
};

export const describeRequirements = (requirements = [], targetCount = 1) => {
  if (requirements.length === 0) return 'nothing required yet';
  const parts = requirements
    .map((r) => requirementMeta(r)?.short)
    .filter(Boolean);
  if (parts.length === 0) return 'nothing required yet';

  const joined = parts.join(' + ');
  if (targetCount > 1) return `needs ${targetCount} × (${joined})`;
  return `needs ${joined}`;
};

/** The one line the list row, the form preview and the section header all show. */
export const describeTracker = (tracker) => {
  if (!tracker) return '';
  const cadence = describeCadence(tracker.cadence);
  const reqs = describeRequirements(tracker.requirements, tracker.targetCount);
  return [cadence, reqs].filter(Boolean).join(' · ');
};

export const describeScope = (tracker, groups = []) => {
  const ids = tracker?.groups || [];
  if (ids.length === 0) {
    return groups.length > 0 ? `All ${groups.length} clients` : 'All clients';
  }
  if (ids.length <= 3) {
    const names = ids
      .map((id) => groups.find((g) => String(g._id) === String(id))?.name)
      .filter(Boolean);
    if (names.length > 0) return names.join(', ');
  }
  return `${ids.length} clients`;
};

/** "Will score 42 days of existing history" — the consequence of startDate. */
export const describeBackfill = (startDate, todayKey) => {
  if (!startDate || !todayKey) return '';
  const days = Math.round(
    (Date.UTC(
      Number(todayKey.slice(0, 4)),
      Number(todayKey.slice(5, 7)) - 1,
      Number(todayKey.slice(8, 10))
    )
      - Date.UTC(
        Number(startDate.slice(0, 4)),
        Number(startDate.slice(5, 7)) - 1,
        Number(startDate.slice(8, 10))
      ))
      / 86400000
  );
  if (Number.isNaN(days)) return '';
  if (days < 0) return 'Starts in the future — nothing is scored yet.';
  if (days === 0) return 'Scores from today onwards.';
  return `Scores ${days} day${days === 1 ? '' : 's'} of existing history.`;
};

/** Long-form date for a cell popover heading, from a 'YYYY-MM-DD'. */
export const formatDayKeyLong = (dayKey) => {
  if (!dayKey || dayKey.length < 10) return '';
  const year = Number(dayKey.slice(0, 4));
  const month = Number(dayKey.slice(5, 7));
  const day = Number(dayKey.slice(8, 10));
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return `${WEEKDAY_SHORT[weekday]} ${day} ${MONTH_LONG[month - 1]} ${year}`;
};

export const todayDayKey = () => {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

export const firstOfThisMonth = () => `${todayDayKey().slice(0, 7)}-01`;

export const browserTimezone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

// ---------------------------------------------------------------------------
// Starter templates
// ---------------------------------------------------------------------------

/**
 * The first-run cards. These are ordinary tracker payloads, not special cases —
 * choosing one just prefills the form, and the card subtitle is describeTracker()
 * run over the same object, so what you read on the card is what you get.
 *
 * Adding a template is a row here. Nothing downstream knows their names.
 */
export const STARTER_TRACKERS = [
  {
    id: 'daily-activity',
    icon: ListChecks,
    title: 'Daily activity',
    seed: {
      name: 'Daily activity',
      cadence: { type: 'everyNDays', n: 1, weekdays: [1, 2, 3, 4, 5, 6], graceDays: 0 },
      requirements: ['TASK_EXISTS', 'UPDATE_POSTED'],
      requireSameTask: true,
      targetCount: 1,
      groups: [],
      match: { nameContains: '', excludeNameContains: 'Report', labels: [] },
      skipDates: [],
    },
  },
  {
    id: 'monthly-report',
    icon: BadgeCheck,
    title: 'Monthly report',
    seed: {
      name: 'Monthly report',
      cadence: { type: 'monthly', weekdays: [0, 1, 2, 3, 4, 5, 6], graceDays: 5 },
      requirements: ['TASK_EXISTS', 'MANUAL_CONFIRM'],
      requireSameTask: true,
      targetCount: 1,
      groups: [],
      match: { nameContains: 'Report', excludeNameContains: '', labels: [] },
      skipDates: [],
    },
  },
  {
    id: 'twice-weekly',
    icon: MessageSquare,
    title: 'Twice a week',
    seed: {
      name: 'Twice a week',
      cadence: { type: 'weekly', weekStartsOn: 1, weekdays: [1, 2, 3, 4, 5, 6], graceDays: 0 },
      requirements: ['TASK_EXISTS', 'UPDATE_POSTED'],
      requireSameTask: true,
      targetCount: 2,
      groups: [],
      match: { nameContains: '', excludeNameContains: '', labels: [] },
      skipDates: [],
    },
  },
];
