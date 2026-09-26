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
  Pin,
  Eye,
  EyeOff,
  Target,
  Gauge,
  Crosshair,
  Bot,
  Activity as ActivityIcon,
} from 'lucide-react';
import { timeAgo, formatDate } from '../../utils/dateUtils';
import { weightLabel } from '../../utils/goalDisplay';
import { formatIn } from '../../utils/money';

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
  pinned: 'pin',
  portalShared: 'client visibility',
  // Monthly goals. `name` and `note` above mean the same thing on a goal.
  goalType: 'kind of goal',
  weight: 'importance',
  owner: 'owner',
  unit: 'unit',
  actual: 'result',
  actualDayKey: 'the day it was done',
};

/** 'atMost' is a storage key; "stay below" is the choice somebody made. */
const DIRECTION_LABELS = { atMost: 'stay below', atLeast: 'stay above' };

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

  if (field === 'pinned') {
    return <Quoted>{value ? 'pinned' : 'not pinned'}</Quoted>;
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

// ---------------------------------------------------------------------------
// Flexible-column changes
//
// The JSX mirror of `describeColumnChange` / `columnScalarText` in
// server/src/services/activityFormat.js — same branches, same words, so a
// change reads the same in this panel and in the exported report. Driven by
// `metadata.columnType`, which the writer stamps because the stored value alone
// cannot say whether `["65f…"]` is people, tags or files.
// ---------------------------------------------------------------------------

const isBlank = (v) =>
  v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

/**
 * Money in the currency recorded IN THE ROW — the unit at write time. A
 * board's currency can be changed later, and that relabels without converting,
 * so today's unit would misstate what was typed. Cents only when there are some.
 */
const moneyText = (value, code) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  const decimals = Number.isInteger(n) ? 0 : 2;
  if (!code) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return formatIn(n, code, { decimals });
};

/** One side of a column change as text, or null when it is empty. */
const columnScalarText = (type, value, meta = {}) => {
  if (isBlank(value)) return null;
  switch (type) {
    case 'number':
      if (typeof value !== 'number') return String(value);
      return meta.currency
        ? moneyText(value, meta.currency)
        : value.toLocaleString('en-US', { maximumFractionDigits: 2 });
    case 'rating':
      return String(value);
    case 'date':
      return formatDate(value) || String(value);
    case 'status':
    case 'dropdown':
      return meta.optionLabels?.[String(value)] || 'a removed choice';
    case 'text':
    case 'long_text':
    case 'email':
    case 'phone': {
      const text = String(value);
      return `“${text.length > 80 ? `${text.slice(0, 80)}…` : text}”`;
    }
    case 'link':
      if (typeof value === 'object') return value.label || value.url || null;
      return String(value);
    case 'client': {
      // `{ boardId, name }` — the name is the snapshot the server stamped from
      // the client board (or typed, for a client with no board), so the row
      // reads "set Client to Acme" even for somebody who cannot open Acme's
      // board, and still does after that board is renamed or gone. Same words
      // as the server's `columnScalarText`.
      if (typeof value === 'object') {
        const name = typeof value.name === 'string' ? value.name.trim() : '';
        if (!name) return null;
        return name.length > 80 ? `${name.slice(0, 80)}…` : name;
      }
      const text = String(value);
      return text.length > 80 ? `${text.slice(0, 80)}…` : text;
    }
    default:
      return null;
  }
};

/** "a", "a and b", "a, b and c". */
const andList = (arr) => {
  if (!arr.length) return '';
  if (arr.length === 1) return arr[0];
  return `${arr.slice(0, -1).join(', ')} and ${arr[arr.length - 1]}`;
};

/**
 * A typed column change as a sentence body (everything after the actor), or
 * null for a type with no sentence of its own — the caller then falls back to
 * "updated <column>".
 */
