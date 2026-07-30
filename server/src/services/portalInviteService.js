const Organisation = require('../models/Organisation');
const ClientContact = require('../models/ClientContact');
const { generateSetupToken, hashSetupToken } = require('../utils/portalCrypto');
const {
  sendPortalInviteEmail,
  sendPortalPasswordInviteEmail,
  sendPortalPasswordResetEmail,
} = require('./emailService');

/**
 * One place that turns a group's portal token into an invitation email, so both
 * group-creation (groupController) and the "resend invite" admin action
 * (portalController) build the link and look up the org name identically.
 */

const CLIENT_URL = () => process.env.CLIENT_URL || 'http://localhost:5173';

/** The client-facing label for a group: its portal name, or the group name. */
const clientLabel = (group) =>
  (group.portalClientName && group.portalClientName.trim()) || group.name;

/** The public landing URL a client opens to accept their invitation. */
const portalLink = (group) => `${CLIENT_URL()}/portal/${group.portalToken}`;

/**
 * The one-time URL a password client opens to choose their password. Unlike
 * portalLink this is per-person and single-use — the raw token only ever exists
 * here and in the email.
 */
const setupLink = (group, setupToken) =>
  `${CLIENT_URL()}/portal/${group.portalToken}/set-password?t=${encodeURIComponent(setupToken)}`;

// How long each kind of one-time link stays valid. Setup is generous because an
// invitation can sit unread over a weekend; a reset is a deliberate act moments
// earlier, so it doesn't need to.
const SETUP_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 24 * 60 * 60 * 1000;
const SETUP_TTL_LABEL = '7 days';
const RESET_TTL_LABEL = '24 hours';

/**
 * Email a client the invitation link for a group's portal. BEST-EFFORT: returns
 * false on any failure (bad address, mail not configured, SMTP error) instead of
 * throwing, so creating a client group never fails just because the mail bounced.
 *
 * Which email goes out depends on how the client signs in:
 *   'google'   → the shared portal link, "Accept invitation"
 *   'password' → a one-time set-password link (requires `setupToken`)
 *
 * @param {object} opts
 * @param {object} opts.group      — the TaskGroup (must already carry portalToken)
 * @param {object} opts.board      — the parent Board (for organisation)
 * @param {string} opts.email      — the client's email address
 * @param {string} [opts.authMethod='google']
 * @param {string} [opts.setupToken] — raw one-time token, required for 'password'
 * @param {string} [opts.purpose='setup'] — 'setup' | 'reset', picks the copy
 * @returns {Promise<boolean>} whether the email was sent
 */
const sendGroupInvite = async ({
  group,
  board,
  email,
  authMethod = 'google',
  setupToken = null,
  purpose = 'setup',
}) => {
  try {
    if (!group?.portalToken || !email) return false;
    const org = await Organisation.findById(board.organisation).select('name');
    const common = {
      to: email,
      orgName: org?.name || '',
      clientName: clientLabel(group),
    };

    if (authMethod === 'password') {
      // No token means we'd be mailing a dead link — fail loudly-ish (false)
      // rather than sending the client somewhere broken.
      if (!setupToken) return false;
      const send = purpose === 'reset' ? sendPortalPasswordResetEmail : sendPortalPasswordInviteEmail;
      await send({
        ...common,
        link: setupLink(group, setupToken),
        expiresIn: purpose === 'reset' ? RESET_TTL_LABEL : SETUP_TTL_LABEL,
      });
      return true;
    }

    await sendPortalInviteEmail({ ...common, link: portalLink(group) });
    return true;
  } catch (err) {
    console.error('sendGroupInvite error:', err);
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
 * matching email. The single path used by group creation, the invite box, and
 * resend, so all three register a client identically.
 *
 * The row is written BEFORE the client has ever signed in, which is what lets the
 * team see who is still outstanding. For 'password' it is also what AUTHORISES
 * the address to use the password form — an email nobody invited that way is
 * refused, so the shared group link never becomes an open sign-up.
 *
 * Best-effort like sendGroupInvite: `ok` is false if the mail didn't go out, but
 * the contact row is still written (the team can resend).
 *
 * @param {object} opts
 * @param {object} opts.group, opts.board
 * @param {string} opts.email — already lowercased/validated by the caller
 * @param {'google'|'password'} [opts.authMethod='google']
 * @returns {Promise<{ok: boolean, contact: object}>}
 */
const inviteContact = async ({ group, board, email, authMethod = 'google' }) => {
  const method = authMethod === 'password' ? 'password' : 'google';

  const contact = await ClientContact.findOneAndUpdate(
    { group: group._id, email },
    {
      $setOnInsert: {
        group: group._id,
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

  const ok = await sendGroupInvite({ group, board, email, authMethod: method, setupToken, purpose });
  return { ok, contact };
};

module.exports = {
  sendGroupInvite,
  inviteContact,
  issueSetupToken,
  clientLabel,
  portalLink,
  setupLink,
  SETUP_TTL_MS,
  RESET_TTL_MS,
};
