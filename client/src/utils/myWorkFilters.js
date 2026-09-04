/**
 * Filtering helpers for the "My Work" tab (assigned board tasks).
 *
 * Unlike the board filter (utils/taskFilters.js), My Work spans tasks from
 * MANY boards at once, so two pieces work differently:
 *
 *   - Status is matched by its resolved display LABEL rather than its per-board
 *     `_id`. A board task's status is an ObjectId into that board's own
 *     `statuses[]`, so the same id is meaningless across boards. Matching by
 *     label groups "Working on it" from every board under one option and also
 *     covers personal/legacy enum statuses.
 *   - A `boards` category lets the user narrow to specific source boards.
 *
 * Search, priority, and due-date matching are board-agnostic, so they reuse
 * taskMatchesFilters directly to keep a single source of truth.
 *
 * Semantics match the rest of the app: a task must satisfy EVERY active
 * category (AND); within a category, matching ANY selected value passes (OR).
 * An empty category imposes no constraint.
 */

import taskMatchesFilters, { DUE_BUCKETS } from './taskFilters';
import { getStatusPalette } from './priorityColors';

export const EMPTY_WORK_FILTERS = {
  search: '',
  statuses: [], // resolved status labels, e.g. 'Working on it'
  priorities: [], // 'critical' | 'high' | 'medium' | 'low'
  boards: [], // board _id strings
  due: [], // DUE_BUCKETS keys (see taskFilters.js)
};

/**
 * Resolve the human-readable status label for a task, interpreted against its
 * own board. Used both for matching and for building the option list so the
 * two never drift.
 */
export const resolveStatusLabel = (task) =>
  getStatusPalette(task?.board || null, task?.status).label;

const boardId = (task) => {
  const ref = task?.board && task.board._id ? task.board._id : task?.board;
  return ref != null ? ref.toString() : null;
};

/**
 * Does a single work task satisfy the active filters?
 * `now` is injectable for deterministic tests.
 */
export const workTaskMatchesFilters = (task, filters, now = new Date()) => {
  if (!filters || !task) return true;
  const board = task.board || null;

  // Search, priority, due — board-agnostic, delegated to the shared matcher.
  if (
    !taskMatchesFilters(
      task,
      {
        search: filters.search,
        priorities: filters.priorities,
        due: filters.due,
      },
      now,
      board
    )
  ) {
    return false;
  }

  // Status — compare the resolved label so it groups across boards.
  if (filters.statuses?.length) {
    if (!filters.statuses.includes(resolveStatusLabel(task))) return false;
  }

  // Board — match ANY selected source board.
  if (filters.boards?.length) {
    const id = boardId(task);
    if (!id || !filters.boards.includes(id)) return false;
  }

  return true;
};

/**
 * Count how many filter categories are currently constraining the view.
 */
export const countActiveWorkFilters = (filters) => {
  if (!filters) return 0;
  let n = 0;
  if (filters.search && filters.search.trim()) n += 1;
  if (filters.statuses?.length) n += 1;
  if (filters.priorities?.length) n += 1;
  if (filters.boards?.length) n += 1;
  if (filters.due?.length) n += 1;
  return n;
};

export const hasActiveWorkFilters = (filters) =>
  countActiveWorkFilters(filters) > 0;

/* ------------------------------------------------------------------ */
/* Deep links into My Work                                            */
/* ------------------------------------------------------------------ */

/**
 * My Work can be opened with its filter bar already set — the dashboard's
 * "4 are overdue" is a link to the four tasks, not a statistic.
 *
 * ONE shape, built and read in this file only, so a caller can never invent a
 * param the page does not understand: `/my-tasks?due=overdue&priority=high`.
 * Repeated params rather than a comma list, because a status here is a display
 * LABEL ("Working on it") and a label may contain anything.
 *
 * Unknown values are dropped on the way in. A URL is user-editable, and a
 * filter for a bucket that does not exist would hide every task with no option
 * in the bar to untick.
 */
export const MY_WORK_PATH = '/my-tasks';

/** filters key → query param. The only mapping; both directions read it. */
const LIST_PARAMS = [
  ['statuses', 'status'],
  ['priorities', 'priority'],
  ['boards', 'board'],
  ['due', 'due'],
];
const SEARCH_PARAM = 'q';

const DUE_KEYS = DUE_BUCKETS.map((b) => b.key);
const PRIORITY_KEYS = ['critical', 'high', 'medium', 'low'];

/**
 * Build the in-app path that opens My Work with these filters applied.
 * Takes a partial EMPTY_WORK_FILTERS; empty categories are simply left out.
 */
export const buildMyWorkLink = (filters = {}) => {
  const params = new URLSearchParams();
  const search = (filters.search || '').trim();
  if (search) params.set(SEARCH_PARAM, search);
  for (const [key, param] of LIST_PARAMS) {
    for (const value of filters[key] || []) {
      if (value != null && value !== '') params.append(param, String(value));
    }
  }
  const query = params.toString();
  return query ? `${MY_WORK_PATH}?${query}` : MY_WORK_PATH;
};

/** Does this URL carry any My Work filter at all? */
export const hasWorkFilterParams = (params) => {
  if (!params) return false;
  if ((params.get(SEARCH_PARAM) || '').trim()) return true;
  return LIST_PARAMS.some(([, param]) => params.getAll(param).length > 0);
};

/**
 * Read filters out of a URL. Always returns a complete filter object, so the
 * result can be dropped straight into state.
 */
export const workFiltersFromParams = (params) => {
  if (!params) return { ...EMPTY_WORK_FILTERS };
  const clean = (values, allowed) =>
    values
      .map((v) => (v || '').trim())
      .filter((v) => v && (!allowed || allowed.includes(v)));
  return {
    ...EMPTY_WORK_FILTERS,
    search: (params.get(SEARCH_PARAM) || '').trim(),
    statuses: clean(params.getAll('status')),
    priorities: clean(params.getAll('priority'), PRIORITY_KEYS),
    boards: clean(params.getAll('board')),
    due: clean(params.getAll('due'), DUE_KEYS),
  };
};

/**
 * The same URL with the filter params removed, leaving anything else on it
 * untouched. The page consumes a deep link once and then drops it, so that
 * clearing the filter bar cannot be undone by a reload.
 */
export const stripWorkFilterParams = (params) => {
  const next = new URLSearchParams(params || '');
  next.delete(SEARCH_PARAM);
  for (const [, param] of LIST_PARAMS) next.delete(param);
  return next;
};

export default workTaskMatchesFilters;
