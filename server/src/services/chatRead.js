const ChannelRead = require('../models/ChannelRead');
const ChannelContactRead = require('../models/ChannelContactRead');
const MailThreadRead = require('../models/MailThreadRead');

/**
 * Read markers, in one place.
 *
 * There are now four of them — channel/thread × user/contact — and they all
 * obey the same rule, which is easy to state and easy to get wrong:
 *
 *   THE MARKER NEVER MOVES BACKWARDS.
 *
 * It is `$max`, never `$set`. A second browser tab left open on an old page,
 * a retried request, a mobile client whose clock is behind — any of them can
 * report an `at` older than the marker already holds, and a `$set` would
 * happily accept it and resurrect a fortnight of read messages as unread. The
 * rule was previously written out three times in `chatController` and would
 * have been written out four more by the portal and by mail.
 *
 * Chat and mail read DIFFERENT UNITS, which is why there are two collections
 * rather than one with a nullable field:
 *
 *   chat — you read a CHANNEL. One marker per (channel, principal).
 *   mail — you read a THREAD. Opening "Q4 budget" must not mark "October plan"
 *          read, so the marker is per (thread, principal) and the channel is
 *          carried alongside only so a cascade can find it.
 *
 * And there are three COLLECTIONS rather than two, because a `User` marker and
 * a `ClientContact` marker cannot share a row either — see the header on
 * [ChannelContactRead](../models/ChannelContactRead.js) for the unique-index
 * reason, which is the same one that keeps `MailThreadRead` off `ChannelRead`.
 * All three are written only from here.
 */

/** A date that is definitely a date; `at` may be absent, a string, or rubbish. */
const resolveAt = (at) => {
  if (!at) return new Date();
  const d = at instanceof Date ? at : new Date(at);
  return Number.isNaN(d.getTime()) ? new Date() : d;
};

/**
 * Move a principal's marker on a whole CHANNEL.
 *
 * Exactly one of `userId` / `contactId` — the caller knows which plane it is
 * on, and passing both would write a row that belongs to nobody. Returns false
 * rather than throwing when neither is given, because every caller is on a
 * best-effort path (posting already succeeded; failing the request now would
 * report a send that did happen as a send that did not).
 */
const markChannelRead = async ({ channelId, userId = null, contactId = null, at = null }) => {
  if (!channelId) return false;
  if (Boolean(userId) === Boolean(contactId)) return false;

  const lastReadAt = resolveAt(at);

  if (userId) {
    await ChannelRead.findOneAndUpdate(
      { channel: channelId, user: userId },
      { $max: { lastReadAt } },
      { upsert: true }
    );
    return true;
  }

  await ChannelContactRead.findOneAndUpdate(
    { channel: channelId, contact: contactId },
    { $max: { lastReadAt } },
    { upsert: true }
  );
  return true;
};

/**
 * `{ channelId: lastReadAt }` for one principal across a set of channels — the
 * sidebar's and the portal's unread computation, in one query.
 */
const channelReadMap = async ({ channelIds, userId = null, contactId = null }) => {
  const map = new Map();
  if (!channelIds?.length) return map;
  if (Boolean(userId) === Boolean(contactId)) return map;

  const rows = userId
    ? await ChannelRead.find({ channel: { $in: channelIds }, user: userId })
        .select('channel lastReadAt')
        .lean()
    : await ChannelContactRead.find({ channel: { $in: channelIds }, contact: contactId })
        .select('channel lastReadAt')
        .lean();

  rows.forEach((r) => map.set(String(r.channel), r.lastReadAt));
  return map;
};

/**
 * Move a principal's marker on ONE MAIL THREAD. `channelId` is stored so the
 * channel cascade can find these rows; it is never part of the identity.
 */
const markThreadRead = async ({
  threadId,
  channelId,
  userId = null,
  contactId = null,
  at = null,
}) => {
  if (!threadId || !channelId) return false;
  if (Boolean(userId) === Boolean(contactId)) return false;

  const lastReadAt = resolveAt(at);
  const principal = userId ? { user: userId } : { contact: contactId };

  await MailThreadRead.findOneAndUpdate(
    { thread: threadId, ...principal },
    { $max: { lastReadAt }, $setOnInsert: { channel: channelId } },
    { upsert: true }
  );
  return true;
};

/**
 * `{ threadId: lastReadAt }` for one principal across a set of threads — what
 * a mailbox listing needs to put the unread dot on the right rows, in one
 * query rather than one per thread.
 */
const threadReadMap = async ({ threadIds, userId = null, contactId = null }) => {
  const map = new Map();
  if (!threadIds?.length) return map;
  if (Boolean(userId) === Boolean(contactId)) return map;

  const principal = userId ? { user: userId } : { contact: contactId };
  const rows = await MailThreadRead.find({ thread: { $in: threadIds }, ...principal })
    .select('thread lastReadAt')
    .lean();
  rows.forEach((r) => map.set(String(r.thread), r.lastReadAt));
  return map;
};

module.exports = {
  markChannelRead,
  markThreadRead,
  channelReadMap,
  threadReadMap,
  resolveAt,
};
