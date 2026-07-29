import api from './api';

/**
 * GET /api/tasks/:taskId/updates — newest-first list of updates.
 *
 * @param {string} taskId
 * @param {'shared'|'internal'} visibility — which thread to read. 'shared' is the
 *   feed the client also sees in the portal; 'internal' is the team-only one.
 */
export const getUpdates = async (taskId, visibility = 'shared') => {
  const { data } = await api.get(`/api/tasks/${taskId}/updates`, {
    params: { visibility },
  });
  return data.updates;
};

/**
 * POST /api/tasks/:taskId/updates
 *
 * @param {string} taskId
 * @param {object} payload
 * @param {object} payload.body         — TipTap JSON document
 * @param {string} payload.bodyText     — plain-text fallback (used in emails)
 * @param {string[]} payload.mentions   — array of mentioned user ids
 * @param {object[]} payload.attachments — [{ url, name, mime, size }]
 * @param {string|null} payload.replyTo — id of the update being replied to
 * @param {'shared'|'internal'} payload.visibility — 'internal' posts to the
 *        team-only thread; the client never sees it and is never emailed it.
 */
export const addUpdate = async (
  taskId,
  {
    body,
    bodyText = '',
    mentions = [],
    attachments = [],
    replyTo = null,
    visibility = 'shared',
  }
) => {
  const { data } = await api.post(`/api/tasks/${taskId}/updates`, {
    body,
    bodyText,
    mentions,
    attachments,
    replyTo,
    visibility,
  });
  return data.update;
};

/**
 * PATCH /api/tasks/:taskId/updates/:id
 *
 * Edit an existing update. Author only. Same payload shape as addUpdate.
 */
export const editUpdate = async (
  taskId,
  updateId,
  { body, bodyText = '', mentions = [], attachments = [] }
) => {
  const { data } = await api.patch(`/api/tasks/${taskId}/updates/${updateId}`, {
    body,
    bodyText,
    mentions,
    attachments,
  });
  return data.update;
};

/**
 * DELETE /api/tasks/:taskId/updates/:id
 */
export const deleteUpdate = async (taskId, updateId) => {
  const { data } = await api.delete(`/api/tasks/${taskId}/updates/${updateId}`);
  return data;
};

/**
 * PATCH /api/tasks/:taskId/updates/:id/read
 *
 * Toggle the current user's per-user read marker on an update they were
 * mentioned in. Only mentioned users are authorised server-side. Returns the
 * populated update.
 */
export const setMentionRead = async (taskId, updateId, read = true) => {
  const { data } = await api.patch(
    `/api/tasks/${taskId}/updates/${updateId}/read`,
    { read }
  );
  return data.update;
};

/**
 * POST /api/tasks/:taskId/updates/attachments — uploads a single file to
 * Cloudinary via multer middleware. Returns the resulting attachment object.
 */
export const uploadAttachment = async (taskId, file) => {
  const form = new FormData();
  form.append('file', file);
  const { data } = await api.post(
    `/api/tasks/${taskId}/updates/attachments`,
    form,
    { headers: { 'Content-Type': 'multipart/form-data' } }
  );
  return data.attachment;
};
