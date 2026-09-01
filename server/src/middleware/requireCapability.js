const Organisation = require('../models/Organisation');
const { resolveOrgAccess } = require('../utils/permissions');

/**
 * requireCapability(cap) — route guard for ORG-level capabilities.
 *
 * The replacement for `requireOrgAdmin`. That middleware asked "is this person in
 * the admins array", which made `admin` a single bit granting roughly fifteen
 * unrelated powers at once — you could not let someone invite members without
 * also letting them delete every board. This asks the only question that
 * matters: does this person's ROLE hold this specific capability?
 *
 * Board-scoped capabilities are NOT checked here — they need the board, and the
 * board is the second half of the AND. Those go through
 * [boardContext.js](../utils/boardContext.js) `loadBoardContext` instead.
 *
 * Resolves orgId from (in order):
 *   1. req.params.id
 *   2. req.params.orgId
 *   3. req.body.orgId
 *   4. req.query.org
 *
 * Attaches `req.org` and `req.orgAccess` for downstream handlers.
 */
const requireCapability = (capability, message) => async (req, res, next) => {
  try {
    const orgId =
      req.params.id || req.params.orgId || req.body.orgId || req.query.org;

    if (!orgId) {
      return res.status(400).json({ error: 'Organisation ID required' });
    }

    const org = await Organisation.findById(orgId);
    if (!org) {
      return res.status(404).json({ error: 'Organisation not found' });
    }

    const userId = req.user.userId;
    const isMember = org.members.some((m) => m.toString() === userId);
    if (!isMember) {
      return res
        .status(403)
        .json({ error: 'Not a member of this workspace' });
    }

    // Orgs created before the role system have no `roles` yet. Seed them on
    // first touch so the resolver has something to resolve against, rather than
    // failing closed and locking a legacy workspace out of its own settings.
    if (org.ensureSystemRoles()) await org.save();

    const access = resolveOrgAccess(org, userId);
    if (!access.can(capability)) {
      return res.status(403).json({
        error: message || 'You do not have permission to do this',
        required: capability,
      });
    }

    req.org = org;
    req.orgAccess = access;
    return next();
  } catch (err) {
    console.error(`requireCapability(${capability}) error:`, err);
    return res.status(500).json({ error: 'Server error' });
  }
};

module.exports = { requireCapability };
