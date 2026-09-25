const Organisation = require('../models/Organisation');
const Board = require('../models/Board');
const TaskGroup = require('../models/TaskGroup');
const Task = require('../models/Task');
const Update = require('../models/Update');
const Note = require('../models/Note');
const Notification = require('../models/Notification');
const NotificationPreference = require('../models/NotificationPreference');
const ItemFollow = require('../models/ItemFollow');
const Automation = require('../models/Automation');
const Tracker = require('../models/Tracker');
const TrackerEntry = require('../models/TrackerEntry');
const Goal = require('../models/Goal');
const AdsBudget = require('../models/AdsBudget');
const GoalReminder = require('../models/GoalReminder');
const User = require('../models/User');
const ActivityLog = require('../models/ActivityLog');
const BoardConnection = require('../models/BoardConnection');
const ConnectorAccount = require('../models/ConnectorAccount');
const ConnectorAuthAttempt = require('../models/ConnectorAuthAttempt');
const ConnectorProject = require('../models/ConnectorProject');
const ConnectorSnapshot = require('../models/ConnectorSnapshot');
const DfsTask = require('../models/DfsTask');
const DfsSerpResult = require('../models/DfsSerpResult');
const DfsCacheProbe = require('../models/DfsCacheProbe');
const DfsSerpCache = require('../models/DfsSerpCache');
const ConnectorBudget = require('../models/ConnectorBudget');
const BoardConnector = require('../models/BoardConnector');
const ConnectorFieldMapping = require('../models/ConnectorFieldMapping');
const GoalConnectorLink = require('../models/GoalConnectorLink');
const ClientContact = require('../models/ClientContact');
const PortalDigest = require('../models/PortalDigest');
const { destroyCloudinaryAssets, destroyLogos } = require('../config/cloudinary');
const VaultEscrow = require('../models/VaultEscrow');
const ExecutiveView = require('../models/ExecutiveView');
const ServiceCatalogEntry = require('../models/ServiceCatalogEntry');
const SavedMessage = require('../models/SavedMessage');
const Channel = require('../models/Channel');
const { cascadeDeleteVaults } = require('./vaultCascade');
const { deleteSurfacesForBoard, deleteWorkspaceChannels } = require('./workstreamSurfaces');

/**
 * Permanently delete an organisation and everything that lives under it.
 *
 * Cascade order (children first to avoid dangling refs if anything fails):
 *   1. Updates, Notifications — scoped by task IDs in the org's boards
 *   2. Notifications — scoped directly by organisation (covers non-task notifs)
 *   3. Tasks → TaskGroups → Automations → Boards
 *   4. Pull org ID from every member/admin's User.organisations array
 *   5. Delete the Organisation document
 *
 * Shared by orgController.deleteOrg and profileController.deleteAccount so
 * the two paths can't drift.
 */
