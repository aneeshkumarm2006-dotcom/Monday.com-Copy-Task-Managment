const jwt = require('jsonwebtoken');
const ClientContact = require('../models/ClientContact');
const TaskGroup = require('../models/TaskGroup');

/**
 * Auth guard for the external Client Portal (`/api/portal/me/*`). It is the
 * mirror image of middleware/auth.js:
 *
 *  - It ONLY accepts tokens signed with `scope: 'portal'` (minted in the portal
 *    verify flow); a normal user token is rejected here, and a portal token is
 *    rejected by auth.js. This mutual exclusion is a security requirement.
 *  - It loads the ClientContact named in the token and attaches the trusted
 *    scope to `req.portal`. Controllers derive board/group from `req.portal`,
 *    NEVER from request params/body, so a client can only ever reach their own
 *    group's data.
 */
const portalAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res
      .status(401)
      .json({ error: 'Missing or invalid authorization header' });
  }
  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) {
    return res.status(401).json({ error: 'Missing token' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  if (decoded.scope !== 'portal' || !decoded.contactId) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  try {
    const contact = await ClientContact.findById(decoded.contactId);
    // Reject if the contact was removed or the token's group no longer matches
    // (e.g. the contact record was rewritten). Never trust the token's group id
    // over the stored contact.
    if (!contact || String(contact.group) !== String(decoded.groupId)) {
      return res.status(401).json({ error: 'Session no longer valid' });
    }

    // The group must still be a live portal, AND its current token must match
    // the one baked into the JWT (`ptk`). This is what makes "disable" and
    // "regenerate link" instantly kill existing client sessions: disabling
    // clears portalEnabled, regenerating changes portalToken — either way the
    // check below fails on the next request.
    const group = await TaskGroup.findById(contact.group);
    if (!group || !group.portalEnabled || group.portalToken !== decoded.ptk) {
      return res.status(401).json({ error: 'This portal is no longer available' });
    }

    req.portal = {
      contactId: String(contact._id),
      groupId: String(contact.group),
      boardId: String(contact.board),
      orgId: contact.organisation ? String(contact.organisation) : null,
      email: contact.email,
      contact,
      group,
    };

    // Best-effort presence stamp; never block the request on it.
    contact.lastSeenAt = new Date();
    contact.save().catch(() => {});

    return next();
  } catch (err) {
    console.error('portalAuth error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

module.exports = portalAuth;
