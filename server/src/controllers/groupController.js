const Board = require('../models/Board');
const TaskGroup = require('../models/TaskGroup');
const Task = require('../models/Task');
const Comment = require('../models/Comment');
const Notification = require('../models/Notification');
const Organisation = require('../models/Organisation');
const eventBus = require('../services/eventBus');
const { resolveBoardAccess } = require('../utils/boardAccess');

/**
 * Load the board + its org, validating the current user is a member.
 * `isAdmin` means "may edit board content" — true org admins and members
 * granted edit access on a private board both qualify.
 * Returns { board, org, isAdmin } on success, or { status, error } on failure.
 */
const loadBoardContext = async (boardId, userId) => {
  const board = await Board.findById(boardId);
  if (!board) return { status: 404, error: 'Board not found' };

  const org = await Organisation.findById(board.organisation);
  if (!org) return { status: 404, error: 'Organisation not found' };

  const isMember = org.members.some((m) => m.toString() === userId);
  if (!isMember) {
    return { status: 403, error: 'Not a member of this organisation' };
  }

  const access = resolveBoardAccess(board, org, userId);
  return { board, org, isAdmin: access.canEdit };
};

/**
 * GET /api/boards/:boardId/groups
 *
 * List groups for a board, sorted by order asc then createdAt asc.
 * Any org member can list groups. Regular users can only list groups from
 * public boards.
 */
const getGroups = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { boardId } = req.params;

    const ctx = await loadBoardContext(boardId, userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

    const groups = await TaskGroup.find({ board: boardId }).sort({
      order: 1,
      createdAt: 1,
    });

    return res.json({ groups });
  } catch (err) {
    console.error('getGroups error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/boards/:boardId/groups
 *
 * Admin only. Creates a new group. If `order` is not provided, it is set to
 * the next available order number (count of existing groups).
 */
const createGroup = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { boardId } = req.params;
    const { name, order } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Group name is required' });
    }

    const ctx = await loadBoardContext(boardId, userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    if (!ctx.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    let resolvedOrder = order;
    if (typeof resolvedOrder !== 'number') {
      resolvedOrder = await TaskGroup.countDocuments({ board: boardId });
    }

    const group = await TaskGroup.create({
      name: name.trim(),
      board: boardId,
      order: resolvedOrder,
    });

    // Fan out a group.created event so GROUP_CREATED automations can
    // spawn predefined tasks into the new group. The dispatcher fetches
    // the live group doc itself, so we only need the ids + name here.
    eventBus.emit('group.created', {
      groupId: group._id,
      groupName: group.name,
      boardId,
      createdByUserId: userId,
    });

    return res.status(201).json({ group });
  } catch (err) {
    console.error('createGroup error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * PUT /api/groups/:id
 *
 * Admin only. Updates name or order.
 */
const updateGroup = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    const { name, order } = req.body;

    const group = await TaskGroup.findById(id);
    if (!group) return res.status(404).json({ error: 'Group not found' });

    const ctx = await loadBoardContext(group.board, userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    if (!ctx.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    if (typeof name === 'string') {
      if (!name.trim()) {
        return res.status(400).json({ error: 'Group name cannot be empty' });
      }
      group.name = name.trim();
    }
    if (typeof order === 'number') {
      group.order = order;
    }

    await group.save();
    return res.json({ group });
  } catch (err) {
    console.error('updateGroup error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * DELETE /api/groups/:id
 *
 * Admin only. Cascade deletes the group's tasks and their comments.
 */
const deleteGroup = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;

    const group = await TaskGroup.findById(id);
    if (!group) return res.status(404).json({ error: 'Group not found' });

    const ctx = await loadBoardContext(group.board, userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    if (!ctx.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    // Cascade: find tasks in this group, delete their comments, then tasks,
    // then the group itself.
    const taskIds = await Task.distinct('_id', { group: id });
    if (taskIds.length > 0) {
      await Comment.deleteMany({ task: { $in: taskIds } });
      await Notification.deleteMany({ task: { $in: taskIds } });
    }
    await Task.deleteMany({ group: id });
    await TaskGroup.deleteOne({ _id: id });

    return res.json({ success: true });
  } catch (err) {
    console.error('deleteGroup error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * PUT /api/boards/:boardId/groups/reorder
 *
 * Body: { orderedIds: [groupId,...] }
 * Reorders all groups on the board in a single bulk write. Any org member
 * may reorder groups (no admin-only gate — mirrors task reordering UX).
 */
const reorderGroups = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { boardId } = req.params;
    const orderedIds = Array.isArray(req.body?.orderedIds) ? req.body.orderedIds : null;
    if (!orderedIds) {
      return res.status(400).json({ error: 'orderedIds must be an array' });
    }

    const ctx = await loadBoardContext(boardId, userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

    const currentIds = await TaskGroup.distinct('_id', { board: boardId });
    const currentSet = new Set(currentIds.map((id) => id.toString()));
    const orderedSet = new Set(orderedIds.map((id) => String(id)));
    if (
      orderedIds.length !== currentIds.length ||
      ![...orderedSet].every((id) => currentSet.has(id))
    ) {
      return res
        .status(400)
        .json({ error: 'orderedIds must list every group on the board exactly once' });
    }

    const ops = orderedIds.map((id, idx) => ({
      updateOne: {
        filter: { _id: id, board: boardId },
        update: { $set: { order: idx } },
      },
    }));
    if (ops.length > 0) await TaskGroup.bulkWrite(ops);

    const groups = await TaskGroup.find({ board: boardId }).sort({ order: 1, createdAt: 1 });
    return res.json({ groups });
  } catch (err) {
    console.error('reorderGroups error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

module.exports = {
  getGroups,
  createGroup,
  updateGroup,
  deleteGroup,
  reorderGroups,
};
