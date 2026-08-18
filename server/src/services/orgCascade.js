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
    // Same omission as the board cascade had: notes are only otherwise removed
    // when their GROUP is deleted, so tearing down an org left them behind.
    await Note.deleteMany({ board: { $in: boardIds } });
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
  await Automation.deleteMany({ organisation: orgId });
  await Tracker.deleteMany({ organisation: orgId });
  await TrackerEntry.deleteMany({ organisation: orgId });
  await Goal.deleteMany({ organisation: orgId });
  await GoalReminder.deleteMany({ organisation: orgId });

  await User.updateMany(
    { organisations: orgId },
    { $pull: { organisations: orgId } }
  );

  await Organisation.deleteOne({ _id: orgId });
};

module.exports = { cascadeDeleteOrg };
