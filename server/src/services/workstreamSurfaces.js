const Channel = require('../models/Channel');
const Message = require('../models/Message');
const ChannelRead = require('../models/ChannelRead');
const ChannelContactRead = require('../models/ChannelContactRead');
const MailThreadRead = require('../models/MailThreadRead');
const { destroyCloudinaryAssets } = require('../config/cloudinary');
const { isAdvancedClientBoard } = require('../utils/clientBoard');
const {
  planSurfaces,
  surfaceName,
  keyForSurface,
} = require('../utils/chatSurfaces');

/**
 * Creating and destroying a workstream's conversations.
 *
 * This REPLACES blanket auto-creation for client boards. `ensureAutoChannels`
 * mints one room per tracker group on every sidebar fetch, which is right there
 * — a tracker group is a client and always wants a room — and wrong here: not
 * every client wants chat, some want subject-lined mail, and a room nobody
 * asked for that a client can post into is worse than no room. So a client
 * workstream starts with NOTHING, and surfaces exist because someone chose
 * them in the setup modal.
 *
 * Everything below is idempotent under the `(board, group, mode, audience)`
 * unique index, so a double-submit, a retry, or re-opening the modal on a
 * workstream that already has chat all converge rather than duplicate.
 */

/**
 * Create the chosen surfaces for one workstream. Returns what exists
 * afterwards, split by whether this call made it — the caller needs that split
 * to say "Chat is already set up" rather than claiming to have created it.
 *
 * @param {Object} board - a Board doc; must carry `boardType`, `portalTier`,
 *                         `portalClientName`, `organisation`
 * @param {Object} group - a TaskGroup doc; must carry `name`, `board`
 * @param {Object} selection - `{ clientChat, clientMail, team }`
 * @param {Object} [opts]
 * @param {string|null} [opts.createdBy] - the User who chose; null for system
 * @returns {Promise<{ok, refusals, created, existing}>}
 */
const createSurfaces = async (board, group, selection, { createdBy = null } = {}) => {
  // The tier gate lives here rather than at the route, because this is the
  // function every path — endpoint, upgrade flow, future automation — goes
  // through, and a confidentiality boundary enforced at one of three entrances
  // is enforced at none.
  const plan = planSurfaces(selection, {
    allowClientSurfaces: isAdvancedClientBoard(board),
  });
  if (!plan.ok) return { ok: false, refusals: plan.refusals, created: [], existing: [] };

  const created = [];
  const existing = [];

  for (const surface of plan.surfaces) {
    const name = surfaceName({
      audience: surface.audience,
      groupName: group.name,
      clientName: board.portalClientName,
    });

    const filter = {
      board: group.board || board._id,
      group: group._id,
      mode: surface.mode,
      audience: surface.audience,
    };

    // Find-then-create rather than an upsert, for one reason: the caller has
    // to be able to say "Chat is already set up" instead of claiming to have
    // made a room that has been there for months, and an upsert cannot tell
    // those apart without reading driver result metadata whose shape is a
    // detail of whichever driver version is installed.
    //
    // The race that opens between the read and the write is closed by the
    // unique index, not by the check — see the catch.
    let doc = await Channel.findOne(filter);
    let didInsert = false;

    if (!doc) {
      try {
        doc = await Channel.create({
          organisation: board.organisation,
          ...filter,
          name,
          archived: false,
          createdBy,
        });
        didInsert = true;
      } catch (err) {
        // E11000 IS the unique index winning the race it exists to win — two
        // people opening the modal at once, or a double-submit. The row the
        // other writer made is the correct answer, so read it back rather than
        // failing a request that got precisely what it asked for.
        if (err?.code !== 11000) throw err;
        doc = await Channel.findOne(filter);
      }
    }

    if (doc) (didInsert ? created : existing).push(doc);
  }

  return { ok: true, refusals: [], created, existing };
};

/**
 * Every surface on one workstream, oldest first. The board Chat tab's sidebar
 * and the portal's tab list both ask this question.
 */
const surfacesForGroup = async (groupId) =>
  Channel.find({ group: groupId }).sort({ createdAt: 1 });

