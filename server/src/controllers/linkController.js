/**
 * linkController.js — cross-board link + mirror endpoints (Phase 1, F2).
 *
 * Routes (wired in routes/tasks.js):
 *   POST   /api/tasks/:id/links/:columnId                 { targetTaskId, targetBoardId }
 *   DELETE /api/tasks/:id/links/:columnId/:targetTaskId
 *   GET    /api/tasks/:id/mirror/:columnId
 *
 * Writing a connect link is a column-value write, so it follows the same
 * permission model as PUT /api/tasks/:id columnValues — admin on the source
 * board. Until F3, the target board must be in the same workspace (org).
 */

const mongoose = require('mongoose');
const Board = require('../models/Board');
const Task = require('../models/Task');
const Organisation = require('../models/Organisation');
const { getColumnType } = require('../utils/columnTypes');
const {
  getMirrorValue,
  invalidateOwnMirrors,
  readLinks,
} = require('../services/mirrorRefresh');
const { logActivity } = require('../services/activityService');
const { resolveBoardAccess } = require('../utils/boardAccess');

/**
 * Load a board + org and confirm membership. `isAdmin` means "may edit board
 * content" — true org admins and members granted edit access both qualify.
 * Returns { board, org, isAdmin } or { status, error }.
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
  if (!isMember) return { status: 403, error: 'Not a member of this organisation' };
  const access = resolveBoardAccess(board, org, userId);
  if (!access.canRead) {
    return { status: 403, error: 'Access denied' };
  }
  return { board, org, isAdmin: access.canEdit };
};

/**
 * POST /api/tasks/:id/links/:columnId
 * Body: { targetTaskId, targetBoardId } — adds (or, for single-value connect
 * columns, replaces) a link on the task's connect column.
 */
