const Notification = require('../models/Notification');
const NotificationPreference = require('../models/NotificationPreference');
const ItemFollow = require('../models/ItemFollow');
const eventBus = require('./eventBus');
const pushService = require('./pushService');
const { resolveNotifLink } = require('../utils/notificationLink');
const { filterUsersWithBoardRead } = require('../utils/boardAudience');

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
  // The 9am digest — one row per morning, so it shares the dueDates toggle:
  // a person who muted due-date nags has muted this too, deliberately.
  dueDigest: 'dueDates',
  taskMoved: 'taskMoves',
  invited: 'invites',
  memberJoined: 'invites',
  goalsDue: 'goals',
  /**
   * The SEO connector's two alerts, and the mapping is the point of them.
   *
   * A type with no row in this table is delivered to everybody, always, whatever
   * their preferences say — which is right for `ownershipTransferred` (who owns
   * your workspace is not a subscription) and catastrophic for a rank tracker,
   * whose entire purpose is noticing that something moved. Left unmapped these
   * two would be exactly the recurring nag with no off switch the `goals`
   * category exists as a warning about.
   */
  seoRankDrop: 'seo',
  seoLostBacklinks: 'seo',
  // A chat @mention is a mention. Same toggle as task-thread mentions — one
  // switch for "people calling my name", wherever they do it.
  chatMention: 'mentions',
  /**
   * A client posting in a client-facing surface is an UPDATE, not a mention —
   * nobody called this person's name, the client just said something.
   *
   * 'updates' is where `commented` and `replied` already live, so it is the
   * toggle a user would look for, and it needs no settings-UI work. Leaving it
   * unmapped would deliver every client message to every team member with board
   * access, always, with nothing to switch off — the exact failure the seo
   * mapping above exists as a warning about, except at conversation volume.
   */
  clientChatMessage: 'updates',
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
 * Categories that push by default, for a user who has granted permission but
 * never opened the per-category switches.
 *
 * The line is "is this ABOUT ME, and does it need me": being assigned work,
 * being called by name, being invited somewhere, something of mine being due,
 * a month closing with numbers missing. Everything else — a status moving, a
 * comment on a board I follow, a card being dragged between groups, a rank
 * shifting — is real information that belongs in the bell and does not belong
 * on a lock screen at 9pm.
 *
 * `isChannelEnabled`'s "missing means yes" is deliberately not reused here:
 * for a channel that interrupts, silence should mean silence.
 */
const PUSH_DEFAULT_ON = new Set([
  'assignments',
  'mentions',
  'invites',
  'dueDates',
  'goals',
]);

const isPushEnabled = (pref, type) => {
  const cat = categoryForType(type);
  // An unmapped type is one of the rare, important ones (ownership changing
  // hands). Those push — same reasoning that has them bypass the other gates.
  if (!cat) return true;
  const chosen = pref?.categories?.[cat]?.push;
  if (typeof chosen === 'boolean') return chosen;
  return PUSH_DEFAULT_ON.has(cat);
};

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
 * A notification carrying a `boardId` is only created if the recipient can READ
 * that board. The message and the populated `board.name` / `task.name` on the
 * SSE frame would otherwise leak the contents of a private board to someone who
 * was never granted access — via assignment, an @mention, a stale follow row, or
 * an automation. `boardAccessChecked` lets a batch caller that already filtered
 * its recipients skip the per-user re-query.
 *
 * @param {Object} args
 * @param {string|ObjectId} args.userId  - recipient user id
 * @param {string}          args.type    - notification type (see Notification enum)
 * @param {string}          args.message - human-readable message shown in the bell
 * @param {string|ObjectId} [args.taskId]
 * @param {string|ObjectId} [args.orgId]
 * @param {string|ObjectId} [args.actorId] - who triggered it (null for system)
 * @param {string|ObjectId} [args.boardId]
 * @param {boolean}         [args.boardAccessChecked] - recipient's board read access already verified
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
  month,
  channelId,
  pref,
  boardAccessChecked = false,
}) => {
  try {
    if (!userId || !type || !message) return null;

    if (boardId && !boardAccessChecked) {
      const allowed = await filterUsersWithBoardRead(boardId, [userId]);
      if (!allowed.has(String(userId))) return null;
    }

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
      month: month || null,
      channel: channelId || null,
      isRead: false,
    });

    // Best-effort real-time delivery, both channels suppressed during DND.
    //
    // The SSE stream reaches a tab that is already open; Web Push reaches a
    // browser that is not. They are deliberately gated together — quiet hours
    // that silence the toast on your desktop but light up your phone would be
    // worse than having no quiet hours at all.
    if (!isInDnd(preference)) {
      try {
        eventBus.emit('notification.created', {
          userId: String(userId),
          notificationId: doc._id,
        });
      } catch (emitErr) {
        // never let a delivery failure break notification creation
      }

      if (isPushEnabled(preference, type)) {
        // Not awaited: a push round-trip to Apple or Google must not sit in
        // front of the request that triggered it. sendToUser never throws.
        pushService
          .sendToUser(userId, {
            title: 'Macan',
            body: message,
            url: resolveNotifLink(doc),
            // Collapse repeats about the same task into one entry rather than
            // stacking five lock-screen rows for five edits of one row.
            tag: doc.task ? `task:${doc.task}` : `notif:${doc._id}`,
            notificationId: String(doc._id),
          })
          .catch(() => {});
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
 *
 * When `boardId` is set, recipients are filtered down to those who can read that
 * board — once, for the whole batch — before any preference work happens.
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
  month,
  channelId,
}) => {
  if (!Array.isArray(userIds) || userIds.length === 0) return [];
  const exclude = excludeUserId ? excludeUserId.toString() : null;
  const seen = new Set();
  let targets = [];
  for (const raw of userIds) {
    if (!raw) continue;
    const id = raw.toString();
    if (exclude && id === exclude) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    targets.push(id);
  }
  if (!targets.length) return [];

  // Drop anyone who cannot read the board this notification is about. One query
  // for the batch; createNotification then trusts the result.
  if (boardId) {
    const allowed = await filterUsersWithBoardRead(boardId, targets);
    targets = targets.filter((id) => allowed.has(id));
    if (!targets.length) return [];
  }

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
        month,
        channelId,
        pref: prefMap.get(uid) || null,
        boardAccessChecked: true,
      })
    )
  );
  return results.filter(Boolean);
};