const renderColumnChange = (entry, Actor, colLabel) => {
  const meta = entry.metadata || {};
  const type = meta.columnType;
  const oldV = entry.oldValue;
  const newV = entry.newValue;
  const Col = <Quoted>{colLabel}</Quoted>;

  if (type === 'person') {
    // Already resolved to { id, name } by the server's resolveFieldValue.
    const { added, removed } = diffMembers(
      Array.isArray(oldV) ? oldV : [],
      Array.isArray(newV) ? newV : []
    );
    const parts = [];
    if (added.length) parts.push(`assigned ${added.map((m) => m.name).join(', ')}`);
    if (removed.length) parts.push(`unassigned ${removed.map((m) => m.name).join(', ')}`);
    if (!parts.length) return null;
    return <span>{Actor} {parts.join(' and ')} in {Col}.</span>;
  }

  if (type === 'file') {
    const keyOf = (f) => (f && (f.url || f.name)) || '';
    const before = Array.isArray(oldV) ? oldV : [];
    const after = Array.isArray(newV) ? newV : [];
    const beforeKeys = new Set(before.map(keyOf));
    const afterKeys = new Set(after.map(keyOf));
    const fileName = (f) => `“${(f && f.name) || 'file'}”`;
    const added = after.filter((f) => !beforeKeys.has(keyOf(f))).map(fileName);
    const removed = before.filter((f) => !afterKeys.has(keyOf(f))).map(fileName);
    if (!added.length && !removed.length) return null;
    return (
      <span>
        {Actor}{' '}
        {added.length > 0 && <>attached <Quoted>{andList(added)}</Quoted> to {Col}</>}
        {added.length > 0 && removed.length > 0 && ' and '}
        {removed.length > 0 && <>removed <Quoted>{andList(removed)}</Quoted> from {Col}</>}
        .
      </span>
    );
  }

  if (type === 'payments') {
    // Compared by entry id, never by position: payments are kept sorted by
    // date, so recording an older one shifts every index after it.
    const amount = (p) => moneyText(Number(p?.amount), meta.currency || null);
    const before = new Map((Array.isArray(oldV) ? oldV : []).map((p) => [String(p?.id), p]));
    const after = new Map((Array.isArray(newV) ? newV : []).map((p) => [String(p?.id), p]));
    const added = [...after.keys()].filter((id) => !before.has(id)).map((id) => amount(after.get(id)));
    const removed = [...before.keys()].filter((id) => !after.has(id)).map((id) => amount(before.get(id)));
    const edited = [...after.keys()]
      .filter((id) => before.has(id) && Number(before.get(id).amount) !== Number(after.get(id).amount))
      .map((id) => `changed a payment from ${amount(before.get(id))} to ${amount(after.get(id))}`);
    const parts = [];
    if (added.length) parts.push(`recorded ${added.length === 1 ? 'a payment' : 'payments'} of ${andList(added)}`);
    if (removed.length) parts.push(`removed ${removed.length === 1 ? 'a payment' : 'payments'} of ${andList(removed)}`);
    parts.push(...edited);
    return <span>{Actor} {parts.length ? parts.join(' and ') : 'updated a payment'}.</span>;
  }

  if (type === 'tags') {
    const labelOf = (id) => meta.optionLabels?.[String(id)] || 'a removed tag';
    const before = new Set((Array.isArray(oldV) ? oldV : []).map(String));
    const after = new Set((Array.isArray(newV) ? newV : []).map(String));
    const added = [...after].filter((id) => !before.has(id)).map(labelOf);
    const removed = [...before].filter((id) => !after.has(id)).map(labelOf);
    const parts = [];
    if (added.length) parts.push(`added ${andList(added)}`);
    if (removed.length) parts.push(`removed ${andList(removed)}`);
    if (!parts.length) return null;
    return <span>{Actor} {parts.join(' and ')} in {Col}.</span>;
  }

  if (type === 'checkbox') {
    return <span>{Actor} {newV ? 'checked' : 'unchecked'} {Col}.</span>;
  }

  if (type === 'connect_boards') {
    const count = (v) => (Array.isArray(v) ? v.length : (Array.isArray(v?.links) ? v.links.length : 0));
    const before = count(oldV);
    const after = count(newV);
    if (before === after) return null;
    const n = Math.abs(after - before);
    return (
      <span>
        {Actor} {after > before ? 'linked' : 'unlinked'} {n} item{n === 1 ? '' : 's'} in {Col}.
      </span>
    );
  }

  const from = columnScalarText(type, oldV, meta);
  const to = columnScalarText(type, newV, meta);
  if (from === null && to === null) return null;
  if (from === null) return <span>{Actor} set {Col} to <Quoted>{to}</Quoted>.</span>;
  if (to === null) return <span>{Actor} cleared {Col} (was <Quoted>{from}</Quoted>).</span>;
  return (
    <span>
      {Actor} changed {Col} from <Quoted>{from}</Quoted>
      <Arrow />
      <Quoted>{to}</Quoted>.
    </span>
  );
};


