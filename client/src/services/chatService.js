import api from './api';

/**
 * Chat API — channels sectioned by board, messages shaped like task updates.
 * Every function returns the payload body, unwrapped, matching the style of
 * updateService.
 */

/** GET /api/chat/channels?org= — the sidebar. Also lazily creates the
 *  auto client channels server-side, so the first open of chat in a
 *  workspace populates it. */
export const getChannels = async (orgId) => {
  const { data } = await api.get('/api/chat/channels', {
    params: { org: orgId },
  });
  return data.channels;
};

/** POST /api/chat/channels — a manual channel. boardId null = workspace-level. */
export const createChannel = async (orgId, { name, boardId = null }) => {
  const { data } = await api.post('/api/chat/channels', {
    org: orgId,
    name,
    boardId,
  });
  return data.channel;
};

/** POST /api/chat/dms — find-or-create the DM with one other member. */
export const openDm = async (orgId, userId) => {
  const { data } = await api.post('/api/chat/dms', { org: orgId, userId });
  return data.channel;
};

/** PATCH /api/chat/channels/:id — rename and/or archive. */
export const updateChannel = async (channelId, patch) => {
  const { data } = await api.patch(`/api/chat/channels/${channelId}`, patch);
  return data.channel;
};

/** POST /api/chat/channels/:id/read — move my read marker forward (never back). */
export const markChannelRead = async (channelId, at = null) => {
  const { data } = await api.post(`/api/chat/channels/${channelId}/read`, at ? { at } : {});
  return data;
};

/** GET messages — one page of top-level messages, newest first. */
export const getMessages = async (channelId, { before = null } = {}) => {
  const { data } = await api.get(`/api/chat/channels/${channelId}/messages`, {
    params: before ? { before } : {},
  });
  return data; // { messages, nextBefore, canPost, canManage }
};

/** GET messages?thread= — a parent message and its replies, oldest first. */
export const getThread = async (channelId, messageId) => {
  const { data } = await api.get(`/api/chat/channels/${channelId}/messages`, {
    params: { thread: messageId },
  });
  return data; // { parent, replies }
};

/** POST a message. Payload matches the composer's assembled shape. */
export const sendMessage = async (channelId, payload) => {
  const { data } = await api.post(
    `/api/chat/channels/${channelId}/messages`,
    payload
  );
  return data.message;
};

export const editMessage = async (channelId, messageId, payload) => {
  const { data } = await api.patch(
    `/api/chat/channels/${channelId}/messages/${messageId}`,
    payload
  );
  return data.message;
};

export const deleteMessage = async (channelId, messageId) => {
  const { data } = await api.delete(
    `/api/chat/channels/${channelId}/messages/${messageId}`
  );
  return data;
};

/** POST make-this-a-task — the message becomes a row on the channel's board.
 *  Returns { task, message } (the message now carries the task chip). */
export const makeTaskFromMessage = async (channelId, messageId, payload = {}) => {
  const { data } = await api.post(
    `/api/chat/channels/${channelId}/messages/${messageId}/task`,
    payload
  );
  return data;
};

/* ------------------------------------------------------------------ */
/* Client boards: workstream surfaces and mail threads                  */
/* ------------------------------------------------------------------ */

/**
 * GET /api/chat/boards/:id/channels — every surface on ONE board, grouped by
 * workstream. Powers the board Chat tab.
 *
 * Deliberately a different endpoint from `getChannels` rather than a filter on
 * it: the sidebar wants a flat list of rooms the team can talk in, this wants
 * the board's GROUPS — including the ones with no surfaces yet, which is the
 * whole point, since those are the rows that offer "Set up communication".
 * A filter over the sidebar's response could never show an empty workstream.
 *
 * Returns `{ board, canManage, workstreams, extras }`.
 */
export const getBoardChannels = async (boardId) => {
  const { data } = await api.get(`/api/chat/boards/${boardId}/channels`);
  return data;
};

/**
 * POST the setup modal's selection. `selection` is `{ clientChat, clientMail,
 * team }` — the keys in `utils/chatSurfaces.js`, never a `(mode, audience)`
 * pair spelled out here.
 *
 * Idempotent server-side, so a double-submit converges rather than duplicating.
 * That is why the response splits what it made from what was already there:
 * `{ created, existing }`.
 */
