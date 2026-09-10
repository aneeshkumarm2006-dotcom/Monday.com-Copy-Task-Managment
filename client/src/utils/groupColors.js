/**
 * THE GROUP PALETTE — one source of truth for what colour a group is.
 *
 * A group is the same group whichever view you are looking at, so it has to be
 * the same colour in all of them. Before this, the board view cycled four
 * colours by index while the Stages view painted EVERY column and card with a
 * flat `var(--color-accent)` — the same blue for New Lead, Proposal Sent and
 * Won, on the one view whose whole job is telling stages apart.
 *
 * Hex, not the `--color-card-*` variables these values come from: the group
 * header darkens this colour with `deepFor` to draw the group's name in it, and
 * a CSS variable resolves in the browser long after any JS could measure it.
 */
export const GROUP_COLORS = ['#2563EB', '#16A34A', '#EA580C', '#7C3AED'];

/**
 * Colour for the group at `index` in the board's ORDERED group list.
 *
 * By position rather than by id, so a board's colours read as a sequence down
 * the page instead of a random scatter — and reordering groups re-cycles them
 * rather than leaving two greens adjacent.
 *
 * A negative or non-integer index cannot produce `undefined` here; JS's `%`
 * keeps the sign of its left operand, and an undefined colour would render as
 * a transparent stripe rather than an obvious mistake.
 */
export const groupColorAt = (index) => {
  const n = Number.isFinite(index) ? Math.trunc(index) : 0;
  const len = GROUP_COLORS.length;
  return GROUP_COLORS[((n % len) + len) % len];
};

export default groupColorAt;
