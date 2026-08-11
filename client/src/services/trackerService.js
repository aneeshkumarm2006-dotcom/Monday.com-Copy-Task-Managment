import api from './api';

/**
 * GET /api/boards/:boardId/trackers — the tracker definitions for a board.
 */
export const listTrackers = async (boardId) => {
  const { data } = await api.get(`/api/boards/${boardId}/trackers`, {
    // The endpoint answers 403 with a readable reason when the Trackers feature
    // is off or the role lacks the capability; the tab renders that itself
    // rather than firing the generic toast.
    suppressErrorToast: true,
  });
  return data.trackers;
};

/**
 * GET /api/boards/:boardId/delivery — the computed grid.
 *
 * `windows` is a map of trackerId -> preset ('4w', '12m'). Everything else —
 * period boundaries, labels, timezone, holidays, scoring — is resolved
 * server-side, so the client never does date arithmetic of its own.
 */
export const getDelivery = async (boardId, windows = {}) => {
  const encoded = Object.entries(windows)
    .filter(([, token]) => !!token)
    .map(([id, token]) => `${id}:${token}`)
    .join(',');

  const { data } = await api.get(`/api/boards/${boardId}/delivery`, {
    params: encoded ? { windows: encoded } : undefined,
    suppressErrorToast: true,
  });
  return data.delivery;
};

/**
 * POST /api/boards/:boardId/trackers — create a tracker.
 */
export const createTracker = async (boardId, payload) => {
  const { data } = await api.post(`/api/boards/${boardId}/trackers`, payload);
  return data.tracker;
};

/**
 * PUT /api/trackers/:id — update a tracker. Partial: omitted fields are left alone.
 */
export const updateTracker = async (id, payload) => {
  const { data } = await api.put(`/api/trackers/${id}`, payload);
  return data.tracker;
};

/**
 * DELETE /api/trackers/:id — delete a tracker and its confirmations.
 */
export const deleteTracker = async (id) => {
  const { data } = await api.delete(`/api/trackers/${id}`);
  return data;
};

/**
 * PUT /api/trackers/:id/entries — confirm or excuse one (client, period) cell.
 * Upserts, so re-confirming edits in place rather than stacking rows.
 */
export const setTrackerEntry = async (id, { group, periodKey, state, link, note }) => {
  const { data } = await api.put(`/api/trackers/${id}/entries`, {
    group,
    periodKey,
    state,
    link,
    note,
  });
  return data.entry;
};

/**
 * DELETE /api/trackers/:id/entries — undo a confirmation or waiver, handing the
 * cell back to whatever the task data actually says.
 */
export const deleteTrackerEntry = async (id, { group, periodKey }) => {
  const { data } = await api.delete(`/api/trackers/${id}/entries`, {
    params: { group, periodKey },
  });
  return data;
};
