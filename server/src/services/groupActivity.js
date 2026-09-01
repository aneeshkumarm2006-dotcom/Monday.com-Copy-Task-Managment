/**
 * groupActivity.js — what happened to a group, and who did it.
 *
 * `TaskGroup.createdBy` is a byline: set once at creation, never written again,
 * and gone the moment the group is deleted. That answers exactly one question,
 * for as long as the group exists. This answers the three it cannot:
 *
 *   - who made this group, for a group that has since been DELETED;
 *   - who RENAMED it, and what it used to be called (a group on a client board
 *     IS a client, so "this was Gorski until August" is not trivia);
 *   - who deleted it, and when — the single most destructive action available
 *     on a board, since deleteGroup cascades through every task, update,
 *     note, goal, budget and portal contact underneath it.
 *
 * Rows land in the SAME `ActivityLog` collection as task, goal and budget
 * events, keyed on `group`. One collection, for the reason goalActivity.js
 * states: the board activity export reads a board's whole history by board id,
 * and a second collection would mean a second query, a second merge, and a
 * report that could quietly disagree with itself about what happened.
 *
 * FIRE AND FORGET, like every other logger here — `logActivity` swallows its own
 * errors, so a broken log never blocks the mutation that triggered it. Nothing
 * in this file is awaited in a way that can fail a create, a rename or a delete.
 *
 * NO `group.field_changed`. A group has one user-visible field worth a history
 * (its name), so a dedicated `group.renamed` type says what happened without a
 * reader having to decode a `field` column. Tags, order and the owner timeline
 * are deliberately not logged: order is churn, tags are already reversible from
 * the board's catalog, and the owner timeline IS its own history — it records
 * `setBy` and `setAt` on every entry and never overwrites the past.
 */

const { logActivity } = require('./activityService');

/** How much of a group name we are willing to carry into a log row. */
const MAX_NAME = 120;

const truncate = (s, n) => {
  const v = String(s == null ? '' : s);
  return v.length > n ? `${v.slice(0, n - 1)}…` : v;
};

/**
 * The context every group row carries.
 *
 * `groupName` is what makes a `group.deleted` row readable: once the group is
 * gone there is no document left to join to, and the pointer resolves to
 * nothing. The name captured here is the only thing that still says which group
 * it was — the same trick goal rows use for a deleted goal.
 */
const baseMetadata = (group) => ({
  groupName: truncate(group?.name, MAX_NAME),
  // The board's own kind, captured at the time. A group means something
  // different on a client board (it is a client) than on a tracker board (it is
  // a workstream), and the export reads better when it can say which.
  boardType: null,
});

const actorOf = ({ actor, actorType = 'user', actorLabel = '' }) => ({
  actor,
  actorType,
  actorLabel,
});

/**
 * A new group.
 *
 * Redundant with `TaskGroup.createdBy` while the group lives, and deliberately
 * so: the byline dies with the group, this row does not.
 */
const logGroupCreated = ({ group, board, actor, actorType, actorLabel }) =>
  logActivity({
    group,
    board: board?._id || group?.board,
    ...actorOf({ actor, actorType, actorLabel }),
    type: 'group.created',
    newValue: truncate(group?.name, MAX_NAME),
    metadata: { ...baseMetadata(group), boardType: board?.boardType || null },
  });

/**
 * A rename. Writes nothing when the name did not actually move — the update
 * endpoint re-sends `name` on an order-only or tags-only save, and a save that
 * changed nothing must log nothing (the rule `logGoalChanges` enforces by
 * diffing).
 *
 * `from` must be captured BEFORE the assignment; a mongoose doc compared to its
 * own mutated self finds nothing.
 */
const logGroupRenamed = ({ group, board, from, to, actor, actorType, actorLabel }) => {
  const before = truncate(from, MAX_NAME);
  const after = truncate(to, MAX_NAME);
  if (!before || !after || before === after) return null;
  return logActivity({
    group,
    board: board?._id || group?.board,
    ...actorOf({ actor, actorType, actorLabel }),
    type: 'group.renamed',
    oldValue: before,
    newValue: after,
    // The CURRENT name, so a row reads as "…renamed X to Y" under the name the
    // board shows today rather than the one it had at the time.
    metadata: { ...baseMetadata({ name: after }), boardType: board?.boardType || null },
  });
};

/**
 * A delete, with what it took down.
 *
 * The counts are the point. "Ann deleted a group" and "Ann deleted a group
 * holding 40 tasks and 8 goals" are different events, and after the cascade has
 * run there is nothing left to count — which is why the caller collects these
 * BEFORE deleting and passes them in.
 */
const logGroupDeleted = ({
  group,
  board,
  actor,
  actorType,
  actorLabel,
  taskCount = 0,
  goalCount = 0,
}) =>
  logActivity({
    group,
    board: board?._id || group?.board,
    ...actorOf({ actor, actorType, actorLabel }),
    type: 'group.deleted',
    oldValue: truncate(group?.name, MAX_NAME),
    metadata: {
      ...baseMetadata(group),
      boardType: board?.boardType || null,
      taskCount,
      goalCount,
    },
  });

module.exports = {
  logGroupCreated,
  logGroupRenamed,
  logGroupDeleted,
  MAX_NAME,
};
