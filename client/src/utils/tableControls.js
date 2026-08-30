/**
 * The arithmetic behind a sortable, paged table.
 *
 * Two functions, both pure, both lifted out of the components that use them
 * (`ui/SortableTh.jsx`, `ui/Pagination.jsx`) for two reasons: a component file
 * that also exports helpers breaks fast refresh, and — the one that matters —
 * "the pager keeps its width" and "the third click clears the sort" are
 * properties worth asserting without a DOM.
 */

/**
 * The three-click sort cycle: asc → desc → OFF.
 *
 * ---- Why the third state is not optional ------------------------------------
 *
 * A table's UNSORTED order is meaningful. On a rank table it is the order the
 * keywords were authored in, which is the order a person typed them; on the
 * board it is the order rows were dragged into. A two-state toggle makes that
 * order unreachable the moment anything is clicked, and there is no other
 * control that brings it back.
 *
 * The same contract as `goalSort.js`'s `nextGoalSort`, which is where the board
 * settled it first. If the two ever disagree, this one is wrong.
 *
 * @param {{key: string|null, dir: 'asc'|'desc'}} current
 * @param {string} nextKey
 * @returns {{key: string|null, dir: 'asc'|'desc'}}
 */
export const nextSort = (current, nextKey) => {
  if (current.key !== nextKey) return { key: nextKey, dir: 'asc' };
  if (current.dir === 'asc') return { key: nextKey, dir: 'desc' };
  return { key: null, dir: 'asc' };
};

/** How many numbered buttons sit between the ellipses. Odd, so it centres. */
export const PAGE_WINDOW = 5;

/**
 * The page numbers to render, with `null` standing for an ellipsis.
 *
 * ---- The property this is written for ---------------------------------------
 *
 * THE NUMBER OF NUMBERED BUTTONS NEVER CHANGES. First page, last page, and a
 * fixed-size window around the current one — so paging through does not resize
 * the control under the cursor. The natural implementation (slice a window
 * around the current page and let it clip at the ends) fails exactly here: near
 * page 1 or page N the window is short, so the count drops and every button
 * shifts.
 *
 * The re-anchoring line below is what stops it. What DOES vary is the ellipsis
 * count — one at an end, two in the middle — because an ellipsis marking a gap
 * of zero pages would be a lie about what is hidden.
 *
 * @param {number} page      - 1-based, already clamped
 * @param {number} pageCount
 * @returns {Array<number|null>}
 */
export const pageSlots = (page, pageCount) => {
  if (pageCount <= PAGE_WINDOW + 2) {
    return Array.from({ length: pageCount }, (_, i) => i + 1);
  }

  const half = Math.floor(PAGE_WINDOW / 2);
  let start = Math.max(2, page - half);
  const end = Math.min(pageCount - 1, start + PAGE_WINDOW - 1);
  // Re-anchor when the window ran into the end, so it keeps its width.
  start = Math.max(2, end - PAGE_WINDOW + 1);

  const slots = [1];
  if (start > 2) slots.push(null);
  for (let i = start; i <= end; i += 1) slots.push(i);
  if (end < pageCount - 1) slots.push(null);
  slots.push(pageCount);
  return slots;
};
