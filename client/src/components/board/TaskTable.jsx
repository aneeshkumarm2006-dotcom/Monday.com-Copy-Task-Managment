import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowRight, ArrowUp, ArrowDown, Plus, GripVertical } from 'lucide-react';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import TaskRow from './TaskRow';
import TaskEditRow from './TaskEditRow';
import TaskCardList from './TaskCardList';
import SortableItem from '../dnd/SortableItem';
import useTaskStore from '../../store/taskStore';
import * as taskService from '../../services/taskService';
import { getStatusPalette } from '../../utils/priorityColors';

/**
 * TaskTable — the core spreadsheet-style table used inside a board group.
 *
 * Column widths match Design doc Section 6.7:
 *   Checkbox 40px | Name flex (min 240px) | Priority 130px | Status 160px |
 *   Owner 160px | Due Date 140px | Actions 48px
 *
 * Inline editing: if `editingTaskId` equals a task's _id, that row is replaced
 * with a TaskEditRow pre-filled with the task's data. If `isCreating` is true,
 * a blank TaskEditRow is appended at the bottom.
 *
 * Props:
 *   tasks            — array of populated Task objects
 *   members          — org members (passed into TaskEditRow)
 *   editingTaskId    — id of the task currently being edited (or null)
 *   isCreating       — if true, renders the trailing "new task" edit row
 *   onOpenTask       — called when a task name is clicked
 *   onStatusClick    — called when a status chip is clicked
 *   onActionsClick   — called when the ⋯ action menu is clicked on a row
 *   onSaveNew        — async (payload) => void — create a new task
 *   onSaveEdit       — async (taskId, payload) => void — update an existing task
 *   onCancelEdit     — cancel inline creation or edit
 *   emptyLabel       — text rendered when the group has no tasks
 */
const COLUMNS = [
  { key: 'drag',     label: '',          width: 24,  sortable: false },
  { key: 'check',    label: '',          width: 40,  align: 'center', sortable: false },
  { key: 'name',     label: 'Task',      width: null, minWidth: 240, sortable: true },
  { key: 'priority', label: 'Priority',  width: 130, sortable: true },
  { key: 'status',   label: 'Status',    width: 160, sortable: true },
  { key: 'labels',   label: 'Labels',    width: 180, sortable: true },
  { key: 'owner',    label: 'Owner',     width: 160, sortable: true },
  { key: 'due',      label: 'Due Date',  width: 140, sortable: true },
  { key: 'comments', label: '',          width: 48,  sortable: false },
  { key: 'actions',  label: '',          width: 48,  sortable: false },
];

const PRIORITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

// Status keys ordered by "most complete first" for the default asc direction.
const STATUS_KEY_RANK = { done: 0, working_on_it: 1, not_started: 2, stuck: 3 };

const getStatusRank = (board, statusId) => {
  if (!statusId) return 99;
  const id = statusId.toString();
  if (board && Array.isArray(board.statuses)) {
    const s = board.statuses.find((s) => s._id.toString() === id);
    if (s) {
      if (s.key && STATUS_KEY_RANK[s.key] !== undefined) return STATUS_KEY_RANK[s.key];
      return 10 + (s.order || 0);
    }
  }
  return STATUS_KEY_RANK[id] ?? 99;
};

const sortTasks = (tasks, key, dir, board) => {
  if (!key) return tasks;
  const mul = dir === 'asc' ? 1 : -1;
  return [...tasks].sort((a, b) => {
    let cmp = 0;
    if (key === 'name') {
      cmp = (a.name || '').localeCompare(b.name || '');
    } else if (key === 'priority') {
      const ra = PRIORITY_RANK[a.priority] ?? 99;
      const rb = PRIORITY_RANK[b.priority] ?? 99;
      cmp = ra - rb;
    } else if (key === 'status') {
      cmp = getStatusRank(board, a.status) - getStatusRank(board, b.status);
    } else if (key === 'labels') {
      const la = Array.isArray(a.labels) && a.labels.length > 0 ? 0 : 1;
      const lb = Array.isArray(b.labels) && b.labels.length > 0 ? 0 : 1;
      cmp = la - lb;
    } else if (key === 'owner') {
      const na = a.assignedTo?.[0]?.name || a.assignedTo?.[0] || '';
      const nb = b.assignedTo?.[0]?.name || b.assignedTo?.[0] || '';
      cmp = String(na).localeCompare(String(nb));
    } else if (key === 'due') {
      const da = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
      const db = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
      cmp = da - db;
    }
    return cmp * mul;
  });
};

