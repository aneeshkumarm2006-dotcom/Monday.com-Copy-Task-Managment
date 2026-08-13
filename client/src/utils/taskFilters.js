/**
 * Task filtering helpers for the board filter bar.
 *
 * Filters operate on the standard task fields (name, status, priority,
 * labels, dueDate, assignedTo). Those fields stay populated even on
 * flexible-column boards because Task.js syncs `columnValues` back onto them,
 * so a single filter path covers both the legacy TaskTable and the DataGrid.
 *
 * Semantics: a task must satisfy EVERY active category (AND); within a single
 * category, matching ANY selected value is enough (OR). An empty category
 * imposes no constraint.
 *
 * Labels are the one exception — they match EXCLUSIVELY, so the filtered view
 * shows exactly the label combination that was asked for. See below.
 *
 * `groupOwners` is the one category that does NOT describe a task. A tracker
 * board's group carries a per-month owner (see server utils/groupOwner.js), so
 * that filter cuts at the GROUP level: a non-matching group leaves the view
 * whole, and the tasks inside it are never consulted. Hence the two predicates
 * below — `taskMatchesFilters` for the task categories, `groupMatchesFilters`
 * for this one — and the split active-count helpers, which callers use to tell
 * "the task list has been subset" (unsafe to reorder / create into) from "some
 * groups are hidden" (tasks untouched).
 */

import { isStatusDone } from './statusUtils';

export const EMPTY_FILTERS = {
  search: '',
  statuses: [],   // status _id strings (or legacy enum keys)
  priorities: [], // 'critical' | 'high' | 'medium' | 'low'
  labels: [],     // label _id strings
  due: [],        // DUE_BUCKETS keys
  assignees: [],  // user _id strings, plus the synthetic 'unassigned'
  groupOwners: [], // GROUP owner user _id strings, plus 'unassigned' (tracker boards)
};

/**
 * Due-date buckets offered in the filter, in display order.
 */
export const DUE_BUCKETS = [
  { key: 'overdue', label: 'Overdue' },
  { key: 'today', label: 'Due today' },
  { key: 'week', label: 'Due this week' },
  { key: 'month', label: 'Due this month' },
  { key: 'none', label: 'No due date' },
];

const MS_IN_DAY = 24 * 60 * 60 * 1000;

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

const matchesDueBucket = (dueInput, bucket, now, isDone = false) => {
  if (bucket === 'none') return !dueInput;
  if (!dueInput) return false;
  const due = new Date(dueInput);
  if (Number.isNaN(due.getTime())) return false;
  const dueDay = startOfDay(due).getTime();
  const today = startOfDay(now).getTime();
  switch (bucket) {
    case 'overdue':
      // A completed task is never "overdue", even if its due date has passed.
      return !isDone && dueDay < today;
    case 'today':
      return dueDay === today;
    case 'week':
      // From today through the next 7 days (inclusive), not past.
      return dueDay >= today && dueDay <= today + 7 * MS_IN_DAY;
    case 'month':
      // From today through the next 30 days (inclusive), not past.
      return dueDay >= today && dueDay <= today + 30 * MS_IN_DAY;
    default:
      return false;
  }
};

/**
 * Add `value` to `list` if absent, remove it if present. Returns a new array.
 * Convenience for toggling a checkbox option in a filter category.
 */
export const toggleValue = (list, value) => {
  const arr = Array.isArray(list) ? list : [];
  return arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value];
};

/**
 * Count how many TASK-level categories are constraining the view — i.e. how
 * many of them can remove rows from inside a group.
 */
export const countActiveTaskFilters = (filters) => {
  if (!filters) return 0;
  let n = 0;
  if (filters.search && filters.search.trim()) n += 1;
  if (filters.statuses?.length) n += 1;
  if (filters.priorities?.length) n += 1;
  if (filters.labels?.length) n += 1;
  if (filters.due?.length) n += 1;
  if (filters.assignees?.length) n += 1;
  return n;
};

/** Count of GROUP-level categories. Today: group owner. */
export const countActiveGroupFilters = (filters) =>
  filters?.groupOwners?.length ? 1 : 0;

/**
 * Count how many filter categories are currently constraining the view.
 * Used to badge the affordance and to toggle the "Clear all" button.
 */
