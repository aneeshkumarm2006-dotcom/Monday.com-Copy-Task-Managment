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
 *
 * A THIRD consumer joined them: the per-goal history panel
 * (goalController.getGoalActivity). Goal rows are the same rows in the same
 * collection, so they resolve and describe through the same two functions —
 * which is the only reason "who changed the target" reads the same in the panel
 * and in the exported report.
 */

const { getGoalType, isGoalType } = require('../utils/goalTypes');

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
  // Tracker boards: goals a task was offered as evidence for.
  goalLinks: 'goals',
  // Goal-only fields. `name` and `note` above are shared.
  goalType: 'kind of goal',
  weight: 'importance',
  owner: 'owner',
  unit: 'unit',
  actual: 'result',
  actualDayKey: 'the day it was done',
  // Ads-budget-only fields. `name`, `note` and `owner` above are shared.
  allocated: 'budget',
  spent: 'spend',
  dailyBudget: 'daily budget',
  platform: 'platform',
  account: 'account',
  objective: 'objective',
  lifecycle: 'status',
};

/**
 * Importance, as the WORD the UI shows rather than the number stored.
 *
 * Mirrors `WEIGHT_PRESETS` in client/src/utils/goalDisplay.js. Duplicated
 * deliberately and knowingly: a weight is presentation on both sides of the
 * wire, and an export that says "changed importance from 1 to 3" describes a
 * control nobody has ever seen.
 */
const WEIGHT_LABELS = {
  0: 'Not counted',
  0.5: 'Nice to have',
  1: 'Normal',
  2: 'High',
  3: 'Critical',
};

const weightLabel = (w) => WEIGHT_LABELS[w] || (w === null || w === undefined ? 'none' : `x${w}`);

/** 'atMost' is a storage key; "stay below" is the choice the user made. */
const DIRECTION_LABELS = { atMost: 'stay below', atLeast: 'stay above' };

/** A goal's `actual`, which means different things per type. */
const describeGoalActual = (typeKey, value) => {
  if (value === null || value === undefined || value === '') return 'not reported';
  if (typeKey === 'boolean') return (value === 1 || value === true) ? 'Yes' : 'No';
  if (typeKey === 'rating') {
    if (value >= 100) return 'On track';
    if (value >= 50) return 'Partly there';
    return 'Missed';
  }
  return String(value);
};

/**
 * Resolve a single value (or array of values) for a given field into a shape
 * the frontend can render directly without extra round-trips.
 *
 * Resolution map:
 *   - status  → { id, name, color } from board.statuses
 *   - labels  → [{ id, name, color }] from board.labels
 *   - assignees → [{ id, name, profilePic }] from userMap
 *   - owner (a goal's) → { id, name, profilePic } from userMap
 *   - a person-typed extra column → [{ id, name, profilePic }]
 *   - others (name, note, priority, dueDate, group) → raw value
 *
 * `entry` is the raw log row and is optional. It is only consulted for the one
 * thing the field key cannot carry: an extra column's TYPE, which is what says
 * whether `["65f…"]` is a list of user ids or a list of dropdown choices.
 */
