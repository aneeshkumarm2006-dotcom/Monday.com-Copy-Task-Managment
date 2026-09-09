/**
 * Mapping of task priority and status values to their background/text colors.
 * Colors are pulled from the CSS custom properties defined in globals.css
 * (see Macan_Design.md Section 2).
 */

export const PRIORITY_COLORS = {
  critical: {
    bg: '#FEF2F2',
    text: '#DC2626',
    solid: '#DC2626',
    // `deep` is the fill for a colour-first cell: dark enough that WHITE text
    // on it clears 4.5:1. `solid` is a 600-step and only clears it for some
    // hues, so the two cannot be the same value — see `deepFor`.
    deep: '#B91C1C',
    label: 'Critical',
  },
  high: {
    bg: '#FFF7ED',
    text: '#EA580C',
    solid: '#EA580C',
    deep: '#C2410C',
    label: 'High',
  },
  medium: {
    bg: '#FFFBEB',
    text: '#D97706',
    solid: '#D97706',
    deep: '#B45309',
    label: 'Medium',
  },
  low: {
    bg: '#F3F4F6',
    text: '#6B7280',
    solid: '#6B7280',
    deep: '#4B5563',
    label: 'Low',
  },
};

/**
 * Legacy status palette — used for personal tasks (which don't have a board)
 * and as a fallback during the Phase 2 migration period for any board task
 * whose `status` is still the old enum string.
 */
export const STATUS_COLORS = {
  done: {
    bg: 'var(--color-status-done-bg)',
    text: 'var(--color-status-done)',
    solid: '#16A34A',
    deep: '#15803D',
    label: 'Done',
  },
  working_on_it: {
    bg: 'var(--color-status-working-bg)',
    text: 'var(--color-status-working)',
    solid: '#D97706',
    deep: '#B45309',
    label: 'Working on it',
  },
  stuck: {
    bg: 'var(--color-status-stuck-bg)',
    text: 'var(--color-status-stuck)',
    solid: '#DC2626',
    deep: '#B91C1C',
    label: 'Stuck',
  },
  not_started: {
    bg: 'var(--color-status-notstarted-bg)',
    text: 'var(--color-status-notstarted)',
    solid: '#6B7280',
    deep: '#4B5563',
    label: 'Not Started',
  },
};

export const getPriorityColor = (priority) =>
  PRIORITY_COLORS[priority] || PRIORITY_COLORS.low;

export const getStatusColor = (status) =>
  STATUS_COLORS[status] || STATUS_COLORS.not_started;

/**
 * Parse a `#RRGGBB` (or `#RGB`) hex string into `{ r, g, b }` (0-255).
 */
