const Task = require('../models/Task');
const Board = require('../models/Board');
const Update = require('../models/Update');
const User = require('../models/User');
const {
  createNotificationsForUsers,
  notifyTaskAudience,
  filterByEmailPreference,
} = require('../services/notificationService');
const { sendMentionEmail, sendUpdateEmail } = require('../services/emailService');
const ItemFollow = require('../models/ItemFollow');
const { logActivity } = require('../services/activityService');
const { destroyCloudinaryAssets } = require('../config/cloudinary');
const { loadBoardContext } = require('../utils/boardContext');
const { filterUsersWithBoardRead } = require('../utils/boardAudience');
const { buildTaskDeepLink } = require('../utils/taskDeepLink');
const { sendPortalReplyEmailForTask } = require('./portalController');

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
 * The `visibility` clause for a thread read.
 *
 * 'internal' is an exact match; anything else means the shared thread — and that
 * one has to be `$ne: 'internal'` rather than `'shared'`, because every Update
 * written before this field existed carries no `visibility` at all. A
 * `{ visibility: 'shared' }` query would return an empty feed for every
 * pre-existing task.
 */
const visibilityFilter = (raw) =>
  raw === 'internal' ? 'internal' : { $ne: 'internal' };

/**
 * GET /api/tasks/:taskId/updates?visibility=shared|internal
 *
 * Both feeds are gated on board READ, exactly as the single feed was: internal
 * notes are hidden from the CLIENT (who reaches the task through /api/portal and
 * can never select them), not from teammates who can already open the task.
 * Posting one still takes `update.create` — see addUpdate.
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

    // 'system' updates are portal-only timeline events (status changes shown to
    // the client). Keep them out of the team's discussion feed.
    const updates = await Update.find({
      task: taskId,
      authorType: { $ne: 'system' },
      visibility: visibilityFilter(req.query?.visibility),
    })
      .populate('author', 'name profilePic email')
      .populate('portalAuthor', 'name')
      .populate('mentions', 'name profilePic email')
      .populate({ path: 'replyTo', select: 'author portalAuthor bodyText attachments', populate: [{ path: 'author', select: 'name' }, { path: 'portalAuthor', select: 'name' }] })
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
 *   visibility:  'shared' (default) | 'internal' — 'internal' posts to the
 *                team-only thread: no portal render, no client email.
 * }
 */
