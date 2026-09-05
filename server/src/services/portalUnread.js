const Message = require('../models/Message');
const { channelReadMap } = require('./chatRead');

/**
 * How many unread messages a client contact has, across many channels, in ONE
 * aggregate.
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
 * by the number of services on one board (two channels each), and every clause
 * is served by Message's existing `{ channel: 1, createdAt: -1 }` index.
 *
 * ---- WHAT COUNTS AS UNREAD -------------------------------------------------
 *
 * Newer than this contact's read marker for that channel, and NOT WRITTEN BY
 * THEM. Posting is reading: a client who sends a message must not come back to
 * find their own message counted against them. A channel with no read marker
 * counts everything, which is correct for a room they have never opened.
 *
 * `unreadThreads` rides along for free via `$addToSet` over the thread root
 * (`replyTo` when present, else the message's own id). Mail is read one THREAD
 * at a time — `MailThreadRead` is the source of truth for which — so a mailbox
 * badge showing "4 messages" when there are two conversations is the wrong
 * number. Chat callers ignore it.
 */
const unreadByChannel = async ({ channelIds, contactId }) => {
  const empty = new Map();
  if (!channelIds || !channelIds.length || !contactId) return empty;

  const readAt = await channelReadMap({ channelIds, contactId });

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

  const out = new Map();
  for (const r of rows) {
    out.set(String(r._id), {
      unread: r.unread || 0,
      unreadThreads: r.unreadThreads || 0,
      lastAt: r.lastAt || null,
    });
  }
  return out;
};

module.exports = { unreadByChannel };