const linkTask = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id, columnId } = req.params;
    const { targetTaskId, targetBoardId } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid task id' });
    }
    const task = await Task.findById(id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (task.isPersonal || !task.board) {
      return res.status(400).json({ error: 'Connect links are only available on board tasks' });
    }

    const ctx = await loadBoardContext(task.board, userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    if (!ctx.isAdmin) return res.status(403).json({ error: 'Admin access required' });

    const column = ctx.board.columns.id(columnId);
    if (!column || column.type !== 'connect_boards') {
      return res.status(400).json({ error: 'Column is not a connect_boards column' });
    }

    if (!targetTaskId || !mongoose.Types.ObjectId.isValid(targetTaskId)) {
      return res.status(400).json({ error: 'A valid targetTaskId is required' });
    }
    if (!targetBoardId || !mongoose.Types.ObjectId.isValid(targetBoardId)) {
      return res.status(400).json({ error: 'A valid targetBoardId is required' });
    }

    const allowedTargets = Array.isArray(column.settings && column.settings.targetBoardIds)
      ? column.settings.targetBoardIds.map((b) => b.toString())
      : [];
    if (allowedTargets.length > 0 && !allowedTargets.includes(targetBoardId.toString())) {
      return res.status(400).json({ error: 'Target board is not allowed by this column' });
    }

    const targetTask = await Task.findById(targetTaskId);
    if (!targetTask) return res.status(400).json({ error: 'Target task not found' });
    if (targetTask.isPersonal || !targetTask.board) {
      return res.status(400).json({ error: 'Cannot link to a personal task' });
    }
    if (targetTask.board.toString() !== targetBoardId.toString()) {
      return res.status(400).json({ error: 'Target task does not belong to the target board' });
    }

    const targetBoard = await Board.findById(targetBoardId).select('organisation columns');
    if (!targetBoard) return res.status(400).json({ error: 'Target board not found' });
    // Write on both boards — pre-F3 that means same workspace (org).
    if (targetBoard.organisation.toString() !== ctx.board.organisation.toString()) {
      return res
        .status(403)
        .json({ error: 'Cross-workspace links require a grant (arrives with F3)' });
    }

    // restrictTo filter: enforce only when the referenced column still exists
    // on the target board (Acceptance #5 — a deleted filter column must not 500).
    const restrictTo = column.settings && column.settings.restrictTo;
    if (restrictTo && restrictTo.columnId) {
      const restrictCol = targetBoard.columns.id(restrictTo.columnId);
      if (restrictCol) {
        const tv = targetTask.columnValues
          ? targetTask.columnValues.get(restrictTo.columnId.toString())
          : undefined;
        const matches = tv != null && restrictTo.value != null && tv.toString() === restrictTo.value.toString();
        if (!matches) {
          return res.status(400).json({ error: "Target row does not match this column's filter" });
        }
      }
    }

    const current = readLinks(task, columnId);
    const allowMultiple = !!(column.settings && column.settings.allowMultiple);
    const newLink = { boardId: targetBoardId.toString(), taskId: targetTaskId.toString() };
    let nextLinks;
    if (allowMultiple) {
      nextLinks = current.some((l) => l.taskId === newLink.taskId)
        ? current
        : [...current, newLink];
    } else {
      nextLinks = [newLink];
    }

    const entry = getColumnType('connect_boards');
    try {
      entry.validate({ links: nextLinks }, column.settings || {});
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    const serialized = entry.serialize({ links: nextLinks });
    task.columnValues.set(columnId.toString(), serialized);
    task.markModified('columnValues');
    await task.save();

    // This task's own mirrors read from this connect column — invalidate them.
    await invalidateOwnMirrors(task._id, ctx.board);

    logActivity({
      task,
      actor: userId,
      type: 'task.field_changed',
      field: `column:${column.key}`,
      oldValue: current,
      newValue: serialized.links,
      metadata: { taskName: task.name },
    });

    return res.json({ value: serialized, links: serialized.links });
  } catch (err) {
    console.error('linkTask error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * DELETE /api/tasks/:id/links/:columnId/:targetTaskId — remove a link.
 */
const unlinkTask = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id, columnId, targetTaskId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid task id' });
    }
    const task = await Task.findById(id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (task.isPersonal || !task.board) {
      return res.status(400).json({ error: 'Connect links are only available on board tasks' });
    }

    const ctx = await loadBoardContext(task.board, userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    if (!ctx.isAdmin) return res.status(403).json({ error: 'Admin access required' });

    const column = ctx.board.columns.id(columnId);
    if (!column || column.type !== 'connect_boards') {
      return res.status(400).json({ error: 'Column is not a connect_boards column' });
    }

    const current = readLinks(task, columnId);
    const nextLinks = current.filter((l) => l.taskId !== targetTaskId.toString());

    const entry = getColumnType('connect_boards');
    const serialized = entry.serialize({ links: nextLinks });
    task.columnValues.set(columnId.toString(), serialized);
    task.markModified('columnValues');
    await task.save();

    await invalidateOwnMirrors(task._id, ctx.board);

    logActivity({
      task,
      actor: userId,
      type: 'task.field_changed',
      field: `column:${column.key}`,
      oldValue: current,
      newValue: serialized.links,
      metadata: { taskName: task.name },
    });

    return res.json({ value: serialized, links: serialized.links });
  } catch (err) {
    console.error('unlinkTask error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * GET /api/tasks/:id/mirror/:columnId — the computed mirror value.
 * Member-gated (read). Computes lazily, write-throughs the TTL cache.
 */
const getMirror = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id, columnId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid task id' });
    }
    const task = await Task.findById(id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (task.isPersonal || !task.board) {
      return res.status(400).json({ error: 'Mirror columns are only available on board tasks' });
    }

    const ctx = await loadBoardContext(task.board, userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

    const column = ctx.board.columns.id(columnId);
    if (!column || column.type !== 'mirror') {
      return res.status(400).json({ error: 'Column is not a mirror column' });
    }

    const value = await getMirrorValue(task, ctx.board, column, { persist: true });
    return res.json({ value });
  } catch (err) {
    console.error('getMirror error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

module.exports = {
  linkTask,
  unlinkTask,
  getMirror,
};
