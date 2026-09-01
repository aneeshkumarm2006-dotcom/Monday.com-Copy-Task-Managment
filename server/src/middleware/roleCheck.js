const Organisation = require('../models/Organisation');

/**
 * requireOrgAdmin — Middleware that checks if the current user is the admin
 * of the organisation referenced by the request.
 *
 * Resolves orgId from (in order):
 *   1. req.params.id
 *   2. req.params.orgId
 *   3. req.body.orgId
 *   4. req.query.org
 *
 * Responds 403 if not admin, 404 if org not found, 400 if no orgId resolvable.
 */
const requireOrgAdmin = async (req, res, next) => {
  try {
    const orgId =
      req.params.id ||
      req.params.orgId ||
      req.body.orgId ||
      req.query.org;

    if (!orgId) {
      return res.status(400).json({ error: 'Organisation ID required' });
    }

    const org = await Organisation.findById(orgId);
    if (!org) {
      return res.status(404).json({ error: 'Organisation not found' });
    }

    const isMainAdmin = org.admin.toString() === req.user.userId;
    const isExtraAdmin = Array.isArray(org.admins) &&
      org.admins.some((a) => a.toString() === req.user.userId);

    if (!isMainAdmin && !isExtraAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    // Attach org for downstream handlers
    req.org = org;
    return next();
  } catch (err) {
    console.error('requireOrgAdmin error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * requireOrgOwner — Stricter variant of requireOrgAdmin. Only the organisation's
 * primary admin (org.admin) passes. Extra admins listed in org.admins[] do NOT.
 *
 * Used for destructive workspace-level actions (delete organisation, etc).
 */
const requireOrgOwner = async (req, res, next) => {
  try {
    const orgId =
      req.params.id ||
      req.params.orgId ||
      req.body.orgId ||
      req.query.org;

    if (!orgId) {
      return res.status(400).json({ error: 'Organisation ID required' });
    }

    const org = await Organisation.findById(orgId);
    if (!org) {
      return res.status(404).json({ error: 'Organisation not found' });
    }

    if (org.admin.toString() !== req.user.userId) {
      return res.status(403).json({ error: 'Only the workspace owner can perform this action' });
    }

    req.org = org;
    return next();
  } catch (err) {
    console.error('requireOrgOwner error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

module.exports = { requireOrgAdmin, requireOrgOwner };
