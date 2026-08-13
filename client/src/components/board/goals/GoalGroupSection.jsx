import { ChevronDown, ChevronRight, Plus, Target } from 'lucide-react';
import GoalRow from './GoalRow';
import GoalMobileCard from './GoalMobileCard';
import ScoreRing from '../../ui/ScoreRing';
import {
  buildGoalGrid,
  goalGridMinWidth,
  stickyGutter,
  stickyName,
  stickyActions,
  bandEdgeLeft,
  bandEdgeRight,
  headerAlignFor,
  FROZEN_CELL_CLASS,
} from './goalGrid';

/**
 * One group's goals for the selected month.
 *
 * Collapsible, with the group's own weighted score as a ring in the header —
 * deliberately the same shape and rhythm as the board's task groups, so the
 * Goals tab reads as the same board rather than a different product.
 */
const GoalGroupSection = ({
  group,
  columns = [],
  typesByKey,
  collapsed,
  onToggleCollapse,
  canTrack,
  canManage,
  monthClosable = false,
  onPatch,
  onEdit,
  onDelete,
  onAdd,
}) => {
  const { summary = {}, goals = [] } = group;

  // Gutter, name, …extras, start, target, actual, result, actions — see goalGrid.
  const gridTemplate = buildGoalGrid(columns);
  const hasRequired = columns.some((c) => c.required);

  const headerCell = {
    padding: '8px 10px',
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    color: 'var(--color-text-secondary)',
    borderBottom: '1px solid var(--color-border)',
    display: 'flex',
    alignItems: 'center',
    minWidth: 0,
  };

  // The three number columns are centred — heading over value — so start,
  // target and actual read as one row of figures rather than three ragged edges.
  const numberHeaderCell = { ...headerCell, justifyContent: 'center' };

  return (
    <section
      className="bg-[color:var(--color-bg-surface)]"
      style={{
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-lg)',
        overflow: 'hidden',
      }}
    >
      <header className="flex items-center gap-3 px-3 py-3">
        <button
          type="button"
          onClick={onToggleCollapse}
          aria-expanded={!collapsed}
          aria-label={collapsed ? `Expand ${group.name}` : `Collapse ${group.name}`}
          className="p-0.5 shrink-0"
        >
          {collapsed
            ? <ChevronRight size={16} color="var(--color-text-secondary)" />
            : <ChevronDown size={16} color="var(--color-text-secondary)" />}
        </button>

        <div className="flex-1 min-w-0">
          <h3
            className="font-display font-bold truncate"
            style={{ fontSize: 15, color: 'var(--color-text-primary)' }}
          >
            {group.name}
          </h3>
          <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
            {goals.length === 0
              ? 'No goals set'
              : `${goals.length} goal${goals.length === 1 ? '' : 's'}`
                + (summary.pendingCount
                  ? ` · ${summary.pendingCount} still to report`
                  : '')}
          </p>
        </div>

        <ScoreRing
          pct={summary.pct}
          size={44}
          label={`${group.name} scored ${summary.pct ?? 'nothing yet'}`}
        />

        {canManage && (
          <button
            type="button"
            onClick={() => onAdd(group)}
            className="inline-flex items-center gap-1 font-body shrink-0"
            style={{
              fontSize: 12,
              fontWeight: 500,
              padding: '5px 10px',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--color-border-strong)',
              color: 'var(--color-text-secondary)',
            }}
          >
            <Plus size={13} aria-hidden="true" />
            Goal
          </button>
        )}
      </header>

      {!collapsed && (
        goals.length === 0 ? (
          <div
            className="flex flex-col items-center gap-2 px-4 py-8 text-center"
            style={{ borderTop: '1px solid var(--color-border)' }}
          >
            <Target size={20} color="var(--color-text-muted)" aria-hidden="true" />
            <p className="font-body" style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
              No goals for {group.name} this month.
            </p>
            {canManage && (
              <button
                type="button"
                onClick={() => onAdd(group)}
                className="font-body"
                style={{ fontSize: 13, color: 'var(--color-accent)' }}
              >
                Add the first one
              </button>
            )}
          </div>
        ) : (
          <>
            {/* Desktop grid */}
            <div className="hidden md:block" style={{ overflowX: 'auto' }}>
              <div role="table" style={{ minWidth: goalGridMinWidth(columns) }}>
                <div
                  role="row"
                  className="bg-[color:var(--color-bg-surface)]"
                  style={{ display: 'grid', gridTemplateColumns: gridTemplate }}
                >
                  <div
                    role="columnheader"
                    className={FROZEN_CELL_CLASS}
                    style={{ ...headerCell, ...stickyGutter, padding: '8px 2px' }}
                  />
                  <div
                    role="columnheader"
                    className={FROZEN_CELL_CLASS}
                    style={{ ...headerCell, ...stickyName, ...bandEdgeRight }}
                  >
                    Goal
                  </div>
                  {/* The board's own columns sit next to the name they describe. */}
                  {columns.map((col) => (
                    <div
                      key={col._id}
                      role="columnheader"
                      style={{ ...headerCell, justifyContent: headerAlignFor(col.type) }}
                      title={col.name}
                    >
                      <span className="truncate">{col.name}</span>
                      {col.required && (
                        <span
                          aria-label="required"
                          title="Required before the month can be closed"
                          style={{ color: 'var(--color-status-stuck)', marginLeft: 3 }}
                        >
                          *
                        </span>
                      )}
                    </div>
                  ))}
                  {/* …and the scoring block is fenced off from them. */}
                  <div
                    role="columnheader"
                    style={{ ...numberHeaderCell, ...bandEdgeLeft }}
                    title="Where this goal stood at the start of the month"
                  >
                    Start
                  </div>
                  <div
                    role="columnheader"
                    style={numberHeaderCell}
                    title="What it was aiming for"
                  >
                    Target
                  </div>
                  <div
                    role="columnheader"
                    style={numberHeaderCell}
                    title="Where it actually landed — this is the cell you fill in"
                  >
                    Actual
                  </div>
                  <div role="columnheader" style={headerCell}>Result</div>
                  <div
                    role="columnheader"
                    className={FROZEN_CELL_CLASS}
                    style={{ ...headerCell, ...stickyActions, ...bandEdgeLeft }}
                  />
                </div>

                {goals.map((goal) => (
                  <GoalRow
                    key={goal._id}
                    goal={goal}
                    columns={columns}
                    typeSpec={typesByKey[goal.type]}
                    gridTemplate={gridTemplate}
                    canTrack={canTrack}
                    canManage={canManage}
                    monthClosable={monthClosable}
                    onPatch={(patch) => onPatch(goal, patch)}
                    onEdit={onEdit}
                    onDelete={onDelete}
                  />
                ))}
              </div>
            </div>

            {/* The red asterisk in the headings, explained once per table rather
                than only in a tooltip nobody hovers. */}
            {hasRequired && (
              <p
                className="hidden md:block font-body px-3 py-2"
                style={{ fontSize: 11, color: 'var(--color-text-muted)' }}
              >
                <span style={{ color: 'var(--color-status-stuck)' }}>*</span>
                {' '}has to be filled in before this month can be closed.
              </p>
            )}

            {/* Mobile cards — identical editors, stacked */}
            <div
              className="md:hidden flex flex-col gap-3 p-3"
              style={{ borderTop: '1px solid var(--color-border)' }}
            >
              {goals.map((goal) => (
                <GoalMobileCard
                  key={goal._id}
                  goal={goal}
                  columns={columns}
                  typeSpec={typesByKey[goal.type]}
                  canTrack={canTrack}
                  canManage={canManage}
                  monthClosable={monthClosable}
                  onPatch={(patch) => onPatch(goal, patch)}
                  onEdit={onEdit}
                  onDelete={onDelete}
                />
              ))}
            </div>
          </>
        )
      )}
    </section>
  );
};

export default GoalGroupSection;
