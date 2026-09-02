const Channel = require('../models/Channel');
const Message = require('../models/Message');
const ChannelRead = require('../models/ChannelRead');
const Board = require('../models/Board');
const TaskGroup = require('../models/TaskGroup');
const Task = require('../models/Task');
const Goal = require('../models/Goal');
const eventBus = require('../services/eventBus');
const { loadBoardContext, loadOrgContext, requireCapability } = require('../utils/boardContext');
const { resolveAccess } = require('../utils/permissions');
const { channelAudience } = require('../services/chatAudience');
const { createNotificationsForUsers } = require('../services/notificationService');
const { monthKeyOf } = require('../utils/monthKey');
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
  // A DM admits exactly its two participants. No manage rung — a private
  // conversation has no administrator.
  if (channel.kind === 'dm') {
    const isMember = (channel.members || []).some(
      (m) => String(m?._id || m) === String(userId)
    );
    if (!isMember) return { ok: false, status: 403, error: 'Access denied' };
    return { ok: true, view: true, post: true, manage: false };
  }
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

    // Rooms belong to the workspace; DMs belong to their two PEOPLE and show
    // up in every workspace's sidebar — a conversation with a person is one
    // conversation, wherever you happen to be standing.
    const channels = await Channel.find({
      archived: false,
      $or: [
        { organisation: orgId, kind: { $ne: 'dm' } },
        { kind: 'dm', members: userId },
      ],
    })
      .populate('board', 'name visibility publicDefaultLevel memberAccess createdBy organisation boardType')
      .populate('members', 'name profilePic email');

    // Visibility, board by board. Boards were populated above precisely so
    // resolveAccess can run without a second query per channel.
    const internal = ctx.can('board.view_public');
    const visible = channels.filter((ch) => {
      if (ch.kind === 'dm') {
        return (ch.members || []).some((m) => String(m?._id || m) === String(userId));
      }
      if (!ch.board) return internal;
      return resolveAccess(ch.board, ctx.org, userId).canRead;
    });

    // Legacy per-workspace DM rows: the same pair may exist twice from before
    // DMs were unified. Show ONE per pair — the row that has ever carried a
    // message wins, else the oldest. openDm() merges them for real on the
    // next open; this keeps the sidebar honest in the meantime.
    const byPair = new Map();
    const rooms = [];
    for (const ch of visible) {
      if (ch.kind !== 'dm') {
        rooms.push(ch);
        continue;
      }
      const pairKey = (ch.members || [])
        .map((m) => String(m?._id || m))
        .sort()
        .join(':');
      const existing = byPair.get(pairKey);
      // Keep the OLDEST row — the same one openDm's real merge keeps, so the
      // sidebar and the merge always agree on which conversation survives.
      if (!existing || new Date(ch.createdAt) < new Date(existing.createdAt)) {
        byPair.set(pairKey, ch);
      }
    }
    const visibleChannels = [...rooms, ...byPair.values()];

    if (!visibleChannels.length) return res.json({ channels: [] });

    const channelIds = visibleChannels.map((c) => c._id);

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
          lastAuthorType: { $first: '$authorType' },
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
      visibleChannels.map(async (ch) => {
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

    const payload = visibleChannels.map((ch, i) => {
      const last = latestByChannel.get(String(ch._id));
      // A DM presents as the OTHER person — its stored name is incidental.
      const other =
        ch.kind === 'dm'
          ? (ch.members || []).find((m) => String(m?._id || m) !== String(userId)) || null
          : null;
      return {
        _id: ch._id,
        kind: ch.kind || 'channel',
        name: other?.name || ch.name,
        otherUser: other
          ? { _id: other._id, name: other.name, profilePic: other.profilePic }
          : null,
        board: ch.board ? { _id: ch.board._id, name: ch.board.name } : null,
        group: ch.group || null,
        archived: ch.archived,
        unread: counts[i],
        lastMessage: last
          ? {
              at: last.lastAt,
              text: (last.lastText || '').slice(0, 140),
              authorName:
                last.lastAuthorType === 'system'
                  ? 'Macan'
                  : authorName.get(String(last.lastAuthor)) || '',
            }
          : null,
      };
    });

    // Sections sort: workspace channels first, then boards A→Z, channels A→Z
    // inside each; the client renders in the order given.
    payload.sort((a, b) => {
      if ((a.kind === 'dm') !== (b.kind === 'dm')) return a.kind === 'dm' ? 1 : -1;
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
 * POST /api/chat/dms — { org, userId }
 *
 * Find-or-create the DM between the caller and one other member of the
 * workspace. Idempotent under the partial unique index on `dmKey`, so two
 * racing taps land on the same conversation. Internal members only, both
 * sides: a DM is workspace chat, and guests don't get workspace chat.
 */
const openDm = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { org: orgId, userId: otherId } = req.body || {};
    if (!orgId || !otherId) {
      return res.status(400).json({ error: 'org and userId are required' });
    }
    if (String(otherId) === String(userId)) {
      return res.status(400).json({ error: 'That would be a diary, not a DM' });
    }

    const ctx = await loadOrgContext(orgId, userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    if (!ctx.can('board.view_public')) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const otherIsMember = (ctx.org.members || []).some(
      (m) => String(m?._id || m) === String(otherId)
    );
    if (!otherIsMember) {
      return res.status(404).json({ error: 'That person is not in this workspace' });
    }
    const { resolveOrgAccess } = require('../utils/permissions');
    if (!resolveOrgAccess(ctx.org, otherId).can('board.view_public')) {
      return res.status(403).json({ error: 'That person cannot use workspace chat' });
    }

    const [low, high] = [String(userId), String(otherId)].sort();
    // GLOBAL key — one conversation per pair of people, whatever workspace
    // either of them is standing in. (`organisation` still records where the
    // DM was first opened, for bookkeeping only.)
    const dmKey = `${low}:${high}`;

    // Legacy rows: DMs used to be keyed per workspace, so this pair may own
    // several channels. Merge them into the OLDEST row (same choice the
    // sidebar dedupe makes): messages and read markers move over, duplicates
    // go away, and the survivor takes the canonical key.
    const existing = await Channel.find({
      kind: 'dm',
      members: { $all: [low, high] },
    }).sort({ createdAt: 1 });

    if (existing.length > 0) {
      const keep = existing[0];
      const dupIds = existing.slice(1).map((c) => c._id);
      if (dupIds.length) {
        await Message.updateMany(
          { channel: { $in: dupIds } },
          { $set: { channel: keep._id } }
        );
        const dupReads = await ChannelRead.find({ channel: { $in: dupIds } });
        for (const r of dupReads) {
          // $max: the merged marker never moves anyone's read line backwards.
          // eslint-disable-next-line no-await-in-loop
          await ChannelRead.findOneAndUpdate(
            { channel: keep._id, user: r.user },
            { $max: { lastReadAt: r.lastReadAt } },
            { upsert: true }
          );
        }
        await ChannelRead.deleteMany({ channel: { $in: dupIds } });
        await Channel.deleteMany({ _id: { $in: dupIds } });
      }
      if (keep.dmKey !== dmKey) {
        keep.dmKey = dmKey;
        await keep.save();
      }
      return res.status(200).json({ channel: keep });
    }

    const channel = await Channel.findOneAndUpdate(
      { dmKey },
      {
        $setOnInsert: {
          organisation: orgId,
          kind: 'dm',
          members: [low, high],
          board: null,
          group: null,
          name: 'Direct message',
          archived: false,
          createdBy: userId,
          dmKey,
        },
      },
      { upsert: true, new: true }
    );

    return res.status(201).json({ channel });
  } catch (err) {
    console.error('openDm error:', err);
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

    // DMs are cross-workspace: the sender may not belong to the workspace
    // the DM was first opened in, and it doesn't matter — access was already
    // settled by resolveChannelAccess (membership of the pair). Rooms still
    // load their org for the audience derivation.
    let audience;
    if (channel.kind === 'dm') {
      audience = await channelAudience(channel);
    } else {
      const orgCtx = await loadOrgContext(channel.organisation, userId);
      if (orgCtx.error) return res.status(orgCtx.status).json({ error: orgCtx.error });
      // Mentions must be people who can actually see the channel — a mention
      // that notifies someone into a room they cannot open is a leak.
      audience = await channelAudience(channel, orgCtx.org);
    }
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
        message:
          channel.kind === 'dm'
            ? 'mentioned you in a direct message'
            : `mentioned you in #${channel.name}`,
        // A DM mention is org-less (like personal-task notifications): it
        // shows in the bell whichever workspace the recipient is viewing.
        orgId: channel.kind === 'dm' ? null : String(channel.organisation),
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


/**
 * POST /api/chat/channels/:channelId/messages/:messageId/task
 *
 * "Make this a task" — the conversation produced a piece of work, so the
 * work gets a row on the channel's board without anyone retyping it.
 *
 * The task is a perfectly ordinary task: default status, the board's current
 * month on tracker boards, the caller as creator, the message's text carried
 * in the note with its provenance. The message then gets the new task as its
 * share chip, so the room can see the conversation became work — and the
 * chip still moves no score; the rule survives Phase 2 intact.
 *
 * Gate: `task.create` on the channel's board — making a task from a message
 * IS making a task, so it costs exactly what the board's own New Task button
 * costs. Board channels only; a workspace room has no board to put a row on.
 */
const makeTaskFromMessage = async (req, res) => {
  try {
    const userId = req.user.userId;
    const channel = await Channel.findById(req.params.channelId);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    if (!channel.board) {
      return res.status(400).json({ error: 'Workspace channels have no board to create the task on' });
    }

    const message = await Message.findOne({
      _id: req.params.messageId,
      channel: channel._id,
    }).populate('author', 'name');
    if (!message) return res.status(404).json({ error: 'Message not found' });
    if (message.task) {
      return res.status(400).json({ error: 'This message already has a task' });
    }

    const ctx = await loadBoardContext(channel.board, userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    const denied = requireCapability(
      ctx,
      'task.create',
      'You do not have permission to create tasks on this board'
    );
    if (denied) return res.status(denied.status).json({ error: denied.error });

    // The group: a client channel's own client; a manual board channel takes
    // an explicit groupId (validated against the board) since it has none.
    const groupId = channel.group || req.body?.groupId || null;
    if (!groupId) {
      return res.status(400).json({ error: 'Pick a group for the task — this channel is not tied to one' });
    }
    const group = await TaskGroup.findOne({ _id: groupId, board: channel.board });
    if (!group) return res.status(400).json({ error: 'That group is not on this board' });

    // Name: the caller's override, else the message's first line.
    const firstLine = (message.bodyText || '').split('\n')[0].trim();
    const name = ((req.body?.name || '').trim() || firstLine || 'Task from chat').slice(0, 200);

    const authorName =
      message.authorType === 'system' ? 'Macan' : message.author?.name || 'someone';
    const note = [
      `From #${channel.name} — posted by ${authorName}:`,
      '',
      (message.bodyText || '').slice(0, 4000),
    ].join('\n');

    // Lazy require: automationController itself requires nothing of chat, but
    // keeping the require local mirrors taskController's cycle-avoidance.
    const { resolveDefaultStatusId } = require('./automationController');

    const task = await Task.create({
      name,
      board: channel.board,
      group: group._id,
      parent: null,
      // Tracker boards file every task under a month; "now, in the board's
      // timezone" is the only honest month for a task born in a chat.
      monthKey:
        ctx.board.boardType === 'tracker'
          ? monthKeyOf(new Date(), ctx.board.monthTimezone || 'UTC')
          : null,
      priority: 'medium',
      status: resolveDefaultStatusId(ctx.board),
      assignedTo: [],
      note,
      isPersonal: false,
      createdBy: userId,
    });

    // A chat-born task is a normal manual create, so ITEM_CREATED automations
    // hear about it like any other.
    try {
      eventBus.emit('item.created', {
        taskId: task._id,
        boardId: String(channel.board),
        groupId: String(group._id),
        statusId: task.status,
        createdByUserId: userId,
      });
    } catch (emitErr) {
      // best-effort
    }

    // The message now points at the work it produced.
    message.task = task._id;
    await message.save();

    const populated = await Message.findById(message._id).populate(MESSAGE_POPULATE);
    return res.status(201).json({ task, message: populated });
  } catch (err) {
    console.error('makeTaskFromMessage error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

module.exports = {
  listChannels,
  createChannel,
  openDm,
  updateChannel,
  markChannelRead,
  getMessages,
  sendMessage,
  editMessage,
  deleteMessage,
  makeTaskFromMessage,
  uploadChatAttachment,
  // exported for tests
  resolveChannelAccess,
  ensureAutoChannels,
};
