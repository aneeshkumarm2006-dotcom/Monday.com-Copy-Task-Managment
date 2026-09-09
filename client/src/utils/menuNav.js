/**
 * Filtering and keyboard movement for an option menu.
 *
 * Pure, and separate from the component, because these are the two things that
 * are wrong in ways nobody notices: a search that cannot find the thing you
 * typed, and an arrow key that walks off the end of a list and stops.
 */

/** Below this many options a search box is furniture rather than help. */
export const SEARCH_THRESHOLD = 8;

/**
 * Options whose label matches the query.
 *
 * Case- and whitespace-insensitive substring, not prefix: people search a label
 * called "Meeting Scheduled" by typing "sched" at least as often as "meet".
 * An empty query returns everything rather than nothing.
 */
export const filterOptions = (options, query) => {
  const list = Array.isArray(options) ? options : [];
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return list;
  return list.filter((o) => String(o?.label ?? '').toLowerCase().includes(q));
};

/**
 * Where the highlight goes next.
 *
 * Wraps at both ends, because a menu of four statuses is faster to reach the
 * last of by pressing Up once. Returns 0 for an empty or absent current index,
 * so the first Down on a freshly-opened menu lands on the first option rather
 * than the second.
 *
 * @param {number} current  index now, or -1 when nothing is highlighted
 * @param {number} delta    +1 for Down, -1 for Up
 * @param {number} length   how many options are visible AFTER filtering
 * @returns {number} the next index, or -1 when there is nothing to highlight
 */
export const nextIndex = (current, delta, length) => {
  if (!Number.isFinite(length) || length <= 0) return -1;
  if (!Number.isFinite(current) || current < 0) return delta > 0 ? 0 : length - 1;
  return (((current + delta) % length) + length) % length;
};