const resolveFieldValue = (field, value, board, userMap, entry = null) => {
  if (value === null || value === undefined) return null;

  // A goal's owner — one person, not the task's array of them.
  if (field === 'owner') {
    const idStr = value.toString();
    const u = userMap.get(idStr);
    return u
      ? { id: idStr, name: u.name, profilePic: u.profilePic }
      : { id: idStr, name: 'Unknown', profilePic: null };
  }

  if (
    typeof field === 'string'
    && field.startsWith('column:')
    && entry?.metadata?.columnType === 'person'
    && Array.isArray(value)
  ) {
    return value.map((id) => {
      const idStr = id.toString();
      const u = userMap.get(idStr);
      return u
        ? { id: idStr, name: u.name, profilePic: u.profilePic }
        : { id: idStr, name: 'Unknown', profilePic: null };
    });
  }

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

  // Tracker-board evidence: an array of goal ids, or the sentinel string for
  // the deliberate "not goal work" dismissal.
  //
  // Names come from `metadata.goalNames`, denormalised by the writer, NOT from
  // a live lookup — the row has to still read after the goal is deleted, which
  // is the same reason `logGoalDeleted` keeps its own copy of the name.
  if (field === 'goalLinks') {
    if (value === 'not_goal_work') return { dismissed: true };
    if (!Array.isArray(value)) return value;
    const goalNames = entry?.metadata?.goalNames || {};
    return value.map((id) => {
      const idStr = id.toString();
      return { id: idStr, name: goalNames[idStr] || 'Deleted goal' };
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
  const addAll = (v) => {
    if (Array.isArray(v)) v.forEach((id) => id && ids.add(id.toString()));
  };
  for (const e of entries) {
    if (e.actor) ids.add(e.actor.toString());
    if (e.field === 'assignees') {
      addAll(e.oldValue);
      addAll(e.newValue);
    }
    // A goal's owner is a single id on both sides, not an array.
    if (e.field === 'owner') {
      if (e.oldValue) ids.add(e.oldValue.toString());
      if (e.newValue) ids.add(e.newValue.toString());
    }
    // A person-typed extra column holds user ids; nothing else about a
    // `column:` field says so, which is why the writer stamps the type.
    if (e.metadata?.columnType === 'person') {
      addAll(e.oldValue);
      addAll(e.newValue);
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
 * A goal field's value, in words.
 *
 * `typeKey` is the goal's KIND, carried in metadata because the same stored `1`
 * is "Yes" on a did-we-do-it goal and the number one on every other kind.
 */
const describeGoalValue = (field, value, typeKey, meta = {}) => {
  if (field === 'actual') return describeGoalActual(typeKey, value);
  if (field === 'actualDayKey' || field === 'config:dueDayKey') {
    return value ? (formatDate(value) || String(value)) : 'no date';
  }
  if (field === 'config:direction') {
    return DIRECTION_LABELS[value] || (value ? String(value) : 'none');
  }
  if (field === 'goalType') {
    if (!value) return 'none';
    return isGoalType(value) ? getGoalType(value).label : String(value);
  }
  if (field === 'weight') return weightLabel(value);
  if (field === 'owner') return value ? (value.name || 'Unknown') : 'nobody';
  if (field === 'name' || field === 'note') {
    return value ? quote(truncate(value, 80)) : 'none';
  }
  if (value === null || value === undefined || value === '') return 'none';
  if (Array.isArray(value)) {
    // Resolved people carry names; everything else is already printable.
    const parts = value.map((v) => (v && typeof v === 'object' ? (v.name ?? JSON.stringify(v)) : String(v)));
    return parts.length ? parts.join(', ') : 'none';
  }
  if (typeof value === 'object') return JSON.stringify(value);
  if (meta.unitLabel) return `${meta.unitLabel}${value}`;
  return String(value);
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
 * One goal event as a sentence. Split out of `describeActivity` because it is
 * the longest branch by far and shares none of the task vocabulary.
 */
const describeGoalActivity = (entry) => {
  const actor = entry.actor?.name || 'Someone';
  const meta = entry.metadata || {};
  const goalName = meta.goalName ? quote(truncate(meta.goalName, 60)) : 'a goal';
  const typeKey = meta.goalTypeKey || null;

  if (entry.type === 'goal.created') {
    const kind = typeKey && isGoalType(typeKey) ? ` (${getGoalType(typeKey).label})` : '';
    return `${actor} added the goal ${goalName}${kind}.`;
  }
  if (entry.type === 'goal.deleted') return `${actor} deleted the goal ${goalName}.`;

  const field = entry.field;
  const label = goalFieldLabel(field, meta);
  const from = describeGoalValue(field, entry.oldValue, typeKey, meta);
  const to = describeGoalValue(field, entry.newValue, typeKey, meta);

  if (field === 'name') return `${actor} renamed ${from} to ${to}.`;
  if (field === 'owner') {
    return entry.newValue
      ? `${actor} made ${to} the owner of ${goalName}.`
      : `${actor} removed the owner of ${goalName}.`;
  }
  // Reporting a blank result is the event people scroll this log to find; "from
  // not reported to 5,640" buries it behind two words that mean nothing.
  if ((field === 'actual' || field === 'actualDayKey') && entry.oldValue === null) {
    return `${actor} reported ${to} for ${goalName}.`;
  }
  return `${actor} changed ${label} on ${goalName} from ${from} to ${to}.`;
};

/** Money as a sentence reads it. Not a currency — the board owns that. */
const describeAmount = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'nothing';
  return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
};

/** What a budget row is called, when it has to be named in a sentence. */
const budgetSubject = (meta) => {
  if (meta.isCampaign && meta.campaignName) {
    return quote(truncate(meta.campaignName, 60));
  }
  if (meta.platform) return quote(truncate(meta.platform, 60));
  return 'an ads budget';
};

/**
 * One ads-budget event as a sentence.
 *
 * Split out for the same reason `describeGoalActivity` is: it shares none of
 * the task vocabulary, and the money fields want wording of their own —
 * "raised the budget from 8,000 to 10,000" rather than the generic "changed
 * budget from X to Y", because a budget moving up and a budget moving down are
 * the two things anybody scrolling this log is looking for.
 */
const describeAdsBudgetActivity = (entry) => {
  const actor = entry.actor?.name || 'Someone';
  const meta = entry.metadata || {};
  const subject = budgetSubject(meta);
  const where = meta.isCampaign && meta.platform ? ` on ${meta.platform}` : '';

  if (entry.type === 'ads_budget.created') {
    const opening = entry.newValue?.allocated;
    const amount =
      typeof opening === 'number' && opening > 0 ? ` with a budget of ${describeAmount(opening)}` : '';
    return `${actor} added ${subject}${where}${amount}.`;
  }
  if (entry.type === 'ads_budget.deleted') {
    return `${actor} removed ${subject}${where}.`;
  }

  const field = entry.field;
  const label = FIELD_LABELS[field] || field;

  if (field === 'allocated' || field === 'spent') {
    const from = typeof entry.oldValue === 'number' ? entry.oldValue : 0;
    const to = typeof entry.newValue === 'number' ? entry.newValue : 0;
    const verb = to > from ? 'raised' : 'lowered';
    return `${actor} ${verb} the ${label} on ${subject}${where} from ${describeAmount(from)} to ${describeAmount(to)}.`;
  }
  if (field === 'name' && entry.oldValue) {
    return `${actor} renamed ${quote(truncate(String(entry.oldValue), 60))} to ${quote(truncate(String(entry.newValue), 60))}.`;
  }
  if (field === 'owner') {
    return entry.newValue
      ? `${actor} made ${describeScalar(field, entry.newValue)} the owner of ${subject}.`
      : `${actor} removed the owner of ${subject}.`;
  }

  const from = describeScalar(field, entry.oldValue);
  const to = describeScalar(field, entry.newValue);
  return `${actor} changed ${label} on ${subject}${where} from ${from} to ${to}.`;
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

  if (typeof entry.type === 'string' && entry.type.startsWith('goal.')) {
    return describeGoalActivity(entry);
  }
  if (typeof entry.type === 'string' && entry.type.startsWith('ads_budget.')) {
    return describeAdsBudgetActivity(entry);
  }

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

      // Tracker-board evidence. The dismissal and the attachments share a
      // field, so the sentinel is checked first — `{ dismissed: true }` is what
      // resolveFieldValue turns the 'not_goal_work' marker into.
      if (entry.field === 'goalLinks') {
        if (entry.newValue?.dismissed) {
          return `${actor} marked this as not goal work.`;
        }
        if (entry.oldValue?.dismissed) {
          return `${actor} cleared "not goal work".`;
        }
        const { added, removed } = diffMembers(entry.oldValue, entry.newValue);
        const parts = [];
        if (added.length) parts.push(`attached this to ${names(added)}`);
        if (removed.length) parts.push(`detached it from ${names(removed)}`);
        return `${actor} ${parts.length ? parts.join(' and ') : 'updated goals'}.`;
      }

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
  'goal.created': 'Goal added',
  'goal.deleted': 'Goal deleted',
  'goal.field_changed': 'Goal changed',
  'ads_budget.created': 'Ads budget added',
  'ads_budget.deleted': 'Ads budget removed',
  'ads_budget.field_changed': 'Ads budget changed',
};

const eventLabel = (type) => EVENT_LABELS[type] || type;

module.exports = {
  resolveFieldValue,
  collectUserIds,
  describeActivity,
  describeGoalActivity,
  describeAdsBudgetActivity,
  describeGoalValue,
  goalFieldLabel,
  eventLabel,
  formatDate,
  weightLabel,
  FIELD_LABELS,
  LEGACY_STATUS_LABELS,
  DIRECTION_LABELS,
};
