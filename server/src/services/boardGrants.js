const Task = require('../models/Task');
const ItemFollow = require('../models/ItemFollow');
const Notification = require('../models/Notification');
const { createNotification } = require('./notificationService');

/**
 * Writing and tearing down ONE person's grant on ONE board.
 *
 * ---- WHY THIS IS A SERVICE AND NOT A BLOCK INSIDE THE CONTROLLER ----------
 *
 * `boardController.setBoardAccess` (`PUT /api/boards/:id/access`) owned every
 * line of this, which was correct while the Share modal was the only thing that
 * ever wrote a grant. It is not the only thing any more. Curating somebody's
 * board list — the executive-view service — IS writing these grants: adding a
 * board to their list writes exactly this grant, removing it revokes exactly
 * this one. A second caller with its own copy of the loop would be two places
 * that have to stay in step forever, and the revoke half is the one that must
 * not drift.
 *
 * That half fixes a bug worth restating, because nothing observable breaks when
 * it regresses: revoking a grant used to strip `memberAccess` and stop there,
 * leaving the user's DERIVED subscriptions behind. Their ItemFollow rows
 * survived, so the task-audience fan-out kept pinging them with task names from
 * a board they could no longer open, indefinitely — a notification feed
 * narrating work they cannot see and cannot unsubscribe from, because the UI
 * that would let them unfollow is behind the access they just lost. The cleanup
 * in `revoke` is the fix, and it lives here so that there is exactly one place
 * for it to be right.
 *
 * ---- WHAT DELIBERATELY DOES NOT LIVE HERE --------------------------------
 *
 * Authorisation. Who may change whose grant is request-level policy about the
 * CALLER — only the board owner may give or take full access, nobody edits their
 * own grant, the board owner's own access is untouchable, the target must be a
 * member of the workspace — and all of it stays in the controller. Both
 * functions below take an ALREADY AUTHORISED decision and carry it out; calling
 * `grant` is itself the statement that the caller was entitled to. Putting the
 * guards here instead would mean every internal caller had to fake a request
 * shape to get past them, which is how a guard ends up being passed `{ isOwner:
 * true }` by the one caller it was written to stop.
 *
 * Both functions mutate and SAVE the board document they are handed, and return
 * it alongside `existed` — whether there was a grant before this call. The
 * caller needs `existed` because it is the difference between "shared with you"
 * and "your access changed", and it cannot be recomputed afterwards.
 */

/**
 * Compare ids without caring whether the ref arrived populated.
 *
 * `String(doc)` on a populated Mongoose Document is its inspect string, never
 * the hex id — the trap `idOf` in utils/permissions.js exists for. `memberAccess`
 * is populated for display on the way OUT of these endpoints, so a caller
 * handing us a board it already populated is a question of when, not if. Kept
 * local because permissions.js does not export its copy.
 */
const idOf = (ref) => String(ref?._id || ref || '');

/** This user's existing grant on the board, or undefined. */
const entryFor = (board, targetUserId) =>
  (board.memberAccess || []).find((e) => idOf(e.user) === idOf(targetUserId));

/** The grant list with this user's entry removed. */
const withoutEntryFor = (board, targetUserId) =>
  (board.memberAccess || []).filter((e) => idOf(e.user) !== idOf(targetUserId));

/**
 * Give `targetUserId` `level` access to `board`, creating or replacing whatever
 * grant they had.
 *
 * `canManage` upgrades an 'edit' grant to FULL access (they may manage sharing
 * too). It is meaningless below 'edit' — a viewer who could hand out access
 * would be a hole, not a feature — so any lower rung clears it here rather than
 * trusting each caller to remember. The controller has already clamped it for
 * the same reason; doing it twice costs nothing and means an internal caller
 * cannot mint a manage-everything viewer by passing the pair that never occurs
 * through the HTTP path.
 *
 * `notify` exists for callers that are already telling the person something
 * else. Adding four boards to an executive's profile in one save should not
 * arrive as four separate "you were given access" rows on top of whatever the
 * feature says itself; the default is to notify, and suppressing it is a
 * deliberate act at the call site.
 */
const grant = async ({
  board,
  targetUserId,
  level,
  canManage = false,
  actorId = null,
  notify = true,
}) => {
  const existing = entryFor(board, targetUserId);

  // Upsert by drop-then-push rather than in-place mutation: the entry is a
  // subdocument, and rewriting the array is what makes "no grant yet" and
  // "already had one" the same two lines of code.
  board.memberAccess = withoutEntryFor(board, targetUserId);
  board.memberAccess.push({
    user: targetUserId,
    level,
    canManage: level === 'edit' && canManage === true,
  });
  await board.save();

  // Notify the user the FIRST time they're given access to this board, and only
  // then. Somebody moving a member between rungs while they set a board up is a
  // detail of the admin's afternoon; the person on the other end needs to hear
  // "this board exists and is yours now" exactly once.
  if (notify && !existing) {
    await createNotification({
      userId: targetUserId,
      type: 'invited',
      message: `You were given access to the board "${board.name}"`,
      orgId: board.organisation,
      boardId: board._id,
      actorId,
    });
  }

  return { board, existed: !!existing };
};

/**
 * Take `targetUserId`'s grant on `board` away, and take their derived
 * subscriptions with it.
 *
 * The cleanup is the reason this function exists — see the header. It is
 * skipped entirely when there was no grant to begin with: a revoke of nothing
 * must not reach across every task on the board to delete rows that, by
 * definition, no grant of ours created. (That case is not hypothetical. Both
 * the Share modal and the executive configurator will happily send 'none' for
 * somebody who never had access, because the UI cannot always know.)
 *
 * The board is still saved in that case, exactly as the controller always has:
 * a no-op save on an unmodified document is cheap and keeps one code path.
 */
const revoke = async ({ board, targetUserId }) => {
  const existing = entryFor(board, targetUserId);

  board.memberAccess = withoutEntryFor(board, targetUserId);
  await board.save();

  if (existing) {
    // `distinct` rather than a find: the ItemFollow rows are keyed by task, and
    // all we need is the id set for this board. On a board with thousands of
    // tasks that is one projection instead of thousands of documents.
    const boardTaskIds = await Task.distinct('_id', { board: board._id });
    if (boardTaskIds.length > 0) {
      await ItemFollow.deleteMany({
        user: targetUserId,
        task: { $in: boardTaskIds },
      });
    }
    // The already-delivered notifications go too. They deep-link into a board
    // this person can no longer open, so every one of them is now a row that
    // 403s when clicked.
    await Notification.deleteMany({
      user: targetUserId,
      board: board._id,
    });
  }

  return { board, existed: !!existing };
};

module.exports = { grant, revoke };
