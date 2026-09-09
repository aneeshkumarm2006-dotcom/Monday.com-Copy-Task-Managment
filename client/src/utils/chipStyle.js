/**
 * HOW A CHIP IS PAINTED, given its palette and which form it is taking.
 *
 * Split out of `Chip.jsx` so the one rule that actually matters can be asserted
 * rather than eyeballed: a FILLED chip carries white text and must therefore
 * paint itself with `deep`, never `solid`. `solid` is a 600-step and only
 * clears 4.5:1 for some hues — the amber and the green fail — so a variant that
 * reached for the wrong one would ship unreadable cells for two of the four
 * statuses and look fine in a screenshot of the other two.
 *
 * ---- THE FOUR FORMS -------------------------------------------------------
 *
 *   pill  the original. Pale tint, coloured text, fully rounded. Still the
 *         default, and still what renders everywhere that is NOT a board table:
 *         My Work, the dashboard, kanban cards, the ledger, the client portal,
 *         notifications. A filled cell only makes sense inside a grid; a
 *         notification that is a solid green rectangle does not.
 *
 *   fill  the colour-first cell. Edge to edge, saturated, white text, centred.
 *         This is the monday.com idea and it is reserved for STATUS, because a
 *         board wants exactly one column that shouts.
 *
 *   tint  pale background, deep text, and a full-strength left edge. For
 *         PRIORITY, which is an ordered scale rather than a membership badge —
 *         the edge makes four of them read as a gauge, and Low goes quiet
 *         instead of holding Critical's weight.
 *
 *   edge  `tint` for somewhere that is not a cell — the priority MENU, where the
 *         same four options are stacked as a scale. Identical colours, but it
 *         sizes to its content instead of filling its parent: `tint` sets
 *         width/height to 100%, which inside an auto-height menu row collapses
 *         to nothing.
 *
 *   tag   light, small, squared-off. For LABELS, which are a taxonomy and must
 *         never out-shout the row's state.
 */

export const CHIP_VARIANTS = ['pill', 'fill', 'tint', 'edge', 'tag'];

/** Which form each family takes inside a board table. */
export const TABLE_VARIANT = {
  status: 'fill',
  priority: 'tint',
  label: 'tag',
};

/**
 * The inline style for one chip.
 *
 * @param {{bg?:string, text?:string, solid?:string, deep?:string}} palette
 * @param {string} variant one of CHIP_VARIANTS
 * @returns {Object} a React style object
 */
export const chipStyle = (palette = {}, variant = 'pill') => {
  const bg = palette.bg || 'transparent';
  const text = palette.text || 'inherit';
  // `deep` is the only value white text may sit on. Falling back to `solid`
  // here would silently reintroduce the contrast failure this whole token
  // exists to remove, so an entry without one falls back to its TEXT colour,
  // which is darker than solid rather than lighter.
  const deep = palette.deep || palette.text || palette.solid || '#4B5563';
  const solid = palette.solid || deep;

  switch (variant) {
    case 'fill':
      return {
        background: deep,
        color: '#FFFFFF',
        borderRadius: 0,
        border: 'none',
        padding: '0 10px',
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontWeight: 600,
        fontSize: 12,
        whiteSpace: 'nowrap',
      };

    case 'tint':
      return {
        background: bg,
        color: deep,
        borderRadius: 0,
        border: 'none',
        borderLeft: `3px solid ${solid}`,
        padding: '0 10px',
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        fontWeight: 700,
        fontSize: 12,
        whiteSpace: 'nowrap',
      };

    case 'edge':
      return {
        background: bg,
        color: deep,
        borderRadius: 4,
        border: 'none',
        borderLeft: `3px solid ${solid}`,
        padding: '4px 9px',
        fontWeight: 600,
        fontSize: 12,
        whiteSpace: 'nowrap',
      };

    case 'tag':
      return {
        background: bg,
        color: deep,
        borderRadius: 4,
        border: 'none',
        padding: '3px 8px',
        fontWeight: 600,
        fontSize: 11,
        whiteSpace: 'nowrap',
      };

    case 'pill':
    default:
      return {
        background: bg,
        color: text,
        borderRadius: 'var(--radius-full)',
        border: 'none',
        padding: '3px 10px',
        fontWeight: 500,
        fontSize: 12,
        whiteSpace: 'nowrap',
      };
  }
};

/** Does this variant paint white type on a filled ground? */
export const isFilled = (variant) => variant === 'fill';
