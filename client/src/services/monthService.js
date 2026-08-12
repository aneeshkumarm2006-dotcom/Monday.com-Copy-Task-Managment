import api from './api';

/**
 * GET /api/boards/:boardId/months — the month dropdown for a tracker board.
 *
 * Every month from the board's earliest task through the current month, plus
 * one ahead for planning. Newest first, with labels already formatted.
 *
 * The SERVER owns this list, for the same reason `trackerService.getDelivery`
 * says the client never does date arithmetic of its own: "which month is it"
 * depends on the board's timezone, and there is no timezone-aware day math on
 * the client at all. It also owns the labels, so this dropdown and the Delivery
 * grid can never disagree about what to call August.
 */
export const listBoardMonths = async (boardId) => {
  const { data } = await api.get(`/api/boards/${boardId}/months`, {
    // 404s on a non-tracker board; the caller decides whether that matters
    // rather than firing the generic toast at someone opening a normal board.
    suppressErrorToast: true,
  });
  return data;
};

/**
 * POST /api/boards/:boardId/convert with `dryRun: true` — the month-split
 * preview. Writes nothing, and answers 200 even when the conversion is refused,
 * because the refusal IS what the preview dialog is asking about.
 */
export const previewBoardConversion = async (boardId, { to, timezone }) => {
  const { data } = await api.post(
    `/api/boards/${boardId}/convert`,
    { to, timezone, dryRun: true },
    { suppressErrorToast: true }
  );
  return data.preview;
};

/** POST /api/boards/:boardId/convert — perform it. */
export const convertBoard = async (boardId, { to, timezone }) => {
  const { data } = await api.post(`/api/boards/${boardId}/convert`, { to, timezone });
  return data;
};

/**
 * PUT /api/boards/:boardId/month-timezone
 *
 * Changing the timezone re-derives every task's month, because the boundaries
 * they were filed against have moved. `dryRun` reports how many rows would
 * actually land in a different month — the only number that makes the decision
 * informed.
 */
export const previewMonthTimezone = async (boardId, timezone) => {
  const { data } = await api.put(
    `/api/boards/${boardId}/month-timezone`,
    { timezone, dryRun: true },
    { suppressErrorToast: true }
  );
  return data.preview;
};

export const setMonthTimezone = async (boardId, timezone) => {
  const { data } = await api.put(`/api/boards/${boardId}/month-timezone`, { timezone });
  return data;
};

/**
 * PUT /api/tasks/move-month — refile one or many tasks into another month.
 * Subitems follow their parent server-side.
 */
export const moveTasksToMonth = async (taskIds, monthKey) => {
  const { data } = await api.put('/api/tasks/move-month', { taskIds, monthKey });
  return data;
};