export const createSurfaces = async (boardId, groupId, selection) => {
  const { data } = await api.post(
    `/api/chat/boards/${boardId}/groups/${groupId}/surfaces`,
    selection
  );
  return data;
};

/**
 * GET the thread list of a MAIL channel, newest activity first.
 *
 * Sorted by last activity rather than by the root's creation date — a
 * three-week-old subject someone just replied to is the one you want at the
 * top. `params.before` pages backwards using the cursor the previous response
 * returned as `nextBefore`.
 *
 * Returns `{ threads, nextBefore, canPost, canManage }`.
 */
export const getThreads = async (channelId, { before = null } = {}) => {
  const { data } = await api.get(`/api/chat/channels/${channelId}/threads`, {
    params: before ? { before } : {},
  });
  return data;
};

/** POST a new mail thread. `subject` is required (1–200 chars); mail channels
 *  only, and the server 400s on a chat one rather than inventing a subject. */
export const createThread = async (channelId, payload) => {
  const { data } = await api.post(`/api/chat/channels/${channelId}/threads`, payload);
  return data.message;
};

/** POST — mark one mail thread read. Per THREAD, not per channel: a mailbox is
 *  read one subject at a time, so opening one must not clear the rest. */
export const markThreadRead = async (channelId, threadId) => {
  const { data } = await api.post(
    `/api/chat/channels/${channelId}/threads/${threadId}/read`
  );
  return data;
};

/** POST a file; returns the attachment descriptor the composer embeds. */
export const uploadChatAttachment = async (channelId, file) => {
  const form = new FormData();
  form.append('file', file);
  const { data } = await api.post(
    `/api/chat/channels/${channelId}/attachments`,
    form,
    { headers: { 'Content-Type': 'multipart/form-data' } }
  );
  return data.attachment;
};

/* ------------------------- Reactions, pins, saves ------------------------- */

/**
 * Toggle one emoji on one message. The same call adds or removes — the server
 * decides which, so a double-tap cannot leave the two sides disagreeing.
 * Returns the message's full reactions array.
 */
export const toggleReaction = async (channelId, messageId, emoji) => {
  const { data } = await api.put(
    `/api/chat/channels/${channelId}/messages/${messageId}/reactions`,
    { emoji }
  );
  return data.reactions;
};

/** Pin or unpin a message in its room. Returns the re-populated message. */
export const togglePin = async (channelId, messageId, pinned) => {
  const { data } = await api.put(
    `/api/chat/channels/${channelId}/messages/${messageId}/pin`,
    { pinned }
  );
  return data.message;
};

/** The room's pinned messages, most recently pinned first. */
export const getPins = async (channelId) => {
  const { data } = await api.get(`/api/chat/channels/${channelId}/pins`);
  return data.messages || [];
};

/** Save or unsave a message. Private to the caller — nobody is told. */
export const toggleSave = async (channelId, messageId, saved) => {
  const { data } = await api.put(
    `/api/chat/channels/${channelId}/messages/${messageId}/save`,
    { saved }
  );
  return data.saved;
};

/** Everything the caller set aside, newest-saved first. */
export const getSaved = async () => {
  const { data } = await api.get('/api/chat/saved');
  return data.messages || [];
};

/**
 * Every place someone called your name.
 *
 * `filter` is 'unanswered' (default) or 'all'. `unansweredCount` always
 * reflects the FULL set regardless of the filter, so the badge does not change
 * when you switch tabs.
 */
export const getMentions = async (filter = 'unanswered') => {
  const { data } = await api.get('/api/chat/mentions', { params: { filter } });
  return data;
};

/**
 * Search message HISTORY, not room names.
 *
 * Scoped server-side to the rooms the caller can read, so nothing here can
 * widen it — `channel` narrows the search, and asking for one you cannot read
 * is refused rather than ignored.
 */
export const searchMessages = async (orgId, q, filters = {}) => {
  const { data } = await api.get('/api/chat/search', {
    params: { org: orgId, q, ...filters },
  });
  return data.results || [];
};
