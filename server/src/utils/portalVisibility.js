/**
 * THE rule for "can an external client see this task", in one place.
 *
 * A task on a Client Portal board reaches the client through exactly two doors:
 *
 *   1. the client raised it themselves — `source: 'client'` with a
 *      `portalSubmitter`, created by portalController.createMyIssue; or
 *   2. the team published it — `portalShared: true`, set by a team member who
 *      wants the client to track something the team is asking OF them.
 *
 * Nothing else qualifies. Sitting on a client board is not enough: most rows on
 * one are ordinary internal work, and a task that merely lives on a client's
 * board must stay invisible. Every portal read and every client-facing side
 * effect asks this module rather than re-deriving the rule, because the two
 * doors do not look alike (one is keyed to a person, the other to the board) and
 * a hand-rolled `source === 'client'` check silently drops the second.
 */

/**
 * Is this task readable by the client at all? Use for client-facing SIDE EFFECTS
 * (portal timeline events, client-visible wording) where there is a task in hand
 * but no signed-in contact to scope against.
 *
 * Note this deliberately says nothing about WHICH contact — see portalTaskFilter
 * for that. A shared task is readable by every contact on its board.
 */
const isClientVisibleTask = (task) => {
  if (!task) return false;
  if (task.portalShared === true) return true;
  return task.source === 'client' && !!task.portalSubmitter;
};

/**
 * The Mongo filter for "everything this signed-in contact may see", to be spread
 * into any portal query. Pass `req.portal`.
 *
 * Scoped to the BOARD, because a client board is one client company and its
 * groups are that client's workstreams — a contact sees all of them.
 *
 * `parent: null` keeps subitems out. The portal has no notion of nesting, so a
 * shared parent's children would otherwise surface as extra top-level cards with
 * no context — and the team never chose to show them. Sharing a subitem is
 * rejected at the write end too; this is the second lock on the same door.
 *
 * WHY THIS THROWS instead of returning a filter with holes in it: Mongoose
 * strips `undefined` values out of a query filter. A caller still passing the
 * old `{ groupId, contactId }` shape would therefore produce
 * `{ parent: null, $or: [{ portalSubmitter: undefined }, { portalShared: true }] }`
 * — which matches EVERY portalShared task in the database, across every board
 * and every workspace, and hands it to whichever client happened to ask. That
 * is the single worst outcome available in this refactor and it is one missed
 * call site away. Throwing turns a silent cross-tenant disclosure into a 500.
 */
const portalTaskFilter = ({ boardId, contactId } = {}) => {
  if (!boardId || !contactId) {
    throw new Error(
      'portalTaskFilter requires both boardId and contactId — refusing to build an unscoped portal query'
    );
  }
  return {
    board: boardId,
    parent: null,
    $or: [{ portalSubmitter: contactId }, { portalShared: true }],
  };
};

/**
 * Did this task come FROM the team rather than from a client?
 *
 * Drives who the portal credits the opening message to. It keys off the
 * submitter, not `portalShared`, so it stays right if a client-raised ticket is
 * ever shared group-wide: whoever raised it still authored it.
 */
const isTeamAuthoredIssue = (task) => !task?.portalSubmitter;

module.exports = { isClientVisibleTask, portalTaskFilter, isTeamAuthoredIssue };
