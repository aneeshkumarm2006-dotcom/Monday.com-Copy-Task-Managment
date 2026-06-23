import { useEffect, useState, useCallback, useMemo } from 'react';
import { Calendar, momentLocalizer } from 'react-big-calendar';
import moment from 'moment';
import 'react-big-calendar/lib/css/react-big-calendar.css';
import {
  Plus,
  ClipboardList,
  Trash2,
  Pencil,
  Calendar as CalendarIcon,
  StickyNote,
  ChevronLeft,
  ChevronRight,
  Briefcase,
  FolderOpen,
  ExternalLink,
  Filter,
  X,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import PageWrapper from '../components/layout/PageWrapper';
import PersonalTaskModal from '../components/board/PersonalTaskModal';
import CommentPanel from '../components/board/CommentPanel';
import MyWorkFilterBar from '../components/board/MyWorkFilterBar';
import CalendarThemeStyles from '../components/calendar/CalendarThemeStyles';
import Chip from '../components/ui/Chip';
import Button from '../components/ui/Button';
import useOrgStore from '../store/orgStore';
import { getMyTasks, updateTask, deleteTask } from '../services/taskService';
import { isStatusDone } from '../utils/statusUtils';
import { taskToEvent, eventPropGetter } from '../utils/calendarEvents';
import { PRIORITY_COLORS } from '../utils/priorityColors';
import {
  EMPTY_WORK_FILTERS,
  workTaskMatchesFilters,
  countActiveWorkFilters,
} from '../utils/myWorkFilters';

const localizer = momentLocalizer(moment);

const STATUSES = [
  { value: 'not_started', label: 'Not Started' },
  { value: 'working_on_it', label: 'Working on it' },
  { value: 'done', label: 'Done' },
  { value: 'stuck', label: 'Stuck' },
];

const PRIORITIES = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'critical', label: 'Critical' },
];

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const formatDate = (dateStr) => {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
};

/* ------------------------------------------------------------------ */
/* Sub-tab navigation                                                  */
/* ------------------------------------------------------------------ */

const SUB_TABS = [
  { key: 'work', label: 'My Work' },
  { key: 'personal', label: 'Personal Tasks' },
  { key: 'calendar', label: 'Calendar' },
];

const SubTabs = ({ active, onChange, counts }) => (
  <div
    role="tablist"
    aria-label="My Work views"
    className="flex items-center gap-1 mt-6"
    style={{ borderBottom: '1px solid var(--color-border)' }}
  >
    {SUB_TABS.map((t) => {
      const isActive = t.key === active;
      const count = counts[t.key];
      return (
        <button
          key={t.key}
          role="tab"
          aria-selected={isActive}
          type="button"
          onClick={() => onChange(t.key)}
          className="relative font-body font-medium text-[14px] px-3 py-2.5 transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
          style={{
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            color: isActive
              ? 'var(--color-accent)'
              : 'var(--color-text-secondary)',
            fontWeight: isActive ? 600 : 500,
          }}
        >
          {t.label}
          {typeof count === 'number' && (
            <span
              className="ml-1.5 font-body"
              style={{
                fontSize: 12,
                color: 'var(--color-text-muted)',
              }}
            >
              {count}
            </span>
          )}
          {isActive && (
            <span
              aria-hidden="true"
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: -1,
                height: 2,
                background: 'var(--color-accent)',
                borderRadius: 2,
              }}
            />
          )}
        </button>
      );
    })}
  </div>
);

/* ------------------------------------------------------------------ */
/* My Work tab — board tasks (not done) assigned to the user           */
/* ------------------------------------------------------------------ */

