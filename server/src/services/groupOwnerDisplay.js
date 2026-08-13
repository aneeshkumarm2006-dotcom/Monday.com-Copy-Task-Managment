/**
 * Turning a group's ownership timeline into the fields a screen can render.
 *
 * [utils/groupOwner.js](../utils/groupOwner.js) is the only RESOLVER — it
 * answers "who owns this group in this month" from the sparse timeline. This is
 * the layer above it: it takes that answer, hydrates the user, and produces the
 * exact set of fields every owner-displaying response carries. There is one
 * copy of both halves for the same reason: the Board tab and the Goals tab are
 * showing the SAME fact about the same group, and a second hydration would be a
 * second place for "who owns Black Suede in August" to drift.
 *
 * The raw timeline never appears in the output. That is deliberate and it is
 * what keeps the resolver singular — a client that has never seen the timeline
 * cannot derive a competing answer from it.
 */

const User = require('../models/User');
const { ownerForMonth } = require('../utils/groupOwner');

/**
 * Resolve the owner of every group for one month, in ONE user query.
 *
 * A populate would hydrate every historical entry of every group's timeline to
 * render one avatar each; this fetches only the handful of people actually on
 * screen.
 *
 * The user doc is returned rather than a bare id because a board viewer has no
 * org roster to look ids up in — the client only fetches the member list for
 * board editors, since handing the workspace roster to everyone who can open a
 * board would leak it.
 *
 * @param {Array<Object>} groups - lean TaskGroups carrying `ownerTimeline`.
 * @param {string} monthKey - 'YYYY-MM'; the month the owner is resolved AGAINST.
 * @param {Object} [org] - the organisation, for the `ownerActive` flag only.
 * @returns {Promise<Map<string, {owner, ownerMonth, ownerFromMonth, ownerInherited, ownerActive}>>}
 *   keyed by group id as a string. Every group gets an entry, owner or not.
 */
const resolveOwnerDisplay = async (groups = [], monthKey, org) => {
  const resolved = groups.map((g) => ({ id: String(g._id), owner: ownerForMonth(g, monthKey) }));

  const ids = [...new Set(resolved.map((r) => r.owner.userId).filter(Boolean))];
  const users = ids.length
    ? await User.find({ _id: { $in: ids } }).select('name profilePic email').lean()
    : [];
  const byId = new Map(users.map((u) => [String(u._id), u]));
  const memberIds = new Set((org?.members || []).map((m) => String(m?._id || m)));

  return new Map(resolved.map(({ id, owner }) => [id, {
    owner: owner.userId ? byId.get(owner.userId) || null : null,
    // The month this was resolved against. The board echoes it back on write,
    // which is what stops a stale tab assigning into a month nobody is looking at.
    ownerMonth: monthKey,
    ownerFromMonth: owner.fromMonth,
    ownerInherited: owner.inherited,
    // Removing someone from the org does NOT scrub the groups they owned — the
    // same rule Task.assignedTo already follows, and scrubbing would rewrite
    // history that was true at the time. Flagged rather than hidden, because the
    // group still needs a new owner.
    ownerActive: owner.userId ? memberIds.has(owner.userId) : true,
  }]));
};

/** The zero value, for a group the caller could not resolve. Same shape. */
const EMPTY_OWNER_DISPLAY = {
  owner: null,
  ownerMonth: null,
  ownerFromMonth: null,
  ownerInherited: false,
  ownerActive: true,
};

module.exports = { resolveOwnerDisplay, EMPTY_OWNER_DISPLAY };
