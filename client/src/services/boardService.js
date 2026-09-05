import api from './api';

/**
 * GET /api/boards?org=:orgId — list boards for an organisation.
 */
export const getBoards = async (orgId) => {
  const { data } = await api.get('/api/boards', { params: { org: orgId } });
  return data.boards;
};

/**
 * GET /api/boards/:id — one board by id, without knowing its workspace.
 *
 * What deep links need: a board opened from an email or a notification may
 * live in a workspace other than the one currently selected, and the list
 * above can only ever return boards from one workspace at a time.
 */
export const getBoard = async (boardId) => {
  const { data } = await api.get(`/api/boards/${boardId}`);
  return data.board;
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

// --- Board roster ----------------------------------------------------------

/**
 * GET /api/boards/:id/members — who may be ASSIGNED work on this board.
 *
 * The workspace roster narrowed, server-side, to the people who can actually
 * read this board. Every picker on a board page should source its options here
 * rather than from `useOrgStore.members`, which is the whole workspace and on a
 * private board lists people who are not on it.
 *
 * Returns the member array: [{ _id, name, email, profilePic }].
 */
export const getBoardMembers = async (boardId) => {
  const { data } = await api.get(`/api/boards/${boardId}/members`);
  return data.members || [];
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

/**
 * POST /api/boards/:id/transfer-ownership — make another member the board owner.
 * Board-owner only.
 *
 * The outgoing owner keeps an edit + full-access grant, so this hands over the
 * board's LIFECYCLE (delete, visibility, full access) without taking anyone's
 * working access away. Returns { board, access } — `board.permissions` is the
 * CALLER's, re-resolved, so it now says they are no longer the owner.
 */
export const transferBoardOwnership = async (boardId, userId) => {
  const { data } = await api.post(
    `/api/boards/${boardId}/transfer-ownership`,
    { userId }
  );
  return data;
};

// --- Client Portal (per-BOARD link management; client boards only) ----------
//
// A client board IS one client company, so the portal link, the contact roster
// and the tier all hang off the board. These were per-GROUP until the board
// became the client; a group is now that client's workstream (SEO, Ads, Web
// Development) and has no portal of its own.

/**
 * GET /api/portal/boards/:boardId/config — the board's portal state for the
 * management modal. Board-manager only (enforced server-side).
 * Returns { boardId, portalEnabled, clientName, link, tier, announcement, faqs }.
 */
export const getBoardPortalConfig = async (boardId) => {
  const { data } = await api.get(`/api/portal/boards/${boardId}/config`, {
    timeout: 20000,
  });
  return data.portal;
};

/**
 * PUT /api/portal/boards/:boardId/config — set the client label, enable/disable,
 * rotate the link, or edit the announcement + FAQ.
 * Body: { enabled?, clientName?, regenerateLink?, announcement?, faqs? }.
 */
export const saveBoardPortalConfig = async (boardId, payload) => {
  const { data } = await api.put(`/api/portal/boards/${boardId}/config`, payload, {
    timeout: 20000,
  });
  return data.portal;
};

/**
 * POST /api/portal/boards/:boardId/invite — invite a client (ensures the link is
 * live first). Body: { email, authMethod }.
 *
 * `authMethod` decides which email goes out AND how this person may sign in:
 *   'google'   — the shared portal link, "Accept invitation"
 *   'password' — registers the address and mails a one-time set-password link
 *
 * Returns { message, portal, contacts }.
 */
export const sendBoardPortalInvite = async (boardId, email, authMethod = 'google') => {
  const { data } = await api.post(
    `/api/portal/boards/${boardId}/invite`,
    { email, authMethod },
    { timeout: 20000 }
  );
  return data;
};

/**
 * GET /api/portal/boards/:boardId/contacts — who has been invited to this
 * client's portal and how far they've got. Returns { contacts }.
 */
export const getBoardPortalContacts = async (boardId) => {
  const { data } = await api.get(`/api/portal/boards/${boardId}/contacts`, {
    timeout: 20000,
  });
  return data.contacts;
};

/**
 * POST /api/portal/boards/:boardId/invites — THE BATCH INVITE.
 *
 * `rows` is `[{ service, email, authMethod }]`, up to 25. N services become N
 * groups on the board, each with its client chat, client mailbox and private
 * team room; addresses are deduped, so one person on four rows gets ONE email
 * listing four services.
 *
 * The response's `rows` is INDEX-ALIGNED WITH WHAT WAS SENT — that is what lets
 * the table put a tick or a message on each row the user typed. Also returns
 * `services`, `contacts`, `warnings` and a fresh `roster`.
 *
 * 30s, not the usual 20: this sends up to 25 emails through Gmail SMTP.
 */
export const sendBoardPortalInvites = async (boardId, rows) => {
  const { data } = await api.post(
    `/api/portal/boards/${boardId}/invites`,
    { rows },
    { timeout: 30000 }
  );
  return data;
};

/**
 * POST /api/portal/boards/:boardId/contacts/:contactId/resend — re-send whatever
 * this contact needs (Google invite, first set-password link, or a reset link).
 * Returns { message, contacts }.
 */
export const resendPortalInvite = async (boardId, contactId) => {
  const { data } = await api.post(
    `/api/portal/boards/${boardId}/contacts/${contactId}/resend`,
    {},
    { timeout: 20000 }
  );
  return data;
};

/**
 * There is no portal TIER any more, and so no `getBoardPortalTier` /
 * `upgradeBoardPortalTier`. Both existed here with ZERO call sites for their
 * whole life: no UI ever offered the upgrade, so every client board stayed on
 * 'basic' and client chat and mail were unreachable in production. The tier is
 * removed server-side (see server/src/utils/clientBoard.js); these went with it.
 */

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

// --- Group tags (extra feature) ---------------------------------------------
// The board-level catalog of tags its GROUPS may be filed under — the same shape
// as labels, and a separate list on purpose. Listing is open to anyone who can
// read the board; every write needs `column.manage` plus the caller's own
// `features.groupTags` opt-in, both re-checked server-side.

export const listGroupTags = async (boardId) => {
  const { data } = await api.get(`/api/boards/${boardId}/group-tags`);
  return data.groupTags;
};

export const addGroupTag = async (boardId, payload) => {
  const { data } = await api.post(`/api/boards/${boardId}/group-tags`, payload);
  return data.groupTags;
};

export const updateGroupTag = async (boardId, tagId, payload) => {
  const { data } = await api.put(
    `/api/boards/${boardId}/group-tags/${tagId}`,
    payload
  );
  return data.groupTags;
};

export const deleteGroupTag = async (boardId, tagId) => {
  const { data } = await api.delete(
    `/api/boards/${boardId}/group-tags/${tagId}`
  );
  return data.groupTags;
};

export const reorderGroupTags = async (boardId, orderedIds) => {
  const { data } = await api.put(`/api/boards/${boardId}/group-tags/reorder`, {
    orderedIds,
  });
  return data.groupTags;
};

/**
 * Every activity event recorded on a board between two dates (inclusive,
 * `YYYY-MM-DD`). Returns the raw payload — board, range, rows and the
 * `truncated` flag — which utils/activityExport.js turns into a CSV or PDF.
 *
 * 403s when the caller lacks `board.export_activity` OR has not switched the
 * feature on in Settings → Extra features; the modal surfaces the server's own
 * message, which distinguishes the two.
 */
// `threads` pulls each task's full update thread into the payload. It is the
// heaviest part of the response, and only the CSV has a column for it.
export const getActivityExport = async (boardId, { from, to, threads = true }) => {
  const { data } = await api.get(`/api/boards/${boardId}/activity-export`, {
    params: { from, to, threads: threads ? 1 : 0 },
    suppressErrorToast: true,
  });
  return data;
};
