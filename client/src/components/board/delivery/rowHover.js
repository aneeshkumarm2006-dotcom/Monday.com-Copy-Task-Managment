/**
 * The row-hover band for the delivery grid — one definition shared by the sticky
 * name column (DeliveryGrid) and every cell track (DeliveryCell), which is the
 * only reason it is its own module rather than a constant next to its consumer.
 *
 * It is drawn in the warm neutral of the page chrome, NOT in the accent. Blue is
 * load-bearing everywhere else in this view — the accent marks the hovered
 * column header, the focus ring and every link — so tinting the row with it made
 * a passive pointer position look like a selection. `--color-bg-subtle` is the
 * token the design system already reserves for "hover rows", and being a neutral
 * it sits under the green/amber/red cells without competing with a single one.
 *
 * The band across the cells is a VERTICAL fade on purpose. A horizontal one is
 * the obvious first idea and it cannot work here: the row is up to 26 separate
 * track elements, so a left-to-right gradient would restart inside every column
 * and read as stripes. An identical top-to-bottom fade tiles seamlessly, so the
 * row paints as one continuous wash however many periods are on screen.
 *
 * The sticky name column is the one place a horizontal fade IS safe — it is a
 * single element — so it carries the strong end of the gradient and hands off to
 * the band, pulling the eye to the client name the row belongs to. Its stops are
 * mixed over the surface colour rather than `transparent` because that cell
 * scrolls across the grid and must stay opaque at rest AND at full fade.
 *
 * The hairlines are what make this "clearer" rather than merely "prettier" — a
 * wash alone is ambiguous on a row of mostly empty squares; two edges are not.
 *
 * These values are consumed as CSS custom properties by `.macan-row-wash` in
 * globals.css, which owns the fade itself. See the comment there for why the
 * transition cannot live on `background-image` where these are defined.
 */

const wash = (pct, over = 'transparent') =>
  `color-mix(in srgb, var(--color-bg-subtle) ${pct}%, ${over})`;

const edge = (pct) => `color-mix(in srgb, var(--color-border-strong) ${pct}%, transparent)`;

/** Cell tracks — tiles across the row with no seam. */
export const ROW_HOVER_BAND = `linear-gradient(180deg, ${wash(92)} 0%, ${wash(48)} 100%)`;

/** Sticky name column — the strong end, opaque. */
export const NAME_COL_HOVER = `linear-gradient(90deg, ${wash(100, 'var(--color-bg-surface)')} 0%, `
  + `${wash(72, 'var(--color-bg-surface)')} 100%)`;

export const ROW_HOVER_EDGE = `inset 0 1px 0 ${edge(55)}, inset 0 -1px 0 ${edge(55)}`;

/**
 * Slower than a button's hover because this band is ~740px of moving colour
 * rather than a 24px square, and eased out so it arrives gently and settles —
 * the pointer is already over the next cell by the time it finishes. Kept in
 * step with the opacity fade in `.macan-row-wash`.
 */
export const HOVER_EASE = 'cubic-bezier(0.22, 0.61, 0.36, 1)';
export const HOVER_MS = 180;

/** The style props every washed element carries; the class does the rest. */
export const washVars = (image) => ({
  '--row-wash-image': image,
  '--row-wash-edge': ROW_HOVER_EDGE,
});
