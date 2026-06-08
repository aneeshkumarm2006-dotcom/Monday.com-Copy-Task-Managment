const mongoose = require('mongoose');
const Board = require('../models/Board');
const Task = require('../models/Task');
const TaskGroup = require('../models/TaskGroup');
const Comment = require('../models/Comment');
const Notification = require('../models/Notification');
const Organisation = require('../models/Organisation');
const { resolveBoardAccess, isBoardCreator } = require('../utils/boardAccess');

const VALID_VISIBILITIES = ['public', 'private'];
const VALID_ACCESS_LEVELS = ['read', 'edit'];

/**
 * Resolve whether the current user is the admin of the given org.
 */
const isOrgAdmin = (org, userId) =>
  !!org &&
  (
    (org.admin && org.admin.toString() === userId) ||
    (Array.isArray(org.admins) && org.admins.some((a) => a.toString() === userId))
  );

/**
 * Confirm the user is a member of the org. Returns the org doc or null.
 */
const loadOrgForMember = async (orgId, userId) => {
  const org = await Organisation.findById(orgId);
  if (!org) return { org: null, isMember: false };
  const isMember = org.members.some((m) => m.toString() === userId);
  return { org, isMember };
};

/**
 * Load a board + its org, validating that the current user is a member.
 * Returns { board, org, isAdmin } or { status, error } on failure.
 */
const loadBoardContext = async (boardId, userId) => {
  if (!boardId || !mongoose.Types.ObjectId.isValid(boardId)) {
    return { status: 400, error: 'Invalid board id' };
  }
  const board = await Board.findById(boardId);
  if (!board) return { status: 404, error: 'Board not found' };

  const org = await Organisation.findById(board.organisation);
  if (!org) return { status: 404, error: 'Organisation not found' };

  const isMember = org.members.some((m) => m.toString() === userId);
  if (!isMember) {
    return { status: 403, error: 'Not a member of this organisation' };
  }
  const access = resolveBoardAccess(board, org, userId);
  if (!access.canRead) {
    return { status: 403, error: 'Access denied' };
  }
  // `isAdmin` stays "true org admin" here (it gates org-wide concerns like the
  // connectable-board list). `canEdit` is the board-content write gate, which
  // members granted edit access also satisfy.
  return {
    board,
    org,
    isAdmin: access.orgAdmin,
    canEdit: access.canEdit,
    readOnly: access.readOnly,
  };
};

const DEFAULT_STATUSES = [
  { key: 'not_started',   name: 'Not Started',   color: '#6B7280', order: 0, isDefault: true  },
  { key: 'working_on_it', name: 'Working on it', color: '#D97706', order: 1, isDefault: false },
  { key: 'done',          name: 'Done',          color: '#16A34A', order: 2, isDefault: false },
  { key: 'stuck',         name: 'Stuck',         color: '#DC2626', order: 3, isDefault: false },
];

