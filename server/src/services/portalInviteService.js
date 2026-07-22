const Organisation = require('../models/Organisation');
const { sendPortalInviteEmail } = require('./emailService');

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
 * Email a client the invitation link for a group's portal. BEST-EFFORT: returns
 * false on any failure (bad address, mail not configured, SMTP error) instead of
 * throwing, so creating a client group never fails just because the mail bounced.
 *
 * @param {object} opts
 * @param {object} opts.group  — the TaskGroup (must already carry portalToken)
 * @param {object} opts.board  — the parent Board (for organisation)
 * @param {string} opts.email  — the client's email address
 * @returns {Promise<boolean>} whether the email was sent
 */
const sendGroupInvite = async ({ group, board, email }) => {
  try {
    if (!group?.portalToken || !email) return false;
    const org = await Organisation.findById(board.organisation).select('name');
    await sendPortalInviteEmail({
      to: email,
      orgName: org?.name || '',
      clientName: clientLabel(group),
      link: portalLink(group),
    });
    return true;
  } catch (err) {
    console.error('sendGroupInvite error:', err);
    return false;
  }
};

module.exports = { sendGroupInvite, clientLabel, portalLink };
