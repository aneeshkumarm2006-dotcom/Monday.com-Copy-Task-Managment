/**
 * Status-related helpers shared across views.
 *
 * Tasks reference statuses in one of two shapes:
 *   - ObjectId / string id pointing into `board.statuses[]` (post Phase 2)
 *   - Legacy enum string ('done', 'working_on_it', 'stuck', 'not_started')
 *     used by personal tasks and pre-migration board tasks
 *
 * Helpers here accept either shape and resolve the correct answer.
 */

/**
 * Whether the task's status — interpreted against the board — is the
 * "done" status.
 *
 * `board` may be null (personal task) — in that case the legacy enum
 * string is the only thing to check.
 */
export const isStatusDone = (board, statusRef) => {
  if (board && Array.isArray(board.statuses) && statusRef != null) {
    const match = board.statuses.find(
      (s) => s._id && s._id.toString() === statusRef.toString()
    );
    if (match) return match.key === 'done';
  }
  return statusRef === 'done';
};

/**
 * Is EVERY task in this list done?
 *
 * `tasks` MUST be the UNFILTERED bucket. Deciding this from the rows currently
 * on screen would make a group announce itself finished the moment somebody
 * filters to Status = Done, and un-finish it under a filter for Stuck — the
 * completion is a fact about the group, not about what the filter bar is
 * showing. That is the whole reason this is a named helper rather than an
 * inline `.every()` a later edit can quietly repoint at the wrong array.
 *
 * An EMPTY group is not complete. Nothing has been completed, and the other
 * answer fires the banner the instant somebody creates a group.
 */
export const isGroupComplete = (tasks, board) =>
  Array.isArray(tasks)
  && tasks.length > 0
  && tasks.every((t) => t && t.status != null && isStatusDone(board, t.status));

export default { isStatusDone, isGroupComplete };
