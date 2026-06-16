const Task = require('../models/Task');
const Board = require('../models/Board');
const Comment = require('../models/Comment');
const User = require('../models/User');
const Organisation = require('../models/Organisation');
const {
  createNotificationsForUsers,
} = require('../services/notificationService');
const { sendMentionEmail } = require('../services/emailService');
const { logActivity } = require('../services/activityService');

/**
 * Check if a user has read access to the given task. Returns
 * { ok: true } on success, or { status, error } on failure.
 *
 * Rules (mirrors taskController access):
 *   - Personal task: only the creator can read.
 *   - Board task (admin of the board's org): always.
 *   - Board task (regular member): only on public boards AND only when the
 *     user is an assignee of the task.
 */
const checkTaskAccess = async (task, userId) => {
  // Personal task — only the creator can access
  if (task.isPersonal) {
    if (!task.createdBy || task.createdBy.toString() !== userId) {
      return { status: 403, error: 'Not authorised' };
    }
    return { ok: true };
  }

  // Board task — need board + org context
  const board = await Board.findById(task.board);
  if (!board) return { status: 404, error: 'Board not found' };

  const org = await Organisation.findById(board.organisation);
  if (!org) return { status: 404, error: 'Organisation not found' };

  const isMember = org.members.some((m) => m.toString() === userId);
  if (!isMember) {
    return { status: 403, error: 'Not a member of this organisation' };
  }

  // Any org member can access board task comments
  return { ok: true };
};

/**
 * GET /api/tasks/:taskId/comments
 *
 * List comments for a task, populated with author (name, profilePic),
 * sorted oldest-first (chronological).
 */
