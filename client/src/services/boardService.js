import api from './api';

/**
 * GET /api/boards?org=:orgId — list boards for an organisation.
 */
export const getBoards = async (orgId) => {
  const { data } = await api.get('/api/boards', { params: { org: orgId } });
  return data.boards;
};

/**
 * GET /api/dashboard/stats?org=:orgId — aggregated workspace stats.
 */
export const getDashboardStats = async (orgId) => {
  const { data } = await api.get('/api/dashboard/stats', {
    params: { org: orgId },
  });
  return data;
};

/**
 * POST /api/boards — create a board (admin only).
 */
export const createBoard = async (payload) => {
  const { data } = await api.post('/api/boards', payload);
  return data.board;
};

/**
 * PUT /api/boards/:id — update a board (admin only).
 */
export const updateBoard = async (id, payload) => {
  const { data } = await api.put(`/api/boards/${id}`, payload);
  return data.board;
};

/**
 * DELETE /api/boards/:id — delete board + cascade (admin only).
 */
export const deleteBoard = async (id) => {
  const { data } = await api.delete(`/api/boards/${id}`);
  return data;
};

/**
 * PUT /api/boards/reorder — reorder boards within an organisation.
 */
export const reorderBoards = async (organisation, orderedIds) => {
  const { data } = await api.put('/api/boards/reorder', {
    organisation,
    orderedIds,
  });
  return data.boards;
};

// --- Access grants (private boards) ----------------------------------------

/**
 * GET /api/boards/:id/access — list a private board's per-member grants.
 * Open to the owner and to members with 'edit' access.
 * Returns { access: [{ user, level, canManage }], createdBy, isOwner,
 *           canManageAccess }.
 */
export const getBoardAccess = async (boardId) => {
  const { data } = await api.get(`/api/boards/${boardId}/access`);
  return data;
};

/**
 * PUT /api/boards/:id/access — set a member's access level.
 * `level` is 'read' | 'edit' | 'none' ('none' removes the grant).
 * `canManage` (owner-only) upgrades an 'edit' grant to full access — they can
 * manage the board's sharing too. Omit it to leave the current flag alone.
 * Returns { board, access }.
 */
export const setBoardAccess = async (boardId, userId, level, canManage) => {
  const { data } = await api.put(`/api/boards/${boardId}/access`, {
    userId,
    level,
    ...(canManage === undefined ? {} : { canManage }),
  });
  return data;
};

// --- Client Portal (per-group link management; client boards only) ----------

/**
 * GET /api/portal/groups/:groupId/config — the group's portal link state for the
 * management modal. Board-manager only (enforced server-side).
 * Returns { groupId, portalEnabled, clientName, passcodeSet, link }.
 */
export const getGroupPortalConfig = async (groupId) => {
  const { data } = await api.get(`/api/portal/groups/${groupId}/config`);
  return data.portal;
};

/**
 * PUT /api/portal/groups/:groupId/config — enable/disable, set the client label,
 * (re)set the passcode, or rotate the link.
 * Body: { enabled?, clientName?, passcode?, regenerateLink? }.
 */
export const saveGroupPortalConfig = async (groupId, payload) => {
  const { data } = await api.put(`/api/portal/groups/${groupId}/config`, payload);
  return data.portal;
};

// --- Labels ----------------------------------------------------------------

export const addLabel = async (boardId, payload) => {
  const { data } = await api.post(`/api/boards/${boardId}/labels`, payload);
  return data.labels;
};

export const updateLabel = async (boardId, labelId, payload) => {
  const { data } = await api.put(
    `/api/boards/${boardId}/labels/${labelId}`,
    payload
  );
  return data.labels;
};

export const deleteLabel = async (boardId, labelId) => {
  const { data } = await api.delete(`/api/boards/${boardId}/labels/${labelId}`);
  return data.labels;
};

export const reorderLabels = async (boardId, orderedIds) => {
  const { data } = await api.put(`/api/boards/${boardId}/labels/reorder`, {
    orderedIds,
  });
  return data.labels;
};

// --- Statuses --------------------------------------------------------------

export const addStatus = async (boardId, payload) => {
  const { data } = await api.post(`/api/boards/${boardId}/statuses`, payload);
  return data.statuses;
};

export const updateStatus = async (boardId, statusId, payload) => {
  const { data } = await api.put(
    `/api/boards/${boardId}/statuses/${statusId}`,
    payload
  );
  return data.statuses;
};

export const deleteStatus = async (boardId, statusId) => {
  const { data } = await api.delete(
    `/api/boards/${boardId}/statuses/${statusId}`
  );
  return data.statuses;
};

export const reorderStatuses = async (boardId, orderedIds) => {
  const { data } = await api.put(`/api/boards/${boardId}/statuses/reorder`, {
    orderedIds,
  });
  return data.statuses;
};
