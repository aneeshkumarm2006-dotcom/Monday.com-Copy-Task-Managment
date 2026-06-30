const Notification = require('../models/Notification');
const NotificationPreference = require('../models/NotificationPreference');
const ItemFollow = require('../models/ItemFollow');
const eventBus = require('./eventBus');

/**
 * Map a notification `type` to its preference category. Types with no mapping
 * are always delivered (never gated).
 */
const TYPE_CATEGORY = {
  assigned: 'assignments',
  unassigned: 'assignments',
  mentioned: 'mentions',
  statusChanged: 'statusChanges',
  commented: 'updates',
  replied: 'updates',
  dueSoon: 'dueDates',
  dueDateChanged: 'dueDates',
  taskMoved: 'taskMoves',
  invited: 'invites',
  memberJoined: 'invites',
};

const categoryForType = (type) => TYPE_CATEGORY[type] || null;

const isChannelEnabled = (pref, type, channel) => {
  if (!pref) return true;
  const cat = categoryForType(type);
  if (!cat) return true;
  const c = pref.categories?.[cat];
  if (!c) return true;
  return c[channel] !== false;
};

const isInAppEnabled = (pref, type) => isChannelEnabled(pref, type, 'inApp');
const isEmailEnabled = (pref, type) => isChannelEnabled(pref, type, 'email');

/**
 * Is `now` inside the user's Do-Not-Disturb window? DND is stored as minutes
 * from midnight (server-local); end < start denotes an overnight window.
 */
const isInDnd = (pref, now = new Date()) => {
  if (!pref?.dnd?.enabled) return false;
  const { startMinute, endMinute } = pref.dnd;
  if (startMinute == null || endMinute == null || startMinute === endMinute) {
    return false;
  }
  const mins = now.getHours() * 60 + now.getMinutes();
  if (startMinute < endMinute) return mins >= startMinute && mins < endMinute;
  return mins >= startMinute || mins < endMinute; // overnight
};

/**
 * Create a single Notification record, gated by the recipient's preferences.
 *
 * - If the recipient disabled this category's in-app channel, nothing is
 *   created (returns null).
 * - The doc is always recorded if in-app is on, but real-time delivery (the
 *   `notification.created` event → SSE push / toast) is suppressed while the
 *   recipient is in their DND window.
 *
 * Pass `pref` to reuse a preference doc already loaded by the caller (batch
 * fan-out); otherwise it is looked up here. Failures are swallowed — best-effort
 * so a notification never blocks the triggering action.
 *
 * @param {Object} args
 * @param {string|ObjectId} args.userId  - recipient user id
 * @param {string}          args.type    - notification type (see Notification enum)
 * @param {string}          args.message - human-readable message shown in the bell
 * @param {string|ObjectId} [args.taskId]
 * @param {string|ObjectId} [args.orgId]
 * @param {string|ObjectId} [args.actorId] - who triggered it (null for system)
 * @param {string|ObjectId} [args.boardId]
 */
const createNotification = async ({
  userId,
  type,
  message,
  taskId,
  orgId,
  tab,
  actorId,
  boardId,
  pref,
}) => {
  try {
    if (!userId || !type || !message) return null;
    const preference =
      pref !== undefined
        ? pref
        : await NotificationPreference.findOne({ user: userId });

    if (!isInAppEnabled(preference, type)) return null;

    const doc = await Notification.create({
      user: userId,
      actor: actorId || null,
      organisation: orgId || null,
      type,
      message,
      task: taskId || undefined,
      board: boardId || null,
      tab: tab || null,
      isRead: false,
    });

    // Best-effort real-time push (suppressed during DND). The SSE stream service
    // loads + populates the doc and delivers it to the recipient's connections.
    if (!isInDnd(preference)) {
      try {
        eventBus.emit('notification.created', {
          userId: String(userId),
          notificationId: doc._id,
        });
      } catch (emitErr) {
        // never let a delivery failure break notification creation
      }
    }
    return doc;
  } catch (err) {
    console.error('createNotification error:', err);
    return null;
  }
};

/**
 * Create multiple notifications at once. De-duplicates user ids, skips a single
 * `excludeUserId` (the actor), and batch-loads recipient preferences once so the
 * per-recipient gating in createNotification doesn't issue N queries.
 */
const createNotificationsForUsers = async ({
  userIds,
  type,
  message,
  taskId,
  orgId,
  excludeUserId,
  tab,
  actorId,
  boardId,
}) => {
  if (!Array.isArray(userIds) || userIds.length === 0) return [];
  const exclude = excludeUserId ? excludeUserId.toString() : null;
  const seen = new Set();
  const targets = [];
  for (const raw of userIds) {
    if (!raw) continue;
    const id = raw.toString();
    if (exclude && id === exclude) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    targets.push(id);
  }
  if (!targets.length) return [];

  const prefs = await NotificationPreference.find({ user: { $in: targets } });
  const prefMap = new Map(prefs.map((p) => [p.user.toString(), p]));

  const results = await Promise.all(
    targets.map((uid) =>
      createNotification({
        userId: uid,
        type,
        message,
        taskId,
        orgId,
        tab,
        actorId,
        boardId,
        pref: prefMap.get(uid) || null,
      })
    )
  );
  return results.filter(Boolean);
};

/**
 * Notify a task's full audience — its assignees plus anyone following (watching)
 * the task — for activity-style events (updates, status changes, moves, due-date
 * changes). De-dup and preference gating are handled by createNotificationsForUsers.
 */
const notifyTaskAudience = async (task, args) => {
  if (!task) return [];
  let followerIds = [];
  try {
    const follows = await ItemFollow.find({ task: task._id }).select('user');
    followerIds = follows.map((f) => f.user);
  } catch (err) {
    console.error('notifyTaskAudience follow lookup error:', err);
  }
  const userIds = [...(task.assignedTo || []), ...followerIds];
  return createNotificationsForUsers({ ...args, userIds, taskId: task._id });
};

/**
 * Given recipient user ids and a notification type, return the subset whose
 * email channel is enabled for that category AND who are not currently in DND.
 * Email trigger sites filter their recipient list through this.
 */
const filterByEmailPreference = async (userIds, type, { now } = {}) => {
  const ids = [...new Set((userIds || []).filter(Boolean).map(String))];
  if (!ids.length) return new Set();
  const prefs = await NotificationPreference.find({ user: { $in: ids } });
  const prefMap = new Map(prefs.map((p) => [p.user.toString(), p]));
  const allowed = new Set();
  for (const id of ids) {
    const p = prefMap.get(id) || null;
    if (isEmailEnabled(p, type) && !isInDnd(p, now)) allowed.add(id);
  }
  return allowed;
};

module.exports = {
  createNotification,
  createNotificationsForUsers,
  notifyTaskAudience,
  filterByEmailPreference,
};