/**
 * A goal's stored value, in words.
 *
 * The text mirror of `describeGoalValue` in server/src/services/activityFormat.js
 * — same rules, same wording, because the same change must not read one way in
 * this panel and another in the exported report.
 *
 * `typeKey` is the goal's KIND and comes from the row's own metadata rather
 * than from the goal as it stands today: the same stored `1` is "Yes" on a
 * did-we-do-it goal and the number one on every other kind, and a goal whose
 * kind was changed later must still describe its old rows correctly.
 */
const renderGoalValue = (field, value, typeKey, meta = {}, typeLabels = {}) => {
  if (field === 'actual') {
    if (value === null || value === undefined || value === '') {
      return <Quoted muted>not reported</Quoted>;
    }
    if (typeKey === 'boolean') {
      return <Quoted>{value === 1 || value === true ? 'Yes' : 'No'}</Quoted>;
    }
    if (typeKey === 'rating') {
      let word = 'Missed';
      if (value >= 100) word = 'On track';
      else if (value >= 50) word = 'Partly there';
      return <Quoted>{word}</Quoted>;
    }
    return <Quoted>{String(value)}</Quoted>;
  }

  if (value === null || value === undefined || value === '') {
    return <Quoted muted>none</Quoted>;
  }

  // A column with a vocabulary stores the CHOICE'S ID. The writer resolved the
  // word at the time of the change and put it here, which is also why a choice
  // that has since been deleted still reads as itself in this sentence rather
  // than as "technical_a1b2c3".
  if (meta.optionLabel) return <Quoted>{meta.optionLabel}</Quoted>;

  if (field === 'actualDayKey' || field === 'config:dueDayKey') {
    return <Quoted>{formatDate(value) || String(value)}</Quoted>;
  }
  if (field === 'config:direction') {
    return <Quoted>{DIRECTION_LABELS[value] || String(value)}</Quoted>;
  }
  if (field === 'goalType') return <Pill>{typeLabels[value] || String(value)}</Pill>;
  if (field === 'weight') return <Quoted>{weightLabel(value)}</Quoted>;
  if (field === 'owner') return <Quoted>{value.name || 'Unknown'}</Quoted>;
  if (field === 'name' || field === 'note') {
    const text = String(value);
    const truncated = text.length > 80 ? `${text.slice(0, 80)}…` : text;
    return <Quoted>“{truncated}”</Quoted>;
  }
  if (Array.isArray(value)) {
    // Resolved people carry names; a dropdown or a link column is already text.
    const parts = value.map((v) => (
      v && typeof v === 'object' ? (v.name ?? JSON.stringify(v)) : String(v)
    ));
    return <Quoted>{parts.join(', ')}</Quoted>;
  }
  if (typeof value === 'object') return <Quoted>{JSON.stringify(value)}</Quoted>;
  return <Quoted>{meta.unitLabel ? `${meta.unitLabel}${value}` : String(value)}</Quoted>;
};

