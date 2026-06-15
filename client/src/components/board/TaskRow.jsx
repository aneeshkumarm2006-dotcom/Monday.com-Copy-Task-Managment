import { useEffect, useMemo, useRef, useState } from 'react';
import {
  MoreHorizontal,
  MessageSquare,
  Plus,
  Check,
  ChevronRight,
  CornerDownRight,
  GripVertical,
  ListTree,
} from 'lucide-react';
import Chip from '../ui/Chip';
import DatePickerPopover from '../ui/DatePickerPopover';
import { isOverdue } from '../../utils/dateUtils';
import { isStatusDone } from '../../utils/statusUtils';

const NAVBAR_HEIGHT = 56;

const toYMD = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * TaskRow — a single row in the board task table.
 *
 * Columns:
 *   [Checkbox 40] [Name flex] [Priority 130] [Status 160]
 *   [Labels 180] [Owner 160] [Due 140] [Comments 48] [Actions 48]
 */
const TaskRow = ({
  task,
  board = null,
  selected = false,
  onSelect,
  onOpen,
  onStatusClick,
  onPriorityClick,
  onLabelsClick,
  onOwnerClick,
  onActionsClick,
  onDueDateChange,
  onToggleExpand,
  expanded = false,
  isLast = false,
  highlighted = false,
  // When true this row is a subtask rendered beneath an expanded parent: the
  // name cell is indented with a connector, the drag handle + select checkbox
  // are suppressed, and the row carries a subtle tinted background so the
  // hierarchy reads at a glance.
  isSubtask = false,
  // Sortable wiring (optional): when provided, the row participates in
  // @dnd-kit drag-and-drop. The drag handle owns the listeners so clicking
  // anywhere else still routes to the existing handlers.
  sortableRef,
  sortableStyle,
  sortableAttributes,
  dragHandleRef,
  dragHandleListeners,
  isDragging = false,
  dndDisabled = false,
}) => {
  const rowRef = useRef(null);
  const assignees = Array.isArray(task.assignedTo) ? task.assignedTo : [];
  const overdue = isOverdue(task.dueDate) && !isStatusDone(board, task.status);
  const labels = Array.isArray(task.labels) ? task.labels : [];
  const commentCount =
    typeof task.commentCount === 'number' ? task.commentCount : 0;
  const subitemCount =
    typeof task.subitemCount === 'number' ? task.subitemCount : 0;

  // Merge sortable ref with the internal rowRef used for highlight scrolling.
  const setRowRefs = (el) => {
    rowRef.current = el;
    if (typeof sortableRef === 'function') sortableRef(el);
  };

  useEffect(() => {
    if (!highlighted || !rowRef.current) return;
    const el = rowRef.current;
    const timer = setTimeout(() => {
      const rect = el.getBoundingClientRect();
      const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
      const targetY = scrollTop + rect.top - NAVBAR_HEIGHT - (window.innerHeight / 2 - el.offsetHeight / 2);
      window.scrollTo({ top: Math.max(0, targetY), behavior: 'smooth' });
    }, 100);
    return () => clearTimeout(timer);
  }, [highlighted]);

  const handleRowClick = (e) => {
    if (e.target.closest('button, input, a, label, [role="button"], [data-row-click-ignore]')) {
      return;
    }
    onOpen?.(task);
  };

  return (
    <tr
      ref={setRowRefs}
      data-task-id={task._id}
      onClick={handleRowClick}
      className={[
        'group/task-row transition-colors duration-100 hover:bg-[color:var(--color-bg-subtle)] cursor-pointer',
        highlighted ? 'macan-task-highlight' : '',
      ].join(' ')}
      style={{
        ...sortableStyle,
        height: 48,
        borderBottom: isLast ? 'none' : '1px solid var(--color-border)',
        background: sortableStyle?.background,
        opacity: isDragging ? 0.4 : sortableStyle?.opacity,
        position: isDragging ? 'relative' : sortableStyle?.position,
        zIndex: isDragging ? 20 : sortableStyle?.zIndex,
      }}
      {...(sortableAttributes || {})}
    >
      {/* Drag handle */}
      <td style={{ width: 24, padding: '0 0 0 8px' }}>
        {!dndDisabled && !isSubtask && (
          <button
            ref={dragHandleRef}
            type="button"
            aria-label="Drag to reorder task"
            {...(dragHandleListeners || {})}
            onClick={(e) => e.stopPropagation()}
            data-row-click-ignore
            className="flex items-center justify-center opacity-0 group-hover/task-row:opacity-100 focus-visible:opacity-100 transition-opacity duration-150"
            style={{
              width: 16,
              height: 24,
              cursor: 'grab',
              touchAction: 'none',
              background: 'transparent',
              border: 'none',
              padding: 0,
            }}
          >
            <GripVertical size={14} color="var(--color-text-muted)" aria-hidden="true" />
          </button>
        )}
      </td>

      {/* Checkbox — suppressed for subtasks (bulk selection only spans
          top-level tasks). The cell is kept for column alignment. */}
      <td style={{ width: 40, padding: '0 0 0 16px' }}>
        {!isSubtask && (
          <input
            type="checkbox"
            checked={selected}
            onChange={(e) => onSelect?.(task._id, e.target.checked)}
            aria-label={`Select ${task.name}`}
            style={{
              width: 16,
              height: 16,
              accentColor: 'var(--color-accent)',
              cursor: 'pointer',
            }}
          />
        )}
      </td>

      {/* Task Name */}
      <td style={{ padding: '0 16px', minWidth: 240 }}>
        <div
          className="flex items-center gap-2 min-w-0"
          style={isSubtask ? { paddingLeft: 28 } : undefined}
        >
          {isSubtask ? (
            <CornerDownRight
              size={14}
              aria-hidden="true"
              style={{ color: 'var(--color-text-muted)', flexShrink: 0 }}
            />
          ) : null}
          {onToggleExpand ? (
            <button
              type="button"
              onClick={() => onToggleExpand(task._id)}
              aria-label={expanded ? 'Collapse subitems' : 'Expand subitems'}
              aria-expanded={expanded}
              title={
                task.hasSubitems
                  ? expanded
                    ? 'Hide subitems'
                    : 'Show subitems'
                  : 'Add subitems'
              }
              className="flex items-center justify-center rounded transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
              style={{
                width: 18,
                height: 18,
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                // Dim the chevron for rows that have no subtasks yet so the
                // table stays calm; it still reads as an actionable affordance
                // on hover/focus.
                color: task.hasSubitems
                  ? 'var(--color-text-secondary)'
                  : 'var(--color-text-muted)',
                flexShrink: 0,
                padding: 0,
                transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
                transition: 'transform 150ms ease',
              }}
            >
              <ChevronRight size={14} aria-hidden="true" />
            </button>
          ) : null}
          {!isSubtask && task.hasSubitems ? (
            onToggleExpand ? (
              <button
                type="button"
                onClick={() => onToggleExpand(task._id)}
                aria-label={
                  subitemCount > 0
                    ? `${expanded ? 'Hide' : 'Show'} subtasks (${subitemCount})`
                    : expanded
                      ? 'Hide subtasks'
                      : 'Show subtasks'
                }
                aria-expanded={expanded}
                title={expanded ? 'Hide subtasks' : 'Show subtasks'}
                className="flex items-center justify-center rounded transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
                style={{
                  position: 'relative',
                  background: 'transparent',
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  color: 'var(--color-text-secondary)',
                  flexShrink: 0,
                }}
              >
                <ListTree size={14} aria-hidden="true" />
                <SubitemCountBadge count={subitemCount} />
              </button>
            ) : (
              <span
                aria-label={
                  subitemCount > 0
                    ? `Has ${subitemCount} subtasks`
                    : 'Has subtasks'
                }
                className="inline-flex items-center justify-center"
                style={{ position: 'relative', color: 'var(--color-text-secondary)', flexShrink: 0 }}
              >
                <ListTree size={14} aria-hidden="true" />
                <SubitemCountBadge count={subitemCount} />
              </span>
            )
          ) : null}
          <ChecklistBadge checklist={task.checklist} />
          <button
            type="button"
            onClick={() => onOpen?.(task)}
            className="text-left font-body transition-colors duration-150 hover:underline hover:text-[color:var(--color-accent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)] truncate flex-1 min-w-0"
            style={{
              fontSize: 14,
              fontWeight: 500,
              color: 'var(--color-text-primary)',
              background: 'transparent',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
            }}
          >
            {task.name}
          </button>
        </div>
      </td>

      {/* Priority */}
      <td style={{ width: 130, padding: '0 16px' }}>
        {task.priority ? (
          <Chip
            type="priority"
            value={task.priority}
            onClick={
              onPriorityClick ? (e) => onPriorityClick(task, e) : undefined
            }
          />
        ) : (
          <button
            type="button"
            onClick={onPriorityClick ? (e) => onPriorityClick(task, e) : undefined}
            className="font-body transition-colors duration-150 hover:text-[color:var(--color-accent)]"
            style={{
              fontSize: 13,
              color: 'var(--color-text-muted)',
              background: 'transparent',
              border: 'none',
              padding: 0,
              cursor: onPriorityClick ? 'pointer' : 'default',
            }}
          >
            —
          </button>
        )}
      </td>

      {/* Status */}
      <td style={{ width: 160, padding: '0 16px' }}>
        <Chip
          type="status"
          value={task.status || 'not_started'}
          board={board}
          onClick={
            onStatusClick ? (e) => onStatusClick(task, e) : undefined
          }
        />
      </td>

      {/* Labels */}
      <td style={{ width: 180, padding: '0 16px' }}>
        <LabelsCell
          board={board}
          labels={labels}
          onClick={onLabelsClick ? (e) => onLabelsClick(task, e) : undefined}
        />
      </td>

      {/* Owner / Assigned to */}
      <td style={{ width: 160, padding: '0 16px' }}>
        <div
          role={onOwnerClick ? 'button' : undefined}
          tabIndex={onOwnerClick ? 0 : undefined}
          onClick={onOwnerClick ? (e) => onOwnerClick(task, e) : undefined}
          onKeyDown={onOwnerClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') onOwnerClick(task, e); } : undefined}
          className={onOwnerClick ? 'rounded transition-colors hover:bg-[color:var(--color-bg-subtle)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)]' : undefined}
          style={{ cursor: onOwnerClick ? 'pointer' : 'default', padding: '2px 4px', margin: '-2px -4px', display: 'inline-flex', alignItems: 'center' }}
          data-row-click-ignore
        >
          {assignees.length > 0 ? (
            <AssigneeStack assignees={assignees} />
          ) : (
            <span
              className="font-body"
              style={{ fontSize: 13, color: 'var(--color-text-muted)' }}
            >
              Unassigned
            </span>
          )}
        </div>
      </td>

      {/* Due Date */}
      <td style={{ width: 140, padding: '0 16px' }}>
        <DatePickerPopover
          variant="inline"
          value={toYMD(task.dueDate)}
          overdue={overdue}
          onChange={(v) => onDueDateChange?.(task, v)}
        />
      </td>

      {/* Comments */}
      <td style={{ width: 48, padding: '0 8px' }}>
        <button
          type="button"
          onClick={() => onOpen?.(task)}
          aria-label={
            commentCount > 0
              ? `Open comments (${commentCount})`
              : 'Open comments'
          }
          className="flex items-center justify-center rounded transition-colors duration-150 hover:bg-[color:var(--color-border)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
          style={{ position: 'relative', width: 28, height: 28, margin: '0 auto', background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }}
        >
          <MessageSquare size={15} color="var(--color-text-secondary)" aria-hidden="true" />
          {commentCount > 0 && (
            <span
              aria-hidden="true"
              style={{
                position: 'absolute',
                top: -3,
                right: -3,
                minWidth: 15,
                height: 15,
                padding: '0 3px',
                boxSizing: 'border-box',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 9999,
                background: 'var(--color-accent)',
                color: '#FFFFFF',
                fontSize: 9,
                fontWeight: 700,
                lineHeight: 1,
                border: '1.5px solid var(--color-bg-surface, #FFFFFF)',
              }}
            >
              {commentCount > 9 ? '9+' : commentCount}
            </span>
          )}
        </button>
      </td>

      {/* Actions */}
      <td style={{ width: 48, padding: '0 8px 0 0' }}>
        {onActionsClick ? (
          <button
            type="button"
            onClick={(e) => onActionsClick(task, e)}
            aria-label="Task actions"
            className="flex items-center justify-center rounded-md transition-colors duration-150 hover:bg-[color:var(--color-border)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
            style={{ width: 28, height: 28, marginLeft: 'auto' }}
          >
            <MoreHorizontal
              size={16}
              color="var(--color-text-secondary)"
              aria-hidden="true"
            />
          </button>
        ) : null}
      </td>
    </tr>
  );
};

/**
 * Tiny count bubble pinned to the top-right of the subtask (ListTree) icon,
 * mirroring the comment-count badge so the two read as the same affordance.
 * Hidden when there are no subitems.
 */
const SubitemCountBadge = ({ count }) => {
  if (!count || count < 1) return null;
  return (
    <span
      aria-hidden="true"
      style={{
        position: 'absolute',
        top: -6,
        right: -6,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'transparent',
        color: 'var(--color-text-secondary)',
        fontSize: 9,
        fontWeight: 700,
        lineHeight: 1,
      }}
    >
      {count > 9 ? '9+' : count}
    </span>
  );
};

/**
 * Inline 20px progress ring shown to the left of the task name when the
 * task has any checklist items. Fills clockwise green proportional to the
 * done/total ratio; full green with a check icon at 100%.
 */
const ChecklistBadge = ({ checklist }) => {
  const { total, done } = useMemo(() => {
    const list = Array.isArray(checklist) ? checklist : [];
    return {
      total: list.length,
      done: list.filter((it) => it && it.done).length,
    };
  }, [checklist]);

  if (total === 0) return null;

  const size = 20;
  const stroke = 3;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const ratio = done / total;
  const complete = done === total;
  const dashOffset = circumference * (1 - ratio);

  return (
    <span
      className="inline-flex items-center justify-center shrink-0"
      style={{ width: size, height: size, position: 'relative' }}
      title={`${done} / ${total} complete`}
      aria-label={`${done} of ${total} checklist items complete`}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-hidden="true"
        style={{ transform: 'rotate(-90deg)' }}
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill={complete ? 'var(--color-status-done, #00C875)' : 'transparent'}
          stroke="var(--color-border-strong, #D1D5DB)"
          strokeWidth={stroke}
        />
        {!complete && ratio > 0 && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="transparent"
            stroke="var(--color-status-done, #00C875)"
            strokeWidth={stroke}
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            strokeLinecap="round"
          />
        )}
      </svg>
      {complete && (
        <Check
          size={11}
          strokeWidth={3}
          color="#FFFFFF"
          aria-hidden="true"
          style={{ position: 'absolute' }}
        />
      )}
    </span>
  );
};

