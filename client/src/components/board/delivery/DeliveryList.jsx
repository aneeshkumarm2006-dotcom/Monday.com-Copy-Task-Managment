import { useState } from 'react';
import { cellStateMeta, requirementMeta } from '../../../utils/deliveryTrackers';
import { LegendSwatch } from './DeliveryLegend';

/**
 * The linear view of a tracker.
 *
 * One component, three jobs: the Grid|List toggle target, the layout below
 * 768px, and the screen-reader-friendly alternative to a 520-cell grid. Building
 * it once for all three is the argument for building it at all.
 *
 * Shows only the periods that need attention by default — a list of 500 rows
 * saying "met" helps nobody — with a toggle to see everything.
 */

const DeliveryList = ({ tracker, periods, rows, onCellClick }) => {
  const [showAll, setShowAll] = useState(false);
  const targetCount = tracker.targetCount || 1;

  const entries = [];
  rows.forEach((row) => {
    row.cells.forEach((cell, ci) => {
      if (cell.s === 'off' || cell.s === 'na') return;
      if (!showAll && (cell.s === 'met' || cell.s === 'pending')) return;
      entries.push({ row, cell, period: periods[ci] });
    });
  });

  const cellStyle = {
    padding: '8px 10px',
    borderBottom: '1px solid var(--color-border)',
    fontSize: 12.5,
    textAlign: 'left',
    verticalAlign: 'top',
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
          {entries.length === 0
            ? showAll
              ? 'Nothing tracked in this window.'
              : 'Everything on time in this window.'
            : `${entries.length} period${entries.length === 1 ? '' : 's'} listed`}
        </p>
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="font-body"
          style={{
            fontSize: 11.5,
            fontWeight: 600,
            color: 'var(--color-accent)',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
          }}
        >
          {showAll ? 'Only show problems' : 'Show everything'}
        </button>
      </div>

      {entries.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table className="w-full font-body" style={{ borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['Client', 'When', 'Result', "What's missing"].map((h) => (
                  <th
                    key={h}
                    scope="col"
                    style={{
                      ...cellStyle,
                      fontSize: 11,
                      fontWeight: 600,
                      letterSpacing: '0.04em',
                      textTransform: 'uppercase',
                      color: 'var(--color-text-secondary)',
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {entries.map(({ row, cell, period }) => (
                <tr
                  key={`${row.groupId}:${cell.p}`}
                  onClick={(e) => onCellClick?.({ cell, period, row, anchor: e.currentTarget })}
                  style={{ cursor: onCellClick ? 'pointer' : 'default' }}
                >
                  <td style={{ ...cellStyle, color: 'var(--color-text-primary)', fontWeight: 500 }}>
                    {row.groupName}
                  </td>
                  <td style={{ ...cellStyle, color: 'var(--color-text-secondary)' }}>
                    {period.ariaLabel}
                  </td>
                  <td style={cellStyle}>
                    <span className="inline-flex items-center gap-1.5">
                      <LegendSwatch state={cell.s} />
                      <span style={{ color: 'var(--color-text-primary)' }}>
                        {cellStateMeta(cell.s).label}
                        {targetCount > 1 && ` (${cell.n}/${targetCount})`}
                      </span>
                    </span>
                  </td>
                  <td style={{ ...cellStyle, color: 'var(--color-text-muted)' }}>
                    {cell.missing?.length > 0
                      ? cell.missing.map((r) => requirementMeta(r)?.short).filter(Boolean).join(', ')
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default DeliveryList;
