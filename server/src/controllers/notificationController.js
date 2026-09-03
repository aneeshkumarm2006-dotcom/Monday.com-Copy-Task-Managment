const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const Notification = require('../models/Notification');
const NotificationPreference = require('../models/NotificationPreference');
const Task = require('../models/Task');
const Board = require('../models/Board');
const PushSubscription = require('../models/PushSubscription');
const notificationStream = require('../services/notificationStream');
const pushService = require('../services/pushService');

const PREFERENCE_CATEGORIES = [
  'assignments',
  'mentions',
  'statusChanges',
  'updates',
  'dueDates',
  'taskMoves',
  'invites',
  /**
   * `goals` and `seo` are both on `NotificationPreference.categories` and both
   * belong here, because this list is the WRITE allowlist: a category missing
   * from it is a switch the settings page renders and the server silently
   * discards.
   */
  'goals',
  'seo',
];

const clampMinute = (v) => Math.min(Math.max(parseInt(v, 10) || 0, 0), 1439);

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const DUE_SOON_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Build the base org-scoping filter shared by every notification query:
 * always the current user, plus — when an org is supplied — that org's
 * notifications together with organisation-less personal-task notifications.
 *
 * This base filter is the ONLY thing the unread count is derived from, so the
 * bell badge always reflects the org-wide unread total, never the active tab
 * or pagination window.
 */
const buildBaseFilter = (userId, orgId) => {
  const filter = { user: userId };
  if (orgId && mongoose.Types.ObjectId.isValid(orgId)) {
    filter.$or = [
      { organisation: new mongoose.Types.ObjectId(orgId) },
      { organisation: null },
      { organisation: { $exists: false } },
    ];
  }
  return filter;
};

/**
 * Apply a UI filter tab to a base filter. Returns a new object so the base
 * filter (used for the unread count) is never mutated.
 *   all       → no extra constraint
 *   unread    → isRead:false
 *   mentioned → type:'mentioned'
 *   assigned  → type:'assigned'
 *   bookmarked→ bookmarked:true
 */
const applyTabFilter = (baseFilter, filter) => {
  const f = { ...baseFilter };
  switch (filter) {
    case 'unread':
      f.isRead = false;
      break;
    case 'mentioned':
      f.type = 'mentioned';
      break;
    case 'assigned':
      f.type = 'assigned';
      break;
    case 'bookmarked':
      f.bookmarked = true;
      break;
    default:
      break;
  }
  return f;
};

/**
 * Scan for tasks assigned to the given user whose due date lands inside the
 * next 24 hours and create a `dueSoon` notification for each task that
 * doesn't already have one. Personal tasks created by the user are also
 * included.
 *
 * This runs on the FIRST page of GET /api/notifications (poll-based, no cron).
 * Failures are swallowed so they never break the list fetch.
 *
 * Board-task dueSoon notifications are stamped with the board's organisation
 * (and board id) so they only appear in that org's notification bell. Personal-
 * task dueSoon notifications keep `organisation: null` and show in every org.
 */
const ensureDueSoonNotifications = async (userId) => {
  try {
    const now = new Date();
    const soon = new Date(now.getTime() + DUE_SOON_WINDOW_MS);
    const userObjectId = new mongoose.Types.ObjectId(userId);

    const dueTasks = await Task.find({
      dueDate: { $gte: now, $lte: soon },
      $or: [
        { assignedTo: userObjectId },
        { isPersonal: true, createdBy: userObjectId },
      ],
    }).select('_id name dueDate board isPersonal');

    if (!dueTasks.length) return;

    const taskIds = dueTasks.map((t) => t._id);
    const existing = await Notification.find({
      user: userObjectId,
      type: 'dueSoon',
      task: { $in: taskIds },
    }).select('task');
    const existingSet = new Set(existing.map((n) => n.task.toString()));

    const missing = dueTasks.filter((t) => !existingSet.has(t._id.toString()));
    if (!missing.length) return;

    // Bulk-resolve org id per board for the missing board tasks.
    const boardIds = [
      ...new Set(
        missing
          .filter((t) => !t.isPersonal && t.board)
          .map((t) => t.board.toString())
      ),
    ];
    const boardOrgMap = new Map();
    if (boardIds.length) {
      const boards = await Board.find({ _id: { $in: boardIds } }).select(
        'organisation'
      );
      boards.forEach((b) => {
        boardOrgMap.set(b._id.toString(), b.organisation || null);
      });
    }

    const toCreate = missing.map((t) => ({
      user: userObjectId,
      actor: null,
      organisation: t.isPersonal
        ? null
        : boardOrgMap.get(t.board?.toString()) || null,
      type: 'dueSoon',
      message: `"${t.name}" is due soon`,
      task: t._id,
      board: t.isPersonal ? null : t.board || null,
      isRead: false,
    }));

    if (toCreate.length) {
      await Notification.insertMany(toCreate);
    }
  } catch (err) {
    console.error('ensureDueSoonNotifications error:', err);
  }
};

