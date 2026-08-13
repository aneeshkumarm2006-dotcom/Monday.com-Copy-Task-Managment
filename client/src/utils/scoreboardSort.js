/**
 * Row ordering for the People tab.
 *
 * Client-side because the payload is one row per person — tens, not thousands —
 * and because a server-side `?sort=missed` would have to fail or silently fall
 * back whenever the delivery half is withheld. The server still emits the
 * default order and stamps `rank`, so a page nobody has touched shows a correct
 * leaderboard and the rank badge always means one fixed thing: standing by
 * score, not by whatever column is currently sorted.
 *
 * TWO RULES every comparator here obeys:
 *   1. `null` sorts LAST regardless of direction. No score and unknown delivery
 *      are absences, not zeroes, and "worst first" must never put a blank row on
 *      top of the page.
 *   2. The Unassigned row is never sorted — the caller appends it afterwards. It
 *      is not a person and does not compete.
 */

const nullsLast = (a, b, dir) => {
  const aHas = typeof a === 'number';
  const bHas = typeof b === 'number';
  if (aHas && bHas) return dir === 'desc' ? b - a : a - b;
  if (aHas !== bHas) return aHas ? -1 : 1;
  return 0;
};

const byName = (a, b) =>
  String(a.user?.name || '').localeCompare(String(b.user?.name || ''));

export const SORT_OPTIONS = [
  {
    value: 'score',
    label: 'Goal score',
    // The product's own score: what ScoreRing draws and scoreBoard produces. It
    // is size-normalised, so it ranks performance rather than workload — a raw
    // "goals achieved" count would put whoever owns the most clients on top by
    // arithmetic alone.
    compare: (a, b) => nullsLast(a.goals?.pct, b.goals?.pct, 'desc') || byName(a, b),
  },
  {
    value: 'achieved',
    label: 'Goals achieved',
    compare: (a, b) =>
      (b.goals?.counts?.achieved || 0) - (a.goals?.counts?.achieved || 0) || byName(a, b),
  },
  {
    value: 'missed',
    label: 'Missed deliveries',
    // Descending: this one is a worst-first list on purpose. It is also why the
    // table is not sorted this way by DEFAULT — a leaderboard whose first row
    // means "worst" reads as a shaming board.
    compare: (a, b) => nullsLast(a.delivery?.missed, b.delivery?.missed, 'desc') || byName(a, b),
  },
  {
    value: 'kept',
    label: 'Commitments kept',
    compare: (a, b) => nullsLast(a.delivery?.keptPct, b.delivery?.keptPct, 'desc') || byName(a, b),
  },
  { value: 'name', label: 'Name (A–Z)', compare: byName },
];

/** Sort a copy of `people`. Unknown keys fall back to the server's own order. */
export const sortPeople = (people = [], sortKey = 'score') => {
  const option = SORT_OPTIONS.find((o) => o.value === sortKey);
  if (!option) return [...people];
  return [...people].sort(option.compare);
};

/** Which sorts are meaningless when the caller cannot see delivery numbers. */
export const availableSorts = (hasDelivery) =>
  SORT_OPTIONS.filter((o) => hasDelivery || (o.value !== 'missed' && o.value !== 'kept'));
