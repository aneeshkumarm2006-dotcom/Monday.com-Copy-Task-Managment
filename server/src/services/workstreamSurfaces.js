const Channel = require('../models/Channel');
const Message = require('../models/Message');
const ChannelRead = require('../models/ChannelRead');
const ChannelContactRead = require('../models/ChannelContactRead');
const MailThreadRead = require('../models/MailThreadRead');
const SavedMessage = require('../models/SavedMessage');
const Notification = require('../models/Notification');
const { destroyCloudinaryAssets } = require('../config/cloudinary');
const { isLiveClientBoard } = require('../utils/clientBoard');
const {
  planSurfaces,
  surfaceName,
  keyForSurface,
} = require('../utils/chatSurfaces');

/**
 * Creating and destroying a SERVICE's conversations.
 *
 * A group on a client board is one SERVICE the agency sells that client — SEO,
 * Meta Ads, Web Development — and it gets all three surfaces the day it is
 * created: a client chat, a client mailbox, and a private team room.
 *
 * ---- THIS REVERSES AN EARLIER DECISION, DELIBERATELY --------------------
 *
 * This file used to argue the opposite, and the argument is worth recording
 * because it was not silly: not every client wants chat, some want subject-lined
 * mail, and a room nobody asked for that a client can post into is worse than no
 * room. So a client workstream started with NOTHING and surfaces existed only
 * because someone ticked them in the setup modal.
 *
 * What that missed is that the modal was a step nobody took. Combined with the
 * (now removed) 'advanced' tier gate, the practical result was that client chat
 * and mail existed in the code and nowhere else. "Chat and mail by default" is
 * now the product requirement, and the empty-room worry is answered better by
 * the surface itself: an unused room shows an empty state, costs one Channel
 * row, and is one click from being useful — whereas a missing room reads to the
 * client as a feature the agency does not offer.
 *
 * If a team genuinely wants a service with no client mailbox, the answer is a
 * per-service setting, not a global default of nothing.
 *
 * Callers that auto-create: `groupController.createGroup` (client boards only),
 * `services/portalBatchInvite.js`, and the migration's --backfill-surfaces.
 * `SetUpCommunicationModal` remains the manual path for repair and for adding a
 * surface someone turned off.
 *
 * Everything below is idempotent under the `(board, group, mode, audience)`
 * unique index, so a double-submit, a retry, an auto-create racing a manual one,
 * or re-opening the modal on a service that already has chat all converge rather
 * than duplicate. That is what makes auto-creation safe to call from three
 * places without coordinating them.
 */

/**
 * Create the chosen surfaces for one workstream. Returns what exists
 * afterwards, split by whether this call made it — the caller needs that split
 * to say "Chat is already set up" rather than claiming to have created it.
 *
 * @param {Object} board - a Board doc; must carry `boardType`, `portalEnabled`,
 *                         `portalClientName`, `organisation`
 * @param {Object} group - a TaskGroup doc; must carry `name`, `board`
 * @param {Object} selection - `{ clientChat, clientMail, team }`
 * @param {Object} [opts]
 * @param {string|null} [opts.createdBy] - the User who chose; null for system
 * @returns {Promise<{ok, refusals, created, existing}>}
 */
const createSurfaces = async (board, group, selection, { createdBy = null } = {}) => {
  // The gate lives here rather than at the route, because this is the function
  // every path — the setup modal, the batch invite, createGroup's auto-create,
  // the migration backfill — goes through, and a confidentiality boundary
  // enforced at one of four entrances is enforced at none.
  //
  // It is no longer a TIER check (that concept is gone); it asks whether a
  // client-facing room could be read by anybody at all. On a board that is not
  // a live client portal the answer is no, and such a room would exist while
  // being readable and postable by nobody.
  const plan = planSurfaces(selection, {
    allowClientSurfaces: isLiveClientBoard(board),
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
 * Tear down a set of channels: their messages, their Cloudinary assets, both
 * kinds of read marker, the private bookmarks pointing into them, and the bell
 * rows that name them. The one implementation behind every cascade below, so
 * "what hangs off a channel" is written down once — six collections plus an
 * external store is exactly the sort of list that gets one entry shorter each
 * time someone copies it.
 *
 * It got two entries shorter, which is why this paragraph now names them.
 *
 *   SavedMessage. A bookmark is a private row keyed on (user, message,
 *   channel) and NOTHING in the product ever deleted one for a message that
 *   died. The damage is not merely a leaked row: `chatController.listSaved`
 *   read the caller's 100 newest bookmarks and only then dropped the ones
 *   whose channel or message no longer resolved, so a person whose recent
 *   bookmarks all lived in a deleted board opened Saved and saw a short — sometimes
 *   empty — list, with older, perfectly valid bookmarks pushed out of the
 *   window by rows they could not see. And they could not clear them either:
 *   un-bookmarking goes through `toggleSave`, which 404s on the missing
 *   Message before it ever reaches the delete, so no screen in the app could
 *   remove the row. (`listSaved` was hardened to filter before it caps, for
 *   the orphans already in production; this delete is what stops new ones.)
 *
 *   Notification. `Notification.channel` exists precisely so a bell row can
 *   point at a conversation, and a `chatMention` is board-less by
 *   construction, so `deleteBoard`'s `Notification.deleteMany({ board: id })`
 *   never matched one and `deleteGroup` swept only task-scoped rows. The
 *   survivor renders as an unread mention of a room that is gone and clicks
 *   through to an empty channel. Deleting by channel here fixes board delete,
 *   group delete and workspace-channel teardown in one place, which is the
 *   whole reason this function exists.
 *
 * ORDER IS FOR CRASH-SAFETY, not correctness. The channels go LAST, so an
 * interruption leaves rows whose channel still exists — findable, and
 * re-deletable by running the same cascade again — rather than orphans that
 * nothing can locate.
 */
const purgeChannels = async (channelIds) => {
  if (!channelIds.length) {
    return { channels: 0, messages: 0, reads: 0, mailReads: 0, saved: 0, notifications: 0 };
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
  // Scoped by `channel`, not by user or by message: the bookmark's `channel`
  // is denormalised onto the row exactly so a question like this one can be
  // asked without loading every message first, and after the Message rows
  // above are gone it is the ONLY way left to find these.
  const saved = await SavedMessage.deleteMany({ channel: { $in: channelIds } });
  // Only rows that NAME one of these channels. A `chatMention` is the case
  // this was missing, but the filter is on the ref rather than on the type so
  // any future channel-scoped notification is collected without this list
  // having to be revisited a third time.
  const notifications = await Notification.deleteMany({ channel: { $in: channelIds } });
  await Channel.deleteMany({ _id: { $in: channelIds } });

  return {
    channels: channelIds.length,
    messages: messages.deletedCount || 0,
    reads: (reads.deletedCount || 0) + (contactReads.deletedCount || 0),
    mailReads: mailReads.deletedCount || 0,
    saved: saved.deletedCount || 0,
    notifications: notifications.deletedCount || 0,
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
  // Exported for `services/userCascade.js`, which tears down the DMs of a
  // deleted account. A DM has no board and no group, so neither cascade above
  // can reach it — but what hangs off a channel is the same six collections
  // plus Cloudinary either way, and that list must stay written down once.
  purgeChannels,
  deleteSurfacesForGroup,
  deleteSurfacesForBoard,
  deleteWorkspaceChannels,
  existingSurfaceKeys,
};