/**
 * GET /api/notifications?org=<orgId>&filter=<tab>&cursor=<id>&limit=<n>
 *
 * Return a page of notifications for the current user, newest first.
 *
 * - `filter` selects a tab: all | unread | mentioned | assigned | bookmarked.
 * - Pagination is keyset on `_id` (a time-ordered, unique ObjectId) rather than
 *   createdAt — batch inserts (insertMany / Promise.all fan-out) share the same
 *   millisecond and would otherwise skip or duplicate rows at page boundaries.
 * - `unreadCount` is always computed from the org-wide base filter, independent
 *   of the active tab/cursor, so the bell badge stays correct.
 * - The inline due-soon scan only runs on the first page (no cursor).
 */
const getNotifications = async (req, res) => {
  try {
    const userId = req.user.userId;
    const orgId = (req.query.org || '').toString().trim();
    const filter = (req.query.filter || 'all').toString().trim();
    const cursor = (req.query.cursor || '').toString().trim();
    const rawLimit = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(rawLimit, 1), MAX_LIMIT)
      : DEFAULT_LIMIT;

    if (!cursor) {
      await ensureDueSoonNotifications(userId);
    }

    const baseFilter = buildBaseFilter(userId, orgId);
    const listFilter = applyTabFilter(baseFilter, filter);
    if (cursor && mongoose.Types.ObjectId.isValid(cursor)) {
      listFilter._id = { $lt: new mongoose.Types.ObjectId(cursor) };
    }

    // Fetch one extra row to know whether another page exists.
    const docs = await Notification.find(listFilter)
      .sort({ _id: -1 })
      .limit(limit + 1)
      .populate('actor', 'name profilePic email')
      .populate('board', 'name')
      // `monthKey` rides along so the click can deep-link to the month that
      // actually holds the task — a tracker board shows one month at a time.
      .populate('task', 'board name parent monthKey');

    let nextCursor = null;
    if (docs.length > limit) {
      docs.length = limit; // trim the lookahead row
      nextCursor = docs[docs.length - 1]._id;
    }

    const unreadCount = await Notification.countDocuments({
      ...baseFilter,
      isRead: false,
    });

    return res.json({ notifications: docs, unreadCount, nextCursor });
  } catch (err) {
    console.error('getNotifications error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * GET /api/notifications/unread-count?org=<orgId>
 *
 * Lightweight unread-count-only endpoint — the smart-poll target. A single
 * indexed countDocuments against the org-wide base filter.
 */
const getUnreadCount = async (req, res) => {
  try {
    const userId = req.user.userId;
    const orgId = (req.query.org || '').toString().trim();
    const baseFilter = buildBaseFilter(userId, orgId);
    const unreadCount = await Notification.countDocuments({
      ...baseFilter,
      isRead: false,
    });
    return res.json({ unreadCount });
  } catch (err) {
    console.error('getUnreadCount error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * PUT /api/notifications/:id/read
 *
 * Mark one notification as read. Must belong to the current user.
 */
const markAsRead = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid notification id' });
    }

    const notif = await Notification.findOne({ _id: id, user: userId });
    if (!notif) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    notif.isRead = true;
    notif.readAt = new Date();
    await notif.save();
    return res.json({ notification: notif });
  } catch (err) {
    console.error('markAsRead error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * PUT /api/notifications/:id/unread
 *
 * Mark one notification as unread (clears readAt). Must belong to the current
 * user. Monday has no per-item mark-unread — this is a deliberate improvement.
 */
const markAsUnread = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid notification id' });
    }

    const notif = await Notification.findOne({ _id: id, user: userId });
    if (!notif) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    notif.isRead = false;
    notif.readAt = null;
    await notif.save();
    return res.json({ notification: notif });
  } catch (err) {
    console.error('markAsUnread error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * PUT /api/notifications/:id/bookmark  body: { value: boolean }
 *
 * Set the bookmarked (starred) flag on a notification. Must belong to the
 * current user.
 */
const toggleBookmark = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    const value = !!req.body.value;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid notification id' });
    }

    const notif = await Notification.findOne({ _id: id, user: userId });
    if (!notif) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    notif.bookmarked = value;
    await notif.save();
    return res.json({ notification: notif });
  } catch (err) {
    console.error('toggleBookmark error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * PUT /api/notifications/read-all?org=<orgId>
 *
 * Bulk mark every unread notification for the current user as read. Scoped to
 * the org-wide base filter so the bell stays consistent with the GET endpoint.
 */
const markAllAsRead = async (req, res) => {
  try {
    const userId = req.user.userId;
    const orgId = (req.query.org || '').toString().trim();
    const baseFilter = buildBaseFilter(userId, orgId);

    const result = await Notification.updateMany(
      { ...baseFilter, isRead: false },
      { $set: { isRead: true, readAt: new Date() } }
    );
    return res.json({ success: true, updated: result.modifiedCount });
  } catch (err) {
    console.error('markAllAsRead error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * DELETE /api/notifications/:id
 *
 * Delete a single notification. Must belong to the current user.
 */
const deleteNotification = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid notification id' });
    }

    const result = await Notification.deleteOne({ _id: id, user: userId });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Notification not found' });
    }
    return res.json({ success: true });
  } catch (err) {
    console.error('deleteNotification error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * DELETE /api/notifications/clear-read?org=<orgId>
 *
 * Bulk delete every already-read notification for the current user, scoped to
 * the org-wide base filter. Unread notifications are kept.
 */
const clearRead = async (req, res) => {
  try {
    const userId = req.user.userId;
    const orgId = (req.query.org || '').toString().trim();
    const baseFilter = buildBaseFilter(userId, orgId);

    const result = await Notification.deleteMany({
      ...baseFilter,
      isRead: true,
    });
    return res.json({ success: true, deleted: result.deletedCount });
  } catch (err) {
    console.error('clearRead error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * GET /api/notifications/stream?token=<jwt>&org=<orgId>
 *
 * Server-Sent-Events stream of new notifications for the current user.
 * EventSource cannot set an Authorization header, so the JWT is passed as a
 * query param and verified inline here (mirroring middleware/auth.js). This
 * route is registered BEFORE the bearer auth middleware for that reason.
 */
const streamNotifications = (req, res) => {
  const token = (req.query.token || '').toString();
  let userId;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    userId = decoded.userId;
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const orgId = (req.query.org || '').toString().trim() || null;

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (res.flushHeaders) res.flushHeaders();
  res.write(': connected\n\n');

  const cleanup = notificationStream.addConnection(userId, res, orgId);
  req.on('close', () => {
    cleanup();
    try {
      res.end();
    } catch (err) {
      // already closed
    }
  });

  return undefined;
};

/**
 * GET /api/notifications/preferences
 *
 * Return the current user's notification preferences, creating a defaults
 * document on first access so the client always gets a consistent shape.
 */
const getPreferences = async (req, res) => {
  try {
    const userId = req.user.userId;
    const pref = await NotificationPreference.findOneAndUpdate(
      { user: userId },
      { $setOnInsert: { user: userId } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    return res.json({ preferences: pref });
  } catch (err) {
    console.error('getPreferences error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * PUT /api/notifications/preferences
 *
 * Update (upsert) the current user's notification preferences. Accepts a
 * partial body: { categories: { <cat>: { inApp, email } }, dnd: { enabled,
 * startMinute, endMinute } }. Unknown keys are ignored.
 */
const updatePreferences = async (req, res) => {
  try {
    const userId = req.user.userId;
    const body = req.body || {};
    const update = {};

    if (body.categories && typeof body.categories === 'object') {
      for (const cat of PREFERENCE_CATEGORIES) {
        const c = body.categories[cat];
        if (c && typeof c === 'object') {
          if (typeof c.inApp === 'boolean') {
            update[`categories.${cat}.inApp`] = c.inApp;
          }
          if (typeof c.email === 'boolean') {
            update[`categories.${cat}.email`] = c.email;
          }
          // `null` is meaningful for push — it means "never chosen", which
          // hands the decision back to PUSH_DEFAULT_ON. So unlike the other
          // two, this accepts a null as well as a boolean.
          if (typeof c.push === 'boolean' || c.push === null) {
            update[`categories.${cat}.push`] = c.push;
          }
        }
      }
    }

    if (body.dnd && typeof body.dnd === 'object') {
      if (typeof body.dnd.enabled === 'boolean') {
        update['dnd.enabled'] = body.dnd.enabled;
      }
      if (body.dnd.startMinute !== undefined) {
        update['dnd.startMinute'] = clampMinute(body.dnd.startMinute);
      }
      if (body.dnd.endMinute !== undefined) {
        update['dnd.endMinute'] = clampMinute(body.dnd.endMinute);
      }
    }

    // ---- Email mute switches (email-only) ----
    if (typeof body.emailMasterOff === 'boolean') {
      update.emailMasterOff = body.emailMasterOff;
    }
    // mutedBoards / mutedActors are full-replacement arrays of ObjectId strings.
    // Keep only valid, unique ids so a malformed body can't corrupt the doc.
    if (Array.isArray(body.mutedBoards)) {
      update.mutedBoards = [...new Set(body.mutedBoards.map(String))].filter(
        (id) => mongoose.Types.ObjectId.isValid(id)
      );
    }
    if (Array.isArray(body.mutedActors)) {
      update.mutedActors = [...new Set(body.mutedActors.map(String))].filter(
        (id) => mongoose.Types.ObjectId.isValid(id)
      );
    }

    const pref = await NotificationPreference.findOneAndUpdate(
      { user: userId },
      { $set: update, $setOnInsert: { user: userId } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    return res.json({ preferences: pref });
  } catch (err) {
    console.error('updatePreferences error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/* --------------------------- Web Push subscriptions --------------------------- */

/**
 * GET /api/notifications/push/key
 *
 * The VAPID public key the browser needs in order to subscribe, plus whether
 * push is configured at all. The client asks BEFORE showing any "turn on
 * notifications" affordance — offering a button that cannot work, and burning
 * the one permission prompt the browser will ever grant us, is worse than
 * showing nothing.
 */
const getPushKey = async (req, res) => {
  return res.json({
    enabled: pushService.isConfigured,
    publicKey: pushService.getPublicKey(),
  });
};

/**
 * POST /api/notifications/push/subscribe
 *
 * Upserts on `endpoint`, not on user: one browser is one row, and the row's
 * `user` is overwritten so a shared machine (or a sign-out and back in as
 * somebody else) stops delivering the previous person's notifications to it.
 */
const subscribePush = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { endpoint, keys, deviceLabel } = req.body || {};

    if (
      typeof endpoint !== 'string' ||
      !endpoint.startsWith('https://') ||
      !keys ||
      typeof keys.p256dh !== 'string' ||
      typeof keys.auth !== 'string'
    ) {
      return res.status(400).json({ error: 'Invalid subscription' });
    }

    const sub = await PushSubscription.findOneAndUpdate(
      { endpoint },
      {
        user: userId,
        endpoint,
        keys: { p256dh: keys.p256dh, auth: keys.auth },
        deviceLabel: typeof deviceLabel === 'string' ? deviceLabel.slice(0, 120) : '',
        lastUsedAt: new Date(),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return res.status(201).json({ subscription: { _id: sub._id } });
  } catch (err) {
    console.error('subscribePush error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * DELETE /api/notifications/push/subscribe
 *
 * Scoped to the caller: you can only delete a subscription that is currently
 * yours, so knowing somebody else's endpoint is not enough to silence them.
 */
const unsubscribePush = async (req, res) => {
  try {
    const userId = req.user.userId;
    const endpoint = req.body?.endpoint;
    if (typeof endpoint !== 'string') {
      return res.status(400).json({ error: 'Endpoint required' });
    }
    await PushSubscription.deleteOne({ endpoint, user: userId });
    return res.json({ ok: true });
  } catch (err) {
    console.error('unsubscribePush error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

module.exports = {
  getPushKey,
  subscribePush,
  unsubscribePush,
  getNotifications,
  getUnreadCount,
  streamNotifications,
  markAsRead,
  markAsUnread,
  toggleBookmark,
  markAllAsRead,
  deleteNotification,
  clearRead,
  getPreferences,
  updatePreferences,
};
