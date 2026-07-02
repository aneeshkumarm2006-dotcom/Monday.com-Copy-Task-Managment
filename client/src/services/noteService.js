import api from './api';

/**
 * Notes — rich-text docs attached to a board group. Mirrors updateService.
 *
 * A note's shape: { _id, group, board, author, lastEditedBy, title,
 * body (TipTap JSON), bodyText, createdAt, updatedAt }.
 */

/**
 * GET /api/groups/:groupId/notes — notes for a group, most recently edited first.
 */
export const getNotes = async (groupId) => {
  const { data } = await api.get(`/api/groups/${groupId}/notes`);
  return data.notes;
};

/**
 * POST /api/groups/:groupId/notes
 *
 * @param {string} groupId
 * @param {object} payload
 * @param {string} payload.title    — note title (may be empty)
 * @param {object} payload.body     — TipTap JSON document
 * @param {string} payload.bodyText — plain-text mirror for previews
 */
export const createNote = async (groupId, { title = '', body = null, bodyText = '' } = {}) => {
  const { data } = await api.post(`/api/groups/${groupId}/notes`, {
    title,
    body,
    bodyText,
  });
  return data.note;
};

/**
 * PATCH /api/notes/:id — partial update. Editor only. Same payload as create.
 */
export const updateNote = async (noteId, { title, body, bodyText } = {}) => {
  const { data } = await api.patch(`/api/notes/${noteId}`, {
    title,
    body,
    bodyText,
  });
  return data.note;
};

/**
 * DELETE /api/notes/:id
 */
export const deleteNote = async (noteId) => {
  const { data } = await api.delete(`/api/notes/${noteId}`);
  return data;
};

/**
 * GET /api/boards/:boardId/notes/counts — per-group note counts for the header
 * badges. Returns a plain map { [groupId]: count }.
 */
export const getNoteCounts = async (boardId) => {
  const { data } = await api.get(`/api/boards/${boardId}/notes/counts`);
  return data.counts || {};
};