/**
 * Tear down a set of channels: their messages, their Cloudinary assets, and
 * both kinds of read marker. The one implementation behind every cascade
 * below, so "what hangs off a channel" is written down once — four collections
 * plus an external store is exactly the sort of list that gets one entry
 * shorter each time someone copies it.
 *
 * ORDER IS FOR CRASH-SAFETY, not correctness. The channels go LAST, so an
 * interruption leaves rows whose channel still exists — findable, and
 * re-deletable by running the same cascade again — rather than orphans that
 * nothing can locate.
 */
const purgeChannels = async (channelIds) => {
  if (!channelIds.length) {
    return { channels: 0, messages: 0, reads: 0, mailReads: 0 };
  }


  // Cloudinary first, and read before deleting: once the Message rows are gone
  // there is nothing left that knows these public ids, and the files would sit
  // in the account forever with no way to find them again. `deleteMessage`
  // already does this for a single message; a board or org teardown was
  // dropping every file on the floor.
  const withFiles = await Message.find({
    channel: { $in: channelIds },
    'attachments.0': { $exists: true },
  })
    .select('attachments')
    .lean();
  const assets = withFiles.flatMap((m) =>
    (m.attachments || []).map((a) => ({ publicId: a.publicId, mime: a.mime }))
  );
  if (assets.length) await destroyCloudinaryAssets(assets);

  const messages = await Message.deleteMany({ channel: { $in: channelIds } });
  const reads = await ChannelRead.deleteMany({ channel: { $in: channelIds } });
  const contactReads = await ChannelContactRead.deleteMany({
    channel: { $in: channelIds },
  });
  const mailReads = await MailThreadRead.deleteMany({ channel: { $in: channelIds } });
  await Channel.deleteMany({ _id: { $in: channelIds } });

  return {
    channels: channelIds.length,
    messages: messages.deletedCount || 0,
    reads: (reads.deletedCount || 0) + (contactReads.deletedCount || 0),
    mailReads: mailReads.deletedCount || 0,
  };
};

/**
 * Every conversation belonging to a group. Called from `deleteGroup`.
 *
 * WHY DELETE RATHER THAN ARCHIVE. An archived channel still matches
 * `{ board: contact.board }`, and the contact-side audience gate keys on the
 * BOARD, not the group — the group is gone, so there is nothing left for it to
 * key on. An orphaned `audience:'client'` room would therefore stay readable
 * and postable by the client after the team deleted the workstream, while
 * being invisible to the team, who have no group left to reach it through.
 * That is the worst possible way round for a conversation to survive.
 */
const deleteSurfacesForGroup = async (groupId) => {
  const channels = await Channel.find({ group: groupId }).select('_id').lean();
  return purgeChannels(channels.map((c) => c._id));
};

/**
 * The same, for a whole board. `deleteBoard` cleaned nine collections and
 * touched none of these.
 *
 * Scoped by `board`, which covers every group's surfaces AND any manual extra
 * channel with `group: null` — those are board channels too and orphan just as
 * readily. DMs carry no board and are correctly untouched.
 */
const deleteSurfacesForBoard = async (boardId) => {
  const channels = await Channel.find({ board: boardId }).select('_id').lean();
  return purgeChannels(channels.map((c) => c._id));
};

/**
 * The workspace-level rooms — `board: null`, which no board-scoped cascade can
 * ever reach. Only an org teardown should call this.
 *
 * `kind: { $ne: 'dm' }` is the load-bearing clause. A DM belongs to its two
 * PEOPLE, not to the workspace it happened to be opened in — `chatAudience`
 * says so outright, and the sidebar shows every DM in every workspace. Deleting
 * one workspace must not delete a conversation that follows both participants
 * everywhere else.
 */
const deleteWorkspaceChannels = async (orgId) => {
  const channels = await Channel.find({
    organisation: orgId,
    board: null,
    kind: { $ne: 'dm' },
  })
    .select('_id')
    .lean();
  return purgeChannels(channels.map((c) => c._id));
};

/**
 * Which surface keys a group already has — what the modal needs to render a
 * card as "already set up" rather than offering to create it again.
 */
const existingSurfaceKeys = async (groupId) => {
  const channels = await Channel.find({ group: groupId }).select('mode audience').lean();
  return channels.map((c) => keyForSurface(c.mode, c.audience)).filter(Boolean);
};

module.exports = {
  createSurfaces,
  surfacesForGroup,
  deleteSurfacesForGroup,
  deleteSurfacesForBoard,
  deleteWorkspaceChannels,
  existingSurfaceKeys,
};
