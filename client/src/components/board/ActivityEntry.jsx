import {
  Plus,
  Trash2,
  Pencil,
  CheckSquare,
  Square,
  Tag,
  UserPlus,
  Flag,
  Calendar,
  StickyNote,
  ListChecks,
  Paperclip,
  MessageSquare,
  FileText,
  ArrowRight,
  Activity as ActivityIcon,
} from 'lucide-react';
import { timeAgo, formatDate } from '../../utils/dateUtils';

const LEGACY_STATUS_LABELS = {
  not_started: 'Not started',
  working_on_it: 'Working on it',
  done: 'Done',
  stuck: 'Stuck',
};

const FIELD_LABELS = {
  name: 'name',
  status: 'status',
  priority: 'priority',
  assignees: 'assignees',
  dueDate: 'due date',
  labels: 'labels',
  note: 'notes',
  group: 'group',
};

const formatDateValue = (value) => {
  if (!value) return 'no date';
  return formatDate(value);
};

const Pill = ({ children, color }) => (
  <span
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      padding: '1px 8px',
      borderRadius: 999,
      fontSize: 11,
      fontWeight: 600,
      background: color || 'var(--color-bg-subtle, #F3F4F6)',
      color: color ? '#FFFFFF' : 'var(--color-text-secondary)',
      lineHeight: '18px',
      maxWidth: 180,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    }}
  >
    {children}
  </span>
);

const Quoted = ({ children, muted = false }) => (
  <span
    style={{
      fontWeight: muted ? 400 : 600,
      color: muted ? 'var(--color-text-muted)' : 'var(--color-text-primary)',
      fontStyle: muted ? 'italic' : 'normal',
    }}
  >
    {children}
  </span>
);

const Arrow = () => (
  <ArrowRight
    size={12}
    aria-hidden="true"
    style={{
      display: 'inline-block',
      verticalAlign: '-2px',
      margin: '0 4px',
      color: 'var(--color-text-muted)',
    }}
  />
);

/**
 * Render a single resolved value into a chip/pill, falling back to a muted
 * "empty" pill when null/undefined. Used for status, priority, due date
 * before/after pairs.
 */
const renderScalarValue = (field, value) => {
  if (value === null || value === undefined || value === '') {
    return <Quoted muted>none</Quoted>;
  }

  if (field === 'status') {
    if (typeof value === 'string') {
      return <Pill>{LEGACY_STATUS_LABELS[value] || value}</Pill>;
    }
    return <Pill color={value.color}>{value.name}</Pill>;
  }

  if (field === 'priority') {
    return <Quoted>{value}</Quoted>;
  }

  if (field === 'dueDate') {
    return <Quoted>{formatDateValue(value)}</Quoted>;
  }

  if (field === 'name' || field === 'note') {
    const text = String(value);
    const truncated = text.length > 80 ? `${text.slice(0, 80)}…` : text;
    return <Quoted>“{truncated}”</Quoted>;
  }

  if (field === 'group') {
    return <Quoted>{value.toString().slice(-6)}</Quoted>;
  }

  return <Quoted>{String(value)}</Quoted>;
};

/**
 * Compute added/removed members from two arrays of resolved member objects.
 */
const diffMembers = (oldArr, newArr) => {
  const oldIds = new Set((oldArr || []).map((m) => m.id));
  const newIds = new Set((newArr || []).map((m) => m.id));
  const added = (newArr || []).filter((m) => !oldIds.has(m.id));
  const removed = (oldArr || []).filter((m) => !newIds.has(m.id));
  return { added, removed };
};

/**
 * Pick an icon for an event type. Field changes drill into the field.
 */
