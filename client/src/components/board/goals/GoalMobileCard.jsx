import { AlertTriangle, Trash2, Pencil } from 'lucide-react';
import GoalValueCell from './GoalValueCell';
import GoalProgressBar from './GoalProgressBar';
import GoalOutcomeBadge from './GoalOutcomeBadge';
import { cellComponentFor } from '../columns';
import { formatGoalValue, targetFieldOf, hasBaselineField } from '../../../utils/goalDisplay';

/**
 * One goal, stacked, below 768px.
 *
 * Reuses the identical cell components as the desktop row — the house pattern
 * from `DataGrid`, which renders a `hidden md:block` grid beside an `md:hidden`
 * card and shares every editor between them.
 *
 * Field order is deliberate: the result and the score come FIRST. On a phone
 * you are almost always here to type this month's number in or to see how it
 * went, and neither should be below the fold.
 */
/** A label→value row. Hoisted out of the card: a component defined during
 *  render is a new type on every pass, so React unmounts and remounts its whole
 *  subtree — which would blow away a half-typed value on every keystroke. */
const Field = ({ label, children }) => (
  <div className="flex items-baseline justify-between gap-3 py-1.5">
    <span
      className="font-body shrink-0"
      style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}
    >
      {label}
    </span>
    <div className="min-w-0 flex-1 flex justify-end">{children}</div>
  </div>
);

const GoalMobileCard = ({
  goal, columns = [], typeSpec, canTrack, canManage, monthClosable = false, onPatch, onEdit, onDelete,
}) => {
  const c = goal.computed || {};
  const usesDate = (typeSpec?.actualField?.key || (goal.type === 'deadline' ? 'actualDayKey' : 'actual')) === 'actualDayKey';
  const actualFieldKey = usesDate ? 'actualDayKey' : 'actual';
  const actualKind = usesDate
    ? 'date'
    : goal.type === 'boolean' ? 'boolean'
      : goal.type === 'rating' ? 'rating' : 'number';
  // Same rule as the desktop row: a blank is only "missing" once the month is
  // over, and the flags are the same flags.
  const missingFields = new Set(
    monthClosable ? (goal.missing || []).map((m) => m.field) : []
  );
  const missingLabels = monthClosable ? (goal.missing || []).map((m) => m.label) : [];

  const targetField = targetFieldOf(typeSpec, goal.type);
  const targetValue = targetField ? goal.config?.[targetField.key] : undefined;
  const baselineSet = hasBaselineField(typeSpec, goal.type)
    && goal.config?.baseline !== undefined
    && goal.config?.baseline !== null
    && goal.config?.baseline !== '';

  return (
    <div
      className="bg-[color:var(--color-bg-surface)]"
      style={{
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-md)',
        padding: 12,
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p
            className="font-body font-medium"
            style={{ fontSize: 14, color: 'var(--color-text-primary)' }}
          >
            {goal.name}
          </p>
          <p className="font-body" style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
            {typeSpec?.label || goal.type}
          </p>
        </div>
        {canManage && (
          <div className="flex gap-1 shrink-0">
            <button type="button" onClick={() => onEdit(goal)} aria-label="Edit goal" className="p-1.5">
              <Pencil size={15} color="var(--color-text-secondary)" />
            </button>
            <button type="button" onClick={() => onDelete(goal)} aria-label="Delete goal" className="p-1.5">
              <Trash2 size={15} color="var(--color-status-stuck)" />
            </button>
          </div>
        )}
      </div>

      <div className="mt-2 flex flex-col gap-1">
        {/* No bar until there is something to draw — same rule as the desktop
            row. The badge stays: on a card it is the only outcome on screen. */}
        {typeof c.pct === 'number' && (
          <GoalProgressBar pct={c.pct} state={c.state} rawPct={c.rawPct} height={8} />
        )}
        <div className="flex items-center gap-2">
          <GoalOutcomeBadge state={c.state} rawPct={c.rawPct} />
          {missingLabels.length > 0 && (
            <span
              className="inline-flex items-center gap-1 font-body"
              style={{ fontSize: 11, color: 'var(--color-status-working)' }}
            >
              <AlertTriangle size={12} aria-hidden="true" />
              needs {missingLabels.join(', ')}
            </span>
          )}
        </div>
      </div>

      <div className="mt-2" style={{ borderTop: '1px solid var(--color-border)' }}>
        <Field label="Where did you land?">
          <GoalValueCell
            value={usesDate ? goal.actualDayKey : goal.actual}
            goal={goal}
            kind={actualKind}
            readOnly={!canTrack}
            required={missingFields.has(actualFieldKey)}
            placeholder="Not yet"
            onChange={(v) => onPatch({ [actualFieldKey]: v })}
          />
        </Field>
        {baselineSet && (
          <Field label="Started at">
            <span className="font-body" style={{ fontSize: 13 }}>
              {formatGoalValue(goal.config.baseline, goal)}
            </span>
          </Field>
        )}
        {/* No row at all for a type that promises no number — "Aiming for —"
            under "Did we do it?" is a question the goal never asked. */}
        {targetField && (
          <Field label="Aiming for">
            <span className="font-body" style={{ fontSize: 13 }}>
              {targetField.kind === 'date'
                ? (targetValue || '—')
                : formatGoalValue(targetValue ?? null, goal)}
            </span>
          </Field>
        )}
        {columns.map((col) => {
          const Cell = cellComponentFor(col.type);
          return (
            <Field key={col._id} label={col.name}>
              <Cell
                value={goal.columnValues?.[col._id] ?? null}
                column={col}
                task={goal}
                readOnly={!canTrack}
                onChange={(v) => onPatch({ columnValues: { [col._id]: v } })}
              />
            </Field>
          );
        })}
      </div>
    </div>
  );
};

export default GoalMobileCard;
