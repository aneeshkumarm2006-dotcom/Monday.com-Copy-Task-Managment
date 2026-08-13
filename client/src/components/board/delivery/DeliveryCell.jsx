import { memo, useCallback } from 'react';
import { cellStateMeta, requirementMeta } from '../../../utils/deliveryTrackers';
import { ROW_HOVER_BAND, washVars } from './rowHover';

/**
 * One square in the delivery grid.
 *
 * memo'd and given only primitives plus stable callbacks: a 20x26 grid is 520 of
 * these, and the hover crosshair deliberately lives on the row/column headers so
 * that moving the mouse re-renders two nodes rather than all of them.
 *
 * Encoding is three redundant channels — fill, glyph and border style — so the
 * grid stays readable without colour. See CELL_STATES in utils/deliveryTrackers.
 */

/** "Partial: task created, no update posted" — the tooltip and the aria-label. */
const describeCellOutcome = (cell, targetCount) => {
  const meta = cellStateMeta(cell.s);
  if (cell.s === 'off') return 'Day off';
  if (cell.s === 'na') return 'Not tracked in this period';
  if (cell.s === 'excused') return `Excused${cell.entry?.note ? ` — ${cell.entry.note}` : ''}`;

  const bits = [];
  if (targetCount > 1) bits.push(`${cell.n} of ${targetCount}`);
  if (cell.missing?.length > 0) {
    const names = cell.missing.map((r) => requirementMeta(r)?.short).filter(Boolean);
    if (names.length > 0) bits.push(`missing ${names.join(' and ')}`);
  }
  if (cell.s === 'met' && bits.length === 0) return meta.label;
  return bits.length > 0 ? `${meta.label}: ${bits.join(', ')}` : meta.label;
};

const DeliveryCell = ({
  cell,
  period,
  groupName,
  targetCount,
  density,
  row,
  col,
  isFocused,
  rowHovered,
  onActivate,
  onFocus,
  onHover,
  registerRef,
}) => {
  // The grid hands down stable callbacks plus this cell's coordinates; binding
  // them here keeps the memo intact (see the note on the callbacks in the grid).
  const handleRef = useCallback((node) => registerRef(row, col, node), [registerRef, row, col]);
  const handleFocus = useCallback(() => onFocus(row, col), [onFocus, row, col]);
  const handleHover = useCallback(() => onHover(row, col), [onHover, row, col]);
  const handleActivate = useCallback(
    (e) => onActivate(row, col, e.currentTarget),
    [onActivate, row, col],
  );

  const meta = cellStateMeta(cell.s);
  const Glyph = meta.glyph;
  const outcome = describeCellOutcome(cell, targetCount);
  const title = `${groupName} — ${period.ariaLabel} — ${outcome}`;
  const showCount = targetCount > 1 && cell.s !== 'off' && cell.s !== 'na';

  // The wash itself is `.macan-row-wash::before`, fading its opacity; all this
  // has to do is name the gradient and say whether the row is under the pointer.
  const trackProps = {
    className: 'macan-row-wash flex items-center justify-center',
    'data-row-hovered': rowHovered ? 'true' : 'false',
    style: { height: density.rowH, ...washVars(ROW_HOVER_BAND) },
  };

  // Nothing was due, so there is nothing to open. A non-interactive div keeps
  // these out of the tab order and out of arrow-key navigation.
  if (cell.s === 'off' || cell.s === 'na') {
    return (
      <div
        role="gridcell"
        aria-label={`${groupName} — ${period.ariaLabel} — ${outcome}`}
        title={title}
        {...trackProps}
      >
        <span
          aria-hidden="true"
          style={{
            width: 3,
            height: 3,
            borderRadius: '50%',
            background: cell.s === 'off' ? 'var(--color-border-strong)' : 'var(--color-border)',
          }}
        />
      </div>
    );
  }

  const background =
    meta.pattern === 'half'
      ? 'linear-gradient(135deg, var(--color-status-working) 0 50%,'
        + ' var(--color-status-working-bg) 50% 100%)'
      : meta.fill;

  return (
    <div role="gridcell" {...trackProps}>
      <button
        ref={handleRef}
        type="button"
        tabIndex={isFocused ? 0 : -1}
        aria-label={title}
        title={title}
        onClick={handleActivate}
        onFocus={handleFocus}
        onMouseEnter={handleHover}
        className="flex items-center justify-center font-body transition-shadow duration-100"
        style={{
          width: density.cell,
          height: density.cell,
          padding: 0,
          borderRadius: 'var(--radius-sm)',
          background,
          border:
            meta.border === 'transparent'
              ? '1.5px solid transparent'
              : `1.5px ${meta.pattern === 'dashed' ? 'dashed' : 'solid'} ${meta.border}`,
          color: meta.ink,
          fontSize: 10,
          fontWeight: 700,
          lineHeight: 1,
          cursor: 'pointer',
          boxShadow: isFocused ? '0 0 0 2px var(--color-accent)' : 'none',
        }}
      >
        {showCount ? cell.n : Glyph && (
          <Glyph size={density.cell >= 24 ? 12 : 10} strokeWidth={3} aria-hidden="true" />
        )}
      </button>
    </div>
  );
};

export default memo(DeliveryCell);
