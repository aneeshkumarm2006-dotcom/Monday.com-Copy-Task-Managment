const eventBus = require('./eventBus');
const Notification = require('../models/Notification');
const portalStream = require('./portalStream');
const {
  PORTAL_MESSAGE_POPULATE,
  serializeMessageForPortal,
} = require('../utils/portalMessage');

/**
 * Server-Sent-Events delivery for notifications.
 *
 * Keeps an in-process registry of open SSE connections keyed by user id, and
 * subscribes ONCE to the `notification.created` event on the shared eventBus.
 * When a notification is created, the matching user's open connections receive
 * the populated notification as a `data:` frame in real time.
 *
 * This rides the existing `app.listen` server (no http.createServer wrap) and
 * adds no new dependency. It assumes a single-process deploy — the registry is
 * in memory, so multi-instance deploys must rely on the client's polling
 * fallback for cross-instance delivery.
 */

const HEARTBEAT_MS = 25000;

// userId (string) -> Set<{ res, orgId }>
const connections = new Map();

let mounted = false;
let heartbeat = null;

/**
 * Register an open SSE response for a user. Returns a cleanup function that
 * removes it from the registry.
 */
const addConnection = (userId, res, orgId) => {
  const key = String(userId);
  let set = connections.get(key);
  if (!set) {
    set = new Set();
    connections.set(key, set);
  }
  const conn = { res, orgId: orgId ? String(orgId) : null };
  set.add(conn);
  return () => {
    const s = connections.get(key);
    if (!s) return;
    s.delete(conn);
    if (s.size === 0) connections.delete(key);
  };
};

const writeEvent = (res, payload) => {
  try {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch (err) {
    // Broken pipe — the 'close' handler will clean the connection up.
  }
};

/**
 * Deliver a freshly-created notification to the recipient's open connections.
 * Mirrors the GET endpoint's org scoping on the wire: a connection viewing org
 * X receives that org's notifications plus org-less (personal) ones; a
 * connection with no active org receives everything.
 */
const handleNotificationCreated = async ({ userId, notificationId } = {}) => {
  try {
    if (!userId || !notificationId) return;
    const key = String(userId);
    const set = connections.get(key);
    if (!set || set.size === 0) return;

    const notif = await Notification.findById(notificationId)
      .populate('actor', 'name profilePic email')
      .populate('board', 'name')
      // Same shape the list endpoint returns — `monthKey` included, so a live
      // notification deep-links to the right month too.
      .populate('task', 'board name parent monthKey');
    if (!notif) return;

    const notifOrg = notif.organisation ? String(notif.organisation) : null;
    for (const conn of set) {
      if (notifOrg === null || conn.orgId === null || conn.orgId === notifOrg) {
        writeEvent(conn.res, { type: 'notification', notification: notif });
      }
    }
  } catch (err) {
    console.error('notificationStream handleNotificationCreated error:', err);
  }
};

/**
 * Deliver a lightweight "board changed" ping to a single user's open
 * connections. Used when a background job (e.g. an automation) mutates a board
 * out-of-band, so the user's board view can refetch. Carries only the boardId —
 * the client decides whether it's viewing that board and refetches if so.
 */
const handleBoardChanged = ({ userId, boardId } = {}) => {
  try {
    if (!userId || !boardId) return;
    const set = connections.get(String(userId));
    if (!set || set.size === 0) return;
    for (const conn of set) {
      writeEvent(conn.res, { type: 'board.changed', boardId: String(boardId) });
    }
  } catch (err) {
    console.error('notificationStream handleBoardChanged error:', err);
  }
};

/**
 * Deliver a freshly-posted chat message to every recipient's open connections.
 * The CONTROLLER computed `recipientIds` (everyone who may see the channel,
 * minus the author) at send time — this handler only addresses envelopes, it
 * never decides who may read one. Org-scoped on the wire like notifications:
 * a connection viewing another workspace doesn't receive this one's chatter.
 */
const handleChatMessage = async ({
  channelId,
  messageId,
  orgId,
  recipientIds,
  recipientContactIds,
} = {}) => {
  try {
    if (!channelId || !messageId) return;

    const users = Array.isArray(recipientIds) ? recipientIds : [];
    const contacts = Array.isArray(recipientContactIds) ? recipientContactIds : [];
    if (!users.length && !contacts.length) return;

    const Message = require('../models/Message');

    // ---- The team's copy -------------------------------------------------
    //
    // Populated the same way the REST endpoints populate. This spec is a
    // DUPLICATE of chatController's MESSAGE_POPULATE and has to stay in step
    // with it: a field added to one and not the other makes a live SSE frame
    // differ from the same message fetched a second later, which shows up as a
    // chip or a name that appears only after a refresh.
    if (users.length) {
      const message = await Message.findById(messageId).populate([
        { path: 'author', select: 'name profilePic email' },
        { path: 'mentions', select: 'name' },
        { path: 'task', select: 'name status board group monthKey parent' },
        { path: 'goal', select: 'name board group monthKey type' },
      ]);
      if (message) {
        const org = orgId ? String(orgId) : null;
        for (const userId of users) {
          const set = connections.get(String(userId));
          if (!set || set.size === 0) continue;
          for (const conn of set) {
            if (org === null || conn.orgId === null || conn.orgId === org) {
              writeEvent(conn.res, {
                type: 'chat.message',
                channelId: String(channelId),
                message,
              });
            }
          }
        }
      }
    }

    // ---- The client's copy, which is a DIFFERENT DOCUMENT -----------------
    //
    // Not the same object with fields removed: a separate populate and a
    // separate builder, because the team's spec selects `author.email` and
    // sending that down a client's socket would hand an outside company every
    // team member's address. See utils/portalMessage.js.
    //
    // Loaded only when somebody is actually listening — the common case is a
    // client with the tab closed, and a second query per message to serve
    // nobody is worth avoiding.
    if (contacts.length && portalStream.hasAnyConnection(contacts)) {
      const forClient = await Message.findById(messageId).populate(
        PORTAL_MESSAGE_POPULATE
      );
      if (forClient) {
        // `mine` is per-reader, so each contact gets their own serialization.
        // Cheap — it is one object build, not a query.
        for (const contactId of contacts) {
          portalStream.sendToContacts([contactId], {
            type: 'chat.message',
            channelId: String(channelId),
            message: serializeMessageForPortal(forClient, { contactId }),
          });
        }
      }
    }
  } catch (err) {
    console.error('notificationStream handleChatMessage error:', err);
  }
};

/**
 * Subscribe to the event bus and start the heartbeat. Idempotent — safe to call
 * once on server boot next to the other mount() calls.
 */
const mount = () => {
  if (mounted) return;
  mounted = true;
  eventBus.on('notification.created', handleNotificationCreated);
  eventBus.on('board.changed', handleBoardChanged);
  eventBus.on('chat.message', handleChatMessage);
  heartbeat = setInterval(() => {
    for (const set of connections.values()) {
      for (const conn of set) {
        try {
          conn.res.write(': ping\n\n');
        } catch (err) {
          // ignore; cleanup handled on connection close
        }
      }
    }
  }, HEARTBEAT_MS);
  if (heartbeat.unref) heartbeat.unref();
};

module.exports = { addConnection, mount };
