import { useEffect, useState, useCallback } from 'react';
import {
  Plus,
  ClipboardList,
  Trash2,
  Pencil,
  Calendar as CalendarIcon,
  StickyNote,
} from 'lucide-react';
import PageWrapper from '../components/layout/PageWrapper';
import PersonalTaskModal from '../components/board/PersonalTaskModal';
import Chip from '../components/ui/Chip';
import Button from '../components/ui/Button';
import { getMyTasks, updateTask, deleteTask } from '../services/taskService';

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

const formatDate = (dateStr) => {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
};

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

const FILTER_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'not_started', label: 'Not Started' },
  { value: 'working_on_it', label: 'Working on it' },
  { value: 'done', label: 'Done' },
  { value: 'stuck', label: 'Stuck' },
];

const MyTasksPage = () => {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingTask, setEditingTask] = useState(null);
  const [filter, setFilter] = useState('all');

  const fetchTasks = useCallback(async () => {
    try {
      const all = await getMyTasks();
      // Only show personal tasks (isPersonal: true)
      setTasks(all.filter((t) => t.isPersonal));
    } catch (err) {
      console.error('Failed to fetch personal tasks:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  const handleStatusChange = async (taskId, newStatus) => {
    setTasks((prev) =>
      prev.map((t) => (t._id === taskId ? { ...t, status: newStatus } : t))
    );
    try {
      await updateTask(taskId, { status: newStatus });
    } catch {
      fetchTasks();
    }
  };

  const handlePriorityChange = async (taskId, newPriority) => {
    setTasks((prev) =>
      prev.map((t) => (t._id === taskId ? { ...t, priority: newPriority } : t))
    );
    try {
      await updateTask(taskId, { priority: newPriority });
    } catch {
      fetchTasks();
    }
  };

  const handleDelete = async (taskId) => {
    setTasks((prev) => prev.filter((t) => t._id !== taskId));
    await deleteTask(taskId);
  };

  const handleCreated = (task) => {
    setTasks((prev) => [task, ...prev]);
  };

  const handleUpdated = (task) => {
    setTasks((prev) => prev.map((t) => (t._id === task._id ? task : t)));
  };

  const handleEdit = (task) => {
    setEditingTask(task);
  };

  const filtered =
    filter === 'all' ? tasks : tasks.filter((t) => t.status === filter);

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
            <ClipboardList size={20} color="var(--color-accent)" />
          </div>
          <div>
            <h1
              className="font-display font-bold"
              style={{ fontSize: 22, color: 'var(--color-text-primary)' }}
            >
              My Tasks
            </h1>
            <p
              className="font-body"
              style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}
            >
              Your personal tasks — only visible to you
            </p>
          </div>
        </div>

        <Button variant="primary" icon={Plus} onClick={() => setModalOpen(true)}>
          Add Task
        </Button>
      </div>

      {/* Filter bar */}
      {tasks.length > 0 && (
        <div className="flex items-center gap-2 mt-6 flex-wrap">
          {FILTER_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setFilter(opt.value)}
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

      {/* Content */}
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
          <EmptyState onAdd={() => setModalOpen(true)} />
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
                onStatusChange={handleStatusChange}
                onPriorityChange={handlePriorityChange}
                onDelete={handleDelete}
                onEdit={handleEdit}
              />
            ))}
          </div>
        )}
      </div>

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
    </PageWrapper>
  );
};

export default MyTasksPage;
