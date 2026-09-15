const Organisation = require('../models/Organisation');
const { resolveOrgAccess } = require('../utils/permissions');
const { buildAnalytics, VALID_RANGES } = require('../services/analyticsReport');

/**
 * GET /api/analytics?org=:orgId&board=:boardId&range=:range
 *
 * Requires `analytics.view`, and reports ONLY over the boards the caller can
 * read. Those are two separate questions: the capability buys you the report,
 * it does not buy you the boards.
 *
 * This handler is now only the HTTP half: read the query string, load the org,
 * check membership, check the capability, decide what this caller is allowed to
 * be told about other people, and translate the result into a response. Every
 * aggregation that used to live inline moved to `services/analyticsReport.js`
 * when the executive home's "workspace numbers" section became a second caller
 * of the same figures — see that file's header for why a second copy of them
 * was not an option. The response bytes are unchanged.
 */
const getAnalytics = async (req, res) => {
  try {
    const userId = req.user.userId;
    const orgId = req.query.org;
    const boardFilter = req.query.board && req.query.board !== 'all'
      ? req.query.board
      : null;
    const range = VALID_RANGES.includes(req.query.range)
      ? req.query.range
      : '30d';

    if (!orgId) {
      return res.status(400).json({ error: 'Organisation ID required' });
    }

    // `members` is populated here rather than in the service because the
    // service names overdue assignees off this list — an unpopulated ref would
    // turn every person in the breakdown into "Unknown".
    const org = await Organisation.findById(orgId)
      .populate('members', 'name email profilePic');
    if (!org) return res.status(404).json({ error: 'Organisation not found' });

    // Membership was never checked here — the old admin gate implied it. Under
    // the role model it does not: an unknown user resolves to the DEFAULT role,
    // which holds `analytics.view`, so without this any authenticated user could
    // read any org's analytics by passing its id. `members` is populated, so
    // compare on `_id`.
    const isMember = (org.members || []).some(
      (m) => (m._id || m).toString() === userId
    );
    if (!isMember) {
      return res.status(403).json({ error: 'Not a member of this workspace' });
    }

    // Orgs created before the role system carry no `roles`, and the resolver
    // fails closed with nothing to resolve against. Seed on first touch.
    if (org.ensureSystemRoles()) await org.save();

    const orgAccess = resolveOrgAccess(org, userId);
    if (!orgAccess.can('analytics.view')) {
      return res
        .status(403)
        .json({ error: 'You do not have permission to view analytics' });
    }
    // Resolved HERE, once, and passed in: the service withholds the named
    // per-assignee breakdown on this flag alone and never re-asks the role
    // system who is calling. Every caller of `buildAnalytics` therefore has to
    // make this decision deliberately for the person it is reporting to.
    const canSeeOthers = orgAccess.can('productivity.view_others');

    const report = await buildAnalytics({
      org,
      userId,
      range,
      boardFilter,
      canSeeOthers,
    });
    // The service answers with EITHER the payload or a refusal about the
    // caller's input — the board-filter 400 and 404 that used to be `res.status`
    // calls inside the aggregation body. They come back as data rather than as
    // exceptions so they stay a 400 and a 404: thrown, they would land in the
    // catch below, which exists for genuine faults and answers 500.
    if (report.error) {
      return res.status(report.status).json({ error: report.error });
    }
    return res.json(report);
  } catch (err) {
    console.error('getAnalytics error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

module.exports = {
  getAnalytics,
};
