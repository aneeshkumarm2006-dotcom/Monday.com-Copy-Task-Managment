/**
 * activityFormat.js — turning raw ActivityLog rows into something readable.
 *
 * Two consumers now share this: the per-task activity feed
 * (controllers/activityController.js), which hydrates rows into JSON for the
 * timeline UI to render, and the board activity export
 * (controllers/boardExportController.js), which needs the same rows collapsed
 * into plain sentences for a CSV cell or a PDF table.
 *
 * They must agree. A row that reads "Ann changed status from Working on it to
 * Done" in the task panel and something else in the exported report is a bug
 * report waiting to happen, so the resolution step lives here once rather than
 * twice.
 *
 * `resolveFieldValue` and `collectUserIds` moved here verbatim from
 * activityController; `describeActivity` is the text mirror of the JSX in
 * client/src/components/board/ActivityEntry.jsx — keep the two in step when
 * either changes.
 */

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** Mirrors client/src/utils/dateUtils.js `formatDate` — "Apr 10, 2026". */
const formatDate = (input) => {
  if (!input) return '';
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return '';
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
};

/**
 * Statuses used to be four hardcoded strings before boards carried their own
 * `statuses` array. Rows written back then store the string, not an id, so the
 * export still has to name them.
 */
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
};

/**
 * Resolve a single value (or array of values) for a given field into a shape
 * the frontend can render directly without extra round-trips.
 *
 * Resolution map:
 *   - status  → { id, name, color } from board.statuses
 *   - labels  → [{ id, name, color }] from board.labels
 *   - assignees → [{ id, name, profilePic }] from userMap
 *   - others (name, note, priority, dueDate, group) → raw value
 */
const resolveFieldValue = (field, value, board, userMap) => {
  if (value === null || value === undefined) return null;

  if (field === 'status') {
    if (!board) return value;
    const idStr = value.toString();
    const byId = board.statuses?.find((s) => s._id.toString() === idStr);
    if (byId) return { id: idStr, name: byId.name, color: byId.color };

    // Rows written before boards carried their own `statuses` array store the
    // status KEY ('done'), not an ObjectId. Matching on `key` recovers the
    // board's current name and colour for them; the label map is the last
    // resort for a key the board no longer defines. Without this every
    // pre-migration status change read "Unknown → Unknown", which an export
    // billed as a historical record cannot afford.
    const byKey = board.statuses?.find((s) => s.key && s.key === idStr);
    if (byKey) {
      return { id: byKey._id.toString(), name: byKey.name, color: byKey.color };
    }
    return {
      id: idStr,
      name: LEGACY_STATUS_LABELS[idStr] || 'Unknown',
      color: null,
    };
  }

  if (field === 'labels') {
    if (!Array.isArray(value)) return [];
    if (!board) return value;
    return value.map((id) => {
      const idStr = id.toString();
      const found = board.labels?.find((l) => l._id.toString() === idStr);
      return found
        ? { id: idStr, name: found.name, color: found.color }
        : { id: idStr, name: 'Unknown', color: null };
    });
  }

  if (field === 'assignees') {
    if (!Array.isArray(value)) return [];
    return value.map((id) => {
      const idStr = id.toString();
      const u = userMap.get(idStr);
      return u
        ? { id: idStr, name: u.name, profilePic: u.profilePic }
        : { id: idStr, name: 'Unknown', profilePic: null };
    });
  }

  return value;
};

/**
 * Collect every user id referenced across a batch of activity entries so we
 * can fetch them all in one go (avoids N+1).
 */
const collectUserIds = (entries) => {
  const ids = new Set();
  for (const e of entries) {
    if (e.actor) ids.add(e.actor.toString());
    if (e.field === 'assignees') {
      if (Array.isArray(e.oldValue)) e.oldValue.forEach((id) => id && ids.add(id.toString()));
      if (Array.isArray(e.newValue)) e.newValue.forEach((id) => id && ids.add(id.toString()));
    }
  }
  return Array.from(ids);
};

// ---------------------------------------------------------------------------
// Plain-text description
// ---------------------------------------------------------------------------

const quote = (text) => `"${text}"`;

