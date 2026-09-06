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
 *
 * ---- AND WHY HOURLY IS AFFORDABLE ------------------------------------------
 *
 * Because the tick is bounded by BOARDS, not by contacts. See `tick` and
 * `loadBoardDigestContext`: the per-contact cost is one aggregate, and
 * everything else is done once per board however many people are on it.
 */

let started = false;
// Whether a tick is in flight. `started` only stops the cron being scheduled
// twice; it says nothing about a tick that is still running when the next hour
// arrives, and two overlapping ticks fight over the same claim rows and send the
// same digests twice as fast as the mailer will take them.
let running = false;

// How many times one contact's digest may be attempted on one day. The claim row
// is RELEASED when a send throws (see `digestOne`), so a transient SMTP failure
// costs a retry rather than the whole day; the counter is what stops a
// permanently broken mailer retrying 24 times a day. In-process on purpose: it
// is a rate limit, not a fact about the world, and a restart is allowed to
// forget it. `models/PortalDigest.js` has no field for it and this file is not
// the place to add one.
const MAX_SEND_ATTEMPTS = 2;
const sendAttempts = new Map(); // `${contactId}:${dayKey}` -> attempts
let attemptsDay = null;

const dayKeyUtc = (now) => now.toISOString().slice(0, 10);

/**
 * Everything ONE BOARD contributes to its contacts' digests, loaded once.
 *
 * This is the whole N+1 fix. Ten contacts on one client board used to re-read
 * that board, its channels, its groups, its service colours and its organisation
 * ten times over, every hour, for a digest that can be sent to each of them at
 * most once a day. None of that varies by contact; only the unread counts do.
 *
 * Returns null when the board has nothing to digest — not a live client portal,
 * or no client-facing rooms at all. A disabled or deleted portal has nothing to
 * link to, and mailing a dead link is worse than staying quiet.
 *
 * @param {Object} board - a Board doc loaded WITH +portalToken
 */
const loadBoardDigestContext = async (board) => {
  if (!board || board.boardType !== 'client' || !board.portalEnabled || !board.portalToken) {
    return null;
  }

  const channels = await Channel.find({
    board: board._id,
    audience: 'client',
    archived: false,
  })
    .select('_id group mode')
    .lean();
  if (!channels.length) return null;

  const groupIds = [...new Set(channels.map((c) => String(c.group || '')).filter(Boolean))];
  const groups = await TaskGroup.find({ _id: { $in: groupIds } })
    .select('name order serviceKey')
    .sort({ order: 1 })
    .lean();
  const colors = await resolveColors(
    board.organisation,
    groups.map((g) => g.serviceKey).filter(Boolean)
  );
  const org = await Organisation.findById(board.organisation).select('name');

  return {
    channelIds: channels.map((c) => c._id),
    channels,
    groups,
    colors,
    orgName: org?.name || '',
    clientName: (board.portalClientName || '').trim() || board.name,
    link: `${process.env.CLIENT_URL || 'http://localhost:5173'}/portal/${board.portalToken}`,
  };
};

/**
 * One contact's digest. Returns true when an email actually went out.
 *
 * `ctx` is the shared board work from `loadBoardDigestContext`. `tick` always
 * passes it; when it is absent — a one-off call, a script — this loads the same
 * thing for this contact's board alone, so the signature keeps working.
 */
