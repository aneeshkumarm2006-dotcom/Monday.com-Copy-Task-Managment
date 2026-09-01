import { useMemo } from 'react';
import { Target } from 'lucide-react';
import useTaskStore from '../../store/taskStore';
import {
  evidenceStateOf,
  isAttachable,
  isDismissed,
  linkedGoalIds,
} from '../../utils/goalEvidence';

/**
 * GoalEvidenceMarker — the small badge on a task row saying whether the work is
 * attached to a goal, and the way in to attaching it.
 *
 * ONE component, rendered from BOTH grids. A tracker board goes through
 * `TaskTable`/`TaskRow` or through `DataGrid` depending on
 * `board.useFlexibleColumns`, so a marker built into only one of them is
 * invisible on half the boards that have this feature. Keeping it in a single
 * file is what stops the two drifting.
 *
 * Four outcomes, and the last is silence:
 *   attributed — a count, so you can see the work landed somewhere
 *   orphaned   — a solid dot: done, in a group that HAS goals, attached to none
 *   available  — a faint hollow ring: not finished yet, but there ARE goals
 *                this month, so attaching is possible
 *   dismissed  — nothing at all. Someone said this was not goal work; honouring
 *                that means the row stops asking.
 *
 * WHY `available` EXISTS. Without it a row that is not yet done showed nothing
 * whatsoever, and since the panel's Goal section is below the fold of the
 * sidebar, "no icon on the row" read as "this task cannot have a goal" — the
 * feature looked broken on precisely the tasks somebody was about to work on.
 * It is deliberately the quietest of the three: no colour, low opacity, full
 * strength only on hover or keyboard focus.
 *
 * It is still gated on the group having goals this month, which is the rule
 * that stops any of these being wallpaper: if there was nothing to attach to,
 * there is nothing to offer. That rule lives in `utils/goalEvidence.js`.
 *
 * EVERY visible state is a button. The marker used to be an inert span with a
 * tooltip, which is the other half of why the feature read as unusable: the
 * one goal-shaped thing on the row did nothing when clicked. Clicking asks the
 * store to open this task on its Goal section (`requestGoalAttach`); the board
 * page does the opening, so this stays a one-line drop-in for both grids.
 *
 * It reads `groupsWithGoals` from the store rather than taking it as a prop, so
 * that adding the marker to a grid is a one-line change. Threading it through
 * `TaskTable` and `DataGrid` separately is exactly how the two call sites would
 * come to disagree.
 */
const GoalEvidenceMarker = ({ task, board }) => {
  const groupsWithGoals = useTaskStore((s) => s.groupsWithGoals);
  const requestGoalAttach = useTaskStore((s) => s.requestGoalAttach);
  const groupHasGoals = useMemo(
    () => (groupsWithGoals || []).includes(String(task?.group || '')),
    [groupsWithGoals, task?.group]
  );

  const state = evidenceStateOf({ task, board, groupHasGoals });

  // Not done, nothing attached, but this group has goals this month — the
  // fourth state. Derived here rather than in `evidenceStateOf`, which is a
  // deliberate line-for-line mirror of the server's copy and answers a
  // different question: what the EVIDENCE is, not what the row should offer.
  const canOffer =
    state === null
    && isAttachable(task)
    && groupHasGoals
    && !isDismissed(task)
    && linkedGoalIds(task).length === 0;

  if (state === 'dismissed') return null;
  if (state === null && !canOffer) return null;

  const open = (e) => {
    // The whole row opens the panel on click; without this the row handler
    // wins the event and the Goal section is never focused.
    e.stopPropagation();
    requestGoalAttach(task._id);
  };

  const buttonReset = {
    background: 'transparent',
    border: 'none',
    padding: 0,
    cursor: 'pointer',
  };
  const focusRing =
    'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]';

  if (canOffer) {
    return (
      <button
        type="button"
        onClick={open}
        title="Attach this to a goal"
        aria-label="Attach this to a goal"
        className={`inline-flex items-center justify-center shrink-0 rounded-full opacity-30 hover:opacity-100 focus-visible:opacity-100 transition-opacity duration-150 ${focusRing}`}
        style={{
          ...buttonReset,
          width: 16,
          height: 16,
          color: 'var(--color-text-muted)',
        }}
      >
        <Target size={12} aria-hidden="true" />
      </button>
    );
  }

  if (state === 'orphaned') {
    return (
      <button
        type="button"
        onClick={open}
        title="Done, but not attached to a goal"
        aria-label="Done, but not attached to a goal — attach it"
        className={`inline-flex items-center justify-center shrink-0 rounded-full ${focusRing}`}
        style={{
          ...buttonReset,
          width: 16,
          height: 16,
          color: 'var(--color-status-working)',
        }}
      >
        <Target size={12} aria-hidden="true" />
      </button>
    );
  }

  const count = linkedGoalIds(task).length;
  const label = `Counted towards ${count} goal${count === 1 ? '' : 's'}`;
  return (
    <button
      type="button"
      onClick={open}
      title={label}
      aria-label={label}
      className={`inline-flex items-center gap-0.5 font-body font-medium shrink-0 ${focusRing}`}
      style={{
        ...buttonReset,
        fontSize: 11,
        padding: '1px 6px 1px 4px',
        borderRadius: 'var(--radius-full)',
        backgroundColor: 'var(--color-bg-subtle)',
        color: 'var(--color-text-secondary)',
      }}
    >
      <Target size={11} aria-hidden="true" />
      {count}
    </button>
  );
};

export default GoalEvidenceMarker;
