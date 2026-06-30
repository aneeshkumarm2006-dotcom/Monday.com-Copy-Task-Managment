import { create } from 'zustand';
import * as notificationService from '../services/notificationService';

const PANEL_CAP = 50; // max notifications held in memory for the bell panel

/**
 * Does a notification belong in the currently active filter tab? Used when a
 * real-time push arrives so we only splice it into the list when the user is
 * looking at a tab that would include it.
 */
const matchesFilter = (notif, filter) => {
  switch (filter) {
    case 'unread':
      return !notif.isRead;
    case 'mentioned':
      return notif.type === 'mentioned';
    case 'assigned':
      return notif.type === 'assigned';
    case 'bookmarked':
      return !!notif.bookmarked;
    default:
      return true;
  }
};

/**
 * useNotificationStore — the current user's in-app notifications.
 *
 * Freshness comes from: fetch-on-load / org-change (App.jsx), the background
 * poller (useNotificationPoll) hitting the unread-count endpoint, and the SSE
 * stream (useNotificationStream) calling `pushNotification` directly.
 */
const useNotificationStore = create((set, get) => ({
  notifications: [],
  unreadCount: 0,
  filter: 'all', // all | unread | mentioned | assigned | bookmarked
  nextCursor: null,
  loading: false,
  loadingMore: false,
  stale: false, // poller noticed the server count changed since last fetch
  error: null,

  /**
   * Pull the first page of notifications + unread count, scoped to the org.
   *
   * Backward-compatible: legacy callers invoke this with just an orgId (or no
   * args). When `filter` is omitted it falls back to the active tab so a plain
   * refresh never silently flips the user's open tab.
   */
  fetchNotifications: async (orgId, { filter } = {}) => {
    const activeFilter = filter || get().filter;
    set({ loading: true, error: null, filter: activeFilter });
    try {
      const { notifications, unreadCount, nextCursor } =
        await notificationService.getNotifications(orgId, {
          filter: activeFilter,
        });
      set({
        notifications: notifications || [],
        unreadCount: unreadCount || 0,
        nextCursor: nextCursor || null,
        loading: false,
        stale: false,
      });
    } catch (err) {
      set({ loading: false, error: err });
    }
  },

  /**
   * Append the next page (keyset pagination). No-op when there's nothing more.
   */
  fetchMore: async (orgId) => {
    const { nextCursor, loadingMore, filter, notifications } = get();
    if (!nextCursor || loadingMore) return;
    set({ loadingMore: true });
    try {
      const res = await notificationService.getNotifications(orgId, {
        filter,
        cursor: nextCursor,
      });
      // Dedupe in case a push slipped a row in while paginating.
      const seen = new Set(notifications.map((n) => n._id));
      const fresh = (res.notifications || []).filter((n) => !seen.has(n._id));
      set({
        notifications: [...notifications, ...fresh],
        nextCursor: res.nextCursor || null,
        unreadCount: res.unreadCount ?? get().unreadCount,
        loadingMore: false,
      });
    } catch (err) {
      set({ loadingMore: false, error: err });
    }
  },

  /**
   * Switch the active filter tab and reload the first page.
   */
  setFilter: (orgId, filter) => {
    if (get().filter === filter) return;
    get().fetchNotifications(orgId, { filter });
  },

  /**
   * Refresh just the unread count (cheap; used by the background poller). When
   * the count changed from what we hold, flag the list stale so the next panel
   * open refetches.
   */
  refreshUnreadCount: async (orgId) => {
    try {
      const count = await notificationService.getUnreadCount(orgId);
      const changed = count !== get().unreadCount;
      set({ unreadCount: count, stale: get().stale || changed });
      return changed;
    } catch {
      return false;
    }
  },

  /**
   * Splice a pushed notification (from the SSE stream) into the list. Always
   * bumps the unread count; only inserts into the visible list when it matches
   * the active tab. Deduped by _id.
   */
  pushNotification: (notif) => {
    if (!notif || !notif._id) return;
    const { notifications, filter, unreadCount } = get();
    if (notifications.some((n) => n._id === notif._id)) return;
    const nextUnread = notif.isRead ? unreadCount : unreadCount + 1;
    if (matchesFilter(notif, filter)) {
      set({
        notifications: [notif, ...notifications].slice(0, PANEL_CAP),
        unreadCount: nextUnread,
      });
    } else {
      set({ unreadCount: nextUnread });
    }
  },

  /**
   * Optimistically mark a single notification as read, then sync. Rolls back on
   * failure. The row stays in the list (just restyled), matching monday.
   */
  markRead: async (id) => {
    const prev = get().notifications;
    const prevUnread = get().unreadCount;
    const target = prev.find((n) => n._id === id);
    if (!target || target.isRead) return;
    set({
      notifications: prev.map((n) =>
        n._id === id ? { ...n, isRead: true, readAt: new Date().toISOString() } : n
      ),
      unreadCount: Math.max(0, prevUnread - 1),
    });
    try {
      await notificationService.markAsRead(id);
    } catch (err) {
      set({ notifications: prev, unreadCount: prevUnread });
      throw err;
    }
  },

  /**
   * Optimistically mark a single notification as unread, then sync.
   */
  markUnread: async (id) => {
    const prev = get().notifications;
    const prevUnread = get().unreadCount;
    const target = prev.find((n) => n._id === id);
    if (!target || !target.isRead) return;
    set({
      notifications: prev.map((n) =>
        n._id === id ? { ...n, isRead: false, readAt: null } : n
      ),
      unreadCount: prevUnread + 1,
    });
    try {
      await notificationService.markAsUnread(id);
    } catch (err) {
      set({ notifications: prev, unreadCount: prevUnread });
      throw err;
    }
  },

  /**
   * Optimistically toggle the bookmark flag, then sync. On the Bookmarked tab,
   * un-bookmarking removes the row from view.
   */
  toggleBookmark: async (id) => {
    const prev = get().notifications;
    const filter = get().filter;
    const target = prev.find((n) => n._id === id);
    if (!target) return;
    const nextValue = !target.bookmarked;
    let optimistic = prev.map((n) =>
      n._id === id ? { ...n, bookmarked: nextValue } : n
    );
    if (filter === 'bookmarked' && !nextValue) {
      optimistic = optimistic.filter((n) => n._id !== id);
    }
    set({ notifications: optimistic });
    try {
      await notificationService.toggleBookmark(id, nextValue);
    } catch (err) {
      set({ notifications: prev });
      throw err;
    }
  },

  /**
   * Optimistically mark every unread notification as read.
   */
  markAllRead: async (orgId) => {
    const prev = get().notifications;
    const prevUnread = get().unreadCount;
    if (prevUnread === 0) return;
    set({
      notifications: prev.map((n) =>
        n.isRead ? n : { ...n, isRead: true, readAt: new Date().toISOString() }
      ),
      unreadCount: 0,
    });
    try {
      await notificationService.markAllAsRead(orgId);
    } catch (err) {
      set({ notifications: prev, unreadCount: prevUnread });
      throw err;
    }
  },

  /**
   * Optimistically remove a notification, then sync. Rolls back on failure.
   */
  deleteNotification: async (id) => {
    const prev = get().notifications;
    const prevUnread = get().unreadCount;
    const target = prev.find((n) => n._id === id);
    set({
      notifications: prev.filter((n) => n._id !== id),
      unreadCount:
        target && !target.isRead ? Math.max(0, prevUnread - 1) : prevUnread,
    });
    try {
      await notificationService.deleteNotification(id);
    } catch (err) {
      set({ notifications: prev, unreadCount: prevUnread });
      throw err;
    }
  },

  /**
   * Delete all already-read notifications (optimistic).
   */
  clearRead: async (orgId) => {
    const prev = get().notifications;
    set({ notifications: prev.filter((n) => !n.isRead) });
    try {
      await notificationService.clearRead(orgId);
    } catch (err) {
      set({ notifications: prev });
      throw err;
    }
  },

  clear: () =>
    set({
      notifications: [],
      unreadCount: 0,
      nextCursor: null,
      filter: 'all',
      stale: false,
      error: null,
    }),
}));

export default useNotificationStore;
