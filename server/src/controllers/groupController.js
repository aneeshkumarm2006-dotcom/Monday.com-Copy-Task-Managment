const TaskGroup = require('../models/TaskGroup');
const Task = require('../models/Task');
const Update = require('../models/Update');
const Note = require('../models/Note');
const Notification = require('../models/Notification');
const ItemFollow = require('../models/ItemFollow');
const ClientContact = require('../models/ClientContact');
const eventBus = require('../services/eventBus');
const { loadBoardContext, requireCapability } = require('../utils/boardContext');
const { generatePortalToken } = require('../utils/portalCrypto');
const { inviteContact } = require('../services/portalInviteService');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Every group mutation on this board — create, rename, reorder, delete — is one
 * capability: `group.manage`. Restructuring a board's groups is a single power,
 * so it is a single gate.
 */

/**
 * GET /api/boards/:boardId/groups
 *
 * List groups for a board, sorted by order asc then createdAt asc.
 * Anyone who can read the board can list its groups — `loadBoardContext` already
 * rejects users who cannot, so there is no further gate here.
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
 * Requires `group.manage`. Creates a new group. If `order` is not provided, it
 * is set to the next available order number (count of existing groups).
 */
const createGroup = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { boardId } = req.params;
    const { name, order, clientEmail, clientName, clientAuthMethod } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Group name is required' });
    }

    const ctx = await loadBoardContext(boardId, userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    const denied = requireCapability(
      ctx,
      'group.manage',
      'You do not have permission to create groups'
    );
    if (denied) return res.status(denied.status).json({ error: denied.error });

    // Reject a duplicate group name on the same board (case-insensitive) so a
    // board never carries two groups the user can't tell apart.
    const trimmedName = name.trim();
    const duplicate = await TaskGroup.findOne({
      board: boardId,
      name: new RegExp(`^${trimmedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
    })
      .select('_id')
      .lean();
    if (duplicate) {
      return res.status(409).json({
        error: `A group named "${trimmedName}" already exists on this board. Please choose a different name.`,
      });
    }

    let resolvedOrder = order;
    if (typeof resolvedOrder !== 'number') {
      resolvedOrder = await TaskGroup.countDocuments({ board: boardId });
    }

    // Client Portal boards mint the shareable link AT CREATION and turn the
    // portal on immediately — the link exists the moment the group does, so it
    // can be shared or emailed straight away. A trimmed client email, if given,
    // gets the invitation. Standard boards are untouched.
    const isClientBoard = ctx.board.boardType === 'client';
    const inviteEmail = (clientEmail || '').trim().toLowerCase();
    const portalFields = isClientBoard
      ? {
          portalToken: generatePortalToken(),
          portalEnabled: true,
          portalClientName: (clientName || '').trim() || name.trim(),
        }
      : {};

    const group = await TaskGroup.create({
      name: name.trim(),
      board: boardId,
      order: resolvedOrder,
      ...portalFields,
    });

    // Send the invitation email (best-effort — never fails the create).
    // `clientAuthMethod` says how this client signs in: 'google' (the shared
    // link) or 'password' (register the address and mail a one-time set-password
    // link). inviteContact writes the ClientContact row and picks the email.
    let inviteSent = false;
    if (isClientBoard && EMAIL_RE.test(inviteEmail)) {
      try {
        const { ok } = await inviteContact({
          group,
          board: ctx.board,
          email: inviteEmail,
          authMethod: clientAuthMethod === 'password' ? 'password' : 'google',
        });
        inviteSent = ok;
      } catch (inviteErr) {
        console.error('createGroup invite error:', inviteErr);
      }
    }

    // Fan out a group.created event so GROUP_CREATED automations can
    // spawn predefined tasks into the new group. The dispatcher fetches
    // the live group doc itself, so we only need the ids + name here.
    eventBus.emit('group.created', {
      groupId: group._id,
      groupName: group.name,
      boardId,
      createdByUserId: userId,
    });

    return res.status(201).json({ group, inviteSent });
  } catch (err) {
    console.error('createGroup error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * PUT /api/groups/:id
 *
 * Requires `group.manage`. Updates name or order.
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
    const denied = requireCapability(
      ctx,
      'group.manage',
      'You do not have permission to edit groups'
    );
    if (denied) return res.status(denied.status).json({ error: denied.error });

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
 * Requires `group.manage`. Cascade deletes the group's tasks and their comments.
 */
const deleteGroup = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;

    const group = await TaskGroup.findById(id);
    if (!group) return res.status(404).json({ error: 'Group not found' });

    const ctx = await loadBoardContext(group.board, userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    const denied = requireCapability(
      ctx,
      'group.manage',
      'You do not have permission to delete groups'
    );
    if (denied) return res.status(denied.status).json({ error: denied.error });

    // Cascade: find tasks in this group, delete their updates, then tasks,
    // then the group itself.
    const taskIds = await Task.distinct('_id', { group: id });
    if (taskIds.length > 0) {
      await Update.deleteMany({ task: { $in: taskIds } });
      await Notification.deleteMany({ task: { $in: taskIds } });
      await ItemFollow.deleteMany({ task: { $in: taskIds } });
    }
    await Note.deleteMany({ group: id });
    await Task.deleteMany({ group: id });
    // Client Portal cleanup: a group can be a client's portal, so drop its
    // external contacts with it.
    await ClientContact.deleteMany({ group: id });
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
 * Reorders all groups on the board in a single bulk write. Requires
 * `group.manage`: reordering rewrites the board's structure for everyone who
 * opens it, so it is the same power as renaming or deleting a group — not a
 * personal view preference.
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
    const denied = requireCapability(
      ctx,
      'group.manage',
      'You do not have permission to reorder groups'
    );
    if (denied) return res.status(denied.status).json({ error: denied.error });

    const currentIds = await TaskGroup.distinct('_id', { board: boardId });
    const currentSet = new Set(currentIds.map((id) => id.toString()));
    const orderedSet = new Set(orderedIds.map((id) => String(id)));
    // The de-duped size must equal the raw length. Comparing only the raw length
    // against the board's group count while membership-checking the SET lets a
    // payload like ['a','a'] through on a two-group board: it is the right length
    // and every distinct id exists, so the bulk write reorders 'a' twice and
    // strands the omitted group at its old `order`. Duplicates are corruption,
    // not a permutation.
    if (
      orderedIds.length !== currentIds.length ||
      orderedSet.size !== orderedIds.length ||
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