const iconFor = (entry) => {
  if (entry.type === 'task.created') return Plus;
  if (entry.type === 'task.deleted') return Trash2;
  if (entry.type === 'task.field_changed') {
    if (entry.field === 'status') return ActivityIcon;
    if (entry.field === 'priority') return Flag;
    if (entry.field === 'assignees') return UserPlus;
    if (entry.field === 'dueDate') return Calendar;
    if (entry.field === 'labels') return Tag;
    if (entry.field === 'note') return StickyNote;
    if (entry.field === 'name') return Pencil;
    return Pencil;
  }
  if (entry.type === 'checklist.added') return Plus;
  if (entry.type === 'checklist.toggled') {
    return entry.newValue ? CheckSquare : Square;
  }
  if (entry.type === 'checklist.renamed') return Pencil;
  if (entry.type === 'checklist.deleted') return Trash2;
  if (entry.type === 'checklist.reordered') return ListChecks;
  if (entry.type === 'attachment.uploaded') return Paperclip;
  if (entry.type === 'attachment.deleted') return Trash2;
  if (entry.type === 'comment.added') return MessageSquare;
  if (entry.type === 'update.added') return FileText;
  if (entry.type === 'client.request_created') return Plus;
  if (entry.type === 'client.update_added') return MessageSquare;
  return ActivityIcon;
};

/**
 * Build the inline JSX describing what changed. Keeps templates per type
 * grouped here so a future event type just needs a new branch.
 */
const renderBody = (entry) => {
  const actorName = entry.actor?.name || 'Someone';
  const Actor = <strong style={{ color: 'var(--color-text-primary)' }}>{actorName}</strong>;

  if (entry.type === 'task.created') {
    return (
      <span>
        {Actor} created the task.
      </span>
    );
  }
  if (entry.type === 'task.deleted') {
    return (
      <span>
        {Actor} deleted the task.
      </span>
    );
  }

  if (entry.type === 'task.field_changed') {
    const label = FIELD_LABELS[entry.field] || entry.field;

    if (entry.field === 'assignees') {
      const { added, removed } = diffMembers(entry.oldValue, entry.newValue);
      const parts = [];
      if (added.length > 0) {
        parts.push(
          <span key="added">
            assigned {added.map((m, i) => (
              <span key={m.id}>
                {i > 0 ? ', ' : ''}
                <Quoted>{m.name}</Quoted>
              </span>
            ))}
          </span>
        );
      }
      if (removed.length > 0) {
        parts.push(
          <span key="removed">
            {parts.length > 0 ? ' and ' : ''}unassigned {removed.map((m, i) => (
              <span key={m.id}>
                {i > 0 ? ', ' : ''}
                <Quoted>{m.name}</Quoted>
              </span>
            ))}
          </span>
        );
      }
      return (
        <span>
          {Actor} {parts.length > 0 ? parts : <>updated assignees</>}.
        </span>
      );
    }

    if (entry.field === 'labels') {
      const { added, removed } = diffMembers(entry.oldValue, entry.newValue);
      const parts = [];
      if (added.length > 0) {
        parts.push(
          <span key="added">
            added {added.map((m, i) => (
              <span key={m.id}>
                {i > 0 ? ', ' : ''}
                <Pill color={m.color}>{m.name}</Pill>
              </span>
            ))}
          </span>
        );
      }
      if (removed.length > 0) {
        parts.push(
          <span key="removed">
            {parts.length > 0 ? ' and ' : ''}removed {removed.map((m, i) => (
              <span key={m.id}>
                {i > 0 ? ', ' : ''}
                <Pill color={m.color}>{m.name}</Pill>
              </span>
            ))}
          </span>
        );
      }
      return (
        <span>
          {Actor} {parts.length > 0 ? parts : <>updated labels</>}.
        </span>
      );
    }

    return (
      <span>
        {Actor} changed {label} from {renderScalarValue(entry.field, entry.oldValue)}
        <Arrow />
        {renderScalarValue(entry.field, entry.newValue)}.
      </span>
    );
  }

  if (entry.type === 'checklist.added') {
    return (
      <span>
        {Actor} added checklist item <Quoted>“{entry.metadata?.itemText || 'item'}”</Quoted>.
      </span>
    );
  }
  if (entry.type === 'checklist.toggled') {
    const done = !!entry.newValue;
    return (
      <span>
        {Actor} {done ? 'checked off' : 'unchecked'} <Quoted>“{entry.metadata?.itemText || 'item'}”</Quoted>.
      </span>
    );
  }
  if (entry.type === 'checklist.renamed') {
    return (
      <span>
        {Actor} renamed checklist item from <Quoted>“{entry.oldValue}”</Quoted>
        <Arrow />
        <Quoted>“{entry.newValue}”</Quoted>.
      </span>
    );
  }
  if (entry.type === 'checklist.deleted') {
    return (
      <span>
        {Actor} deleted checklist item <Quoted>“{entry.metadata?.itemText || 'item'}”</Quoted>.
      </span>
    );
  }
  if (entry.type === 'checklist.reordered') {
    return (
      <span>
        {Actor} reordered the checklist.
      </span>
    );
  }
  if (entry.type === 'attachment.uploaded') {
    return (
      <span>
        {Actor} uploaded <Quoted>{entry.metadata?.attachmentName || 'file'}</Quoted>.
      </span>
    );
  }
  if (entry.type === 'attachment.deleted') {
    return (
      <span>
        {Actor} deleted attachment <Quoted>{entry.metadata?.attachmentName || 'file'}</Quoted>.
      </span>
    );
  }
  if (entry.type === 'comment.added') {
    const snippet = entry.metadata?.commentSnippet;
    return (
      <span>
        {Actor} commented{snippet ? <>: <Quoted muted>“{snippet}”</Quoted></> : '.'}
      </span>
    );
  }
  if (entry.type === 'update.added') {
    const snippet = entry.metadata?.updateSnippet;
    // The activity log is team-only, so an internal note is safe to quote here —
    // but it must say which thread it landed in, or the timeline reads as if the
    // client were told something they weren't.
    const what = entry.metadata?.internal ? 'posted an internal note' : 'posted an update';
    return (
      <span>
        {Actor} {what}{snippet ? <>: <Quoted muted>“{snippet}”</Quoted></> : '.'}
      </span>
    );
  }
  if (entry.type === 'client.request_created') {
    return (
      <span>
        {Actor} <span style={{ color: 'var(--color-accent)', fontWeight: 600 }}>(client)</span> raised this request.
      </span>
    );
  }
  if (entry.type === 'client.update_added') {
    const snippet = entry.metadata?.updateSnippet;
    return (
      <span>
        {Actor} <span style={{ color: 'var(--color-accent)', fontWeight: 600 }}>(client)</span> sent a message{snippet ? <>: <Quoted muted>“{snippet}”</Quoted></> : '.'}
      </span>
    );
  }

  return <span>{Actor} performed an action.</span>;
};