const truncate = (text, max = 120) => {
  const s = String(text);
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

/** Added/removed members between two arrays of resolved { id, name } objects. */
const diffMembers = (oldArr, newArr) => {
  const oldIds = new Set((oldArr || []).map((m) => m.id));
  const newIds = new Set((newArr || []).map((m) => m.id));
  return {
    added: (newArr || []).filter((m) => !oldIds.has(m.id)),
    removed: (oldArr || []).filter((m) => !newIds.has(m.id)),
  };
};

const names = (arr) => arr.map((m) => m.name).join(', ');

/** One scalar value → the words for it. Mirrors ActivityEntry's renderScalarValue. */
const describeScalar = (field, value) => {
  if (value === null || value === undefined || value === '') return 'none';

  if (field === 'status') {
    if (typeof value === 'string') return LEGACY_STATUS_LABELS[value] || value;
    return value.name || 'Unknown';
  }
  if (field === 'dueDate') return formatDate(value) || 'no date';
  if (field === 'name' || field === 'note') return quote(truncate(value, 80));
  // Group changes store a raw ObjectId. The export replaces this branch with
  // real group names before it gets here; the task feed shows the short id.
  if (field === 'group') return value.toString().slice(-6);
  if (field === 'pinned') return value ? 'pinned' : 'not pinned';
  return String(value);
};

/**
 * Describe one hydrated activity entry as a single sentence.
 *
 * Expects the entry AFTER `resolveFieldValue` has run over oldValue/newValue —
 * i.e. statuses/labels/assignees already carry names — plus `actor.name`.
 *
 * @param {Object} entry
 * @param {Object} [opts]
 * @param {string} [opts.oldGroupName] - resolved name for a `group` change
 * @param {string} [opts.newGroupName]
 */
const describeActivity = (entry, { oldGroupName, newGroupName } = {}) => {
  const actor = entry.actor?.name || 'Someone';
  const meta = entry.metadata || {};

  switch (entry.type) {
    case 'task.created':
      return `${actor} created the task.`;
    case 'task.deleted':
      return `${actor} deleted the task.`;

    case 'task.field_changed': {
      // Flexible columns: the field is `column:<key>`, unreadable on its own, so
      // the writer stores the column's display name alongside it.
      if (typeof entry.field === 'string' && entry.field.startsWith('column:')) {
        const label = meta.columnLabel || entry.field.slice('column:'.length);
        const before = Array.isArray(entry.oldValue) ? entry.oldValue.length : null;
        const after = Array.isArray(entry.newValue) ? entry.newValue.length : null;
        if (before !== null && after !== null && before !== after) {
          const verb = after > before ? 'linked' : 'unlinked';
          const n = Math.abs(after - before);
          return `${actor} ${verb} ${n} item${n === 1 ? '' : 's'} in ${label}.`;
        }
        return `${actor} updated ${label}.`;
      }

      const label = FIELD_LABELS[entry.field] || entry.field;

      if (entry.field === 'assignees') {
        const { added, removed } = diffMembers(entry.oldValue, entry.newValue);
        const parts = [];
        if (added.length) parts.push(`assigned ${names(added)}`);
        if (removed.length) parts.push(`unassigned ${names(removed)}`);
        return `${actor} ${parts.length ? parts.join(' and ') : 'updated assignees'}.`;
      }

      if (entry.field === 'labels') {
        const { added, removed } = diffMembers(entry.oldValue, entry.newValue);
        const parts = [];
        if (added.length) parts.push(`added ${names(added)}`);
        if (removed.length) parts.push(`removed ${names(removed)}`);
        return `${actor} ${parts.length ? parts.join(' and ') : 'updated labels'}.`;
      }

      if (entry.field === 'group') {
        const from = oldGroupName || describeScalar('group', entry.oldValue);
        const to = newGroupName || describeScalar('group', entry.newValue);
        return `${actor} moved the task from ${from} to ${to}.`;
      }

      return (
        `${actor} changed ${label} from ${describeScalar(entry.field, entry.oldValue)}` +
        ` to ${describeScalar(entry.field, entry.newValue)}.`
      );
    }

    case 'checklist.added':
      return `${actor} added checklist item ${quote(meta.itemText || 'item')}.`;
    case 'checklist.toggled':
      return `${actor} ${entry.newValue ? 'checked off' : 'unchecked'} ${quote(meta.itemText || 'item')}.`;
    case 'checklist.renamed':
      return `${actor} renamed checklist item from ${quote(entry.oldValue)} to ${quote(entry.newValue)}.`;
    case 'checklist.deleted':
      return `${actor} deleted checklist item ${quote(meta.itemText || 'item')}.`;
    case 'checklist.reordered':
      return `${actor} reordered the checklist.`;

    case 'attachment.uploaded':
      return `${actor} uploaded ${quote(meta.attachmentName || 'file')}.`;
    case 'attachment.deleted':
      return `${actor} deleted attachment ${quote(meta.attachmentName || 'file')}.`;

    case 'comment.added':
      return meta.commentSnippet
        ? `${actor} commented: ${quote(truncate(meta.commentSnippet))}`
        : `${actor} commented.`;

    case 'update.added': {
      // Which thread matters. 'internal' is the team thread and the
      // unremarkable case; only a post on the CLIENT thread is worth naming,
      // because a report that blurs the two reads as if the client were told
      // something they were not.
      const what = meta.thread === 'client' ? 'posted on the client thread' : 'posted an update';
      return meta.updateSnippet
        ? `${actor} ${what}: ${quote(truncate(meta.updateSnippet))}`
        : `${actor} ${what}.`;
    }

    case 'client.request_created':
      return `${actor} (client) raised this request.`;
    case 'client.update_added':
      return meta.updateSnippet
        ? `${actor} (client) sent a message: ${quote(truncate(meta.updateSnippet))}`
        : `${actor} (client) sent a message.`;

    default:
      return `${actor} performed an action.`;
  }
};

/** Human label for an event type — the "Event" column of the export. */
const EVENT_LABELS = {
  'task.created': 'Task created',
  'task.deleted': 'Task deleted',
  'task.field_changed': 'Field changed',
  'checklist.added': 'Checklist item added',
  'checklist.toggled': 'Checklist item toggled',
  'checklist.renamed': 'Checklist item renamed',
  'checklist.deleted': 'Checklist item deleted',
  'checklist.reordered': 'Checklist reordered',
  'attachment.uploaded': 'File uploaded',
  'attachment.deleted': 'File deleted',
  'comment.added': 'Comment added',
  'update.added': 'Update posted',
  'client.request_created': 'Client request raised',
  'client.update_added': 'Client message',
};

const eventLabel = (type) => EVENT_LABELS[type] || type;

module.exports = {
  resolveFieldValue,
  collectUserIds,
  describeActivity,
  eventLabel,
  formatDate,
  FIELD_LABELS,
  LEGACY_STATUS_LABELS,
};
