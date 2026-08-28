/**
 * Task→Goal EVIDENCE, client side.
 *
 * On a tracker board a done task can be attached to the goals it counted
 * towards. The links live on the task itself (`task.goalLinks`), which is what
 * lets the board grid render its marker with no extra request — the rows it
 * already fetched carry their own answer.
 *
 * MIRROR OF `server/src/utils/goalEvidence.js`, and deliberately only half of
 * it. The STATE rules are here, because the grid has to decide what to draw
 * from data it already holds. The stale WORDING is not: "Moved to September
 * 2026" is composed on the server and arrives as data, so there is exactly one
 * copy of every sentence. That is the same split `statusUtils.isStatusDone`
 * and the server's `doneStatus.isResolvedStatus` already make.
 *
 * EVIDENCE ONLY. Nothing here feeds a score. A goal's number is computed
 * server-side by `goalTypes.js`, which never sees a link.
 */

import { isStatusDone } from './statusUtils';

const idOf = (value) => {
  if (value === null || value === undefined) return null;
  const raw = value._id !== undefined ? value._id : value;
  return raw === null || raw === undefined ? null : String(raw);
};

/** The goal ids a task currently claims, as strings, in link order. */
export const linkedGoalIds = (task) =>
  (task && Array.isArray(task.goalLinks) ? task.goalLinks : [])
    .map((link) => idOf(link && link.goal))
    .filter(Boolean);

/** Has someone explicitly said "this is not goal work"? */
export const isDismissed = (task) => !!(task && task.goalLinkDismissedAt);

/**
 * Can this task carry evidence at all? Subitems inherit their parent's month
 * rather than deriving one and move with it, so the evidence belongs to the
 * parent; personal tasks live on no board and so have no goals to point at.
 */
export const isAttachable = (task) =>
  !!task && !task.isPersonal && !task.parent && !!task.monthKey;

/**
 * What the row marker should say. `null` means draw nothing.
 *
 * `groupHasGoals` is load-bearing and not an optimisation: without it every
 * done task in every group that never set a goal wears an orphan dot on day
 * one, the marker becomes wallpaper, and the feature reads as broken. If there
 * was nothing to attach to, there is nothing to nag about.
 *
 * @returns {'attributed'|'orphaned'|'dismissed'|null}
 */
export const evidenceStateOf = ({ task, board, groupHasGoals }) => {
  if (!isAttachable(task)) return null;
  if (linkedGoalIds(task).length > 0) return 'attributed';
  if (!isStatusDone(board, task.status)) return null;
  if (isDismissed(task)) return 'dismissed';
  return groupHasGoals ? 'orphaned' : null;
};

/**
 * Did this update move the task INTO the done column? The question the on-done
 * prompt is asking.
 *
 * Both sides are needed: firing on "is done now" alone would re-prompt on every
 * later edit of an already-finished task, and the optimistic update paths call
 * the store twice for one user action (once optimistically, once with the
 * server's reply) — the `from` side is what makes that fire once.
 */
export const becameDone = (prev, next, board) =>
  !!board
  && board.boardType === 'tracker'
  && isAttachable(next)
  && !isStatusDone(board, prev?.status)
  && isStatusDone(board, next?.status);

export default {
  linkedGoalIds,
  isDismissed,
  isAttachable,
  evidenceStateOf,
  becameDone,
};
