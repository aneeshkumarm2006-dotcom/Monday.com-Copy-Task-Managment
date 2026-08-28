/**
 * Task→Goal EVIDENCE — the derived facts, in one pure place.
 *
 * A tracker board's Goals and Tasks have always shared the same
 * (board, group, monthKey) partition without knowing about each other. A goal
 * row could say "Target 12, Actual 7" while the work behind that 7 was
 * invisible. `Task.goalLinks` is the answer to "what did we actually do for
 * this goal?", and this file is the only place that interprets it.
 *
 * THE ONE PROMISE THIS FEATURE MAKES: evidence is EVIDENCE ONLY. Nothing here
 * is read by anything that scores. `utils/goalTypes.js` never sees a link, and
 * `scoreGoal` still reads exactly `type`, `config` and `actual`/`actualDayKey`.
 * Attaching a task cannot move a number, and if a future change makes it able
 * to, that change is wrong.
 *
 * WHY THE LINK CARRIES ITS OWN `monthKey` AND `group`. They are the task's
 * values at the moment the link was made, and they are not denormalisation for
 * speed — they ARE the staleness input. A task that is later reopened, refiled
 * into September, or moved to another group has drifted away from what was
 * claimed about it, and the drift is only visible because the claim was
 * written down. Nothing here ever deletes a link to resolve that drift: the
 * link is a record of something a person asserted, and it is flagged for a
 * human to reconcile, never quietly corrected.
 *
 * STALENESS IS DERIVED, NEVER STORED, for exactly the reason Goal.js:21-23
 * refuses to store a score: a stored flag is wrong the instant someone reopens
 * a task, and both sides of every comparison are already loaded on both read
 * paths, so deriving it is free.
 *
 * CLIENT MIRROR. `client/src/utils/goalEvidence.js` holds the same STATE rules
 * (attributed / orphaned / dismissed) so the board grid can render a marker
 * from task documents it already has, with no extra request. It deliberately
 * does NOT mirror the stale LABELS — the wording lives here and reaches the
 * client as data, so there is one copy of every sentence. That split is the
 * same one `doneStatus.js` and `client/src/utils/statusUtils.js` already make.
 */

const { isResolvedStatus } = require('./doneStatus');
const { formatMonth } = require('./monthKey');

/**
 * A task attached to twenty goals is a data-entry mistake, not a use case, and
 * an unbounded array on a document the board grid reads a page at a time is
 * the one real failure mode of embedding these on the Task.
 */
const MAX_GOAL_LINKS = 20;

const STALE_CODES = ['reopened', 'moved_month', 'moved_group'];

const idOf = (value) => {
  if (value === null || value === undefined) return null;
  // Populated ref, raw ObjectId, or string — all three reach this.
  const raw = value._id !== undefined ? value._id : value;
  return raw === null || raw === undefined ? null : String(raw);
};

/** The goal ids a task currently claims, as strings, in link order. */
const linkedGoalIds = (task) =>
  (task && Array.isArray(task.goalLinks) ? task.goalLinks : [])
    .map((link) => idOf(link && link.goal))
    .filter(Boolean);

/** Has someone explicitly said "this is not goal work"? */
const isDismissed = (task) => !!(task && task.goalLinkDismissedAt);

/**
 * Can this task carry evidence at all?
 *
 * Subitems are excluded because a subitem inherits its parent's month rather
 * than deriving one (Task.js:85-88) and moves with its parent — the evidence
 * is about the parent's work. Personal tasks live on no board and so have no
 * goals to point at.
 */
const isAttachable = (task) =>
  !!task && !task.isPersonal && !task.parent && !!task.monthKey;

/**
 * Why is this link no longer telling the truth about its task?
 *
 * Returns [] for a healthy link. Order is stable so a UI can render the first
 * reason as the headline.
 *
 * @param {object} task  the task as it is NOW
 * @param {object} link  one entry of `task.goalLinks` — the claim as it was made
 * @param {object} board needed to interpret `task.status`, which is Mixed
 * @returns {Array<{code: string, label: string}>}
 */
