/**
 * WHERE AN ANCHORED POPOVER GOES — the arithmetic behind `ui/AnchoredPopover`.
 *
 * Pure, so the rules a person actually notices ("it opened off the bottom of
 * the screen", "it hid its own Delete button") are reachable from `node --test`
 * rather than only from a browser.
 *
 * ---- Why a popover is placed in the VIEWPORT, not inside its cell ----------
 *
 * The board grid is a horizontal scroll container (`overflow-x: auto`, which
 * per the CSS spec makes overflow-y auto too) inside a group card that is
 * `overflow: hidden`. A menu positioned `absolute` under a header cell is
 * clipped to the grid's in-flow height, so on a group with one invoice the
 * column menu's Currency / Summary / Delete were cut off and reachable only by
 * wheel-scrolling inside a 110px grid. A `position: fixed` box rendered in a
 * portal has no clipping ancestor, so it is placed against the viewport — and
 * that makes the placement this file's job.
 */

/** Clamp `n` into [lo, hi]; when the range is inverted (a tiny viewport), `lo` wins. */
const clamp = (n, lo, hi) => Math.max(lo, Math.min(n, hi));

/**
 * The fixed-position box for a popover of `size` hanging off `anchor`.
 *
 *   anchor    the trigger's `getBoundingClientRect()` (top/left/right/bottom)
 *   size      the popover's NATURAL size — its content height, not whatever
 *             max-height it is currently squeezed to, or it could never grow
 *   viewport  `{ width, height }` — `window.innerWidth/innerHeight`
 *   align     'start' lines the popover's left edge up with the anchor's;
 *             'end' lines up the right edges (a menu off a trailing ⋯)
 *   gap       space between the anchor and the popover
 *   margin    the popover never comes closer than this to a viewport edge
 *   maxHeight a cap on the popover's height whatever the room
 *
 * Returns `{ top, left, width, maxHeight, placement }`. `maxHeight` is the room
 * actually available on the chosen side: a popover taller than that scrolls
 * INSIDE itself rather than running off the screen.
 *
 * ---- When it flips ---------------------------------------------------------
 *
 * Below is the default — it is where a person's eye already is. It flips above
 * only when the popover does not fit below AND there is more room above. "Does
 * not fit" alone is not enough: a trigger near the top of a short window has
 * even less room above, and flipping there trades a scrollable popover for a
 * clipped one.
 */
export const placePopover = ({
  anchor,
  size,
  viewport,
  align = 'start',
  gap = 4,
  margin = 8,
  maxHeight = Infinity,
}) => {
  const a = anchor || { top: 0, left: 0, right: 0, bottom: 0 };
  const vw = Math.max(0, viewport?.width || 0);
  const vh = Math.max(0, viewport?.height || 0);

  const natural = Math.min(Math.max(0, size?.height || 0), maxHeight);
  const roomBelow = vh - a.bottom - gap - margin;
  const roomAbove = a.top - gap - margin;
  const flip = natural > roomBelow && roomAbove > roomBelow;
  const room = Math.max(0, flip ? roomAbove : roomBelow);
  const height = Math.min(natural, room);

  const top = flip
    ? clamp(a.top - gap - height, margin, vh - margin)
    : clamp(a.bottom + gap, margin, Math.max(margin, vh - margin - height));

  // Never wider than the viewport allows — on a phone a 280px popover is most
  // of the screen, and one wider than it would be clipped on both sides.
  const width = Math.min(Math.max(0, size?.width || 0), Math.max(0, vw - margin * 2));
  const preferred = align === 'end' ? a.right - width : a.left;
  const left = clamp(preferred, margin, vw - margin - width);

  return { top, left, width, maxHeight: height, placement: flip ? 'top' : 'bottom' };
};

/**
 * Is the anchor entirely outside the viewport?
 *
 * A popover follows its trigger as the page scrolls. Once the trigger has left
 * the screen there is nothing left for it to point at, and a menu floating over
 * unrelated rows is worse than one that closed.
 */
export const anchorOffscreen = (anchor, viewport) =>
  !anchor ||
  anchor.bottom <= 0 ||
  anchor.right <= 0 ||
  anchor.top >= (viewport?.height || 0) ||
  anchor.left >= (viewport?.width || 0);

/**
 * Does `inner` lie entirely outside `outer`?
 *
 * The same question as `anchorOffscreen`, asked of a clipping ancestor: a
 * header cell scrolled out of the grid's horizontal scroll area is still "on
 * screen" by viewport coordinates, but it is hidden, and so should its menu be.
 */
export const rectOutside = (inner, outer) =>
  !inner ||
  !outer ||
  inner.right <= outer.left ||
  inner.left >= outer.right ||
  inner.bottom <= outer.top ||
  inner.top >= outer.bottom;
