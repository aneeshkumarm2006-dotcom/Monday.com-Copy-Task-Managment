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
 */

import { isStatusDone } from './statusUtils';

export const EMPTY_FILTERS = {
  search: '',
  statuses: [],   // status _id strings (or legacy enum keys)
  priorities: [], // 'critical' | 'high' | 'medium' | 'low'
  labels: [],     // label _id strings
  due: [],        // DUE_BUCKETS keys
  assignees: [],  // user _id strings, plus the synthetic 'unassigned'
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
 * Count how many filter categories are currently constraining the view.
 * Used to badge the affordance and to toggle the "Clear all" button.
 */
export const countActiveFilters = (filters) => {
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

export const hasActiveFilters = (filters) => countActiveFilters(filters) > 0;

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

  // Labels — exclusive, unlike every other category: a task passes only if
  // every label it carries was selected. So a task tagged both "Approved" and
  // "Meeting Done" fails an "Approved"-only filter, and returns once "Meeting
  // Done" is selected too. Unlabelled tasks never pass.
  if (filters.labels?.length) {
    const taskLabels = (task.labels || []).map((id) => id.toString());
    if (taskLabels.length === 0) return false;
    if (!taskLabels.every((id) => filters.labels.includes(id))) return false;
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

export default taskMatchesFilters;
