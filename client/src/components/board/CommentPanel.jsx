import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  X,
  Plus,
  Settings as SettingsIcon,
  ChevronLeft,
  ChevronDown,
  Check,
  Lock,
  Users,
} from 'lucide-react';
import Chip from '../ui/Chip';
import DatePickerPopover from '../ui/DatePickerPopover';
import { formatDate } from '../../utils/dateUtils';
import useOrgStore from '../../store/orgStore';
import {
  getColorPair,
  PRIORITY_COLORS,
  STATUS_COLORS,
} from '../../utils/priorityColors';
import ChecklistEditor from './ChecklistEditor';
import UpdatesTab from './UpdatesTab';
import FilesTab from './FilesTab';
import ActivityLogTab from './ActivityLogTab';
import SubitemsList from './SubitemsList';
import AssigneePicker from './AssigneePicker';
import FollowButton from './FollowButton';

// Mirror of TaskEditRow's toDateInputValue so the date input round-trips
// the same ISO/YYYY-MM-DD shape used elsewhere in the app.
const toDateInputValue = (d) => {
  if (!d) return '';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

/**
 * CommentPanel — right-edge slide-out panel showing task detail + updates.
 *
 * See Macan_Design.md Section 6.9.
 *
 * Specs:
 *   - 420px width (desktop), full-width (mobile <768px)
 *   - Background: white, left border, shadow-lg, z-index 100
 *   - Animation: translateX(100%) → 0, 300ms cubic-bezier(0.4, 0, 0.2, 1)
 *   - Sections: close button, task header, tabbed body (updates, files, activity)
 *   - Subtle 40% dark backdrop (overlay). Click outside or ESC to close.
 *
 * Props:
 *   task     — populated task doc (contains: name, priority, status,
 *              assignedTo[{name, profilePic}], dueDate, note)
 *   isOpen   — whether the panel is rendered + in-position
 *   onClose  — callback to close the panel
 */
const CommentPanel = ({
  task,
  board = null,
  isOpen,
  onClose,
  isAdmin = false,
  onUpdateTask,
  onEditLabels,
  onOpenSubitem,
  onBack,
  canGoBack = false,
  onUpdatesCountChange,
  // Tab to pre-select when the panel opens (e.g. arriving from a reply
  // notification). Null/undefined → keep the default ('updates').
  initialTab = null,
  // When true, the priority + status badges become inline dropdowns even for
  // non-admins. Used by the "My Work" view so users can re-triage their own
  // tasks straight from the detail panel. Board context leaves this off so
  // its existing admin-gated permission model is unchanged.
  editableStatusPriority = false,
}) => {
  // Tabs (Updates / Client / Files / Activity Log)
  const [activeTab, setActiveTab] = useState('updates');
  // null = not counted yet. The badge is hidden until its tab has actually
  // loaded, because a placeholder 0 is not a neutral "loading" state — it is a
  // confident, wrong answer, and "Files / 0" on a task with three client
  // screenshots is precisely the reason nobody opened the tab.
  const [updatesCount, setUpdatesCount] = useState(null);
  const [clientCount, setClientCount] = useState(null);
  const [filesCount, setFilesCount] = useState(null);

  // A separate Client thread only exists where there IS a client: a Client Portal
  // board. Everywhere else Updates is the only thread, and splitting it would be
  // for nothing.
  //
  // `board` is only passed from BoardDetailPage — My Work and Calendar render this
  // panel without it — so fall back to the populated `task.board`, and finally to
  // the task having a portal submitter, which is what actually makes a task
  // readable by a client.
  const boardTypeOf = (b) => (typeof b === 'object' && b ? b.boardType : null);
  const isClientTask =
    boardTypeOf(board) === 'client' ||
    boardTypeOf(task?.board) === 'client' ||
    !!task?.portalSubmitter;

  // A notification's `tab: 'client'` hint is itself evidence the task has a client
  // thread, so honour it even if none of the signals above resolved (the board doc
  // hasn't landed yet, or it was since converted back to a standard board).
  // Otherwise the hint would select a tab that isn't rendered and the pane would
  // be blank.
  const showClientTab = isClientTask || activeTab === 'client';

  // On a client board Updates is the TEAM thread; everywhere else it is the single
  // ordinary thread. Only the former is stored as internal — see UpdatesTab.
  const updatesAudience = isClientTask ? 'team' : 'default';

  // Org members for @mention
  const currentOrg = useOrgStore((s) => s.currentOrg);
  const orgMembers = useOrgStore((s) => s.members);
  const fetchMembers = useOrgStore((s) => s.fetchMembers);

  const taskId = task?._id || null;

  // Fetch org members when panel opens (if not already loaded)
  useEffect(() => {
    if (isOpen && currentOrg?._id && orgMembers.length === 0) {
      fetchMembers(currentOrg._id).catch(() => {});
    }
  }, [isOpen, currentOrg?._id, orgMembers.length, fetchMembers]);

  // Reset the per-task tab counts whenever the task changes so a previous
  // task's count is never shown against a newly-opened one (UpdatesTab and
  // FilesTab re-report their live counts as soon as they load).
  useEffect(() => {
    setUpdatesCount(null);
    setClientCount(null);
    setFilesCount(null);
  }, [taskId]);

  // Return to the default tab when the panel fully closes. activeTab is
  // intentionally preserved across task switches while the panel stays open.
  useEffect(() => {
    if (!isOpen || !taskId) setActiveTab('updates');
  }, [isOpen, taskId]);

  // When the panel opens with a tab hint (e.g. a reply notification pointing at
  // the Updates tab), switch to it. Legacy 'comments' hints (from before the
  // Comments tab was merged into Updates) fall back to the Updates tab.
  useEffect(() => {
    if (!isOpen || !initialTab) return;
    // Legacy hints both resolve to Updates: 'comments' predates the
    // Comments/Updates merge, and 'internal' predates the Internal tab becoming
    // Updates (the team thread) with Client as its own tab.
    const legacy = initialTab === 'comments' || initialTab === 'internal';
    setActiveTab(legacy ? 'updates' : initialTab);
  }, [isOpen, initialTab, taskId]);

  // Keep the board row's discussion-count badge in sync with the live updates
  // count reported by UpdatesTab while the panel is open.
  useEffect(() => {
    if (!isOpen || !taskId) return;
    // Skip the pre-load null — the row already shows a count, and overwriting it
    // with "unknown" every time the panel opens would make it flicker.
    if (updatesCount === null) return;
    onUpdatesCountChange?.(taskId, updatesCount);
  }, [isOpen, taskId, updatesCount, onUpdatesCountChange]);

  // ESC closes the panel + scroll lock on <body>
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

  const assignees = useMemo(
    () => (Array.isArray(task?.assignedTo) ? task.assignedTo : []),
    [task]
  );

  // --- Inline header edits (name / assignees / due date) ----------------
  // The name uses a click-to-edit pattern: an <h2> by default, an <input>
  // while editing. Assignees and due date are always-on editors (the
  // existing AssigneePicker + a native date input) — read-only for
  // non-admin users.
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [savingDueDate, setSavingDueDate] = useState(false);
  const nameInputRef = useRef(null);

  // Reset edit mode whenever the panel switches to a new task.
  useEffect(() => {
    setEditingName(false);
    setNameDraft('');
    setSavingName(false);
    setSavingDueDate(false);
  }, [taskId]);

  // Autofocus + select the input when entering edit mode.
  useEffect(() => {
    if (editingName && nameInputRef.current) {
      nameInputRef.current.focus();
      nameInputRef.current.select();
    }
  }, [editingName]);

  const commitNameEdit = useCallback(async () => {
    if (!task) return;
    const next = nameDraft.trim();
    const prev = task.name || '';
    if (!next || next === prev) {
      setEditingName(false);
      setNameDraft('');
      return;
    }
    if (!onUpdateTask) {
      setEditingName(false);
      return;
    }
    setSavingName(true);
    try {
      await onUpdateTask(task._id, { name: next });
      setEditingName(false);
      setNameDraft('');
    } catch {
      // parent surfaces a toast; keep the draft visible so the user can retry
    } finally {
      setSavingName(false);
    }
  }, [task, nameDraft, onUpdateTask]);

  const cancelNameEdit = useCallback(() => {
    setEditingName(false);
    setNameDraft('');
  }, []);

  const handleAssigneesChange = useCallback(
    async (nextIds) => {
      if (!task || !onUpdateTask) return;
      const prevIds = assignees.map((u) => (typeof u === 'string' ? u : u._id));
      const sameSet =
        prevIds.length === nextIds.length &&
        prevIds.every((id) => nextIds.includes(id));
      if (sameSet) return;
      try {
        await onUpdateTask(task._id, { assignedTo: nextIds });
      } catch {
        // toast surfaced by parent; AssigneePicker will re-render from the
        // store on rollback
      }
    },
    [task, onUpdateTask, assignees]
  );

  const handleDueDateChange = useCallback(
    async (e) => {
      if (!task || !onUpdateTask) return;
      const raw = e.target.value;
      const nextIso = raw ? new Date(raw).toISOString() : null;
      const prevIso = task.dueDate ? new Date(task.dueDate).toISOString() : null;
      if (nextIso === prevIso) return;
      setSavingDueDate(true);
      try {
        await onUpdateTask(task._id, { dueDate: nextIso });
      } catch {
        // toast surfaced by parent
      } finally {
        setSavingDueDate(false);
      }
    },
    [task, onUpdateTask]
  );

  if (!isOpen || !task) return null;

  // Members list — used by the inline AssigneePicker. Falls back to the
  // currently-assigned users so the trigger still shows initials before the
  // org-members fetch lands.
  const pickerMembers =
    orgMembers && orgMembers.length > 0
      ? orgMembers
      : assignees.map((u) => ({
          _id: typeof u === 'string' ? u : u._id,
          name: u?.name,
          profilePic: u?.profilePic,
          email: u?.email,
        }));
  const assignedIds = assignees.map((u) => (typeof u === 'string' ? u : u._id));
  const canEditFields = isAdmin && !!onUpdateTask;

  const panel = (
    <>
      {/* Subtle backdrop — clicking it closes the panel */}
      <div
        aria-hidden="true"
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0, 0, 0, 0.15)',
          zIndex: 99,
          animation: 'macan-cp-backdrop 200ms ease-out',
        }}
      />

      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`Task details: ${task.name || ''}`}
        className="macan-comment-panel bg-white flex flex-col"
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width: 880,
          maxWidth: '100vw',
          zIndex: 100,
          borderLeft: '1px solid var(--color-border)',
          boxShadow: 'var(--shadow-lg)',
          animation:
            'macan-cp-slide 300ms cubic-bezier(0.4, 0, 0.2, 1)',
        }}
      >
        {/* Header controls: back (when viewing a subitem) + close */}
        <div
          className="flex items-center justify-between"
          style={{
            padding: '12px 16px 0 16px',
          }}
        >
          {canGoBack && onBack ? (
            <button
              type="button"
              onClick={onBack}
              aria-label="Back to parent task"
              className="inline-flex items-center gap-1 font-body transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
              style={{
                height: 32,
                padding: '0 8px',
                background: 'transparent',
                border: 'none',
                borderRadius: 'var(--radius-sm)',
                cursor: 'pointer',
                fontSize: 12,
                fontWeight: 500,
                color: 'var(--color-text-secondary)',
              }}
            >
              <ChevronLeft size={16} aria-hidden="true" />
              Back
            </button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            {taskId && !task.isPersonal && (
              <FollowButton taskId={taskId} isOpen={isOpen} />
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close panel"
              className="flex items-center justify-center rounded-md transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
              style={{ width: 32, height: 32 }}
            >
              <X size={18} color="var(--color-text-secondary)" aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Task detail header */}
        <header
          style={{
            padding: '4px 24px 20px 24px',
            borderBottom: '1px solid var(--color-border)',
          }}
        >
          {editingName ? (
            <input
              ref={nameInputRef}
              type="text"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={commitNameEdit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitNameEdit();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  cancelNameEdit();
                }
              }}
              disabled={savingName}
              aria-label="Task name"
              className="w-full font-display focus:outline-none"
              style={{
                fontSize: 20,
                fontWeight: 700,
                lineHeight: 1.3,
                color: 'var(--color-text-primary)',
                background: 'var(--color-bg-surface, #FFFFFF)',
                border: '1.5px solid var(--color-accent)',
                borderRadius: 'var(--radius-md)',
                padding: '4px 8px',
                boxShadow: '0 0 0 3px rgba(37, 99, 235, 0.12)',
              }}
            />
          ) : (
            <h2
              role={canEditFields ? 'button' : undefined}
              tabIndex={canEditFields ? 0 : -1}
              onClick={
                canEditFields
                  ? () => {
                      setNameDraft(task.name || '');
                      setEditingName(true);
                    }
                  : undefined
              }
              onKeyDown={
                canEditFields
                  ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setNameDraft(task.name || '');
                        setEditingName(true);
                      }
                    }
                  : undefined
              }
              title={canEditFields ? 'Click to edit name' : undefined}
              className={
                canEditFields
                  ? 'font-display transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)]'
                  : 'font-display'
              }
              style={{
                fontSize: 20,
                fontWeight: 700,
                lineHeight: 1.3,
                color: 'var(--color-text-primary)',
                wordBreak: 'break-word',
                cursor: canEditFields ? 'text' : 'default',
                borderRadius: 'var(--radius-md)',
                padding: canEditFields ? '4px 8px' : 0,
                margin: canEditFields ? '-4px -8px' : 0,
              }}
            >
              {task.name}
            </h2>
          )}

          <div
            className="mt-3 flex flex-wrap items-center gap-2"
            aria-label="Task badges"
          >
            {editableStatusPriority && onUpdateTask ? (
              <>
                <PriorityEditor task={task} onUpdateTask={onUpdateTask} />
                <StatusEditor
                  task={task}
                  board={board || task.board}
                  onUpdateTask={onUpdateTask}
                />
              </>
            ) : (
              <>
                {task.priority && <Chip type="priority" value={task.priority} />}
                <Chip
                  type="status"
                  value={task.status || 'not_started'}
                  board={board}
                />
              </>
            )}
          </div>

          <dl className="mt-4 flex flex-col gap-2">
            <MetaRow label="Assigned to">
              {canEditFields ? (
                <div style={{ maxWidth: 280 }}>
                  <AssigneePicker
                    members={pickerMembers}
                    value={assignedIds}
                    onChange={handleAssigneesChange}
                    isAdmin={isAdmin}
                    showNames
                  />
                </div>
              ) : assignees.length > 0 ? (
                <div className="flex items-center gap-2 flex-wrap">
                  {assignees.map((u) => (
                    <span
                      key={u._id || u.email || u.name}
                      className="inline-flex items-center gap-2"
                    >
                      <Avatar user={u} size={20} />
                      <span
                        className="font-body"
                        style={{
                          fontSize: 13,
                          fontWeight: 500,
                          color: 'var(--color-text-primary)',
                        }}
                      >
                        {u.name}
                      </span>
                    </span>
                  ))}
                </div>
              ) : (
                <span
                  className="font-body"
                  style={{ fontSize: 13, color: 'var(--color-text-muted)' }}
                >
                  Unassigned
                </span>
              )}
            </MetaRow>

            <MetaRow label="Due date">
              {canEditFields ? (
                <div style={{ maxWidth: 180 }}>
                  <DatePickerPopover
                    value={toDateInputValue(task.dueDate)}
                    onChange={(val) =>
                      handleDueDateChange({ target: { value: val } })
                    }
                    disabled={savingDueDate}
                    placeholder="Set due date"
                  />
                </div>
              ) : (
                <span
                  className="font-body"
                  style={{
                    fontSize: 13,
                    fontWeight: 500,
                    color: task.dueDate
                      ? 'var(--color-text-primary)'
                      : 'var(--color-text-muted)',
                  }}
                >
                  {task.dueDate ? formatDate(task.dueDate) : 'No due date'}
                </span>
              )}
            </MetaRow>

            {/* Labels row — only meaningful for board tasks */}
            {board && (
              <MetaRow label="Labels">
                <LabelsEditor
                  task={task}
                  board={board}
                  isAdmin={isAdmin}
                  onUpdateTask={onUpdateTask}
                  onEditLabels={onEditLabels}
                />
              </MetaRow>
            )}
          </dl>

          {task.note ? (
            <div className="mt-4">
              <p
                className="font-body"
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.07em',
                  color: 'var(--color-text-muted)',
                  marginBottom: 6,
                }}
              >
                Notes
              </p>
              <p
                className="font-body"
                style={{
                  fontSize: 14,
                  lineHeight: 1.55,
                  color: 'var(--color-text-secondary)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {task.note}
              </p>
            </div>
          ) : null}
        </header>

        {/* Two-column body: tabs on the left, checklist + subitems on the right */}
        <div className="macan-cp-body">
          <div className="macan-cp-left">
            {/* Tabs row */}
            <Tabs
              active={activeTab}
              onChange={setActiveTab}
              tabs={[
                {
                  key: 'updates',
                  label: 'Updates',
                  count: updatesCount,
                  icon: isClientTask ? Lock : null,
                },
                ...(showClientTab
                  ? [
                      {
                        key: 'client',
                        label: 'Client',
                        count: clientCount,
                        icon: Users,
                      },
                    ]
                  : []),
                { key: 'files', label: 'Files', count: filesCount },
                { key: 'activity', label: 'Activity Log' },
              ]}
            />

            {/* Tab content — both threads stay mounted so their counts remain
                live even when the user is browsing another tab. */}
            <div
              style={{
                flex: 1,
                minHeight: 0,
                display: activeTab === 'updates' ? 'flex' : 'none',
                flexDirection: 'column',
              }}
            >
              <UpdatesTab
                task={task}
                audience={updatesAudience}
                onCountChange={setUpdatesCount}
              />
            </div>

            {showClientTab && (
              <div
                style={{
                  flex: 1,
                  minHeight: 0,
                  display: activeTab === 'client' ? 'flex' : 'none',
                  flexDirection: 'column',
                }}
              >
                <UpdatesTab
                  task={task}
                  audience="client"
                  onCountChange={setClientCount}
                />
              </div>
            )}

            {/* Mounted like the threads rather than on first click: the count is
                the only hint that a client attached screenshots to this task, and
                a tab that has to be opened before it will admit it has anything
                in it is a tab nobody opens. */}
            <div
              style={{
                flex: 1,
                minHeight: 0,
                display: activeTab === 'files' ? 'flex' : 'none',
                flexDirection: 'column',
              }}
            >
              <FilesTab task={task} onCountChange={setFilesCount} />
            </div>

            {activeTab === 'activity' && (
              <div
                style={{
                  flex: 1,
                  minHeight: 0,
                  display: 'flex',
                  flexDirection: 'column',
                }}
              >
                <ActivityLogTab taskId={taskId} />
              </div>
            )}

          </div>

          <div className="macan-cp-right" role="complementary" aria-label="Task details sidebar">
            <ChecklistEditor task={task} />
            <SubitemsList
              task={task}
              board={board}
              isAdmin={isAdmin}
              onOpenSubitem={onOpenSubitem}
            />
          </div>
        </div>
      </aside>

      <style>{`
        @keyframes macan-cp-slide {
          from { transform: translateX(100%); }
          to   { transform: translateX(0); }
        }
        @keyframes macan-cp-backdrop {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        .macan-cp-body {
          flex: 1;
          min-height: 0;
          display: grid;
          grid-template-columns: minmax(0, 1fr) 320px;
          gap: 0;
        }
        .macan-cp-left {
          min-width: 0;
          min-height: 0;
          display: flex;
          flex-direction: column;
          border-right: 1px solid var(--color-border);
        }
        .macan-cp-right {
          padding: 16px 20px 24px 20px;
          display: flex;
          flex-direction: column;
          gap: 8px;
          min-height: 0;
          overflow-y: auto;
        }
        @media (max-width: 900px) {
          .macan-cp-body {
            grid-template-columns: 1fr;
          }
          .macan-cp-left {
            border-right: none;
            border-bottom: 1px solid var(--color-border);
          }
        }
        @media (max-width: 767px) {
          .macan-comment-panel {
            width: 100vw !important;
          }
        }

        /* Clean, modern scrollbars inside the panel.
           Hides the native up/down arrow buttons (which look ugly on Windows)
           and renders a thin, subtle thumb. */
        .macan-comment-panel *::-webkit-scrollbar {
          width: 8px;
          height: 8px;
        }
        .macan-comment-panel *::-webkit-scrollbar-track {
          background: transparent;
        }
        .macan-comment-panel *::-webkit-scrollbar-thumb {
          background: var(--color-border-strong);
          border-radius: 8px;
          border: 2px solid transparent;
          background-clip: padding-box;
        }
        .macan-comment-panel *::-webkit-scrollbar-thumb:hover {
          background: var(--color-text-muted);
          background-clip: padding-box;
          border: 2px solid transparent;
        }
        .macan-comment-panel *::-webkit-scrollbar-button,
        .macan-comment-panel *::-webkit-scrollbar-corner {
          display: none;
        }
        .macan-comment-panel * {
          scrollbar-width: thin;
          scrollbar-color: var(--color-border-strong) transparent;
        }
      `}</style>
    </>
  );

  return createPortal(panel, document.body);
};

