import { useEffect, useRef, useState } from 'react';
import { MoreHorizontal, Calendar as CalendarIcon, Pin } from 'lucide-react';

const NAVBAR_HEIGHT = 56;
import Chip from '../ui/Chip';
import { formatShortDate, isOverdue } from '../../utils/dateUtils';

/**
 * TaskCardList — mobile alternative to TaskTable.
 *
 * On mobile (<768px) the board switches from a tabular layout to a stacked
 * card-per-task layout. Each card surfaces the same fields as a table row:
 * task name, priority chip, status chip, owner avatars, due date.
 *
 * See Macan_Design.md Section 8.2 and PDR Section 9 (Responsive Design).
 *
 * Props mirror TaskTable's display-only props.
 */
const TaskCardList = ({
  tasks = [],
  // Set of task ids this user pinned privately; combined with `task.pinned`
  // (the team pin) to decide which cards show the pin marker.
  personalPins = null,
  board = null,
  onOpenTask,
  onStatusClick,
  onPriorityClick,
  onLabelsClick,
  onActionsClick,
  highlightedTaskId,
  emptyLabel = 'No tasks in this group yet',
  groupId = null,
  dndDisabled = false,
}) => {
  if (tasks.length === 0) {
    return (
      <div
        className="font-body text-center"
        style={{
          fontSize: 13,
          color: 'var(--color-text-muted)',
          padding: '20px 16px',
        }}
      >
        {emptyLabel}
      </div>
    );
  }

  return (
    <ul
      style={{
        listStyle: 'none',
        padding: 0,
        margin: 0,
        background: 'var(--color-bg-surface, #FFFFFF)',
      }}
    >
      {tasks.map((task, i) => (
        <TaskCardItem
          key={task._id}
          task={task}
          board={board}
          highlighted={highlightedTaskId === task._id}
          isLast={i === tasks.length - 1}
          pinnedForAll={task.pinned === true}
          pinnedForMe={personalPins?.has(task._id) || false}
          onOpenTask={onOpenTask}
          onStatusClick={onStatusClick}
          onPriorityClick={onPriorityClick}
          onLabelsClick={onLabelsClick}
          onActionsClick={onActionsClick}
          groupId={groupId}
          dndDisabled={dndDisabled}
        />
      ))}
    </ul>
  );
};

const TaskCardItem = ({
  task,
  board,
  highlighted,
  isLast,
  pinnedForAll,
  pinnedForMe,
  onOpenTask,
  onStatusClick,
  onPriorityClick,
  onLabelsClick,
  onActionsClick,
}) => {
  const liRef = useRef(null);

  useEffect(() => {
    if (!highlighted || !liRef.current) return;
    const el = liRef.current;
    const timer = setTimeout(() => {
      const rect = el.getBoundingClientRect();
      const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
      const targetY = scrollTop + rect.top - NAVBAR_HEIGHT - (window.innerHeight / 2 - el.offsetHeight / 2);
      window.scrollTo({ top: Math.max(0, targetY), behavior: 'smooth' });
    }, 100);
    return () => clearTimeout(timer);
  }, [highlighted]);

  return (
    <li
      ref={liRef}
      data-task-id={task._id}
      className={highlighted ? 'macan-task-highlight' : ''}
      style={{ borderBottom: isLast ? 'none' : '1px solid var(--color-border)' }}
    >
      <TaskCard
        task={task}
        board={board}
        pinnedForAll={pinnedForAll}
        pinnedForMe={pinnedForMe}
        onOpen={onOpenTask}
        onStatusClick={onStatusClick}
        onPriorityClick={onPriorityClick}
        onLabelsClick={onLabelsClick}
        onActionsClick={onActionsClick}
      />
    </li>
  );
};

/**
 * Single stacked card showing a task's core attributes. Tapping the name
 * opens the comment panel; tapping the status chip (or the ⋯ button for
 * admins) opens the corresponding menu.
 */