const staleReasonsFor = (task, link, board) => {
  if (!task || !link) return [];
  const out = [];

  // `Task.status` is Mixed — an ObjectId into board.statuses for board tasks,
  // the legacy string for personal ones. `isResolvedStatus` is the only
  // permitted done-test; a bare `=== 'done'` is wrong for every board task.
  if (!isResolvedStatus(board, task.status)) {
    out.push({ code: 'reopened', label: 'Task was reopened' });
  }

  if (task.monthKey && link.monthKey && task.monthKey !== link.monthKey) {
    out.push({
      code: 'moved_month',
      label: `Moved to ${formatMonth(task.monthKey, { long: true })}`,
    });
  }

  const taskGroup = idOf(task.group);
  const linkGroup = idOf(link.group);
  if (taskGroup && linkGroup && taskGroup !== linkGroup) {
    out.push({ code: 'moved_group', label: 'Moved to another group' });
  }

  return out;
};

/**
 * A done task that nobody has attached to anything and nobody has excused.
 *
 * `groupHasGoals` is load-bearing and not an optimisation. Without it, every
 * done task in every group that never set a goal grows an orphan marker on day
 * one — the marker becomes wallpaper, and the feature reads as broken. If
 * there was nothing to attach to, there is nothing to nag about.
 */
const isOrphan = ({ task, board, groupHasGoals }) =>
  !!groupHasGoals &&
  isAttachable(task) &&
  isResolvedStatus(board, task.status) &&
  linkedGoalIds(task).length === 0 &&
  !isDismissed(task);

/**
 * What the board-grid marker should say about this row. `null` means render
 * nothing at all, which is the answer for every task that is not yet done and
 * every task on a board that has no goals for the month.
 *
 * @returns {'attributed'|'orphaned'|'dismissed'|null}
 */
const evidenceStateOf = ({ task, board, groupHasGoals }) => {
  if (!isAttachable(task)) return null;
  if (linkedGoalIds(task).length > 0) return 'attributed';
  if (!isResolvedStatus(board, task.status)) return null;
  if (isDismissed(task)) return 'dismissed';
  return groupHasGoals ? 'orphaned' : null;
};

/**
 * Fold a month's tasks into the per-group counts the Goals tab header and the
 * People tab both read. One function, two callers, so the two can never
 * disagree about what "attributed" means.
 *
 * `goalGroupIds` is the set of groups that actually have a goal this month —
 * the `groupHasGoals` rule above, applied in bulk.
 *
 * @param {object[]} tasks         the month's top-level tasks
 * @param {object} board
 * @param {Set<string>} goalGroupIds
 * @returns {Map<string, {done:number, attributed:number, orphaned:number, dismissed:number}>}
 */
const foldEvidenceByGroup = (tasks, board, goalGroupIds) => {
  const out = new Map();
  const bucket = (groupId) => {
    if (!out.has(groupId)) {
      out.set(groupId, { done: 0, attributed: 0, orphaned: 0, dismissed: 0 });
    }
    return out.get(groupId);
  };

  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (!isAttachable(task)) continue;
    const groupId = idOf(task.group);
    if (!groupId) continue;

    const done = isResolvedStatus(board, task.status);
    const row = bucket(groupId);
    if (done) row.done += 1;

    if (linkedGoalIds(task).length > 0) {
      row.attributed += 1;
    } else if (done && isDismissed(task)) {
      row.dismissed += 1;
    } else if (done && goalGroupIds && goalGroupIds.has(groupId)) {
      row.orphaned += 1;
    }
  }

  return out;
};

module.exports = {
  MAX_GOAL_LINKS,
  STALE_CODES,
  linkedGoalIds,
  isDismissed,
  isAttachable,
  staleReasonsFor,
  isOrphan,
  evidenceStateOf,
  foldEvidenceByGroup,
};
