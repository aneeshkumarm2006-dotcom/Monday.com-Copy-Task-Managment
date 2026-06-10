const Organisation = require('../models/Organisation');
const Board = require('../models/Board');
const TaskGroup = require('../models/TaskGroup');
const Task = require('../models/Task');
const Comment = require('../models/Comment');
const Update = require('../models/Update');
const Notification = require('../models/Notification');
const Automation = require('../models/Automation');
const User = require('../models/User');
const ActivityLog = require('../models/ActivityLog');
const BoardConnection = require('../models/BoardConnection');
const { destroyCloudinaryAssets } = require('../config/cloudinary');

/**
 * Permanently delete an organisation and everything that lives under it.
 *
 * Cascade order (children first to avoid dangling refs if anything fails):
 *   1. Updates, Comments, Notifications — scoped by task IDs in the org's boards
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
    await Comment.deleteMany({ task: { $in: taskIds } });
    await Notification.deleteMany({ task: { $in: taskIds } });
    await ActivityLog.deleteMany({ task: { $in: taskIds } });
    await Task.deleteMany({ _id: { $in: taskIds } });
  }

  await Notification.deleteMany({ organisation: orgId });

  if (boardIds.length) {
    await TaskGroup.deleteMany({ board: { $in: boardIds } });
    await Automation.deleteMany({ board: { $in: boardIds } });
    await BoardConnection.deleteMany({
      $or: [{ fromBoardId: { $in: boardIds } }, { toBoardId: { $in: boardIds } }],
    });
    await Board.deleteMany({ _id: { $in: boardIds } });
  }

  await Automation.deleteMany({ organisation: orgId });

  await User.updateMany(
    { organisations: orgId },
    { $pull: { organisations: orgId } }
  );

  await Organisation.deleteOne({ _id: orgId });
};

module.exports = { cascadeDeleteOrg };
