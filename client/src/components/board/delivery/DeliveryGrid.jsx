import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DeliveryCell from './DeliveryCell';
import { HOVER_EASE, HOVER_MS, NAME_COL_HOVER, washVars } from './rowHover';

/**
 * The delivery matrix: clients down, periods across.
 *
 * IT NEVER INSPECTS CADENCE. The server hands it `periods[]` and, for each row,
 * `cells[]` in the SAME index order, along with each period's label / sublabel /
 * band / ariaLabel. So one component renders a daily tracker and a monthly one
 * with no branching — cadence only affects column width, which is a function of
 * how many periods there are.
 *
 * A calendar month-grid was considered and rejected: it cannot render a monthly
 * cadence at all, its primary axis is the date when the axis that matters here
 * is the CLIENT, and it hard-codes month boundaries that a 26-day window
 * straddles.
 *
 * Layout note behind the numbers below — PageWrapper gives a 960px content box
 * at a 1280px viewport, 912px inside a 24px-padded section card. A 172px sticky
 * name column leaves 740px, so 26 columns at 28px (24 + 4 gutter) is 728px and
 * fits with no scroll. That is why the default daily window is 26 periods rather
 * than 30. Past that the grid scrolls inside its own card; the page body never
 * scrolls sideways.
 */

const METRICS = { nameCol: 172, cell: 24, gutter: 4, rowH: 30, headH: 42 };

const MAX_TRACK = 96;

const NAME_COL_DIVIDER = '1px 0 0 var(--color-border)';

/**
 * Wide columns when there are few periods, tight ones when there are many —
 * but always a FIXED width, never `1fr`. A fractional track makes a short window
 * stretch its handful of columns across the whole card, which reads as a broken
 * layout with one lonely tick floating in the middle rather than as "there is
 * only one period here".
 */
const trackWidth = (count, d) =>
  count > 20 ? d.cell + d.gutter : Math.min(MAX_TRACK, Math.max(d.cell + d.gutter, 640 / count));

/** Merge consecutive periods sharing a `band` into one header span. */
const buildBands = (periods) => {
  const bands = [];
  for (let i = 0; i < periods.length; i++) {
    const label = periods[i].band || '';
    const last = bands[bands.length - 1];
    if (last && last.label === label) last.span += 1;
    else bands.push({ key: `${label}-${i}`, label, span: 1, first: bands.length === 0 });
  }
  return bands;
};

