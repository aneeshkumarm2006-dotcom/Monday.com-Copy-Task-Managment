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

import taskMatchesFilters from './taskFilters';
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

export default workTaskMatchesFilters;
