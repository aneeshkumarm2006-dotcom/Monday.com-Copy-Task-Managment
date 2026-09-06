const mongoose = require('mongoose');
const Channel = require('../models/Channel');
const Message = require('../models/Message');
const { channelReadMap, threadReadMap } = require('./chatRead');

/**
 * How many unread messages a client contact has, across many channels.
 *
 * ---- WHY THIS EXISTS -------------------------------------------------------
 *
 * `getPortalChannels` used to do `Promise.all(channels.map(countDocuments))` —
 * one query per channel. That cost nothing while the (now removed) portal tier
 * meant no board had any client channels at all, so the loop ran zero times. The
 * moment every service gets a chat and a mailbox by default, a four-service
 * client makes that eight queries on the portal's hottest path, and the home
 * screen would make eight more.
 *
 * One `$or` over the channel ids replaces all of it. The clause list is bounded
 * by the number of services on one board, and every clause is served by
 * Message's existing `{ channel: 1, createdAt: -1 }` index.
 *
 * ---- THE READ MODEL, IN ONE PLACE ------------------------------------------
 *
 * A surface's unread count is computed from THE MARKER THAT SURFACE IS ACTUALLY
 * READ WITH, and the two surfaces are not read the same way:
 *
 *   chat  — you read a ROOM. `ChannelContactRead` (via `channelReadMap`) is the
 *           cursor: everything newer than it, in that channel, is unread.
 *   mail  — you read a THREAD. `MailThreadRead` (via `threadReadMap`) is the
 *           cursor, one per conversation, and the CHANNEL marker is not
 *           consulted at all. A mailbox's unread is therefore assembled from its
 *           threads: a thread counts when it holds a message this contact has
 *           not seen, which is exactly the rule the mailbox list itself uses to
 *           put the dot on a row (`serializeThreadRow`).
 *
 * That split is the whole fix for the badge that never cleared. Reading mail
 * writes `MailThreadRead` and nothing else, so a mailbox scored against the
 * channel marker stayed permanently at its opening backlog; and conversely a
 * client who merely POSTED once had the channel marker dragged to now, which
 * zeroed a mailbox full of conversations they had never opened.
 *
 * The channel marker is still written on a mail send — see `writeClientMessage`
 * — but only as a PRESENCE stamp for `portalNotify`. Nothing here reads it for a
 * mailbox.
 *
 * ---- WHAT COUNTS AS UNREAD -------------------------------------------------
 *
 * Newer than the relevant marker, and NOT WRITTEN BY THIS CONTACT. Posting is
 * reading: a client who sends a message must not come back to find their own
 * message counted against them. A channel or thread with no marker counts
 * everything, which is correct for a room or a conversation they have never
 * opened.
 *
 * ---- TWO NUMBERS, AND WHICH ONE TO USE -------------------------------------
 *
 * `unread` counts MESSAGES; `unreadThreads` counts CONVERSATIONS. A mail caller
 * wants the second — a mailbox badge showing "4 messages" over two conversations
 * is the wrong number, and it can never reach zero when the UI clears it one
 * thread at a time. Every mail caller therefore reads `unreadThreads`
 * (`getPortalChannels`, `getPortalHome`, `portalDigestRunner`); chat callers read
 * `unread` and ignore the other.
 */

/**
 * `Model.aggregate` does NO schema casting — a `$match` compares raw BSON. Every
 * id that goes into a pipeline is therefore cast here: `req.portal.contactId` is
 * a STRING (see middleware/portalAuth.js), and a string is never `$eq` an
 * ObjectId, so `portalAuthor: { $ne: contactId }` used to exclude nothing at all
 * and each caller's numbers depended on which type it happened to hold.
 */
const asObjectId = (value) => {
  if (value instanceof mongoose.Types.ObjectId) return value;
  const raw = String(value || '');
  return mongoose.Types.ObjectId.isValid(raw) ? new mongoose.Types.ObjectId(raw) : null;
};

/** `{ unread, unreadThreads, lastAt }`, created on demand. */
const slotFor = (map, key) => {
  if (!map.has(key)) map.set(key, { unread: 0, unreadThreads: 0, lastAt: null });
  return map.get(key);
};

