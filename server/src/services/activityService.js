const ActivityLog = require('../models/ActivityLog');

/**
 * Record an activity event for a task.
 *
 * Fire-and-forget by design: failures are logged but never re-thrown so a
 * broken log never blocks the triggering mutation (mirrors notificationService).
 *
 * @param {Object} args
 * @param {Object|string} args.task    - Task doc (preferred — supplies board) OR task id
 * @param {string|ObjectId} args.actor - userId performing the action
 * @param {string} args.type           - one of ActivityLog.ACTIVITY_TYPES
 * @param {string} [args.field]        - for type 'task.field_changed'
 * @param {*}      [args.oldValue]
 * @param {*}      [args.newValue]
 * @param {Object} [args.metadata]     - { itemText, attachmentName, commentSnippet, ... }
 */
const logActivity = async ({
  task,
  actor,
  actorType = 'user',
  actorLabel = '',
  type,
  field,
  oldValue,
  newValue,
  metadata,
}) => {
  try {
    // Team events need a User actor; client-portal events carry a label instead.
    if (!task || !type) return null;
    if (actorType !== 'client' && !actor) return null;

    const taskId = task._id || task;
    const boardId = task.board || null;

    const doc = await ActivityLog.create({
      task: taskId,
      board: boardId,
      actor: actorType === 'client' ? null : actor,
      actorType,
      actorLabel,
      type,
      field: field || null,
      oldValue: oldValue === undefined ? null : oldValue,
      newValue: newValue === undefined ? null : newValue,
      metadata: metadata || null,
    });
    return doc;
  } catch (err) {
    console.error('logActivity error:', err);
    return null;
  }
};

module.exports = {
  logActivity,
};
