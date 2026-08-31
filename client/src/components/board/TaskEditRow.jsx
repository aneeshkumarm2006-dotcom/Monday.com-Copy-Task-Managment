import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, X, Eye, EyeOff } from 'lucide-react';
import Chip from '../ui/Chip';
import StatusMenu from './StatusMenu';
import PriorityMenu from './PriorityMenu';
import AssigneePicker from './AssigneePicker';
import DatePickerPopover from '../ui/DatePickerPopover';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import { dateInputToISO } from '../../utils/dateUtils';

const sameStringSet = (a, b) => {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
};

/**
 * TaskEditRow — inline editable row used for both creating and editing
 * a task within a group's TaskTable.
 *
 * The Status chip reads its options from the board's `statuses` array
 * when a board is passed in (post Phase 2). Falls back to the legacy 4-enum
 * options if no board is provided (kept for safety / personal task lists).
 *
 * Props:
 *   board        — board doc with `statuses[]`
 *   members      — the board's members ({ _id, name, profilePic })
 *   initialTask  — optional existing task (for edit mode)
 *   onSave       — async (payload) => void
 *   onCancel     — () => void
 *   isLast       — removes bottom border when this is the last row
 *   askPortalShare — Client Portal boards only: on save, ask whether the new
 *                  task should also appear in the client's portal
 *   canAssignOthers — holds `task.assign`. False for a `contribute` member, who
 *                  may put only their OWN name on a task (see AssigneePicker).
 *   selfId       — the current user's id, i.e. the one row that stays live.
 */

