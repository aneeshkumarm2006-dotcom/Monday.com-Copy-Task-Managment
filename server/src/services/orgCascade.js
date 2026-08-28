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
const GoalReminder = require('../models/GoalReminder');
const User = require('../models/User');
const ActivityLog = require('../models/ActivityLog');
const BoardConnection = require('../models/BoardConnection');
const ConnectorAccount = require('../models/ConnectorAccount');
const ConnectorAuthAttempt = require('../models/ConnectorAuthAttempt');
const ConnectorProject = require('../models/ConnectorProject');
const ConnectorSnapshot = require('../models/ConnectorSnapshot');
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
