/**
 * linkController.js — cross-board link + mirror endpoints (Phase 1, F2).
 *
 * Routes (wired in routes/tasks.js):
 *   POST   /api/tasks/:id/links/:columnId                 { targetTaskId, targetBoardId }
 *   DELETE /api/tasks/:id/links/:columnId/:targetTaskId
 *   GET    /api/tasks/:id/mirror/:columnId
 *
 * A connect link is a structural, cross-board reference rather than an ordinary
 * cell edit — it is the wiring a mirror column reads through — so writing one
 * takes `column.manage` on the SOURCE board, and (for linkTask) read access on
 * the TARGET board: a link you may not open would otherwise become a read
 * channel around that board's privacy. Until F3, the target board must be in the
 * same workspace (org).
 */

const mongoose = require('mongoose');
const Board = require('../models/Board');
const Task = require('../models/Task');
const { getColumnType } = require('../utils/columnTypes');
const {
  getMirrorValue,
  invalidateOwnMirrors,
  readLinks,
} = require('../services/mirrorRefresh');
const { logActivity } = require('../services/activityService');
const { loadBoardContext, requireCapability } = require('../utils/boardContext');
const { resolveAccess } = require('../utils/permissions');

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
    const denied = requireCapability(
      ctx,
      'column.manage',
      'You do not have permission to link tasks on this board'
    );
    if (denied) return res.status(denied.status).json({ error: denied.error });

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

    // Loaded whole rather than projected: resolving access reads `createdBy`,
    // `visibility` and `memberAccess`, not just the columns.
    const targetBoard = await Board.findById(targetBoardId);
    if (!targetBoard) return res.status(400).json({ error: 'Target board not found' });
    // Both boards must sit in one workspace — pre-F3 there is no cross-org grant.
    if (targetBoard.organisation.toString() !== ctx.board.organisation.toString()) {
      return res
        .status(403)
        .json({ error: 'Cross-workspace links require a grant (arrives with F3)' });
    }
    // Same org, so ctx.org IS the target board's org. Read standing on the target
    // is required in its own right: linking a row you cannot open would surface
    // its values through a mirror on a board you can, routing around board privacy.
    const targetAccess = resolveAccess(targetBoard, ctx.org, userId);
    if (!targetAccess.canRead) {
      return res
        .status(403)
        .json({ error: 'You do not have access to the target board' });
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
      // `column:<key>` is not a human-readable field name, so carry the column's
      // display name for the activity feed and the board export to render.
      metadata: { taskName: task.name, columnLabel: column.name },
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

    // Source board only, by design: dropping a reference exposes nothing on the
    // target, and a link into a board you have since lost access to must still be
    // removable.
    const ctx = await loadBoardContext(task.board, userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    const denied = requireCapability(
      ctx,
      'column.manage',
      'You do not have permission to unlink tasks on this board'
    );
    if (denied) return res.status(denied.status).json({ error: denied.error });

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
      metadata: { taskName: task.name, columnLabel: column.name },
    });

    return res.json({ value: serialized, links: serialized.links });
  } catch (err) {
    console.error('unlinkTask error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * GET /api/tasks/:id/mirror/:columnId — the computed mirror value.
 *
 * Read standing on the board holding the mirror is the whole gate — no
 * capability beyond it, since reading a cell you can already see on the board
 * list is not a separate power. The target board is NOT re-checked here: the
 * value is derived from links whose creation already required read access to the
 * target (see linkTask), and the board task-list embeds these same values via
 * `embedMirrorValues` without a per-target check, so gating only this endpoint
 * would close nothing. Computes lazily, write-throughs the TTL cache.
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