const cascadeDeleteOrg = async (orgId) => {
  const boardIds = await Board.distinct('_id', { organisation: orgId });
  const taskIds = boardIds.length
    ? await Task.distinct('_id', { board: { $in: boardIds } })
    : [];

  if (taskIds.length) {
    // Collect and destroy all Cloudinary assets before wiping the DB rows.
    const taskDocs = await Task.find({ _id: { $in: taskIds } }).select('attachments').lean();
    const updateDocs = await Update.find({ task: { $in: taskIds } }).select('attachments').lean();
    const allAttachments = [
      ...taskDocs.flatMap((t) => t.attachments || []),
      ...updateDocs.flatMap((u) => u.attachments || []),
    ];
    await destroyCloudinaryAssets(allAttachments);

    await Update.deleteMany({ task: { $in: taskIds } });
    await Notification.deleteMany({ task: { $in: taskIds } });
    await ItemFollow.deleteMany({ task: { $in: taskIds } });
    await ActivityLog.deleteMany({ task: { $in: taskIds } });
    await Task.deleteMany({ _id: { $in: taskIds } });
  }

  await Notification.deleteMany({ organisation: orgId });
  await ItemFollow.deleteMany({ organisation: orgId });
  // Chat bookmarks. A SavedMessage is one person's private pointer at one
  // message in one channel, and nothing collected it anywhere — not here, not
  // in the board teardown, not in the per-channel purge — so every bookmark
  // anyone ever made in this workspace's rooms survived it. They are invisible
  // rather than broken (the saved list re-resolves channel access on read and
  // silently drops what no longer resolves), which is exactly why nobody would
  // ever notice: the rows accumulate, and the one screen that could delete a
  // bookmark 404s once the message behind it is gone.
  //
  // Deleted HERE, before the board loop and `deleteWorkspaceChannels` below take
  // the channels and messages these rows point at — children before parents, so
  // a run that dies halfway leaves bookmarks whose targets still exist rather
  // than bookmarks pointing into nothing. The per-channel half of this belongs
  // in `purgeChannels`, which is where a single board or group teardown has to
  // find it; this sweep is the workspace-wide net that also catches a row whose
  // channel was already deleted on its own.
  //
  // Scoped by CHANNEL, with DMs excluded — not by `organisation`, which is the
  // obvious one-liner and is wrong. `Channel.organisation` is REQUIRED on every
  // room including a DM (it records where the DM was first opened), and
  // `toggleSave` copies that field straight onto the bookmark. So an
  // organisation-scoped sweep collects bookmarks on DM messages too — and this
  // cascade deliberately does NOT delete the DMs themselves
  // (`deleteWorkspaceChannels` excludes `kind: 'dm'`, because a direct line
  // belongs to its two PEOPLE rather than to the workspace it was opened in).
  // The result would be the worst of both: the conversation survives, the
  // messages survive, and one participant's bookmarks on them silently vanish
  // because a third party tore down an unrelated workspace.
  //
  // Selecting the ids costs one projection over a collection with at most a few
  // rooms per board, and it is the same list `deleteWorkspaceChannels` and the
  // board loop will delete — so nothing is collected here that does not go.
  const orgChannelIds = await Channel.distinct('_id', {
    organisation: orgId,
    kind: { $ne: 'dm' },
  });
  if (orgChannelIds.length) {
    await SavedMessage.deleteMany({ channel: { $in: orgChannelIds } });
  }
  // The org-wide half of the ClientContact cleanup — see the board-scoped
  // delete below. A contact whose board was already deleted has no board to be
  // found by, and would otherwise survive its whole workspace.
  //
  // The daily-digest markers key on the CONTACT, so they are collected here,
  // once, before the first of the two contact deletes runs — after it there is
  // nothing left to resolve them against.
  const contactIds = await ClientContact.distinct('_id', { organisation: orgId });
  if (contactIds.length) {
    await PortalDigest.deleteMany({ contact: { $in: contactIds } });
  }
  await ClientContact.deleteMany({ organisation: orgId });

  if (boardIds.length) {
    await cascadeDeleteVaults(boardIds);
    await BoardConnector.deleteMany({ board: { $in: boardIds } });
    // Field mappings name goal columns embedded on the board documents about to
    // be deleted. Same reasoning as the board cascade: a dangling reference, not
    // history worth keeping.
    await ConnectorFieldMapping.deleteMany({ board: { $in: boardIds } });
    // Same reasoning for the goal links: they name goals on boards that are
    // about to go, so there is nothing left for them to be about.
    await GoalConnectorLink.deleteMany({ board: { $in: boardIds } });
    // Same omission as the board cascade had: notes are only otherwise removed
    // when their GROUP is deleted, so tearing down an org left them behind.
    await Note.deleteMany({ board: { $in: boardIds } });
    await AdsBudget.deleteMany({ board: { $in: boardIds } });
    // Everything else in the activity feed. Goal, adsBudget and group rows
    // carry their own subject and no `task`, so the task-scoped delete above
    // cannot reach any of them. Scoped by BOARD rather than by subject id: it
    // is the same set (each subject belongs to exactly one board) and it also
    // collects rows whose subject was already deleted, which an id list no
    // longer contains. Previously this filtered on `goal`/`adsBudget`, which
    // silently left every GROUP row behind once groups joined the collection.
    await ActivityLog.deleteMany({ board: { $in: boardIds } });
    // Group and board logos, before the rows that name them go.
    await destroyLogos([
      ...(await TaskGroup.find({ board: { $in: boardIds } }).select('logoPublicId').lean()),
      ...(await Board.find({ _id: { $in: boardIds } }).select('logoPublicId').lean()),
    ]);
    await TaskGroup.deleteMany({ board: { $in: boardIds } });
    // Client Portal contacts. These carry email addresses, scrypt password
    // hashes and one-time setup-token hashes, so they must not outlive the
    // workspace. Deleted by board here, and again by org below — the same
    // belt-and-braces this file already applies to ConnectorFieldMapping and
    // GoalConnectorLink, so a contact whose board vanished earlier still goes.
    await ClientContact.deleteMany({ board: { $in: boardIds } });
    // Conversations. Channels, messages, and both kinds of read marker were
    // missing here as well as from deleteBoard — so tearing down a workspace
    // left every room and every message in it behind, permanently unreachable.
    // A DM is deliberately NOT collected by this loop: it carries no board, and
    // it belongs to its two PEOPLE rather than to the workspace it was opened
    // in, so it survives one of them leaving. `deleteWorkspaceChannels` below
    // takes the org's rooms; nothing takes the DMs, and that is the intent.
    for (const boardId of boardIds) {
      await deleteSurfacesForBoard(boardId);
    }
    await Automation.deleteMany({ board: { $in: boardIds } });
    await BoardConnection.deleteMany({
      $or: [{ fromBoardId: { $in: boardIds } }, { toBoardId: { $in: boardIds } }],
    });
    // Stale email mutes, the `$in` counterpart of the single-board `$pull` that
    // `boardController.deleteBoard` already performs. Its comment there says why
    // it exists at all — "Harmless if left, but they accumulate on every user
    // forever and there is no screen that could ever clear one" — and that
    // reasoning is strictly worse here: deleting a workspace deletes every one
    // of its boards at once, and the people holding the dead ids include members
    // of OTHER workspaces who keep using the app afterwards. The settings screen
    // renders mutes from live boards only, so a user can neither see nor remove
    // them, and the client rebuilds the whole array from the stored preference
    // on every subsequent toggle, which writes the dead ids straight back. They
    // cannot age out on their own.
    //
    // Runs before `Board.deleteMany` for the usual reason: while the boards are
    // still here the ids in `mutedBoards` are resolvable, so a run that dies
    // between the two leaves a preference naming boards that exist rather than
    // one naming nothing.
    await NotificationPreference.updateMany(
      { mutedBoards: { $in: boardIds } },
      { $pull: { mutedBoards: { $in: boardIds } } }
    );
    await Board.deleteMany({ _id: { $in: boardIds } });
  }

  // Executive profiles. The per-WORKSPACE half of a teardown `services/
  // userCascade.js` now does per-PERSON: that file drops one person's profile
  // when they leave an org or delete their account, and this drops every profile
  // in an org that is going away entirely.
  //
  // It was reached by no cascade at all before, which made it the one collection
  // here whose orphans were permanently unreachable rather than merely untidy.
  // `ExecutiveView` is identified by the pair `{ organisation, user }` and the
  // only surface that can list one is `GET /api/orgs/:orgId/executive-views`,
  // which loads the org first — so the moment the org document goes, no query in
  // the product can name the rows again. The admin list is also what makes the
  // OTHER orphan in this collection acceptable: `executiveViewController` keeps
  // a profile whose user was deleted, with `user: null`, on the stated grounds
  // that the list is "the only surface in the app that could ever surface one".
  // That defence is exactly what an org teardown removes, so it does not extend
  // to this case and there is nothing to preserve here.
  //
  // What the rows hold is a reason to delete rather than to keep: a curated
  // board list with the Executive's own labels, and the free text typed into any
  // `note` home section. A profile is a VIEW of a workspace, and this workspace
  // is about to stop existing.
  //
  // OUTSIDE the `if (boardIds.length)` block, which is where this briefly lived
  // and where it was wrong: a workspace with no boards is exactly the case the
  // paragraph above describes — nothing left that could ever name the rows — and
  // nesting it would have skipped the one teardown that most needed it.
  //
  // It is also the reason the mute pull's ordering argument does not apply here.
  // That one is a `$pull` on a document that SURVIVES, so it has to happen while
  // the ids it removes still resolve. This deletes the whole profile, boards[]
  // and all, so there is no intermediate state to get wrong and no reason to tie
  // it to the board loop.
  await ExecutiveView.deleteMany({ organisation: orgId });
  // Workspace-level channels — the ones with no board at all, which the
  // board loop above cannot reach by definition. DMs are excluded inside the
  // helper: they follow their two people across workspaces.
  await deleteWorkspaceChannels(orgId);

  // The org's break-glass key. Nothing else references it once the boards are
  // gone, and leaving it would keep a wrapped private key alive for a workspace
  // that no longer exists.
  await VaultEscrow.deleteMany({ organisation: orgId });
  // Connectors. Unlike a board or group teardown — where a mirrored project is
  // unbound and kept, because it still exists inside the provider and parents a
  // rank history worth more than the mapping — an org teardown has nothing left
  // to keep it for. The sealed OAuth tokens in particular must not outlive the
  // workspace that consented to them.
  // Snapshots go FIRST, and they are the one thing in this block worth pausing
  // over: they are the only per-keyword rank history that will ever exist, and
  // nothing can rebuild them. They are still deleted, because an org teardown is
  // the one event that ends the relationship the data was collected under — but
  // they are deleted BEFORE the projects that parent them, so a failure halfway
  // through leaves orphaned projects rather than orphaned history.
  await ConnectorSnapshot.deleteMany({ organisation: orgId });
  // The DataForSEO task ledger. It is the exact reason `DfsTask.organisation` is
  // REQUIRED rather than derivable: a row that could carry a null would outlive
  // the workspace it was bought for, still holding that workspace's keyword list
  // — which is competitive intelligence, not incidental metadata. Deleted after
  // the snapshots and before the projects, so a failure halfway through leaves
  // orphaned parents rather than orphaned children.
  // The stored SERP bodies. Deleted BEFORE the tasks that bought them and the
  // projects that parent them, children first like everything else here. The
  // pages themselves are public search results, but the KEYWORDS they answer are
  // the workspace's competitive intelligence, and a TTL that expires them in
  // ninety days is not a substitute for a teardown that ends the relationship
  // today. It is also the field phase 11 would have to give up: a cross-tenant
  // SERP cache cannot carry an organisation, which is the first of the four
  // reasons that phase may never happen.
  await DfsSerpResult.deleteMany({ organisation: orgId });
  await DfsTask.deleteMany({ organisation: orgId });
  // Phase 11's measurement. It carries no keywords, but it does carry this
  // workspace's keyword VOLUME and market mix per day, which is competitive
  // intelligence one level up. Same rule as everything else here.
  await DfsCacheProbe.deleteMany({ organisation: orgId });
  // THE SHARED SERP CACHE, and the one collection in this cascade that cannot be
  // deleted by `organisation` — because it has none. That is the first of the
  // four reasons phase 11 nearly did not happen, and the answer is a REFCOUNT:
  // `DfsSerpCache.orgs` names every participating workspace that has paid for or
  // read the body, this workspace is pulled out of it, and a row nobody refers to
  // any more is deleted. A set of ids rather than a counter, because `$pull` is
  // idempotent and `$inc: -1` is not — a cascade retried after a partial failure
  // must not be able to delete a body two other workspaces are still using.
  //
  // The compliance position, stated rather than assumed: a shared row outlives
  // this teardown only while ANOTHER participating workspace is still asking the
  // same question, at which point the keyword is theirs as much as it was ours
  // and the body itself is a public search result. It expires within 48 hours
  // regardless. Nothing here is reachable unless somebody set
  // `DATAFORSEO_SERP_CACHE_ORGS`, which is empty by default.
  await DfsSerpCache.updateMany({ orgs: orgId }, { $pull: { orgs: orgId } });
  await DfsSerpCache.deleteMany({ orgs: { $size: 0 } });
  // The spend ledger. Kept until last of the connector rows, because it is the
  // only record of what this workspace cost — and deleted anyway, for the same
  // reason the snapshots are: an org teardown ends the relationship the data was
  // collected under. An operator who needs the number after the fact takes it
  // from the invoice, which is the authoritative copy regardless.
  await ConnectorBudget.deleteMany({ organisation: orgId });
  await ConnectorProject.deleteMany({ organisation: orgId });
  await ConnectorAccount.deleteMany({ organisation: orgId });
  await ConnectorAuthAttempt.deleteMany({ organisation: orgId });
  await BoardConnector.deleteMany({ organisation: orgId });
  // By `organisation` as well as by board above, so a mapping whose board was
  // already gone cannot survive the workspace.
  await ConnectorFieldMapping.deleteMany({ organisation: orgId });
  await Automation.deleteMany({ organisation: orgId });
  await Tracker.deleteMany({ organisation: orgId });
  await TrackerEntry.deleteMany({ organisation: orgId });
  await Goal.deleteMany({ organisation: orgId });
  await GoalReminder.deleteMany({ organisation: orgId });
  // By `organisation` as well as by board above, so a link whose board was
  // already gone cannot survive the workspace.
  await GoalConnectorLink.deleteMany({ organisation: orgId });
  // The workspace's service catalog — the agency's own vocabulary of the things
  // it sells, one row per name anybody ever typed into the invite table. It had
  // no delete path anywhere in the server: `serviceCatalogService` only reads,
  // upserts and archives, so a workspace's whole catalog outlived the workspace,
  // unlistable (every read filters by organisation) and unremovable.
  //
  // The model's `archived` field says "There is deliberately NO delete", and
  // that decision is preserved: it is about removing ONE entry while the
  // workspace is alive, where groups still resolve their colour through the
  // slug the entry was minted under. It has nothing to say about a teardown in
  // which no group survives to resolve anything. This sweep must therefore stay
  // org-scoped and must not be generalised into the board or group cascade —
  // `TaskGroup.serviceKey` stores the slug rather than this row's id precisely
  // so a surviving group can outlive an entry, and the client-portal reset
  // script depends on the catalog surviving a board wipe.
  await ServiceCatalogEntry.deleteMany({ organisation: orgId });
  // The last of the activity feed, and the third sweep this collection needs.
  // The two above are scoped by task and by board; the executive subject is
  // org-level and carries NEITHER, so `executive.declared`, `executive.updated`
  // and `executive.removed` fell through both and stayed behind holding a real
  // person's name, denormalised into `metadata.targetUserName` at write time
  // because the subject it names is expected to be gone by the time anyone reads
  // the row. Nothing could list them and nothing could delete them.
  //
  // Placed HERE rather than next to the board-scoped sweep, and the placement is
  // the point: that sweep sits inside `if (boardIds.length)`, so an org with no
  // boards left — the exact shape a workspace has after its boards were deleted
  // one at a time — would skip it entirely, and the three types this line exists
  // for are the ones that never had a board to be found by. Running last also
  // means it can only ever follow the board-scoped sweep, never precede it, so
  // the reasoning written over that line about collecting rows whose subject is
  // already gone still holds unchanged.
  //
  // Safe to scope on `organisation` alone: the model's invariant is that exactly
  // one of `task` / `goal` / `adsBudget` / `group` / `organisation` is set, so no
  // task, goal, budget or group row can carry this field. The two board-scoped
  // executive types do carry both, which makes this their belt-and-braces in the
  // same way the two lines above are ConnectorFieldMapping's and
  // GoalConnectorLink's.
  await ActivityLog.deleteMany({ organisation: orgId });

  await User.updateMany(
    { organisations: orgId },
    { $pull: { organisations: orgId } }
  );

  await destroyLogos([await Organisation.findById(orgId).select('logoPublicId').lean()]);
  await Organisation.deleteOne({ _id: orgId });
};

module.exports = { cascadeDeleteOrg };
