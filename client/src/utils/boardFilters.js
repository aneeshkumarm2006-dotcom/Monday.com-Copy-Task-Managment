/**
 * Filtering helpers for the "My Boards" grid/list.
 *
 * The board name search lives in its own toolbar input (MyBoardsPage), so it is
 * deliberately NOT part of this shape — these are the categories the Filter
 * popup owns: visibility, completion progress, ownership, and last-updated
 * recency, all derived from fields `GET /api/boards` already ships on each
 * board (visibility, taskCount/progress, permissions.isBoardOwner, updatedAt).
 *
 * Semantics match the rest of the app (My Work / board filter bar): a board
 * must satisfy EVERY active category (AND); within a category, matching ANY
 * selected value passes (OR). An empty category imposes no constraint.
 */

export const EMPTY_BOARD_FILTERS = {
  visibility: [], // 'public' | 'private'
  boardType: [], // 'standard' | 'client' | 'tracker'
  progress: [], // 'empty' | 'not_started' | 'in_progress' | 'completed'
  ownership: [], // 'owned' | 'shared'
  updated: [], // 'today' | 'week' | 'month' | 'older'
};

// Option metadata, exported so the panel and the matcher share one source of
// truth for the available keys (and never drift).
export const VISIBILITY_OPTIONS = [
  { key: 'public', label: 'Public' },
  { key: 'private', label: 'Private' },
];

export const BOARD_TYPE_OPTIONS = [
  { key: 'standard', label: 'Standard' },
  { key: 'client', label: 'Client Portal' },
  { key: 'tracker', label: 'Tracker' },
];

/**
 * The single label a board should wear. Board TYPE beats visibility when there
 * is one: "tracker" and "client" say far more than "private" does, and both of
 * those types are always private anyway. Lives here rather than beside the pill
 * component so the pill file exports only a component (react-refresh) and the
 * filter and the badge cannot disagree about what a board is.
 */
export const boardTypeKey = (board) => {
  if (board?.boardType === 'tracker') return 'tracker';
  if (board?.boardType === 'client') return 'client';
  return board?.visibility === 'public' ? 'public' : 'private';
};

export const PROGRESS_OPTIONS = [
  { key: 'empty', label: 'No tasks yet' },
  { key: 'not_started', label: 'Not started (0%)' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'completed', label: 'Completed (100%)' },
];

export const OWNERSHIP_OPTIONS = [
  { key: 'owned', label: 'Owned by me' },
  { key: 'shared', label: 'Shared with me' },
];

export const UPDATED_OPTIONS = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'Last 7 days' },
  { key: 'month', label: 'Last 30 days' },
  { key: 'older', label: 'Older than 30 days' },
];

const FILTER_CATEGORIES = [
  'visibility', 'boardType', 'progress', 'ownership', 'updated',
];

/**
 * Which progress bucket a board falls in. Mutually exclusive, so matching one
 * selected bucket is a clean equality test. "empty" (no tasks) is kept distinct
 * from "not_started" (has tasks, none done) because they read very differently
 * on a card.
 */
export const progressBucket = (board) => {
  const taskCount = board?.taskCount ?? 0;
  const progress = board?.progress ?? 0;
  if (taskCount === 0) return 'empty';
  if (progress >= 100) return 'completed';
  if (progress <= 0) return 'not_started';
  return 'in_progress';
};

const matchesOwnership = (board, key) => {
  const owned = board?.permissions?.isBoardOwner === true;
  return key === 'owned' ? owned : !owned;
};

/**
 * The updated buckets are cumulative windows (today ⊂ week ⊂ month), plus an
 * exclusive "older" tail — this matches how people think ("boards touched in the
 * last 7 days"), and OR-within-category makes any overlap harmless.
 * `now` is injectable for deterministic tests.
 */
const matchesUpdated = (board, key, now) => {
  const ts = board?.updatedAt || board?.createdAt;
  const then = ts ? new Date(ts).getTime() : NaN;
  if (Number.isNaN(then)) return key === 'older';
  const t = now.getTime();
  const DAY = 86400000;
  switch (key) {
    case 'today': {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      return then >= start.getTime();
    }
    case 'week':
      return then >= t - 7 * DAY;
    case 'month':
      return then >= t - 30 * DAY;
    case 'older':
      return then < t - 30 * DAY;
    default:
      return true;
  }
};

/**
 * Does a single board satisfy the active filters?
 * `now` is injectable for deterministic tests.
 */
export const boardMatchesFilters = (board, filters, now = new Date()) => {
  if (!filters || !board) return true;

  if (filters.visibility?.length && !filters.visibility.includes(board.visibility)) {
    return false;
  }
  // `boardType` is absent on boards created before the field existed; they are
  // standard, so default rather than dropping them out of every filtered view.
  if (
    filters.boardType?.length &&
    !filters.boardType.includes(board.boardType || 'standard')
  ) {
    return false;
  }
  if (filters.progress?.length && !filters.progress.includes(progressBucket(board))) {
    return false;
  }
  if (
    filters.ownership?.length &&
    !filters.ownership.some((k) => matchesOwnership(board, k))
  ) {
    return false;
  }
  if (
    filters.updated?.length &&
    !filters.updated.some((k) => matchesUpdated(board, k, now))
  ) {
    return false;
  }
  return true;
};

/**
 * Count how many filter categories are currently constraining the view.
 */
export const countActiveBoardFilters = (filters) => {
  if (!filters) return 0;
  return FILTER_CATEGORIES.reduce(
    (n, key) => n + (filters[key]?.length ? 1 : 0),
    0
  );
};

export const hasActiveBoardFilters = (filters) =>
  countActiveBoardFilters(filters) > 0;

export default boardMatchesFilters;
