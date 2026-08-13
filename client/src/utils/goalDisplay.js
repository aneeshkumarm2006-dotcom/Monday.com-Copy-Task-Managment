/**
 * Presentation-only helpers for monthly goals.
 *
 * Note what is NOT here: any scoring. The server puts a computed `score`,
 * `state` and `rawPct` on every goal it returns and this file only decides what
 * colour that is and what to call it. If you ever find yourself computing a
 * percentage in the client, the number you want is already on the row.
 */

/** Outcome bands. Keys match `state` from the server's scorer. */
export const OUTCOME_META = {
  exceeded: {
    label: 'Exceeded',
    // Deliberately NOT green: "hit it" and "smashed it" should be
    // distinguishable at a glance without reading the number.
    color: 'var(--color-card-purple)',
    bg: 'var(--color-card-purple-bg)',
  },
  achieved: {
    label: 'Achieved',
    color: 'var(--color-status-done)',
    bg: 'var(--color-status-done-bg)',
  },
  partial: {
    label: 'Partial',
    color: 'var(--color-status-working)',
    bg: 'var(--color-status-working-bg)',
  },
  missed: {
    label: 'Missed',
    color: 'var(--color-status-stuck)',
    bg: 'var(--color-status-stuck-bg)',
  },
  untracked: {
    label: 'Not reported',
    color: 'var(--color-text-muted)',
    bg: 'var(--color-bg-subtle)',
  },
};

export const outcomeOf = (state) => OUTCOME_META[state] || OUTCOME_META.untracked;

/**
 * Importance presets. Weight is a number in the data model but a WORD in the
 * UI — "how much does this one matter" is a question a non-technical person can
 * answer, and "weight: 2.0" is not. Leave everything on Normal and the group
 * score is a plain average, which is what most people expect it to be.
 */
export const WEIGHT_PRESETS = [
  { value: 0.5, label: 'Nice to have' },
  { value: 1, label: 'Normal' },
  { value: 2, label: 'High' },
  { value: 3, label: 'Critical' },
];

export const weightLabel = (weight) => {
  const match = WEIGHT_PRESETS.find((p) => p.value === weight);
  if (match) return match.label;
  if (weight === 0) return 'Not counted';
  return `x${weight}`;
};

/** Format a value for display, mirroring the server's `formatValue`. */
export const formatGoalValue = (value, goal) => {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value !== 'number' || !Number.isFinite(value)) return String(value);
  const n = value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  switch (goal?.unit) {
    case 'percent': return `${n}%`;
    // Money is USD — the symbol is fixed, not read from `unitLabel`.
    case 'currency': return `$${n}`;
    case 'custom': return goal.unitLabel ? `${n} ${goal.unitLabel}` : n;
    default: return n;
  }
};

/**
 * Which config field the Start and Target columns edit, per goal type.
 *
 * One table, used by the desktop row AND the mobile card, because they were
 * each carrying their own copy of the same `checklist → total, threshold →
 * limit, deadline → dueDayKey` switch and two copies of a mapping is one copy
 * too many.
 *
 * `null` is a real answer, and the important one: "Did we do it?" and "Judge it
 * manually" promise NO number, so their Target cell must render as a dash you
 * cannot type into. It used to be an editable number cell writing `config.target`
 * — a field neither scorer ever reads, so the value simply vanished.
 */
const TARGET_KEY_BY_TYPE = {
  numeric: 'target',
  checklist: 'total',
  threshold: 'limit',
  deadline: 'dueDayKey',
};

const BASELINE_TYPES = ['numeric', 'threshold'];

/**
 * Both helpers take the server's type spec but fall back to the goal's own type
 * key, so a row still renders correctly in the moment before `GET /api/goal-types`
 * comes back — or at all, if it fails.
 */
export const targetFieldOf = (typeSpec, type) => {
  const key = TARGET_KEY_BY_TYPE[typeSpec?.key || type];
  if (!key) return null;
  const field = (typeSpec?.configFields || []).find((f) => f.key === key);
  return {
    key,
    kind: (field?.type || (key === 'dueDayKey' ? 'date' : 'number')) === 'date' ? 'date' : 'number',
    label: field?.label || 'Target',
  };
};

export const hasBaselineField = (typeSpec, type) =>
  (typeSpec?.configFields || []).some((f) => f.key === 'baseline')
  || (!typeSpec && BASELINE_TYPES.includes(type));

/**
 * The boolean and rating types store their result as a number so every type can
 * share one field. These turn that back into what the user actually picked.
 */
export const RATING_CHOICES = [
  { value: 100, label: 'On track' },
  { value: 50, label: 'Partly there' },
  { value: 0, label: 'Missed' },
];

/** The one-sentence description of a goal, shown in the form preview and as a row tooltip. */
export const describeGoal = (draft, typeSpec) => {
  if (!draft?.name) return '';
  const name = draft.name.trim();
  const c = draft.config || {};
  const val = (v) => formatGoalValue(v, draft);

  switch (draft.type) {
    case 'numeric': {
      if (c.target === undefined || c.target === null || c.target === '') return name;
      const from = c.baseline === undefined || c.baseline === null || c.baseline === ''
        ? null
        : Number(c.baseline);
      const to = Number(c.target);
      if (from === null) return `${name} — reach ${val(to)} this month.`;
      const dir = to > from ? 'Higher is better' : 'Lower is better';
      const gap = Math.abs(to - from).toLocaleString();
      return `${name} — from ${val(from)} to ${val(to)} this month. ${dir}: you’re aiming to move by ${gap}.`;
    }
    case 'boolean':
      return `${name} — done or not done by the end of the month.`;
    case 'checklist':
      return c.total ? `${name} — get through ${c.total} of them this month.` : name;
    case 'threshold': {
      if (c.limit === undefined || c.limit === '') return name;
      const side = (c.direction || 'atMost') === 'atMost' ? 'below' : 'above';
      const base = c.baseline !== undefined && c.baseline !== null && c.baseline !== ''
        ? ` You’re at ${val(Number(c.baseline))} now, so getting closer counts for something.`
        : ' No starting point given, so this one is pass or fail.';
      return `${name} — stay ${side} ${val(Number(c.limit))}.${base}`;
    }
    case 'deadline':
      return c.dueDayKey ? `${name} — has to be done by ${c.dueDayKey}.` : name;
    case 'rating':
      return `${name} — someone rates this at the end of the month.`;
    default:
      return typeSpec?.hint ? `${name} — ${typeSpec.hint}` : name;
  }
};

/** localStorage per-board view prefs, mirroring `deliveryPrefs.js`. */
const PREFS_KEY = 'board:goals:prefs:';

export const loadGoalPrefs = (boardId) => {
  try {
    const raw = localStorage.getItem(`${PREFS_KEY}${boardId}`);
    const parsed = raw ? JSON.parse(raw) : {};
    return { collapsed: [], trendMonths: 12, showTrend: true, ...parsed };
  } catch {
    return { collapsed: [], trendMonths: 12, showTrend: true };
  }
};

export const saveGoalPrefs = (boardId, prefs) => {
  try {
    localStorage.setItem(`${PREFS_KEY}${boardId}`, JSON.stringify(prefs));
  } catch {
    // Private browsing or a full quota — view prefs are a convenience.
  }
};