/**
 * Notify a task's full audience — its assignees plus anyone following (watching)
 * the task — for activity-style events (updates, status changes, moves, due-date
 * changes). De-dup and preference gating are handled by createNotificationsForUsers.
 *
 * `boardId` defaults to the task's own board rather than trusting the caller to
 * pass it: both halves of the audience can outlive board access (an assignment or
 * a follow row survives a revoked grant), so this is exactly the fan-out that must
 * not skip the read-access filter. Personal tasks have no board and stay ungated.
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
  return createNotificationsForUsers({
    boardId: task.isPersonal ? null : task.board || null,
    ...args,
    userIds,
    taskId: task._id,
  });
};

/**
 * Does this preference doc mute email for the given board / actor context?
 * These are email-only kill-switches layered on top of the per-category channel:
 *   - emailMasterOff → mute everything
 *   - mutedBoards    → mute email for events on that board
 *   - mutedActors    → mute email for events triggered by that person
 * A null/absent doc mutes nothing.
 */
const isEmailMuted = (pref, { boardId, actorId } = {}) => {
  if (!pref) return false;
  if (pref.emailMasterOff) return true;
  if (boardId && Array.isArray(pref.mutedBoards)) {
    const b = String(boardId);
    if (pref.mutedBoards.some((id) => String(id) === b)) return true;
  }
  if (actorId && Array.isArray(pref.mutedActors)) {
    const a = String(actorId);
    if (pref.mutedActors.some((id) => String(id) === a)) return true;
  }
  return false;
};

/**
 * Given recipient user ids and a notification type, return the subset whose
 * email channel is enabled for that category, who are not currently in DND, and
 * who have not muted this board or actor. Email trigger sites filter their
 * recipient list through this.
 *
 * @param {Object} [ctx]
 * @param {Date}             [ctx.now]     - reference time for the DND check
 * @param {string|ObjectId}  [ctx.boardId] - board the event happened on (for mutedBoards)
 * @param {string|ObjectId}  [ctx.actorId] - who triggered it (for mutedActors)
 */
const filterByEmailPreference = async (
  userIds,
  type,
  { now, boardId, actorId } = {}
) => {
  const ids = [...new Set((userIds || []).filter(Boolean).map(String))];
  if (!ids.length) return new Set();
  const prefs = await NotificationPreference.find({ user: { $in: ids } });
  const prefMap = new Map(prefs.map((p) => [p.user.toString(), p]));
  const allowed = new Set();
  for (const id of ids) {
    const p = prefMap.get(id) || null;
    if (
      isEmailEnabled(p, type) &&
      !isInDnd(p, now) &&
      !isEmailMuted(p, { boardId, actorId })
    ) {
      allowed.add(id);
    }
  }
  return allowed;
};

module.exports = {
  createNotification,
  createNotificationsForUsers,
  notifyTaskAudience,
  filterByEmailPreference,
  // Exported for tests: the push defaults are the one piece of this file that
  // is duplicated on the client, so they need a tripwire.
  isPushEnabled,
  PUSH_DEFAULT_ON,
};
