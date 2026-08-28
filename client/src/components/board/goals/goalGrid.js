/**
 * The Goals table's column geometry, in one place.
 *
 * The header row and every goal row are separate CSS grids stacked inside one
 * horizontal scroller, so their track lists — and the pixel offsets of the
 * frozen columns — have to come from the same numbers or the columns drift
 * apart the moment anything changes. This module is that single source.
 *
 * Column ORDER is deliberate: name, then the board's own extra columns, and
 * only then Start / Target / Actual / Result. The extras describe the goal
 * ("channel", "who asked for it"), so they belong beside its name — parked past
 * the scoring block, the only way to read one was to scroll the name it belongs
 * to off the left edge of the screen.
 *
 * The name and the row actions are FROZEN for the same reason: on a board with
 * several extra columns the table is wider than the viewport, and a number you
 * cannot attribute to a goal is not information.
 */

const GUTTER_W = 26;
const NAME_W = 180;
/**
 * The frozen actions column, which is only ever as wide as it has buttons.
 *
 * 84px fits three 22px buttons — move, edit, delete — plus their gaps and the
 * cell's own padding. Someone who can only report numbers gets none of them, so
 * they keep the narrower column rather than paying 28px of frozen dead space
 * out of the horizontal budget the scoring block is already fighting for.
 *
 * The width is ADDITIVE per button rather than two magic totals, because there
 * are now three separate permissions deciding what lands in this cell and a
 * single number per case would have to be re-derived every time one is added.
 */
const ACTIONS_W = { manage: 84, view: 30 };
/**
 * The link button is its own 26px because it is a DIFFERENT permission from the
 * other three: pointing a goal at a keyword is `connector.manage`, while
 * editing, deleting and moving are `goal.manage`. On a board with no connector
 * nobody has it, and the column stays exactly the width it was — which is the
 * point of paying for it per-board rather than always.
 */
const LINK_BTN_W = 26;
/**
 * History is the one button in this cell EVERYONE gets — it opens a read-only
 * panel over rows they can already see, so there is no capability to gate it on.
 * Always paid for, which is why it is not conditional here.
 */
const HISTORY_BTN_W = 26;
const actionsWidth = (canManage, canLink = false) =>
  (canManage ? ACTIONS_W.manage : ACTIONS_W.view)
  + (canLink ? LINK_BTN_W : 0)
  + HISTORY_BTN_W;

/**
 * The full `grid-template-columns` for a table with these extra columns.
 *
 * Every track is deliberately mean with its minimum. Three extra columns at the
 * old widths pushed Start/Target/Actual clean off a 1280px screen — which is
 * only the original complaint (the name scrolling away) pointed the other way.
 * A goal's own numbers are the point of the table, so they are what has to
 * survive the squeeze; the extras get a floor that fits a five-figure number and
 * a share of the slack, not a share of the whole row.
 */
// Start and Target carry a sort arrow beside a six-letter heading; at 78px
// "TARGET" truncated to "TARG…" the moment the column became clickable.
const FIXED_W = { start: 86, target: 86, actual: 92, result: 168 };

const extraW = (c) => Math.max(92, Math.min(c.width || 116, 220));

export const buildGoalGrid = (columns = [], canManage = true, canLink = false) => [
  `${GUTTER_W}px`,                       // flag gutter (frozen)
  `minmax(${NAME_W}px, 1.15fr)`,         // goal name (frozen)
  ...columns.map((c) => `minmax(${extraW(c)}px, 0.7fr)`),
  `${FIXED_W.start}px`,
  `${FIXED_W.target}px`,
  `${FIXED_W.actual}px`,
  `minmax(${FIXED_W.result}px, 1.1fr)`,
  `${actionsWidth(canManage, canLink)}px`, // row actions (frozen)
].join(' ');

/**
 * The table's own min-width, as a NUMBER of pixels — deliberately not
 * `max-content`.
 *
 * `min-width: max-content` sizes every track to its longest cell, so one goal
 * named "quarter pound of something long enough to truncate" widened the name
 * column to fit that sentence and shoved the scoring off the right edge, on a
 * table that had room for all of it. Sizing to the declared minimums instead
 * makes the grid fill the space when it fits and scroll only when it genuinely
 * cannot — and the long name simply truncates, which is what `truncate` on it
 * was always for.
 */
export const goalGridMinWidth = (columns = [], canManage = true, canLink = false) =>
  GUTTER_W + NAME_W + actionsWidth(canManage, canLink)
  + FIXED_W.start + FIXED_W.target + FIXED_W.actual + FIXED_W.result
  + columns.reduce((sum, c) => sum + extraW(c), 0);

/**
 * Extra-column headings sit over cells the shared registry right-aligns, so the
 * heading follows the number rather than floating away from it.
 */
export const headerAlignFor = (type) =>
  (type === 'number' || type === 'formula' ? 'flex-end' : 'flex-start');

/**
 * Frozen-column styles. Sticky cells must paint their own background or the
 * scrolled content slides visibly underneath them, so every caller pairs these
 * with `frozenBg` (header) or the `group-hover` classes below (rows).
 */
export const stickyGutter = { position: 'sticky', left: 0, zIndex: 2 };
export const stickyName = {
  position: 'sticky',
  left: GUTTER_W,
  zIndex: 2,
  // The soft edge is load-bearing: when the table is wider than the screen the
  // middle columns pass UNDER these cells, and without a shadow that reads as a
  // clipped, broken cell rather than as a column held in place.
  boxShadow: '6px 0 8px -8px rgba(0, 0, 0, 0.35)',
};
export const stickyActions = {
  position: 'sticky',
  right: 0,
  zIndex: 2,
  boxShadow: '-6px 0 8px -8px rgba(0, 0, 0, 0.35)',
};

/**
 * The two rules that split the table into its three readable bands:
 * [ goal + what describes it ] | [ what it promised and what happened ].
 */
export const bandEdgeLeft = { borderLeft: '1px solid var(--color-border)' };
export const bandEdgeRight = { borderRight: '1px solid var(--color-border)' };

/** Applied to sticky cells so the scrolled body cannot show through them. */
export const FROZEN_CELL_CLASS =
  'bg-[color:var(--color-bg-surface)] group-hover:bg-[color:var(--color-bg-subtle)]';