/**
 * A labelled row inside the task detail header (dt/dd pair).
 */
const MetaRow = ({ label, children }) => (
  <div className="flex items-start gap-3">
    <dt
      className="font-body shrink-0"
      style={{
        fontSize: 12,
        fontWeight: 500,
        color: 'var(--color-text-muted)',
        width: 88,
        paddingTop: 2,
      }}
    >
      {label}
    </dt>
    <dd className="min-w-0 flex-1" style={{ margin: 0 }}>
      {children}
    </dd>
  </div>
);

/**
 * Tabs — pill-underline tabs row used at the top of the panel body.
 * Each tab can carry an optional count badge and an optional leading icon.
 */
const Tabs = ({ tabs, active, onChange }) => (
  <div
    role="tablist"
    aria-label="Task detail tabs"
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 4,
      padding: '0 16px',
      borderBottom: '1px solid var(--color-border)',
      overflowX: 'auto',
    }}
  >
    {tabs.map((t) => {
      const isActive = t.key === active;
      const Icon = t.icon || null;
      return (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={isActive}
          onClick={() => onChange(t.key)}
          className="font-body transition-colors duration-150"
          style={{
            position: 'relative',
            padding: '10px 12px 12px 12px',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            fontSize: 13,
            fontWeight: isActive ? 600 : 500,
            color: isActive
              ? 'var(--color-text-primary)'
              : 'var(--color-text-muted)',
            whiteSpace: 'nowrap',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          {Icon ? <Icon size={12} aria-hidden="true" /> : null}
          <span>{t.label}</span>
          {typeof t.count === 'number' ? (
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: 'var(--color-text-muted)',
              }}
            >
              / {t.count}
            </span>
          ) : null}
          {isActive ? (
            <span
              aria-hidden="true"
              style={{
                position: 'absolute',
                left: 8,
                right: 8,
                bottom: -1,
                height: 2,
                background: 'var(--color-accent)',
                borderRadius: 2,
              }}
            />
          ) : null}
        </button>
      );
    })}
  </div>
);