/**
 * Compact horizontal stack of label chips. Renders up to 2 chips inline,
 * with a `+N` overflow bubble for the remainder. When the task has no
 * labels yet, surfaces a small `+` affordance.
 */
const LabelsCell = ({ board, labels, onClick }) => {
  if (!labels || labels.length === 0) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label="Add labels"
        className="inline-flex items-center justify-center rounded transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)]"
        style={{
          width: 22,
          height: 22,
          background: 'transparent',
          border: '1px dashed var(--color-border-strong)',
          cursor: onClick ? 'pointer' : 'default',
          color: 'var(--color-text-muted)',
        }}
      >
        <Plus size={12} aria-hidden="true" />
      </button>
    );
  }

  const visible = labels.slice(0, 2);
  const remaining = labels.length - visible.length;

  return (
    <div
      role={onClick ? 'button' : undefined}
      onClick={onClick}
      className="flex items-center gap-1 flex-wrap"
      style={{ cursor: onClick ? 'pointer' : 'default' }}
    >
      {visible.map((labelId) => (
        <Chip
          key={labelId.toString()}
          type="label"
          value={labelId}
          board={board}
        />
      ))}
      {remaining > 0 && (
        <span
          className="inline-flex items-center font-body font-medium"
          style={{
            fontSize: 11,
            padding: '3px 6px',
            borderRadius: 'var(--radius-full)',
            background: 'var(--color-bg-subtle)',
            color: 'var(--color-text-secondary)',
          }}
        >
          +{remaining}
        </span>
      )}
    </div>
  );
};

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
              width: 24,
              height: 24,
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
            fontSize: 13,
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
    width: 24,
    height: 24,
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

export default TaskRow;
