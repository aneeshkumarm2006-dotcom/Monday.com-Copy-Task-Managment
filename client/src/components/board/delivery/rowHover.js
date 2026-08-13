/**
 * The row-hover band for the delivery grid — one definition shared by the sticky
 * name column (DeliveryGrid) and every cell track (DeliveryCell), which is the
 * only reason it is its own module rather than a constant next to its consumer.
 *
 * The band across the cells is a VERTICAL fade on purpose. A horizontal one is
 * the obvious first idea and it cannot work here: the row is up to 26 separate
 * track elements, so a left-to-right gradient would restart inside every column
 * and read as stripes. An identical top-to-bottom fade tiles seamlessly, so the
 * row paints as one continuous wash however many periods are on screen.
 *
 * The sticky name column is the one place a horizontal fade IS safe — it is a
 * single element — so it carries the strong end of the gradient and hands off to
 * the flat band, pulling the eye to the client name the row belongs to. It is
 * mixed over the surface colour rather than `transparent` because that cell
 * scrolls across the grid: anything translucent would show cells sliding under.
 *
 * The hairlines are what make this "clearer" rather than merely "prettier" — a
 * tint alone is ambiguous on a row of mostly empty squares; two edges are not.
 */

export const tint = (pct, over = 'transparent') =>
  `color-mix(in srgb, var(--color-accent) ${pct}%, ${over})`;

/** Cell tracks — tiles across the row with no seam. */
export const ROW_HOVER_BAND = `linear-gradient(180deg, ${tint(14)} 0%, ${tint(5)} 100%)`;

/** Sticky name column — the strong end, opaque. */
export const NAME_COL_HOVER = `linear-gradient(90deg, ${tint(16, 'var(--color-bg-surface)')} 0%, `
  + `${tint(6, 'var(--color-bg-surface)')} 100%)`;

export const ROW_HOVER_EDGE = `inset 0 1px 0 ${tint(20)}, inset 0 -1px 0 ${tint(20)}`;

export const ROW_HOVER_TRANSITION = 'background 130ms ease, box-shadow 130ms ease';
