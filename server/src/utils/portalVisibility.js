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
 * one are ordinary internal work, and a task that merely lives next to a portal
 * group must stay invisible. Every portal read and every client-facing side
 * effect asks this module rather than re-deriving the rule, because the two
 * doors do not look alike (one is keyed to a person, the other to the group) and
 * a hand-rolled `source === 'client'` check silently drops the second.
 */

/**
 * Is this task readable by the client at all? Use for client-facing SIDE EFFECTS
 * (portal timeline events, client-visible wording) where there is a task in hand
 * but no signed-in contact to scope against.
 *
 * Note this deliberately says nothing about WHICH contact — see portalTaskFilter
 * for that. A shared task is readable by every contact on its group.
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
 * `parent: null` keeps subitems out. The portal has no notion of nesting, so a
 * shared parent's children would otherwise surface as extra top-level cards with
 * no context — and the team never chose to show them. Sharing a subitem is
 * rejected at the write end too; this is the second lock on the same door.
 */
const portalTaskFilter = ({ groupId, contactId }) => ({
  group: groupId,
  parent: null,
  $or: [{ portalSubmitter: contactId }, { portalShared: true }],
});

/**
 * Did this task come FROM the team rather than from a client?
 *
 * Drives who the portal credits the opening message to. It keys off the
 * submitter, not `portalShared`, so it stays right if a client-raised ticket is
 * ever shared group-wide: whoever raised it still authored it.
 */
const isTeamAuthoredIssue = (task) => !task?.portalSubmitter;

module.exports = { isClientVisibleTask, portalTaskFilter, isTeamAuthoredIssue };