/**
 * GET /api/boards?org=:orgId
 *
 * All org members can see all boards. Sorted by updatedAt desc.
 */
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
      return res.status(403).json({ error: 'Not a member of this organisation' });
    }

    const admin = isOrgAdmin(org, userId);
    // Non-admins see public boards plus any private board they've been
    // granted access to.
    const visibilityFilter = admin
      ? {}
      : { $or: [{ visibility: 'public' }, { 'memberAccess.user': userId }] };
    const boards = await Board.find({ organisation: orgId, ...visibilityFilter })
      .sort({ order: 1, updatedAt: -1 });

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

    return res.json({ boards });
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
 * Returns: { totalBoards, completedTasks, pendingTasks, completionRate }
 * Admins see org-wide stats. Regular users see stats scoped to tasks they
 * are assigned to within the org's public boards.
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
      return res.status(403).json({ error: 'Not a member of this organisation' });
    }

    const orgBoardIds = await Board.distinct('_id', { organisation: orgId });
    const taskFilter = { board: { $in: orgBoardIds }, isPersonal: { $ne: true } };

    const doneStatusIds = await findDoneStatusIdsForOrg(orgId);

    const [completedTasks, pendingTasks, totalBoards] = await Promise.all([
      Task.countDocuments({
        ...taskFilter,
        status: { $in: doneStatusIds.length ? doneStatusIds : ['done'] },
      }),
      Task.countDocuments({
        ...taskFilter,
        status: { $nin: doneStatusIds.length ? doneStatusIds : ['done'] },
      }),
      Board.countDocuments({ organisation: orgId }),
    ]);

    const totalTasks = completedTasks + pendingTasks;
    const completionRate =
      totalTasks === 0 ? 0 : Math.round((completedTasks / totalTasks) * 100);

    return res.json({
      totalBoards,
      completedTasks,
      pendingTasks,
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
 * Admin-only. Validates input, attaches orgId and createdBy. New boards
 * are seeded with the four default statuses so the existing UI flow
 * (StatusMenu / Chip) keeps working.
 */
const createBoard = async (req, res) => {
  try {
    const userId = req.user.userId;
    const {
      name,
      visibility = 'private',
      organisation,
      description = '',
    } = req.body;

    if (!organisation) {
      return res.status(400).json({ error: 'Organisation ID required' });
    }
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Board name is required' });
    }
    if (!VALID_VISIBILITIES.includes(visibility)) {
      return res.status(400).json({ error: 'Invalid visibility value' });
    }

    const org = await Organisation.findById(organisation);
    if (!org) return res.status(404).json({ error: 'Organisation not found' });
    if (!isOrgAdmin(org, userId)) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const lastBoard = await Board.findOne({ organisation })
      .sort({ order: -1 })
      .select('order')
      .lean();
    const nextBoardOrder = (lastBoard?.order ?? -1) + 1;

    const board = await Board.create({
      name: name.trim(),
      description: typeof description === 'string' ? description.trim() : '',
      visibility,
      organisation,
      createdBy: userId,
      order: nextBoardOrder,
      statuses: DEFAULT_STATUSES.map((s) => ({ ...s })),
      labels: [],
      columns: [],
      useFlexibleColumns: false,
    });

    return res.status(201).json({ board });
  } catch (err) {
    console.error('createBoard error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * PUT /api/boards/:id
 *
 * Body: { name?, visibility? }
 * Admin-only for the owning org.
 */
const updateBoard = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    const { name, visibility, description } = req.body;

    const board = await Board.findById(id);
    if (!board) return res.status(404).json({ error: 'Board not found' });

    const org = await Organisation.findById(board.organisation);
    if (!org) return res.status(404).json({ error: 'Organisation not found' });
    if (!isOrgAdmin(org, userId)) {
      return res.status(403).json({ error: 'Admin access required' });
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
    if (typeof description === 'string') {
      board.description = description.trim();
    }

    await board.save();
    return res.json({ board });
  } catch (err) {
    console.error('updateBoard error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * DELETE /api/boards/:id
 *
 * Admin-only. Cascade deletes all TaskGroups, Tasks and Comments belonging
 * to this board.
 */
const deleteBoard = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;

    const board = await Board.findById(id);
    if (!board) return res.status(404).json({ error: 'Board not found' });

    const org = await Organisation.findById(board.organisation);
    if (!org) return res.status(404).json({ error: 'Organisation not found' });
    if (!isOrgAdmin(org, userId)) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const taskIds = await Task.distinct('_id', { board: id });
    if (taskIds.length > 0) {
      await Comment.deleteMany({ task: { $in: taskIds } });
      await Notification.deleteMany({ task: { $in: taskIds } });
    }
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
// Labels + Statuses CRUD (admin-only)
// ---------------------------------------------------------------------------

/**
 * Shared write guard for any /labels or /statuses sub-route. Satisfied by org
 * admins and by members granted edit access to the board.
 */
const requireBoardAdmin = async (req, res) => {
  const ctx = await loadBoardContext(req.params.id, req.user.userId);
  if (ctx.error) {
    res.status(ctx.status).json({ error: ctx.error });
    return null;
  }
  if (!ctx.canEdit) {
    res.status(403).json({ error: 'Admin access required' });
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
    const ctx = await loadBoardContext(req.params.id, req.user.userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    return res.json({ labels: serializeBoardChips(ctx.board).labels });
  } catch (err) {
    console.error('listLabels error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

const addLabel = async (req, res) => {
  try {
    const ctx = await requireBoardAdmin(req, res);
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
    const ctx = await requireBoardAdmin(req, res);
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
    const ctx = await requireBoardAdmin(req, res);
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
    const ctx = await requireBoardAdmin(req, res);
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
    const ctx = await loadBoardContext(req.params.id, req.user.userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    return res.json({ statuses: serializeBoardChips(ctx.board).statuses });
  } catch (err) {
    console.error('listStatuses error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

const addStatus = async (req, res) => {
  try {
    const ctx = await requireBoardAdmin(req, res);
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
    const ctx = await requireBoardAdmin(req, res);
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
    const ctx = await requireBoardAdmin(req, res);
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
    const ctx = await requireBoardAdmin(req, res);
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

/**
 * PUT /api/boards/reorder
 *
 * Body: { organisation, orderedIds: [boardId,...] }
 * Reorders boards within an organisation. Any user who is a member of the
 * organisation can reorder boards (mirrors the read permission for getBoards).
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
      return res.status(403).json({ error: 'Not a member of this organisation' });
    }

    const admin = isOrgAdmin(org, userId);
    const visibilityFilter = admin
      ? {}
      : { $or: [{ visibility: 'public' }, { 'memberAccess.user': userId }] };
    const currentIds = await Board.distinct('_id', { organisation, ...visibilityFilter });
    const currentSet = new Set(currentIds.map((id) => id.toString()));
    const orderedSet = new Set(orderedIds.map((id) => String(id)));
    if (
      orderedIds.length !== currentIds.length ||
      ![...orderedSet].every((id) => currentSet.has(id))
    ) {
      return res
        .status(400)
        .json({ error: 'orderedIds must list every visible board in the organisation exactly once' });
    }

    const ops = orderedIds.map((id, idx) => ({
      updateOne: {
        filter: { _id: id, organisation },
        update: { $set: { order: idx } },
      },
    }));
    if (ops.length > 0) await Board.bulkWrite(ops);

    const boards = await Board.find({ organisation }).sort({ order: 1, updatedAt: -1 });
    return res.json({ boards });
  } catch (err) {
    console.error('reorderBoards error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * GET /api/boards/:id/connectable
 *
 * Boards a `connect_boards` column on this board may target. Pre-F3 that's
 * every OTHER board in the same workspace; F3 adds boards reachable through an
 * active WorkspaceGrant. Member-gated. The column list is included so the
 * client can offer source-column choices when building a mirror.
 *
 * Returns: { connectable: [{ board, workspace }] }
 */
const getConnectableBoards = async (req, res) => {
  try {
    const ctx = await loadBoardContext(req.params.id, req.user.userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

    const visibilityFilter = ctx.isAdmin ? {} : { visibility: 'public' };
    const boards = await Board.find({
      organisation: ctx.board.organisation,
      _id: { $ne: ctx.board._id },
      ...visibilityFilter,
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
// Per-board access grants (private boards)
// ---------------------------------------------------------------------------

/**
 * GET /api/boards/:id/access
 *
 * List the board's per-member grants. Creator-only — the board's owner is the
 * one who manages who can see/edit a private board.
 * Returns: { access: [{ user: {…}, level }], createdBy }
 */
const getBoardAccess = async (req, res) => {
  try {
    const userId = req.user.userId;
    const board = await Board.findById(req.params.id).populate(
      'memberAccess.user',
      'name email profilePic'
    );
    if (!board) return res.status(404).json({ error: 'Board not found' });
    if (!isBoardCreator(board, userId)) {
      return res
        .status(403)
        .json({ error: 'Only the board creator can manage access' });
    }
    return res.json({ access: board.memberAccess, createdBy: board.createdBy });
  } catch (err) {
    console.error('getBoardAccess error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * PUT /api/boards/:id/access
 *
 * Body: { userId, level: 'read' | 'edit' | 'none' }
 * Creator-only. Upserts a grant for the target org member; `'none'` removes it.
 * Returns the updated board (so the client can refresh its cache) plus the
 * populated access list for display.
 */
const setBoardAccess = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { userId: targetUserId, level } = req.body || {};

    if (!targetUserId || !mongoose.Types.ObjectId.isValid(targetUserId)) {
      return res.status(400).json({ error: 'Valid userId required' });
    }
    if (level !== 'none' && !VALID_ACCESS_LEVELS.includes(level)) {
      return res.status(400).json({ error: 'Invalid access level' });
    }

    const board = await Board.findById(req.params.id);
    if (!board) return res.status(404).json({ error: 'Board not found' });
    if (!isBoardCreator(board, userId)) {
      return res
        .status(403)
        .json({ error: 'Only the board creator can manage access' });
    }
    if (targetUserId === userId) {
      return res
        .status(400)
        .json({ error: 'You already have full access as the board creator' });
    }

    const org = await Organisation.findById(board.organisation);
    if (!org) return res.status(404).json({ error: 'Organisation not found' });
    const isMember = org.members.some((m) => m.toString() === targetUserId);
    if (!isMember) {
      return res
        .status(400)
        .json({ error: 'User is not a member of this organisation' });
    }

    // Upsert: drop any existing grant for this user, then re-add unless 'none'.
    board.memberAccess = (board.memberAccess || []).filter(
      (e) => e.user.toString() !== targetUserId
    );
    if (level !== 'none') {
      board.memberAccess.push({ user: targetUserId, level });
    }
    await board.save();

    const populated = await Board.findById(board._id).populate(
      'memberAccess.user',
      'name email profilePic'
    );
    return res.json({ board, access: populated.memberAccess });
  } catch (err) {
    console.error('setBoardAccess error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

module.exports = {
  getBoards,
  getDashboardStats,
  createBoard,
  updateBoard,
  deleteBoard,
  reorderBoards,
  getConnectableBoards,
  getBoardAccess,
  setBoardAccess,
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
  // exported for analytics/dashboard
  findDoneStatusIdsForOrg,
};
