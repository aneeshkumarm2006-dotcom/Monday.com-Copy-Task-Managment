const Task = require('../models/Task');
const Board = require('../models/Board');
const Update = require('../models/Update');
const User = require('../models/User');
const Organisation = require('../models/Organisation');
const {
  createNotificationsForUsers,
} = require('../services/notificationService');
const { sendMentionEmail } = require('../services/emailService');
const { logActivity } = require('../services/activityService');
const { destroyCloudinaryAssets } = require('../config/cloudinary');

/**
 * Access rules (mirrors commentController):
 *   - Personal task: only the creator can read / post.
 *   - Board task: any org member can read / post.
 */
const checkTaskAccess = async (task, userId) => {
  if (task.isPersonal) {
    if (!task.createdBy || task.createdBy.toString() !== userId) {
      return { status: 403, error: 'Not authorised' };
    }
    return { ok: true };
  }
  const board = await Board.findById(task.board);
  if (!board) return { status: 404, error: 'Board not found' };
  const org = await Organisation.findById(board.organisation);
  if (!org) return { status: 404, error: 'Organisation not found' };
  const isMember = org.members.some((m) => m.toString() === userId);
  if (!isMember) {
    return { status: 403, error: 'Not a member of this organisation' };
  }
  return { ok: true, board, org };
};

/**
 * GET /api/tasks/:taskId/updates
 */