export const countActiveFilters = (filters) =>
  countActiveTaskFilters(filters) + countActiveGroupFilters(filters);

export const hasActiveFilters = (filters) => countActiveFilters(filters) > 0;

/** True when the visible task list is a SUBSET of a group's real task list. */
export const hasActiveTaskFilters = (filters) => countActiveTaskFilters(filters) > 0;

/** True when whole groups are being hidden. */
export const hasActiveGroupFilters = (filters) => countActiveGroupFilters(filters) > 0;

/**
 * Does a single task satisfy the active filters?
 * `now` defaults to the current time; injectable for deterministic tests.
 */
export const taskMatchesFilters = (task, filters, now = new Date(), board = null) => {
  if (!filters || !task) return true;

  // Name search
  const q = (filters.search || '').trim().toLowerCase();
  if (q && !(task.name || '').toLowerCase().includes(q)) return false;

  // Status — compare as strings to tolerate ObjectId vs legacy enum shapes
  if (filters.statuses?.length) {
    const s = task.status != null ? task.status.toString() : null;
    if (!s || !filters.statuses.includes(s)) return false;
  }

  // Priority
  if (filters.priorities?.length) {
    if (!task.priority || !filters.priorities.includes(task.priority)) return false;
  }

  // Labels — exclusive, unlike every other category: a task passes only if its
  // label set is exactly the selected set. A task tagged only "Approved" fails
  // an "Approved" + "Meeting Done" filter (it is missing one), and so does a
  // task tagged "Approved" + "Meeting Done" + "Sent" (it carries a spare).
  //
  // The synthetic 'none' value is the one OR-style escape hatch: it matches
  // unlabelled tasks. Selected on its own it shows exactly the tasks with no
  // labels; combined with real labels it ORs in — a task passes if it is
  // unlabelled OR it exactly matches the selected real-label set.
  if (filters.labels?.length) {
    const wantsNone = filters.labels.includes('none');
    const realLabels = filters.labels.filter((id) => id !== 'none');
    const taskLabels = (task.labels || []).map((id) => id.toString());

    const matchesNone = wantsNone && taskLabels.length === 0;

    let matchesReal = false;
    if (realLabels.length && taskLabels.length) {
      const hasEverySelected = realLabels.every((id) => taskLabels.includes(id));
      const carriesNothingElse = taskLabels.every((id) => realLabels.includes(id));
      matchesReal = hasEverySelected && carriesNothingElse;
    }

    if (!matchesNone && !matchesReal) return false;
  }

  // Due date — match ANY selected bucket. Done tasks are excluded from the
  // "Overdue" bucket so completed work drops out of an overdue view.
  if (filters.due?.length) {
    const done = isStatusDone(board, task.status);
    if (!filters.due.some((b) => matchesDueBucket(task.dueDate, b, now, done)))
      return false;
  }

  // Assignees — match ANY selected member, plus the synthetic "unassigned"
  if (filters.assignees?.length) {
    const ids = (task.assignedTo || []).map((a) =>
      (a && a._id ? a._id : a).toString()
    );
    const wantsUnassigned = filters.assignees.includes('unassigned');
    const matchesUnassigned = wantsUnassigned && ids.length === 0;
    const matchesMember = filters.assignees.some(
      (id) => id !== 'unassigned' && ids.includes(id)
    );
    if (!matchesUnassigned && !matchesMember) return false;
  }

  return true;
};

/**
 * Does a group survive the GROUP-level filters?
 *
 * Reads `group.owner` — the already-RESOLVED owner for the month on screen,
 * which groupController serializes onto each group. The `ownerTimeline` never
 * reaches the client precisely so that no second copy of the carry-forward rule
 * can exist here; this function must therefore never try to derive an owner
 * from anything but that field.
 *
 * A group carrying no owner for the month — never assigned, or a tombstone —
 * matches only the synthetic 'unassigned' value, mirroring how the assignee
 * category treats a task with nobody on it.
 */
export const groupMatchesFilters = (group, filters) => {
  if (!filters?.groupOwners?.length) return true;
  if (!group) return false;

  const owner = group.owner;
  const ownerId = owner ? String(owner._id ?? owner) : null;

  if (!ownerId) return filters.groupOwners.includes('unassigned');
  return filters.groupOwners.includes(ownerId);
};

export default taskMatchesFilters;
