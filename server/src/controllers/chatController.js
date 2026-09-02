const Channel = require('../models/Channel');
const Message = require('../models/Message');
const ChannelRead = require('../models/ChannelRead');
const Board = require('../models/Board');
const TaskGroup = require('../models/TaskGroup');
const Task = require('../models/Task');
const Goal = require('../models/Goal');
const eventBus = require('../services/eventBus');
const { loadBoardContext, loadOrgContext } = require('../utils/boardContext');
const { resolveAccess, resolveOrgAccess } = require('../utils/permissions');
const { createNotificationsForUsers } = require('../services/notificationService');
const { destroyCloudinaryAssets } = require('../config/cloudinary');

/**
 * Chat — Phase 1. Channels sectioned by board, messages shaped like Updates,
 * membership derived on every read, zero automatic posting.
 *
 * ---- Permissions: deliberately NO new chat.* capabilities -------------------
 *
 * `ensureSystemRoles` seeds missing ROLES, never missing capabilities on roles
 * an org already stored (see the `board.export_activity` note in
 * capabilities.js). A brand-new `chat.post` capability would therefore be
 * absent from every existing workspace's stored role lists — chat would launch
 * locked for the exact teams it was built for, until an admin hand-ticked
 * three boxes per role. So Phase 1 rides the semantics that already exist and
 * already mean the right thing:
 *
 *   SEE a board channel   = read the board            (access.canRead)
 *   POST in one           = weigh in on the board     (can('update.create'))
 *   MANAGE board channels = restructure the board     (can('group.manage'))
 *   SEE / POST workspace channels = internal member   (org can('board.view_public'))
 *   MANAGE workspace channels     = run the workspace (org can('org.manage_settings'))
 *
 * `board.view_public` as the "internal member" test is not a proxy grabbed at
 * random: its absence is the defining property of the guest role ("the absence
 * of board.view_public is the whole point of this role"), and guests must not
 * see workspace-wide rooms. A custom role stripped of it is treated as
 * external here too, which is the conservative reading.
 *
 * ---- Auto channels ----------------------------------------------------------
 *
 * A "client" is a group on a tracker board, so the roster of channels IS the
 * roster of (tracker board x group). `ensureAutoChannels` lazily upserts one
 * channel per pair whenever a workspace's sidebar is fetched — idempotent
 * under the partial unique index on (board, group), so two racing requests
 * cannot mint duplicates. No Client entity exists, so the same client on two
 * boards is two channels; that is a data-model fact, not a chat decision.
 *
 * ---- Chat never writes a score ---------------------------------------------
 *
 * Share chips (message.task / message.goal) are references. Nothing posted
 * here changes a status, a score, or a tracker cell. Phase 1 also posts
 * nothing automatically — every message in a channel was typed by a person.
 */

const MAX_MESSAGE_LIMIT = 50;

/* ------------------------------------------------------------------ */
/* Access resolution                                                   */
/* ------------------------------------------------------------------ */

/**
 * Resolve what `userId` may do in `channel`. Returns
 * `{ ok, status?, error?, view, post, manage, board? }`.
 * Fails closed: a channel whose board has vanished admits nobody.
 */
const resolveChannelAccess = async (channel, userId) => {
  if (channel.board) {
    const ctx = await loadBoardContext(channel.board, userId);
    if (ctx.error) return { ok: false, status: ctx.status, error: ctx.error };
    return {
      ok: true,
      view: true,
      post: ctx.can('update.create'),
      manage: ctx.can('group.manage'),
      boardCtx: ctx,
    };
  }
  const ctx = await loadOrgContext(channel.organisation, userId);
  if (ctx.error) return { ok: false, status: ctx.status, error: ctx.error };
  if (!ctx.can('board.view_public')) {
    // External collaborators (guests) never see workspace-wide rooms.
    return { ok: false, status: 403, error: 'Access denied' };
  }
  return {
    ok: true,
    view: true,
    post: true,
    manage: ctx.can('org.manage_settings'),
    orgCtx: ctx,
  };
};

