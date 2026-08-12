import { AlertTriangle, Trash2, Pencil } from 'lucide-react';
import GoalValueCell from './GoalValueCell';
import GoalProgressBar from './GoalProgressBar';
import GoalOutcomeBadge from './GoalOutcomeBadge';
import GoalSparkline from './GoalSparkline';
import { cellComponentFor } from '../columns';
import { weightLabel } from '../../../utils/goalDisplay';

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
  onPatch,
  onEdit,
  onDelete,
}) => {
  const c = goal.computed || {};
  const usesDate = typeSpec?.actualField?.key === 'actualDayKey';
  const actualKind = usesDate
    ? 'date'
    : goal.type === 'boolean'
      ? 'boolean'
      : goal.type === 'rating'
        ? 'rating'
        : 'number';

  const missingFields = new Set((goal.missing || []).map((m) => m.field));
  const flaggedColumns = (goal.missing || []).filter((m) => m.field !== goal.type);

  const cellStyle = {
    padding: '8px 10px',
    borderBottom: '1px solid var(--color-border)',
    display: 'flex',
    alignItems: 'center',
    minWidth: 0,
  };

  return (
    <div
      role="row"
      className="hover:bg-[color:var(--color-bg-subtle)] transition-colors duration-100"
      style={{ display: 'grid', gridTemplateColumns: gridTemplate }}
    >
      {/* Flag gutter — an amber triangle when something required is missing. */}
      <div style={{ ...cellStyle, justifyContent: 'center', padding: '8px 2px' }}>
        {flaggedColumns.length > 0 && (
          <AlertTriangle
            size={14}
            color="var(--color-status-working)"
            aria-hidden="true"
            title={`Missing: ${flaggedColumns.map((m) => m.label).join(', ')}`}
          />
        )}
      </div>

      {/* Name + the type in plain language */}
      <div style={{ ...cellStyle, flexDirection: 'column', alignItems: 'flex-start', gap: 1 }}>
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

      {/* Start / Target — the promise, editable only by goal.manage */}
      <div style={cellStyle}>
        {typeSpec?.configFields?.some((f) => f.key === 'baseline') ? (
          <GoalValueCell
            value={goal.config?.baseline ?? null}
            goal={goal}
            readOnly={!canManage}
            onChange={(v) => onPatch({ config: { ...goal.config, baseline: v } })}
          />
        ) : (
          <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>—</span>
        )}
      </div>
      <div style={cellStyle}>
        <GoalValueCell
          value={
            goal.type === 'checklist' ? goal.config?.total ?? null
              : goal.type === 'threshold' ? goal.config?.limit ?? null
                : goal.type === 'deadline' ? goal.config?.dueDayKey ?? null
                  : goal.config?.target ?? null
          }
          goal={goal}
          kind={goal.type === 'deadline' ? 'date' : 'number'}
          readOnly={!canManage}
          onChange={(v) => {
            const field = goal.type === 'checklist' ? 'total'
              : goal.type === 'threshold' ? 'limit'
                : goal.type === 'deadline' ? 'dueDayKey' : 'target';
            onPatch({ config: { ...goal.config, [field]: v } });
          }}
        />
      </div>

      {/* Actual — the result. This is the one cell `goal.track` can write. */}
      <div style={cellStyle}>
        <GoalValueCell
          value={usesDate ? goal.actualDayKey : goal.actual}
          goal={goal}
          kind={actualKind}
          readOnly={!canTrack}
          required={missingFields.has(usesDate ? 'actualDayKey' : 'actual')}
          placeholder="Not yet"
          onChange={(v) => onPatch(usesDate ? { actualDayKey: v } : { actual: v })}
        />
      </div>

      {/* Result: bar, badge, sparkline */}
      <div style={{ ...cellStyle, gap: 8 }}>
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
      </div>

      {/* Admin-defined extra columns, through the existing cell registry */}
      {columns.map((col) => {
        const Cell = cellComponentFor(col.type);
        const value = goal.columnValues?.[col._id] ?? null;
        const isMissing = missingFields.has(String(col._id));
        return (
          <div
            key={col._id}
            style={{
              ...cellStyle,
              border: isMissing ? '1.5px solid var(--color-status-stuck)' : undefined,
              borderBottom: isMissing
                ? '1.5px solid var(--color-status-stuck)'
                : '1px solid var(--color-border)',
              background: isMissing ? 'var(--color-status-stuck-bg)' : undefined,
            }}
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

      {/* Row actions */}
      <div style={{ ...cellStyle, gap: 4, justifyContent: 'flex-end' }}>
        {canManage && (
          <>
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
