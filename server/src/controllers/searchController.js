const Board = require('../models/Board');
const Task = require('../models/Task');
const Organisation = require('../models/Organisation');
const { resolveAccess } = require('../utils/permissions');

/**
 * GET /api/search?q=:query&org=:orgId
 *
 * Searches boards by name and tasks by name, across the boards THIS caller may
 * READ — and nothing else.
 *
 * The old gate was `isAdmin ? {} : { visibility: 'public' }`, and it was wrong in
 * both directions. It handed org admins every PRIVATE board in the workspace,
 * including boards nobody had granted them, so search was a back door straight
 * around board access — the board itself would refuse them, its tasks came back
 * in the search results anyway. And it hid the private boards that HAD been
 * shared with the caller, so the boards they were entitled to were the ones
 * search would not find. Read access now decides both, exactly as it does on the
 * board itself.
 *
 * Returns: { boards: [...], tasks: [...] }
 */
const search = async (req, res) => {
  try {
    const { q, org: orgId } = req.query;

    if (!q || !q.trim()) return res.json({ boards: [], tasks: [] });
    if (!orgId) return res.status(400).json({ error: 'Organisation ID required' });

    const userId = req.user.userId;

    const org = await Organisation.findById(orgId);
    if (!org) return res.status(404).json({ error: 'Organisation not found' });

    const isMember = org.members.some((m) => m.toString() === userId);
    if (!isMember) {
      return res.status(403).json({ error: 'Not a member of this organisation' });
    }

    // Orgs created before the role system carry no `roles`, and the resolver
    // fails closed with nothing to resolve against — which would silently return
    // zero results rather than the caller's boards. Seed on first touch.
    if (org.ensureSystemRoles()) await org.save();

    // Escape special regex characters to prevent ReDoS
    const escaped = q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const queryRegex = new RegExp(escaped, 'i');

    // Resolve access per board rather than filtering on `visibility` in Mongo. A
    // private board shared with the caller IS readable; a public board is NOT
    // readable by a Guest, whose role withholds `board.view_public`. Only the
    // resolver knows the difference, so the boards come back unfiltered and the
    // resolver picks.
    const orgBoards = await Board.find({ organisation: orgId })
      .select('name visibility publicDefaultLevel memberAccess createdBy')
      .lean();
    const readableBoards = orgBoards.filter(
      (b) => resolveAccess(b, org, userId).canRead
    );

    const boards = readableBoards
      .filter((b) => queryRegex.test(b.name))
      .slice(0, 10)
      .map((b) => ({ _id: b._id, name: b.name, visibility: b.visibility }));

    const tasks = await Task.find({
      board: { $in: readableBoards.map((b) => b._id) },
      name: queryRegex,
      isPersonal: { $ne: true },
    })
      .select('name status priority board labels')
      .populate('board', 'name statuses labels')
      .limit(20)
      .lean();

    return res.json({ boards, tasks });
  } catch (err) {
    console.error('search error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

module.exports = { search };
