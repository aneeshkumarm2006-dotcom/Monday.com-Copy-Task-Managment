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
const { markChannelRead: writeChannelRead, markThreadRead: writeThreadRead, threadReadMap } = require('../services/chatRead');
const { createSurfaces } = require('../services/workstreamSurfaces');
const { keyForSurface } = require('../utils/chatSurfaces');
const { isClientBoard } = require('../utils/clientBoard');
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
 *
 * TRACKER BOARDS ONLY, and deliberately so. A client board's surfaces are
 * CHOSEN by the team rather than minted automatically, and this function runs
 * on every global sidebar fetch — which now excludes client boards — so
 * extending it there would create rooms it then filters out, org-wide, on
 * every request.
 *
 * `mode` and `audience` are written EXPLICITLY, in both the filter and the
 * insert. Two reasons, and the first is the one that bites:
 *
 *   - The filter `{board, group}` no longer identifies a row. A workstream can
 *     carry up to four surfaces, so a bare pair could match any of them.
 *     Tracker groups only ever have the one, but a filter that is accidentally
 *     right is a filter that stops being right.
 *   - Relying on schema defaults here means relying on `setDefaultsOnInsert`,
 *     which is unset globally in this app. A document inserted without them
 *     indexes as `(board, group, null, null)` — a DIFFERENT key from
 *     `(board, group, 'chat', 'team')` — and the next call mints a duplicate.
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
        filter: { board: g.board, group: g._id, mode: 'chat', audience: 'team' },
        update: {
          $setOnInsert: {
            organisation: orgId,
            board: g.board,
            group: g._id,
            mode: 'chat',
            audience: 'team',
            name: g.name || 'Untitled client',
            archived: false,
            createdBy: null,
          },
        },
        upsert: true,
      },
    })),
    { ordered: false }
  ).catch((err) => {
    // E11000 on an upsert IS the race the unique index exists to win — two
    // sidebar fetches arriving together, one losing. Rethrowing it would turn
    // a won race into a 500 on the sidebar, the board tab and the portal list
    // at once, because an unordered bulkWrite throws rather than reporting.
    const writeErrors = err?.writeErrors || [];
    const allDuplicates =
      err?.code === 11000 ||
      (writeErrors.length > 0 && writeErrors.every((e) => e?.code === 11000));
    if (!allDuplicates) throw err;
  });
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
      .populate('board', 'name visibility publicDefaultLevel memberAccess createdBy organisation boardType monthTimezone')
      .populate('members', 'name profilePic email');

    // Visibility, board by board. Boards were populated above precisely so
    // resolveAccess can run without a second query per channel.
    const internal = ctx.can('board.view_public');
    const visible = channels.filter((ch) => {
      if (ch.kind === 'dm') {
        return (ch.members || []).some((m) => String(m?._id || m) === String(userId));
      }
      if (!ch.board) return internal;
      // A CLIENT BOARD'S ROOMS LIVE ONLY ON THAT BOARD'S CHAT TAB.
      //
      // Not a permission decision — the reader can already see these — but a
      // placement one, and it matters. These are conversations WITH an outside
      // company; mixed into the same list as internal team chat, they are how
      // somebody answers in the wrong room. `isClientBoardChannel` on the
      // client mirrors this exactly, and the mobile tab badge must apply the
      // same filter or it advertises unread the user cannot reach from there.
      if (isClientBoard(ch.board)) return false;
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
        board: ch.board
          ? {
              _id: ch.board._id,
              name: ch.board.name,
              // The share pickers need these: a tracker board's task and goal
              // reads are month-scoped, and "now, in the board's timezone" is
              // the month a chat share means.
              boardType: ch.board.boardType || null,
              monthTimezone: ch.board.monthTimezone || null,
            }
          : null,
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

    // $max, not $set — see services/chatRead.js. A stale tab reporting an old
    // `at` must never move the marker backwards and resurrect read messages.
    await writeChannelRead({ channelId: channel._id, userId, at: lastReadAt });
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
      // NEVER into a room the client is in. A task chip carries the internal
      // name and status of a row the client has no other way to see — most
      // rows on a client board are ordinary internal work — and a goal chip
      // carries a target we may not have agreed with them. The share picker is
      // hidden on these channels, but hiding a control is a courtesy; this is
      // the control.
      if (channel.audience === 'client') {
        return res.status(400).json({
          error: 'Tasks and goals cannot be shared into a client-facing channel',
        });
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
    // `audience` is now {userIds, contactIds}. This is the TEAM send path, so
    // `mentions` names Users and is validated against userIds only; a team
    // member mentioning a client contact goes through `mentionsContacts`,
    // which this endpoint does not accept.
    const audienceSet = new Set(audience.userIds);
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
    // unread, so the marker rides forward with the send. Through the shared
    // helper, so the `$max`-never-backwards rule has one implementation across
    // both principal types and both units (channel and thread).
    await writeChannelRead({ channelId: channel._id, userId, at: message.createdAt });

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

    // Real-time fan-out to everyone who can see the channel — BOTH principal
    // types. `recipientContactIds` is empty for every team surface, which is
    // every channel that is not on an upgraded client board, so this is inert
    // until a board is upgraded.
    try {
      eventBus.emit('chat.message', {
        channelId: String(channel._id),
        messageId: String(message._id),
        orgId: String(channel.organisation),
        recipientIds: audience.userIds.filter((id) => id !== String(userId)),
        recipientContactIds: audience.contactIds,
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


/* ------------------------------------------------------------------ */
/* Client boards: the board Chat tab, and the setup picker             */
/* ------------------------------------------------------------------ */

/** One channel as the board tab wants it, with its surface key resolved. */
const serializeSurface = (ch, { unread = 0, lastMessage = null } = {}) => ({
  _id: ch._id,
  kind: ch.kind || 'channel',
  mode: ch.mode || 'chat',
  audience: ch.audience || 'team',
  surfaceKey: keyForSurface(ch.mode || 'chat', ch.audience || 'team'),
  name: ch.name,
  group: ch.group || null,
  archived: ch.archived,
  unread,
  lastMessage,
});

/**
 * GET /api/chat/boards/:boardId/channels
 *
 * Every surface on one board, grouped by workstream — the board Chat tab.
 *
 * Separate from `listChannels` rather than a query param on it, because the two
 * answer different questions and have opposite defaults. The sidebar asks "what
 * are all my conversations", auto-creates tracker rooms as a side effect, and
 * now deliberately EXCLUDES client boards. This asks "what exists on this one
 * board", creates nothing, and is the only place client rooms appear.
 */
const listBoardChannels = async (req, res) => {
  try {
    const userId = req.user.userId;
    const ctx = await loadBoardContext(req.params.boardId, userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

    const channels = await Channel.find({ board: ctx.board._id, archived: false }).sort({
      createdAt: 1,
    });

    const ids = channels.map((c) => c._id);

    // Same preview + unread machinery as the sidebar. Kept here rather than
    // shared because the sidebar's version also handles DMs and legacy pair
    // merging, neither of which can occur on a board.
    const latest = ids.length
      ? await Message.aggregate([
          { $match: { channel: { $in: ids } } },
          { $sort: { channel: 1, createdAt: -1 } },
          {
            $group: {
              _id: '$channel',
              lastAt: { $first: '$createdAt' },
              lastText: { $first: '$bodyText' },
              lastAuthor: { $first: '$author' },
              lastAuthorType: { $first: '$authorType' },
              lastPortalAuthor: { $first: '$portalAuthor' },
            },
          },
        ])
      : [];
    const latestByChannel = new Map(latest.map((l) => [String(l._id), l]));

    const reads = await ChannelRead.find({ user: userId, channel: { $in: ids } });
    const readByChannel = new Map(reads.map((r) => [String(r.channel), r.lastReadAt]));

    const counts = await Promise.all(
      channels.map(async (ch) => {
        const last = latestByChannel.get(String(ch._id));
        if (!last) return 0;
        const readAt = readByChannel.get(String(ch._id));
        if (readAt && last.lastAt <= readAt) return 0;
        return Message.countDocuments({
          channel: ch._id,
          ...(readAt ? { createdAt: { $gt: readAt } } : {}),
          author: { $ne: userId },
        });
      })
    );

    // Author names for the preview line, across BOTH principal types — a client
    // room's newest message is as likely to be the client's as ours.
    const User = require('../models/User');
    const ClientContact = require('../models/ClientContact');
    const userIds = [...new Set(latest.map((l) => String(l.lastAuthor)).filter(Boolean))];
    const contactIds = [
      ...new Set(latest.map((l) => String(l.lastPortalAuthor)).filter(Boolean)),
    ];
    const [users, contacts] = await Promise.all([
      userIds.length ? User.find({ _id: { $in: userIds } }).select('name') : [],
      contactIds.length
        ? ClientContact.find({ _id: { $in: contactIds } }).select('name email')
        : [],
    ]);
    const nameOf = new Map(users.map((u) => [String(u._id), u.name]));
    contacts.forEach((c) => nameOf.set(String(c._id), c.name || c.email));

    const previewFor = (ch) => {
      const last = latestByChannel.get(String(ch._id));
      if (!last) return null;
      const author =
        last.lastAuthorType === 'system'
          ? 'Macan'
          : nameOf.get(String(last.lastPortalAuthor || last.lastAuthor)) || '';
      return {
        at: last.lastAt,
        text: (last.lastText || '').slice(0, 140),
        authorName: author,
      };
    };

    const byGroup = new Map();
    const extras = [];
    channels.forEach((ch, i) => {
      const payload = serializeSurface(ch, {
        unread: counts[i],
        lastMessage: previewFor(ch),
      });
      if (!ch.group) {
        extras.push(payload);
        return;
      }
      const key = String(ch.group);
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key).push(payload);
    });

    // Every group, INCLUDING those with no surfaces — a workstream with none is
    // precisely the row that has to render "Set up communication", so it cannot
    // be filtered out by starting from the channels.
    const groups = await TaskGroup.find({ board: ctx.board._id })
      .select('name order')
      .sort({ order: 1, createdAt: 1 })
      .lean();

    return res.json({
      board: {
        _id: ctx.board._id,
        name: ctx.board.name,
        boardType: ctx.board.boardType,
        portalTier: ctx.board.portalTier || 'basic',
        portalClientName: ctx.board.portalClientName || '',
      },
      canManage: ctx.can('group.manage'),
      workstreams: groups.map((g) => {
        const surfaces = byGroup.get(String(g._id)) || [];
        return {
          group: { _id: g._id, name: g.name, order: g.order },
          surfaces,
          surfaceKeys: surfaces.map((s) => s.surfaceKey).filter(Boolean),
        };
      }),
      extras,
    });
  } catch (err) {
    console.error('listBoardChannels error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/chat/boards/:boardId/groups/:groupId/surfaces
 * Body: { clientChat, clientMail, team }
 *
 * The setup picker's write. Idempotent — re-running with the same selection
 * reports everything as `existing` and creates nothing.
 */
const createGroupSurfaces = async (req, res) => {
  try {
    const userId = req.user.userId;
    const ctx = await loadBoardContext(req.params.boardId, userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

    const denied = requireCapability(
      ctx,
      'group.manage',
      'You do not have permission to set up communication on this board'
    );
    if (denied) return res.status(denied.status).json({ error: denied.error });

    // The group must be on THIS board. Scoped by the board the caller's access
    // was resolved against, never by a board id from the body.
    const group = await TaskGroup.findOne({
      _id: req.params.groupId,
      board: ctx.board._id,
    }).select('name board');
    if (!group) return res.status(404).json({ error: 'Workstream not found' });

    const result = await createSurfaces(
      ctx.board,
      group,
      {
        clientChat: Boolean(req.body?.clientChat),
        clientMail: Boolean(req.body?.clientMail),
        team: Boolean(req.body?.team),
      },
      { createdBy: userId }
    );

    if (!result.ok) {
      return res.status(400).json({ error: result.refusals[0], refusals: result.refusals });
    }

    return res.status(201).json({
      created: result.created.map((c) => serializeSurface(c)),
      existing: result.existing.map((c) => serializeSurface(c)),
    });
  } catch (err) {
    console.error('createGroupSurfaces error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Mail: threads                                                       */
/* ------------------------------------------------------------------ */

/**
 * The thread list for a mail channel, newest ACTIVITY first.
 *
 * Shared by both planes — the team's endpoint below and the portal's — because
 * the aggregation IS the feature, and two copies would sort differently within
 * a release of each other.
 *
 * WHY AN AGGREGATION AND NOT THE ORDINARY MESSAGE LIST. Chat's listing sorts
 * top-level messages by their own `createdAt`, which for mail is the moment the
 * thread was OPENED. Gmail sorts by last activity, and it is right to: a thread
 * answered this morning must not sit at the bottom because it was started in
 * March. So each root is joined to its replies to compute `lastAt`, and that is
 * what both the sort and the pagination cursor use.
 *
 * The cursor is `lastAt` for the same reason. Paging on the root's `createdAt`
 * while sorting on `lastAt` would skip and repeat rows as threads move.
 */
const loadThreads = async (channelId, { before = null, limit = MAX_MESSAGE_LIMIT } = {}) => {
  const rows = await Message.aggregate([
    { $match: { channel: channelId, replyTo: null } },
    {
      $lookup: {
        from: 'messages',
        localField: '_id',
        foreignField: 'replyTo',
        as: 'replies',
      },
    },
    {
      $addFields: {
        replyCount: { $size: '$replies' },
        // The root's own timestamp is the floor: a thread with no replies is as
        // recent as the day it was written, not as recent as nothing.
        lastAt: { $max: { $concatArrays: [['$createdAt'], '$replies.createdAt'] } },
        lastText: {
          $let: {
            vars: {
              newest: {
                $first: { $sortArray: { input: '$replies', sortBy: { createdAt: -1 } } },
              },
            },
            in: { $ifNull: ['$$newest.bodyText', '$bodyText'] },
          },
        },
        // Everyone who has spoken in the thread, root author included. Kept as
        // two id sets rather than resolved names, because the two planes
        // resolve them differently — the client must never receive a team
        // member's email address.
        participantUsers: {
          $setUnion: [
            { $cond: [{ $ifNull: ['$author', false] }, ['$author'], []] },
            { $filter: { input: '$replies.author', as: 'a', cond: { $ne: ['$$a', null] } } },
          ],
        },
        participantContacts: {
          $setUnion: [
            { $cond: [{ $ifNull: ['$portalAuthor', false] }, ['$portalAuthor'], []] },
            {
              $filter: {
                input: '$replies.portalAuthor',
                as: 'a',
                cond: { $ne: ['$$a', null] },
              },
            },
          ],
        },
      },
    },
    ...(before ? [{ $match: { lastAt: { $lt: before } } }] : []),
    { $sort: { lastAt: -1 } },
    { $limit: limit },
    {
      $project: {
        subject: 1,
        bodyText: 1,
        lastText: 1,
        lastAt: 1,
        createdAt: 1,
        replyCount: 1,
        participantUsers: 1,
        participantContacts: 1,
        author: 1,
        portalAuthor: 1,
        authorType: 1,
      },
    },
  ]);

  return {
    threads: rows,
    nextBefore: rows.length === limit ? rows[rows.length - 1].lastAt : null,
  };
};

/**
 * Resolve the (user, contact) id sets on a page of threads to display names.
 *
 * `includeAvatars` is off for the portal: a team member's `profilePic` is a
 * Google URL that identifies them beyond the name we chose to share.
 */
const nameParticipants = async (rows, { includeAvatars = true } = {}) => {
  const User = require('../models/User');
  const ClientContact = require('../models/ClientContact');
  const userIds = [...new Set(rows.flatMap((r) => (r.participantUsers || []).map(String)))];
  const contactIds = [
    ...new Set(rows.flatMap((r) => (r.participantContacts || []).map(String))),
  ];
  const [users, contacts] = await Promise.all([
    userIds.length ? User.find({ _id: { $in: userIds } }).select('name profilePic') : [],
    contactIds.length
      ? ClientContact.find({ _id: { $in: contactIds } }).select('name email')
      : [],
  ]);
  const byId = new Map();
  users.forEach((u) =>
    byId.set(String(u._id), {
      name: u.name,
      ...(includeAvatars ? { profilePic: u.profilePic } : {}),
      kind: 'user',
    })
  );
  contacts.forEach((c) => byId.set(String(c._id), { name: c.name || c.email, kind: 'client' }));
  return byId;
};

/**
 * One thread row as both planes want it, given the resolved names and this
 * reader's marker. `unread` is computed rather than stored: no marker at all
 * means never opened, which is unread.
 */
const serializeThreadRow = (t, names, seenAt) => ({
  _id: t._id,
  subject: t.subject || '(no subject)',
  snippet: (t.lastText || t.bodyText || '').slice(0, 140),
  participants: [...(t.participantUsers || []), ...(t.participantContacts || [])]
    .map((id) => names.get(String(id)))
    .filter(Boolean),
  replyCount: t.replyCount || 0,
  lastAt: t.lastAt,
  createdAt: t.createdAt,
  unread: !seenAt || t.lastAt > seenAt,
});

/**
 * GET /api/chat/channels/:channelId/threads?before=<ISO>
 */
const listThreads = async (req, res) => {
  try {
    const userId = req.user.userId;
    const channel = await Channel.findById(req.params.channelId);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    if (channel.mode !== 'mail') {
      return res.status(400).json({ error: 'This channel is not a mailbox' });
    }

    const access = await resolveChannelAccess(channel, userId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });

    const before = req.query.before ? new Date(req.query.before) : null;
    const { threads, nextBefore } = await loadThreads(channel._id, {
      before: before && !Number.isNaN(before.getTime()) ? before : null,
    });

    const names = await nameParticipants(threads);
    const readAt = await threadReadMap({ threadIds: threads.map((t) => t._id), userId });

    return res.json({
      threads: threads.map((t) => serializeThreadRow(t, names, readAt.get(String(t._id)))),
      nextBefore,
      canPost: access.post,
      canManage: access.manage,
    });
  } catch (err) {
    console.error('listThreads error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/chat/channels/:channelId/threads
 * Body: { subject, body, bodyText, attachments, mentions }
 *
 * Start a mail thread. THIS is where "a mail root must carry a subject" is
 * enforced — see the comment on `Message.subject` for why the model cannot:
 * the rule depends on `channel.mode`, which lives on another document, and this
 * is a place that already holds it.
 */
const createThread = async (req, res) => {
  try {
    const userId = req.user.userId;
    const channel = await Channel.findById(req.params.channelId);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    if (channel.mode !== 'mail') {
      return res.status(400).json({ error: 'This channel is not a mailbox' });
    }
    if (channel.archived) return res.status(400).json({ error: 'This channel is archived' });

    const access = await resolveChannelAccess(channel, userId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    if (!access.post) {
      return res.status(403).json({ error: 'You do not have permission to post here' });
    }

    const subject = (req.body?.subject || '').toString().trim();
    if (!subject) return res.status(400).json({ error: 'A subject is required' });
    if (subject.length > 200) {
      return res.status(400).json({ error: 'Subject must be 200 characters or fewer' });
    }

    const bodyText = (req.body?.bodyText || '').trim();
    const attachments = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
    if (!bodyText && !attachments.length) {
      return res.status(400).json({ error: 'Message is empty' });
    }

    const orgCtx = await loadOrgContext(channel.organisation, userId);
    if (orgCtx.error) return res.status(orgCtx.status).json({ error: orgCtx.error });
    const audience = await channelAudience(channel, orgCtx.org);
    const audienceSet = new Set(audience.userIds);
    const validMentions = [
      ...new Set((Array.isArray(req.body?.mentions) ? req.body.mentions : []).map(String)),
    ].filter((id) => audienceSet.has(id));

    const message = await Message.create({
      channel: channel._id,
      author: userId,
      subject,
      body: req.body?.body || null,
      bodyText,
      attachments,
      mentions: validMentions,
      replyTo: null,
    });

    // Writing a thread is reading it.
    await writeThreadRead({
      threadId: message._id,
      channelId: channel._id,
      userId,
      at: message.createdAt,
    });

    try {
      eventBus.emit('chat.message', {
        channelId: String(channel._id),
        messageId: String(message._id),
        orgId: String(channel.organisation),
        recipientIds: audience.userIds.filter((id) => id !== String(userId)),
        recipientContactIds: audience.contactIds,
      });
    } catch (emitErr) {
      // Delivery is best-effort; the message is already stored.
    }

    const populated = await Message.findById(message._id).populate(MESSAGE_POPULATE);
    return res.status(201).json({ message: populated });
  } catch (err) {
    console.error('createThread error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/chat/channels/:channelId/threads/:threadId/read
 *
 * Per-thread, because mail reads a thread. Opening "Q4 budget" must not mark
 * "October plan" read.
 */
const markThreadReadEndpoint = async (req, res) => {
  try {
    const userId = req.user.userId;
    const channel = await Channel.findById(req.params.channelId);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });

    const access = await resolveChannelAccess(channel, userId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });

    const thread = await Message.findOne({
      _id: req.params.threadId,
      channel: channel._id,
      replyTo: null,
    }).select('_id');
    if (!thread) return res.status(404).json({ error: 'Thread not found' });

    await writeThreadRead({
      threadId: thread._id,
      channelId: channel._id,
      userId,
      at: req.body?.at || null,
    });
    return res.json({ success: true });
  } catch (err) {
    console.error('markThreadRead error:', err);
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
  listBoardChannels,
  createGroupSurfaces,
  listThreads,
  createThread,
  markThreadRead: markThreadReadEndpoint,
  // Exported for tests AND for the portal plane, which reuses the thread
  // aggregation rather than growing a second one that sorts differently.
  resolveChannelAccess,
  ensureAutoChannels,
  loadThreads,
  nameParticipants,
  serializeThreadRow,
  serializeSurface,
};