/**
 * Everyone who may currently SEE `channel` — the fan-out list for SSE frames
 * and mention notifications. Derived fresh each time, so a revoked board
 * share stops the stream the moment it stops the board.
 */
const channelAudience = async (channel, org) => {
  const memberIds = (org.members || []).map((m) => String(m?._id || m));
  if (!channel.board) {
    return memberIds.filter((id) =>
      // Same "internal member" test as resolveChannelAccess.
      resolveOrgAccess(org, id).can('board.view_public')
    );
  }
  const board = await Board.findById(channel.board);
  if (!board) return [];
  return memberIds.filter((id) => resolveAccess(board, org, id).canRead);
};

/* ------------------------------------------------------------------ */
/* Auto-channel backfill                                               */
/* ------------------------------------------------------------------ */

/**
 * Upsert one channel per (tracker board, group) in the org. Runs on every
 * sidebar fetch; the partial unique index makes racing calls converge on one
 * row. `setOnInsert` only — a channel an admin renamed keeps its name when
 * the group's name later drifts.
 */
const ensureAutoChannels = async (orgId) => {
  const boards = await Board.find({
    organisation: orgId,
    boardType: 'tracker',
  }).select('_id');
  if (!boards.length) return;

  const groups = await TaskGroup.find({
    board: { $in: boards.map((b) => b._id) },
  }).select('_id board name');
  if (!groups.length) return;

  await Channel.bulkWrite(
    groups.map((g) => ({
      updateOne: {
        filter: { board: g.board, group: g._id },
        update: {
          $setOnInsert: {
            organisation: orgId,
            board: g.board,
            group: g._id,
            name: g.name || 'Untitled client',
            archived: false,
            createdBy: null,
          },
        },
        upsert: true,
      },
    })),
    { ordered: false }
  );
};

/* ------------------------------------------------------------------ */
/* Channels                                                            */
/* ------------------------------------------------------------------ */

/**
 * GET /api/chat/channels?org=<orgId>
 *
 * The sidebar: every channel the caller may see, sectioned by board, each
 * carrying its unread count and a one-line preview of the latest message.
 */
