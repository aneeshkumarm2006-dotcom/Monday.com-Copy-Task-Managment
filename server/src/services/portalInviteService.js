const Organisation = require('../models/Organisation');
const ClientContact = require('../models/ClientContact');
const { generateSetupToken, hashSetupToken } = require('../utils/portalCrypto');
const {
  sendPortalInviteEmail,
  sendPortalPasswordInviteEmail,
  sendPortalPasswordResetEmail,
} = require('./emailService');

/**
 * One place that turns a client BOARD's portal token into an invitation email,
 * so board creation (boardController) and the "resend invite" admin action
 * (portalController) build the link and look up the org name identically.
 *
 * These used to take a TaskGroup, back when a group was the client company. A
 * client board IS the client now; its groups are that client's workstreams.
 */

const CLIENT_URL = () => process.env.CLIENT_URL || 'http://localhost:5173';

/**
 * The client-facing label for a board: its portal name, or the board name.
 * Exported and shared with taskController — one definition, so the client is
 * never called two different things in two different emails.
 */
const clientLabel = (board) =>
  (board.portalClientName && board.portalClientName.trim()) || board.name;

/**
 * The public landing URL a client opens to accept their invitation.
 *
 * NOTE the URL SHAPE is unchanged from when this took a group — `/portal/:token`
 * either way. That is exactly why the migration promotes each board's existing
 * group token upward instead of minting a fresh one: every link already sitting
 * in a client's inbox keeps resolving.
 *
 * The board must have been loaded with `.select('+portalToken')`; the field is
 * `select: false`. `sendInviteEmail`'s own guard is the backstop.
 */
const portalLink = (board) => `${CLIENT_URL()}/portal/${board.portalToken}`;

/**
 * The one-time URL a password client opens to choose their password. Unlike
 * portalLink this is per-person and single-use — the raw token only ever exists
 * here and in the email.
 */
const setupLink = (board, setupToken) =>
  `${CLIENT_URL()}/portal/${board.portalToken}/set-password?t=${encodeURIComponent(setupToken)}`;

// How long each kind of one-time link stays valid. Setup is generous because an
// invitation can sit unread over a weekend; a reset is a deliberate act moments
// earlier, so it doesn't need to.
const SETUP_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 24 * 60 * 60 * 1000;
const SETUP_TTL_LABEL = '7 days';
const RESET_TTL_LABEL = '24 hours';

/**
 * Email a client the invitation link for a board's portal. BEST-EFFORT: returns
 * false on any failure (bad address, mail not configured, SMTP error) instead of
 * throwing, so creating a client board never fails just because the mail bounced.
 *
 * Which email goes out depends on how the client signs in:
 *   'google'   → the shared portal link, "Accept invitation"
 *   'password' → a one-time set-password link (requires `setupToken`)
 *
 * @param {object} opts
 * @param {object} opts.board      — the client Board, loaded WITH +portalToken
 * @param {string} opts.email      — the client's email address
 * @param {string} [opts.authMethod='google']
 * @param {string} [opts.setupToken] — raw one-time token, required for 'password'
 * @param {string} [opts.purpose='setup'] — 'setup' | 'reset', picks the copy
 * @returns {Promise<boolean>} whether the email was sent
 */
const sendInviteEmail = async ({
  board,
  email,
  authMethod = 'google',
  setupToken = null,
  purpose = 'setup',
}) => {
  try {
    // The token guard is also what catches a board loaded without
    // `+portalToken` — a silent no-send beats emailing a broken link.
    if (!board?.portalToken || !email) return false;
    const org = await Organisation.findById(board.organisation).select('name');
    const common = {
      to: email,
      orgName: org?.name || '',
      clientName: clientLabel(board),
    };

    if (authMethod === 'password') {
      // No token means we'd be mailing a dead link — fail loudly-ish (false)
      // rather than sending the client somewhere broken.
      if (!setupToken) return false;
      const send = purpose === 'reset' ? sendPortalPasswordResetEmail : sendPortalPasswordInviteEmail;
      await send({
        ...common,
        link: setupLink(board, setupToken),
        expiresIn: purpose === 'reset' ? RESET_TTL_LABEL : SETUP_TTL_LABEL,
      });
      return true;
    }

    await sendPortalInviteEmail({ ...common, link: portalLink(board) });
    return true;
  } catch (err) {
    console.error('sendInviteEmail error:', err);
    return false;
  }
};

/**
 * Mint a one-time setup/reset token on a contact and return the RAW value. Only
 * its hash is persisted, so this return value is the only chance to use it —
 * it goes straight into the emailed URL and is then unrecoverable.
 *
 * @param {object} contact — a ClientContact doc (must have +setupTokenHash selected)
 * @param {'setup'|'reset'} purpose
 * @returns {Promise<string>} the raw token
 */
const issueSetupToken = async (contact, purpose) => {
  const raw = generateSetupToken();
  contact.setupTokenHash = hashSetupToken(raw);
  contact.setupTokenExpires = new Date(
    Date.now() + (purpose === 'reset' ? RESET_TTL_MS : SETUP_TTL_MS)
  );
  contact.setupTokenPurpose = purpose;
  await contact.save();
  return raw;
};

/**
 * Create-or-update the ClientContact row for an invited email and send them the
 * matching email. The single path used by board creation, the invite box, and
 * resend, so all three register a client identically.
 *
 * The row is written BEFORE the client has ever signed in, which is what lets the
 * team see who is still outstanding. For 'password' it is also what AUTHORISES
 * the address to use the password form — an email nobody invited that way is
 * refused, so the shared board link never becomes an open sign-up.
 *
 * Best-effort like sendInviteEmail: `ok` is false if the mail didn't go out, but
 * the contact row is still written (the team can resend).
 *
 * @param {object} opts
 * @param {object} opts.board — the client Board, loaded WITH +portalToken
 * @param {string} opts.email — already lowercased/validated by the caller
 * @param {'google'|'password'} [opts.authMethod='google']
 * @returns {Promise<{ok: boolean, contact: object}>}
 */
const inviteContact = async ({ board, email, authMethod = 'google' }) => {
  const method = authMethod === 'password' ? 'password' : 'google';

  const contact = await ClientContact.findOneAndUpdate(
    { board: board._id, email },
    {
      $setOnInsert: {
        board: board._id,
        organisation: board.organisation,
        email,
      },
      // Re-inviting with the other method switches them over — a deliberate team
      // action. Any existing passwordHash is left alone, so switching back later
      // doesn't force a reset.
      $set: { authMethod: method, invitedAt: new Date() },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).select('+passwordHash +setupTokenHash');

  let setupToken = null;
  let purpose = 'setup';
  if (method === 'password') {
    // Someone who already has a password gets "reset" wording, not "welcome".
    purpose = contact.passwordHash ? 'reset' : 'setup';
    setupToken = await issueSetupToken(contact, purpose);
  }

  const ok = await sendInviteEmail({ board, email, authMethod: method, setupToken, purpose });
  return { ok, contact };
};

module.exports = {
  sendInviteEmail,
  inviteContact,
  issueSetupToken,
  clientLabel,
  portalLink,
  setupLink,
  SETUP_TTL_MS,
  RESET_TTL_MS,
};
