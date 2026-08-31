const Organisation = require('../models/Organisation');
const Board = require('../models/Board');
const TaskGroup = require('../models/TaskGroup');
const Task = require('../models/Task');
const Update = require('../models/Update');
const Note = require('../models/Note');
const Notification = require('../models/Notification');
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
const { destroyCloudinaryAssets } = require('../config/cloudinary');
const VaultEscrow = require('../models/VaultEscrow');
const { cascadeDeleteVaults } = require('./vaultCascade');

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
    // Goal activity rows carry `goal`, not `task`, so the task-scoped delete
    // above cannot reach them. Scoped by BOARD rather than by goal id: it is
    // the same set (a goal belongs to exactly one board) and it also collects
    // rows for goals already deleted, which the id list no longer contains.
    await ActivityLog.deleteMany({ board: { $in: boardIds }, goal: { $ne: null } });
    // Ads budgets, and their activity, for exactly the same two reasons as the
    // goal rows above: they hang off the board rather than off a task, and the
    // board-scoped delete also collects rows for budgets already deleted.
    await AdsBudget.deleteMany({ board: { $in: boardIds } });
    await ActivityLog.deleteMany({ board: { $in: boardIds }, adsBudget: { $ne: null } });
    await TaskGroup.deleteMany({ board: { $in: boardIds } });
    await Automation.deleteMany({ board: { $in: boardIds } });
    await BoardConnection.deleteMany({
      $or: [{ fromBoardId: { $in: boardIds } }, { toBoardId: { $in: boardIds } }],
    });
    await Board.deleteMany({ _id: { $in: boardIds } });
  }

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

  await User.updateMany(
    { organisations: orgId },
    { $pull: { organisations: orgId } }
  );

  await Organisation.deleteOne({ _id: orgId });
};

module.exports = { cascadeDeleteOrg };
