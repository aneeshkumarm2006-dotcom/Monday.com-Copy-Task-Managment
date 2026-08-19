/**
 * Moving one goal within its group's table.
 *
 * The counterpart to `goalSort.js`, and deliberately its opposite. Sorting is a
 * way of LOOKING at the month — per person, per visit, written nowhere. This is
 * a change TO the month: it ends in a `PUT .../goals/reorder`, writes
 * `Goal.order`, and everybody who opens that group afterwards sees the table in
 * the order the mover left it. A goal at the top is at the top for the whole
 * team.
 *
 * Which is why the two cannot both be live at once. While a column sort is
 * active the rows on screen are not in stored order, so "move up" has no
 * honest meaning — the section disables the move controls and offers to save
 * the sorted order instead, which is the same act said out loud.
 *
 * Pure id arithmetic, no React and no goal objects: the desktop row, the mobile
 * card and the "save this order" button all have to agree about what "up"
 * means, and one function is how they cannot disagree.
 */

/** The four moves, in menu order. A 28-goal table is why `top` exists. */
export const GOAL_MOVES = ['top', 'up', 'down', 'bottom'];

const indexOfId = (ids, id) => ids.findIndex((x) => String(x) === String(id));

/** Where `dir` lands a row currently at `from`, or -1 when it cannot move. */
const targetIndex = (dir, from, count) => {
  switch (dir) {
    case 'top': return 0;
    case 'up': return from - 1;
    case 'down': return from + 1;
    case 'bottom': return count - 1;
    default: return -1;
  }
};

/**
 * Which moves are available to the row at `index`, for greying out menu items.
 * A one-row table can do nothing, and neither can it be asked to.
 */
export const availableGoalMoves = (index, count) => ({
  top: index > 0,
  up: index > 0,
  down: index >= 0 && index < count - 1,
  bottom: index >= 0 && index < count - 1,
});

/**
 * The whole table's ids after moving `id` in direction `dir`.
 *
 * Returns null — not the array back — for a move that changes nothing, so the
 * caller can skip a pointless round trip rather than having to compare arrays.
 */
export const moveGoalId = (ids = [], id, dir) => {
  const from = indexOfId(ids, id);
  if (from < 0) return null;

  const to = targetIndex(dir, from, ids.length);
  if (to === from || to < 0 || to > ids.length - 1) return null;

  const next = ids.map(String);
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
};

/** Reorder a list of goal objects to match `orderedIds`. Unknown ids are dropped. */
export const applyGoalOrder = (goals = [], orderedIds = []) => {
  const byId = new Map(goals.map((g) => [String(g._id), g]));
  return orderedIds.map((id) => byId.get(String(id))).filter(Boolean);
};
