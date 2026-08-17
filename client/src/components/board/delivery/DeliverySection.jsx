import { ChevronDown, ChevronRight, LayoutGrid, List, Pencil } from 'lucide-react';

import { SegmentedControl } from '../../ui/FormControls';
import { describeScope, describeTracker, windowOptionsFor } from '../../../utils/deliveryTrackers';
import DeliveryGrid from './DeliveryGrid';
import DeliveryList from './DeliveryList';
import DeliveryLegend from './DeliveryLegend';

/**
 * One tracker's section: a plain-English header, the legend, then the grid.
 *
 * The header sentence comes from describeTracker() — the SAME function that
 * renders the live preview while you build the tracker and the subtitle in the
 * Trackers list. Someone who has never seen this page reads three lines and
 * knows what the squares mean.
 */

const DeliverySection = ({
  tracker,
  groups,
  collapsed,
  view,
  window: windowToken,
  onToggleCollapsed,
  onChangeView,
  onChangeWindow,
  onEdit,
  onCellClick,
  onPeriodClick,
  canManage,
  sectionRef,
}) => {
  const rows = tracker.rows || [];
  const periods = tracker.periods || [];
  const summary = tracker.summary;

  return (
    <section
      ref={sectionRef}
      style={{
        background: 'var(--color-bg-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-lg)',
        padding: 20,
        opacity: tracker.enabled ? 1 : 0.75,
      }}
    >
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex-1" style={{ minWidth: 220 }}>
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-expanded={!collapsed}
            className="inline-flex items-center gap-1.5"
            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
          >
            {collapsed ? (
              <ChevronRight size={16} color="var(--color-text-secondary)" aria-hidden="true" />
            ) : (
              <ChevronDown size={16} color="var(--color-text-secondary)" aria-hidden="true" />
            )}
            <span
              className="font-display font-semibold"
              style={{ fontSize: 15, color: 'var(--color-text-primary)' }}
            >
              {tracker.name}
            </span>
            {!tracker.enabled && (
              <span
                className="font-body"
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                  padding: '2px 6px',
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--color-bg-subtle)',
                  color: 'var(--color-text-muted)',
                }}
              >
                Paused
              </span>
            )}
          </button>

          <p
            className="font-body mt-1"
            style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', paddingLeft: 22 }}
          >
            {describeTracker(tracker)}
          </p>
          <p
            className="font-body mt-0.5"
            style={{ fontSize: 11.5, color: 'var(--color-text-muted)', paddingLeft: 22 }}
          >
            {describeScope(tracker, groups)}
            {summary?.keptPct !== null && summary?.keptPct !== undefined
              && ` · ${summary.keptPct}% kept`}
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0 flex-wrap">
          <SegmentedControl
            options={windowOptionsFor(tracker.cadence?.type)}
            value={windowToken}
            onChange={onChangeWindow}
          />
          <div className="hidden md:block">
            <SegmentedControl
              options={[
                { value: 'grid', label: <LayoutGrid size={13} aria-label="Grid" /> },
                { value: 'list', label: <List size={13} aria-label="List" /> },
              ]}
              value={view}
              onChange={onChangeView}
            />
          </div>
          {canManage && (
            <button
              type="button"
              onClick={onEdit}
              aria-label={`Edit ${tracker.name}`}
              title="Edit tracker"
              className="flex items-center justify-center transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
              style={{
                width: 30,
                height: 30,
                borderRadius: 'var(--radius-sm)',
                border: '1.5px solid var(--color-border)',
                background: 'transparent',
                cursor: 'pointer',
              }}
            >
              <Pencil size={13} color="var(--color-text-secondary)" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {!collapsed && (
        <>
          <div className="mt-3">
            <DeliveryLegend />
          </div>

          {!tracker.enabled ? (
            <p
              className="font-body mt-4"
              style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}
            >
              This tracker is paused, so nothing is being scored. Turn it back on from Trackers.
            </p>
          ) : rows.length === 0 ? (
            <div
              className="mt-4"
              style={{
                padding: '12px 14px',
                borderRadius: 'var(--radius-md)',
                background: 'var(--color-status-working-bg)',
                border: '1.5px solid var(--color-status-working)',
              }}
            >
              <p
                className="font-body"
                style={{ fontSize: 12.5, color: 'var(--color-status-working)' }}
              >
                This tracker covers no clients on this board. Edit it to choose some.
              </p>
            </div>
          ) : (
            <div className="mt-4">
              {/* Below 768px a 172px sticky column leaves 200px of grid, so the
                  mobile answer is the list rather than a squeezed matrix. */}
              <div className={view === 'list' ? 'hidden' : 'hidden md:block'}>
                <DeliveryGrid
                  tracker={tracker}
                  periods={periods}
                  rows={rows}
                  onCellClick={onCellClick}
                  onPeriodClick={onPeriodClick}
                />
              </div>
              <div className={view === 'list' ? '' : 'md:hidden'}>
                <DeliveryList
                  tracker={tracker}
                  periods={periods}
                  rows={rows}
                  onCellClick={onCellClick}
                />
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
};

export default DeliverySection;