const toDateInputValue = (d) => {
  if (!d) return '';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const TaskEditRow = ({
  board = null,
  members = [],
  initialTask = null,
  onSave,
  onCancel,
  isLast = false,
  isAdmin = false,
  autoFocus = true,
  // When true the name field is indented to align with subtask rows rendered
  // beneath an expanded parent (see TaskTable's SubtaskSection).
  isSubtask = false,
  askPortalShare = false,
  canAssignOthers = true,
  selfId = null,
}) => {
  // Resolve initial status. If the task has one, use it; otherwise pick the
  // first board status (or the legacy `not_started` enum for boardless rows).
  const initialStatus = useMemo(() => {
    if (initialTask?.status) return initialTask.status.toString();
    if (board && Array.isArray(board.statuses) && board.statuses.length > 0) {
      const sorted = [...board.statuses].sort(
        (a, b) => (a.order || 0) - (b.order || 0),
      );
      return sorted[0]._id.toString();
    }
    return 'not_started';
  }, [initialTask, board]);

  const [name, setName] = useState(initialTask?.name || '');
  const [priority, setPriority] = useState(initialTask?.priority || 'medium');
  const [status, setStatus] = useState(initialStatus);
  const [assignedTo, setAssignedTo] = useState(() => {
    const raw = initialTask?.assignedTo || [];
    return raw.map((u) => (typeof u === 'string' ? u : u._id));
  });
  const [dueDate, setDueDate] = useState(() =>
    toDateInputValue(initialTask?.dueDate)
  );
  const [saving, setSaving] = useState(false);
  // Client Portal: the audience question, asked between "save" and the actual
  // write. Nothing is created while this is open, so backing out of it returns
  // the user to a row that still has everything they typed.
  const [askingShare, setAskingShare] = useState(false);
  const [statusError, setStatusError] = useState('');
  const [statusMenuAnchor, setStatusMenuAnchor] = useState(null);
  const [priorityMenuAnchor, setPriorityMenuAnchor] = useState(null);
  const nameInputRef = useRef(null);
  const statusCellRef = useRef(null);

  useEffect(() => {
    if (autoFocus) nameInputRef.current?.focus();
  }, [autoFocus]);

  const canSave = name.trim().length > 0 && !saving;

  // On a Client Portal board the audience of a new task is a real decision, so
  // it is asked once, at the moment of saving, rather than left to a checkbox
  // nobody notices in a row of six other controls. Editing an existing task
  // skips it — the row menu and the task panel own that flip.
  const handleSave = () => {
    if (!canSave) return;
    if (!initialTask && askPortalShare) {
      setAskingShare(true);
      return;
    }
    return commitSave(false);
  };

  const commitSave = async (portalShared) => {
    if (!canSave) return;
    setAskingShare(false);
    setSaving(true);
    setStatusError('');

    const trimmedName = name.trim();
    const isoDue = dateInputToISO(dueDate);

    let payload;
    if (!initialTask) {
      payload = {
        name: trimmedName,
        priority,
        status,
        assignedTo,
        dueDate: isoDue,
        sendEmailNotification: true,
        // Only sent when the board actually has a portal to share into; the
        // server refuses the flag anywhere else rather than quietly ignoring it.
        ...(askPortalShare ? { portalShared } : {}),
      };
    } else {
      payload = {};
      if (trimmedName !== (initialTask.name || '')) payload.name = trimmedName;
      if (priority !== (initialTask.priority || 'medium')) payload.priority = priority;
      if (status !== initialStatus) payload.status = status;

      const prevAssignees = (initialTask.assignedTo || []).map((u) =>
        typeof u === 'string' ? u : u._id
      );
      if (!sameStringSet(prevAssignees, assignedTo)) payload.assignedTo = assignedTo;

      const prevIso = dateInputToISO(initialTask.dueDate);
      if (isoDue !== prevIso) payload.dueDate = isoDue;

      if (Object.keys(payload).length === 0) {
        setSaving(false);
        onCancel?.();
        return;
      }
      payload.sendEmailNotification = true;
    }

    try {
      await onSave?.(payload);
    } catch (err) {
      setSaving(false);
      const data = err?.response?.data;
      if (data?.field === 'status') {
        setStatusError(data.error || 'Invalid status for this board');
        if (statusCellRef.current) {
          statusCellRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
      }
    }
  };

  const handleCancel = () => {
    setAskingShare(false);
    if (!initialTask) {
      setName('');
      setPriority('medium');
      setStatus(initialStatus);
      setAssignedTo([]);
      setDueDate('');
      onCancel?.();
    } else {
      onCancel?.();
    }
  };

  const handleKeyDown = (e) => {
    if (e.target.closest('[role="listbox"]') || e.target.closest('[role="option"]')) {
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSave();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      handleCancel();
    }
  };

  const mainRowBorder = isLast ? 'none' : '1px solid var(--color-border)';

  return (
    <>
    <tr
      style={{
        height: 56,
        borderBottom: mainRowBorder,
        background: 'var(--color-bg-subtle)',
      }}
      onKeyDown={handleKeyDown}
    >
      {/* Drag handle column (visual alignment only — editing rows aren't sortable) */}
      <td style={{ width: 24, padding: 0 }} />
      <td style={{ width: 40, padding: '0 0 0 16px' }} />

      <td style={{ padding: '0 16px', minWidth: 240 }}>
        <input
          ref={nameInputRef}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={isSubtask ? 'Subtask name…' : 'Task name…'}
          aria-label={isSubtask ? 'Subtask name' : 'Task name'}
          className="w-full font-body bg-white focus:outline-none"
          style={{
            fontSize: 14,
            height: 32,
            padding: '0 10px',
            marginLeft: isSubtask ? 28 : 0,
            width: isSubtask ? 'calc(100% - 28px)' : '100%',
            border: '1.5px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            color: 'var(--color-text-primary)',
          }}
          onFocus={(e) => {
            e.currentTarget.style.border = '1.5px solid var(--color-accent)';
            e.currentTarget.style.boxShadow = '0 0 0 3px rgba(37, 99, 235, 0.12)';
          }}
          onBlur={(e) => {
            e.currentTarget.style.border = '1.5px solid var(--color-border)';
            e.currentTarget.style.boxShadow = 'none';
          }}
        />
      </td>

      <td style={{ width: 130, padding: '0 16px' }}>
        <Chip
          type="priority"
          value={priority}
          onClick={(e) => setPriorityMenuAnchor(e.currentTarget)}
        />
      </td>

      <td
        ref={statusCellRef}
        style={{
          width: 160,
          padding: '0 16px',
          outline: statusError
            ? '2px solid var(--color-status-stuck)'
            : 'none',
          outlineOffset: -2,
          borderRadius: 0,
          transition: 'outline-color 150ms ease-in-out',
        }}
        title={statusError || undefined}
      >
        <Chip
          type="status"
          value={status}
          board={board}
          onClick={(e) => setStatusMenuAnchor(e.currentTarget)}
        />
      </td>

      {/* Labels column placeholder — edited from the comment panel / picker */}
      <td style={{ width: 180, padding: '0 8px' }}>
        <span
          className="font-body"
          style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
        >
          —
        </span>
      </td>

      <td style={{ width: 160, padding: '0 8px' }}>
        <AssigneePicker
          members={members}
          value={assignedTo}
          onChange={setAssignedTo}
          isAdmin={isAdmin}
          canAssignOthers={canAssignOthers}
          selfId={selfId}
        />
      </td>

      <td style={{ width: 140, padding: '0 8px' }}>
        <DatePickerPopover
          value={dueDate}
          onChange={setDueDate}
          placeholder="Due date"
        />
      </td>

      <td style={{ width: 48 }} />

      <td style={{ width: 72, padding: '0 8px 0 0' }}>
        <div className="flex items-center gap-1 justify-end">
          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave}
            aria-label="Save task"
            className="flex items-center justify-center rounded-md transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)] disabled:opacity-50 disabled:cursor-not-allowed"
            style={{
              width: 28,
              height: 28,
              background: 'var(--color-accent)',
              color: '#FFFFFF',
              border: 'none',
              cursor: canSave ? 'pointer' : 'not-allowed',
            }}
          >
            <Check size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={handleCancel}
            aria-label="Cancel"
            className="flex items-center justify-center rounded-md transition-colors duration-150 hover:bg-[color:var(--color-border)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
            style={{
              width: 28,
              height: 28,
              background: 'transparent',
              border: '1.5px solid var(--color-border-strong)',
              color: 'var(--color-text-secondary)',
            }}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      </td>
    </tr>
    {priorityMenuAnchor && (
      <PriorityMenu
        anchorEl={priorityMenuAnchor}
        value={priority}
        onSelect={(val) => {
          setPriority(val);
          setPriorityMenuAnchor(null);
        }}
        onClose={() => setPriorityMenuAnchor(null)}
      />
    )}
    {statusMenuAnchor && (
      <StatusMenu
        anchorEl={statusMenuAnchor}
        board={board}
        value={status}
        onSelect={(val) => {
          setStatusError('');
          setStatus(val.toString());
          setStatusMenuAnchor(null);
        }}
        onClose={() => setStatusMenuAnchor(null)}
      />
    )}
    {/* Closing without choosing creates nothing — the row keeps its values so
        the user can carry on editing. That is why the two real answers are both
        buttons in the footer and neither is the dialog's dismiss action. */}
    <Modal
      isOpen={askingShare}
      onClose={() => setAskingShare(false)}
      title="Show this in the client portal?"
      maxWidth={470}
      footer={
        <>
          <Button
            variant="secondary"
            icon={EyeOff}
            onClick={() => commitSave(false)}
            disabled={saving}
          >
            Keep internal
          </Button>
          <Button
            variant="primary"
            icon={Eye}
            onClick={() => commitSave(true)}
            disabled={saving}
          >
            Show to client
          </Button>
        </>
      }
    >
      <p
        className="font-body"
        style={{
          fontSize: 14,
          lineHeight: 1.6,
          color: 'var(--color-text-secondary)',
          margin: 0,
        }}
      >
        <strong style={{ color: 'var(--color-text-primary)' }}>
          {name.trim()}
        </strong>{' '}
        is on a client board. Show it in the portal when it&rsquo;s something you
        need <em>from</em> the client — they&rsquo;ll see its name, status and due
        date, and can reply on it.
      </p>
      <p
        className="font-body"
        style={{
          fontSize: 13,
          lineHeight: 1.6,
          color: 'var(--color-text-muted)',
          margin: '10px 0 0',
        }}
      >
        Assignees, priority and your team&rsquo;s Updates thread stay private
        either way. You can change this later from the row&rsquo;s ⋯ menu.
      </p>
    </Modal>
    </>
  );
};

export default TaskEditRow;
