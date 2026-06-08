import api from './api';

/**
 * columnService — wraps the flexible-columns engine endpoints (F1).
 *
 * Mirrors the shape of boardService / taskService so the new store can use
 * it the same way. Routes are mounted under `/api/boards/:id/columns` —
 * see `server/src/routes/boards.js`.
 */

/**
 * GET /api/boards/:id/columns — member auth.
 */
export const listColumns = async (boardId) => {
  const { data } = await api.get(`/api/boards/${boardId}/columns`);
  return data.columns;
};

/**
 * POST /api/boards/:id/columns — admin auth.
 * Payload: { name, type, settings?, width?, after?, key?, isPrimary? }
 */
export const addColumn = async (boardId, payload) => {
  const { data } = await api.post(`/api/boards/${boardId}/columns`, payload);
  return data;
};

/**
 * PATCH /api/boards/:id/columns/:cid — admin auth.
 * Payload: { name?, settings?, width? }
 */
export const updateColumn = async (boardId, columnId, payload) => {
  const { data } = await api.patch(
    `/api/boards/${boardId}/columns/${columnId}`,
    payload
  );
  return data;
};

/**
 * PATCH /api/boards/:id/columns/reorder — admin auth.
 * Payload: { order: [cid, cid, ...] } — must list every column exactly once.
 */
export const reorderColumns = async (boardId, order) => {
  const { data } = await api.patch(
    `/api/boards/${boardId}/columns/reorder`,
    { order }
  );
  return data.columns;
};

/**
 * DELETE /api/boards/:id/columns/:cid — admin auth.
 * Rejected when the column is the board's primary.
 */
export const deleteColumn = async (boardId, columnId) => {
  const { data } = await api.delete(
    `/api/boards/${boardId}/columns/${columnId}`
  );
  return data.columns;
};