/**
 * ActivityEntry — a single row in the activity timeline.
 */
const ActivityEntry = ({ entry }) => {
  const Icon = iconFor(entry);
  const initials = (entry.actor?.name || '?')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase())
    .join('');

  return (
    <li
      className="flex items-start gap-3"
      style={{ padding: '12px 0' }}
    >
      {/* Avatar */}
      <div
        aria-hidden="true"
        style={{
          width: 32,
          height: 32,
          borderRadius: '50%',
          flexShrink: 0,
          background: 'var(--color-bg-subtle, #F3F4F6)',
          color: 'var(--color-text-secondary)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 12,
          fontWeight: 600,
          overflow: 'hidden',
          border: '1px solid var(--color-border)',
        }}
      >
        {entry.actor?.profilePic ? (
          <img
            src={entry.actor.profilePic}
            alt=""
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          initials || '?'
        )}
      </div>

      {/* Body */}
      <div className="min-w-0 flex-1">
        <p
          className="font-body"
          style={{
            fontSize: 13,
            lineHeight: 1.5,
            color: 'var(--color-text-secondary)',
            margin: 0,
            wordBreak: 'break-word',
          }}
        >
          {renderBody(entry)}
        </p>
        <div
          className="flex items-center gap-2"
          style={{ marginTop: 2, fontSize: 11, color: 'var(--color-text-muted)' }}
        >
          <Icon size={11} aria-hidden="true" />
          <span title={new Date(entry.createdAt).toLocaleString()}>
            {timeAgo(entry.createdAt)}
          </span>
        </div>
      </div>
    </li>
  );
};

export default ActivityEntry;
