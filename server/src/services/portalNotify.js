const ClientContact = require('../models/ClientContact');
const ChannelContactRead = require('../models/ChannelContactRead');
const Board = require('../models/Board');
const Organisation = require('../models/Organisation');
const { channelAudience } = require('./chatAudience');
const { sendPortalNewMessageEmail } = require('./emailService');

/**
 * Telling a CLIENT that something is waiting for them in the portal.
 *
 * Chat and mail live inside Macan — there is no SMTP thread for a client to
 * reply into — so without this a team reply sits unseen until the client happens
 * to open the portal. This is the notify-only email that closes that gap.
 *
 * It is the mirror image of `portalChatController.notifyTeamOfClientMessage`,
 * which does the same job in the other direction for the team's bell, and it
 * borrows that function's central idea: COLLAPSE. One nudge per conversation,
 * not one per message.
 *
 * ---- THREE LAYERS OF RESTRAINT, AND WHY EACH ONE EXISTS -------------------
 *
 *   1. PRESENCE. Skip anyone who is demonstrably reading right now — their read
 *      marker for this channel is newer than three minutes ago. Emailing someone
 *      about a message they are watching arrive is the fastest way to teach them
 *      to filter these.
 *
 *   2. FIRST-UNREAD ONLY, with a six-hour ceiling. Send when they have never
 *      been notified, OR when they have READ since the last notification (so a
 *      genuinely new conversation earns a fresh nudge), OR when the last nudge
 *      is more than six hours old (so a long unread silence still reaches them).
 *      A forty-message back-and-forth therefore sends ONE email.
 *
 *   3. OPT-OUT. `ClientContact.notifyEmail`. See that field's comment.
 *
 * ---- NO Reply-To, DELIBERATELY --------------------------------------------
 *
 * `sendPortalReplyEmail` sets a plus-addressed `Reply-To` because an ISSUE
 * thread genuinely has an inbound path — `services/inboundEmail.js` routes those
 * replies back onto the task. Chat and mail have NO inbound path whatsoever.
 * A Reply-To here would create a black hole that silently eats a client's reply,
 * which is worse than every problem this email solves. The CTA is the only
 * action, and the copy says so.
 *
 * Fire-and-forget: every failure is logged and swallowed. A message that is
 * already stored must not fail because the mailer did.
 */

const PRESENCE_MS = 3 * 60 * 1000;
const CEILING_MS = 6 * 60 * 60 * 1000;

/**
 * Should this contact be emailed about this channel right now?
 *
 * Pure apart from the two documents handed in, so the rule can be reasoned about
 * — and asserted — without a mailer.
 *
 * @param {Object} read  - the ChannelContactRead row, or null if they have never opened it
 * @param {Date}   now
 */
const shouldNotify = (read, now = new Date()) => {
  if (!read) return true; // never opened, never notified
  const readAt = read.lastReadAt ? read.lastReadAt.getTime() : 0;
  const notifiedAt = read.lastNotifiedAt ? read.lastNotifiedAt.getTime() : 0;

  // Layer 1 — they are looking at it.
  if (now.getTime() - readAt < PRESENCE_MS) return false;

  // Layer 2.
  if (!notifiedAt) return true;
  if (readAt > notifiedAt) return true;
  return now.getTime() - notifiedAt > CEILING_MS;
};

/**
 * Email the client contacts in a channel that a team message is waiting.
 *
 * @param {Object} channel - a Channel doc; must be `audience: 'client'`
 * @param {Object} message - the Message just written by a team member
 * @param {Object} [opts]
 * @param {string} [opts.authorName] - who wrote it, for the copy
 */
const notifyClientsOfTeamMessage = async (channel, message, { authorName = '' } = {}) => {
  try {
    if (!channel || channel.audience !== 'client') return;

    // The audience helper is the ONE place that decides who is in a room, and it
    // re-reads the board every call — so a portal disabled a second ago produces
    // an empty list here rather than an email to someone who can no longer sign in.
    const audience = await channelAudience(channel);
    if (!audience.contactIds.length) return;

    const contacts = await ClientContact.find({
      _id: { $in: audience.contactIds },
      notifyEmail: { $ne: false },
    }).select('email name notifyEmail');
    if (!contacts.length) return;

    const [board, org] = await Promise.all([
      Board.findById(channel.board).select('+portalToken portalClientName name organisation portalEnabled'),
      Organisation.findById(channel.organisation).select('name'),
    ]);
    if (!board || !board.portalToken || !board.portalEnabled) return;

    const reads = await ChannelContactRead.find({
      channel: channel._id,
      contact: { $in: contacts.map((c) => c._id) },
    });
    const readByContact = new Map(reads.map((r) => [String(r.contact), r]));

    const now = new Date();
    const due = contacts.filter((c) => shouldNotify(readByContact.get(String(c._id)), now));
    if (!due.length) return;

    const clientName = (board.portalClientName || '').trim() || board.name;
    const snippet = (message?.bodyText || '').replace(/\s+/g, ' ').trim().slice(0, 140);

    await Promise.allSettled(
      due.map(async (contact) => {
        await sendPortalNewMessageEmail({
          to: contact.email,
          orgName: org?.name || '',
          clientName,
          serviceName: channel.name || 'your portal',
          mode: channel.mode === 'mail' ? 'mail' : 'chat',
          authorName,
          subject: message?.subject || null,
          snippet,
          link: `${process.env.CLIENT_URL || 'http://localhost:5173'}/portal/${board.portalToken}`,
        });

        // Stamp AFTER a successful send. Stamping first would silently swallow
        // the notification when the mailer is down — the client would be marked
        // as told about something they were never told about.
        await ChannelContactRead.updateOne(
          { channel: channel._id, contact: contact._id },
          { $set: { lastNotifiedAt: now }, $setOnInsert: { lastReadAt: new Date(0) } },
          { upsert: true }
        );
      })
    );
  } catch (err) {
    console.error('notifyClientsOfTeamMessage error:', err);
  }
};

module.exports = { shouldNotify, notifyClientsOfTeamMessage, PRESENCE_MS, CEILING_MS };
