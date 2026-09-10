import { getStatusPalette, STATUS_COLORS } from './priorityColors.js';

/**
 * STATUS SPREAD — how a group's work is distributed, not just how much is done.
 *
 * The group header used to carry an 80x4 progress bar that answered exactly one
 * question: what fraction is done. That is the least useful question you can
 * ask a board of work in flight — it cannot tell you that four of the seven are
 * STUCK, which is the fact you would act on. This returns one segment per
 * status actually present, in the board's own status order, so a single 6px
 * strip answers "where is everything" instead.
 *
 * WORKS ON EVERY BOARD, which is the point:
 *   - template and flexible boards store `task.status` as an ObjectId into
 *     `board.statuses`
 *   - older boards store the legacy enum string ('done', 'stuck', …)
 *   - a personal task can carry the enum on a board that also has statuses
 * All three resolve here, so no caller has to know which kind of board it is
 * looking at.
 */

/** The bucket for rows whose status is missing or points at a deleted status. */
export const UNSET = '__unset__';

/** Order the legacy enum falls back to when a board has no `statuses` array. */
const LEGACY_ORDER = ['not_started', 'working_on_it', 'stuck', 'done'];

const idOf = (v) => (v === null || v === undefined ? null : v.toString());

/**
 * Largest-remainder rounding.
 *
 * Naive `Math.round` on each share leaves the widths summing to 99% or 101%,
 * which shows up as a hairline gap at the end of the bar or a last segment
 * clipped by `overflow: hidden`. Handing out the leftover points to the largest
 * remainders makes them sum to exactly 100 — no gap, at any group size.
 */
const percentages = (counts, total) => {
  if (total <= 0) return counts.map(() => 0);
  const exact = counts.map((c) => (c * 100) / total);
  const floors = exact.map((n) => Math.floor(n));
  let left = 100 - floors.reduce((a, b) => a + b, 0);
  const order = exact
    .map((n, i) => ({ i, rem: n - Math.floor(n) }))
    .sort((a, b) => b.rem - a.rem || a.i - b.i);
  const out = [...floors];
  for (let k = 0; k < order.length && left > 0; k += 1, left -= 1) {
    out[order[k].i] += 1;
  }
  return out;
};

/**
 * `(tasks, board)` → `{ total, doneCount, segments }`.
 *
 * `segments` is `[{ id, name, count, pct, color }]`, empty when there are no
 * tasks — callers render nothing rather than an empty grey rail.
 */
export const statusSpread = (tasks, board) => {
  const rows = Array.isArray(tasks) ? tasks : [];
  const total = rows.length;
  if (total === 0) return { total: 0, doneCount: 0, segments: [] };

  const statuses = Array.isArray(board?.statuses) ? board.statuses : [];
  // `order` is advisory and can repeat or be absent; the array's own order is
  // the tie-break so two statuses never swap places between renders.
  const ordered = statuses
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (a.s.order ?? 0) - (b.s.order ?? 0) || a.i - b.i)
    .map(({ s }) => s);

  const byId = new Map(ordered.map((s) => [idOf(s._id), s]));
  const byKey = new Map(ordered.filter((s) => s.key).map((s) => [String(s.key), s]));

  const counts = new Map();
  const bump = (k) => counts.set(k, (counts.get(k) || 0) + 1);

  rows.forEach((t) => {
    const ref = t?.status;
    if (ref === null || ref === undefined || ref === '') return bump(UNSET);
    const match = byId.get(idOf(ref)) || byKey.get(String(ref));
    if (match) return bump(idOf(match._id));
    // No board status matched. A legacy enum still has a name and a colour, so
    // it gets its own segment rather than being lumped in with "not set".
    if (typeof ref === 'string' && STATUS_COLORS[ref]) return bump(ref);
    return bump(UNSET);
  });

  // Board statuses first, in board order; then any legacy enum that survived
  // the lookup; then the unset bucket, always last because it is the absence
  // of an answer rather than one of the answers.
  const keys = [
    ...ordered.map((s) => idOf(s._id)),
    ...LEGACY_ORDER.filter((k) => !byKey.has(k)),
  ].filter((k) => (counts.get(k) || 0) > 0);
  if ((counts.get(UNSET) || 0) > 0) keys.push(UNSET);

  const nums = keys.map((k) => counts.get(k) || 0);
  const pcts = percentages(nums, total);

  const segments = keys.map((key, i) => {
    if (key === UNSET) {
      return {
        id: UNSET,
        name: 'Not set',
        count: nums[i],
        pct: pcts[i],
        color: 'var(--color-border-strong)',
      };
    }
    const status = byId.get(key);
    const palette = getStatusPalette(board, status ? status._id : key);
    return {
      id: key,
      name: status ? status.name : palette.label,
      count: nums[i],
      pct: pcts[i],
      // `deep` rather than `solid`: these segments sit beside the full-bleed
      // status cells in the table, which are painted `deep` too. One board,
      // one green.
      color: palette.deep,
    };
  });

  // Kept so the header can go on saying "46% done" without a second pass over
  // the same rows. Matches the old `doneCount` exactly: the board's own status
  // whose key is 'done', or the legacy string.
  const doneStatus = ordered.find((s) => s.key === 'done');
  const doneCount = doneStatus
    ? counts.get(idOf(doneStatus._id)) || 0
    : counts.get('done') || 0;

  return { total, doneCount, segments };
};

export default statusSpread;
