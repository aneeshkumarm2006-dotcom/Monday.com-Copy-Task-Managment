const ActivityLog = require('../models/ActivityLog');

/**
 * Record an activity event for a task.
 *
 * Fire-and-forget by design: failures are logged but never re-thrown so a
 * broken log never blocks the triggering mutation (mirrors notificationService).
 *
 * EXACTLY ONE SUBJECT per row: a `task` or a `goal`. Goals are their own
 * collection on tracker boards and are not tasks, so a goal event carries the
 * goal pointer and no task — which is what keeps the per-task feed from ever
 * returning one.
 *
 * @param {Object} args
 * @param {Object|string} [args.task]  - Task doc (preferred — supplies board) OR task id
 * @param {Object|string} [args.goal]  - Goal doc (preferred — supplies board) OR goal id
 * @param {string|ObjectId} [args.board] - board id, when neither doc was passed whole
 * @param {string|ObjectId} args.actor - userId performing the action
 * @param {string} args.type           - one of ActivityLog.ACTIVITY_TYPES
 * @param {string} [args.field]        - for type 'task.field_changed' / 'goal.field_changed'
 * @param {*}      [args.oldValue]
 * @param {*}      [args.newValue]
 * @param {Object} [args.metadata]     - { itemText, attachmentName, commentSnippet, ... }
 */
const logActivity = async ({
  task,
  goal,
  board,
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
    // Team events need a User actor; client-portal and unattended events carry
    // a label instead.
    if ((!task && !goal) || !type) return null;
    if (actorType === 'user' && !actor) return null;

    const taskId = task ? (task._id || task) : null;
    const goalId = goal ? (goal._id || goal) : null;
    // A bare id string has no `.board`, which is why callers pass the doc where
    // they have one; `board` is the explicit way out when they do not.
    const boardId = board || task?.board || goal?.board || null;

    const doc = await ActivityLog.create({
      task: taskId,
      goal: goalId,
      board: boardId,
      actor: actorType === 'user' ? actor : null,
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