const listChannels = async (req, res) => {
  try {
    const userId = req.user.userId;
    const orgId = (req.query.org || '').toString();
    if (!orgId) return res.status(400).json({ error: 'org is required' });

    const ctx = await loadOrgContext(orgId, userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

    await ensureAutoChannels(orgId);

    const channels = await Channel.find({
      organisation: orgId,
      archived: false,
    }).populate('board', 'name visibility publicDefaultLevel memberAccess createdBy organisation boardType');

    // Visibility, board by board. Boards were populated above precisely so
    // resolveAccess can run without a second query per channel.
    const internal = ctx.can('board.view_public');
    const visible = channels.filter((ch) => {
      if (!ch.board) return internal;
      return resolveAccess(ch.board, ctx.org, userId).canRead;
    });

    if (!visible.length) return res.json({ channels: [] });

    const channelIds = visible.map((c) => c._id);

    // Latest top-level-or-reply message per channel, for the preview line.
    const latest = await Message.aggregate([
      { $match: { channel: { $in: channelIds } } },
      { $sort: { channel: 1, createdAt: -1 } },
      {
        $group: {
          _id: '$channel',
          lastAt: { $first: '$createdAt' },
          lastText: { $first: '$bodyText' },
          lastAuthor: { $first: '$author' },
        },
      },
    ]);
    const latestByChannel = new Map(latest.map((l) => [String(l._id), l]));

    const reads = await ChannelRead.find({
      user: userId,
      channel: { $in: channelIds },
    });
    const readByChannel = new Map(reads.map((r) => [String(r.channel), r.lastReadAt]));

    // Unread counts: one indexed count per channel with anything in it. The
    // sidebar is a few dozen channels; a per-channel threshold cannot ride a
    // single aggregation without a $switch the next reader would curse.
    const counts = await Promise.all(
      visible.map(async (ch) => {
        const last = latestByChannel.get(String(ch._id));
        if (!last) return 0; // empty channel — nothing to be unread
        const readAt = readByChannel.get(String(ch._id));
        if (readAt && last.lastAt <= readAt) return 0; // fast path: seen it all
        return Message.countDocuments({
          channel: ch._id,
          ...(readAt ? { createdAt: { $gt: readAt } } : {}),
          author: { $ne: userId },
        });
      })
    );

    const User = require('../models/User');
    const authorIds = [...new Set(latest.map((l) => String(l.lastAuthor)).filter(Boolean))];
    const authors = await User.find({ _id: { $in: authorIds } }).select('name');
    const authorName = new Map(authors.map((u) => [String(u._id), u.name]));

    const payload = visible.map((ch, i) => {
      const last = latestByChannel.get(String(ch._id));
      return {
        _id: ch._id,
        name: ch.name,
        board: ch.board ? { _id: ch.board._id, name: ch.board.name } : null,
        group: ch.group || null,
        archived: ch.archived,
        unread: counts[i],
        lastMessage: last
          ? {
              at: last.lastAt,
              text: (last.lastText || '').slice(0, 140),
              authorName: authorName.get(String(last.lastAuthor)) || '',
            }
          : null,
      };
    });

    // Sections sort: workspace channels first, then boards A→Z, channels A→Z
    // inside each; the client renders in the order given.
    payload.sort((a, b) => {
      const ab = a.board?.name || '';
      const bb = b.board?.name || '';
      if (ab !== bb) return ab.localeCompare(bb);
      return a.name.localeCompare(b.name);
    });

    return res.json({ channels: payload });
  } catch (err) {
    console.error('listChannels error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/chat/channels — { org, boardId?, name }
 *
 * A manual channel: workspace-level (no boardId, needs org.manage_settings)
 * or an extra room under a board (needs group.manage on that board).
 */
const createChannel = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { org: orgId, boardId, name } = req.body || {};
    const trimmed = (name || '').trim();
    if (!orgId) return res.status(400).json({ error: 'org is required' });
    if (!trimmed) return res.status(400).json({ error: 'Channel name is required' });
    if (trimmed.length > 80) {
      return res.status(400).json({ error: 'Channel name is too long (80 characters max)' });
    }

    if (boardId) {
      const ctx = await loadBoardContext(boardId, userId);
      if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
      if (!ctx.can('group.manage')) {
        return res.status(403).json({ error: 'You do not have permission to add channels on this board' });
      }
      if (String(ctx.board.organisation) !== String(orgId)) {
        return res.status(400).json({ error: 'Board is not in this workspace' });
      }
    } else {
      const ctx = await loadOrgContext(orgId, userId);
      if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
      if (!ctx.can('org.manage_settings')) {
        return res.status(403).json({ error: 'You do not have permission to add workspace channels' });
      }
    }

    const channel = await Channel.create({
      organisation: orgId,
      board: boardId || null,
      group: null,
      name: trimmed,
      createdBy: userId,
    });
    return res.status(201).json({ channel });
  } catch (err) {
    console.error('createChannel error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * PATCH /api/chat/channels/:channelId — { name?, archived? }
 * Rename / archive / unarchive. History is never deleted from here.
 */
const updateChannel = async (req, res) => {
  try {
    const userId = req.user.userId;
    const channel = await Channel.findById(req.params.channelId);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });

    const access = await resolveChannelAccess(channel, userId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    if (!access.manage) {
      return res.status(403).json({ error: 'You do not have permission to manage this channel' });
    }

    const { name, archived } = req.body || {};
    if (name !== undefined) {
      const trimmed = (name || '').trim();
      if (!trimmed) return res.status(400).json({ error: 'Channel name is required' });
      if (trimmed.length > 80) {
        return res.status(400).json({ error: 'Channel name is too long (80 characters max)' });
      }
      channel.name = trimmed;
    }
    if (archived !== undefined) channel.archived = !!archived;

    await channel.save();
    return res.json({ channel });
  } catch (err) {
    console.error('updateChannel error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/chat/channels/:channelId/read
 * Move the caller's read marker to now (or to `at`, if the client passes the
 * timestamp of the newest message it actually rendered — safer under races).
 */
const markChannelRead = async (req, res) => {
  try {
    const userId = req.user.userId;
    const channel = await Channel.findById(req.params.channelId);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });

    const access = await resolveChannelAccess(channel, userId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });

    const at = req.body?.at ? new Date(req.body.at) : new Date();
    const lastReadAt = Number.isNaN(at.getTime()) ? new Date() : at;

    await ChannelRead.findOneAndUpdate(
      { channel: channel._id, user: userId },
      // $max, not $set: a stale tab reporting an old `at` must never move the
      // marker backwards and resurrect read messages as unread.
      { $max: { lastReadAt } },
      { upsert: true }
    );
    return res.json({ success: true });
  } catch (err) {
    console.error('markChannelRead error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Messages                                                            */
/* ------------------------------------------------------------------ */

const MESSAGE_POPULATE = [
  { path: 'author', select: 'name profilePic email' },
  { path: 'mentions', select: 'name' },
  { path: 'task', select: 'name status board group monthKey parent' },
  { path: 'goal', select: 'name board group monthKey type' },
];

/**
 * GET /api/chat/channels/:channelId/messages
 *   ?before=<ISO date>  — page older top-level messages (newest first)
 *   ?thread=<messageId> — one thread: the parent + replies, oldest first
 */
const getMessages = async (req, res) => {
  try {
    const userId = req.user.userId;
    const channel = await Channel.findById(req.params.channelId);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });

    const access = await resolveChannelAccess(channel, userId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });

    const threadId = (req.query.thread || '').toString();
    if (threadId) {
      const parent = await Message.findOne({ _id: threadId, channel: channel._id })
        .populate(MESSAGE_POPULATE);
      if (!parent) return res.status(404).json({ error: 'Message not found' });
      const replies = await Message.find({ replyTo: parent._id })
        .sort({ createdAt: 1 })
        .populate(MESSAGE_POPULATE);
      return res.json({ parent, replies });
    }

    const limit = Math.min(
      parseInt(req.query.limit, 10) || MAX_MESSAGE_LIMIT,
      MAX_MESSAGE_LIMIT
    );
    const before = req.query.before ? new Date(req.query.before) : null;

    const filter = { channel: channel._id, replyTo: null };
    if (before && !Number.isNaN(before.getTime())) {
      filter.createdAt = { $lt: before };
    }

    const messages = await Message.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate(MESSAGE_POPULATE);

    // Reply counts for the page, one aggregation.
    const ids = messages.map((m) => m._id);
    const replyCounts = ids.length
      ? await Message.aggregate([
          { $match: { replyTo: { $in: ids } } },
          { $group: { _id: '$replyTo', count: { $sum: 1 } } },
        ])
      : [];
    const countById = new Map(replyCounts.map((r) => [String(r._id), r.count]));

    return res.json({
      messages: messages.map((m) => ({
        ...m.toObject(),
        replyCount: countById.get(String(m._id)) || 0,
      })),
      // The cursor for the next page is the oldest message on this one.
      nextBefore: messages.length === limit ? messages[messages.length - 1].createdAt : null,
      canPost: access.post,
      canManage: access.manage,
    });
  } catch (err) {
    console.error('getMessages error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/chat/channels/:channelId/messages
 * { body, bodyText, attachments, mentions, replyTo, taskId, goalId }
 */
const sendMessage = async (req, res) => {
  try {
    const userId = req.user.userId;
    const channel = await Channel.findById(req.params.channelId);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    if (channel.archived) {
      return res.status(400).json({ error: 'This channel is archived' });
    }

    const access = await resolveChannelAccess(channel, userId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    if (!access.post) {
      return res.status(403).json({ error: 'You do not have permission to post in this channel' });
    }

    const {
      body = null,
      bodyText = '',
      attachments = [],
      mentions = [],
      replyTo = null,
      taskId = null,
      goalId = null,
    } = req.body || {};

    const text = (bodyText || '').trim();
    const hasAttachment = Array.isArray(attachments) && attachments.length > 0;
    if (!text && !hasAttachment && !taskId && !goalId) {
      return res.status(400).json({ error: 'Message is empty' });
    }

    // One-level threads, and never across channels: the parent must be a
    // TOP-LEVEL message of THIS channel.
    let parent = null;
    if (replyTo) {
      parent = await Message.findOne({ _id: replyTo, channel: channel._id });
      if (!parent) return res.status(404).json({ error: 'Message not found' });
      if (parent.replyTo) {
        return res.status(400).json({ error: 'Replies go one level deep — reply to the original message' });
      }
    }

    // Share chips: board channels only, and the item must live on the
    // channel's own board. A chip pointing off-board would leak names to
    // people whose access was resolved against a different board entirely.
    let task = null;
    let goal = null;
    if (taskId || goalId) {
      if (!channel.board) {
        return res.status(400).json({ error: 'Tasks and goals can only be shared in board channels' });
      }
      if (taskId) {
        task = await Task.findById(taskId).select('_id board name');
        if (!task || String(task.board) !== String(channel.board)) {
          return res.status(400).json({ error: 'That task is not on this channel’s board' });
        }
      }
      if (goalId) {
        goal = await Goal.findById(goalId).select('_id board name');
        if (!goal || String(goal.board) !== String(channel.board)) {
          return res.status(400).json({ error: 'That goal is not on this channel’s board' });
        }
      }
    }

    const orgCtx = await loadOrgContext(channel.organisation, userId);
    if (orgCtx.error) return res.status(orgCtx.status).json({ error: orgCtx.error });

    // Mentions must be people who can actually see the channel — a mention
    // that notifies someone into a room they cannot open is a leak.
    const audience = await channelAudience(channel, orgCtx.org);
    const audienceSet = new Set(audience);
    const validMentions = [
      ...new Set((Array.isArray(mentions) ? mentions : []).map(String)),
    ].filter((id) => audienceSet.has(id));

    const message = await Message.create({
      channel: channel._id,
      author: userId,
      body: body || null,
      bodyText: text,
      attachments: hasAttachment ? attachments : [],
      mentions: validMentions,
      replyTo: parent ? parent._id : null,
      task: task ? task._id : null,
      goal: goal ? goal._id : null,
    });

    // Posting is reading: your own message must never count against you as
    // unread, so the marker rides forward with the send.
    await ChannelRead.findOneAndUpdate(
      { channel: channel._id, user: userId },
      { $max: { lastReadAt: message.createdAt } },
      { upsert: true }
    );

    // Mentions → the bell, through the same service as everything else (so
    // the 'mentions' preference toggle governs chat too).
    const mentioned = validMentions.filter((id) => id !== String(userId));
    if (mentioned.length) {
      await createNotificationsForUsers({
        userIds: mentioned,
        excludeUserId: userId,
        type: 'chatMention',
        message: `mentioned you in #${channel.name}`,
        orgId: String(channel.organisation),
        actorId: userId,
        channelId: String(channel._id),
      });
    }

    // Real-time fan-out to everyone who can see the channel.
    try {
      eventBus.emit('chat.message', {
        channelId: String(channel._id),
        messageId: String(message._id),
        orgId: String(channel.organisation),
        recipientIds: audience.filter((id) => id !== String(userId)),
      });
    } catch (emitErr) {
      // Delivery is best-effort; the message is already stored.
    }

    const populated = await Message.findById(message._id).populate(MESSAGE_POPULATE);
    return res.status(201).json({ message: populated });
  } catch (err) {
    console.error('sendMessage error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * PATCH /api/chat/channels/:channelId/messages/:messageId — author edits.
 */
const editMessage = async (req, res) => {
  try {
    const userId = req.user.userId;
    const message = await Message.findOne({
      _id: req.params.messageId,
      channel: req.params.channelId,
    });
    if (!message) return res.status(404).json({ error: 'Message not found' });
    if (String(message.author) !== String(userId)) {
      return res.status(403).json({ error: 'Only the author can edit a message' });
    }

    const channel = await Channel.findById(message.channel);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    const access = await resolveChannelAccess(channel, userId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });

    const { body, bodyText } = req.body || {};
    const text = (bodyText || '').trim();
    if (!text && !(message.attachments || []).length && !message.task && !message.goal) {
      return res.status(400).json({ error: 'Message is empty' });
    }

    message.body = body || null;
    message.bodyText = text;
    message.editedAt = new Date();
    await message.save();

    const populated = await Message.findById(message._id).populate(MESSAGE_POPULATE);
    return res.json({ message: populated });
  } catch (err) {
    console.error('editMessage error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * DELETE /api/chat/channels/:channelId/messages/:messageId
 * The author, or whoever may manage the channel. Replies go with the parent.
 */
const deleteMessage = async (req, res) => {
  try {
    const userId = req.user.userId;
    const message = await Message.findOne({
      _id: req.params.messageId,
      channel: req.params.channelId,
    });
    if (!message) return res.status(404).json({ error: 'Message not found' });

    const channel = await Channel.findById(message.channel);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    const access = await resolveChannelAccess(channel, userId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });

    const isAuthor = String(message.author) === String(userId);
    if (!isAuthor && !access.manage) {
      return res.status(403).json({ error: 'You do not have permission to delete this message' });
    }

    const replies = message.replyTo
      ? []
      : await Message.find({ replyTo: message._id }).select('attachments');

    // Cloudinary assets go down with the rows that referenced them.
    const assets = [message, ...replies].flatMap((m) =>
      (m.attachments || []).map((a) => ({ publicId: a.publicId, mime: a.mime }))
    );
    if (assets.length) await destroyCloudinaryAssets(assets);

    if (replies.length) await Message.deleteMany({ replyTo: message._id });
    await message.deleteOne();

    return res.json({ success: true });
  } catch (err) {
    console.error('deleteMessage error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/chat/channels/:channelId/attachments
 * Multer has already pushed the file to Cloudinary when this runs — mirror of
 * updateController.uploadAttachment, including the take-it-back-down rule.
 */
const uploadChatAttachment = async (req, res) => {
  try {
    const userId = req.user.userId;

    const discardUpload = () =>
      destroyCloudinaryAssets([
        {
          publicId: req.file?.public_id || req.file?.filename || '',
          mime: req.file?.mimetype || '',
        },
      ]);

    const channel = await Channel.findById(req.params.channelId);
    if (!channel) {
      await discardUpload();
      return res.status(404).json({ error: 'Channel not found' });
    }

    const access = await resolveChannelAccess(channel, userId);
    if (!access.ok) {
      await discardUpload();
      return res.status(access.status).json({ error: access.error });
    }
    if (!access.post) {
      await discardUpload();
      return res.status(403).json({ error: 'You do not have permission to post in this channel' });
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
    console.error('uploadChatAttachment error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

module.exports = {
  listChannels,
  createChannel,
  updateChannel,
  markChannelRead,
  getMessages,
  sendMessage,
  editMessage,
  deleteMessage,
  uploadChatAttachment,
  // exported for tests
  resolveChannelAccess,
  ensureAutoChannels,
};