const parseHex = (hex) => {
  if (typeof hex !== 'string') return null;
  let value = hex.trim().replace(/^#/, '');
  if (value.length === 3) {
    value = value
      .split('')
      .map((c) => c + c)
      .join('');
  }
  if (!/^[0-9a-fA-F]{6}$/.test(value)) return null;
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
};

const toHex = ({ r, g, b }) =>
  '#' +
  [r, g, b]
    .map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0'))
    .join('');

const lighten = ({ r, g, b }, amount) => ({
  r: r + (255 - r) * amount,
  g: g + (255 - g) * amount,
  b: b + (255 - b) * amount,
});

const darken = ({ r, g, b }, amount) => ({
  r: r * (1 - amount),
  g: g * (1 - amount),
  b: b * (1 - amount),
});

/**
 * WCAG relative luminance, and the contrast a colour has against WHITE TEXT.
 *
 * Needed because the colour-first cell puts white type on a filled background,
 * and a label's colour is chosen by whoever made the label — so "is this dark
 * enough to write on" cannot be answered by picking values by hand. It has to
 * be computed, per colour, every time.
 */
const relativeLuminance = ({ r, g, b }) => {
  const channel = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

/** Contrast ratio of white text on this colour. 1 is invisible, 21 is black. */
export const whiteTextContrast = (hex) => {
  const rgb = parseHex(hex);
  if (!rgb) return 0;
  // White's relative luminance is 1, so the ratio is (1 + 0.05) / (L + 0.05).
  return 1.05 / (relativeLuminance(rgb) + 0.05);
};

/** The floor. AA for normal-size text; chip labels are small and bold. */
export const MIN_WHITE_CONTRAST = 4.5;

/**
 * The darkest-enough version of a colour, for a cell that carries white text.
 *
 * Darkens in small steps until white clears 4.5:1, then stops — so a colour
 * that already passes is returned untouched and one that does not is nudged the
 * least distance that fixes it. This is what lets a person pick any label
 * colour they like without being able to produce an unreadable chip.
 *
 * monday.com does not do this, and it is the single thing about their board
 * worth not copying: white on their `#FDAB3D` is about 2.3:1.
 */
export const deepFor = (hex) => {
  const rgb = parseHex(hex);
  if (!rgb) return PRIORITY_COLORS.low.deep;
  let current = rgb;
  // 24 steps of 4% bottoms out near black, which is far past any real colour.
  for (let i = 0; i < 24; i += 1) {
    if (1.05 / (relativeLuminance(current) + 0.05) >= MIN_WHITE_CONTRAST) break;
    current = darken(current, 0.04);
  }
  return toHex(current);
};

/**
 * Given a user-defined hex color, return a `{ bg, text, solid }` triple
 * suitable for rendering a chip background + readable foreground text.
 *
 * - `bg`    = 90% lightened toward white (pastel surface for the chip)
 * - `text`  = 20% darkened toward black  (high-contrast label color)
 * - `solid` = the original hex
 * - `deep`  = darkened until WHITE text on it clears 4.5:1 (the filled cell)
 */
export const getColorPair = (hex) => {
  const rgb = parseHex(hex);
  if (!rgb) {
    return {
      bg: PRIORITY_COLORS.low.bg,
      text: PRIORITY_COLORS.low.text,
      solid: PRIORITY_COLORS.low.solid,
      deep: PRIORITY_COLORS.low.deep,
    };
  }
  const solid = toHex(rgb);
  return {
    bg: toHex(lighten(rgb, 0.9)),
    text: toHex(darken(rgb, 0.2)),
    solid,
    deep: deepFor(solid),
  };
};

/**
 * Lightweight alias used by call sites that only need `{ bg, text }`.
 */
export const hexToPair = (hex) => {
  const { bg, text } = getColorPair(hex);
  return { bg, text };
};

const findById = (collection, id) => {
  if (!Array.isArray(collection) || id == null) return null;
  const target = id.toString();
  return collection.find((c) => c && c._id && c._id.toString() === target) || null;
};

/**
 * Resolve `{ bg, text, label, solid }` for a board status reference.
 *
 * `statusRef` may be:
 *   - an ObjectId / ObjectId-string referencing `board.statuses._id`
 *   - a legacy enum key string (`'done'`, etc.) — falls back to STATUS_COLORS
 *
 * Returns the legacy `not_started` palette if nothing matches, so callers
 * never have to null-check.
 */
export const getStatusPalette = (board, statusRef) => {
  if (board && Array.isArray(board.statuses)) {
    const match = findById(board.statuses, statusRef);
    if (match) {
      const pair = getColorPair(match.color);
      return { bg: pair.bg, text: pair.text, solid: pair.solid, deep: pair.deep, label: match.name };
    }
  }
  // Fallback to the legacy enum palette.
  if (typeof statusRef === 'string' && STATUS_COLORS[statusRef]) {
    const entry = STATUS_COLORS[statusRef];
    return { bg: entry.bg, text: entry.text, solid: entry.solid, deep: entry.deep, label: entry.label };
  }
  const fallback = STATUS_COLORS.not_started;
  return {
    bg: fallback.bg,
    deep: fallback.deep,
    text: fallback.text,
    solid: fallback.solid,
    label: fallback.label,
  };
};

/**
 * Resolve `{ bg, text, label, solid }` for a board label reference.
 */
export const getLabelPalette = (board, labelRef) => {
  const match = findById(board?.labels, labelRef);
  if (!match) {
    return {
      bg: PRIORITY_COLORS.low.bg,
      text: PRIORITY_COLORS.low.text,
      solid: PRIORITY_COLORS.low.solid,
      deep: PRIORITY_COLORS.low.deep,
      label: '',
    };
  }
  const pair = getColorPair(match.color);
  return { bg: pair.bg, text: pair.text, solid: pair.solid, deep: pair.deep, label: match.name };
};

export default PRIORITY_COLORS;
