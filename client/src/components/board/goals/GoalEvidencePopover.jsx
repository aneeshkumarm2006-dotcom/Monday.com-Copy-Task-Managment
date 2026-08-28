import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2 } from 'lucide-react';
import useDropdownPosition from '../../../utils/useDropdownPosition';
import { getGoalTasks } from '../../../services/goalService';
import buildTaskLink from '../../../utils/taskLink';

const POPOVER_HEIGHT = 300;

/**
 * GoalEvidencePopover — the work behind one goal.
 *
 * Portal + useDropdownPosition, the same mechanics as AssigneePicker and
 * StatusMenu, because a goal row lives inside a horizontally-scrolling grid and
 * an absolutely-positioned panel would be clipped by it.
 *
 * Rows are fetched on open rather than carried in the tab's evidence payload:
 * the chip needs a count for every goal, this needs full task rows for one, and
 * shipping the second on every tab load to serve the occasional click is the
 * wrong trade.
 *
 * STALE ROWS COME FIRST, and that ordering is the point of the list. The count
 * on the chip is trustworthy on its own; the reason to open it is to find what
 * has drifted since someone claimed it.
 *
 * Navigation goes through `buildTaskLink` — never a hand-built URL. That helper
 * already carries the task's own `month`, which matters most exactly here: a
 * task refiled into September must open on September's board, not on a board
 * that genuinely does not contain it.
 */
const GoalEvidencePopover = ({ goal, anchorRef, onClose, onOpenTask }) => {
  const [rows, setRows] = useState(null);
  const [failed, setFailed] = useState(false);
  const { top, left, openUpward } = useDropdownPosition(anchorRef, true, {
    menuHeight: POPOVER_HEIGHT,
  });

  useEffect(() => {
    let alive = true;
    getGoalTasks(goal._id)
      .then((next) => alive && setRows(next))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [goal._id]);

  // Escape closes, and so does any click outside. Mousedown rather than click so
  // the popover is gone before the underlying row's own handler runs.
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    const onDown = (e) => {
      if (anchorRef.current?.contains(e.target)) return;
      if (e.target.closest?.('[data-goal-evidence-popover]')) return;
      onClose?.();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [anchorRef, onClose]);

  const handleOpen = (row) => {
    onClose?.();
    if (onOpenTask) {
      onOpenTask(row);
      return;
    }
    const href = buildTaskLink(row, { tab: 'updates' });
    if (href) window.location.assign(href);
  };

  return createPortal(
    <div
      data-goal-evidence-popover=""
      role="dialog"
      aria-label={`Work counted towards ${goal.name}`}
      style={{
        position: 'fixed',
        top,
        left,
        zIndex: 70,
        width: 320,
        maxHeight: POPOVER_HEIGHT,
        overflowY: 'auto',
        background: 'var(--color-bg-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-lg)',
        padding: 8,
        transformOrigin: openUpward ? 'bottom' : 'top',
      }}
    >
      <p
        className="font-body"
        style={{
          fontSize: 11,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: 'var(--color-text-muted)',
          margin: '2px 4px 6px',
        }}
      >
        Work counted towards this goal
      </p>

      {rows === null && !failed && (
        <div className="flex items-center gap-2" style={{ padding: '8px 4px' }}>
          <Loader2 size={13} className="animate-spin" aria-hidden="true" />
          <span
            className="font-body"
            style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
          >
            Loading…
          </span>
        </div>
      )}

      {failed && (
        <p
          className="font-body"
          style={{ fontSize: 12, color: 'var(--color-text-muted)', padding: '4px' }}
        >
          Could not load the linked tasks.
        </p>
      )}

      {rows?.map((row) => (
        <button
          key={row._id}
          type="button"
          onClick={() => handleOpen(row)}
          className="w-full text-left rounded transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
          style={{
            display: 'block',
            padding: '6px 8px',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
          }}
        >
          <span
            className="font-body block truncate"
            style={{ fontSize: 13, color: 'var(--color-text-primary)' }}
          >
            {row.name}
          </span>
          {row.stale?.length > 0 && (
            <span className="flex flex-wrap items-center gap-1" style={{ marginTop: 3 }}>
              {row.stale.map((reason) => (
                <span
                  key={reason.code}
                  className="font-body"
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    padding: '1px 6px',
                    borderRadius: 'var(--radius-full)',
                    background: 'var(--color-status-working-bg)',
                    color: 'var(--color-status-working)',
                  }}
                >
                  {reason.label}
                </span>
              ))}
            </span>
          )}
        </button>
      ))}

      {rows?.length === 0 && (
        <p
          className="font-body"
          style={{ fontSize: 12, color: 'var(--color-text-muted)', padding: '4px' }}
        >
          Nothing is attached to this goal yet.
        </p>
      )}
    </div>,
    document.body
  );
};

export default GoalEvidencePopover;
