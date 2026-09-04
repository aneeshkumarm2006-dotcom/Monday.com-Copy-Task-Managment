/**
 * Server-Sent-Events delivery to CLIENT CONTACTS.
 *
 * The sibling of [notificationStream.js](./notificationStream.js), and
 * deliberately a separate registry rather than extra rows in that one.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT JUST PUT CONTACTS IN THE EXISTING MAP
 * ---------------------------------------------------------------------------
 *
 * `notificationStream.connections` is `Map<userId, Set<conn>>`, keyed by a bare
 * ObjectId string. A `ClientContact` id is a bare ObjectId string too, from a
 * different collection and a different ID SPACE — but the Map cannot tell them
 * apart. Two ids never actually collide (ObjectIds are unique across
 * collections), so nothing would break loudly; what would happen instead is
 * that any future code doing `connections.get(someId)` would be reaching into
 * a namespace holding both kinds of principal, and one careless fan-out would
 * deliver an internal notification down a client's socket. A separate Map makes
 * that mistake unavailable rather than merely unlikely.
 *
 * The second reason is that the payloads differ. A client must receive
 * `serializeMessageForPortal` output, never the team's — see
 * [utils/portalMessage.js](../utils/portalMessage.js).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS NOT
 * ---------------------------------------------------------------------------
 *
 * In-memory and single-process, exactly like its sibling. On a multi-instance
 * deploy a client connected to instance A never sees a message posted through
 * instance B. THE PORTAL'S POLLING IS THEREFORE NOT A FALLBACK, IT IS THE
 * FLOOR — this only makes delivery feel instant when it can. Do not remove the
 * polling on the strength of this file.
 *
 * It also carries no authorisation. `addConnection` is called only after
 * `verifyPortalToken` has succeeded, and the fan-out addresses ids the CALLER
 * derived from `chatAudience`. Nothing here decides who may read anything.
 */

const HEARTBEAT_MS = 25000;

// contactId (string) -> Set<{ res, boardId }>
const connections = new Map();

let heartbeat = null;

/**
 * Register an open SSE response for a contact. Returns a cleanup function.
 *
 * `boardId` is stored so a portal being disabled or its link rotated can drop
 * that board's sockets outright rather than waiting for each client's next
 * request to fail. A long-lived connection is exactly where a kill switch has
 * to reach.
 */
const addConnection = (contactId, res, boardId = null) => {
  const key = String(contactId);
  let set = connections.get(key);
  if (!set) {
    set = new Set();
    connections.set(key, set);
  }
  const conn = { res, boardId: boardId ? String(boardId) : null };
  set.add(conn);
  startHeartbeat();
  return () => {
    const s = connections.get(key);
    if (!s) return;
    s.delete(conn);
    if (s.size === 0) connections.delete(key);
    if (connections.size === 0) stopHeartbeat();
  };
};

const writeEvent = (res, payload) => {
  try {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch (err) {
    // Broken pipe — the 'close' handler cleans the connection up.
  }
};

/** Is any of these contacts currently connected? Lets callers skip work. */
const hasAnyConnection = (contactIds = []) =>
  contactIds.some((id) => (connections.get(String(id))?.size || 0) > 0);

/** Deliver one payload to every open socket of every listed contact. */
const sendToContacts = (contactIds, payload) => {
  if (!Array.isArray(contactIds) || !contactIds.length) return;
  for (const id of contactIds) {
    const set = connections.get(String(id));
    if (!set || set.size === 0) continue;
    for (const conn of set) writeEvent(conn.res, payload);
  }
};

/**
 * Close every socket belonging to a board. Called when a portal is disabled or
 * its link rotated — the same instant those actions stop the next REQUEST, they
 * must stop the open STREAM, or a client keeps receiving messages for as long
 * as they leave the tab open.
 */
const dropBoard = (boardId) => {
  const target = String(boardId);
  for (const [key, set] of connections) {
    for (const conn of [...set]) {
      if (conn.boardId !== target) continue;
      set.delete(conn);
      try {
        conn.res.end();
      } catch (err) {
        // already closed
      }
    }
    if (set.size === 0) connections.delete(key);
  }
  if (connections.size === 0) stopHeartbeat();
};

/**
 * Started on the first connection and stopped on the last, rather than on boot.
 * Most deploys have no client watching at any given moment, and an interval
 * that only exists while somebody is listening is one less thing running
 * forever for nothing.
 */
function startHeartbeat() {
  if (heartbeat) return;
  heartbeat = setInterval(() => {
    for (const set of connections.values()) {
      for (const conn of set) {
        try {
          conn.res.write(': ping\n\n');
        } catch (err) {
          // ignore; cleanup happens on close
        }
      }
    }
  }, HEARTBEAT_MS);
  if (heartbeat.unref) heartbeat.unref();
}

function stopHeartbeat() {
  if (!heartbeat) return;
  clearInterval(heartbeat);
  heartbeat = null;
}

module.exports = {
  addConnection,
  sendToContacts,
  hasAnyConnection,
  dropBoard,
  HEARTBEAT_MS,
};
