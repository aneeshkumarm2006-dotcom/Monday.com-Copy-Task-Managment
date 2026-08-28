const mongoose = require('mongoose');
const ActivityLog = require('../models/ActivityLog');
const Task = require('../models/Task');
const User = require('../models/User');
const { loadBoardContext } = require('../utils/boardContext');
// Value resolution is shared with the board activity export so the timeline and
// the exported report can never describe the same row differently.
const { resolveFieldValue, collectUserIds } = require('../services/activityFormat');

/**
 * Who may read a task's history.
 *
 *   Personal task → its creator, and nobody else.
 *   Board task    → whoever may READ the board the task lives on.
 *
 * The board rung used to be "any member of the org", which made this endpoint a
 * side channel out of every private board. The log carries task names, status
 * names, note bodies and assignee names, so a member who could not open the
 * board could still read its contents one task at a time. Board read access is
 * the gate now — the same one the board itself enforces.
 *
 * Reading history needs no capability beyond that: `loadBoardContext` already
 * refuses a caller who cannot open the board, and there is nothing here a reader
 * of the board may not see.
 */
const checkTaskAccess = async (task, userId) => {
  if (task.isPersonal) {
    if (!task.createdBy || task.createdBy.toString() !== userId) {
      return { status: 403, error: 'Not authorised' };
    }
    return { ok: true, board: null };
  }
  const ctx = await loadBoardContext(task.board, userId);
  if (ctx.error) return { status: ctx.status, error: ctx.error };
  return { ok: true, board: ctx.board };
};

/**
 * GET /api/tasks/:taskId/activity?cursor=<isoDate>&limit=50&actor=<id>&type=<type>
 */
const getActivity = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { taskId } = req.params;
    const { cursor, actor, type } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);

    if (!mongoose.Types.ObjectId.isValid(taskId)) {
      return res.status(400).json({ error: 'Invalid task id' });
    }

    const task = await Task.findById(taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const access = await checkTaskAccess(task, userId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });

    // `task: taskId` and nothing else. Goal rows live in the same collection
    // under `goal`, carry no task at all, and so can never appear here.
    const filter = { task: taskId };
    if (cursor) {
      const cursorDate = new Date(cursor);
      if (!isNaN(cursorDate.getTime())) {
        filter.createdAt = { $lt: cursorDate };
      }
    }
    if (actor && mongoose.Types.ObjectId.isValid(actor)) {
      filter.actor = actor;
    }
    if (type && ActivityLog.ACTIVITY_TYPES.includes(type)) {
      filter.type = type;
    }

    // +1 to detect if there are more pages.
    const raw = await ActivityLog.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit + 1)
      .lean();

    const hasMore = raw.length > limit;
    const slice = hasMore ? raw.slice(0, limit) : raw;

    const userIds = collectUserIds(slice);
    const users = userIds.length
      ? await User.find({ _id: { $in: userIds } })
          .select('name profilePic email')
          .lean()
      : [];
    const userMap = new Map(users.map((u) => [u._id.toString(), u]));

    const board = access.board;

    const items = slice.map((e) => {
      const actorDoc = e.actor ? userMap.get(e.actor.toString()) : null;
      let actor;
      if (actorDoc) {
        actor = { _id: actorDoc._id, name: actorDoc.name, profilePic: actorDoc.profilePic };
      } else if (e.actorType === 'client') {
        actor = { _id: null, name: e.actorLabel || 'Client', profilePic: null, isClient: true };
      } else {
        actor = { _id: e.actor, name: 'Unknown', profilePic: null };
      }
      return {
        _id: e._id,
        type: e.type,
        field: e.field,
        oldValue: resolveFieldValue(e.field, e.oldValue, board, userMap, e),
        newValue: resolveFieldValue(e.field, e.newValue, board, userMap, e),
        metadata: e.metadata,
        actor,
        createdAt: e.createdAt,
      };
    });

    const nextCursor = hasMore ? slice[slice.length - 1].createdAt.toISOString() : null;

    return res.json({ items, nextCursor });
  } catch (err) {
    console.error('getActivity error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

module.exports = {
  getActivity,
};
