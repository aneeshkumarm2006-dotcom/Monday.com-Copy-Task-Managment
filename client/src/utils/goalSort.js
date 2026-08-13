import { targetFieldOf } from './goalDisplay';

/**
 * Column sorting for the Goals table.
 *
 * The same contract as the board's task table (`TaskTable.jsx`), because it is
 * the same gesture on what looks like the same table: click a heading to sort
 * ascending, click again for descending, click a third time to drop back to the
 * board's own order. Per group, per visit — nothing is persisted and nothing is
 * written back, so sorting is a way of LOOKING at the month and never a change
 * to it. (Goals have no stored `order` to corrupt, unlike the drag-sorted task
 * rows, but the principle is the one that matters.)
 *
 * One deliberate difference from the board: blanks sort last in BOTH
 * directions. The board hands an undated task `Infinity`, which floats every
 * dateless row to the top the moment you reverse the sort. Here, "not reported
 * yet" is the single most common cell on the table for most of the month, so
 * that rule would bury the rows you reversed the sort to look at.
 */

/** Not a value — a hole. Kept distinct from 0 and from '' , both of which are real. */
const BLANK = Symbol('blank');

const isEmpty = (v) =>
  v === null
  || v === undefined
  || v === ''
  || (Array.isArray(v) && v.length === 0)
  || (typeof v === 'number' && !Number.isFinite(v));

/** Prefix for the board's own goal columns: `col:<columnId>`. */
export const columnSortKey = (column) => `col:${column._id}`;

/** Every heading the Goals table lets you sort by. */
export const isSortableGoalColumn = (type) =>
  ['text', 'number', 'date', 'dropdown', 'link', 'person'].includes(type);

const optionRank = (column, value) => {
  const options = column?.settings?.options;
  if (!Array.isArray(options)) return String(value);
  const hit = options.find((o) => o.id != null && String(o.id) === String(value));
  // Configured position, not the label: a dropdown's options are already in the
  // order its author meant them to be read in.
  return hit ? (hit.order || 0) : Number.MAX_SAFE_INTEGER;
};

const columnValue = (column, raw, personName) => {
  if (isEmpty(raw)) return BLANK;
  switch (column?.type) {
    case 'number': {
      const n = Number(raw);
      return Number.isFinite(n) ? n : BLANK;
    }
    case 'date': {
      const t = new Date(raw).getTime();
      return Number.isFinite(t) ? t : BLANK;
    }
    case 'dropdown':
      return optionRank(column, raw);
    case 'link':
      return String(raw?.label || raw?.url || raw || '').toLowerCase();
    case 'person': {
      const ids = Array.isArray(raw) ? raw : [raw];
      const names = ids
        .map((id) => personName?.(id) || '')
        .filter(Boolean)
        .sort();
      // By the first name shown in the cell, so the column reads alphabetically.
      return names.length ? names[0].toLowerCase() : BLANK;
    }
    default:
      return String(raw).toLowerCase();
  }
};

/**
 * The comparable behind one cell.
 *
 * `ctx` carries what the row itself cannot answer: `typesByKey` (which config
 * field the Target column is actually editing for this goal's type),
 * `columnsById`, and `personName` for resolving member ids to names.
 */
const sortValueFor = (goal, key, ctx = {}) => {
  const { typesByKey = {}, columnsById = {}, personName } = ctx;

  if (key.startsWith('col:')) {
    const id = key.slice(4);
    return columnValue(columnsById[id], goal.columnValues?.[id], personName);
  }

  switch (key) {
    case 'name':
      return (goal.name || '').toLowerCase();

    case 'start': {
      const v = goal.config?.baseline;
      return isEmpty(v) ? BLANK : Number(v);
    }

    case 'target': {
      const field = targetFieldOf(typesByKey[goal.type], goal.type);
      // A type that promises no number — "Did we do it?", "Judge it manually" —
      // has nothing in this column to sort by, so it sorts as the hole it is.
      if (!field) return BLANK;
      const v = goal.config?.[field.key];
      if (isEmpty(v)) return BLANK;
      // Day keys are 'YYYY-MM-DD', so lexical order IS chronological order.
      return field.kind === 'date' ? String(v) : Number(v);
    }

    case 'actual': {
      if (!isEmpty(goal.actualDayKey)) return String(goal.actualDayKey);
      return isEmpty(goal.actual) ? BLANK : Number(goal.actual);
    }

    case 'result': {
      const c = goal.computed || {};
      // `rawPct` over `pct`: the score is capped at 100, so sorting on it stacks
      // every over-delivery into one indistinguishable band at the top.
      if (typeof c.rawPct === 'number') return c.rawPct;
      return typeof c.pct === 'number' ? c.pct : BLANK;
    }

    default:
      return BLANK;
  }
};

const compare = (a, b) => {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
};

/** `key` of null means "no sort" and returns the array untouched. */
export const sortGoals = (goals = [], key = null, dir = 'asc', ctx = {}) => {
  if (!key) return goals;
  const mul = dir === 'desc' ? -1 : 1;

  return goals
    .map((goal, index) => ({ goal, index, value: sortValueFor(goal, key, ctx) }))
    .sort((a, b) => {
      const aBlank = a.value === BLANK;
      const bBlank = b.value === BLANK;
      if (aBlank || bBlank) {
        // Never multiplied by `mul` — see the note at the top of this file.
        if (aBlank !== bBlank) return aBlank ? 1 : -1;
        return a.index - b.index;
      }
      const cmp = compare(a.value, b.value);
      // Ties keep the board's order rather than whatever the engine felt like.
      return cmp !== 0 ? cmp * mul : a.index - b.index;
    })
    .map((entry) => entry.goal);
};

/**
 * The board's three-click cycle: asc → desc → off. Returns the next
 * `{ key, dir }` for a click on `nextKey`.
 */
export const nextGoalSort = (current, nextKey) => {
  if (current.key !== nextKey) return { key: nextKey, dir: 'asc' };
  if (current.dir === 'asc') return { key: nextKey, dir: 'desc' };
  return { key: null, dir: 'asc' };
};