const getUpdates = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { taskId } = req.params;
    const task = await Task.findById(taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const access = await checkTaskAccess(task, userId);
    if (!access.ok) {
      return res.status(access.status).json({ error: access.error });
    }

    const updates = await Update.find({ task: taskId })
      .populate('author', 'name profilePic email')
      .populate('mentions', 'name profilePic email')
      .populate({ path: 'replyTo', select: 'author bodyText attachments', populate: { path: 'author', select: 'name' } })
      .sort({ createdAt: -1 });

    return res.json({ updates });
  } catch (err) {
    console.error('getUpdates error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/tasks/:taskId/updates
 *
 * Body: {
 *   body:        TipTap JSON document (object)
 *   bodyText:    plain-text fallback for notifications/preview
 *   mentions:    [userId]
 *   attachments: [{ url, name, mime, size }]
 * }
 */
const addUpdate = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { taskId } = req.params;
    const { body, bodyText, mentions, attachments, replyTo } = req.body || {};

    const hasBody =
      (body && typeof body === 'object' && Object.keys(body).length > 0) ||
      (typeof bodyText === 'string' && bodyText.trim().length > 0);
    const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
    if (!hasBody && !hasAttachments) {
      return res.status(400).json({ error: 'Update body is required' });
    }

    const task = await Task.findById(taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const access = await checkTaskAccess(task, userId);
    if (!access.ok) {
      return res.status(access.status).json({ error: access.error });
    }

    // Validate mention IDs against the task's org members.
    let validMentions = [];
    if (Array.isArray(mentions) && mentions.length > 0 && !task.isPersonal) {
      const board = access.board || (await Board.findById(task.board));
      if (board) {
        const org =
          access.org || (await Organisation.findById(board.organisation));
        if (org) {
          const memberSet = new Set(org.members.map((m) => m.toString()));
          validMentions = mentions.filter((id) => memberSet.has(id.toString()));
        }
      }
    }

    // Sanitize attachments — drop any without a url.
    const cleanAttachments = Array.isArray(attachments)
      ? attachments
          .filter((a) => a && typeof a.url === 'string' && a.url.length > 0)
          .map((a) => ({
            url: a.url,
            name: a.name || '',
            mime: a.mime || '',
            size: Number.isFinite(a.size) ? a.size : 0,
            publicId: a.publicId || '',
          }))
      : [];

    // Validate replyTo — must reference an update on the same task.
    let replyToId = null;
    let parentAuthorId = null;
    if (replyTo) {
      const parentUpdate = await Update.findOne({ _id: replyTo, task: taskId });
      if (parentUpdate) {
        replyToId = parentUpdate._id;
        parentAuthorId = parentUpdate.author || null;
      }
    }

    const update = await Update.create({
      task: taskId,
      author: userId,
      body: body || null,
      bodyText: (bodyText || '').toString().slice(0, 4000),
      mentions: validMentions,
      attachments: cleanAttachments,
      replyTo: replyToId,
    });

    logActivity({
      task,
      actor: userId,
      type: 'update.added',
      metadata: {
        updateSnippet: (bodyText || '').toString().trim().slice(0, 80),
        taskName: task.name,
        attachmentCount: cleanAttachments.length,
      },
    });

    const populated = await Update.findById(update._id)
      .populate('author', 'name profilePic email')
      .populate('mentions', 'name profilePic email')
      .populate({ path: 'replyTo', select: 'author bodyText attachments', populate: { path: 'author', select: 'name' } });

    // Resolve org id from the board (board tasks only) so notifications are
    // scoped to the right organisation.
    let notifOrgId = null;
    if (!task.isPersonal) {
      const taskBoard =
        access.board ||
        (await Board.findById(task.board).select('organisation'));
      notifOrgId = taskBoard?.organisation || null;
    }

    // Notify assignees (board tasks only).
    if (!task.isPersonal && Array.isArray(task.assignedTo)) {
      const authorName = populated.author?.name || 'Someone';
      await createNotificationsForUsers({
        userIds: task.assignedTo,
        type: 'commented',
        message: `${authorName} posted an update on "${task.name}"`,
        taskId: task._id,
        orgId: notifOrgId,
        excludeUserId: userId,
      });
    }

    // Notify the author of the update being replied to (skips self-replies via
    // excludeUserId). Carries a 'updates' tab hint so clicking the notification
    // opens the task's Updates tab.
    if (parentAuthorId) {
      const authorName = populated.author?.name || 'Someone';
      await createNotificationsForUsers({
        userIds: [parentAuthorId],
        type: 'replied',
        message: `${authorName} replied to your update on "${task.name}"`,
        taskId: task._id,
        orgId: notifOrgId,
        excludeUserId: userId,
        tab: 'updates',
      });
    }

    // Notify + email mentioned users.
    if (validMentions.length > 0) {
      const authorName = populated.author?.name || 'Someone';
      await createNotificationsForUsers({
        userIds: validMentions,
        type: 'mentioned',
        message: `${authorName} mentioned you in an update on "${task.name}"`,
        taskId: task._id,
        orgId: notifOrgId,
        excludeUserId: userId,
      });

      const mentionIds = validMentions.filter((id) => id.toString() !== userId);
      const mentionedUsers = await User.find(
        { _id: { $in: mentionIds } },
        'email name'
      );
      const boardId = task.board?.toString?.() || task.board;
      const taskLink = `${process.env.CLIENT_URL || 'http://localhost:5173'}/boards/${boardId}`;
      const previewText = (bodyText || '').toString().trim().slice(0, 280);
      const emailResults = await Promise.allSettled(
        mentionedUsers.map((u) =>
          sendMentionEmail({
            to: u.email,
            mentionedByName: authorName,
            taskName: task.name,
            commentText: previewText || '(rich update)',
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

    return res.status(201).json({ update: populated });
  } catch (err) {
    console.error('addUpdate error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * PATCH /api/tasks/:taskId/updates/:id
 *
 * Only the update's author can edit. Accepts the same body shape as addUpdate
 * (body, bodyText, mentions, attachments) and stamps `editedAt`. No
 * notifications are emitted on edit — newly-added mentions don't ping.
 */
const editUpdate = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { taskId, id } = req.params;
    const { body, bodyText, mentions, attachments } = req.body || {};

    const update = await Update.findOne({ _id: id, task: taskId });
    if (!update) return res.status(404).json({ error: 'Update not found' });

    const task = await Task.findById(taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const access = await checkTaskAccess(task, userId);
    if (!access.ok) {
      return res.status(access.status).json({ error: access.error });
    }

    if (!update.author || update.author.toString() !== userId) {
      return res.status(403).json({ error: 'Not authorised' });
    }

    const hasBody =
      (body && typeof body === 'object' && Object.keys(body).length > 0) ||
      (typeof bodyText === 'string' && bodyText.trim().length > 0);
    const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
    if (!hasBody && !hasAttachments) {
      return res.status(400).json({ error: 'Update body is required' });
    }

    let validMentions = [];
    if (Array.isArray(mentions) && mentions.length > 0 && !task.isPersonal) {
      const board = access.board || (await Board.findById(task.board));
      if (board) {
        const org =
          access.org || (await Organisation.findById(board.organisation));
        if (org) {
          const memberSet = new Set(org.members.map((m) => m.toString()));
          validMentions = mentions.filter((id) => memberSet.has(id.toString()));
        }
      }
    }

    const cleanAttachments = Array.isArray(attachments)
      ? attachments
          .filter((a) => a && typeof a.url === 'string' && a.url.length > 0)
          .map((a) => ({
            url: a.url,
            name: a.name || '',
            mime: a.mime || '',
            size: Number.isFinite(a.size) ? a.size : 0,
            publicId: a.publicId || '',
          }))
      : [];

    // Destroy Cloudinary assets for attachments removed in this edit.
    const newPublicIds = new Set(cleanAttachments.map((a) => a.publicId).filter(Boolean));
    const removedAttachments = update.attachments.filter(
      (a) => a.publicId && !newPublicIds.has(a.publicId)
    );
    await destroyCloudinaryAssets(removedAttachments);

    update.body = body || null;
    update.bodyText = (bodyText || '').toString().slice(0, 4000);
    update.mentions = validMentions;
    update.attachments = cleanAttachments;
    update.editedAt = new Date();
    await update.save();

    const populated = await Update.findById(update._id)
      .populate('author', 'name profilePic email')
      .populate('mentions', 'name profilePic email')
      .populate({ path: 'replyTo', select: 'author bodyText attachments', populate: { path: 'author', select: 'name' } });

    return res.json({ update: populated });
  } catch (err) {
    console.error('editUpdate error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * DELETE /api/tasks/:taskId/updates/:id
 *
 * Only the update's author (or an org admin on the board) can delete.
 */
const deleteUpdate = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { taskId, id } = req.params;

    const update = await Update.findOne({ _id: id, task: taskId });
    if (!update) return res.status(404).json({ error: 'Update not found' });

    const task = await Task.findById(taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const access = await checkTaskAccess(task, userId);
    if (!access.ok) {
      return res.status(access.status).json({ error: access.error });
    }

    const isAuthor = update.author && update.author.toString() === userId;
    let isAdmin = false;
    if (!task.isPersonal) {
      const org =
        access.org ||
        (access.board &&
          (await Organisation.findById(access.board.organisation)));
      if (org) {
        isAdmin =
          (org.admin && org.admin.toString() === userId) ||
          (Array.isArray(org.admins) &&
            org.admins.some((a) => a.toString() === userId));
      }
    }
    if (!isAuthor && !isAdmin) {
      return res.status(403).json({ error: 'Not authorised' });
    }

    await destroyCloudinaryAssets(update.attachments);
    await Update.deleteOne({ _id: id });
    return res.json({ ok: true });
  } catch (err) {
    console.error('deleteUpdate error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/tasks/:taskId/updates/attachments
 *
 * Cloudinary-backed upload handler. The multer middleware in routes/updates.js
 * does the actual upload; this endpoint just relays the resulting URL back to
 * the client so the editor can embed/link the file.
 */
const uploadAttachment = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { taskId } = req.params;

    const task = await Task.findById(taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const access = await checkTaskAccess(task, userId);
    if (!access.ok) {
      return res.status(access.status).json({ error: access.error });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    return res.status(201).json({
      attachment: {
        url: req.file.path || req.file.secure_url || req.file.url,
        name: req.file.originalname || '',
        mime: req.file.mimetype || '',
        size: req.file.size || 0,
        publicId: req.file.public_id || req.file.filename || '',
      },
    });
  } catch (err) {
    console.error('uploadAttachment error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * PATCH /api/tasks/:taskId/updates/:id/read
 *
 * Toggle the current user's per-user "read" marker on an update they were
 * mentioned in. Only users present in the update's `mentions` may do this.
 * Body: { read: boolean } (defaults to true).
 */
const setUpdateMentionRead = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { taskId, id } = req.params;
    const read = req.body?.read !== false; // default → mark read

    const update = await Update.findOne({ _id: id, task: taskId });
    if (!update) return res.status(404).json({ error: 'Update not found' });

    const task = await Task.findById(taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const access = await checkTaskAccess(task, userId);
    if (!access.ok) {
      return res.status(access.status).json({ error: access.error });
    }

    // Only a mentioned user can mark this update read for themselves.
    const isMentioned = Array.isArray(update.mentions)
      ? update.mentions.some((m) => m.toString() === userId)
      : false;
    if (!isMentioned) {
      return res.status(403).json({ error: 'Not mentioned in this update' });
    }

    const already = update.mentionReads.some((u) => u.toString() === userId);
    if (read && !already) {
      update.mentionReads.push(userId);
      await update.save();
    } else if (!read && already) {
      update.mentionReads = update.mentionReads.filter(
        (u) => u.toString() !== userId
      );
      await update.save();
    }

    const populated = await Update.findById(update._id)
      .populate('author', 'name profilePic email')
      .populate('mentions', 'name profilePic email')
      .populate({ path: 'replyTo', select: 'author bodyText attachments', populate: { path: 'author', select: 'name' } });

    return res.json({ update: populated });
  } catch (err) {
    console.error('setUpdateMentionRead error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

module.exports = {
  getUpdates,
  addUpdate,
  editUpdate,
  deleteUpdate,
  uploadAttachment,
  setUpdateMentionRead,
};