const TaskCard = ({ task, board, pinnedForAll = false, pinnedForMe = false, onOpen, onStatusClick, onPriorityClick, onLabelsClick, onActionsClick }) => {
  const assignees = Array.isArray(task.assignedTo) ? task.assignedTo : [];
  const statusIsDone = (() => {
    if (board && Array.isArray(board.statuses) && task.status != null) {
      const match = board.statuses.find(
        (s) => s._id && s._id.toString() === task.status.toString()
      );
      if (match) return match.key === 'done';
    }
    return task.status === 'done';
  })();
  const overdue = isOverdue(task.dueDate) && !statusIsDone;
  const labels = Array.isArray(task.labels) ? task.labels : [];

  return (
    <div
      className="flex flex-col gap-2"
      style={{ padding: '14px 16px' }}
    >
      {/* Top row — task name + actions menu */}
      <div className="flex items-start justify-between gap-2">
        {/* Why this card is sitting at the top of its group. */}
        {(pinnedForAll || pinnedForMe) && (
          <span
            className="shrink-0 inline-flex items-center"
            title={
              pinnedForAll && pinnedForMe
                ? 'Pinned for the team, and by you'
                : pinnedForAll
                  ? 'Pinned for the team'
                  : 'Pinned for you only'
            }
            style={{ color: 'var(--color-accent)', marginTop: 3 }}
          >
            <Pin size={14} fill="currentColor" aria-hidden="true" />
            <span className="sr-only">Pinned to top</span>
          </span>
        )}
        <button
          type="button"
          onClick={() => onOpen?.(task)}
          className="text-left font-body transition-colors duration-150 hover:text-[color:var(--color-accent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
          style={{
            fontSize: 14,
            fontWeight: 500,
            color: 'var(--color-text-primary)',
            background: 'transparent',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
            flex: 1,
            minWidth: 0,
            lineHeight: 1.4,
            wordBreak: 'break-word',
          }}
        >
          {task.name}
        </button>
        {onActionsClick ? (
          <button
            type="button"
            onClick={(e) => onActionsClick(task, e)}
            aria-label="Task actions"
            className="flex items-center justify-center rounded-md transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)] shrink-0"
            style={{ width: 36, height: 36 }}
          >
            <MoreHorizontal
              size={16}
              color="var(--color-text-secondary)"
              aria-hidden="true"
            />
          </button>
        ) : null}
      </div>

      {/* Middle row — priority + status chips */}
      <div className="flex items-center gap-2 flex-wrap">
        {task.priority && (
          <Chip
            type="priority"
            value={task.priority}
            onClick={
              onPriorityClick ? (e) => onPriorityClick(task, e) : undefined
            }
          />
        )}
        <Chip
          type="status"
          value={task.status || 'not_started'}
          board={board}
          onClick={
            onStatusClick ? (e) => onStatusClick(task, e) : undefined
          }
        />
        {labels.length > 0 && labels.slice(0, 2).map((labelId) => (
          <Chip
            key={labelId.toString()}
            type="label"
            value={labelId}
            board={board}
            onClick={
              onLabelsClick ? (e) => onLabelsClick(task, e) : undefined
            }
          />
        ))}
        {labels.length > 2 && (
          <span
            className="inline-flex items-center font-body font-medium"
            onClick={onLabelsClick ? (e) => onLabelsClick(task, e) : undefined}
            style={{
              fontSize: 11,
              padding: '3px 8px',
              borderRadius: 'var(--radius-full)',
              background: 'var(--color-bg-subtle)',
              color: 'var(--color-text-secondary)',
              cursor: onLabelsClick ? 'pointer' : 'default',
            }}
          >
            +{labels.length - 2}
          </span>
        )}
      </div>

      {/* Bottom row — owner + due date */}
      <div className="flex items-center justify-between gap-3">
        {/* Owner */}
        <div className="min-w-0 flex-1">
          {assignees.length > 0 ? (
            <AssigneeStack assignees={assignees} />
          ) : (
            <span
              className="font-body"
              style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
            >
              Unassigned
            </span>
          )}
        </div>

        {/* Due date */}
        {task.dueDate ? (
          <span
            className="inline-flex items-center gap-1 font-body shrink-0"
            style={{
              fontSize: 12,
              fontWeight: overdue ? 600 : 500,
              color: overdue
                ? 'var(--color-status-stuck)'
                : 'var(--color-text-secondary)',
            }}
          >
            <CalendarIcon size={12} aria-hidden="true" />
            {formatShortDate(task.dueDate)}
          </span>
        ) : (
          <span
            className="font-body shrink-0"
            style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
          >
            No due date
          </span>
        )}
      </div>
    </div>
  );
};

/**
 * Stacked avatar display for a task's assignees. Up to 3 avatars visible,
 * followed by a "+N" bubble. When there's exactly one assignee, their name
 * is shown alongside the avatar.
 */
const AssigneeStack = ({ assignees }) => {
  const visible = assignees.slice(0, 3);
  const remaining = assignees.length - visible.length;
  const first = assignees[0];
  const firstName = (first && first.name) || '';

  return (
    <div className="flex items-center gap-2 min-w-0">
      <div className="flex items-center">
        {visible.map((u, i) => (
          <Avatar
            key={u._id || i}
            user={u}
            style={{
              marginLeft: i === 0 ? 0 : -8,
              zIndex: visible.length - i,
            }}
          />
        ))}
        {remaining > 0 && (
          <span
            className="inline-flex items-center justify-center font-body font-semibold"
            style={{
              width: 22,
              height: 22,
              marginLeft: -8,
              borderRadius: '50%',
              background: 'var(--color-bg-subtle)',
              color: 'var(--color-text-secondary)',
              fontSize: 10,
              border: '2px solid var(--color-bg-surface, #FFFFFF)',
            }}
          >
            +{remaining}
          </span>
        )}
      </div>
      {assignees.length === 1 && firstName && (
        <span
          className="font-body truncate"
          style={{
            fontSize: 12,
            fontWeight: 500,
            color: 'var(--color-text-primary)',
          }}
        >
          {firstName}
        </span>
      )}
    </div>
  );
};

const Avatar = ({ user, style = {} }) => {
  const [imgError, setImgError] = useState(false);
  const name = user?.name || '';
  const initial = name.charAt(0).toUpperCase() || '?';
  const hasPic = !!user?.profilePic && !imgError;

  const base = {
    width: 22,
    height: 22,
    borderRadius: '50%',
    border: '2px solid var(--color-bg-surface, #FFFFFF)',
    flexShrink: 0,
    ...style,
  };

  if (hasPic) {
    return (
      <img
        src={user.profilePic}
        alt={name}
        style={{ ...base, objectFit: 'cover' }}
        onError={() => setImgError(true)}
      />
    );
  }

  return (
    <span
      aria-label={name}
      className="inline-flex items-center justify-center font-body font-semibold"
      style={{
        ...base,
        background: 'var(--color-accent-light)',
        color: 'var(--color-accent-text)',
        fontSize: 10,
      }}
    >
      {initial}
    </span>
  );
};

export default TaskCardList;
