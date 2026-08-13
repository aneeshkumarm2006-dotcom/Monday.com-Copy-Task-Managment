/**
 * Who owns a group, in a given month.
 *
 * On a tracker board each group is one client or area, and in practice one
 * person is responsible for it. That responsibility mostly carries forward month
 * to month — but it does change, and when it does, LAST month's numbers must
 * keep pointing at whoever actually held it then. A single `owner` field cannot
 * do that: reassigning a client today would silently rewrite who is credited
 * with March, and every historical scoreboard would become a lie.
 *
 * So ownership is stored as a SPARSE TIMELINE. Each entry says "from this month
 * onward, this person owns this group", and the owner for month M is the LAST
 * entry whose `fromMonth` is <= M. Carry-forward is therefore structural rather
 * than scheduled: set it in March and it holds for April, May and every month
 * after, until a later entry exists. Nothing runs monthly, nothing is
 * materialised, and there is no rollover job that can fail.
 *
 * A `user` of null is a TOMBSTONE, not an absence: "deliberately unassigned from
 * this month onward". Without it you could never un-inherit an owner set in some
 * earlier month.
 *
 * THIS FILE IS THE ONLY RESOLVER, the same way goalTypes.js is the only scorer.
 * The timeline itself never leaves the server — groupController resolves it and
 * ships only the answer for the month asked about, so no client can derive a
 * second, drifting version of the rule.
 *
 * Pure by design, like trackerPeriods.js and goalTypes.js: plain objects in,
 * plain objects out, no mongoose, and NO notion of "what month is it now" —
 * that needs `board.monthTimezone` and belongs to the caller.
 */

const { isMonthKey, compareMonthKeys } = require('./monthKey');

/**
 * Twenty years of monthly churn, for a field that realistically changes once or
 * twice a year. This is not a guess at usage; it is the backstop that keeps the
 * "a row per CHANGE, not a row per month" claim in TaskGroup.js true even when
 * the client misbehaves — `PUT /api/groups/:id` takes an arbitrary month, and
 * without a cap a loop could grow a document that is read on every board load.
 */
const OWNER_TIMELINE_LIMIT = 240;

/** ObjectId | '24-char string' | a populated { _id, name } doc → string | null. */
const idOf = (value) => {
  if (value === null || value === undefined) return null;
  const raw = typeof value === 'object' && value._id !== undefined ? value._id : value;
  if (raw === null || raw === undefined) return null;
  const str = String(raw);
  return str && str !== 'null' && str !== 'undefined' ? str : null;
};

/**
 * Clean a stored timeline into something resolvable: drop malformed entries,
 * normalise ids to strings, sort ascending, and collapse duplicate months.
 *
 * Deliberately tolerant on every axis, because a single bad row must never 500 a
 * board load and because the storage order cannot be trusted — a `$push` without
 * `$sort`, a hand edit in a DB console, or a restored backup all produce an
 * unsorted array, and reading one positionally would silently return the wrong
 * person.
 *
 * DUPLICATE MONTHS are a real state, not a corruption: `updateGroup` is a
 * read-modify-write, so two interleaved saves can both land an entry at the same
 * month. The tiebreak is deterministic — later `setAt` wins, and on a tie the
 * later array position wins — so the resolver has exactly one answer rather than
 * depending on which copy it happened to see first.
 *
 * Exported for its tests. Callers want ownerForMonth / setOwnerForMonth.
 *
 * @param {any} timeline - anything; `undefined` on documents written before the
 *   field existed, which is the common case and must not throw.
 * @returns {Array<{fromMonth: string, user: string|null, setBy: string|null, setAt: Date|null}>}
 */
const normaliseTimeline = (timeline) => {
  if (!Array.isArray(timeline)) return [];

  const clean = [];
  for (let i = 0; i < timeline.length; i++) {
    const entry = timeline[i];
    if (!entry || typeof entry !== 'object') continue;
    if (!isMonthKey(entry.fromMonth)) continue;
    clean.push({
      fromMonth: entry.fromMonth,
      user: idOf(entry.user),
      setBy: idOf(entry.setBy),
      setAt: entry.setAt ? new Date(entry.setAt) : null,
      // Insertion order, kept only to break a tie the timestamps cannot.
      _i: i,
    });
  }

  clean.sort((a, b) => {
    const byMonth = compareMonthKeys(a.fromMonth, b.fromMonth);
    if (byMonth !== 0) return byMonth;
    const at = a.setAt ? a.setAt.getTime() : 0;
    const bt = b.setAt ? b.setAt.getTime() : 0;
    if (at !== bt) return at - bt;
    return a._i - b._i;
  });

  // The sort put the winner of each duplicated month last, so overwriting as we
  // go leaves exactly that one standing.
  const byMonth = new Map();
  for (const entry of clean) byMonth.set(entry.fromMonth, entry);

  return [...byMonth.values()].map(({ _i, ...rest }) => rest);
};

