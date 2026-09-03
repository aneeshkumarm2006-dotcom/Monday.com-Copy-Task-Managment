const mongoose = require('mongoose');
const Board = require('../models/Board');
const Task = require('../models/Task');
const TaskGroup = require('../models/TaskGroup');
const Update = require('../models/Update');
const Note = require('../models/Note');
const Notification = require('../models/Notification');
const ItemFollow = require('../models/ItemFollow');
const Automation = require('../models/Automation');
const Tracker = require('../models/Tracker');
const TrackerEntry = require('../models/TrackerEntry');
const Goal = require('../models/Goal');
const AdsBudget = require('../models/AdsBudget');
const GoalReminder = require('../models/GoalReminder');
const BoardConnector = require('../models/BoardConnector');
const ConnectorProject = require('../models/ConnectorProject');
const ConnectorFieldMapping = require('../models/ConnectorFieldMapping');
const GoalConnectorLink = require('../models/GoalConnectorLink');
const Organisation = require('../models/Organisation');
const User = require('../models/User');
const { isBoardCreator } = require('../utils/boardAccess');
const { loadBoardContext, requireCapability } = require('../utils/boardContext');
const { resolveAccess, resolveOrgAccess } = require('../utils/permissions');
const { BOARD_LEVELS } = require('../utils/capabilities');
const { isGoalVocabulary, GOAL_VOCABULARY_KEYS } = require('../utils/goalTypes');
const { isBoardType } = require('../utils/boardTypes');
const { isValidTimezone } = require('../utils/tzDay');
const { monthKeyOf } = require('../utils/monthKey');
const { createNotification } = require('../services/notificationService');
const { requireFeature } = require('../utils/userFeatures');
const { cascadeDeleteVaults } = require('../services/vaultCascade');

const VALID_VISIBILITIES = ['public', 'private'];

// Escape user text so it can be used as a literal in a RegExp (for the
// case-insensitive duplicate-name check). Mirrors searchController's ReDoS guard.
const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * The rungs a per-board grant may name: the ladder itself, plus `none` to revoke
 * and the legacy `read` spelling of `view`, which grants written before the
 * ladder existed still carry (`normaliseLevel` folds it in, so they keep working
 * with no data migration).
 */
const VALID_ACCESS_LEVELS = [...BOARD_LEVELS, 'read'];

/**
 * Confirm the user is a member of the org. Returns the org doc or null.
 */
const loadOrgForMember = async (orgId, userId) => {
  const org = await Organisation.findById(orgId);
  if (!org) return { org: null, isMember: false };
  // An org created before the role system carries no `roles`, so every
  // capability would resolve to false and its members would open an empty
  // workspace. Seed on first touch — the same lazy heal requireCapability does.
  if (org.ensureSystemRoles()) await org.save();
  const isMember = org.members.some((m) => m.toString() === userId);
  return { org, isMember };
};

/**
 * The shared board context (../utils/boardContext), behind the id-shape check
 * these routes rely on to answer 400 rather than letting Mongoose's cast blow up
 * into a 500. Every permission decision lives in the context it returns.
 */
const loadBoard = async (boardId, userId) => {
  if (!boardId || !mongoose.Types.ObjectId.isValid(boardId)) {
    return { status: 400, error: 'Invalid board id' };
  }
  return loadBoardContext(boardId, userId);
};

/**
 * Which of the org's boards this user may see at all.
 *
 * `board.view_all_private` is the override that opens every private board to a
 * role. Without `board.view_public` — a Guest — public boards are not visible
 * either, so only authorship or an explicit grant lets them in.
 *
 * THIS FILTER AND `resolveAccess` MUST AGREE. Whatever the list shows has to be
 * openable, and whatever is openable has to be listed — a board that resolves to
 * full access but never appears in `GET /api/boards` is unreachable in the UI,
 * which is precisely how a private board became un-administerable.
 */
const boardVisibilityFilter = (access, userId) => {
  // The org owner holds every board in their workspace outright (see
  // `boardCapabilities`), so there is nothing to filter. `{}` is scoped by the
  // caller's `organisation` clause, never a workspace-wide wildcard.
  if (access.isOwner) return {};

  const clauses = [{ createdBy: userId }, { 'memberAccess.user': userId }];
  if (access.can('board.view_public')) {
    clauses.unshift({ visibility: 'public' });
  }
  // The private override is ADDITIVE, not a wildcard. Returning `{}` here would
  // also hand back every PUBLIC board — including to a role that lacks
  // `board.view_public` and which `resolveAccess` therefore refuses to let into a
  // public board at all. This filter and resolveAccess have to agree: whatever the
  // list shows must be openable, or a Guest with the override ticked on sees
  // boards in their sidebar that 403 the moment they click.
  if (access.can('board.view_all_private')) {
    clauses.push({ visibility: 'private' });
  }
  return { $or: clauses };
};

// The User fields a board's byline needs. `createdBy` is shipped POPULATED on
// every board the client caches, so the header can name the owner without a
// second round-trip and without guessing at the org roster (which does not
// contain everyone a private board's owner might be).
//
// Populating it is safe everywhere it is read: `idOf` in utils/permissions.js
// and utils/boardAccess.js already accepts either shape, which is what makes
// "the creator owns their board" keep working with a User document sitting in
// that slot instead of an id.
const CREATOR_FIELDS = 'name profilePic email';

/**
 * Attach this user's resolved capability set to a board, for the client.
 *
 * The client renders affordances from this rather than reconstructing permission
 * from `memberAccess` + a local guess at admin-ness. Hiding a button is a
 * courtesy, never a control — every capability here is enforced independently on
 * the write path — but a courtesy that disagrees with the server is worse than
 * none, because the user clicks and gets a 403.
 */
const withPermissions = (board, org, userId) => {
  const access = resolveAccess(board, org, userId);
  return {
    ...board.toObject(),
    permissions: {
      capabilities: [...access.capabilities],
      level: access.level,
      canRead: access.canRead,
      readOnly: access.readOnly,
      isBoardOwner: access.board.creator,
      canViewAccess: access.canViewAccess,
      canManageAccess: access.canManageAccess,
    },
  };
};

const DEFAULT_STATUSES = [
  { key: 'not_started',   name: 'Not Started',   color: '#6B7280', order: 0, isDefault: true  },
  { key: 'working_on_it', name: 'Working on it', color: '#D97706', order: 1, isDefault: false },
  { key: 'done',          name: 'Done',          color: '#16A34A', order: 2, isDefault: false },
  { key: 'stuck',         name: 'Stuck',         color: '#DC2626', order: 3, isDefault: false },
];

/**
 * Compute a completion percentage for each board in `boards`.
 *
 * "Done" is board-relative: each board owns its own `statuses`, and the done
 * rung is the subdoc with `key === 'done'` (its `_id` is unique to that board,
 * so a task's status id maps back to exactly one board — no cross-board
 * leakage). We count only the rows a user actually sees in the board view:
 * top-level (`parent: null`), non-personal tasks. Subitems and personal tasks
 * are excluded so the number matches the visible task list.
 *
 * Returns a Map of boardId → { taskCount, doneCount, progress } that the caller
 * merges into each board's payload.
 *
 * On a TRACKER board this counts the CURRENT month only — see the scope clause
 * below. Callers must therefore pass full board documents (`boardType` and
 * `monthTimezone`), not a lean projection.
 */
