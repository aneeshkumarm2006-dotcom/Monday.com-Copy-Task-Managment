const cron = require('node-cron');

const Board = require('../models/Board');
const Channel = require('../models/Channel');
const ClientContact = require('../models/ClientContact');
const Organisation = require('../models/Organisation');
const TaskGroup = require('../models/TaskGroup');
const PortalDigest = require('../models/PortalDigest');
const { unreadByChannel } = require('./portalUnread');
const { resolveColors } = require('./serviceCatalogService');
const { sendPortalDigestEmail } = require('./emailService');

/**
 * The daily portal digest — everything still unread, once a day, per client.
 *
 * A direct sibling of [dueDigestRunner.js](./dueDigestRunner.js): same node-cron
 * tick, same module-level `started` guard, same start-from-server.js shape, same
 * CLAIM-BEFORE-SEND idempotency. The differences are the subject (a CLIENT's
 * unread conversations rather than a user's due tasks) and the audience (a
 * ClientContact, who is not a User and has no notification preferences).
 *
 * ---- HOW THIS DIFFERS FROM THE FIRST-UNREAD EMAIL --------------------------
 *
 * `services/portalNotify.js` is prompt and per-conversation: one nudge the
 * moment a conversation goes from read to unread, then silence for six hours.
 * This is the catch-all for the client who has not opened the portal all day and
 * whose ceiling has quietly lapsed. Both are wanted; neither replaces the other.
 *
 * A CONTACT WITH NOTHING UNREAD GETS NOTHING. No "you're all caught up" mail. A
 * digest that arrives empty is noise, and noise is how a digest ends up in a
 * folder nobody opens — the same rule dueDigestRunner states for itself.
 *
 * ---- WHY HOURLY ------------------------------------------------------------
 *
 * The claim row makes the send once-per-day whatever the tick rate, so the rate
 * only decides how soon after midnight UTC a client hears. Hourly keeps that
 * within an hour without a per-contact timezone this model does not have.
 */

let started = false;

const dayKeyUtc = (now) => now.toISOString().slice(0, 10);

/**
 * One contact's digest. Returns true when an email actually went out.
 */
const digestOne = async (contact, now) => {
  if (contact.notifyEmail === false || !contact.email) return false;

  const board = await Board.findById(contact.board).select(
    '+portalToken portalEnabled portalClientName name organisation boardType'
  );
  // A disabled or deleted portal has nothing to link to, and mailing a dead link
  // is worse than staying quiet.
  if (!board || board.boardType !== 'client' || !board.portalEnabled || !board.portalToken) {
    return false;
  }

  const channels = await Channel.find({
    board: board._id,
    audience: 'client',
    archived: false,
  })
    .select('_id group mode')
    .lean();
  if (!channels.length) return false;

  const unread = await unreadByChannel({
    channelIds: channels.map((c) => c._id),
    contactId: contact._id,
  });
  if (!unread.size) return false;

  const perGroup = new Map();
  for (const ch of channels) {
    const u = unread.get(String(ch._id));
    if (!u) continue;
    const key = String(ch.group || '');
    if (!perGroup.has(key)) perGroup.set(key, { chat: 0, mail: 0 });
    // Mail counts THREADS, matching the badge the portal itself shows.
    if (ch.mode === 'mail') perGroup.get(key).mail += u.unreadThreads;
    else perGroup.get(key).chat += u.unread;
  }

  const groups = await TaskGroup.find({ _id: { $in: [...perGroup.keys()].filter(Boolean) } })
    .select('name order serviceKey')
    .sort({ order: 1 })
    .lean();
  const colors = await resolveColors(
    board.organisation,
    groups.map((g) => g.serviceKey).filter(Boolean)
  );

  const rows = groups
    .map((g) => {
      const u = perGroup.get(String(g._id)) || { chat: 0, mail: 0 };
      return {
        name: g.name,
        color: g.serviceKey ? colors.get(g.serviceKey) : null,
        chat: u.chat,
        mail: u.mail,
        requests: 0,
      };
    })
    .filter((r) => r.chat || r.mail);

  if (!rows.length) return false;

  // Claim FIRST, then send — see models/PortalDigest.js for why this ordering.
  const dayKey = dayKeyUtc(now);
  try {
    await PortalDigest.create({
      contact: contact._id,
      dayKey,
      sentAt: now,
      serviceCount: rows.length,
    });
  } catch (err) {
    if (err?.code === 11000) return false; // today is already handled
    throw err;
  }

  const org = await Organisation.findById(board.organisation).select('name');
  await sendPortalDigestEmail({
    to: contact.email,
    orgName: org?.name || '',
    clientName: (board.portalClientName || '').trim() || board.name,
    name: contact.name || '',
    rows,
    link: `${process.env.CLIENT_URL || 'http://localhost:5173'}/portal/${board.portalToken}`,
  });

  await PortalDigest.updateOne({ contact: contact._id, dayKey }, { $set: { emailed: true } });
  return true;
};

const tick = async () => {
  const now = new Date();
  let contacts;
  try {
    contacts = await ClientContact.find({ notifyEmail: { $ne: false } })
      .select('email name board notifyEmail')
      .lean();
  } catch (err) {
    console.error('[portalDigest] failed to query contacts:', err);
    return;
  }

  for (const contact of contacts) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await digestOne(contact, now);
    } catch (err) {
      console.error('[portalDigest] failed for contact', String(contact?._id), err);
    }
  }
};

const startPortalDigestRunner = () => {
  if (started) return;
  started = true;
  cron.schedule('7 * * * *', () => {
    tick().catch((err) => console.error('[portalDigest] tick failed:', err));
  });
  console.log('portal digest runner started');
};

module.exports = { startPortalDigestRunner, tick, digestOne, dayKeyUtc };