/** Chat: one cursor per room, so this is a single counting aggregate. */
const chatUnread = async ({ channelIds, contactId }) => {
  const out = new Map();
  if (!channelIds.length) return out;

  const readAt = await channelReadMap({ channelIds, contactId: String(contactId) });

  const clauses = channelIds.map((id) => {
    const seen = readAt.get(String(id));
    return seen ? { channel: id, createdAt: { $gt: seen } } : { channel: id };
  });

  const rows = await Message.aggregate([
    {
      $match: {
        $or: clauses,
        // Posting is reading. `$ne` on a null-able field also correctly counts
        // team messages, whose portalAuthor is null.
        portalAuthor: { $ne: contactId },
      },
    },
    {
      $group: {
        _id: '$channel',
        unread: { $sum: 1 },
        unreadThreads: { $addToSet: { $ifNull: ['$replyTo', '$_id'] } },
        lastAt: { $max: '$createdAt' },
      },
    },
    { $addFields: { unreadThreads: { $size: '$unreadThreads' } } },
  ]);

  rows.forEach((r) =>
    out.set(String(r._id), {
      unread: r.unread || 0,
      unreadThreads: r.unreadThreads || 0,
      lastAt: r.lastAt || null,
    })
  );
  return out;
};

/**
 * Mail: one cursor per THREAD, which cannot be expressed as a channel-level
 * `$match` — the cutoff differs per conversation and most conversations have no
 * cutoff at all. So the pipeline groups the mailbox by thread root and hands the
 * per-thread timestamps back for the markers to be applied in JS.
 *
 * It reads the whole mailbox rather than a tail of it, deliberately: a thread
 * the client has never opened is unread from its first message, and any floor
 * cheap enough to push into the `$match` would be the channel marker — the very
 * thing that made these badges wrong. A client portal mailbox is a handful of
 * conversations per service, and the scan is an index scan on `channel`.
 */
const mailUnread = async ({ channelIds, contactId }) => {
  const out = new Map();
  if (!channelIds.length) return out;

  const rows = await Message.aggregate([
    { $match: { channel: { $in: channelIds }, portalAuthor: { $ne: contactId } } },
    {
      $group: {
        // A reply's thread is its parent; a root's thread is itself.
        _id: { $ifNull: ['$replyTo', '$_id'] },
        channel: { $first: '$channel' },
        at: { $push: '$createdAt' },
      },
    },
  ]);
  if (!rows.length) return out;

  const readAt = await threadReadMap({
    threadIds: rows.map((r) => r._id),
    contactId: String(contactId),
  });

  for (const row of rows) {
    const seen = readAt.get(String(row._id));
    const unseen = seen ? row.at.filter((at) => at > seen) : row.at;
    if (!unseen.length) continue;

    const slot = slotFor(out, String(row.channel));
    slot.unread += unseen.length;
    slot.unreadThreads += 1;
    const last = unseen.reduce((a, b) => (b > a ? b : a));
    if (!slot.lastAt || last > slot.lastAt) slot.lastAt = last;
  }
  return out;
};

/**
 * `{ channelId: { unread, unreadThreads, lastAt } }` for one client contact.
 * Channels with nothing unread are absent from the map, as they always were.
 *
 * `contactId` may be a string or an ObjectId — the two controllers hold the
 * first, the digest runner the second, and both must produce the same numbers.
 */
const unreadByChannel = async ({ channelIds, contactId }) => {
  const out = new Map();
  if (!channelIds || !channelIds.length || !contactId) return out;

  const me = asObjectId(contactId);
  if (!me) return out;
  const ids = channelIds.map(asObjectId).filter(Boolean);
  if (!ids.length) return out;

  // The mode decides which marker scores the surface, and the callers pass ids
  // rather than documents, so it is one extra `_id: { $in }` — the cheapest
  // query in this file, and cheaper than the per-caller signature change that
  // would spread the read model back out across three files.
  const channels = await Channel.find({ _id: { $in: ids } })
    .select('_id mode')
    .lean();

  const [chat, mail] = await Promise.all([
    chatUnread({
      channelIds: channels.filter((c) => c.mode !== 'mail').map((c) => c._id),
      contactId: me,
    }),
    mailUnread({
      channelIds: channels.filter((c) => c.mode === 'mail').map((c) => c._id),
      contactId: me,
    }),
  ]);

  chat.forEach((v, k) => out.set(k, v));
  mail.forEach((v, k) => out.set(k, v));
  return out;
};

module.exports = { unreadByChannel };
