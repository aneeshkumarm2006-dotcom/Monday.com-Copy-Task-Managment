const Task = require('../models/Task');
const Board = require('../models/Board');
const Update = require('../models/Update');
const User = require('../models/User');
const {
  createNotificationsForUsers,
  notifyTaskAudience,
  filterByEmailPreference,
} = require('../services/notificationService');
const { sendMentionEmail } = require('../services/emailService');
const { logActivity } = require('../services/activityService');
const { destroyCloudinaryAssets } = require('../config/cloudinary');
const { loadBoardContext } = require('../utils/boardContext');
const { filterUsersWithBoardRead } = require('../utils/boardAudience');

/**
 * Access rules:
 *   - Personal task: only the creator can read / post.
 *   - Board task: the user must be able to READ the board the task lives on.
 *
 * Org membership alone is NOT sufficient. This used to check only
 * `org.members`, which meant any member could read and post comments on any
 * task on any private board they had never been granted — the board's own
 * access control was simply not consulted on this path. Comments carry the task
 * name, attachments and @mentions, so it was a full read-side hole around
 * [boardAccess.js](../utils/boardAccess.js).
 *
 * Reading the board is only the gate. The returned `can` carries the resolved
 * two-layer capability set, so every further decision on the task — may I post,
 * may I delete someone else's comment — is answered from the same context rather
 * than re-derived per handler.
 */
const checkTaskAccess = async (task, userId) => {
  if (task.isPersonal) {
    if (!task.createdBy || task.createdBy.toString() !== userId) {
      return { status: 403, error: 'Not authorised' };
    }
    // A personal task hangs off no board, so there is no ladder to climb: its
    // creator is its only audience and holds every task-content capability on it.
    //
    // Except `update.delete_any`. A personal task has exactly one participant, so
    // "delete anyone else's comment" has nobody to apply to — granting it here
    // would only ever mean "the creator may delete their own", which authorship
    // already allows. The old code forced isAdmin=false on personal tasks for the
    // same reason, making deletion strictly author-only; a blanket `() => true`
    // would silently widen that.
    return { ok: true, can: (cap) => cap !== 'update.delete_any' };
  }
  const ctx = await loadBoardContext(task.board, userId);
  if (ctx.error) return { status: ctx.status, error: ctx.error };
  return {
    ok: true,
    board: ctx.board,
    org: ctx.org,
    access: ctx.access,
    can: ctx.can,
  };
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

    // Reading the board no longer implies being able to comment on it: the
    // `view` rung is silent by design, and `comment` is the rung that speaks.
    if (!access.can('update.create')) {
      return res
        .status(403)
        .json({ error: 'You do not have permission to post updates' });
    }

    // Validate mention IDs against the people who can actually READ this board —
    // not merely against org members. Mentioning someone fires a notification and
    // an email naming the task, so an org-only check let you pull a colleague into
    // a private board they have no grant on.
    let validMentions = [];
    if (Array.isArray(mentions) && mentions.length > 0 && !task.isPersonal) {
      const allowed = await filterUsersWithBoardRead(task.board, mentions);
      validMentions = mentions.filter((id) => allowed.has(id.toString()));
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
      await notifyTaskAudience(task, {
        type: 'commented',
        message: `${authorName} posted an update on "${task.name}"`,
        orgId: notifOrgId,
        excludeUserId: userId,
        actorId: userId,
        boardId: task.board,
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
        actorId: userId,
        boardId: task.board,
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
        actorId: userId,
        boardId: task.board,
      });

      const mentionIds = validMentions.filter((id) => id.toString() !== userId);
      const mentionedUsers = await User.find(
        { _id: { $in: mentionIds } },
        'email name'
      );
      const mentionEmailAllowed = await filterByEmailPreference(
        mentionIds,
        'mentioned'
      );
      const boardId = task.board?.toString?.() || task.board;
      const taskLink = `${process.env.CLIENT_URL || 'http://localhost:5173'}/boards/${boardId}`;
      const previewText = (bodyText || '').toString().trim().slice(0, 280);
      const emailResults = await Promise.allSettled(
        mentionedUsers
          .filter((u) => mentionEmailAllowed.has(u._id.toString()))
          .map((u) =>
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
 * Only the update's author can edit, and only while they still hold
 * `update.create` on the board. Accepts the same body shape as addUpdate
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

    // Authorship is necessary but not sufficient. Editing a comment IS posting
    // one — it rewrites the body, the attachments and the mention list — so it
    // takes the same rung addUpdate takes. Gating on authorship alone left the
    // `update.create` check bypassable for anyone holding a pre-existing update:
    // a member demoted to `view` could still rewrite their old comments on a
    // board they may now only read.
    if (!access.can('update.create')) {
      return res
        .status(403)
        .json({ error: 'You do not have permission to post updates' });
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
      const allowed = await filterUsersWithBoardRead(task.board, mentions);
      validMentions = mentions.filter((id) => allowed.has(id.toString()));
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
 * Authors may always delete their own comment. Deleting SOMEONE ELSE'S takes
 * `update.delete_any` on the board.
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
    if (!isAuthor && !access.can('update.delete_any')) {
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
 *
 * Gated on `update.create` — the only thing an attachment can be attached to is
 * an update, so anyone who cannot post one has no business uploading for it.
 */
const uploadAttachment = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { taskId } = req.params;

    // multer (updateUpload.single) has ALREADY pushed the file to Cloudinary by
    // the time this handler runs — the gate is downstream of the upload, not in
    // front of it. So a denial that simply returns leaves the asset stranded in
    // the bucket with nothing referencing it. Take it back down on the way out.
    // No-ops when there is no file: destroyCloudinaryAssets skips entries with no
    // publicId.
    const discardUpload = () =>
      destroyCloudinaryAssets([
        {
          publicId: req.file?.public_id || req.file?.filename || '',
          mime: req.file?.mimetype || '',
        },
      ]);

    const task = await Task.findById(taskId);
    if (!task) {
      // Multer/CloudinaryStorage has ALREADY pushed the file by the time this
      // handler runs, so every early return that skips cleanup strands a paid
      // asset in the bucket with nothing referencing it.
      await discardUpload();
      return res.status(404).json({ error: 'Task not found' });
    }

    const access = await checkTaskAccess(task, userId);
    if (!access.ok) {
      await discardUpload();
      return res.status(access.status).json({ error: access.error });
    }

    if (!access.can('update.create')) {
      await discardUpload();
      return res
        .status(403)
        .json({ error: 'You do not have permission to post updates' });
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
    // Reachable, not theoretical: the route does not validate :taskId, so a
    // malformed id makes Task.findById throw a CastError — after the upload has
    // already happened. Tear the asset down, but never let a cleanup failure mask
    // the original error.
    try {
      await destroyCloudinaryAssets([
        {
          publicId: req.file?.public_id || req.file?.filename || '',
          mime: req.file?.mimetype || '',
        },
      ]);
    } catch (cleanupErr) {
      console.error('uploadAttachment cleanup failed:', cleanupErr);
    }
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
