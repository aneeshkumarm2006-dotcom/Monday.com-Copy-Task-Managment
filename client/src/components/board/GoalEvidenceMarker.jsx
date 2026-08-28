import { useMemo } from 'react';
import { Target } from 'lucide-react';
import useTaskStore from '../../store/taskStore';
import { evidenceStateOf, linkedGoalIds } from '../../utils/goalEvidence';

/**
 * GoalEvidenceMarker — the small badge on a task row saying whether the work is
 * attached to a goal.
 *
 * ONE component, rendered from BOTH grids. A tracker board goes through
 * `TaskTable`/`TaskRow` or through `DataGrid` depending on
 * `board.useFlexibleColumns`, so a marker built into only one of them is
 * invisible on half the boards that have this feature. Keeping it in a single
 * file is what stops the two drifting.
 *
 * Three outcomes, and the third is silence:
 *   attributed — a count, so you can see the work landed somewhere
 *   orphaned   — a hollow dot: done, in a group that HAS goals, attached to none
 *   dismissed  — nothing at all. Someone said this was not goal work; honouring
 *                that means the row stops asking.
 *
 * A task in a group with no goals this month is also silent: there was nothing
 * to attach to, so there is nothing to nag about. That rule lives in
 * `utils/goalEvidence.js` and is the difference between a useful marker and
 * wallpaper.
 *
 * It reads `groupsWithGoals` from the store rather than taking it as a prop, so
 * that adding the marker to a grid is a one-line change. Threading it through
 * `TaskTable` and `DataGrid` separately is exactly how the two call sites would
 * come to disagree.
 */
const GoalEvidenceMarker = ({ task, board }) => {
  const groupsWithGoals = useTaskStore((s) => s.groupsWithGoals);
  const groupHasGoals = useMemo(
    () => (groupsWithGoals || []).includes(String(task?.group || '')),
    [groupsWithGoals, task?.group]
  );

  const state = evidenceStateOf({ task, board, groupHasGoals });
  if (state === null || state === 'dismissed') return null;

  if (state === 'orphaned') {
    return (
      <span
        title="Done, but not attached to a goal"
        aria-label="Done, but not attached to a goal"
        className="inline-flex items-center justify-center shrink-0"
        style={{ width: 16, height: 16, color: 'var(--color-status-working)' }}
      >
        <Target size={12} aria-hidden="true" />
      </span>
    );
  }

  const count = linkedGoalIds(task).length;
  const label = `Counted towards ${count} goal${count === 1 ? '' : 's'}`;
  return (
    <span
      title={label}
      aria-label={label}
      className="inline-flex items-center gap-0.5 font-body font-medium shrink-0"
      style={{
        fontSize: 11,
        padding: '1px 6px 1px 4px',
        borderRadius: 'var(--radius-full)',
        backgroundColor: 'var(--color-bg-subtle)',
        color: 'var(--color-text-secondary)',
      }}
    >
      <Target size={11} aria-hidden="true" />
      {count}
    </span>
  );
};

export default GoalEvidenceMarker;