/**
 * The resolved owner of `group` in `monthKey`: the last entry at or before it.
 *
 * Returns four fields rather than two because four states exist and each renders
 * differently. Collapsing the first and last would lose the only way to tell
 * "nobody has ever owned this" from "we deliberately took the owner off in
 * March":
 *
 *   never set     → { userId: null, fromMonth: null }        "Assign"
 *   set at M      → { userId: id,   inherited: false }        plain avatar
 *   set at M' < M → { userId: id,   inherited: true }         muted + "carried forward from…"
 *   tombstone     → { userId: null, fromMonth: M' }           "unassigned since…"
 *
 * `explicit` (an entry sits exactly at `monthKey`) is what tells a caller whether
 * this month is pinned or merely inheriting.
 *
 * There is NO implicit backfill here: a month before the first entry resolves to
 * nobody. Reaching an assignment back to a group's birth month is a policy the
 * WRITER applies once (see groupController), so that reading can never invent an
 * owner who was never recorded.
 *
 * @param {Object} group - a TaskGroup doc or lean object; may lack the field.
 * @param {string} monthKey - 'YYYY-MM'.
 * @returns {{userId: string|null, fromMonth: string|null, inherited: boolean, explicit: boolean}}
 */
const ownerForMonth = (group, monthKey) => {
  const none = { userId: null, fromMonth: null, inherited: false, explicit: false };
  if (!isMonthKey(monthKey)) return none;

  const entries = normaliseTimeline(group?.ownerTimeline);
  if (entries.length === 0) return none;

  let found = null;
  for (const entry of entries) {
    if (compareMonthKeys(entry.fromMonth, monthKey) > 0) break;
    found = entry;
  }
  if (!found) return none;

  return {
    userId: found.user,
    fromMonth: found.fromMonth,
    inherited: found.fromMonth !== monthKey,
    explicit: found.fromMonth === monthKey,
  };
};

/**
 * The next timeline with `monthKey` pinned to `userId`. Never mutates its input.
 *
 * `userId` of null writes a tombstone — "unassigned from here on" — which is a
 * different act from clearOwnerForMonth's "stop pinning this month at all".
 *
 * A redundant pin is KEPT, not optimised away. If March says Alice and you set
 * June to Alice, the June entry stays even though it changes nothing today: it
 * means a later correction to March will not silently propagate through June.
 * Pruning "redundant" entries would make the timeline's future behaviour depend
 * on history nobody can see.
 *
 * `changed: false` when the pin already says exactly this, so the caller can skip
 * the save and a repeat click is a genuine no-op rather than a new `setAt`.
 *
 * @returns {{timeline: Array, changed: boolean}}
 */
const setOwnerForMonth = (timeline, monthKey, userId, byUserId, { at = new Date() } = {}) => {
  const entries = normaliseTimeline(timeline);
  if (!isMonthKey(monthKey)) return { timeline: entries, changed: false };

  const nextUser = idOf(userId);
  const existing = entries.find((e) => e.fromMonth === monthKey);
  if (existing && existing.user === nextUser) return { timeline: entries, changed: false };

  const next = entries.filter((e) => e.fromMonth !== monthKey);
  next.push({ fromMonth: monthKey, user: nextUser, setBy: idOf(byUserId), setAt: at });
  next.sort((a, b) => compareMonthKeys(a.fromMonth, b.fromMonth));

  // Trim from the FRONT: the oldest entries are the ones whose months are least
  // likely to still be looked at, and the entry just written must always survive.
  const trimmed = next.length > OWNER_TIMELINE_LIMIT
    ? next.slice(next.length - OWNER_TIMELINE_LIMIT)
    : next;

  return { timeline: trimmed, changed: true };
};

/**
 * Remove the pin AT `monthKey`, so the month falls back to inheriting from an
 * earlier entry.
 *
 * Distinct from `setOwnerForMonth(..., null)`, which pins "unassigned". The
 * distinction is the one thing about this model people get wrong, so both are
 * named even though only the setter is wired to a route today.
 */
const clearOwnerForMonth = (timeline, monthKey) => {
  const entries = normaliseTimeline(timeline);
  if (!isMonthKey(monthKey)) return { timeline: entries, changed: false };
  const next = entries.filter((e) => e.fromMonth !== monthKey);
  return { timeline: next, changed: next.length !== entries.length };
};

module.exports = {
  OWNER_TIMELINE_LIMIT,
  normaliseTimeline,
  ownerForMonth,
  setOwnerForMonth,
  clearOwnerForMonth,
};