const DeliveryGrid = ({ tracker, periods, rows, onCellClick }) => {
  const d = METRICS;
  const track = trackWidth(periods.length, d);
  const bands = useMemo(() => buildBands(periods), [periods]);

  const [hover, setHover] = useState({ row: -1, col: -1 });
  const [focus, setFocus] = useState({ row: 0, col: 0 });
  const cellRefs = useRef(new Map());

  /**
   * Every cell callback below is identity-stable, and that is the whole point:
   * DeliveryCell is memo'd, but a callback rebuilt on each render is a changed
   * prop, so before this the memo did nothing and moving the pointer one column
   * re-rendered all 520 cells. Now a hover re-renders the two rows whose
   * `rowHovered` actually flipped, which is what lets the 180ms fade run without
   * competing with React for the frame.
   *
   * They take (row, col) rather than closing over them, and read the live data
   * through a ref, so `rows` changing does not churn the identities either.
   */
  const dataRef = useRef({ rows, periods, onCellClick });
  useEffect(() => {
    dataRef.current = { rows, periods, onCellClick };
  }, [rows, periods, onCellClick]);

  const registerRef = useCallback((r, c, node) => {
    const key = `${r}:${c}`;
    if (node) cellRefs.current.set(key, node);
    else cellRefs.current.delete(key);
  }, []);

  const handleHover = useCallback((r, c) => {
    setHover((prev) => (prev.row === r && prev.col === c ? prev : { row: r, col: c }));
  }, []);

  const handleFocus = useCallback((r, c) => {
    setFocus((prev) => (prev.row === r && prev.col === c ? prev : { row: r, col: c }));
  }, []);

  const handleActivate = useCallback((r, c, anchor) => {
    const live = dataRef.current;
    const row = live.rows[r];
    if (!row) return;
    live.onCellClick?.({ cell: row.cells[c], period: live.periods[c], row, anchor });
  }, []);

  const isInteractive = (r, c) => {
    const s = rows[r]?.cells?.[c]?.s;
    return s && s !== 'off' && s !== 'na';
  };

  /**
   * One keydown listener on the container rather than 520 on the cells, with a
   * roving tabindex so the whole grid is a single tab stop. Horizontal movement
   * skips `off` cells so the caret never lands on a Sunday.
   */
  const onKeyDown = (e) => {
    const { row, col } = focus;
    let next = null;

    const step = (dir) => {
      let c = col + dir;
      while (c >= 0 && c < periods.length && !isInteractive(row, c)) c += dir;
      return c >= 0 && c < periods.length ? { row, col: c } : null;
    };

    if (e.key === 'ArrowRight') next = step(1);
    else if (e.key === 'ArrowLeft') next = step(-1);
    else if (e.key === 'ArrowDown') next = row + 1 < rows.length ? { row: row + 1, col } : null;
    else if (e.key === 'ArrowUp') next = row > 0 ? { row: row - 1, col } : null;
    else if (e.key === 'Home') next = { row, col: 0 };
    else if (e.key === 'End') next = { row, col: periods.length - 1 };
    else if (e.key === 'PageDown') next = { row: rows.length - 1, col };
    else if (e.key === 'PageUp') next = { row: 0, col };
    else return;

    e.preventDefault();
    if (!next) return;
    setFocus(next);
    const node = cellRefs.current.get(`${next.row}:${next.col}`);
    if (node) {
      node.focus();
      node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  };

  const headerTone = (col) => (hover.col === col ? 'var(--color-accent-text)' : 'var(--color-text-muted)');

  return (
    <div
      style={{ position: 'relative', width: '100%', overflowX: 'auto' }}
      onMouseLeave={() => setHover({ row: -1, col: -1 })}
    >
      <div
        role="grid"
        aria-label={`${tracker.name} — ${rows.length} clients by ${periods.length} periods`}
        aria-rowcount={rows.length + 1}
        aria-colcount={periods.length + 1}
        onKeyDown={onKeyDown}
        style={{
          display: 'grid',
          gridTemplateColumns: `${d.nameCol}px repeat(${periods.length}, ${track}px)`,
          justifyContent: 'start',
          minWidth: 'fit-content',
          alignItems: 'center',
          rowGap: 0,
        }}
      >
        {/* Band row — months for a daily tracker, years for a monthly one.
            Decorative: each column header carries the full date in its label. */}
        <div style={{ gridColumn: '1 / 2' }} aria-hidden="true" />
        {bands.map((b) => (
          <div
            key={b.key}
            aria-hidden="true"
            className="font-body truncate"
            style={{
              gridColumn: `span ${b.span}`,
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              color: 'var(--color-text-muted)',
              padding: '0 0 4px 2px',
              borderLeft: b.first ? 'none' : '1px solid var(--color-border)',
            }}
          >
            {b.label}
          </div>
        ))}

        {/* Header row */}
        <div
          role="columnheader"
          style={{
            position: 'sticky',
            left: 0,
            zIndex: 2,
            height: d.headH,
            background: 'var(--color-bg-surface)',
            borderBottom: '1px solid var(--color-border)',
          }}
        />
        {periods.map((p, ci) => (
          <div
            key={p.key}
            role="columnheader"
            aria-label={p.ariaLabel}
            className="font-body flex flex-col items-center justify-end"
            style={{
              height: d.headH,
              paddingBottom: 5,
              borderBottom: '1px solid var(--color-border)',
              background: hover.col === ci ? 'var(--color-accent-light)' : 'transparent',
              color: headerTone(ci),
              transition: `background ${HOVER_MS}ms ${HOVER_EASE}, color ${HOVER_MS}ms ${HOVER_EASE}`,
            }}
          >
            {p.sublabel && (
              <span style={{ fontSize: 9, lineHeight: 1.1, letterSpacing: '0.02em' }}>
                {p.sublabel}
              </span>
            )}
            <span style={{ fontSize: 11, fontWeight: p.isCurrent ? 700 : 500, lineHeight: 1.2 }}>
              {p.label}
            </span>
          </div>
        ))}

        {/* Body */}
        {rows.map((row, ri) => {
          const rowHovered = hover.row === ri;
          return (
            <Fragment key={row.groupId}>
              <div
                role="rowheader"
                className="macan-row-wash font-body truncate"
                data-row-hovered={rowHovered ? 'true' : 'false'}
                title={row.groupName}
                style={{
                  position: 'sticky',
                  left: 0,
                  zIndex: 1,
                  height: d.rowH,
                  display: 'flex',
                  alignItems: 'center',
                  paddingRight: 10,
                  fontSize: 12.5,
                  fontWeight: rowHovered ? 600 : 500,
                  color: rowHovered ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                  // Stays opaque under the wash: this cell scrolls across the
                  // grid and must never let a cell show through it.
                  background: 'var(--color-bg-surface)',
                  boxShadow: NAME_COL_DIVIDER,
                  transition: `color ${HOVER_MS}ms ${HOVER_EASE}`,
                  ...washVars(NAME_COL_HOVER),
                }}
              >
                {row.groupName}
              </div>
              {row.cells.map((cell, ci) => (
                <DeliveryCell
                  key={cell.p}
                  cell={cell}
                  period={periods[ci]}
                  groupName={row.groupName}
                  targetCount={tracker.targetCount || 1}
                  density={d}
                  row={ri}
                  col={ci}
                  isFocused={focus.row === ri && focus.col === ci}
                  rowHovered={rowHovered}
                  registerRef={registerRef}
                  onFocus={handleFocus}
                  onHover={handleHover}
                  onActivate={handleActivate}
                />
              ))}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
};

export default DeliveryGrid;