/**
 * Avatar bubble — profile pic if available, otherwise an initial fallback.
 */
const Avatar = ({ user, size = 28 }) => {
  const [imgError, setImgError] = useState(false);
  const name = user?.name || '';
  const initial = name.charAt(0).toUpperCase() || '?';
  const hasPic = !!user?.profilePic && !imgError;

  const base = {
    width: size,
    height: size,
    borderRadius: '50%',
    flexShrink: 0,
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
        fontSize: Math.round(size * 0.4),
      }}
    >
      {initial}
    </span>
  );
};

/**
 * Inline labels editor for the task detail header. Renders the task's
 * applied labels as removable chips, and exposes a `+` button that opens
 * a small inline picker over the available board labels. Admins also
 * see an "Edit labels" cog that opens the EditChipsModal.
 */
const LabelsEditor = ({ task, board, isAdmin, onUpdateTask, onEditLabels }) => {
  const [pickerOpen, setPickerOpen] = useState(false);
  const taskLabels = useMemo(
    () => (Array.isArray(task.labels) ? task.labels.map((l) => l.toString()) : []),
    [task.labels]
  );
  const boardLabels = useMemo(() => {
    if (!board || !Array.isArray(board.labels)) return [];
    return [...board.labels].sort((a, b) => (a.order || 0) - (b.order || 0));
  }, [board]);
  const labelById = useMemo(() => {
    const m = new Map();
    for (const lb of boardLabels) m.set(lb._id.toString(), lb);
    return m;
  }, [boardLabels]);

  const updateLabels = async (next) => {
    if (!onUpdateTask) return;
    try {
      await onUpdateTask(task._id, { labels: next });
    } catch {
      // toast is surfaced by the parent
    }
  };

  const handleToggle = (labelId) => {
    const idStr = labelId.toString();
    const next = taskLabels.includes(idStr)
      ? taskLabels.filter((id) => id !== idStr)
      : [...taskLabels, idStr];
    updateLabels(next);
  };

  const handleRemove = (labelId) => {
    const idStr = labelId.toString();
    updateLabels(taskLabels.filter((id) => id !== idStr));
  };

  const available = boardLabels.filter(
    (l) => !taskLabels.includes(l._id.toString())
  );

  return (
    <div className="flex items-center gap-2 flex-wrap" style={{ minHeight: 24 }}>
      {taskLabels.length === 0 && (
        <span
          className="font-body"
          style={{ fontSize: 13, color: 'var(--color-text-muted)' }}
        >
          No labels
        </span>
      )}
      {taskLabels.map((id) => {
        const lb = labelById.get(id);
        if (!lb) return null;
        const pair = getColorPair(lb.color);
        return (
          <span
            key={id}
            className="inline-flex items-center gap-1 font-body font-medium"
            style={{
              fontSize: 12,
              padding: '3px 4px 3px 10px',
              borderRadius: 'var(--radius-full)',
              backgroundColor: pair.bg,
              color: pair.text,
            }}
          >
            {lb.name}
            {isAdmin && (
              <button
                type="button"
                onClick={() => handleRemove(id)}
                aria-label={`Remove ${lb.name}`}
                style={{
                  width: 14,
                  height: 14,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'transparent',
                  border: 'none',
                  color: 'inherit',
                  cursor: 'pointer',
                  borderRadius: '50%',
                  opacity: 0.7,
                }}
              >
                <X size={10} />
              </button>
            )}
          </span>
        );
      })}
      {isAdmin && (
        <div style={{ position: 'relative' }}>
          <button
            type="button"
            onClick={() => setPickerOpen((v) => !v)}
            aria-label="Add label"
            className="inline-flex items-center justify-center rounded transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
            style={{
              width: 22,
              height: 22,
              background: 'transparent',
              border: '1px dashed var(--color-border-strong)',
              color: 'var(--color-text-muted)',
              cursor: 'pointer',
            }}
          >
            <Plus size={12} aria-hidden="true" />
          </button>
          {pickerOpen && (
            <div
              role="listbox"
              onMouseLeave={() => setPickerOpen(false)}
              style={{
                position: 'absolute',
                top: 28,
                left: 0,
                zIndex: 60,
                minWidth: 200,
                background: '#FFFFFF',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-md)',
                boxShadow: 'var(--shadow-md)',
                padding: 6,
              }}
            >
              {available.length === 0 ? (
                <p
                  className="font-body text-center"
                  style={{
                    fontSize: 12,
                    color: 'var(--color-text-muted)',
                    padding: '8px',
                  }}
                >
                  All labels applied
                </p>
              ) : (
                available.map((lb) => {
                  const pair = getColorPair(lb.color);
                  return (
                    <button
                      key={lb._id}
                      type="button"
                      onClick={() => {
                        handleToggle(lb._id);
                        setPickerOpen(false);
                      }}
                      className="w-full text-left transition-opacity hover:opacity-90 focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
                      style={{
                        margin: '2px 0',
                        padding: '4px 6px',
                        background: 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                        borderRadius: 'var(--radius-sm)',
                      }}
                    >
                      <span
                        className="inline-flex items-center font-body font-medium"
                        style={{
                          fontSize: 12,
                          padding: '3px 10px',
                          borderRadius: 'var(--radius-full)',
                          backgroundColor: pair.bg,
                          color: pair.text,
                        }}
                      >
                        {lb.name}
                      </span>
                    </button>
                  );
                })
              )}
              {onEditLabels && (
                <button
                  type="button"
                  onClick={() => {
                    setPickerOpen(false);
                    onEditLabels();
                  }}
                  className="w-full flex items-center gap-2 font-body transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)]"
                  style={{
                    marginTop: 6,
                    padding: '6px 10px',
                    fontSize: 12,
                    fontWeight: 500,
                    color: 'var(--color-text-secondary)',
                    background: 'transparent',
                    border: 'none',
                    borderTop: '1px solid var(--color-border)',
                    borderRadius: 'var(--radius-sm)',
                    cursor: 'pointer',
                  }}
                >
                  <SettingsIcon size={12} aria-hidden="true" />
                  Edit Labels
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Inline status / priority editors                                    */
/* ------------------------------------------------------------------ */

// Priority options in severity order.
const PRIORITY_OPTIONS = ['critical', 'high', 'medium', 'low'];

// Legacy enum statuses — used for personal tasks (no board) and as a fallback
// for board tasks whose `status` is still the pre-migration enum string.
const LEGACY_STATUS_OPTIONS = ['not_started', 'working_on_it', 'done', 'stuck'];

/**
 * A Chip-styled trigger that opens a dropdown of colored option pills.
 * `value` is compared against each option's `value` to mark the current
 * selection; `onSelect` receives the chosen value and may return a promise
 * (the chip shows a brief saving state while it resolves).
 */
const InlineSelectChip = ({ value, current, options, onSelect, ariaLabel }) => {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const handlePick = async (opt) => {
    setOpen(false);
    if (opt.value === value) return;
    setSaving(true);
    try {
      await onSelect(opt.value);
    } catch {
      // Parent surfaces a toast and rolls the value back.
    } finally {
      setSaving(false);
    }
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={saving}
        className="inline-flex items-center gap-1 font-body font-medium text-[12px] leading-none whitespace-nowrap transition-opacity duration-150 hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
        style={{
          backgroundColor: current.bg,
          color: current.text,
          borderRadius: 'var(--radius-full)',
          padding: '3px 8px 3px 10px',
          border: 'none',
          cursor: saving ? 'wait' : 'pointer',
          opacity: saving ? 0.6 : 1,
        }}
      >
        {current.label}
        <ChevronDown
          size={12}
          aria-hidden="true"
          style={{
            transition: 'transform 150ms ease-in-out',
            transform: open ? 'rotate(180deg)' : 'rotate(0)',
          }}
        />
      </button>

      {open && (
        <ul
          role="listbox"
          aria-label={ariaLabel}
          className="overflow-auto"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            zIndex: 120,
            minWidth: 200,
            maxHeight: 280,
            listStyle: 'none',
            margin: 0,
            padding: 4,
            background: '#FFFFFF',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            boxShadow: 'var(--shadow-lg)',
          }}
        >
          {options.map((opt) => {
            const selected = opt.value === value;
            return (
              <li key={opt.value} role="option" aria-selected={selected}>
                <button
                  type="button"
                  onClick={() => handlePick(opt)}
                  className="w-full flex items-center gap-2 text-left transition-colors duration-100 hover:bg-[color:var(--color-bg-subtle)] focus:outline-none focus-visible:bg-[color:var(--color-bg-subtle)]"
                  style={{
                    padding: '6px 8px',
                    background: 'transparent',
                    border: 'none',
                    borderRadius: 'var(--radius-sm)',
                    cursor: 'pointer',
                  }}
                >
                  <span
                    className="inline-flex items-center font-body font-medium text-[12px] leading-none"
                    style={{
                      backgroundColor: opt.bg,
                      color: opt.text,
                      borderRadius: 'var(--radius-full)',
                      padding: '3px 10px',
                    }}
                  >
                    {opt.label}
                  </span>
                  {selected && (
                    <Check
                      size={14}
                      strokeWidth={3}
                      aria-hidden="true"
                      style={{ marginLeft: 'auto', color: 'var(--color-accent)' }}
                    />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

/**
 * Priority dropdown — the four fixed severity levels.
 */
const PriorityEditor = ({ task, onUpdateTask }) => {
  const value = task.priority || 'low';
  const cur = PRIORITY_COLORS[value] || PRIORITY_COLORS.low;
  const options = PRIORITY_OPTIONS.map((p) => {
    const c = PRIORITY_COLORS[p];
    return { value: p, label: c.label, bg: c.bg, text: c.text };
  });
  return (
    <InlineSelectChip
      value={value}
      current={{ label: cur.label, bg: cur.bg, text: cur.text }}
      options={options}
      ariaLabel="Change priority"
      onSelect={(v) => onUpdateTask(task._id, { priority: v })}
    />
  );
};

/**
 * Status dropdown. Resolves its options from the board's custom statuses when
 * available (board tasks), otherwise falls back to the legacy enum (personal
 * tasks). `board` may come from the prop or `task.board`.
 */
const StatusEditor = ({ task, board, onUpdateTask }) => {
  const boardStatuses =
    board && Array.isArray(board.statuses) && board.statuses.length
      ? board.statuses
      : null;

  let options;
  let current;

  if (boardStatuses) {
    options = [...boardStatuses]
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .map((s) => {
        const pair = getColorPair(s.color);
        return { value: s._id.toString(), label: s.name, bg: pair.bg, text: pair.text };
      });
    const valStr = task.status != null ? task.status.toString() : null;
    current =
      options.find((o) => o.value === valStr) || {
        label: 'Not Started',
        bg: STATUS_COLORS.not_started.bg,
        text: STATUS_COLORS.not_started.text,
      };
    return (
      <InlineSelectChip
        value={current.value ?? null}
        current={current}
        options={options}
        ariaLabel="Change status"
        onSelect={(v) => onUpdateTask(task._id, { status: v })}
      />
    );
  }

  // Legacy enum (personal tasks).
  options = LEGACY_STATUS_OPTIONS.map((s) => {
    const c = STATUS_COLORS[s];
    return { value: s, label: c.label, bg: c.bg, text: c.text };
  });
  const val = task.status || 'not_started';
  const c = STATUS_COLORS[val] || STATUS_COLORS.not_started;
  current = { label: c.label, bg: c.bg, text: c.text };
  return (
    <InlineSelectChip
      value={val}
      current={current}
      options={options}
      ariaLabel="Change status"
      onSelect={(v) => onUpdateTask(task._id, { status: v })}
    />
  );
};

export default CommentPanel;
