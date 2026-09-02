import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowUp, ArrowDown, Plus } from 'lucide-react';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import TaskRow from './TaskRow';
import TaskEditRow from './TaskEditRow';
import TaskCardList from './TaskCardList';
import SortableItem from '../dnd/SortableItem';
import useTaskStore from '../../store/taskStore';
import { isTaskPinned, sortPinnedFirst } from '../../utils/taskPins';

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
 *   tasks            — array of populated Task objects, already pinned-first
 *   personalPins     — Set of task ids this user pinned privately
 *   members          — the board's members (passed into TaskEditRow)
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
  personalPins = null,
  board = null,
  members = [],
  editingTaskId = null,
  isCreating = false,
  createKey = 0,
  isAdmin = false,
  // "May this person add a row" — the `contribute` rung's `task.create`, which
  // sits BELOW `isAdmin` (the `edit` rung). The two are distinct on purpose: a
  // contributor may add tasks and subtasks without being able to restructure
  // the board. Defaults to `isAdmin` so a caller that hasn't been taught the
  // difference behaves exactly as before.
  canCreate = isAdmin,
  // "May this person put a name OTHER than their own on a task" — `task.assign`,
  // which sits on the `edit` rung. Same shape and same reason as `canCreate`
  // above: a contributor holds neither, but may still assign THEMSELVES, so the
  // picker greys out everyone else rather than 403ing on click. `selfId` is
  // which row stays live. Defaults to `isAdmin` so untaught callers are
  // unchanged.
  canAssign = isAdmin,
  selfId = null,
  highlightedTaskId = null,
  highlightedParentId = null,
  onOpenTask,
  onStatusClick,
  onPriorityClick,
  onLabelsClick,
  onOwnerClick,
  onActionsClick,
  onDueDateChange,
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
  // Client Portal boards: ask, when a top-level task is created, whether the
  // client should see it. Never offered on the subitem rows — a subitem cannot
  // be shared (the portal list is flat), so asking would promise nothing.
  askPortalShare = false,
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

  // Column-header sort, then re-float the pins. Sorting by Due Date shouldn't
  // drop a pinned row back into the pile — the pin outranks the column.
  const sortedTasks = useMemo(
    () => sortPinnedFirst(sortTasks(tasks, sortKey, sortDir, board), personalPins),
    [tasks, sortKey, sortDir, board, personalPins]
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

  // Auto-expand a parent row when a subtask notification points into it, so the
  // target subtask actually renders (and can be scrolled to + highlighted). Only
  // the table that owns the parent acts; the rest ignore the id.
  useEffect(() => {
    if (!highlightedParentId) return;
    if (!tasks.some((t) => t._id === highlightedParentId)) return;
    setExpanded((prev) => {
      if (prev.has(highlightedParentId)) return prev;
      const next = new Set(prev);
      next.add(highlightedParentId);
      return next;
    });
    if (!subitemsByParent[highlightedParentId]) {
      fetchSubitems(highlightedParentId).catch((err) => {
        console.error('Failed to load subitems:', err);
      });
    }
  }, [highlightedParentId, tasks, subitemsByParent, fetchSubitems]);

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

  const taskIds = useMemo(() => sortedTasks.map((t) => t._id), [sortedTasks]);

  return (
    <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
      {/* Mobile stacked cards (<768px). Creation happens HERE, in the card
          list's own ghost add row — `isCreating` (true for anyone who may
          create) used to force the 1170px desktop table onto every phone,
          which is exactly the "table furniture on mobile" the design killed.
          Only an actual row edit still falls back to the table. */}
      {editingTaskId === null && (
        <div className="md:hidden">
          <TaskCardList
            tasks={tasks}
            personalPins={personalPins}
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
            canCreate={isCreating}
            onSaveNew={onSaveNew}
          />
        </div>
      )}

      {/* Desktop table view (md+) — also used on mobile when inline editing
          is active so the user can fill in the form fields. */}
      <div
        className={[
          'w-full',
          // The table has a fixed min-width (1170px), so on any viewport narrower
          // than that — including short/narrow desktop windows — it must scroll
          // horizontally rather than spill its trailing columns (comments, the
          // ⋯ menu, and the edit row's save/cancel buttons) off-screen.
          // overflow-x-auto gives that scrollbar in every mode. Row dropdowns are
          // portaled to <body>, so the scroll container never clips them.
          editingTaskId !== null ? 'overflow-x-auto' : 'overflow-x-auto hidden md:block',
        ].join(' ')}
      >
      <table
        className="w-full"
        style={{
          borderCollapse: 'collapse',
          // Fixed layout pins every sized column to its declared px width so a
          // long task name can't stretch the Name column and push the others
          // off-screen. The Name column (width null) is the only auto column,
          // so it absorbs leftover space and truncates its content instead.
          // minWidth = sum of fixed columns (930) + Name floor (240) so the
          // table scrolls horizontally rather than collapsing on narrow viewports.
          tableLayout: 'fixed',
          minWidth: 1170,
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
                      canAssignOthers={canAssign}
                      selfId={selfId}
                      onSave={(payload) => onSaveEdit?.(task._id, payload)}
                      onCancel={onCancelEdit}
                    />
                  );
                }

                const isExpanded = expanded.has(task._id);
                // A pinned row's persisted slot is frozen — that freeze is
                // exactly what lets an unpin put it back where it was, so the
                // row gets no drag handle until it's unpinned.
                const pinned = isTaskPinned(task, personalPins);
                return (
                  <SortableItem
                    key={task._id}
                    id={task._id}
                    data={{ type: 'task', groupId }}
                    disabled={dndDisabled || !groupId || pinned}
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
                          onDueDateChange={onDueDateChange}
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
                          dndDisabled={dndDisabled || !groupId || pinned}
                          pinnedForAll={task.pinned === true}
                          pinnedForMe={personalPins?.has(task._id) || false}
                        />
                        {isExpanded ? (
                          <SubtaskSection
                            parent={task}
                            board={board}
                            members={members}
                            colSpan={COLUMNS.length}
                            isLast={isLastRow}
                            isAdmin={isAdmin}
                            canCreate={canCreate}
                            canAssign={canAssign}
                            selfId={selfId}
                            editingTaskId={editingTaskId}
                            highlightedTaskId={highlightedTaskId}
                            onOpenTask={onOpenTask}
                            onStatusClick={onStatusClick}
                            onPriorityClick={onPriorityClick}
                            onLabelsClick={onLabelsClick}
                            onOwnerClick={onOwnerClick}
                            onActionsClick={onActionsClick}
                            onDueDateChange={onDueDateChange}
                            onSaveEdit={onSaveEdit}
                            onCancelEdit={onCancelEdit}
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
              canAssignOthers={canAssign}
              selfId={selfId}
              autoFocus={false}
              askPortalShare={askPortalShare}
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
 * SubtaskSection — the set of `<tr>`s rendered beneath an expanded parent.
 *
 * Each subtask is a full Task in its own right, so it renders through the same
 * `TaskRow` as a top-level task (every column: name, priority, status, labels,
 * owner, due date, comments, actions) — just flagged `isSubtask` so the name is
 * indented and the drag handle + select checkbox are suppressed. All the row
 * handlers are the same ones the board passes to top-level rows; the store
 * routes subtask mutations to the parent's bucket automatically.
 *
 * The trailing row is an inline "Add subtask" affordance that opens the same
 * `TaskEditRow` form used to create a top-level task, so a subtask is created
 * with the identical fields. Returns a Fragment of sibling `<tr>`s (valid
 * inside `<tbody>`).
 */
const SubtaskSection = ({
  parent,
  board,
  members,
  colSpan,
  isLast,
  isAdmin,
  canCreate = isAdmin,
  canAssign = isAdmin,
  selfId = null,
  editingTaskId,
  highlightedTaskId = null,
  onOpenTask,
  onStatusClick,
  onPriorityClick,
  onLabelsClick,
  onOwnerClick,
  onActionsClick,
  onDueDateChange,
  onSaveEdit,
  onCancelEdit,
}) => {
  const subitems = useTaskStore((s) => s.subitemsByParent[parent._id] || null);
  const addSubitem = useTaskStore((s) => s.addSubitem);

  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');

  const items = Array.isArray(subitems) ? subitems : [];
  const loading = subitems == null;

  const handleSaveNew = async (payload) => {
    setError('');
    try {
      await addSubitem(parent._id, payload);
      setAdding(false);
    } catch (err) {
      console.error('Failed to add subtask:', err);
      setError(
        err?.response?.data?.error ||
          'Failed to add subtask. Please try again.'
      );
      throw err;
    }
  };

  return (
    <>
      {error ? (
        <tr style={{ background: 'var(--color-bg-subtle)' }}>
          <td colSpan={colSpan} style={{ padding: '6px 16px 6px 80px' }}>
            <p
              className="font-body"
              role="alert"
              style={{ fontSize: 12, color: 'var(--color-status-stuck)' }}
            >
              {error}
            </p>
          </td>
        </tr>
      ) : null}

      {loading ? (
        <tr style={{ background: 'var(--color-bg-subtle)' }}>
          <td colSpan={colSpan} style={{ padding: '8px 16px 8px 80px' }}>
            <p
              className="font-body"
              style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
            >
              Loading subtasks…
            </p>
          </td>
        </tr>
      ) : (
        items.map((sub, idx) => {
          // The last subtask only owns the section's closing border when no
          // trailing row (add-subtask / empty state) follows it — i.e. for a
          // read-only viewer.
          const subIsLast = !canCreate && idx === items.length - 1 ? isLast : false;
          return editingTaskId === sub._id ? (
            <TaskEditRow
              key={sub._id}
              board={board}
              members={members}
              initialTask={sub}
              isLast={subIsLast}
              isAdmin={isAdmin}
              canAssignOthers={canAssign}
              selfId={selfId}
              onSave={(payload) => onSaveEdit?.(sub._id, payload)}
              onCancel={onCancelEdit}
            />
          ) : (
            <TaskRow
              key={sub._id}
              task={sub}
              board={board}
              isSubtask
              dndDisabled
              highlighted={highlightedTaskId === sub._id}
              onOpen={onOpenTask}
              onStatusClick={onStatusClick}
              onPriorityClick={onPriorityClick}
              onLabelsClick={onLabelsClick}
              onOwnerClick={onOwnerClick}
              onActionsClick={onActionsClick}
              onDueDateChange={onDueDateChange}
              isLast={subIsLast}
            />
          );
        })
      )}

      {/* Inline "Add subtask" — same form/fields as creating a top-level task */}
      {canCreate ? (
        adding ? (
          <TaskEditRow
            board={board}
            members={members}
            initialTask={null}
            isLast={isLast}
            isAdmin={isAdmin}
            canAssignOthers={canAssign}
            selfId={selfId}
            isSubtask
            onSave={handleSaveNew}
            onCancel={() => setAdding(false)}
          />
        ) : (
          <tr
            style={{
              background: 'var(--color-bg-subtle)',
              borderBottom: isLast ? 'none' : '1px solid var(--color-border)',
            }}
          >
            <td colSpan={colSpan} style={{ padding: '6px 16px 8px 80px' }}>
              <button
                type="button"
                onClick={() => setAdding(true)}
                className="inline-flex items-center gap-1 font-body transition-colors duration-150 hover:text-[color:var(--color-accent)]"
                style={{
                  padding: '4px 0',
                  fontSize: 13,
                  fontWeight: 500,
                  color: 'var(--color-text-muted)',
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                }}
              >
                <Plus size={13} aria-hidden="true" />
                Add subtask
              </button>
            </td>
          </tr>
        )
      ) : items.length === 0 && !loading ? (
        <tr
          style={{
            background: 'var(--color-bg-subtle)',
            borderBottom: isLast ? 'none' : '1px solid var(--color-border)',
          }}
        >
          <td colSpan={colSpan} style={{ padding: '8px 16px 8px 80px' }}>
            <p
              className="font-body"
              style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
            >
              No subtasks yet.
            </p>
          </td>
        </tr>
      ) : null}
    </>
  );
};

export default TaskTable;