const computeBoardProgress = async (boards) => {
  const result = new Map();
  const boardIds = boards.map((b) => b._id);
  for (const b of boards) {
    result.set(b._id.toString(), { taskCount: 0, doneCount: 0, progress: 0 });
  }
  if (boardIds.length === 0) return result;

  // Every board's done-status id, flattened. Each id is unique to its board,
  // so matching a task's status against this set is already board-scoped.
  const doneStatusIds = [];
  for (const b of boards) {
    for (const s of b.statuses || []) {
      if (s.key === 'done') doneStatusIds.push(s._id);
    }
  }

  // A TRACKER board's progress is THIS MONTH's progress, not its lifetime's.
  //
  // Counting every task a retainer board has ever held would mean the card on My
  // Boards showed a percentage over three years of work, which drifts towards a
  // meaningless constant and never reflects what the team is actually doing —
  // and it would contradict the board itself, which shows one month at a time.
  // Each tracker board therefore gets its own `board + monthKey` clause, in the
  // board's own timezone; standard and client boards keep the lifetime count
  // they have always had.
  const monthlyClauses = [];
  const standardIds = [];
  for (const b of boards) {
    if (b.boardType === 'tracker') {
      const monthKey = monthKeyOf(new Date(), b.monthTimezone || 'UTC');
      monthlyClauses.push({ board: b._id, monthKey });
    } else {
      standardIds.push(b._id);
    }
  }

  const scopeClause = monthlyClauses.length === 0
    ? { board: { $in: standardIds } }
    : { $or: [...(standardIds.length ? [{ board: { $in: standardIds } }] : []), ...monthlyClauses] };

  const baseMatch = {
    ...scopeClause,
    isPersonal: { $ne: true },
    parent: null,
  };

  const [totals, dones] = await Promise.all([
    Task.aggregate([
      { $match: baseMatch },
      { $group: { _id: '$board', count: { $sum: 1 } } },
    ]),
    // Also match the legacy string 'done' so pre-migration board tasks (whose
    // status was the enum string, not a status _id) still count as complete.
    Task.aggregate([
      {
        $match: {
          ...baseMatch,
          status: { $in: [...doneStatusIds, 'done'] },
        },
      },
      { $group: { _id: '$board', count: { $sum: 1 } } },
    ]),
  ]);

  for (const row of totals) {
    const entry = result.get(row._id.toString());
    if (entry) entry.taskCount = row.count;
  }
  for (const row of dones) {
    const entry = result.get(row._id.toString());
    if (entry) entry.doneCount = row.count;
  }
  for (const entry of result.values()) {
    entry.progress =
      entry.taskCount === 0
        ? 0
        : Math.round((entry.doneCount / entry.taskCount) * 100);
  }
  return result;
};

/**
 * GET /api/boards?org=:orgId
 *
 * The boards this member's ROLE reaches — see `boardVisibilityFilter`. Sorted by
 * order, then updatedAt desc.
 */
/**
 * GET /api/boards/:id — one board, by id alone.
 *
 * The list endpoint above is scoped to an organisation, which meant a board
 * could only ever be resolved by first knowing which workspace it lived in.
 * Deep links do not know that: a link out of an email lands on /boards/:id
 * with whatever workspace the reader happened to have selected, and if the
 * board belongs to a different one it was never in the list, the page waited
 * for a document that could not arrive, and it sat on "Loading…" forever.
 *
 * Access is resolved from the BOARD's own organisation rather than from a
 * caller-supplied `org`, so the two-layer AND still applies exactly as it does
 * in the list: you must be a member of the owning workspace, and the board
 * must survive the same visibility filter. A board you may not see returns
 * 403, not a silent empty page.
 */
