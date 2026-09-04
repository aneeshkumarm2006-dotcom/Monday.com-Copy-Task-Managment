const Channel = require('../models/Channel');
const Message = require('../models/Message');
const Notification = require('../models/Notification');
const TaskGroup = require('../models/TaskGroup');
const User = require('../models/User');
const eventBus = require('../services/eventBus');
const portalStream = require('../services/portalStream');
const { verifyPortalToken } = require('../middleware/portalAuth');
const { channelAudience } = require('../services/chatAudience');
const { markChannelRead, markThreadRead, channelReadMap, threadReadMap } = require('../services/chatRead');
const { createNotificationsForUsers } = require('../services/notificationService');
const {
  loadThreads,
  nameParticipants,
  serializeThreadRow,
} = require('./chatController');
const {
  PORTAL_MESSAGE_POPULATE,
  serializeMessageForPortal,
  contactLabel,
} = require('../utils/portalMessage');
const { isAdvancedClientBoard } = require('../utils/clientBoard');
const { describeSurface } = require('../utils/chatSurfaces');

/**
 * Chat and mail for the EXTERNAL CLIENT.
 *
 * Every handler here runs behind `portalAuth`, so `req.portal` is trusted and
 * request params are not: the board always comes from the token, and a channel
 * id from the URL is only ever used to LOOK UP a row that is then checked
 * against that board.
 *
 * The read path is deliberately NOT shared with `chatController`. Its
 * `MESSAGE_POPULATE` selects `author.email`, and the two planes want different
 * shapes for good reasons — see `utils/portalMessage.js`. What IS shared is the
 * mail thread aggregation, because that is a sort order rather than a payload,
 * and two copies of it would drift.
 */

const MAX_LIMIT = 50;
const MAX_BODY_TEXT = 8000;
const MAX_SUBJECT = 200;

/* ------------------------------------------------------------------ */
/* The gate                                                            */
/* ------------------------------------------------------------------ */

/**
 * Is chat available on this portal at all?
 *
 * `portalAuth` has already proved the board is a live client board and that the
 * link has not been rotated. This adds the tier, which is the one thing that
 * separates a board where these endpoints exist from one where they do not.
 *
 * Returns an `{ status, error }` or null, matching the shape the rest of the
 * codebase's guards use.
 */
const requireChat = (req) => {
  if (!isAdvancedClientBoard(req.portal.board)) {
    return { status: 403, error: 'Chat is not enabled for this portal' };
  }
  return null;
};

/**
 * Load a channel this contact may actually be in.
 *
 * THREE conditions, and all three are load-bearing:
 *
 *   1. the channel is on the board in the TOKEN — never a board from the URL;
 *   2. `audience === 'client'` — this is what keeps the private team room
 *      private. The team room and the client room on one workstream differ by
 *      nothing else, so a lookup that checked only the board would hand the
 *      client the team's own conversation;
 *   3. not archived, for writes.
 *
 * Returns the channel or null; callers 404 rather than 403, so a client cannot
 * probe which channels exist on a board they can partly see.
 */
const loadClientChannel = async (req, channelId) => {
  if (!channelId) return null;
  const channel = await Channel.findOne({
    _id: channelId,
    board: req.portal.boardId,
    audience: 'client',
  });
  return channel || null;
};

/* ------------------------------------------------------------------ */
/* Surfaces                                                            */
/* ------------------------------------------------------------------ */

/**
 * GET /api/portal/me/chat/channels
 * The client's rooms and mailboxes, grouped by workstream.
 */
