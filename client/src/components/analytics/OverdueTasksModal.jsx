import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  X,
  AlertTriangle,
  User as UserIcon,
  UserX,
  CalendarClock,
  ChevronRight,
} from 'lucide-react';
import { formatDate } from '../../utils/dateUtils';

/**
 * OverdueTasksModal — full-screen drill-down that opens from the Analytics
 * "Overdue Tasks" stat card. Lists every assignee with the actual overdue
 * tasks under their name; clicking a task jumps to that task on its board.
 *
 * Props:
 *   isOpen   — boolean
 *   onClose  — () => void
 *   assignees — overdue.byAssignee from the analytics payload:
 *     [{ _id, name, profilePic, unassigned, count, tasks: [
 *        { _id, name, boardId, boardName, dueDate, daysOverdue, priority, status }
 *     ]}]
 *   totalCount — total overdue task count (tasks, not people)
 *   onSelectTask — (task) => void   jump to a task
 */

const PRIORITY_LABELS = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

const PRIORITY_COLORS = {
  critical: 'var(--color-priority-critical)',
  high: 'var(--color-priority-high)',
  medium: 'var(--color-priority-medium)',
  low: 'var(--color-priority-low)',
};

const Avatar = ({ user, size = 36 }) => {
  const [imgError, setImgError] = useState(false);
  const handleError = useCallback(() => setImgError(true), []);

  if (user?.profilePic && !imgError) {
    return (
      <img
        src={user.profilePic}
        alt={user.name || 'Avatar'}
        className="object-cover"
        style={{ width: size, height: size, borderRadius: 9999 }}
        onError={handleError}
      />
    );
  }
  const Icon = user?.unassigned ? UserX : UserIcon;
  return (
    <div
      className="flex items-center justify-center"
      style={{
        width: size,
        height: size,
        borderRadius: 9999,
        background: 'var(--color-bg-subtle)',
        border: user?.unassigned
          ? '1px dashed var(--color-border)'
          : '1px solid var(--color-border)',
      }}
      aria-hidden="true"
    >
      <Icon
        size={Math.round(size * 0.55)}
        color="var(--color-text-muted)"
        strokeWidth={2}
      />
    </div>
  );
};

const Chip = ({ label, color, dot }) => (
  <span
    className="font-body font-medium inline-flex items-center gap-1 whitespace-nowrap"
    style={{
      fontSize: 11,
      padding: '2px 8px',
      borderRadius: 'var(--radius-full)',
      background: 'var(--color-bg-subtle)',
      color: 'var(--color-text-secondary)',
    }}
  >
    {dot && (
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: 9999,
          background: color,
          flexShrink: 0,
        }}
      />
    )}
    {label}
  </span>
);

const TaskRow = ({ task, onSelect }) => {
  const overdueLabel =
    task.daysOverdue <= 0
      ? 'Due today'
      : `${task.daysOverdue} day${task.daysOverdue === 1 ? '' : 's'} overdue`;

  return (
    <button
      type="button"
      onClick={() => onSelect(task)}
      className="group w-full flex items-center gap-3 text-left transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[color:var(--color-accent)]"
      style={{
        padding: '10px 12px',
        borderRadius: 'var(--radius-md)',
      }}
    >
      <div className="min-w-0 flex-1">
        <p
          className="font-body font-medium truncate"
          style={{ fontSize: 14, color: 'var(--color-text-primary)' }}
          title={task.name}
        >
          {task.name || 'Untitled task'}
        </p>
        <div className="mt-1.5 flex items-center flex-wrap gap-1.5">
          <Chip label={task.boardName} />
          {task.status?.name && (
            <Chip label={task.status.name} color={task.status.color} dot />
          )}
          {task.priority && (
            <Chip
              label={PRIORITY_LABELS[task.priority] || task.priority}
              color={PRIORITY_COLORS[task.priority] || 'var(--color-accent)'}
              dot
            />
          )}
        </div>
      </div>

      <div className="flex flex-col items-end gap-1 flex-shrink-0">
        <span
          className="font-body font-semibold inline-flex items-center gap-1 whitespace-nowrap"
          style={{ fontSize: 12, color: 'var(--color-priority-critical)' }}
        >
          <CalendarClock size={13} strokeWidth={2} aria-hidden="true" />
          {overdueLabel}
        </span>
        {task.dueDate && (
          <span
            className="font-body whitespace-nowrap"
            style={{ fontSize: 11, color: 'var(--color-text-muted)' }}
          >
            Due {formatDate(task.dueDate)}
          </span>
        )}
      </div>

      <ChevronRight
        size={16}
        strokeWidth={2}
        className="flex-shrink-0 opacity-40 transition-opacity group-hover:opacity-80"
        color="var(--color-text-muted)"
        aria-hidden="true"
      />
    </button>
  );
};