const digestOne = async (contact, now, ctx = null) => {
  if (contact.notifyEmail === false || !contact.email) return false;

  let context = ctx;
  if (!context) {
    const board = await Board.findById(contact.board).select(
      '+portalToken portalEnabled portalClientName name organisation boardType'
    );
    context = await loadBoardDigestContext(board);
  }
  if (!context) return false;

  // The only per-contact query. Everything above it is shared.
  const unread = await unreadByChannel({
    channelIds: context.channelIds,
    contactId: contact._id,
  });
  if (!unread.size) return false;

  const perGroup = new Map();
  for (const ch of context.channels) {
    const u = unread.get(String(ch._id));
    if (!u) continue;
    const key = String(ch.group || '');
    if (!perGroup.has(key)) perGroup.set(key, { chat: 0, mail: 0 });
    // Mail counts THREADS, matching the badge the portal itself shows.
    if (ch.mode === 'mail') perGroup.get(key).mail += u.unreadThreads;
    else perGroup.get(key).chat += u.unread;
  }

  const rows = context.groups
    .map((g) => {
      const u = perGroup.get(String(g._id)) || { chat: 0, mail: 0 };
      return {
        name: g.name,
        color: g.serviceKey ? context.colors.get(g.serviceKey) : null,
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

  const attemptKey = String(contact._id) + ':' + dayKey;
  try {
    await sendPortalDigestEmail({
      to: contact.email,
      orgName: context.orgName,
      clientName: context.clientName,
      name: contact.name || '',
      rows,
      link: context.link,
    });
  } catch (err) {
    // THE CLAIM IS RELEASED WHEN THE SEND FAILS, and that is a narrowing of the
    // model's rule rather than a reversal of it. "Claim before send" is there so
    // a CRASH under-notifies instead of double-sending, and a crash still does:
    // the row survives a dead process. But a caught SMTP error is different —
    // the claim was the only thing standing between one bad minute and a client
    // losing a whole day's digest while 23 more ticks ran that would have
    // succeeded. `emailed` recorded that state and nothing has ever read it.
    //
    // The cost is bounded: at most one retry (MAX_SEND_ATTEMPTS), so the worst
    // case — a send that threw after the mail actually left — is one duplicate,
    // not a loop.
    const attempts = (sendAttempts.get(attemptKey) || 0) + 1;
    sendAttempts.set(attemptKey, attempts);
    if (attempts < MAX_SEND_ATTEMPTS) {
      await PortalDigest.deleteOne({ contact: contact._id, dayKey });
    } else {
      console.error(
        '[portalDigest] giving up on',
        contact.email,
        'for',
        dayKey,
        'after',
        attempts,
        'attempts'
      );
    }
    throw err;
  }

  sendAttempts.delete(attemptKey);
  await PortalDigest.updateOne({ contact: contact._id, dayKey }, { $set: { emailed: true } });
  return true;
};

/**
 * BOARDS FIRST, CONTACTS SECOND.
 *
 * This used to read every ClientContact in the database and then ask, once per
 * contact, whether their board was a live client portal. Two queries now bound
 * the whole tick: the client boards that are actually switched on, and the
 * contacts who sit on one of them. A contact on an offboarded client is never
 * loaded at all, and each board's shared work is done once for everyone on it.
 *
 * If the board list itself ever outgrows a single query, this loop is where
 * paging goes — the per-board work below is already independent.
 */
const tick = async () => {
  if (running) {
    console.warn('[portalDigest] previous tick still running, skipping this hour');
    return;
  }
  running = true;
  try {
    const now = new Date();

    // The attempt counters describe ONE day. Dropping them when the day turns is
    // what stops this map growing for the life of the process.
    const today = dayKeyUtc(now);
    if (attemptsDay !== today) {
      sendAttempts.clear();
      attemptsDay = today;
    }

    let boards;
    let contacts;
    try {
      boards = await Board.find({ boardType: 'client', portalEnabled: true }).select(
        '+portalToken portalEnabled portalClientName name organisation boardType'
      );
      if (!boards.length) return;

      contacts = await ClientContact.find({
        notifyEmail: { $ne: false },
        board: { $in: boards.map((b) => b._id) },
      })
        .select('email name board notifyEmail')
        .lean();
    } catch (err) {
      console.error('[portalDigest] failed to query boards and contacts:', err);
      return;
    }
    if (!contacts.length) return;

    const byBoard = new Map();
    for (const contact of contacts) {
      const key = String(contact.board || '');
      if (!byBoard.has(key)) byBoard.set(key, []);
      byBoard.get(key).push(contact);
    }

    for (const board of boards) {
      const list = byBoard.get(String(board._id));
      if (!list || !list.length) continue;

      let ctx;
      try {
        // eslint-disable-next-line no-await-in-loop
        ctx = await loadBoardDigestContext(board);
      } catch (err) {
        console.error('[portalDigest] failed for board', String(board._id), err);
        continue;
      }
      if (!ctx) continue;

      for (const contact of list) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await digestOne(contact, now, ctx);
        } catch (err) {
          console.error('[portalDigest] failed for contact', String(contact?._id), err);
        }
      }
    }
  } finally {
    running = false;
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

module.exports = { startPortalDigestRunner, tick, digestOne, dayKeyUtc, loadBoardDigestContext };