/** The words for a goal's field key: 'config:target' → 'target'. */
const goalFieldLabel = (field, meta = {}) => {
  if (typeof field === 'string' && field.startsWith('config:')) {
    return meta.configLabel || field.slice('config:'.length);
  }
  if (typeof field === 'string' && field.startsWith('column:')) {
    return meta.columnLabel || field.slice('column:'.length);
  }
  return FIELD_LABELS[field] || field;
};

/**
 * One goal event as a sentence.
 *
 * The goal's NAME is deliberately absent from most of these: this panel is
 * opened from one row and shows only that row's history, so repeating the name
 * on every line is thirty copies of something already in the title. The two
 * exceptions are creation and deletion, where naming it is the event.
 */
const renderGoalBody = (entry, typeLabels) => {
  const actorName = entry.actor?.name || 'Someone';
  const Actor = <strong style={{ color: 'var(--color-text-primary)' }}>{actorName}</strong>;
  const meta = entry.metadata || {};
  const typeKey = meta.goalTypeKey || null;
  const goalName = meta.goalName || 'this goal';

  if (entry.type === 'goal.created') {
    const kind = typeKey && typeLabels[typeKey] ? ` (${typeLabels[typeKey]})` : '';
    return (
      <span>
        {Actor} added the goal <Quoted>“{goalName}”</Quoted>{kind}.
      </span>
    );
  }
  if (entry.type === 'goal.deleted') {
    return (
      <span>
        {Actor} deleted the goal <Quoted>“{goalName}”</Quoted>.
      </span>
    );
  }

  const { field } = entry;
  // `oldLabel` / `newLabel` are the readable form of a dropdown value, one per
  // side, so each is handed only to the side it describes.
  const from = renderGoalValue(
    field, entry.oldValue, typeKey, { ...meta, optionLabel: meta.oldLabel }, typeLabels
  );
  const to = renderGoalValue(
    field, entry.newValue, typeKey, { ...meta, optionLabel: meta.newLabel }, typeLabels
  );

  if (field === 'name') {
    return <span>{Actor} renamed this from {from}<Arrow />{to}.</span>;
  }
  if (field === 'owner') {
    return entry.newValue
      ? <span>{Actor} made {to} the owner.</span>
      : <span>{Actor} removed the owner.</span>;
  }
  // Filling in a blank result is the event people open this panel to find;
  // "from not reported to 5,640" buries it behind two words that mean nothing.
  if ((field === 'actual' || field === 'actualDayKey') && entry.oldValue === null) {
    return <span>{Actor} reported {to}.</span>;
  }
  return (
    <span>
      {Actor} changed {goalFieldLabel(field, meta)} from {from}<Arrow />{to}.
    </span>
  );
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
    if (entry.field === 'pinned') return Pin;
    if (entry.field === 'portalShared') return entry.newValue ? Eye : EyeOff;
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

  if (entry.type === 'goal.created') return Target;
  if (entry.type === 'goal.deleted') return Trash2;
  if (entry.type === 'goal.field_changed') {
    if (entry.field === 'owner') return UserPlus;
    if (entry.field === 'weight') return Gauge;
    if (entry.field === 'name') return Pencil;
    if (entry.field === 'note') return StickyNote;
    if (entry.field === 'actualDayKey' || entry.field === 'config:dueDayKey') return Calendar;
    if (entry.field === 'actual') return ActivityIcon;
    if (typeof entry.field === 'string' && entry.field.startsWith('config:')) return Crosshair;
    return Pencil;
  }
  return ActivityIcon;
};

/**
 * Build the inline JSX describing what changed. Keeps templates per type
 * grouped here so a future event type just needs a new branch.
 */
