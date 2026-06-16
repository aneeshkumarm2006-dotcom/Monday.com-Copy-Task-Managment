const Notification = require('../models/Notification');

/**
 * Create a single Notification record.
 *
 * @param {Object} args
 * @param {string|ObjectId} args.userId  - recipient user id
 * @param {string}          args.type    - 'assigned' | 'commented' | 'statusChanged' | 'dueSoon'
 * @param {string}          args.message - human-readable message shown in the bell dropdown
 * @param {string|ObjectId} [args.taskId] - task this notification is about (optional)
 * @param {string|ObjectId} [args.orgId]  - organisation this notification belongs to.
 *   Omit for personal-task notifications (they're shown across all orgs).
 *
 * Failures are swallowed (logged only) — notifications are best-effort and
 * should never block the triggering action (task assign, comment add, etc.).
 */
const createNotification = async ({ userId, type, message, taskId, orgId, tab }) => {
  try {
    if (!userId || !type || !message) return null;
    const doc = await Notification.create({
      user: userId,
      organisation: orgId || null,
      type,
      message,
      task: taskId || undefined,
      tab: tab || null,
      isRead: false,
    });
    return doc;
  } catch (err) {
    console.error('createNotification error:', err);
    return null;
  }
};

/**
 * Create multiple notifications at once. Accepts an array of recipient user
 * ids and creates one notification per id with the same type/message/task.
 * De-duplicates user ids and skips a single `excludeUserId` (e.g. the actor
 * who triggered the event shouldn't notify themselves).
 */
const createNotificationsForUsers = async ({
  userIds,
  type,
  message,
  taskId,
  orgId,
  excludeUserId,
  tab,
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
  const results = await Promise.all(
    targets.map((uid) =>
      createNotification({ userId: uid, type, message, taskId, orgId, tab })
    )
  );
  return results.filter(Boolean);
};

module.exports = {
  createNotification,
  createNotificationsForUsers,
};