const getPortalChannels = async (req, res) => {
  try {
    const denied = requireChat(req);
    if (denied) return res.status(denied.status).json({ error: denied.error });

    const { boardId, contactId } = req.portal;

    const channels = await Channel.find({
      board: boardId,
      audience: 'client',
      archived: false,
    }).sort({ createdAt: 1 });

    if (!channels.length) return res.json({ tier: req.portal.tier, workstreams: [] });

    const ids = channels.map((c) => c._id);

    const latest = await Message.aggregate([
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
    ]);
    const latestByChannel = new Map(latest.map((l) => [String(l._id), l]));

    const readAt = await channelReadMap({ channelIds: ids, contactId });

    const counts = await Promise.all(
      channels.map(async (ch) => {
        const last = latestByChannel.get(String(ch._id));
        if (!last) return 0;
        const seen = readAt.get(String(ch._id));
        if (seen && last.lastAt <= seen) return 0;
        return Message.countDocuments({
          channel: ch._id,
          ...(seen ? { createdAt: { $gt: seen } } : {}),
          // Not the client's own messages — posting is reading.
          portalAuthor: { $ne: contactId },
        });
      })
    );

    // Preview author names. Team members are named, never emailed.
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
    contacts.forEach((c) => nameOf.set(String(c._id), contactLabel(c)));

    const groups = await TaskGroup.find({ board: boardId })
      .select('name order')
      .sort({ order: 1, createdAt: 1 })
      .lean();
    const groupById = new Map(groups.map((g) => [String(g._id), g]));

    const byGroup = new Map();
    channels.forEach((ch, i) => {
      const key = String(ch.group || '');
      if (!groupById.has(key)) return; // a surface whose workstream is gone
      const last = latestByChannel.get(String(ch._id));
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key).push({
        id: String(ch._id),
        mode: ch.mode || 'chat',
        name: ch.name,
        unread: counts[i],
        lastMessage: last
          ? {
              at: last.lastAt,
              text: (last.lastText || '').slice(0, 140),
              authorName:
                last.lastAuthorType === 'system'
                  ? 'Macan'
                  : nameOf.get(String(last.lastPortalAuthor || last.lastAuthor)) || '',
            }
          : null,
      });
    });

    return res.json({
      tier: req.portal.tier,
      // Only workstreams that actually have a surface: the client has no way to
      // create one, so listing an empty workstream would show them a room they
      // cannot open and cannot ask for from here.
      workstreams: groups
        .filter((g) => byGroup.has(String(g._id)))
        .map((g) => ({
          id: String(g._id),
          name: g.name,
          surfaces: byGroup.get(String(g._id)),
        })),
    });
  } catch (err) {
    console.error('getPortalChannels error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

/**
 * GET /api/portal/me/chat/channels/:channelId/messages?before=&thread=
 */
const getPortalMessages = async (req, res) => {
  try {
    const denied = requireChat(req);
    if (denied) return res.status(denied.status).json({ error: denied.error });

    const channel = await loadClientChannel(req, req.params.channelId);
    if (!channel) return res.status(404).json({ error: 'Conversation not found' });

    const { contactId } = req.portal;
    const threadId = (req.query.thread || '').toString();

    if (threadId) {
      const parent = await Message.findOne({
        _id: threadId,
        channel: channel._id,
        replyTo: null,
      }).populate(PORTAL_MESSAGE_POPULATE);
      if (!parent) return res.status(404).json({ error: 'Message not found' });
      const replies = await Message.find({ replyTo: parent._id })
        .sort({ createdAt: 1 })
        .populate(PORTAL_MESSAGE_POPULATE);
      return res.json({
        parent: serializeMessageForPortal(parent, { contactId }),
        replies: replies.map((r) => serializeMessageForPortal(r, { contactId })),
      });
    }

    const limit = Math.min(parseInt(req.query.limit, 10) || MAX_LIMIT, MAX_LIMIT);
    const before = req.query.before ? new Date(req.query.before) : null;

    const filter = { channel: channel._id, replyTo: null };
    if (before && !Number.isNaN(before.getTime())) filter.createdAt = { $lt: before };

    const messages = await Message.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate(PORTAL_MESSAGE_POPULATE);

    const ids = messages.map((m) => m._id);
    const replyCounts = ids.length
      ? await Message.aggregate([
          { $match: { replyTo: { $in: ids } } },
          { $group: { _id: '$replyTo', count: { $sum: 1 } } },
        ])
      : [];
    const countById = new Map(replyCounts.map((r) => [String(r._id), r.count]));

    return res.json({
      messages: messages.map((m) =>
        serializeMessageForPortal(m, {
          contactId,
          replyCount: countById.get(String(m._id)) || 0,
        })
      ),
      nextBefore:
        messages.length === limit ? messages[messages.length - 1].createdAt : null,
      canPost: !channel.archived,
    });
  } catch (err) {
    console.error('getPortalMessages error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

/**
 * Notify the team that a client said something.
 *
 * THROTTLED TO ONE UNREAD ROW PER (RECIPIENT, CHANNEL), and that is the whole
 * design of it. "Notify on every client message" is what the team asked for,
 * and taken literally it means a bell that buzzes forty times during one
 * back-and-forth. So: the first message opens a bell row; every message after
 * it, while that row is still unread, REFRESHES the row's text and timestamp
 * without emitting `notification.created` again.
 *
 * The unread badge on the board's Chat tab rides `chat.message` and does move
 * on every message — which is the right split. "Something happened" is
 * per-message; "come and look" is per-conversation.
 */
const notifyTeamOfClientMessage = async ({ channel, message, req, audience }) => {
  try {
    // The audience is PASSED IN, never re-derived. `channelAudience` loads an
    // Organisation, a Board and every ClientContact on it, and the caller
    // computed exactly this a few lines ago — deriving it twice per message
    // would triple the query count on the busiest path this plane has, and the
    // second answer could differ from the one the message was actually fanned
    // out to.
    if (!audience?.userIds?.length) return;

    const who = contactLabel(req.portal.contact);
    const where = describeSurface(channel);
    const preview = (message.bodyText || '').slice(0, 90);
    const text = preview
      ? `${who} in ${where}: “${preview}”`
      : `${who} sent a file in ${where}`;

    // Who already has an unread row for this channel? Those get a refresh
    // instead of a second row.
    const existing = await Notification.find({
      user: { $in: audience.userIds },
      channel: channel._id,
      type: 'clientChatMessage',
      isRead: false,
    }).select('user');
    const refreshed = new Set(existing.map((n) => String(n.user)));

    if (refreshed.size) {
      await Notification.updateMany(
        {
          user: { $in: [...refreshed] },
          channel: channel._id,
          type: 'clientChatMessage',
          isRead: false,
        },
        { $set: { message: text, createdAt: new Date() } }
      );
    }

    const fresh = audience.userIds.filter((id) => !refreshed.has(String(id)));
    if (!fresh.length) return;

    await createNotificationsForUsers({
      userIds: fresh,
      type: 'clientChatMessage',
      message: text,
      // No actor: the actor is a ClientContact, and `Notification.actor` is a
      // User ref. Sending the contact's id would populate as a missing user.
      actorId: null,
      orgId: req.portal.orgId,
      boardId: channel.board,
      channelId: String(channel._id),
      tab: 'chat',
    });
  } catch (err) {
    // Best-effort: the message is stored, and failing the client's send because
    // our bell misfired would be the wrong way round.
    console.error('notifyTeamOfClientMessage error:', err);
  }
};

/** Attachment descriptors the client may set. Never trust `publicId` from a body. */
const cleanAttachments = (raw) =>
  (Array.isArray(raw) ? raw : [])
    .filter((a) => a && typeof a.url === 'string' && a.url)
    .slice(0, 10)
    .map((a) => ({
      url: a.url,
      name: (a.name || '').toString().slice(0, 200),
      mime: (a.mime || '').toString().slice(0, 100),
      size: Number(a.size) || 0,
      publicId: (a.publicId || '').toString().slice(0, 200),
    }));

/**
 * Shared write path for both a chat message and a mail reply/root.
 * Returns the created Message, or an `{ status, error }`.
 */
const writeClientMessage = async (req, channel, { subject = null, replyTo = null }) => {
  const bodyText = (req.body?.bodyText || '').toString().trim();
  const attachments = cleanAttachments(req.body?.attachments);
  if (!bodyText && !attachments.length) {
    return { status: 400, error: 'Message cannot be empty' };
  }

  // Mentions: the client may call out a TEAM member, and the audience gate is
  // what stops them naming somebody who cannot see the room.
  const audience = await channelAudience(channel);
  const audienceSet = new Set(audience.userIds);
  const mentions = [
    ...new Set((Array.isArray(req.body?.mentions) ? req.body.mentions : []).map(String)),
  ].filter((id) => audienceSet.has(id));

  const message = await Message.create({
    channel: channel._id,
    authorType: 'client',
    author: null,
    portalAuthor: req.portal.contactId,
    body: req.body?.body || null,
    bodyText: bodyText.slice(0, MAX_BODY_TEXT),
    attachments,
    mentions,
    replyTo,
    ...(subject ? { subject } : {}),
    // Share chips are never accepted on this plane — a task or goal id in the
    // body is silently not read, rather than validated and refused, because
    // there is no legitimate client request that carries one.
  });

  await markChannelRead({
    channelId: channel._id,
    contactId: req.portal.contactId,
    at: message.createdAt,
  });

  try {
    eventBus.emit('chat.message', {
      channelId: String(channel._id),
      messageId: String(message._id),
      orgId: String(channel.organisation),
      recipientIds: audience.userIds,
      // Everyone at the client's company EXCEPT the person who just typed it.
      recipientContactIds: audience.contactIds.filter(
        (id) => String(id) !== String(req.portal.contactId)
      ),
    });
  } catch (emitErr) {
    // Delivery is best-effort; the message is stored either way.
  }

  await notifyTeamOfClientMessage({ channel, message, req, audience });

  return { message, audience };
};

/**
 * POST /api/portal/me/chat/channels/:channelId/messages
 */
const sendPortalMessage = async (req, res) => {
  try {
    const denied = requireChat(req);
    if (denied) return res.status(denied.status).json({ error: denied.error });

    const channel = await loadClientChannel(req, req.params.channelId);
    if (!channel) return res.status(404).json({ error: 'Conversation not found' });
    if (channel.archived) {
      return res.status(400).json({ error: 'This conversation is closed' });
    }

    // One level of threading, and never across channels.
    let replyTo = null;
    if (req.body?.replyTo) {
      const parent = await Message.findOne({
        _id: req.body.replyTo,
        channel: channel._id,
      }).select('_id replyTo');
      if (!parent) return res.status(404).json({ error: 'Message not found' });
      if (parent.replyTo) {
        return res
          .status(400)
          .json({ error: 'Replies go one level deep — reply to the original message' });
      }
      replyTo = parent._id;
    }

    const result = await writeClientMessage(req, channel, { replyTo });
    if (result.error) return res.status(result.status).json({ error: result.error });

    const populated = await Message.findById(result.message._id).populate(
      PORTAL_MESSAGE_POPULATE
    );
    return res.status(201).json({
      message: serializeMessageForPortal(populated, { contactId: req.portal.contactId }),
    });
  } catch (err) {
    console.error('sendPortalMessage error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/portal/me/chat/channels/:channelId/attachments  (multipart)
 * Multer has already pushed the file to Cloudinary by the time this runs, so a
 * refusal has to take it back down — the same rule the team's upload follows.
 */
const uploadPortalChatAttachment = async (req, res) => {
  const { destroyCloudinaryAssets } = require('../config/cloudinary');
  const discard = () =>
    destroyCloudinaryAssets([
      {
        publicId: req.file?.public_id || req.file?.filename || '',
        mime: req.file?.mimetype || '',
      },
    ]);

  try {
    const denied = requireChat(req);
    if (denied) {
      await discard();
      return res.status(denied.status).json({ error: denied.error });
    }

    const channel = await loadClientChannel(req, req.params.channelId);
    if (!channel || channel.archived) {
      await discard();
      return res.status(404).json({ error: 'Conversation not found' });
    }
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

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
    console.error('uploadPortalChatAttachment error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/** POST /api/portal/me/chat/channels/:channelId/read */
const markPortalChannelRead = async (req, res) => {
  try {
    const denied = requireChat(req);
    if (denied) return res.status(denied.status).json({ error: denied.error });

    const channel = await loadClientChannel(req, req.params.channelId);
    if (!channel) return res.status(404).json({ error: 'Conversation not found' });

    await markChannelRead({
      channelId: channel._id,
      contactId: req.portal.contactId,
      at: req.body?.at || null,
    });
    return res.json({ success: true });
  } catch (err) {
    console.error('markPortalChannelRead error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Mail                                                                */
/* ------------------------------------------------------------------ */

/** GET /api/portal/me/chat/channels/:channelId/threads?before= */
const getPortalThreads = async (req, res) => {
  try {
    const denied = requireChat(req);
    if (denied) return res.status(denied.status).json({ error: denied.error });

    const channel = await loadClientChannel(req, req.params.channelId);
    if (!channel) return res.status(404).json({ error: 'Conversation not found' });
    if (channel.mode !== 'mail') {
      return res.status(400).json({ error: 'This conversation is not a mailbox' });
    }

    const before = req.query.before ? new Date(req.query.before) : null;
    const { threads, nextBefore } = await loadThreads(channel._id, {
      before: before && !Number.isNaN(before.getTime()) ? before : null,
    });

    // `includeAvatars: false` — a team member's profile picture is a Google URL
    // that identifies them past the name we chose to share.
    const names = await nameParticipants(threads, { includeAvatars: false });
    const readAt = await threadReadMap({
      threadIds: threads.map((t) => t._id),
      contactId: req.portal.contactId,
    });

    return res.json({
      threads: threads.map((t) => serializeThreadRow(t, names, readAt.get(String(t._id)))),
      nextBefore,
      canPost: !channel.archived,
    });
  } catch (err) {
    console.error('getPortalThreads error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/portal/me/chat/channels/:channelId/threads
 *
 * The client starts a mail thread. This is the ONE thing a client may create,
 * and it is deliberate: a mailbox that you can only reply in is not a mailbox,
 * and making somebody file a task to ask a question is the friction this whole
 * feature exists to remove.
 *
 * `subject` is therefore attacker-controlled text. It is trimmed, length-capped
 * here, capped again by the schema, rate-limited per contact by the route, and
 * escaped at render by React. Four layers because it is the only free-text
 * field on this plane that ends up in a TEAM member's notification body.
 */
const createPortalThread = async (req, res) => {
  try {
    const denied = requireChat(req);
    if (denied) return res.status(denied.status).json({ error: denied.error });

    const channel = await loadClientChannel(req, req.params.channelId);
    if (!channel) return res.status(404).json({ error: 'Conversation not found' });
    if (channel.mode !== 'mail') {
      return res.status(400).json({ error: 'This conversation is not a mailbox' });
    }
    if (channel.archived) {
      return res.status(400).json({ error: 'This conversation is closed' });
    }

    const subject = (req.body?.subject || '').toString().trim();
    if (!subject) return res.status(400).json({ error: 'Please give your message a subject.' });
    if (subject.length > MAX_SUBJECT) {
      return res
        .status(400)
        .json({ error: `Subject must be ${MAX_SUBJECT} characters or fewer.` });
    }

    const result = await writeClientMessage(req, channel, { subject, replyTo: null });
    if (result.error) return res.status(result.status).json({ error: result.error });

    await markThreadRead({
      threadId: result.message._id,
      channelId: channel._id,
      contactId: req.portal.contactId,
      at: result.message.createdAt,
    });

    const populated = await Message.findById(result.message._id).populate(
      PORTAL_MESSAGE_POPULATE
    );
    return res.status(201).json({
      message: serializeMessageForPortal(populated, { contactId: req.portal.contactId }),
    });
  } catch (err) {
    console.error('createPortalThread error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/portal/me/chat/threads/:threadId/read
 *
 * Addressed by thread rather than by channel because the thread id is what the
 * client holds; the channel is derived from it and then checked, which is the
 * same scoping the other handlers do in the other order.
 */
const markPortalThreadRead = async (req, res) => {
  try {
    const denied = requireChat(req);
    if (denied) return res.status(denied.status).json({ error: denied.error });

    const thread = await Message.findOne({
      _id: req.params.threadId,
      replyTo: null,
    }).select('_id channel');
    if (!thread) return res.status(404).json({ error: 'Thread not found' });

    const channel = await loadClientChannel(req, thread.channel);
    if (!channel) return res.status(404).json({ error: 'Thread not found' });

    await markThreadRead({
      threadId: thread._id,
      channelId: channel._id,
      contactId: req.portal.contactId,
      at: req.body?.at || null,
    });
    return res.json({ success: true });
  } catch (err) {
    console.error('markPortalThreadRead error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * GET /api/portal/me/chat/mentions
 *
 * Who the client may @mention. Names and ids only — no email, no avatar. The
 * client already sees these names on messages, so this reveals nothing new;
 * shipping the roster with contact details would.
 */
const getPortalMentions = async (req, res) => {
  try {
    const denied = requireChat(req);
    if (denied) return res.status(denied.status).json({ error: denied.error });

    // Derived from a client-facing channel's audience rather than from the org
    // roster, so it is exactly the set the send path will accept — a suggestion
    // the server would then drop is a promise the UI cannot keep.
    const channel = await Channel.findOne({
      board: req.portal.boardId,
      audience: 'client',
      archived: false,
    });
    if (!channel) return res.json([]);

    const audience = await channelAudience(channel);
    if (!audience.userIds.length) return res.json([]);

    const users = await User.find({ _id: { $in: audience.userIds } }).select('name');
    return res.json(users.map((u) => ({ _id: String(u._id), name: u.name })));
  } catch (err) {
    console.error('getPortalMentions error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* SSE                                                                 */
/* ------------------------------------------------------------------ */

/**
 * GET /api/portal/me/stream?token=<portal jwt>
 *
 * EventSource cannot set an Authorization header, so the JWT arrives in the
 * query string and is verified inline — exactly as `/api/notifications/stream`
 * does, and for the same reason. That is why this handler does NOT sit behind
 * `portalAuth`.
 *
 * `verifyPortalToken` is the SAME function the middleware uses, which is the
 * point of it being exported: a long-lived connection is precisely where "the
 * team disabled this portal" must still be enforced, and two copies of those
 * checks is how the connection-based one ends up missing the newest of them.
 *
 * The connection is dropped when the portal is disabled or its link rotated
 * (see `portalStream.dropBoard`), and re-verified on nothing else — so a
 * session that dies mid-stream keeps receiving until one of those fires or the
 * socket closes. That is a known, bounded gap: everything the stream can carry
 * is a message in a room this contact was authorised to read at connect time.
 */
const streamPortalEvents = async (req, res) => {
  try {
    const token = (req.query.token || '').toString();
    const resolved = await verifyPortalToken(token);
    if (!resolved) {
      return res.status(401).json({ error: 'This portal is no longer available' });
    }
    if (!isAdvancedClientBoard(resolved.board)) {
      return res.status(403).json({ error: 'Chat is not enabled for this portal' });
    }

    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    if (res.flushHeaders) res.flushHeaders();
    res.write(': connected\n\n');

    const cleanup = portalStream.addConnection(
      resolved.contact._id,
      res,
      resolved.board._id
    );
    req.on('close', () => {
      cleanup();
      try {
        res.end();
      } catch (err) {
        // already closed
      }
    });
    return undefined;
  } catch (err) {
    console.error('streamPortalEvents error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

module.exports = {
  getPortalChannels,
  getPortalMessages,
  sendPortalMessage,
  uploadPortalChatAttachment,
  markPortalChannelRead,
  getPortalThreads,
  createPortalThread,
  markPortalThreadRead,
  getPortalMentions,
  streamPortalEvents,
  // exported for tests
  loadClientChannel,
  requireChat,
  cleanAttachments,
};
