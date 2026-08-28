const mongoose = require('mongoose');

// Activity event types. Field-level changes use `task.field_changed` with the
// `field` property set; everything else carries its own type.
const ACTIVITY_TYPES = [
  'task.created',
  'task.deleted',
  'task.field_changed',
  'checklist.added',
  'checklist.toggled',
  'checklist.renamed',
  'checklist.deleted',
  'checklist.reordered',
  'attachment.uploaded',
  'attachment.deleted',
  'comment.added',
  'update.added',
  // Client Portal actions (actor is a ClientContact, not a User → actorType 'client').
  'client.request_created',
  'client.update_added',
  // Monthly goals on a tracker board. These rows carry `goal` instead of
  // `task` — a goal is not a task and never has one — which is why `task`
  // below is only conditionally required.
  'goal.created',
  'goal.deleted',
  'goal.field_changed',
];

// NOTE: this list is a VALIDATOR, and `activityService.logActivity` swallows its
// own errors — so a `field` missing from here does not fail loudly, it silently
// writes no row at all. `portalShared` is already being dropped this way on every
// client share (taskController's attachment/share path). Add the key here before
// you log it, or the activity you thought you recorded does not exist.
const FIELD_KEYS = [
  'name',
  'status',
  'priority',
  'assignees',
  'dueDate',
  'labels',
  'note',
  'group',
  'pinned',
  // Tracker boards: which calendar month the task is filed under.
  'monthKey',
  // ---- Goal rows -----------------------------------------------------------
  // `name` and `note` above are shared with tasks and mean the same thing on a
  // goal, so they are not repeated. These are the fields only a goal has.
  //
  // `goalType` rather than `type`, because `type` is already the column holding
  // the EVENT type — a field literally called `type` sitting next to it would
  // read as the same thing and be wrong about half the time.
  'goalType',
  'weight',
  'owner',
  'unit',
  'actual',
  'actualDayKey',
];

/**
 * Flexible-column field keys: `column:<column.key>`. Column keys are slugs of
 * the user-typed column name — `[a-z0-9_]` today, see `slugify` in
 * controllers/columnController.js. The class here is a little wider so a future
 * slug format does not silently start failing validation; what it must reject
 * is whitespace and the empty key.
 */
const COLUMN_FIELD_RE = /^column:[\w.-]+$/;

/**
 * A goal's `config` — the promise it was set with — is a per-TYPE blob
 * (`{ baseline, target }`, `{ dueDayKey, penaltyPerDay }`, …), so its keys can
 * no more be enumerated here than a user's column slugs can. Same treatment,
 * same reason: `config:<key>`, matched rather than listed.
 */
const CONFIG_FIELD_RE = /^config:[\w.-]+$/;

const activityLogSchema = new mongoose.Schema({
  // Required for every event EXCEPT a goal's, which has no task to hang off.
  // Exactly one of `task` / `goal` is set on any row.
  task: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Task',
    required: function requireTaskUnlessGoal() {
      return !this.goal;
    },
    default: null,
    index: true,
  },
  // Set only on `goal.*` rows. Monthly goals live in their own collection and
  // are not tasks, so they get their own pointer rather than being crammed into
  // `task` — which would make every per-task query capable of returning one.
  goal: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Goal',
    default: null,
    index: true,
  },
  // Null for personal tasks (no board).
  board: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Board',
    default: null,
    index: true,
  },
  // Who acted. For team actions this is the User (actorType 'user'). For Client
  // Portal actions there is no User — actorType is 'client' and `actorLabel`
  // carries the client's display name instead. `system` is the third case: an
  // unattended run with nobody behind it (the connector writeback filling in a
  // goal's numbers on a schedule), where `actorLabel` names the connector.
  actor: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: function requireActorForUserEvents() {
      return this.actorType === 'user';
    },
    default: null,
  },
  actorType: {
    type: String,
    enum: ['user', 'client', 'system'],
    default: 'user',
  },
  actorLabel: {
    type: String,
    default: '',
  },
  type: {
    type: String,
    enum: ACTIVITY_TYPES,
    required: true,
    index: true,
  },
  // Only set when type === 'task.field_changed'.
  //
  // Two shapes live here: one of the fixed FIELD_KEYS above, or `column:<key>`
  // for a flexible column, whose keys are created by users at runtime and so can
  // never be enumerated. This used to be a plain `enum: FIELD_KEYS`, which
  // rejected every `column:*` write — and because `logActivity` swallows its own
  // errors, connect-column link/unlink events were silently never recorded at
  // all. A validator rather than an enum is what makes both shapes storable.
  field: {
    type: String,
    default: null,
    validate: {
      validator: function validateField(v) {
        if (v === null || v === undefined) return true;
        return FIELD_KEYS.includes(v)
          || COLUMN_FIELD_RE.test(v)
          || CONFIG_FIELD_RE.test(v);
      },
      message: (props) => `${props.value} is not a valid activity field`,
    },
  },
  // Raw ObjectId, string, date, or array. Resolved to display values in the GET response.
  oldValue: { type: mongoose.Schema.Types.Mixed, default: null },
  newValue: { type: mongoose.Schema.Types.Mixed, default: null },
  // Free-form context: { itemText, attachmentName, commentSnippet, updateSnippet, taskName }.
  metadata: { type: mongoose.Schema.Types.Mixed, default: null },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true,
  },
});

// Compound index: paginated reads filter by task and sort by createdAt desc.
activityLogSchema.index({ task: 1, createdAt: -1 });

// The goal history panel is the same read against the other pointer.
activityLogSchema.index({ goal: 1, createdAt: -1 });

// The board activity export reads one board over one date range, ordered by
// time. The single-field `board` index alone would leave that sort in memory.
activityLogSchema.index({ board: 1, createdAt: -1 });

const Model = mongoose.model('ActivityLog', activityLogSchema);
Model.ACTIVITY_TYPES = ACTIVITY_TYPES;
Model.FIELD_KEYS = FIELD_KEYS;
Model.COLUMN_FIELD_RE = COLUMN_FIELD_RE;
Model.CONFIG_FIELD_RE = CONFIG_FIELD_RE;

module.exports = Model;