const WorkTaskCard = ({ task, onSelect }) => {
  const navigate = useNavigate();
  const boardId = task.board?._id || task.board;

  const handleOpenInBoard = (e) => {
    e.stopPropagation();
    if (boardId) {
      navigate(`/boards/${boardId}?highlightTask=${task._id}`);
    }
  };

  return (
  <button
    type="button"
    onClick={() => onSelect(task)}
    className="w-full text-left bg-surface transition-shadow duration-150 hover:shadow-[var(--shadow-md)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
    style={{
      borderRadius: 'var(--radius-lg)',
      boxShadow: 'var(--shadow-card)',
      padding: '16px 20px',
      border: 'none',
      cursor: 'pointer',
    }}
  >
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <p
            className="font-body font-semibold truncate"
            style={{ fontSize: 15, color: 'var(--color-text-primary)' }}
          >
            {task.name}
          </p>
          {boardId && (
            <span
              role="button"
              tabIndex={0}
              title="Open in board"
              aria-label="Open in board"
              onClick={handleOpenInBoard}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') handleOpenInBoard(e);
              }}
              className="shrink-0 inline-flex items-center justify-center rounded transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--color-accent)]"
              style={{ padding: 4, cursor: 'pointer', color: 'var(--color-text-muted)' }}
            >
              <ExternalLink size={14} />
            </span>
          )}
        </div>
        {task.board?.name && (
          <div className="flex items-center gap-1.5 mt-1.5">
            <Briefcase size={13} color="var(--color-text-muted)" />
            <span
              className="font-body truncate"
              style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
            >
              {task.board.name}
            </span>
          </div>
        )}
        {task.group?.name && (
          <div className="flex items-center gap-1.5 mt-1.5">
            <FolderOpen size={13} color="var(--color-text-muted)" />
            <span
              className="font-body truncate"
              style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
            >
              {task.group.name}
            </span>
          </div>
        )}
        {task.dueDate && (
          <div className="flex items-center gap-1.5 mt-1.5">
            <CalendarIcon size={13} color="var(--color-text-muted)" />
            <span
              className="font-body"
              style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
            >
              {formatDate(task.dueDate)}
            </span>
          </div>
        )}
      </div>
    </div>

    <div className="flex items-center gap-2 mt-3 flex-wrap">
      <Chip type="status" value={task.status} board={task.board} />
      <Chip type="priority" value={task.priority} />
    </div>
  </button>
  );
};

const WorkTab = ({ tasks, loading, onSelect, hasFilters, onClearFilters }) => {
  if (loading) {
    return (
      <div className="flex flex-col gap-3 mt-6">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="animate-pulse bg-surface"
            style={{
              height: 80,
              borderRadius: 'var(--radius-lg)',
              boxShadow: 'var(--shadow-card)',
            }}
          />
        ))}
      </div>
    );
  }

  // No tasks match the active filters — distinct from "all caught up" so the
  // user knows work exists, just not in this slice.
  if (tasks.length === 0 && hasFilters) {
    return (
      <div
        className="flex flex-col items-center justify-center"
        style={{ padding: '64px 20px' }}
      >
        <p
          className="font-body font-medium"
          style={{ fontSize: 15, color: 'var(--color-text-primary)' }}
        >
          No tasks match these filters
        </p>
        <p
          className="font-body mt-1.5"
          style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}
        >
          Try removing a filter to see more of your work.
        </p>
        <button
          type="button"
          onClick={onClearFilters}
          className="mt-4 inline-flex items-center gap-1 font-body font-semibold transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
          style={{
            height: 34,
            padding: '0 14px',
            fontSize: 13,
            color: 'var(--color-accent)',
            background: 'transparent',
            border: '1.5px solid var(--color-border-strong)',
            borderRadius: 'var(--radius-md)',
            cursor: 'pointer',
          }}
        >
          <X size={14} aria-hidden="true" />
          Clear all filters
        </button>
      </div>
    );
  }

  if (tasks.length === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center"
        style={{ padding: '80px 20px' }}
      >
        <div
          className="flex items-center justify-center"
          style={{
            width: 64,
            height: 64,
            borderRadius: 'var(--radius-full)',
            background: 'var(--color-accent-light)',
            marginBottom: 20,
          }}
        >
          <Briefcase size={28} color="var(--color-accent)" />
        </div>
        <h3
          className="font-display font-bold"
          style={{ fontSize: 18, color: 'var(--color-text-primary)' }}
        >
          You're all caught up
        </h3>
        <p
          className="font-body mt-2"
          style={{
            fontSize: 14,
            color: 'var(--color-text-secondary)',
            maxWidth: 360,
            textAlign: 'center',
          }}
        >
          No open board tasks are assigned to you. Tasks you still need to
          finish will show up here.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 mt-6">
      {tasks.map((task) => (
        <WorkTaskCard key={task._id} task={task} onSelect={onSelect} />
      ))}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Personal tasks tab                                                  */
/* ------------------------------------------------------------------ */

const FILTER_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'not_started', label: 'Not Started' },
  { value: 'working_on_it', label: 'Working on it' },
  { value: 'done', label: 'Done' },
  { value: 'stuck', label: 'Stuck' },
];