const getComments = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { taskId } = req.params;

    const task = await Task.findById(taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const access = await checkTaskAccess(task, userId);
    if (!access.ok) {
      return res.status(access.status).json({ error: access.error });
    }

    const comments = await Comment.find({ task: taskId })
      .populate('author', 'name profilePic email')
      .populate('mentions', 'name profilePic email')
      .populate({ path: 'replyTo', select: 'author text', populate: { path: 'author', select: 'name' } })
      .sort({ createdAt: 1 });

    return res.json({ comments });
  } catch (err) {
    console.error('getComments error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/tasks/:taskId/comments
 *
 * Add a comment on a task. The current user is attached as the author.
 * Body: { text: string }
 */
const addComment = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { taskId } = req.params;
    const { text, mentions, replyTo } = req.body || {};

    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Comment text is required' });
    }

    const task = await Task.findById(taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const access = await checkTaskAccess(task, userId);
    if (!access.ok) {
      return res.status(access.status).json({ error: access.error });
    }

    // Validate mention IDs — only allow mentioning org members
    let validMentions = [];
    if (Array.isArray(mentions) && mentions.length > 0 && !task.isPersonal) {
      const board = await Board.findById(task.board);
      if (board) {
        const org = await Organisation.findById(board.organisation);
        if (org) {
          const memberSet = new Set(org.members.map((m) => m.toString()));
          validMentions = mentions.filter((id) => memberSet.has(id.toString()));
        }
      }
    }

    // Validate replyTo — must belong to the same task
    let replyToId = null;
    let parentAuthorId = null;
    if (replyTo) {
      const parentComment = await Comment.findOne({ _id: replyTo, task: taskId });
      if (parentComment) {
        replyToId = parentComment._id;
        parentAuthorId = parentComment.author || null;
      }
    }

    const comment = await Comment.create({
      task: taskId,
      author: userId,
      text: text.trim(),
      mentions: validMentions,
      replyTo: replyToId,
    });

    logActivity({
      task,
      actor: userId,
      type: 'comment.added',
      metadata: {
        commentSnippet: text.trim().slice(0, 80),
        taskName: task.name,
      },
    });

    const populated = await Comment.findById(comment._id)
      .populate('author', 'name profilePic email')
      .populate('mentions', 'name profilePic email')
      .populate({ path: 'replyTo', select: 'author text', populate: { path: 'author', select: 'name' } });

    // Resolve org id from the board (board tasks only). Used to scope
    // notifications to the right organisation.
    let notifOrgId = null;
    if (!task.isPersonal) {
      const taskBoard = await Board.findById(task.board).select('organisation');
      notifOrgId = taskBoard?.organisation || null;
    }

    // Notify task assignees (except the commenter) about the new comment.
    // Personal tasks have no other assignees — they're skipped naturally.
    if (!task.isPersonal && Array.isArray(task.assignedTo)) {
      const authorName = populated.author?.name || 'Someone';
      await createNotificationsForUsers({
        userIds: task.assignedTo,
        type: 'commented',
        message: `${authorName} commented on "${task.name}"`,
        taskId: task._id,
        orgId: notifOrgId,
        excludeUserId: userId,
      });
    }

    // Notify the author of the comment being replied to (skips self-replies).
    // Carries a 'comments' tab hint so clicking opens the task's Comments tab.
    if (parentAuthorId) {
      const authorName = populated.author?.name || 'Someone';
      await createNotificationsForUsers({
        userIds: [parentAuthorId],
        type: 'replied',
        message: `${authorName} replied to your comment on "${task.name}"`,
        taskId: task._id,
        orgId: notifOrgId,
        excludeUserId: userId,
        tab: 'comments',
      });
    }

    // Notify mentioned users (separate from assignee notifications)
    if (validMentions.length > 0) {
      const authorName = populated.author?.name || 'Someone';
      await createNotificationsForUsers({
        userIds: validMentions,
        type: 'mentioned',
        message: `${authorName} mentioned you in a comment on "${task.name}"`,
        taskId: task._id,
        orgId: notifOrgId,
        excludeUserId: userId,
      });

      // Send email to each mentioned user (best-effort)
      const mentionIds = validMentions.filter((id) => id.toString() !== userId);
      const mentionedUsers = await User.find(
        { _id: { $in: mentionIds } },
        'email name'
      );

      const boardId = task.board?.toString?.() || task.board;
      const taskLink = `${process.env.CLIENT_URL || 'http://localhost:5173'}/boards/${boardId}`;

      const emailResults = await Promise.allSettled(
        mentionedUsers.map((u) =>
          sendMentionEmail({
            to: u.email,
            mentionedByName: authorName,
            taskName: task.name,
            commentText: text.trim(),
            taskLink,
          })
        )
      );
      emailResults.forEach((result, i) => {
        if (result.status === 'rejected') {
          console.error(
            `[email] Failed to send mention email to ${mentionedUsers[i]?.email}:`,
            result.reason
          );
        }
      });
    }

    return res.status(201).json({ comment: populated });
  } catch (err) {
    console.error('addComment error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * PATCH /api/tasks/:taskId/comments/:id
 *
 * Edit a comment's text. Only the author can edit. Mentions and replyTo
 * are immutable on edit — only `text` changes. `editedAt` is stamped so the
 * client can show an "(edited)" marker.
 */
const editComment = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { taskId, id } = req.params;
    const { text } = req.body || {};

    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Comment text is required' });
    }

    const comment = await Comment.findOne({ _id: id, task: taskId });
    if (!comment) return res.status(404).json({ error: 'Comment not found' });

    const task = await Task.findById(taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const access = await checkTaskAccess(task, userId);
    if (!access.ok) {
      return res.status(access.status).json({ error: access.error });
    }

    if (!comment.author || comment.author.toString() !== userId) {
      return res.status(403).json({ error: 'Not authorised' });
    }

    comment.text = text.trim();
    comment.editedAt = new Date();
    await comment.save();

    const populated = await Comment.findById(comment._id)
      .populate('author', 'name profilePic email')
      .populate('mentions', 'name profilePic email')
      .populate({ path: 'replyTo', select: 'author text', populate: { path: 'author', select: 'name' } });

    return res.json({ comment: populated });
  } catch (err) {
    console.error('editComment error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * PATCH /api/tasks/:taskId/comments/:id/read
 *
 * Toggle the current user's per-user "read" marker on a comment they were
 * mentioned in. Only users present in the comment's `mentions` may do this —
 * the affordance is theirs alone. Body: { read: boolean } (defaults to true).
 */
const setCommentMentionRead = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { taskId, id } = req.params;
    const read = req.body?.read !== false; // default → mark read

    const comment = await Comment.findOne({ _id: id, task: taskId });
    if (!comment) return res.status(404).json({ error: 'Comment not found' });

    const task = await Task.findById(taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const access = await checkTaskAccess(task, userId);
    if (!access.ok) {
      return res.status(access.status).json({ error: access.error });
    }

    // Only a mentioned user can mark this comment read for themselves.
    const isMentioned = Array.isArray(comment.mentions)
      ? comment.mentions.some((m) => m.toString() === userId)
      : false;
    if (!isMentioned) {
      return res.status(403).json({ error: 'Not mentioned in this comment' });
    }

    const already = comment.mentionReads.some((u) => u.toString() === userId);
    if (read && !already) {
      comment.mentionReads.push(userId);
      await comment.save();
    } else if (!read && already) {
      comment.mentionReads = comment.mentionReads.filter(
        (u) => u.toString() !== userId
      );
      await comment.save();
    }

    const populated = await Comment.findById(comment._id)
      .populate('author', 'name profilePic email')
      .populate('mentions', 'name profilePic email')
      .populate({ path: 'replyTo', select: 'author text', populate: { path: 'author', select: 'name' } });

    return res.json({ comment: populated });
  } catch (err) {
    console.error('setCommentMentionRead error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

module.exports = {
  getComments,
  addComment,
  editComment,
  setCommentMentionRead,
};
