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