const TaskTable = ({
  tasks = [],
  board = null,
  members = [],
  editingTaskId = null,
  isCreating = false,
  createKey = 0,
  isAdmin = false,
  highlightedTaskId = null,
  onOpenTask,
  onStatusClick,
  onPriorityClick,
  onLabelsClick,
  onOwnerClick,
  onActionsClick,
  onSaveNew,
  onSaveEdit,
  onCancelEdit,
  emptyLabel = 'No tasks in this group yet',
  groupId = null,
  dndDisabled = false,
  // Bulk selection is owned by BoardDetailPage so the floating action bar
  // can aggregate selections across every group on the board.
  selectedIds = null,
  onToggleSelect,
  onToggleSelectAll,
}) => {
  const [expanded, setExpanded] = useState(() => new Set());
  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState('asc');

  const handleSortColumn = useCallback((key) => {
    setSortKey((prevKey) => {
      if (prevKey !== key) {
        setSortDir('asc');
        return key;
      }
      setSortDir((prevDir) => {
        if (prevDir === 'asc') return 'desc';
        return 'asc'; // will be cleared below
      });
      // If it was already desc, clear the sort
      if (sortDir === 'desc') return null;
      return key;
    });
  }, [sortDir]);

  const sortedTasks = useMemo(
    () => sortTasks(tasks, sortKey, sortDir, board),
    [tasks, sortKey, sortDir, board]
  );

  const fetchSubitems = useTaskStore((s) => s.fetchSubitems);
  const subitemsByParent = useTaskStore((s) => s.subitemsByParent);

  const handleToggleExpand = (taskId) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) {
        next.delete(taskId);
      } else {
        next.add(taskId);
        // Lazy fetch on first expand. The store caches by parent id so
        // re-expanding the same row doesn't refetch.
        if (!subitemsByParent[taskId]) {
          fetchSubitems(taskId).catch((err) => {
            console.error('Failed to load subitems:', err);
          });
        }
      }
      return next;
    });
  };

  // Collapse expanded rows for tasks that no longer exist (e.g. deleted).
  useEffect(() => {
    setExpanded((prev) => {
      if (prev.size === 0) return prev;
      const liveIds = new Set(tasks.map((t) => t._id));
      let changed = false;
      const next = new Set();
      for (const id of prev) {
        if (liveIds.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [tasks]);

  const handleRowSelect = (id, checked) => {
    onToggleSelect?.(id, checked);
  };

  const handleSelectAll = (checked) => {
    onToggleSelectAll?.(
      sortedTasks.map((t) => t._id),
      checked
    );
  };

  const allSelected =
    sortedTasks.length > 0 &&
    selectedIds != null &&
    sortedTasks.every((t) => selectedIds.has(t._id));
  const noRows = sortedTasks.length === 0 && !isCreating;
  // When an edit row is active, dropdowns inside rows need to escape the
  // table's horizontal scroll clipping.
  const isInlineEditing = isCreating || editingTaskId !== null;

  const taskIds = useMemo(() => sortedTasks.map((t) => t._id), [sortedTasks]);

  return (
    <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
      {/* Mobile stacked cards (<768px) — only for display. When inline editing
          is active on mobile, the table view below takes over so users can
          complete the form. See Design doc Section 8.2. */}
      {!isInlineEditing && (
        <div className="md:hidden">
          <TaskCardList
            tasks={tasks}
            board={board}
            onOpenTask={onOpenTask}
            onStatusClick={onStatusClick}
            onPriorityClick={onPriorityClick}
            onLabelsClick={onLabelsClick}
            onOwnerClick={onOwnerClick}
            onActionsClick={onActionsClick}
            highlightedTaskId={highlightedTaskId}
            emptyLabel={emptyLabel}
            groupId={groupId}
            dndDisabled={dndDisabled}
          />
        </div>
      )}

      {/* Desktop table view (md+) — also used on mobile when inline editing
          is active so the user can fill in the form fields. */}
      <div
        className={[
          'w-full',
          isInlineEditing ? 'overflow-visible' : 'overflow-x-auto hidden md:block',
        ].join(' ')}
      >
      <table
        className="w-full"
        style={{
          borderCollapse: 'collapse',
          background: 'var(--color-bg-surface, #FFFFFF)',
        }}
      >
        <thead>
          <tr
            style={{
              height: 40,
              background: 'var(--color-bg-subtle)',
              borderBottom: '1px solid var(--color-border)',
            }}
          >
            {COLUMNS.map((col) => {
              const isActive = sortKey === col.key;
              return (
                <th
                  key={col.key}
                  scope="col"
                  style={{
                    width: col.width || undefined,
                    minWidth: col.minWidth || undefined,
                    padding: '0 16px',
                    textAlign: 'left',
                    fontFamily: 'var(--font-body)',
                    fontSize: 11,
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    letterSpacing: '0.07em',
                    color: isActive ? 'var(--color-accent)' : 'var(--color-text-secondary)',
                    cursor: col.sortable ? 'pointer' : 'default',
                    userSelect: 'none',
                    whiteSpace: 'nowrap',
                  }}
                  onClick={col.sortable ? () => handleSortColumn(col.key) : undefined}
                  title={col.sortable ? `Sort by ${col.label}` : undefined}
                >
                  {col.key === 'check' ? (
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={(e) => handleSelectAll(e.target.checked)}
                      aria-label="Select all tasks"
                      style={{
                        width: 16,
                        height: 16,
                        accentColor: 'var(--color-accent)',
                        cursor: 'pointer',
                      }}
                    />
                  ) : col.sortable ? (
                    <span className="inline-flex items-center gap-1">
                      {col.label}
                      {isActive ? (
                        sortDir === 'asc'
                          ? <ArrowUp size={11} aria-hidden="true" />
                          : <ArrowDown size={11} aria-hidden="true" />
                      ) : (
                        <ArrowUp size={11} aria-hidden="true" style={{ opacity: 0.25 }} />
                      )}
                    </span>
                  ) : (
                    col.label
                  )}
                </th>
              );
            })}
          </tr>
        </thead>

        <tbody>
          {noRows ? (
            <tr>
              <td
                colSpan={COLUMNS.length}
                style={{
                  padding: '20px 16px',
                  fontFamily: 'var(--font-body)',
                  fontSize: 13,
                  color: 'var(--color-text-muted)',
                  textAlign: 'center',
                }}
              >
                {emptyLabel}
              </td>
            </tr>
          ) : (
            <>
              {sortedTasks.map((task, i) => {
                const isEditing = editingTaskId === task._id;
                const isLastExisting = i === sortedTasks.length - 1;
                const isLastRow = isLastExisting && !isCreating;

                if (isEditing) {
                  return (
                    <TaskEditRow
                      key={task._id}
                      board={board}
                      members={members}
                      initialTask={task}
                      isLast={isLastRow}
                      isAdmin={isAdmin}
                      onSave={(payload) => onSaveEdit?.(task._id, payload)}
                      onCancel={onCancelEdit}
                    />
                  );
                }

                const isExpanded = expanded.has(task._id);
                return (
                  <SortableItem
                    key={task._id}
                    id={task._id}
                    data={{ type: 'task', groupId }}
                    disabled={dndDisabled || !groupId}
                  >
                    {({ ref, setActivatorNodeRef, style, attributes, listeners, isDragging }) => (
                      <Fragment>
                        <TaskRow
                          task={task}
                          board={board}
                          selected={selectedIds?.has(task._id) || false}
                          onSelect={handleRowSelect}
                          onOpen={onOpenTask}
                          onStatusClick={onStatusClick}
                          onPriorityClick={onPriorityClick}
                          onLabelsClick={onLabelsClick}
                          onOwnerClick={onOwnerClick}
                          onActionsClick={onActionsClick}
                          onToggleExpand={handleToggleExpand}
                          expanded={isExpanded}
                          isLast={isLastRow && !isExpanded}
                          highlighted={highlightedTaskId === task._id}
                          sortableRef={ref}
                          sortableStyle={style}
                          sortableAttributes={attributes}
                          dragHandleRef={setActivatorNodeRef}
                          dragHandleListeners={listeners}
                          isDragging={isDragging}
                          dndDisabled={dndDisabled || !groupId}
                        />
                        {isExpanded ? (
                          <SubitemsRow
                            parent={task}
                            board={board}
                            colSpan={COLUMNS.length}
                            onOpenTask={onOpenTask}
                            isLast={isLastRow}
                            isAdmin={isAdmin}
                          />
                        ) : null}
                      </Fragment>
                    )}
                  </SortableItem>
                );
              })}
            </>
          )}

          {isCreating && (
            <TaskEditRow
              key={`__new__-${createKey}`}
              board={board}
              members={members}
              initialTask={null}
              isLast
              isAdmin={isAdmin}
              autoFocus={false}
              onSave={onSaveNew}
              onCancel={onCancelEdit}
            />
          )}
        </tbody>
      </table>
      </div>
    </SortableContext>
  );
};

/**
 * SubitemsRow — single inline `<tr colSpan>` rendered beneath an expanded
 * parent row. Lists each subitem in a compact horizontal layout and exposes
 * a "+ Add subitem" button at the bottom (admin only). Clicking a subitem
 * name opens the CommentPanel via the standard onOpenTask flow.
 */
const SubitemsRow = ({ parent, board, colSpan, onOpenTask, isLast, isAdmin }) => {
  const subitems = useTaskStore(
    (s) => s.subitemsByParent[parent._id] || null
  );
  const addSubitem = useTaskStore((s) => s.addSubitem);
  const updateSubitem = useTaskStore((s) => s.updateSubitem);

  const [adding, setAdding] = useState(false);
  const [newText, setNewText] = useState('');
  const [error, setError] = useState('');

  const boardStatuses = useMemo(() => {
    if (!board || !Array.isArray(board.statuses)) return [];
    return [...board.statuses].sort((a, b) => (a.order || 0) - (b.order || 0));
  }, [board]);

  const handleCycleStatus = async (sub) => {
    if (boardStatuses.length === 0) return;
    const currentId = sub.status ? sub.status.toString() : null;
    const idx = boardStatuses.findIndex(
      (s) => s._id.toString() === currentId
    );
    const next = boardStatuses[(idx + 1) % boardStatuses.length];
    try {
      const updated = await taskService.updateTask(sub._id, {
        status: next._id,
      });
      updateSubitem(updated);
    } catch (err) {
      console.error('Failed to update subitem status:', err);
      setError(
        err?.response?.data?.error ||
          'Failed to update status. Please try again.'
      );
    }
  };

  const handleAdd = async (e) => {
    e?.preventDefault?.();
    const trimmed = newText.trim();
    if (!trimmed) return;
    try {
      await addSubitem(parent._id, { name: trimmed });
      setNewText('');
      setAdding(true);
    } catch (err) {
      console.error('Failed to add subitem:', err);
      setError(
        err?.response?.data?.error ||
          'Failed to add subitem. Please try again.'
      );
    }
  };

  const items = Array.isArray(subitems) ? subitems : [];
  const loading = subitems == null;

  return (
    <tr
      style={{
        background: 'var(--color-bg-subtle, #F9FAFB)',
        borderBottom: isLast ? 'none' : '1px solid var(--color-border)',
      }}
    >
      <td colSpan={colSpan} style={{ padding: '8px 16px 12px 80px' }}>
        {error ? (
          <p
            className="font-body"
            role="alert"
            style={{
              fontSize: 12,
              color: 'var(--color-status-stuck)',
              marginBottom: 6,
            }}
          >
            {error}
          </p>
        ) : null}
        {loading ? (
          <p
            className="font-body"
            style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
          >
            Loading subitems…
          </p>
        ) : items.length === 0 ? (
          <p
            className="font-body"
            style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
          >
            No subitems yet.
          </p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {items.map((sub) => {
              const palette = getStatusPalette(board, sub.status);
              return (
                <li
                  key={sub._id}
                  className="flex items-center gap-2"
                  style={{ padding: '3px 0' }}
                >
                  <button
                    type="button"
                    onClick={() => handleCycleStatus(sub)}
                    aria-label={`Status: ${palette.label}. Click to change.`}
                    title={palette.label}
                    style={{
                      width: 12,
                      height: 12,
                      borderRadius: '50%',
                      background: palette.solid || palette.text,
                      border: '1.5px solid #FFFFFF',
                      boxShadow: '0 0 0 1px var(--color-border-strong)',
                      flexShrink: 0,
                      cursor: 'pointer',
                      padding: 0,
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => onOpenTask?.(sub)}
                    className="text-left font-body transition-colors duration-150 hover:underline hover:text-[color:var(--color-accent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)] truncate"
                    style={{
                      fontSize: 13,
                      fontWeight: 500,
                      color: 'var(--color-text-primary)',
                      background: 'transparent',
                      border: 'none',
                      padding: 0,
                      cursor: 'pointer',
                      flex: 1,
                      minWidth: 0,
                    }}
                  >
                    {sub.name}
                  </button>
                  <button
                    type="button"
                    onClick={() => onOpenTask?.(sub)}
                    aria-label={`Open ${sub.name}`}
                    title="Open subitem"
                    className="flex items-center justify-center rounded transition-colors duration-150 hover:bg-[color:var(--color-border)]"
                    style={{
                      width: 22,
                      height: 22,
                      background: 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      color: 'var(--color-text-muted)',
                      flexShrink: 0,
                    }}
                  >
                    <ArrowRight size={12} aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {isAdmin ? (
          adding ? (
            <form
              onSubmit={handleAdd}
              className="flex items-center gap-2"
              style={{ marginTop: 6 }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: '50%',
                  border: '1.5px solid var(--color-border-strong)',
                  flexShrink: 0,
                }}
              />
              <input
                type="text"
                value={newText}
                onChange={(e) => setNewText(e.target.value)}
                onBlur={() => {
                  if (!newText.trim()) setAdding(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setNewText('');
                    setAdding(false);
                  }
                }}
                placeholder="New subitem"
                autoFocus
                className="flex-1 font-body focus:outline-none"
                style={{
                  fontSize: 13,
                  padding: '4px 6px',
                  background: 'var(--color-bg-surface, #FFFFFF)',
                  border: '1px solid var(--color-border-strong)',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--color-text-primary)',
                }}
              />
              <button
                type="submit"
                disabled={!newText.trim()}
                className="inline-flex items-center justify-center font-body disabled:opacity-40 disabled:cursor-not-allowed"
                style={{
                  height: 26,
                  padding: '0 10px',
                  fontSize: 12,
                  fontWeight: 600,
                  background: 'var(--color-accent)',
                  color: '#FFFFFF',
                  border: 'none',
                  borderRadius: 'var(--radius-sm)',
                  cursor: newText.trim() ? 'pointer' : 'not-allowed',
                }}
              >
                Add
              </button>
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="inline-flex items-center gap-1 font-body transition-colors duration-150 hover:text-[color:var(--color-accent)]"
              style={{
                marginTop: 6,
                padding: '4px 0',
                fontSize: 12,
                fontWeight: 500,
                color: 'var(--color-text-muted)',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
              }}
            >
              <Plus size={12} aria-hidden="true" />
              Add subitem
            </button>
          )
        ) : null}
      </td>
    </tr>
  );
};

export default TaskTable;
