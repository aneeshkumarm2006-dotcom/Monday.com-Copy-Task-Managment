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

/**
 * The type catalog that generates the add-a-goal form.
 *
 * `vocabulary` is the BOARD's `goalVocabulary` and changes wording only — the
 * labels and examples a picker shows, never what a type is scored by. Passing
 * nothing (or a key the server does not know) returns the default wording, so a
 * board that has never opted into a trade's vocabulary is unaffected.
 *
 * Fetched per board rather than once per session, because two boards open in
 * one session can want different wording and a single cached catalog would
 * serve whichever tab loaded first.
 */
export const getGoalTypes = async (vocabulary = null) => {
  const { data } = await api.get('/api/goal-types', {
    params: vocabulary ? { vocabulary } : undefined,
    suppressErrorToast: true,
  });
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

/**
 * Copy a month's PROMISES into another month — normally this month's into next.
 *
 * Manual by design: there is no scheduled version of this and there must not be
 * one (see the server's `services/goalCarryForward.js`). `actual` never travels,
 * a goal already present in the target month is skipped rather than duplicated,
 * and the whole thing is therefore safe to run twice.
 *
 * `dryRun: true` returns the identical plan and writes nothing — that is what
 * the modal previews, so the sentence somebody reads before confirming comes
 * from the code that will actually do the work.
 *
 * @param {string} boardId
 * @param {object} payload
 * @param {string} payload.fromMonth
 * @param {string} payload.toMonth
 * @param {string[]} [payload.goalIds]     - omit for the whole month
 * @param {boolean} [payload.rollBaseline] - start from where this month landed
 * @param {boolean} [payload.carryLinks]   - bring the connector wiring too
 * @param {boolean} [payload.dryRun]
 */
export const carryForwardGoals = async (boardId, payload) => {
  const { data } = await api.post(`/api/boards/${boardId}/goals/carry-forward`, payload, {
    suppressErrorToast: true,
  });
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