const OverdueTasksModal = ({
  isOpen,
  onClose,
  assignees = [],
  totalCount = 0,
  onSelectTask,
}) => {
  // ESC to close + scroll lock while open
  useEffect(() => {
    if (!isOpen) return undefined;
    const handleKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose?.();
      }
    };
    document.addEventListener('keydown', handleKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen, onClose]);

  const peopleCount = useMemo(
    () => assignees.filter((a) => !a.unassigned).length,
    [assignees]
  );

  if (!isOpen) return null;

  const node = (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Overdue tasks breakdown"
      className="fixed inset-0 z-50 flex flex-col"
      style={{
        background: 'var(--color-bg-base)',
        animation: 'macan-overdue-fade 180ms ease-out',
      }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between gap-4 px-5 sm:px-8 shrink-0"
        style={{
          height: 68,
          borderBottom: '1px solid var(--color-border)',
          background: 'var(--color-bg-surface)',
        }}
      >
        <div className="flex items-center gap-3 min-w-0">
          <div
            className="flex items-center justify-center flex-shrink-0"
            style={{
              width: 38,
              height: 38,
              borderRadius: 'var(--radius-md)',
              background: 'var(--color-status-stuck-bg)',
            }}
          >
            <AlertTriangle
              size={20}
              color="var(--color-priority-critical)"
              strokeWidth={2}
              aria-hidden="true"
            />
          </div>
          <div className="min-w-0">
            <h2
              className="font-display font-bold truncate"
              style={{ fontSize: 18, color: 'var(--color-text-primary)' }}
            >
              Overdue Tasks
            </h2>
            <p
              className="font-body"
              style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}
            >
              {totalCount} overdue task{totalCount === 1 ? '' : 's'}
              {peopleCount > 0
                ? ` across ${peopleCount} ${
                    peopleCount === 1 ? 'person' : 'people'
                  }`
                : ''}
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="flex items-center justify-center rounded-md transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
          style={{ width: 36, height: 36 }}
        >
          <X size={20} color="var(--color-text-secondary)" aria-hidden="true" />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-y-auto px-5 sm:px-8 py-6">
        <div className="mx-auto w-full" style={{ maxWidth: 920 }}>
          {assignees.length === 0 ? (
            <div
              className="flex flex-col items-center justify-center text-center"
              style={{ padding: '80px 0' }}
            >
              <div
                className="flex items-center justify-center"
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: 9999,
                  background: 'var(--color-status-done-bg)',
                  marginBottom: 16,
                }}
              >
                <AlertTriangle
                  size={26}
                  color="var(--color-status-done)"
                  strokeWidth={2}
                  aria-hidden="true"
                />
              </div>
              <p
                className="font-display font-semibold"
                style={{ fontSize: 16, color: 'var(--color-text-primary)' }}
              >
                No overdue tasks
              </p>
              <p
                className="font-body mt-1"
                style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}
              >
                Everything is on track for this selection.
              </p>
            </div>
          ) : (
            <div className="flex flex-col" style={{ gap: 16 }}>
              {assignees.map((person) => (
                <section
                  key={person._id}
                  className="bg-surface"
                  style={{
                    borderRadius: 'var(--radius-lg)',
                    boxShadow: 'var(--shadow-card)',
                    overflow: 'hidden',
                  }}
                >
                  {/* Person header */}
                  <div
                    className="flex items-center gap-3"
                    style={{
                      padding: '14px 16px',
                      borderBottom: '1px solid var(--color-border)',
                    }}
                  >
                    <Avatar user={person} size={36} />
                    <span
                      className="font-display font-semibold truncate flex-1"
                      style={{
                        fontSize: 15,
                        color: person.unassigned
                          ? 'var(--color-text-muted)'
                          : 'var(--color-text-primary)',
                        fontStyle: person.unassigned ? 'italic' : 'normal',
                      }}
                      title={person.name}
                    >
                      {person.name}
                    </span>
                    <span
                      className="font-body font-semibold inline-flex items-center justify-center flex-shrink-0"
                      style={{
                        fontSize: 12,
                        minWidth: 26,
                        height: 22,
                        padding: '0 8px',
                        borderRadius: 'var(--radius-full)',
                        background: 'var(--color-status-stuck-bg)',
                        color: 'var(--color-priority-critical)',
                      }}
                    >
                      {person.count}
                    </span>
                  </div>

                  {/* Tasks */}
                  <div className="flex flex-col p-2" style={{ gap: 2 }}>
                    {person.tasks.map((task) => (
                      <TaskRow
                        key={`${person._id}-${task._id}`}
                        task={task}
                        onSelect={onSelectTask}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>

      <style>{`
        @keyframes macan-overdue-fade {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
      `}</style>
    </div>
  );

  return createPortal(node, document.body);
};

export default OverdueTasksModal;
