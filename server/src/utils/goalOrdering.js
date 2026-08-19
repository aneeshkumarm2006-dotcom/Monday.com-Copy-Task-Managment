/**
 * The order goals sit in on the Goals tab — the maths, with no database in it.
 *
 * Reordering is a SHARED fact, not a per-browser preference: `Goal.order` is a
 * stored field and the tab reads it back for everyone. That is the whole point
 * of the feature — a goal someone pushed to the top of a client's table is at
 * the top of that table for the person reporting on it next month too. (Column
 * SORTING, in `client/src/utils/goalSort.js`, is the opposite and stays that
 * way: a way of looking at the month, per person, per visit, persisted nowhere.)
 *
 * One table at a time. Order is only ever meaningful within one (group, month),
 * because that is the only list a human ever sees — the read buckets goals by
 * group, so two groups both starting at 0 never meet.
 */

/**
 * The full ordering to write, given the ids the client asked for and every id
 * actually in that table right now.
 *
 * `orderedIds` is what the user's screen showed when they clicked. `allIds` is
 * the truth, in its current order. Anything in `allIds` the client never saw —
 * a goal someone else added while this tab sat open — keeps its relative place
 * at the END rather than being dropped or, worse, colliding on order 0 with
 * every other row and falling back to creation date. Ids in `orderedIds` that
 * are no longer in the table (deleted from under us) are discarded.
 */
const mergeGoalOrder = (orderedIds = [], allIds = []) => {
  const live = new Set(allIds.map(String));
  const seen = new Set();

  const kept = [];
  for (const raw of orderedIds) {
    const id = String(raw);
    if (!live.has(id) || seen.has(id)) continue;
    seen.add(id);
    kept.push(id);
  }

  const appended = allIds.map(String).filter((id) => !seen.has(id));
  return [...kept, ...appended];
};

/** `${group}:${monthKey}` — the identity of one goals table. */
const tableKeyOf = (goal) => `${goal.group}:${goal.monthKey}`;

/** True when every goal belongs to the SAME group and the same month. */
const isOneTable = (goals = []) =>
  goals.length > 0 && goals.every((g) => tableKeyOf(g) === tableKeyOf(goals[0]));

module.exports = { mergeGoalOrder, tableKeyOf, isOneTable };
