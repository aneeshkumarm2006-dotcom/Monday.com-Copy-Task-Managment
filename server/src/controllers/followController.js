const mongoose = require('mongoose');
const Task = require('../models/Task');
const Board = require('../models/Board');
const Organisation = require('../models/Organisation');
const ItemFollow = require('../models/ItemFollow');
const { resolveBoardAccess } = require('../utils/boardAccess');

/**
 * Resolve a task plus the requesting user's read access and the org the task
 * belongs to. Personal tasks are followable only by their creator; board tasks
 * require board read access.
 */
const loadTaskAccess = async (taskId, userId) => {
  const task = await Task.findById(taskId);
  if (!task) return { status: 404, error: 'Task not found' };

  if (task.isPersonal || !task.board) {
    const canRead = task.createdBy && task.createdBy.toString() === userId;
    return { task, orgId: null, canRead };
  }

  const board = await Board.findById(task.board);
  if (!board) return { status: 404, error: 'Board not found' };
  const org = await Organisation.findById(board.organisation);
  const { canRead } = resolveBoardAccess(board, org, userId);
  return { task, orgId: board.organisation || null, canRead };
};

/**
 * GET /api/tasks/:id/follow — is the current user following this task?
 */
const getFollowState = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid task id' });
    }
    const follow = await ItemFollow.findOne({ user: userId, task: id });
    return res.json({ following: !!follow });
  } catch (err) {
    console.error('getFollowState error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/tasks/:id/follow — follow (watch) a task.
 */
const followTask = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid task id' });
    }
    const access = await loadTaskAccess(id, userId);
    if (access.status) {
      return res.status(access.status).json({ error: access.error });
    }
    if (!access.canRead) {
      return res.status(403).json({ error: 'No access to this task' });
    }
    await ItemFollow.findOneAndUpdate(
      { user: userId, task: id },
      { $setOnInsert: { user: userId, task: id, organisation: access.orgId } },
      { upsert: true, new: true }
    );
    return res.json({ following: true });
  } catch (err) {
    console.error('followTask error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * DELETE /api/tasks/:id/follow — unfollow a task.
 */
const unfollowTask = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid task id' });
    }
    await ItemFollow.deleteOne({ user: userId, task: id });
    return res.json({ following: false });
  } catch (err) {
    console.error('unfollowTask error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

module.exports = { getFollowState, followTask, unfollowTask };