const addUpdate = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { taskId } = req.params;
    const { body, bodyText, mentions, attachments, replyTo } = req.body || {};
    const isInternal = req.body?.visibility === 'internal';

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

    // Which of the task's threads this post lands in. Only a client board has
    // two, so a shared post is only "client-facing" there; on a standard board
    // 'shared' just means the one ordinary thread. Drives the activity wording,
    // the notification tab hint, and the audience email's Reply-To.
    const isClientBoard = access.board?.boardType === 'client';
    const thread = isInternal ? 'team' : isClientBoard ? 'client' : 'default';

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

    // Validate replyTo — must reference an update on the same task AND in the
    // same thread. Crossing the boundary would render an internal note's snippet
    // inside the shared feed's "Replying to" block, which the client can read.
    let replyToId = null;
    let parentAuthorId = null;
    if (replyTo) {
      const parentUpdate = await Update.findOne({
        _id: replyTo,
        task: taskId,
        visibility: visibilityFilter(isInternal ? 'internal' : 'shared'),
      });
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
      visibility: isInternal ? 'internal' : 'shared',
    });

    logActivity({
      task,
      actor: userId,
      type: 'update.added',
      metadata: {
        updateSnippet: (bodyText || '').toString().trim().slice(0, 80),
        taskName: task.name,
        attachmentCount: cleanAttachments.length,
        thread,
      },
    });

    // Client Portal: this is the authenticated (team) post path, so when the
    // task was raised by an external client, email that client their reply.
    // Fire-and-forget — the helper swallows its own errors.
    // An internal note is precisely the thing that must NOT reach them.
    if (!isInternal && task.source === 'client' && task.portalSubmitter) {
      sendPortalReplyEmailForTask(task, bodyText);
    }

    const populated = await Update.findById(update._id)
      .populate('author', 'name profilePic email')
      .populate('portalAuthor', 'name')
      .populate('mentions', 'name profilePic email')
      .populate({ path: 'replyTo', select: 'author portalAuthor bodyText attachments', populate: [{ path: 'author', select: 'name' }, { path: 'portalAuthor', select: 'name' }] });

    // Resolve org id from the board (board tasks only) so notifications are
    // scoped to the right organisation.
    let notifOrgId = null;
    if (!task.isPersonal) {
      const taskBoard =
        access.board ||
        (await Board.findById(task.board).select('organisation'));
      notifOrgId = taskBoard?.organisation || null;
    }

    // Which tab a click on this notification should open. The team thread IS the
    // Updates tab, so it needs no hint. The client thread is its own tab — and
    // only exists on a client board, so on a standard board there is nothing to
    // point at.
    const notifTab = thread === 'client' ? 'client' : null;

    // Notify assignees (board tasks only). Notifications only ever reach app
    // Users — a ClientContact has no notification feed — so either thread is safe
    // here; the wording just says which one the post landed in.
    if (!task.isPersonal && Array.isArray(task.assignedTo)) {
      const authorName = populated.author?.name || 'Someone';
      await notifyTaskAudience(task, {
        type: 'commented',
        message:
          thread === 'client'
            ? `${authorName} replied to the client on "${task.name}"`
            : `${authorName} posted an update on "${task.name}"`,
        orgId: notifOrgId,
        excludeUserId: userId,
        actorId: userId,
        boardId: task.board,
        tab: notifTab,
      });
    }

    // Notify the author of the post being replied to (skips self-replies via
    // excludeUserId), carrying the tab hint for the thread it landed in.
    if (parentAuthorId) {
      const authorName = populated.author?.name || 'Someone';
      await createNotificationsForUsers({
        userIds: [parentAuthorId],
        type: 'replied',
        message: `${authorName} replied to your ${
          notifTab === 'client' ? 'client message' : 'update'
        } on "${task.name}"`,
        taskId: task._id,
        orgId: notifOrgId,
        excludeUserId: userId,
        tab: notifTab || 'updates',
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
        'mentioned',
        { boardId: task.board, actorId: userId }
      );
      const taskLink = buildTaskDeepLink(task, { tab: 'updates' });
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

    // Email the task AUDIENCE (assignees + followers) on the update — for every
    // board, not just client portals. Mentioned users already got their own email
    // above, and the author is excluded. Preference + DND gated like all channels.
    if (!task.isPersonal) {
      try {
        const followerDocs = await ItemFollow.find({ task: task._id }).select('user');
        const followerIds = followerDocs.map((f) => String(f.user));
        const assigneeIds = (task.assignedTo || []).map((u) => String(u._id || u));
        const mentionSet = new Set((validMentions || []).map((m) => m.toString()));
        const audienceIds = [...new Set([...assigneeIds, ...followerIds])].filter(
          (id) => id !== userId && !mentionSet.has(id)
        );
        if (audienceIds.length) {
          const emailAllowed = await filterByEmailPreference(audienceIds, 'commented', {
            boardId: task.board,
            actorId: userId,
          });
          const recipients = await User.find(
            { _id: { $in: [...emailAllowed] } },
            'email name'
          );
          if (recipients.length) {
            const authorName = populated.author?.name || 'Someone';
            const taskLink = buildTaskDeepLink(task, { tab: 'updates' });
            const previewText = (bodyText || '').toString().trim().slice(0, 280) || '(rich update)';
            const results = await Promise.allSettled(
              recipients.map((u) =>
                sendUpdateEmail({
                  to: u.email,
                  authorName,
                  taskName: task.name,
                  commentText: previewText,
                  taskLink,
                  taskId: String(task._id),
                  // Picks the Reply-To as well as the copy, so a reply by email
                  // lands back in the SAME thread this mail came from.
                  thread,
                })
              )
            );
            results.forEach((r, i) => {
              if (r.status === 'rejected') {
                console.error(`[email] Failed to send update email to ${recipients[i]?.email}:`, r.reason);
              }
            });
          }
        }
      } catch (audienceEmailErr) {
        console.error('audience update email error:', audienceEmailErr);
      }
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
      .populate('portalAuthor', 'name')
      .populate('mentions', 'name profilePic email')
      .populate({ path: 'replyTo', select: 'author portalAuthor bodyText attachments', populate: [{ path: 'author', select: 'name' }, { path: 'portalAuthor', select: 'name' }] });

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
      .populate('portalAuthor', 'name')
      .populate('mentions', 'name profilePic email')
      .populate({ path: 'replyTo', select: 'author portalAuthor bodyText attachments', populate: [{ path: 'author', select: 'name' }, { path: 'portalAuthor', select: 'name' }] });

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