const renderBody = (entry, typeLabels = {}) => {
  const actorName = entry.actor?.name || 'Someone';
  const Actor = <strong style={{ color: 'var(--color-text-primary)' }}>{actorName}</strong>;

  if (typeof entry.type === 'string' && entry.type.startsWith('goal.')) {
    return renderGoalBody(entry, typeLabels);
  }

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
    // Flexible columns log `column:<key>`, which is a storage key and not a
    // name. The writer carries the column's label in metadata, so use that
    // rather than showing the user "column:owner_2".
    if (typeof entry.field === 'string' && entry.field.startsWith('column:')) {
      const colLabel = entry.metadata?.columnLabel || 'a column';
      // Rows that say what TYPE the column was show the real values. Rows
      // written before the type was stamped — and link rows, which carry a
      // label but no type — keep the count-or-"updated" wording below.
      if (entry.metadata?.columnType) {
        const typed = renderColumnChange(entry, Actor, colLabel);
        if (typed) return typed;
        return (
          <span>
            {Actor} updated <Quoted>{colLabel}</Quoted>.
          </span>
        );
      }
      const before = Array.isArray(entry.oldValue) ? entry.oldValue.length : null;
      const after = Array.isArray(entry.newValue) ? entry.newValue.length : null;
      if (before !== null && after !== null && before !== after) {
        const n = Math.abs(after - before);
        return (
          <span>
            {Actor} {after > before ? 'linked' : 'unlinked'} {n} item{n === 1 ? '' : 's'} in{' '}
            <Quoted>{colLabel}</Quoted>.
          </span>
        );
      }
      return (
        <span>
          {Actor} updated <Quoted>{colLabel}</Quoted>.
        </span>
      );
    }

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

    // Who can READ the task deserves a sentence, not a from → to. This is the
    // one entry someone scrolls the log to find ("when did the client get
    // this?"), and "changed client visibility from false → true" buries it.
    if (entry.field === 'portalShared') {
      return (
        <span>
          {Actor}{' '}
          {entry.newValue
            ? 'shared this with the client — it is now in their portal'
            : 'removed this from the client portal'}
          .
        </span>
      );
    }

    // A status the SERVER moved because the row's payments came to cover its
    // amount (server utils/paymentsSettle.js). Still the actor's sentence — it
    // was their payment that did it — but it says why, so nobody reading the
    // history wonders who ticked Paid. Same words as the exported report.
    const settledNote =
      entry.field === 'status' && entry.metadata?.settledBy === 'payments'
        ? ' (payments cover the amount)'
        : '';

    return (
      <span>
        {Actor} changed {label} from {renderScalarValue(entry.field, entry.oldValue)}
        <Arrow />
        {renderScalarValue(entry.field, entry.newValue)}
        {settledNote}.
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
    // The activity log is team-only, so either thread is safe to quote here — but
    // it must say WHICH one, or the timeline reads as if the client were told
    // something they weren't (or vice versa). `internal: true` is the team thread,
    // which is the unremarkable case and so gets the plain wording.
    // Only 'client' is remarkable; 'team', 'default' and legacy rows with no
    // `thread` at all are all just an update.
    const what =
      entry.metadata?.thread === 'client'
        ? 'posted on the client thread'
        : 'posted an update';
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
 *
 * `typeLabels` maps a goal type key to its plain-language label ('numeric' →
 * 'Move a number'). Only goal rows read it, and only the Goals tab has it — the
 * catalog is served by `/api/goal-types` rather than hardcoded here, so a new
 * kind of goal reaches this timeline without a second table to keep in sync.
 */
const ActivityEntry = ({ entry, typeLabels = {} }) => {
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
        {entry.actor?.isSystem ? (
          // Nobody was behind it — a scheduled connector run. Its own mark
          // rather than the initials of a name that is not a person's.
          <Bot size={15} aria-hidden="true" />
        ) : entry.actor?.profilePic ? (
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
          {renderBody(entry, typeLabels)}
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
