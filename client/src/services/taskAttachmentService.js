import api from './api';

/**
 * GET /api/tasks/:taskId/attachments — list files attached to a task.
 * Returns an array of { _id, url, name, mime, size, uploadedBy, createdAt }.
 */
export const getAttachments = async (taskId) => {
  const { data } = await api.get(`/api/tasks/${taskId}/attachments`);
  return data.attachments || [];
};

/**
 * POST /api/tasks/:taskId/attachments — upload a file to Cloudinary via the
 * server's multer middleware. Returns the created attachment subdoc.
 */
export const uploadAttachment = async (taskId, file) => {
  const form = new FormData();
  form.append('file', file);
  const { data } = await api.post(
    `/api/tasks/${taskId}/attachments`,
    form,
    { headers: { 'Content-Type': 'multipart/form-data' } }
  );
  return data.attachment;
};

/**
 * GET /api/tasks/:taskId/client-request — the Client Portal request behind a
 * task: what the client titled it, the details they gave, and the files they
 * attached while raising it. Returns null for tasks that weren't raised by a
 * client (the server 404s — that isn't an error worth surfacing).
 */
export const getClientRequest = async (taskId) => {
  try {
    const { data } = await api.get(`/api/tasks/${taskId}/client-request`);
    return data.request || null;
  } catch (err) {
    if (err?.response?.status === 404) return null;
    throw err;
  }
};

/**
 * DELETE /api/tasks/:taskId/attachments/:attachmentId
 */
export const deleteAttachment = async (taskId, attachmentId) => {
  const { data } = await api.delete(
    `/api/tasks/${taskId}/attachments/${attachmentId}`
  );
  return data;
};
