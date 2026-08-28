import api from './api';

/**
 * Monthly goals. Every read comes back with the server's computed score already
 * attached — the client never recomputes one, because two implementations of a
 * scoring rule is the same class of bug as two implementations of a permission
 * rule.
 *
 * `suppressErrorToast` throughout, matching trackerService: a 403 or 404 here is
 * meaningful information (no capability, or not a tracker board) and the tab
 * renders the server's own sentence rather than firing a generic toast.
 */

/** The type catalog that generates the add-a-goal form. Static; fetched once. */
export const getGoalTypes = async () => {
  const { data } = await api.get('/api/goal-types', { suppressErrorToast: true });
  return data;
};

/** Everything the Goals tab needs for one month, in one round trip. */
export const getGoals = async (boardId, monthKey) => {
  const { data } = await api.get(`/api/boards/${boardId}/goals`, {
    params: { month: monthKey },
    suppressErrorToast: true,
  });
  return data.goals;
};

export const createGoal = async (boardId, payload) => {
  const { data } = await api.post(`/api/boards/${boardId}/goals`, payload, {
    suppressErrorToast: true,
  });
  return data.goal;
};

/**
 * A payload touching ONLY `actual` / `actualDayKey` / `columnValues` needs the
 * lower `goal.track` rung; anything else needs `goal.manage`. The server decides
 * that from the body, so there is nothing to pass here.
 */
export const updateGoal = async (goalId, payload) => {
  const { data } = await api.put(`/api/goals/${goalId}`, payload, {
    suppressErrorToast: true,
  });
  return data;
};

export const deleteGoal = async (goalId) => {
  const { data } = await api.delete(`/api/goals/${goalId}`);
  return data;
};

/**
 * GET /api/goals/:id/activity — one goal's history.
 *
 * Rows come from the SAME `ActivityLog` collection as a task's activity feed
 * and in the same shape, which is why the panel renders them with the same
 * `ActivityEntry` component. `goal.createdBy` / `goal.updatedBy` ride along on
 * the response because a goal created before this log existed has no
 * `goal.created` row to find, and the stamp on the document is the only honest
 * answer for it.
 *
 * @param {string} goalId
 * @param {object} [opts]
 * @param {string} [opts.cursor] - `nextCursor` from a previous page
 * @param {number} [opts.limit]
 */
export const getGoalActivity = async (goalId, opts = {}) => {
  const params = {};
  if (opts.cursor) params.cursor = opts.cursor;
  if (opts.limit) params.limit = opts.limit;
  const { data } = await api.get(`/api/goals/${goalId}/activity`, {
    params,
    suppressErrorToast: true,
  });
  return data;
};

/**
 * The order one group's goals sit in, saved for EVERYONE — the whole point of
 * it being a request at all rather than a localStorage key. `orderedIds` is one
 * group's whole table, in one month; the server refuses a list that spans two.
 *
 * `suppressErrorToast` like the rest of this file: the tab re-reads and says
 * what happened itself, rather than firing a generic toast over a move it is
 * about to visibly undo.
 */
export const reorderGoals = async (boardId, orderedIds) => {
  const { data } = await api.put(
    `/api/boards/${boardId}/goals/reorder`,
    { orderedIds },
    { suppressErrorToast: true }
  );
  return data;
};

/** Per-group scores month by month, for the trend chart. */
export const getGoalTrend = async (boardId, { months = 12, through } = {}) => {
  const { data } = await api.get(`/api/boards/${boardId}/goals/trend`, {
    params: { months, through },
    suppressErrorToast: true,
  });
  return data.trend;
};

// --- The shared column schema (org admins only) -----------------------------

export const listGoalColumns = async (boardId) => {
  const { data } = await api.get(`/api/boards/${boardId}/goal-columns`, {
    suppressErrorToast: true,
  });
  return data;
};

export const addGoalColumn = async (boardId, payload) => {
  const { data } = await api.post(`/api/boards/${boardId}/goal-columns`, payload);
  return data.columns;
};

export const updateGoalColumn = async (boardId, columnId, payload) => {
  const { data } = await api.patch(`/api/boards/${boardId}/goal-columns/${columnId}`, payload);
  return data.columns;
};

export const reorderGoalColumns = async (boardId, orderedIds) => {
  const { data } = await api.patch(`/api/boards/${boardId}/goal-columns/reorder`, { orderedIds });
  return data.columns;
};

/** Archives by default; `purge` hard-deletes the column and every value in it. */
export const deleteGoalColumn = async (boardId, columnId, { purge = false } = {}) => {
  const { data } = await api.delete(`/api/boards/${boardId}/goal-columns/${columnId}`, {
    params: purge ? { purge: 'true' } : undefined,
  });
  return data;
};

/**
 * How much work was attached to each goal this month, and each group's coverage.
 *
 * Its own request rather than part of `getGoals`, for the same reason the
 * connector links are: this is a secondary fact, and a failure fetching it must
 * never be able to blank the goals table.
 */
export const getGoalEvidence = async (boardId, monthKey) => {
  const { data } = await api.get(`/api/boards/${boardId}/goals/evidence`, {
    params: { month: monthKey },
    suppressErrorToast: true,
  });
  return data.evidence;
};

/** The tasks behind one goal — what the count chip opens. Stale rows first. */
export const getGoalTasks = async (goalId) => {
  const { data } = await api.get(`/api/goals/${goalId}/tasks`, {
    suppressErrorToast: true,
  });
  return data.tasks;
};
