import api from './api';

/**
 * GET /api/notifications — a page of notifications for the current user.
 * Returns { notifications, unreadCount, nextCursor }.
 *
 * Options:
 *   org    — scope to an organisation (plus personal-task notifications).
 *   filter — tab: 'all' | 'unread' | 'mentioned' | 'assigned' | 'bookmarked'.
 *   cursor — keyset cursor (the _id of the last item from the previous page).
 *   limit  — page size (server clamps to a max).
 */
export const getNotifications = async (orgId, { filter, cursor, limit } = {}) => {
  const params = {};
  if (orgId) params.org = orgId;
  if (filter && filter !== 'all') params.filter = filter;
  if (cursor) params.cursor = cursor;
  if (limit) params.limit = limit;
  const { data } = await api.get('/api/notifications', {
    params: Object.keys(params).length ? params : undefined,
  });
  return data;
};

/**
 * GET /api/notifications/unread-count — lightweight unread count only.
 * Used by the background poller. Returns { unreadCount }.
 */
export const getUnreadCount = async (orgId) => {
  const params = orgId ? { org: orgId } : undefined;
  const { data } = await api.get('/api/notifications/unread-count', { params });
  return data.unreadCount || 0;
};

/**
 * PUT /api/notifications/:id/read — mark a single notification as read.
 */
export const markAsRead = async (id) => {
  const { data } = await api.put(`/api/notifications/${id}/read`);
  return data.notification;
};

/**
 * PUT /api/notifications/:id/unread — mark a single notification as unread.
 */
export const markAsUnread = async (id) => {
  const { data } = await api.put(`/api/notifications/${id}/unread`);
  return data.notification;
};

/**
 * PUT /api/notifications/:id/bookmark — set the bookmarked flag.
 */
export const toggleBookmark = async (id, value) => {
  const { data } = await api.put(`/api/notifications/${id}/bookmark`, { value });
  return data.notification;
};

/**
 * PUT /api/notifications/read-all — mark every unread notification as read.
 * When `orgId` is supplied, only notifications for that org (plus
 * personal-task notifications) are affected.
 */
export const markAllAsRead = async (orgId) => {
  const params = orgId ? { org: orgId } : undefined;
  const { data } = await api.put('/api/notifications/read-all', null, { params });
  return data;
};

/**
 * DELETE /api/notifications/:id — delete a single notification.
 */
export const deleteNotification = async (id) => {
  const { data } = await api.delete(`/api/notifications/${id}`);
  return data;
};

/**
 * DELETE /api/notifications/clear-read — delete all already-read notifications.
 */
export const clearRead = async (orgId) => {
  const params = orgId ? { org: orgId } : undefined;
  const { data } = await api.delete('/api/notifications/clear-read', { params });
  return data;
};

/**
 * GET /api/notifications/preferences — the current user's notification prefs.
 */
export const getPreferences = async () => {
  const { data } = await api.get('/api/notifications/preferences');
  return data.preferences;
};

/**
 * PUT /api/notifications/preferences — update (partial) notification prefs.
 */
export const updatePreferences = async (prefs) => {
  const { data } = await api.put('/api/notifications/preferences', prefs);
  return data.preferences;
};