const EmptyState = ({ onAdd }) => (
  <div
    className="flex flex-col items-center justify-center"
    style={{ padding: '80px 20px' }}
  >
    <div
      className="flex items-center justify-center"
      style={{
        width: 64,
        height: 64,
        borderRadius: 'var(--radius-full)',
        background: 'var(--color-accent-light)',
        marginBottom: 20,
      }}
    >
      <ClipboardList size={28} color="var(--color-accent)" />
    </div>
    <h3
      className="font-display font-bold"
      style={{ fontSize: 18, color: 'var(--color-text-primary)' }}
    >
      No personal tasks yet
    </h3>
    <p
      className="font-body mt-2"
      style={{
        fontSize: 14,
        color: 'var(--color-text-secondary)',
        maxWidth: 360,
        textAlign: 'center',
      }}
    >
      Create tasks that only you can see. Perfect for personal to-dos,
      reminders, and notes.
    </p>
    <div className="mt-6">
      <Button variant="primary" icon={Plus} onClick={onAdd}>
        Add Task
      </Button>
    </div>
  </div>
);

const TaskCard = ({ task, onStatusChange, onPriorityChange, onDelete, onEdit }) => {
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await onDelete(task._id);
    } catch {
      setDeleting(false);
    }
  };

  return (
    <div
      className="bg-surface"
      style={{
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-card)',
        padding: '16px 20px',
        opacity: deleting ? 0.5 : 1,
        transition: 'opacity 150ms',
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p
            className="font-body font-semibold"
            style={{
              fontSize: 15,
              color: 'var(--color-text-primary)',
              textDecoration:
                task.status === 'done' ? 'line-through' : 'none',
            }}
          >
            {task.name}
          </p>

          {task.note && (
            <div className="flex items-start gap-1.5 mt-2">
              <StickyNote
                size={13}
                color="var(--color-text-muted)"
                className="shrink-0 mt-0.5"
              />
              <p
                className="font-body"
                style={{
                  fontSize: 13,
                  color: 'var(--color-text-secondary)',
                  lineHeight: 1.5,
                }}
              >
                {task.note}
              </p>
            </div>
          )}

          {task.dueDate && (
            <div className="flex items-center gap-1.5 mt-2">
              <CalendarIcon size={13} color="var(--color-text-muted)" />
              <span
                className="font-body"
                style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
              >
                {formatDate(task.dueDate)}
              </span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => onEdit(task)}
            disabled={deleting}
            aria-label="Edit task"
            className="flex items-center justify-center rounded-md transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)]"
            style={{ width: 32, height: 32 }}
          >
            <Pencil size={16} color="var(--color-text-muted)" />
          </button>
          <button
            type="button"
            onClick={handleDelete}
            disabled={deleting}
            aria-label="Delete task"
            className="flex items-center justify-center rounded-md transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)]"
            style={{ width: 32, height: 32 }}
          >
            <Trash2 size={16} color="var(--color-text-muted)" />
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2 mt-3 flex-wrap">
        <StatusDropdown
          value={task.status}
          onChange={(val) => onStatusChange(task._id, val)}
        />
        <PriorityDropdown
          value={task.priority}
          onChange={(val) => onPriorityChange(task._id, val)}
        />
      </div>
    </div>
  );
};

const StatusDropdown = ({ value, onChange }) => {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <Chip
        type="status"
        value={value}
        onClick={() => setOpen((v) => !v)}
      />
      {open && (
        <DropdownMenu
          items={STATUSES}
          selected={value}
          onSelect={(val) => {
            onChange(val);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
};

const PriorityDropdown = ({ value, onChange }) => {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <Chip
        type="priority"
        value={value}
        onClick={() => setOpen((v) => !v)}
      />
      {open && (
        <DropdownMenu
          items={PRIORITIES}
          selected={value}
          onSelect={(val) => {
            onChange(val);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
};

const DropdownMenu = ({ items, selected, onSelect, onClose }) => {
  useEffect(() => {
    const handleClick = () => onClose();
    // Delay attaching so the opening click doesn't immediately close
    const t = setTimeout(() => document.addEventListener('click', handleClick), 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener('click', handleClick);
    };
  }, [onClose]);

  return (
    <div
      className="absolute left-0 top-full mt-1 z-50 bg-white overflow-hidden"
      style={{
        minWidth: 140,
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-lg)',
      }}
    >
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          onClick={() => onSelect(item.value)}
          className="w-full text-left px-3 py-2 font-body text-[13px] transition-colors duration-100 hover:bg-[color:var(--color-bg-subtle)]"
          style={{
            color: 'var(--color-text-primary)',
            fontWeight: item.value === selected ? 600 : 400,
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
};

const PersonalTab = ({
  tasks,
  loading,
  filter,
  onFilterChange,
  onAdd,
  onStatusChange,
  onPriorityChange,
  onDelete,
  onEdit,
}) => {
  const filtered =
    filter === 'all' ? tasks : tasks.filter((t) => t.status === filter);

  return (
    <>
      {/* Filter bar */}
      {tasks.length > 0 && (
        <div className="flex items-center gap-2 mt-6 flex-wrap">
          {FILTER_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => onFilterChange(opt.value)}
              className="font-body text-[13px] font-medium px-3 py-1.5 transition-colors duration-150"
              style={{
                borderRadius: 'var(--radius-full)',
                background:
                  filter === opt.value
                    ? 'var(--color-accent)'
                    : 'var(--color-bg-subtle)',
                color:
                  filter === opt.value
                    ? '#FFFFFF'
                    : 'var(--color-text-secondary)',
                border: 'none',
                cursor: 'pointer',
              }}
            >
              {opt.label}
              {opt.value === 'all' && ` (${tasks.length})`}
            </button>
          ))}
        </div>
      )}

      <div className="mt-6">
        {loading ? (
          <div className="flex flex-col gap-3">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="animate-pulse bg-surface"
                style={{
                  height: 80,
                  borderRadius: 'var(--radius-lg)',
                  boxShadow: 'var(--shadow-card)',
                }}
              />
            ))}
          </div>
        ) : tasks.length === 0 ? (
          <EmptyState onAdd={onAdd} />
        ) : filtered.length === 0 ? (
          <p
            className="font-body text-center"
            style={{
              fontSize: 14,
              color: 'var(--color-text-muted)',
              padding: '40px 0',
            }}
          >
            No tasks match this filter.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {filtered.map((task) => (
              <TaskCard
                key={task._id}
                task={task}
                onStatusChange={onStatusChange}
                onPriorityChange={onPriorityChange}
                onDelete={onDelete}
                onEdit={onEdit}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
};

/* ------------------------------------------------------------------ */
/* Calendar tab — board work + personal tasks of the current user      */
/* ------------------------------------------------------------------ */

// Priority filters render in severity order; each lights up in its own
// palette (from priorityColors) when active so the chip reads at a glance.
const PRIORITY_FILTERS = [
  { value: 'critical', label: 'Critical' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
];

const TYPE_FILTERS = [
  { value: 'board', label: 'Board work' },
  { value: 'personal', label: 'Personal' },
];

/**
 * A single toggleable filter pill. When `activeColor` is supplied the active
 * state uses that palette (used for priority chips); otherwise it falls back
 * to the accent colour.
 */
const FilterChip = ({ label, active, onClick, activeColor }) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    className="inline-flex items-center gap-1.5 font-body font-medium transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
    style={{
      fontSize: 12,
      height: 28,
      padding: '0 12px',
      borderRadius: 'var(--radius-full)',
      border: '1.5px solid',
      borderColor: active
        ? activeColor
          ? activeColor.text
          : 'var(--color-accent)'
        : 'var(--color-border)',
      background: active
        ? activeColor
          ? activeColor.bg
          : 'var(--color-accent-light)'
        : 'transparent',
      color: active
        ? activeColor
          ? activeColor.text
          : 'var(--color-accent)'
        : 'var(--color-text-secondary)',
      cursor: 'pointer',
    }}
  >
    {activeColor && (
      <span
        aria-hidden="true"
        className="shrink-0"
        style={{
          width: 8,
          height: 8,
          borderRadius: 'var(--radius-full)',
          background: activeColor.solid,
        }}
      />
    )}
    {label}
  </button>
);

const CalendarTab = ({ events, onSelect }) => {
  const [view, setView] = useState('month');
  const [date, setDate] = useState(() => new Date());
  // Filters — empty arrays mean "no constraint". Categories compose with AND;
  // values within a category are OR'd. `hideDone` strips completed tasks.
  const [priorityFilter, setPriorityFilter] = useState([]);
  const [typeFilter, setTypeFilter] = useState([]);
  const [hideDone, setHideDone] = useState(false);
  // Track viewport so the fixed-height grid can shrink on phones.
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth < 768 : false
  );

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const handler = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  const handleNavigate = (action) => {
    setDate((prev) => {
      const next = new Date(prev);
      const delta = action === 'PREV' ? -1 : 1;
      if (view === 'week') {
        next.setDate(prev.getDate() + delta * 7);
      } else {
        next.setMonth(prev.getMonth() + delta);
        next.setDate(1);
      }
      return next;
    });
  };

  const label =
    view === 'week'
      ? `${moment(date).startOf('week').format('MMM D')} – ${moment(date)
          .endOf('week')
          .format('MMM D, YYYY')}`
      : `${MONTH_NAMES[date.getMonth()]} ${date.getFullYear()}`;

  const toggleValue = (setter) => (value) =>
    setter((prev) =>
      prev.includes(value)
        ? prev.filter((v) => v !== value)
        : [...prev, value]
    );

  const togglePriority = toggleValue(setPriorityFilter);
  const toggleType = toggleValue(setTypeFilter);

  const filtersActive =
    priorityFilter.length > 0 || typeFilter.length > 0 || hideDone;

  const clearFilters = () => {
    setPriorityFilter([]);
    setTypeFilter([]);
    setHideDone(false);
  };

  // Apply filters to the events' underlying tasks (event.resource). Each
  // category is an OR set; categories AND together. (React Compiler memoizes
  // this automatically — no manual useMemo needed.)
  const visibleEvents = !filtersActive
    ? events
    : events.filter((e) => {
        const task = e.resource || {};
        if (priorityFilter.length && !priorityFilter.includes(task.priority)) {
          return false;
        }
        if (typeFilter.length) {
          const type = task.isPersonal ? 'personal' : 'board';
          if (!typeFilter.includes(type)) return false;
        }
        if (hideDone && isStatusDone(task.board, task.status)) return false;
        return true;
      });

  return (
    <div className="mt-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Filters */}
        <div className="flex flex-wrap items-center gap-1.5" role="region" aria-label="Calendar filters">
          <span
            className="inline-flex items-center gap-1.5 font-body font-medium"
            style={{
              fontSize: 12,
              color: 'var(--color-text-secondary)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              marginRight: 2,
            }}
          >
            <Filter size={13} aria-hidden="true" />
            Filter
          </span>

          {PRIORITY_FILTERS.map((p) => (
            <FilterChip
              key={p.value}
              label={p.label}
              active={priorityFilter.includes(p.value)}
              onClick={() => togglePriority(p.value)}
              activeColor={PRIORITY_COLORS[p.value]}
            />
          ))}

          <span
            aria-hidden="true"
            style={{
              width: 1,
              height: 18,
              background: 'var(--color-border)',
              margin: '0 4px',
            }}
          />

          {TYPE_FILTERS.map((t) => (
            <FilterChip
              key={t.value}
              label={t.label}
              active={typeFilter.includes(t.value)}
              onClick={() => toggleType(t.value)}
            />
          ))}

          <FilterChip
            label="Hide completed"
            active={hideDone}
            onClick={() => setHideDone((v) => !v)}
          />

          {filtersActive && (
            <button
              type="button"
              onClick={clearFilters}
              className="inline-flex items-center gap-1 font-body transition-colors duration-150 hover:text-[color:var(--color-accent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
              style={{
                fontSize: 12,
                color: 'var(--color-text-secondary)',
                background: 'transparent',
                border: 'none',
                padding: '4px 8px',
                cursor: 'pointer',
                borderRadius: 'var(--radius-full)',
              }}
            >
              <X size={12} aria-hidden="true" />
              Clear
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3">
        {/* Month/Week toggle */}
        <div
          className="flex items-center bg-surface"
          style={{
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-full)',
            padding: 2,
          }}
        >
          {[
            { value: 'month', label: 'Month' },
            { value: 'week', label: 'Week' },
          ].map((opt) => {
            const activeView = opt.value === view;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => setView(opt.value)}
                aria-pressed={activeView}
                className="font-body font-medium transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
                style={{
                  fontSize: 12,
                  height: 28,
                  padding: '0 14px',
                  borderRadius: 'var(--radius-full)',
                  background: activeView ? 'var(--color-accent)' : 'transparent',
                  color: activeView ? '#FFFFFF' : 'var(--color-text-secondary)',
                  border: 'none',
                  cursor: 'pointer',
                }}
              >
                {opt.label}
              </button>
            );
          })}
        </div>

        {/* Navigation */}
        <div
          className="flex items-center gap-1 bg-surface"
          style={{
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-full)',
            padding: '2px 6px',
          }}
        >
          <button
            type="button"
            onClick={() => handleNavigate('PREV')}
            aria-label="Previous"
            className="flex items-center justify-center rounded-full transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)]"
            style={{ width: 28, height: 28, border: 'none', background: 'transparent', cursor: 'pointer' }}
          >
            <ChevronLeft size={16} color="var(--color-text-secondary)" />
          </button>
          <span
            className="font-body font-medium"
            style={{
              fontSize: 13,
              color: 'var(--color-text-primary)',
              minWidth: 140,
              textAlign: 'center',
              padding: '0 8px',
            }}
          >
            {label}
          </span>
          <button
            type="button"
            onClick={() => handleNavigate('NEXT')}
            aria-label="Next"
            className="flex items-center justify-center rounded-full transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)]"
            style={{ width: 28, height: 28, border: 'none', background: 'transparent', cursor: 'pointer' }}
          >
            <ChevronRight size={16} color="var(--color-text-secondary)" />
          </button>
        </div>
        </div>
      </div>

      <div
        className="bg-surface macan-calendar-wrap mt-5"
        style={{
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-card)',
          padding: 12,
          position: 'relative',
        }}
      >
        {filtersActive && visibleEvents.length === 0 && (
          <div
            className="absolute inset-0 z-10 flex flex-col items-center justify-center text-center"
            style={{ padding: '24px', pointerEvents: 'none' }}
          >
            <p
              className="font-body font-medium"
              style={{ fontSize: 14, color: 'var(--color-text-secondary)' }}
            >
              No tasks match these filters
            </p>
          </div>
        )}
        <Calendar
          localizer={localizer}
          events={visibleEvents}
          date={date}
          view={view}
          onNavigate={setDate}
          onView={setView}
          onSelectEvent={(event) => onSelect(event.resource)}
          eventPropGetter={eventPropGetter}
          views={['month', 'week']}
          popup
          toolbar={false}
          // Shorter grid on mobile; desktop keeps its 640/720 heights.
          style={{
            height: isMobile
              ? (view === 'week' ? 480 : 520)
              : (view === 'week' ? 640 : 720),
          }}
        />
      </div>

      <CalendarThemeStyles />
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

const MyWorkPage = () => {
  const currentOrg = useOrgStore((s) => s.currentOrg);
  const orgId = currentOrg?._id || null;

  const [allTasks, setAllTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('work');
  const [modalOpen, setModalOpen] = useState(false);
  const [editingTask, setEditingTask] = useState(null);
  const [filter, setFilter] = useState('all');
  const [workFilters, setWorkFilters] = useState(EMPTY_WORK_FILTERS);
  const [selectedTask, setSelectedTask] = useState(null);

  const fetchTasks = useCallback(async () => {
    try {
      // getMyTasks returns the user's personal tasks plus the board tasks
      // assigned to them within the current org — a single source for all
      // three sub-tabs.
      const all = await getMyTasks(orgId);
      setAllTasks(all);
    } catch (err) {
      console.error('Failed to fetch tasks:', err);
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    // Re-scope board work when the active organisation changes.
    setLoading(true);
    fetchTasks();
  }, [fetchTasks]);

  // Board tasks assigned to the user that aren't done yet. Top-level only —
  // subitems are kept out of the list tabs (but still shown on the calendar).
  const workTasks = useMemo(
    () =>
      allTasks.filter(
        (t) => !t.isPersonal && !t.parent && !isStatusDone(t.board, t.status)
      ),
    [allTasks]
  );

  const workFiltersActive = countActiveWorkFilters(workFilters) > 0;

  // Apply the My Work filter bar to the assigned-task list.
  const filteredWorkTasks = useMemo(
    () =>
      workFiltersActive
        ? workTasks.filter((t) => workTaskMatchesFilters(t, workFilters))
        : workTasks,
    [workTasks, workFilters, workFiltersActive]
  );

  const personalTasks = useMemo(
    () => allTasks.filter((t) => t.isPersonal && !t.parent),
    [allTasks]
  );

  // Every task with a due date — board work + personal — for the calendar.
  const calendarEvents = useMemo(
    () => allTasks.filter((t) => t.dueDate).map(taskToEvent),
    [allTasks]
  );

  const handleStatusChange = async (taskId, newStatus) => {
    setAllTasks((prev) =>
      prev.map((t) => (t._id === taskId ? { ...t, status: newStatus } : t))
    );
    try {
      await updateTask(taskId, { status: newStatus });
    } catch {
      fetchTasks();
    }
  };

  const handlePriorityChange = async (taskId, newPriority) => {
    setAllTasks((prev) =>
      prev.map((t) => (t._id === taskId ? { ...t, priority: newPriority } : t))
    );
    try {
      await updateTask(taskId, { priority: newPriority });
    } catch {
      fetchTasks();
    }
  };

  const handleDelete = async (taskId) => {
    setAllTasks((prev) => prev.filter((t) => t._id !== taskId));
    await deleteTask(taskId);
  };

  // Generic patch used by the detail panel (status / priority edits). Updates
  // the task in `allTasks` and the open panel optimistically, then persists —
  // rolling both back if the request fails so the UI never lies.
  const handlePanelUpdate = useCallback(
    async (taskId, payload) => {
      let snapshot = null;
      setAllTasks((prev) => {
        snapshot = prev;
        return prev.map((t) => (t._id === taskId ? { ...t, ...payload } : t));
      });
      setSelectedTask((prev) =>
        prev && prev._id === taskId ? { ...prev, ...payload } : prev
      );
      try {
        await updateTask(taskId, payload);
      } catch (err) {
        if (snapshot) {
          setAllTasks(snapshot);
          const original = snapshot.find((t) => t._id === taskId) || null;
          setSelectedTask((prev) =>
            prev && prev._id === taskId ? original : prev
          );
        }
        throw err;
      }
    },
    []
  );

  const handleCreated = (task) => {
    setAllTasks((prev) => [task, ...prev]);
  };

  const handleUpdated = (task) => {
    setAllTasks((prev) => prev.map((t) => (t._id === task._id ? task : t)));
  };

  return (
    <PageWrapper>
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-3">
          <div
            className="flex items-center justify-center"
            style={{
              width: 40,
              height: 40,
              borderRadius: 'var(--radius-lg)',
              background: 'var(--color-accent-light)',
            }}
          >
            <Briefcase size={20} color="var(--color-accent)" />
          </div>
          <div>
            <h1
              className="font-display font-bold"
              style={{ fontSize: 22, color: 'var(--color-text-primary)' }}
            >
              My Work
            </h1>
            <p
              className="font-body"
              style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}
            >
              Your board tasks, personal to-dos, and calendar in one place
            </p>
          </div>
        </div>

        {activeTab === 'personal' && (
          <Button variant="primary" icon={Plus} onClick={() => setModalOpen(true)}>
            Add Task
          </Button>
        )}
      </div>

      {/* Sub-tabs */}
      <SubTabs
        active={activeTab}
        onChange={setActiveTab}
        counts={{
          work: loading ? undefined : workTasks.length,
          personal: loading ? undefined : personalTasks.length,
        }}
      />

      {/* Tab content */}
      {activeTab === 'work' && (
        <>
          {!loading && workTasks.length > 0 && (
            <MyWorkFilterBar
              tasks={workTasks}
              filters={workFilters}
              onChange={setWorkFilters}
              matchedCount={filteredWorkTasks.length}
              totalCount={workTasks.length}
            />
          )}
          <WorkTab
            tasks={filteredWorkTasks}
            loading={loading}
            onSelect={setSelectedTask}
            hasFilters={workFiltersActive && workTasks.length > 0}
            onClearFilters={() => setWorkFilters(EMPTY_WORK_FILTERS)}
          />
        </>
      )}

      {activeTab === 'personal' && (
        <PersonalTab
          tasks={personalTasks}
          loading={loading}
          filter={filter}
          onFilterChange={setFilter}
          onAdd={() => setModalOpen(true)}
          onStatusChange={handleStatusChange}
          onPriorityChange={handlePriorityChange}
          onDelete={handleDelete}
          onEdit={setEditingTask}
        />
      )}

      {activeTab === 'calendar' && (
        <CalendarTab events={calendarEvents} onSelect={setSelectedTask} />
      )}

      <PersonalTaskModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreated={handleCreated}
      />

      <PersonalTaskModal
        isOpen={Boolean(editingTask)}
        task={editingTask}
        onClose={() => setEditingTask(null)}
        onUpdated={handleUpdated}
      />

      <CommentPanel
        task={selectedTask}
        isOpen={!!selectedTask}
        onClose={() => setSelectedTask(null)}
        onUpdateTask={handlePanelUpdate}
        editableStatusPriority
      />
    </PageWrapper>
  );
};

export default MyWorkPage;