const getBoard = async (req, res) => {
  try {
    const userId = req.user.userId;
    const boardId = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(boardId)) {
      return res.status(404).json({ error: 'Board not found' });
    }

    const board = await Board.findById(boardId).populate('createdBy', CREATOR_FIELDS);
    if (!board) return res.status(404).json({ error: 'Board not found' });

    const { org, isMember } = await loadOrgForMember(board.organisation, userId);
    if (!org) return res.status(404).json({ error: 'Board not found' });
    if (!isMember) {
      return res.status(403).json({ error: 'Not a member of this workspace' });
    }

    // Same rule as the list, applied to this one board: re-querying with the
    // visibility filter keeps the two in step rather than restating it here.
    const orgAccess = resolveOrgAccess(org, userId);
    const visible = await Board.exists({
      _id: board._id,
      ...boardVisibilityFilter(orgAccess, userId),
    });
    if (!visible) {
      return res.status(403).json({ error: 'You do not have access to this board' });
    }

    // Same lazy heal the list does for pre-migration boards.
    if (!Array.isArray(board.statuses) || board.statuses.length === 0) {
      board.statuses = DEFAULT_STATUSES.map((s) => ({ ...s }));
      if (!Array.isArray(board.labels)) board.labels = [];
      await board.save();
    }

    const progressByBoard = await computeBoardProgress([board]);
    return res.json({
      board: {
        ...withPermissions(board, org, userId),
        ...(progressByBoard.get(board._id.toString()) || {
          taskCount: 0,
          doneCount: 0,
          progress: 0,
        }),
      },
    });
  } catch (err) {
    console.error('getBoard error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

const getBoards = async (req, res) => {
  try {
    const orgId = req.query.org;
    if (!orgId) {
      return res.status(400).json({ error: 'Organisation ID required' });
    }

    const userId = req.user.userId;
    const { org, isMember } = await loadOrgForMember(orgId, userId);
    if (!org) return res.status(404).json({ error: 'Organisation not found' });
    if (!isMember) {
      return res.status(403).json({ error: 'Not a member of this workspace' });
    }

    // What you see is your ROLE's reach, not your position in an admins array:
    // public boards only if the role holds `board.view_public` (a Guest does
    // not), every private board only if it holds `board.view_all_private` (off by
    // default, admins included) — plus, always, the boards you created or were
    // granted.
    const orgAccess = resolveOrgAccess(org, userId);
    const boards = await Board.find({
      organisation: orgId,
      ...boardVisibilityFilter(orgAccess, userId),
    })
      .sort({ order: 1, updatedAt: -1 })
      .populate('createdBy', CREATOR_FIELDS);

    // Lazy heal: pre-migration boards may have an empty `statuses` array,
    // which causes the client's status picker to fall back to legacy enum
    // options that the task API can't resolve. Seed defaults on first read.
    for (const board of boards) {
      if (!Array.isArray(board.statuses) || board.statuses.length === 0) {
        board.statuses = DEFAULT_STATUSES.map((s) => ({ ...s }));
        if (!Array.isArray(board.labels)) board.labels = [];
        await board.save();
      }
    }

    // Per-board completion percentage, shown on each card in the My Boards grid.
    const progressByBoard = await computeBoardProgress(boards);

    // Ship each board's RESOLVED permissions with it — the two-layer AND already
    // applied, for this user, on this board.
    //
    // Without this the client has no way to know what it may do on a given board
    // except to re-derive it from `memberAccess` + its own idea of what an admin
    // is, which is precisely the drift this whole system exists to remove. The
    // resolver is pure, so this costs nothing beyond the boards already loaded.
    return res.json({
      boards: boards.map((b) => ({
        ...withPermissions(b, org, userId),
        ...(progressByBoard.get(b._id.toString()) || {
          taskCount: 0,
          doneCount: 0,
          progress: 0,
        }),
      })),
    });
  } catch (err) {
    console.error('getBoards error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Resolve the ObjectIds of all "done" statuses across an org's boards.
 * Used by analytics aggregations that previously matched the enum string
 * `'done'` directly.
 */
const findDoneStatusIdsForOrg = async (orgId) => {
  const boards = await Board.find({ organisation: orgId })
    .select('_id statuses')
    .lean();
  const ids = [];
  for (const b of boards) {
    for (const s of b.statuses || []) {
      if (s.key === 'done') ids.push(s._id);
    }
  }
  return ids;
};

/**
 * GET /api/dashboard/stats?org=:orgId
 *
 * Returns: { totalBoards, completedTasks, pendingTasks, myPendingTasks,
 *            myOverdueTasks, completionRate }
 *
 * This is the HOME dashboard, not the analytics page: it was open to every
 * member before the capability model existed and stays that way, so it carries
 * no `analytics.view` gate. What it must not do is roll up boards the caller
 * cannot open — the counts were org-wide, which leaked the shape of private
 * boards (how many, how much work in them) to anyone who could load the home
 * page. So the aggregation is scoped per board by the same resolver that decides
 * whether they may open it: everyone gets a dashboard, of their own boards only.
 */
const getDashboardStats = async (req, res) => {
  try {
    const orgId = req.query.org;
    if (!orgId) {
      return res.status(400).json({ error: 'Organisation ID required' });
    }

    const userId = req.user.userId;
    const { org, isMember } = await loadOrgForMember(orgId, userId);
    if (!org) return res.status(404).json({ error: 'Organisation not found' });
    if (!isMember) {
      return res.status(403).json({ error: 'Not a member of this workspace' });
    }

    // Only the fields `resolveAccess` reads — a query that omitted any of them
    // would resolve every board to no access and hand back an empty dashboard.
    const orgBoards = await Board.find({ organisation: orgId }).select(
      'visibility publicDefaultLevel memberAccess createdBy organisation'
    );
    const readableBoardIds = orgBoards
      .filter((board) => resolveAccess(board, org, userId).canRead)
      .map((board) => board._id);
    const taskFilter = {
      board: { $in: readableBoardIds },
      isPersonal: { $ne: true },
    };

    const doneStatusIds = await findDoneStatusIdsForOrg(orgId);
    const notDoneStatus = {
      $nin: doneStatusIds.length ? doneStatusIds : ['done'],
    };

    // "Overdue" is scoped to the CALLER, not the workspace: a number you can
    // act on beats a number you can only read, and it is the one the Pending
    // card's sub-line and the greeting both quote. Midnight is taken in the
    // server's zone — the same approximation the dueSoon poller has always
    // used, and a few hours' drift on a "how late am I" figure is invisible.
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [completedTasks, pendingTasks, myPendingTasks, myOverdueTasks] = await Promise.all([
      Task.countDocuments({
        ...taskFilter,
        status: { $in: doneStatusIds.length ? doneStatusIds : ['done'] },
      }),
      Task.countDocuments({
        ...taskFilter,
        status: notDoneStatus,
      }),
      // "Tasks waiting" in the greeting mirrors My Work: not-done tasks assigned
      // to the caller (same board scope). Kept separate from the workspace-wide
      // `pendingTasks` above, which the Pending Tasks / Completion Rate cards use.
      Task.countDocuments({
        ...taskFilter,
        assignedTo: new mongoose.Types.ObjectId(userId),
        status: notDoneStatus,
      }),
      Task.countDocuments({
        ...taskFilter,
        assignedTo: new mongoose.Types.ObjectId(userId),
        status: notDoneStatus,
        dueDate: { $ne: null, $lt: startOfToday },
      }),
    ]);
    const totalBoards = readableBoardIds.length;

    const totalTasks = completedTasks + pendingTasks;
    const completionRate =
      totalTasks === 0 ? 0 : Math.round((completedTasks / totalTasks) * 100);

    return res.json({
      totalBoards,
      completedTasks,
      pendingTasks,
      myOverdueTasks,
      myPendingTasks,
      completionRate,
    });
  } catch (err) {
    console.error('getDashboardStats error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/boards
 *
 * Body: { name, visibility, organisation }
 * Requires `board.create`. ORG-scoped, and the one board capability that has to
 * be: there is no board yet to resolve access against. Validates input, attaches
 * orgId and createdBy. New boards are seeded with the four default statuses so
 * the existing UI flow (StatusMenu / Chip) keeps working.
 */
const createBoard = async (req, res) => {
  try {
    const userId = req.user.userId;
    const {
      name,
      visibility = 'private',
      organisation,
      description = '',
      boardType = 'standard',
      portalCategories,
      monthTimezone,
    } = req.body;

    if (!organisation) {
      return res.status(400).json({ error: 'Organisation ID required' });
    }
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Board name is required' });
    }
    if (!isBoardType(boardType)) {
      return res.status(400).json({ error: 'Invalid board type' });
    }
    // A tracker board must know whose calendar defines its months. Not defaulted
    // to UTC on purpose — see the comment on `Board.monthTimezone`. The client
    // sends its resolved browser zone; anything Intl cannot parse is refused
    // here rather than silently filing every boundary task in the wrong month.
    if (boardType === 'tracker' && !isValidTimezone(monthTimezone)) {
      return res.status(400).json({
        error: 'A valid timezone is required for a tracker board',
      });
    }
    // A client-portal board is always internally private — the client plane sits
    // on top of a private board, so we ignore any visibility the client sent and
    // pin it to 'private'. Standard and tracker boards validate visibility as
    // before: a tracker board is an ordinary internal board that happens to be
    // partitioned, so it may be public if the team wants it to be.
    const effectiveVisibility = boardType === 'client' ? 'private' : visibility;
    if (!VALID_VISIBILITIES.includes(effectiveVisibility)) {
      return res.status(400).json({ error: 'Invalid visibility value' });
    }
    // Categories are only meaningful on client boards; sanitize to non-empty strings.
    const cleanPortalCategories =
      boardType === 'client' && Array.isArray(portalCategories)
        ? portalCategories
            .map((c) => (typeof c === 'string' ? c.trim() : ''))
            .filter(Boolean)
            .slice(0, 30)
        : [];

    const { org, isMember } = await loadOrgForMember(organisation, userId);
    if (!org) return res.status(404).json({ error: 'Organisation not found' });
    // Membership was never checked here: the old gate was `isOrgAdmin`, which
    // failed closed for outsiders by accident. Capabilities resolve to the
    // default role for anyone, so the check has to be explicit.
    if (!isMember) {
      return res.status(403).json({ error: 'Not a member of this workspace' });
    }
    if (!resolveOrgAccess(org, userId).can('board.create')) {
      return res
        .status(403)
        .json({ error: 'You do not have permission to create boards' });
    }

    // Reject a duplicate board name within the same organisation (case-insensitive)
    // so the sidebar never shows two boards the user can't tell apart.
    const trimmedName = name.trim();
    const duplicate = await Board.findOne({
      organisation,
      name: new RegExp(`^${escapeRegExp(trimmedName)}$`, 'i'),
    })
      .select('_id')
      .lean();
    if (duplicate) {
      return res.status(409).json({
        error: `A board named "${trimmedName}" already exists. Please choose a different name.`,
      });
    }

    const lastBoard = await Board.findOne({ organisation })
      .sort({ order: -1 })
      .select('order')
      .lean();
    const nextBoardOrder = (lastBoard?.order ?? -1) + 1;

    const board = await Board.create({
      name: name.trim(),
      description: typeof description === 'string' ? description.trim() : '',
      visibility: effectiveVisibility,
      boardType,
      portalCategories: cleanPortalCategories,
      monthTimezone: boardType === 'tracker' ? monthTimezone : null,
      organisation,
      createdBy: userId,
      order: nextBoardOrder,
      statuses: DEFAULT_STATUSES.map((s) => ({ ...s })),
      labels: [],
      columns: [],
      useFlexibleColumns: false,
      goalColumns: [],
    });

    // Attach the creator's resolved permissions, as getBoards does. The client
    // prepends this to its cache and may open it straight away without a
    // refetch; a bare board would leave `permissions` undefined, hiding the
    // owner's own Share/manage controls until the next full boards load. The
    // byline is hydrated for the same reason — the cached copy is what the
    // header reads.
    await board.populate('createdBy', CREATOR_FIELDS);
    return res.status(201).json({ board: withPermissions(board, org, userId) });
  } catch (err) {
    console.error('createBoard error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * PUT /api/boards/:id
 *
 * Body: { name?, visibility?, description?, publicDefaultLevel? }
 *
 * Gated PER FIELD, because a custom role is free to hold one of these and not the
 * other and the matrix is a first-class feature:
 *
 *   name, description                 → `board.rename`
 *   visibility, publicDefaultLevel    → `board.change_visibility`
 *
 * `publicDefaultLevel` is the rung a public board opens to the org, so it is the
 * same lifecycle decision as flipping the board public in the first place. Neither
 * is conferred by any rung on the ladder: only the board's owner, and roles that
 * manage public boards, hold `board.change_visibility`. A capability is demanded
 * only for the fields the request actually carries — gating the whole handler on
 * `board.rename` rejected a visibility-only PUT from someone entitled to make it.
 */
const updateBoard = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    const {
      name, visibility, description, publicDefaultLevel, goalVocabulary,
    } = req.body;

    const ctx = await loadBoard(id, userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    const { board } = ctx;

    const changesNaming =
      typeof name === 'string' || typeof description === 'string';
    if (changesNaming) {
      const denied = requireCapability(
        ctx,
        'board.rename',
        'You do not have permission to edit this board'
      );
      if (denied) return res.status(denied.status).json({ error: denied.error });
    }

    const changesVisibility =
      typeof visibility === 'string' || typeof publicDefaultLevel === 'string';
    if (changesVisibility && !ctx.can('board.change_visibility')) {
      return res.status(403).json({
        error: "You do not have permission to change this board's visibility",
      });
    }

    if (typeof name === 'string') {
      if (!name.trim()) {
        return res.status(400).json({ error: 'Board name cannot be empty' });
      }
      board.name = name.trim();
    }
    if (typeof visibility === 'string') {
      if (!VALID_VISIBILITIES.includes(visibility)) {
        return res.status(400).json({ error: 'Invalid visibility value' });
      }
      board.visibility = visibility;
    }
    if (typeof publicDefaultLevel === 'string') {
      // The ladder only — `read` is accepted on a member's GRANT for backwards
      // compatibility, but there is no legacy `publicDefaultLevel` to honour.
      if (!BOARD_LEVELS.includes(publicDefaultLevel)) {
        return res.status(400).json({ error: 'Invalid public access level' });
      }
      board.publicDefaultLevel = publicDefaultLevel;
    }
    if (typeof description === 'string') {
      board.description = description.trim();
    }

    /**
     * The Goals tab's WORDING for this board — see `Board.goalVocabulary`.
     *
     * THE BOARD'S OWNER SETS THIS, which is `canManageAccess`: the creator, a
     * member the creator granted full access, and the matrix overrides that
     * resolve to owner-equivalent. Deliberately NOT the two neighbouring gates,
     * both of which were considered:
     *
     *   `org.manage_settings` — what goal COLUMNS use, because a column is a
     *     reporting field an agency compares clients across. Wording is not:
     *     an Ads board calling a type "Target" while an SEO board calls it
     *     "Move a number" is the POINT, so routing it through an org admin
     *     makes the org sign off on a decision that belongs to the board.
     *   `goal.manage` — held by every member at the `edit` rung, so any of them
     *     could rename the type cards under everyone else on the board.
     *
     * Empty string means "back to the default wording" and is stored as null,
     * so there is one representation of the default rather than two that both
     * have to be checked for. An unknown key is REFUSED here even though
     * `describeGoalTypes` would fall back to the default for it — a typo that
     * silently does nothing is worse at the point of writing than at the point
     * of reading, where falling back keeps a stale client working.
     */
    if (goalVocabulary !== undefined) {
      if (!ctx.access?.canManageAccess) {
        return res.status(403).json({
          error: 'Goal wording applies to the whole board, so only the board '
            + 'owner can change it.',
        });
      }
      if (goalVocabulary === null || goalVocabulary === '') {
        board.goalVocabulary = null;
      } else if (typeof goalVocabulary !== 'string' || !isGoalVocabulary(goalVocabulary)) {
        return res.status(400).json({
          error: `Unknown goal wording. Available: ${GOAL_VOCABULARY_KEYS.join(', ')}.`,
        });
      } else {
        board.goalVocabulary = goalVocabulary;
      }
    }

    await board.save();
    await board.populate('createdBy', CREATOR_FIELDS);
    // Re-resolve permissions off the saved board so the client's cached copy
    // keeps them (and reflects a visibility change): the store writes this
    // response over the board it holds, and a bare board would strip the
    // owner's Share/manage controls until a full boards refetch.
    return res.json({ board: withPermissions(board, ctx.org, userId) });
  } catch (err) {
    console.error('updateBoard error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * DELETE /api/boards/:id
 *
 * Requires `board.delete`, which is resolved against the board itself — so an
 * admin can no longer delete a private board they cannot even open, and the
 * board's own creator no longer needs to be an org admin to delete it.
 * Cascade deletes all TaskGroups, Tasks and Updates belonging to this board.
 */
const deleteBoard = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;

    const ctx = await loadBoard(id, userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

    const denied = requireCapability(
      ctx,
      'board.delete',
      'You do not have permission to delete this board'
    );
    if (denied) return res.status(denied.status).json({ error: denied.error });

    const taskIds = await Task.distinct('_id', { board: id });
    if (taskIds.length > 0) {
      await Update.deleteMany({ task: { $in: taskIds } });
      await Notification.deleteMany({ task: { $in: taskIds } });
      await ItemFollow.deleteMany({ task: { $in: taskIds } });
    }
    // Board-scoped notifications (e.g. `invited`) carry no task ref.
    await Notification.deleteMany({ board: id });
    // Automations were NOT part of this cascade, so deleting a board orphaned
    // them — and the scheduler keeps picking up orphaned SCHEDULE automations
    // forever, spawning tasks against a board that no longer exists and emailing
    // their assignees. (orgCascade already deletes these on org teardown.)
    await Automation.deleteMany({ board: id });
    await Tracker.deleteMany({ board: id });
    await TrackerEntry.deleteMany({ board: id });
    // Tracker boards: the goals and the "reminder already sent" markers. The
    // goal COLUMNS need no cleanup — they are embedded on the board document
    // that is about to go.
    await Goal.deleteMany({ board: id });
    await GoalReminder.deleteMany({ board: id });
    // Ads budgets. Their `enabled` switch and currency are embedded on the
    // board document that is about to go, so only the rows need collecting.
    await AdsBudget.deleteMany({ board: id });
    // The connector links go with the goals they name, for the same reason the
    // field mappings below go with the columns they name: a link with no goal is
    // a dangling reference, not history worth keeping.
    await GoalConnectorLink.deleteMany({ board: id });
    // Group notes. They were missing from this cascade entirely — `Note` was
    // only ever deleted by groupController's DELETE GROUP, so removing a board
    // outright left every note on it orphaned in the collection forever. The
    // denormalised `board` field is exactly what makes this a one-liner.
    await Note.deleteMany({ board: id });
    // Connectors. The per-board enablement row goes with the board it describes;
    // the mirrored PROJECTS do not — they belong to the org's external account,
    // not to this board, and are simply unbound so they can be mapped elsewhere.
    // Deleting them would discard the ConnectorSnapshot rows they parent — the
    // only per-keyword rank history that will ever exist — in response to a
    // board being tidied away. The snapshots are untouched here for the same
    // reason: they hang off the PROJECT, not off this board.
    await BoardConnector.deleteMany({ board: id });
    // The field mappings go too, and for the opposite reason to the projects
    // below: a mapping names a `goalColumns[]._id` that lives ON this board
    // document, so once the board is gone it points at nothing and could never
    // be re-pointed. Keeping it would be keeping a dangling reference, not
    // keeping history.
    await ConnectorFieldMapping.deleteMany({ board: id });
    await ConnectorProject.updateMany(
      { board: id },
      { $set: { group: null, board: null, boundBy: null, boundAt: null } }
    );
    // The board vault: key material, item ciphertexts, the audit trail, and the
    // encrypted blobs behind any file items. See services/vaultCascade.js for
    // why a surviving vault is worse than the usual orphan.
    await cascadeDeleteVaults(id);
    await Task.deleteMany({ board: id });
    await TaskGroup.deleteMany({ board: id });
    await Board.deleteOne({ _id: id });

    return res.json({ success: true });
  } catch (err) {
    console.error('deleteBoard error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

// ---------------------------------------------------------------------------
// Labels + Statuses CRUD (column.manage)
// ---------------------------------------------------------------------------

/**
 * Shared write guard for any /labels or /statuses sub-route. Labels and statuses
 * are board STRUCTURE — the vocabulary every task is filed under — so they ride
 * on `column.manage`, the same capability that gates the columns they configure.
 */
const requireChipManage = async (req, res, what = 'labels and statuses') => {
  const ctx = await loadBoard(req.params.id, req.user.userId);
  if (ctx.error) {
    res.status(ctx.status).json({ error: ctx.error });
    return null;
  }
  const denied = requireCapability(
    ctx,
    'column.manage',
    `You do not have permission to manage this board's ${what}`
  );
  if (denied) {
    res.status(denied.status).json({ error: denied.error });
    return null;
  }
  return ctx;
};

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const sanitizeColor = (value, fallback = '#6B7280') => {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return HEX_RE.test(trimmed) ? trimmed : fallback;
};

const sanitizeName = (value) => {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, 60);
};

const nextOrder = (collection) =>
  collection.length === 0
    ? 0
    : Math.max(...collection.map((c) => c.order || 0)) + 1;

const serializeBoardChips = (board) => ({
  labels: (board.labels || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0)),
  statuses: (board.statuses || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0)),
});

// --- Labels ----------------------------------------------------------------

const listLabels = async (req, res) => {
  try {
    const ctx = await loadBoard(req.params.id, req.user.userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    return res.json({ labels: serializeBoardChips(ctx.board).labels });
  } catch (err) {
    console.error('listLabels error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

const addLabel = async (req, res) => {
  try {
    const ctx = await requireChipManage(req, res);
    if (!ctx) return;
    const { board } = ctx;
    const name = sanitizeName(req.body?.name);
    if (!name) return res.status(400).json({ error: 'Label name is required' });
    const color = sanitizeColor(req.body?.color);
    board.labels.push({ name, color, order: nextOrder(board.labels) });
    await board.save();
    return res.status(201).json({ labels: serializeBoardChips(board).labels });
  } catch (err) {
    console.error('addLabel error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

const updateLabel = async (req, res) => {
  try {
    const ctx = await requireChipManage(req, res);
    if (!ctx) return;
    const { board } = ctx;
    const { lid } = req.params;
    const label = board.labels.id(lid);
    if (!label) return res.status(404).json({ error: 'Label not found' });
    if (typeof req.body?.name === 'string') {
      const name = sanitizeName(req.body.name);
      if (!name) return res.status(400).json({ error: 'Label name cannot be empty' });
      label.name = name;
    }
    if (typeof req.body?.color === 'string') {
      label.color = sanitizeColor(req.body.color, label.color);
    }
    await board.save();
    return res.json({ labels: serializeBoardChips(board).labels });
  } catch (err) {
    console.error('updateLabel error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

const deleteLabel = async (req, res) => {
  try {
    const ctx = await requireChipManage(req, res);
    if (!ctx) return;
    const { board } = ctx;
    const { lid } = req.params;
    const label = board.labels.id(lid);
    if (!label) return res.status(404).json({ error: 'Label not found' });
    board.labels.pull({ _id: lid });
    await board.save();
    // Detach this label id from every task on the board.
    await Task.updateMany(
      { board: board._id },
      { $pull: { labels: lid } }
    );
    return res.json({ labels: serializeBoardChips(board).labels });
  } catch (err) {
    console.error('deleteLabel error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

const reorderLabels = async (req, res) => {
  try {
    const ctx = await requireChipManage(req, res);
    if (!ctx) return;
    const { board } = ctx;
    const orderedIds = Array.isArray(req.body?.orderedIds) ? req.body.orderedIds : [];
    const lookup = new Map(orderedIds.map((id, i) => [id.toString(), i]));
    for (const lab of board.labels) {
      const idx = lookup.get(lab._id.toString());
      if (idx !== undefined) lab.order = idx;
    }
    await board.save();
    return res.json({ labels: serializeBoardChips(board).labels });
  } catch (err) {
    console.error('reorderLabels error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

// --- Statuses --------------------------------------------------------------

const listStatuses = async (req, res) => {
  try {
    const ctx = await loadBoard(req.params.id, req.user.userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    return res.json({ statuses: serializeBoardChips(ctx.board).statuses });
  } catch (err) {
    console.error('listStatuses error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

const addStatus = async (req, res) => {
  try {
    const ctx = await requireChipManage(req, res);
    if (!ctx) return;
    const { board } = ctx;
    const name = sanitizeName(req.body?.name);
    if (!name) return res.status(400).json({ error: 'Status name is required' });
    const color = sanitizeColor(req.body?.color);
    board.statuses.push({
      name,
      color,
      order: nextOrder(board.statuses),
      key: null,
      isDefault: false,
    });
    await board.save();
    return res.status(201).json({ statuses: serializeBoardChips(board).statuses });
  } catch (err) {
    console.error('addStatus error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

const updateStatus = async (req, res) => {
  try {
    const ctx = await requireChipManage(req, res);
    if (!ctx) return;
    const { board } = ctx;
    const { sid } = req.params;
    const status = board.statuses.id(sid);
    if (!status) return res.status(404).json({ error: 'Status not found' });
    if (typeof req.body?.name === 'string') {
      const name = sanitizeName(req.body.name);
      if (!name) return res.status(400).json({ error: 'Status name cannot be empty' });
      status.name = name;
    }
    if (typeof req.body?.color === 'string') {
      status.color = sanitizeColor(req.body.color, status.color);
    }
    if (typeof req.body?.isDefault === 'boolean' && req.body.isDefault) {
      // Only one status can be the default; clear the others.
      for (const s of board.statuses) s.isDefault = false;
      status.isDefault = true;
    }
    await board.save();
    return res.json({ statuses: serializeBoardChips(board).statuses });
  } catch (err) {
    console.error('updateStatus error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

const deleteStatus = async (req, res) => {
  try {
    const ctx = await requireChipManage(req, res);
    if (!ctx) return;
    const { board } = ctx;
    const { sid } = req.params;
    const status = board.statuses.id(sid);
    if (!status) return res.status(404).json({ error: 'Status not found' });
    if (status.isDefault) {
      return res
        .status(400)
        .json({ error: 'Cannot delete the default status. Reassign another status as default first.' });
    }
    // Reassign any tasks currently using this status to the board's default.
    const fallback = board.statuses.find((s) => s.isDefault && s._id.toString() !== sid);
    if (fallback) {
      await Task.updateMany(
        { board: board._id, status: sid },
        { $set: { status: fallback._id } }
      );
    }
    board.statuses.pull({ _id: sid });
    await board.save();
    return res.json({ statuses: serializeBoardChips(board).statuses });
  } catch (err) {
    console.error('deleteStatus error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

const reorderStatuses = async (req, res) => {
  try {
    const ctx = await requireChipManage(req, res);
    if (!ctx) return;
    const { board } = ctx;
    const orderedIds = Array.isArray(req.body?.orderedIds) ? req.body.orderedIds : [];
    const lookup = new Map(orderedIds.map((id, i) => [id.toString(), i]));
    for (const s of board.statuses) {
      const idx = lookup.get(s._id.toString());
      if (idx !== undefined) s.order = idx;
    }
    await board.save();
    return res.json({ statuses: serializeBoardChips(board).statuses });
  } catch (err) {
    console.error('reorderStatuses error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

// --- Group tags (extra feature) ---------------------------------------------

/**
 * Write guard for the group-tag catalog. TWO gates, in this order:
 *
 *   1. `column.manage` — the tag vocabulary is board structure, exactly like
 *      labels and statuses, so it rides on the same capability they do.
 *   2. `features.groupTags` — the writer's own opt-in. Group tags are an EXTRA
 *      FEATURE, off for everyone until they switch it on, and a switch honoured
 *      only by hiding a button is decorative.
 *
 * Capability first on purpose: someone whose role cannot manage the board's
 * vocabulary is refused for that reason and never learns the feature exists.
 *
 * READS are not gated here at all. `board.groupTags` ships inside the ordinary
 * board payload — the client simply doesn't draw the chips while the feature is
 * off — so there is nothing to withhold and no extra round trip to add.
 */
const requireGroupTagManage = async (req, res) => {
  const ctx = await requireChipManage(req, res, 'group tags');
  if (!ctx) return null;
  const off = await requireFeature(
    req.user.userId,
    'groupTags',
    'Group tags are off. Turn them on in Settings → Extra features.'
  );
  if (off) {
    res.status(off.status).json({ error: off.error, code: off.code });
    return null;
  }
  return ctx;
};

const sortedGroupTags = (board) =>
  (board.groupTags || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));

const listGroupTags = async (req, res) => {
  try {
    const ctx = await loadBoard(req.params.id, req.user.userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    return res.json({ groupTags: sortedGroupTags(ctx.board) });
  } catch (err) {
    console.error('listGroupTags error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

const addGroupTag = async (req, res) => {
  try {
    const ctx = await requireGroupTagManage(req, res);
    if (!ctx) return;
    const { board } = ctx;
    const name = sanitizeName(req.body?.name);
    if (!name) return res.status(400).json({ error: 'Tag name is required' });
    board.groupTags.push({ name, color: sanitizeColor(req.body?.color), order: nextOrder(board.groupTags) });
    await board.save();
    return res.status(201).json({ groupTags: sortedGroupTags(board) });
  } catch (err) {
    console.error('addGroupTag error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

const updateGroupTag = async (req, res) => {
  try {
    const ctx = await requireGroupTagManage(req, res);
    if (!ctx) return;
    const { board } = ctx;
    const tag = board.groupTags.id(req.params.gtid);
    if (!tag) return res.status(404).json({ error: 'Tag not found' });
    if (typeof req.body?.name === 'string') {
      const name = sanitizeName(req.body.name);
      if (!name) return res.status(400).json({ error: 'Tag name cannot be empty' });
      tag.name = name;
    }
    if (typeof req.body?.color === 'string') {
      tag.color = sanitizeColor(req.body.color, tag.color);
    }
    await board.save();
    return res.json({ groupTags: sortedGroupTags(board) });
  } catch (err) {
    console.error('updateGroupTag error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

const deleteGroupTag = async (req, res) => {
  try {
    const ctx = await requireGroupTagManage(req, res);
    if (!ctx) return;
    const { board } = ctx;
    const { gtid } = req.params;
    if (!board.groupTags.id(gtid)) {
      return res.status(404).json({ error: 'Tag not found' });
    }
    board.groupTags.pull({ _id: gtid });
    await board.save();
    // Detach the dead id from every group, so nothing on the board still points
    // at a tag that no longer exists.
    await TaskGroup.updateMany({ board: board._id }, { $pull: { tags: gtid } });
    return res.json({ groupTags: sortedGroupTags(board) });
  } catch (err) {
    console.error('deleteGroupTag error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

const reorderGroupTags = async (req, res) => {
  try {
    const ctx = await requireGroupTagManage(req, res);
    if (!ctx) return;
    const { board } = ctx;
    const orderedIds = Array.isArray(req.body?.orderedIds) ? req.body.orderedIds : [];
    const lookup = new Map(orderedIds.map((id, i) => [id.toString(), i]));
    for (const tag of board.groupTags) {
      const idx = lookup.get(tag._id.toString());
      if (idx !== undefined) tag.order = idx;
    }
    await board.save();
    return res.json({ groupTags: sortedGroupTags(board) });
  } catch (err) {
    console.error('reorderGroupTags error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * PUT /api/boards/reorder
 *
 * Body: { organisation, orderedIds: [boardId,...] }
 * Reorders boards within an organisation. Any user who is a member of the
 * organisation can reorder boards (mirrors the read permission for getBoards).
 *
 * The visible set MUST be resolved with the same `boardVisibilityFilter` getBoards
 * lists from, on both the guard and the response. A second, hardcoded filter here
 * disagreed with it the moment roles arrived — a Guest (no `board.view_public`)
 * was handed a payload the guard then rejected as incomplete — and the reply
 * returned every board in the org, private ones included.
 */
const reorderBoards = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { organisation, orderedIds } = req.body || {};
    if (!organisation) {
      return res.status(400).json({ error: 'Organisation ID required' });
    }
    if (!Array.isArray(orderedIds)) {
      return res.status(400).json({ error: 'orderedIds must be an array' });
    }

    const { org, isMember } = await loadOrgForMember(organisation, userId);
    if (!org) return res.status(404).json({ error: 'Organisation not found' });
    if (!isMember) {
      return res.status(403).json({ error: 'Not a member of this workspace' });
    }

    const orgAccess = resolveOrgAccess(org, userId);
    const visibilityFilter = boardVisibilityFilter(orgAccess, userId);
    const currentIds = await Board.distinct('_id', { organisation, ...visibilityFilter });
    const currentSet = new Set(currentIds.map((id) => id.toString()));
    const orderedSet = new Set(orderedIds.map((id) => String(id)));
    // The `orderedSet.size` check is what rejects DUPLICATES. Comparing the raw
    // array's length against `currentIds` while membership-checking a de-duped Set
    // let `[a, a]` through for a two-board org: the bulk write then set a.order
    // twice and left b stranded at its old value, so two boards collided on the
    // same order. A true permutation needs all three conditions.
    if (
      orderedIds.length !== currentIds.length ||
      orderedSet.size !== orderedIds.length ||
      ![...orderedSet].every((id) => currentSet.has(id))
    ) {
      return res
        .status(400)
        .json({ error: 'orderedIds must list every visible board in the workspace exactly once' });
    }

    const ops = orderedIds.map((id, idx) => ({
      updateOne: {
        filter: { _id: id, organisation },
        update: { $set: { order: idx } },
      },
    }));
    if (ops.length > 0) await Board.bulkWrite(ops);

    const boards = await Board.find({
      organisation,
      ...visibilityFilter,
    }).sort({ order: 1, updatedAt: -1 });

    // Ship the same enriched shape getBoards does — resolved permissions and
    // per-board progress. The store overwrites its cache with this response, so
    // returning bare boards here would strip the ⋯ menu (permissions) and the
    // completion bar (progress) from every card the moment a board is dragged.
    const progressByBoard = await computeBoardProgress(boards);
    return res.json({
      boards: boards.map((b) => ({
        ...withPermissions(b, org, userId),
        ...(progressByBoard.get(b._id.toString()) || {
          taskCount: 0,
          doneCount: 0,
          progress: 0,
        }),
      })),
    });
  } catch (err) {
    console.error('reorderBoards error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * GET /api/boards/:id/connectable
 *
 * Boards a `connect_boards` column on this board may target: every OTHER board
 * in the same workspace the caller can actually REACH. F3 adds boards reachable
 * through an active WorkspaceGrant. The column list is included so the client
 * can offer source-column choices when building a mirror.
 *
 * The old filter widened to the whole org for `isAdmin`, which under the
 * capability model means "may restructure this board" — it would have handed
 * every board editor the name and columns of every private board in the org. The
 * connectable set is now exactly the set they may see, as in getBoards.
 *
 * Returns: { connectable: [{ board, workspace }] }
 */
const getConnectableBoards = async (req, res) => {
  try {
    const userId = req.user.userId;
    const ctx = await loadBoard(req.params.id, userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

    // The ORG access object, as in getBoards: `boardVisibilityFilter` asks which
    // boards a ROLE reaches, which is an org-level question. Passing the board
    // context worked only because it happens to expose a `can` too — one whose
    // board-scoped capabilities are AND'd against THIS board, not the ones being
    // listed.
    const orgAccess = resolveOrgAccess(ctx.org, userId);
    const boards = await Board.find({
      organisation: ctx.board.organisation,
      _id: { $ne: ctx.board._id },
      ...boardVisibilityFilter(orgAccess, userId),
    })
      .select('name visibility columns organisation')
      .sort({ order: 1, updatedAt: -1 })
      .lean();

    const workspace = {
      _id: ctx.org._id,
      name: ctx.org.displayName || ctx.org.name || 'Workspace',
    };
    const connectable = boards.map((board) => ({ board, workspace }));
    return res.json({ connectable });
  } catch (err) {
    console.error('getConnectableBoards error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

// ---------------------------------------------------------------------------
// The board's own roster
// ---------------------------------------------------------------------------

/**
 * GET /api/boards/:id/members
 *
 * The people who may be given work ON THIS BOARD: the org roster narrowed to
 * those `resolveAccess` lets READ it.
 *
 * Every picker on a board page — task assignees, the group owner, a `person`
 * column, a goal's owner — used to render the whole workspace, because the whole
 * workspace was the only roster the client had. On a PRIVATE board that listed
 * people who are not on it. Two things went wrong with that. The server refuses
 * those assignments (`validateAssignees` in taskController applies exactly the
 * rule below), so the extra names bought nothing but an error message after the
 * click; and the names themselves are a disclosure — the roster of a workspace,
 * offered from inside a board those people cannot open.
 *
 * The bar is READ, deliberately, and it has to stay in step with
 * `validateAssignees`: org member AND `canRead`. Narrower would hide people the
 * server would happily accept — a viewer can be handed a task, and often is.
 * Wider puts the names straight back.
 *
 * Gated on read access alone (`loadBoard` already 403s without it) and NOT on
 * `org.view_members`: what comes back is not the workspace roster, it is the
 * membership of a board the caller is already inside, and anyone who can read
 * the board can already see these names on its tasks and in its updates.
 */
const getBoardMembers = async (req, res) => {
  try {
    const userId = req.user.userId;
    const ctx = await loadBoard(req.params.id, userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

    const { board, org } = ctx;

    // `org.members` may arrive raw or populated depending on the loader, so go
    // through `_id` first — a populated Document's toString() is its inspect
    // string, never the hex id. Same trap idOf() exists for elsewhere.
    const assignableIds = (org.members || [])
      .map((m) => String(m?._id || m || ''))
      .filter(Boolean)
      .filter((id) => resolveAccess(board, org, id).canRead);

    const users = await User.find({ _id: { $in: assignableIds } })
      .select('name email profilePic createdAt')
      .lean();

    // Hand them back in the org's own member order, which is the order every
    // existing picker already renders — so switching a picker over to this
    // endpoint does not also reshuffle it.
    const byId = new Map(users.map((u) => [String(u._id), u]));
    const members = assignableIds.map((id) => byId.get(id)).filter(Boolean);

    return res.json({ members });
  } catch (err) {
    console.error('getBoardMembers error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

// ---------------------------------------------------------------------------
// Per-board access grants (private boards)
// ---------------------------------------------------------------------------

/**
 * GET /api/boards/:id/access
 *
 * List the board's per-member grants. Open to the owner and to any member with
 * 'edit' access, so the people running the board can see who is on it. Whether
 * the caller may CHANGE it is reported back as `canManageAccess`.
 * Returns: { access: [{ user: {…}, level, canManage }], createdBy, isOwner,
 *            canManageAccess }
 */
const getBoardAccess = async (req, res) => {
  try {
    const userId = req.user.userId;
    const ctx = await loadBoard(req.params.id, userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

    const { access } = ctx;
    if (!access.canViewAccess) {
      return res
        .status(403)
        .json({ error: "You don't have access to this board's sharing settings" });
    }

    const populated = await Board.findById(ctx.board._id).populate(
      'memberAccess.user',
      'name email profilePic'
    );

    return res.json({
      access: populated.memberAccess,
      createdBy: populated.createdBy,
      isOwner: access.board.creator,
      canManageAccess: access.canManageAccess,
    });
  } catch (err) {
    console.error('getBoardAccess error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * PUT /api/boards/:id/access
 *
 * Body: { userId, level: 'view'|'comment'|'contribute'|'edit'|'none',
 *         canManage?: boolean }
 *
 * Upserts a grant for the target org member; `'none'` removes it. The level is a
 * rung on the board ladder — see [capabilities.js](../utils/capabilities.js)
 * `BOARD_LEVELS`. (`'read'` is still accepted as the legacy spelling of
 * `'view'`.) `canManage` upgrades an 'edit' grant to FULL access (they can manage
 * sharing too); omit it to leave the existing flag alone. It is meaningless below
 * 'edit', so any drop to a lower rung — or to 'none' — clears it.
 *
 * Allowed for the owner and for full-access members. Guardrails:
 *   - the owner's grant is untouchable (they always have full access)
 *   - nobody changes their own grant here
 *   - only the OWNER may give or remove full access, so a full-access member
 *     cannot mint peers or demote the ones the owner appointed
 *
 * Returns the updated board (so the client can refresh its cache) plus the
 * populated access list for display.
 */
const setBoardAccess = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { userId: targetUserId, level, canManage } = req.body || {};

    if (!targetUserId || !mongoose.Types.ObjectId.isValid(targetUserId)) {
      return res.status(400).json({ error: 'Valid userId required' });
    }
    if (level !== 'none' && !VALID_ACCESS_LEVELS.includes(level)) {
      return res.status(400).json({ error: 'Invalid access level' });
    }
    if (canManage !== undefined && typeof canManage !== 'boolean') {
      return res.status(400).json({ error: 'canManage must be true or false' });
    }

    const ctx = await loadBoard(req.params.id, userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

    const { board, org, access } = ctx;
    // The BOARD's owner (createdBy) — not the org's, which `access.isOwner` means.
    const isBoardOwner = access.board.creator;

    if (!access.canManageAccess) {
      return res.status(403).json({
        error: access.canViewAccess
          ? 'Only the board owner, and members given full access, can change who has access'
          : 'Only the board owner can manage access',
      });
    }
    if (targetUserId === userId) {
      return res.status(400).json({
        error: isBoardOwner
          ? 'You already have full access as the board owner'
          : "You can't change your own access",
      });
    }
    if (isBoardCreator(board, targetUserId)) {
      return res
        .status(400)
        .json({ error: 'The board owner always has full access' });
    }

    const isMember = org.members.some((m) => m.toString() === targetUserId);
    if (!isMember) {
      return res
        .status(400)
        .json({ error: 'User is not a member of this workspace' });
    }

    const existing = (board.memberAccess || []).find(
      (e) => e.user.toString() === targetUserId
    );
    // `canManage` omitted → keep whatever the member already had. It only means
    // anything at 'edit', so any lower level clears it.
    const requestedManage =
      typeof canManage === 'boolean' ? canManage : existing?.canManage === true;
    const nextManage = level === 'edit' && requestedManage;
    const hadManage = existing?.canManage === true;

    // Full access is the owner's to give and take back — otherwise a delegate
    // could promote allies or strip the owner's other delegates.
    if (!isBoardOwner && (nextManage || hadManage)) {
      return res.status(403).json({
        error: 'Only the board owner can give or remove full access',
      });
    }

    // Upsert: drop any existing grant for this user, then re-add unless 'none'.
    board.memberAccess = (board.memberAccess || []).filter(
      (e) => e.user.toString() !== targetUserId
    );
    if (level !== 'none') {
      board.memberAccess.push({
        user: targetUserId,
        level,
        canManage: nextManage,
      });
    }
    await board.save();

    // Revoking the grant used to strip `memberAccess` and stop there, leaving the
    // user's derived subscriptions behind: their ItemFollow rows survived, so the
    // task-audience fan-out kept pinging them with task names from a board they
    // could no longer open, indefinitely. Tear those down with the grant.
    if (level === 'none' && existing) {
      const boardTaskIds = await Task.distinct('_id', { board: board._id });
      if (boardTaskIds.length > 0) {
        await ItemFollow.deleteMany({
          user: targetUserId,
          task: { $in: boardTaskIds },
        });
      }
      await Notification.deleteMany({
        user: targetUserId,
        board: board._id,
      });
    }

    const wasAlreadyGranted = !!existing;

    // Notify the user the first time they're given access to this board.
    if (level !== 'none' && !wasAlreadyGranted) {
      await createNotification({
        userId: targetUserId,
        type: 'invited',
        message: `You were given access to the board "${board.name}"`,
        orgId: board.organisation,
        boardId: board._id,
        actorId: userId,
      });
    }

    await board.populate('createdBy', CREATOR_FIELDS);
    const populated = await Board.findById(board._id).populate(
      'memberAccess.user',
      'name email profilePic'
    );
    // Ship the board back with its RESOLVED permissions attached, exactly as
    // getBoards does. The client caches this over the board it already holds; a
    // bare board (no `.permissions`) would wipe the caller's own resolved
    // capabilities — `canViewAccess`, `canManageAccess`, `isBoardOwner` — so the
    // Share button and this very modal would vanish the instant the owner changed
    // anyone's access, and stay gone until a full boards refetch. Re-resolving
    // here also reflects the grant that was just written.
    return res.json({
      board: withPermissions(board, org, userId),
      access: populated.memberAccess,
    });
  } catch (err) {
    console.error('setBoardAccess error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/boards/:id/transfer-ownership
 *
 * Body: { userId }
 *
 * Hand the board to another workspace member. `createdBy` IS board ownership —
 * it is the only thing that confers board LIFECYCLE (delete, change visibility,
 * give out full access), which no rung on the access ladder grants and no org
 * role confers on a private board. So moving that one field is the whole
 * operation; everything else here exists to stop the move from stranding people.
 *
 * WHO MAY CALL IT: the board's owner, and nobody else. Not the workspace owner,
 * not a full-access member, not an org admin. There is exactly one owner and the
 * right to hand the board on is theirs alone — anyone else who could do it could
 * take the board from them, which is not a transfer, it is a seizure. (The cost
 * is that a board whose owner leaves the workspace stays theirs; the answer to
 * that is to transfer it before they go, or to delete the board.)
 *
 * TWO SIDE EFFECTS, both about not stranding anyone:
 *
 *   - The OUTGOING owner is given an explicit `edit` + full-access grant. On a
 *     private board their access came entirely from `createdBy`; clear it and
 *     they would be locked out of their own board by the act of handing it over,
 *     which is not what anyone means by "transfer".
 *   - The INCOMING owner's grant (if any) is dropped. `createdBy` already gives
 *     them everything, and a stale rung sitting underneath it is a lie the Share
 *     modal would render — and the thing that would silently demote them if
 *     ownership ever moved on again.
 *
 * Returns the board with the CALLER's freshly resolved permissions, exactly as
 * setBoardAccess does — after a transfer the caller is usually no longer the
 * owner, and the client has to hear that from the server rather than guess.
 */
const transferBoardOwnership = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { userId: targetUserId } = req.body || {};

    if (!targetUserId || !mongoose.Types.ObjectId.isValid(targetUserId)) {
      return res.status(400).json({ error: 'Valid userId required' });
    }

    const ctx = await loadBoard(req.params.id, userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

    const { board, org, access } = ctx;

    if (!access.board.creator) {
      return res
        .status(403)
        .json({ error: 'Only the board owner can transfer this board' });
    }

    if (isBoardCreator(board, targetUserId)) {
      return res.status(400).json({ error: 'They already own this board' });
    }

    const isMember = org.members.some(
      (m) => String(m?._id || m) === String(targetUserId)
    );
    if (!isMember) {
      return res
        .status(400)
        .json({ error: 'User is not a member of this workspace' });
    }

    // The outgoing owner is the caller — `access.board.creator` above is exactly
    // that check — so no membership test is needed here: loadBoardContext already
    // refused anyone outside the org.
    const previousOwnerId = String(board.createdBy);

    board.createdBy = targetUserId;

    // Drop both people's existing grants, then re-add only the one that means
    // anything: the outgoing owner's. A grant for the incoming owner is dead
    // weight under `createdBy`.
    board.memberAccess = (board.memberAccess || []).filter(
      (e) =>
        String(e.user) !== String(targetUserId) &&
        String(e.user) !== previousOwnerId
    );
    board.memberAccess.push({
      user: previousOwnerId,
      level: 'edit',
      canManage: true,
    });

    await board.save();

    const actor = await User.findById(userId).select('name email').lean();
    const actorName = actor?.name || actor?.email || 'Someone';

    // Only the new owner is told. The old one is the caller — narrating what
    // somebody just did back to them is noise.
    await createNotification({
      userId: targetUserId,
      type: 'ownershipTransferred',
      message: `${actorName} made you the owner of the board "${board.name}"`,
      orgId: board.organisation,
      boardId: board._id,
      actorId: userId,
    });

    await board.populate('createdBy', CREATOR_FIELDS);
    const populated = await Board.findById(board._id).populate(
      'memberAccess.user',
      'name email profilePic'
    );

    return res.json({
      board: withPermissions(board, org, userId),
      access: populated.memberAccess,
    });
  } catch (err) {
    console.error('transferBoardOwnership error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

module.exports = {
  getBoard,
  getBoards,
  getDashboardStats,
  createBoard,
  updateBoard,
  deleteBoard,
  reorderBoards,
  getConnectableBoards,
  getBoardMembers,
  getBoardAccess,
  setBoardAccess,
  transferBoardOwnership,
  // labels
  listLabels,
  addLabel,
  updateLabel,
  deleteLabel,
  reorderLabels,
  // statuses
  listStatuses,
  addStatus,
  updateStatus,
  deleteStatus,
  reorderStatuses,
  // group tags
  listGroupTags,
  addGroupTag,
  updateGroupTag,
  deleteGroupTag,
  reorderGroupTags,
  // exported for analytics/dashboard
  findDoneStatusIdsForOrg,
};
