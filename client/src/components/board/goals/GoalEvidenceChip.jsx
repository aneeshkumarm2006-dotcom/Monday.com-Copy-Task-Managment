import { useRef, useState } from 'react';
import { Target } from 'lucide-react';
import GoalEvidencePopover from './GoalEvidencePopover';

/**
 * GoalEvidenceChip — "3 tasks" on a goal row, opening the list behind it.
 *
 * The answer to the question this whole feature exists for: a goal row can say
 * "Target 12, Actual 7" without saying anything about the work that produced
 * the 7. This is where that work becomes visible.
 *
 * SILENT AT ZERO, like GoalConnectorChip beside it. Most goals on most boards
 * have nothing to say here, and a row of "0 tasks" chips is noise that makes
 * the rows that DO have something harder to see.
 *
 * WHY THERE IS NO COLUMN FOR THIS. Same argument GoalConnectorChip already
 * makes: the Goals grid is fighting for horizontal room, its widths are shared
 * between the header and every row via goalGrid.js, and a permanent column for
 * something most rows are silent about is a tax paid by every board. The chip
 * rides in the frozen name cell instead, and goalGrid.js is not touched.
 *
 * The amber dot means at least one of the linked tasks has drifted — reopened,
 * refiled into another month, moved to another group. The count still includes
 * it, because the link is a record of something a person asserted and is never
 * silently withdrawn; the dot is how they find it to reconcile.
 */
const GoalEvidenceChip = ({ goal, evidence, onOpenTask }) => {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef(null);

  const count = evidence?.count || 0;
  const stale = evidence?.stale || 0;
  if (count === 0) return null;

  const label = `${count} task${count === 1 ? '' : 's'} counted towards this goal${
    stale > 0 ? `, ${stale} needing a look` : ''
  }`;

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={label}
        aria-label={label}
        aria-expanded={open}
        className="inline-flex items-center gap-1 font-body font-medium self-start rounded transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
        style={{
          fontSize: 11,
          marginTop: 2,
          padding: '1px 6px 1px 4px',
          borderRadius: 'var(--radius-full)',
          background: 'transparent',
          border: '1px solid var(--color-border)',
          color: 'var(--color-text-secondary)',
          cursor: 'pointer',
        }}
      >
        <Target size={11} aria-hidden="true" />
        {count}
        {stale > 0 && (
          <span
            aria-hidden="true"
            style={{
              width: 5,
              height: 5,
              borderRadius: '50%',
              background: 'var(--color-status-working)',
            }}
          />
        )}
      </button>

      {open && (
        <GoalEvidencePopover
          goal={goal}
          anchorRef={anchorRef}
          onClose={() => setOpen(false)}
          onOpenTask={onOpenTask}
        />
      )}
    </>
  );
};

export default GoalEvidenceChip;
