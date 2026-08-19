import { useCallback, useMemo, useState } from 'react';
import {
  ArrowDown, ArrowUp, ChevronDown, ChevronRight, ListOrdered, Plus, Target,
} from 'lucide-react';
import GoalRow from './GoalRow';
import GoalMobileCard from './GoalMobileCard';
import ScoreRing from '../../ui/ScoreRing';
import Avatar from '../../ui/Avatar';
import useOrgStore from '../../../store/orgStore';
import { formatMonthKey } from '../../../utils/monthKeys';
import { sortGoals, nextGoalSort, columnSortKey } from '../../../utils/goalSort';
import { moveGoalId } from '../../../utils/goalOrder';
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

/**
 * A clickable column heading.
 *
 * Hoisted to module scope rather than defined inside the section: a component
 * created during render is a new type on every pass, so React would throw the
 * heading away and rebuild it on each keystroke happening anywhere in the table.
 */
const SortHead = ({ label, columnKey, sort, onSort, style, hint, suffix, className }) => {
  const active = sort.key === columnKey;
  const Arrow = active && sort.dir === 'desc' ? ArrowDown : ArrowUp;

  return (
    <div
      role="columnheader"
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={className}
      style={{ ...style, color: active ? 'var(--color-accent)' : style.color }}
    >
      <button
        type="button"
        onClick={() => onSort(columnKey)}
        title={
          active
            ? (sort.dir === 'asc' ? `Sorted by ${label}, low to high` : `Sorted by ${label}, high to low`)
            : (hint || `Sort by ${label}`)
        }
        className="inline-flex items-center gap-1 min-w-0 hover:text-[color:var(--color-text-primary)]"
        // `text-transform` and `letter-spacing` are restated rather than
        // inherited: the CSS reset sets `text-transform: none` on buttons, which
        // beats inheritance and would silently un-capitalise every heading the
        // moment it became clickable.
        style={{ cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.04em' }}
      >
        <span className="truncate">{label}</span>
        {suffix}
        <Arrow
          size={11}
          aria-hidden="true"
          className="shrink-0"
          style={{ opacity: active ? 1 : 0.25 }}
        />
      </button>
    </div>
  );
};

/**
 * One group's goals for the selected month.
 *
 * Collapsible, with the group's own weighted score as a ring in the header —
 * deliberately the same shape and rhythm as the board's task groups, so the
 * Goals tab reads as the same board rather than a different product. Column
 * sorting follows the same rule for the same reason: click a heading for
 * ascending, again for descending, a third time for the board's own order.
 *
 * TWO KINDS OF ORDER LIVE HERE, and keeping them apart is most of this file:
 *
 *   SORTING is yours. Per group, per visit, persisted nowhere, and it never
 *   writes anything back — a way of LOOKING at the month.
 *
 *   THE ORDER is everyone's. It lives in `Goal.order` on the server, so a goal
 *   moved to the top of a table is at the top of that table for whoever opens
 *   it next. Moved through the control on each row.
 *
 * They cannot both be live at once: while a sort is active the rows on screen
 * are not in stored order, so "move up" would move a goal somewhere the mover
 * cannot see. The move controls go quiet, and the header offers the honest
 * version of what the user is probably after — save THIS order for everyone.
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
  onReorder,
}) => {
  const { summary = {}, goals = [], owner = null } = group;

  // Gutter, name, …extras, start, target, actual, result, actions — see goalGrid.
  // The actions column is narrower for someone with no row buttons to put in it.
  const gridTemplate = buildGoalGrid(columns, canManage);
  const hasRequired = columns.some((c) => c.required);

  // Per group, exactly like the board's per-group task table: sorting one
  // client's goals is a question about that client, not about the whole month.
  const [sort, setSort] = useState({ key: null, dir: 'asc' });
  const handleSort = useCallback(
    (key) => setSort((prev) => nextGoalSort(prev, key)),
    []
  );

  const members = useOrgStore((s) => s.members || []);
  const personName = useCallback(
    (id) => members.find((m) => String(m._id || m.id) === String(id))?.name || '',
    [members]
  );

  const columnsById = useMemo(
    () => Object.fromEntries(columns.map((c) => [String(c._id), c])),
    [columns]
  );

  const sortedGoals = useMemo(
    () => sortGoals(goals, sort.key, sort.dir, { typesByKey, columnsById, personName }),
    [goals, sort, typesByKey, columnsById, personName]
  );

  // Empty string means "you can move things"; the rows read it as a tooltip.
  const reorderDisabledHint = sort.key
    ? 'Sorted by a column right now — clear the sort, or save it as the order.'
    : '';

  const handleMove = useCallback(
    (goal, dir) => {
      const next = moveGoalId(goals.map((g) => g._id), goal._id, dir);
      if (next) onReorder?.(group, next);
    },
    [goals, group, onReorder]
  );

  /**
   * Freeze the current sort as the order everyone sees, then drop the sort.
   *
   * The sort has to go: leaving it on would show the same rows in the same
   * places and give no sign that anything had been saved, and the next thing
   * the mover does — nudging one row up — has to happen against stored order
   * anyway. Clearing it turns "this is how I like to look at it" into "this is
   * how it is", visibly, in one click.
   */
  const saveSortAsOrder = useCallback(() => {
    onReorder?.(group, sortedGoals.map((g) => g._id));
    setSort({ key: null, dir: 'asc' });
  }, [group, sortedGoals, onReorder]);

  const canReorder = canManage && !!onReorder && goals.length > 1;

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

        {/* Whose month this is. The SAME resolved owner the Board tab shows on
            the same group — one server-side resolver, one hydration, so a group
            cannot be Aneesh's on one tab and nobody's on the other.

            Read-only on purpose: ownership is ASSIGNED on the board, where the
            work is, and a second writer would be a second way to get the month
            wrong. Nothing renders on a group nobody owns rather than an empty
            slot — on a board where most groups have no owner yet, seventeen
            dashed circles is furniture, not information. */}
        {owner && (
          <div
            // The name is the part that goes on a phone, not the owner: an
            // avatar still says who this group belongs to in 22px.
            className="flex items-center gap-1.5 shrink-0 min-w-0 pl-[3px] pr-[3px] sm:pr-2"
            title={[
              `Owner: ${owner.name}`,
              group.ownerActive === false ? '(no longer in this workspace)' : '',
              group.ownerInherited && group.ownerFromMonth
                ? `— carried forward from ${formatMonthKey(group.ownerFromMonth)}`
                : '',
              '· change it on the Board tab',
            ].filter(Boolean).join(' ')}
            style={{
              height: 28,
              maxWidth: 170,
              borderRadius: 'var(--radius-full)',
              background: 'var(--color-bg-surface)',
              border: '1px solid var(--color-border)',
              // Inherited reads slightly quieter than a decision made THIS
              // month — the same cue, and the same 0.75, as the board header.
              opacity: group.ownerInherited ? 0.75 : 1,
            }}
          >
            <Avatar user={owner} size={22} />
            <span
              className="hidden sm:inline font-body truncate"
              style={{
                fontSize: 11.5,
                fontWeight: 500,
                color: 'var(--color-text-secondary)',
                textDecoration: group.ownerActive === false ? 'line-through' : 'none',
              }}
            >
              {owner.name}
            </span>
          </div>
        )}

        <ScoreRing
          pct={summary.pct}
          size={44}
          label={`${group.name} scored ${summary.pct ?? 'nothing yet'}`}
        />

        {/* Only while a sort is on — otherwise what is on screen already IS the
            saved order, and the button would promise a change it cannot make. */}
        {canReorder && sort.key && (
          <button
            type="button"
            onClick={saveSortAsOrder}
            title="Make this the order everyone sees, and clear the sort"
            className="inline-flex items-center gap-1 font-body shrink-0"
            style={{
              fontSize: 12,
              fontWeight: 500,
              padding: '5px 10px',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--color-accent)',
              color: 'var(--color-accent)',
            }}
          >
            <ListOrdered size={13} aria-hidden="true" />
            <span className="hidden sm:inline">Save this order</span>
          </button>
        )}

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
              <div role="table" style={{ minWidth: goalGridMinWidth(columns, canManage) }}>
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
                  <SortHead
                    label="Goal"
                    columnKey="name"
                    sort={sort}
                    onSort={handleSort}
                    className={FROZEN_CELL_CLASS}
                    style={{ ...headerCell, ...stickyName, ...bandEdgeRight }}
                  />
                  {/* The board's own columns sit next to the name they describe. */}
                  {columns.map((col) => (
                    <SortHead
                      key={col._id}
                      label={col.name}
                      columnKey={columnSortKey(col)}
                      sort={sort}
                      onSort={handleSort}
                      style={{ ...headerCell, justifyContent: headerAlignFor(col.type) }}
                      suffix={col.required ? (
                        <span
                          aria-label="required"
                          title="Required before the month can be closed"
                          style={{ color: 'var(--color-status-stuck)' }}
                        >
                          *
                        </span>
                      ) : null}
                    />
                  ))}
                  {/* …and the scoring block is fenced off from them. */}
                  <SortHead
                    label="Start"
                    columnKey="start"
                    sort={sort}
                    onSort={handleSort}
                    style={{ ...numberHeaderCell, ...bandEdgeLeft }}
                    hint="Where this goal stood at the start of the month — click to sort"
                  />
                  <SortHead
                    label="Target"
                    columnKey="target"
                    sort={sort}
                    onSort={handleSort}
                    style={numberHeaderCell}
                    hint="What it was aiming for — click to sort"
                  />
                  <SortHead
                    label="Actual"
                    columnKey="actual"
                    sort={sort}
                    onSort={handleSort}
                    style={numberHeaderCell}
                    hint="Where it actually landed — click to sort"
                  />
                  <SortHead
                    label="Result"
                    columnKey="result"
                    sort={sort}
                    onSort={handleSort}
                    style={headerCell}
                    hint="How the month went — click to sort worst first"
                  />
                  <div
                    role="columnheader"
                    className={FROZEN_CELL_CLASS}
                    style={{ ...headerCell, ...stickyActions, ...bandEdgeLeft }}
                  />
                </div>

                {sortedGoals.map((goal, i) => (
                  <GoalRow
                    key={goal._id}
                    goal={goal}
                    columns={columns}
                    typeSpec={typesByKey[goal.type]}
                    gridTemplate={gridTemplate}
                    canTrack={canTrack}
                    canManage={canManage}
                    monthClosable={monthClosable}
                    index={i}
                    rowCount={sortedGoals.length}
                    reorderDisabledHint={reorderDisabledHint}
                    onPatch={(patch) => onPatch(goal, patch)}
                    onEdit={onEdit}
                    onDelete={onDelete}
                    onMove={canReorder ? handleMove : undefined}
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
              {sortedGoals.map((goal, i) => (
                <GoalMobileCard
                  key={goal._id}
                  goal={goal}
                  columns={columns}
                  typeSpec={typesByKey[goal.type]}
                  canTrack={canTrack}
                  canManage={canManage}
                  monthClosable={monthClosable}
                  index={i}
                  rowCount={sortedGoals.length}
                  reorderDisabledHint={reorderDisabledHint}
                  onPatch={(patch) => onPatch(goal, patch)}
                  onEdit={onEdit}
                  onDelete={onDelete}
                  onMove={canReorder ? handleMove : undefined}
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
