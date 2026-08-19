import { AlertTriangle, Trash2, Pencil } from 'lucide-react';
import GoalValueCell from './GoalValueCell';
import GoalProgressBar from './GoalProgressBar';
import GoalOutcomeBadge from './GoalOutcomeBadge';
import GoalSparkline from './GoalSparkline';
import GoalMoveMenu from './GoalMoveMenu';
import { cellComponentFor } from '../columns';
import { weightLabel, targetFieldOf, hasBaselineField } from '../../../utils/goalDisplay';
import {
  stickyGutter,
  stickyName,
  stickyActions,
  bandEdgeLeft,
  bandEdgeRight,
  FROZEN_CELL_CLASS,
} from './goalGrid';

/**
 * One goal, on desktop.
 *
 * The extra (admin-defined) columns render through the EXISTING column cell
 * registry from `components/board/columns` — `TextCell`, `NumberCell`,
 * `DateCell`, `DropdownCell`, `LinkCell` and `PersonCell` all take
 * `{ value, column, readOnly, onChange }` and neither know nor care that the
 * row they are editing is a goal rather than a task. The built-in numeric
 * fields get `GoalValueCell` instead, because those need a unit suffix, need to
 * change shape with the goal's type, and need the required-but-empty state.
 */
const GoalRow = ({
  goal,
  columns = [],
  typeSpec,
  gridTemplate,
  canTrack,
  canManage,
  monthClosable = false,
  // Where this row sits in its group's stored order, and whether that order is
  // the one currently on screen — see the note on the move menu below.
  index = 0,
  rowCount = 0,
  sortActive = false,
  onPatch,
  onEdit,
  onDelete,
  onMove,
}) => {
  const c = goal.computed || {};
  const usesDate = (typeSpec?.actualField?.key || (goal.type === 'deadline' ? 'actualDayKey' : 'actual')) === 'actualDayKey';
  const actualKind = usesDate
    ? 'date'
    : goal.type === 'boolean'
      ? 'boolean'
      : goal.type === 'rating'
        ? 'rating'
        : 'number';
  const targetField = targetFieldOf(typeSpec, goal.type);
  // The scorer leaves `pct` null for a goal nobody has reported on yet.
  const reported = typeof c.pct === 'number';

  const actualFieldKey = usesDate ? 'actualDayKey' : 'actual';

  // Blanks only go red once the month is OVER. "Untracked is not a failure, it
  // is an unanswered question" is the scorer's rule, and a goal created this
  // morning shouting that it is missing a result contradicts it. `monthClosable`
  // is the server's own `unclosed` flag — a past month with gaps in it.
  const missing = monthClosable ? (goal.missing || []) : [];
  const missingFields = new Set(missing.map((m) => m.field));
  // The gutter triangle is about the EXTRA columns; the Actual cell paints its
  // own missing state, so flagging it here too would say the same thing twice.
  // (This used to compare `m.field` — 'actual' — against `goal.type` —
  // 'numeric' — so it never actually excluded anything.)
  const flaggedColumns = missing.filter((m) => m.field !== actualFieldKey);

  const cellStyle = {
    padding: '8px 10px',
    borderBottom: '1px solid var(--color-border)',
    display: 'flex',
    alignItems: 'center',
    minWidth: 0,
  };

  // Start / target / actual are centred under their centred headings, so the
  // three figures line up as one row of numbers instead of three ragged edges.
  const numberCellStyle = { ...cellStyle, justifyContent: 'center' };

  // A required-but-empty extra column, outlined in red.
  //
  // LONGHANDS ONLY — never a `border` shorthand here. Spreading `cellStyle` and
  // then naming `borderBottom` again does NOT move that key to the end: it keeps
  // the position it had in `cellStyle`, so any `border` key written afterwards
  // is applied LAST. React writes an undefined style value as `style.border = ''`,
  // and clearing the shorthand clears `border-bottom` with it — which silently
  // erased the row separator from every extra column, on every row, while the
  // name and scoring cells (which never mention `border`) kept theirs.
  const missingCellStyle = {
    borderTop: '1.5px solid var(--color-status-stuck)',
    borderRight: '1.5px solid var(--color-status-stuck)',
    borderBottom: '1.5px solid var(--color-status-stuck)',
    borderLeft: '1.5px solid var(--color-status-stuck)',
    background: 'var(--color-status-stuck-bg)',
  };

  return (
    <div
      role="row"
      className="group hover:bg-[color:var(--color-bg-subtle)] transition-colors duration-100"
      style={{ display: 'grid', gridTemplateColumns: gridTemplate }}
    >
      {/* Flag gutter — an amber triangle when something required is missing. */}
      <div
        className={FROZEN_CELL_CLASS}
        style={{ ...cellStyle, ...stickyGutter, justifyContent: 'center', padding: '8px 2px' }}
      >
        {flaggedColumns.length > 0 && (
          <AlertTriangle
            size={14}
            color="var(--color-status-working)"
            aria-hidden="true"
            title={`Missing: ${flaggedColumns.map((m) => m.label).join(', ')}`}
          />
        )}
      </div>

      {/* Name + the type in plain language. Frozen: every number to the right of
          it is meaningless without the name it belongs to still on screen. */}
      <div
        className={FROZEN_CELL_CLASS}
        style={{
          ...cellStyle,
          ...stickyName,
          ...bandEdgeRight,
          flexDirection: 'column',
          alignItems: 'flex-start',
          gap: 1,
        }}
      >
        <span
          className="font-body font-medium truncate w-full"
          style={{ fontSize: 13, color: 'var(--color-text-primary)' }}
          title={goal.name}
        >
          {goal.name}
        </span>
        <span
          className="font-body truncate w-full"
          style={{ fontSize: 11, color: 'var(--color-text-muted)' }}
        >
          {typeSpec?.label || goal.type}
          {goal.weight !== 1 && ` · ${weightLabel(goal.weight)}`}
        </span>
      </div>

      {/* Admin-defined extra columns, through the existing cell registry. These
          describe the goal, so they sit beside its name, before the scoring. */}
      {columns.map((col) => {
        const Cell = cellComponentFor(col.type);
        const value = goal.columnValues?.[col._id] ?? null;
        const isMissing = missingFields.has(String(col._id));
        return (
          <div
            key={col._id}
            style={{ ...cellStyle, ...(isMissing ? missingCellStyle : null) }}
            title={isMissing ? `${col.name} is required` : undefined}
          >
            <Cell
              value={value}
              column={col}
              task={goal}
              readOnly={!canTrack}
              onChange={(v) => onPatch({ columnValues: { [col._id]: v } })}
            />
          </div>
        );
      })}

      {/* Start / Target — the promise, editable only by goal.manage */}
      <div style={{ ...numberCellStyle, ...bandEdgeLeft }}>
        {hasBaselineField(typeSpec, goal.type) ? (
          <GoalValueCell
            value={goal.config?.baseline ?? null}
            goal={goal}
            align="center"
            readOnly={!canManage}
            onChange={(v) => onPatch({ config: { ...goal.config, baseline: v } })}
          />
        ) : (
          <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>—</span>
        )}
      </div>
      <div style={numberCellStyle}>
        {targetField ? (
          <GoalValueCell
            value={goal.config?.[targetField.key] ?? null}
            goal={goal}
            kind={targetField.kind}
            align="center"
            readOnly={!canManage}
            onChange={(v) => onPatch({ config: { ...goal.config, [targetField.key]: v } })}
          />
        ) : (
          <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>—</span>
        )}
      </div>

      {/* Actual — the result. This is the one cell `goal.track` can write. */}
      <div style={numberCellStyle}>
        <GoalValueCell
          value={usesDate ? goal.actualDayKey : goal.actual}
          goal={goal}
          kind={actualKind}
          align="center"
          readOnly={!canTrack}
          required={missingFields.has(actualFieldKey)}
          placeholder="Not yet"
          onChange={(v) => onPatch({ [actualFieldKey]: v })}
        />
      </div>

      {/* Result: bar, badge, sparkline — and NOTHING at all until a number has
          been reported. An empty grey track plus a "Not reported" pill on every
          unreported row is thirty rows of furniture saying what the Actual cell
          beside it already says in one word, and it drowns the handful of rows
          that do have a result. */}
      <div style={{ ...cellStyle, gap: 8 }}>
        {reported ? (
          <>
            <div className="flex-1 min-w-0 flex flex-col gap-1">
              <GoalProgressBar pct={c.pct} state={c.state} rawPct={c.rawPct} />
              <div className="flex items-center gap-2">
                <GoalOutcomeBadge state={c.state} rawPct={c.rawPct} />
                {c.assumedBaseline && (
                  <span
                    className="font-body"
                    style={{ fontSize: 10, color: 'var(--color-text-muted)' }}
                    title="No starting point was set, so this is measured from zero."
                  >
                    from 0
                  </span>
                )}
              </div>
            </div>
            <GoalSparkline history={goal.history} goal={goal} />
          </>
        ) : (
          <span
            className="font-body"
            style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
            title="Nothing reported for this goal yet"
          >
            —
          </span>
        )}
      </div>

      {/* Row actions — frozen to the right edge, so they stay reachable on a
          board with enough extra columns to overflow the viewport. */}
      <div
        className={FROZEN_CELL_CLASS}
        style={{
          ...cellStyle,
          ...stickyActions,
          ...bandEdgeLeft,
          padding: '8px 6px',
          gap: 2,
          justifyContent: 'flex-end',
        }}
      >
        {canManage && (
          <>
            {/* Moving a goal writes `Goal.order`, so it moves for everyone —
                unlike the column sort in the heading above, which is yours
                alone. Always live, sort or no sort: a move acts on the order
                on screen and commits it. See `handleMove` in the section. */}
            {onMove && (
              <GoalMoveMenu
                index={index}
                count={rowCount}
                goalName={goal.name}
                sortActive={sortActive}
                onMove={(dir) => onMove(goal, dir)}
              />
            )}
            <button
              type="button"
              onClick={() => onEdit(goal)}
              aria-label={`Edit ${goal.name}`}
              className="p-1 rounded hover:bg-[color:var(--color-bg-subtle)]"
            >
              <Pencil size={14} color="var(--color-text-secondary)" />
            </button>
            <button
              type="button"
              onClick={() => onDelete(goal)}
              aria-label={`Delete ${goal.name}`}
              className="p-1 rounded hover:bg-[color:var(--color-bg-subtle)]"
            >
              <Trash2 size={14} color="var(--color-status-stuck)" />
            </button>
          </>
        )}
      </div>
    </div>
  );
};

export default GoalRow;
