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
  // Ads budgets on a tracker board — the THIRD subject this collection serves,
  // after tasks and goals. Same reasoning as goals: a budget row is not a task,
  // so it carries `adsBudget` and `task` stays empty.
  //
  // These rows are not merely an audit trail. The Ads Budget tab's "Budget
  // Activity" ledger IS this history, read back and rendered as money in and
  // money out — which is what lets the tab hold editable Budget and Spend
  // fields without anybody also hand-entering a matching ledger line.
  'ads_budget.created',
  'ads_budget.deleted',
  'ads_budget.field_changed',
  // A group's own lifecycle — the FOURTH subject. These rows carry `group` and
  // no task, for the same reason goal rows do: a group is not a task, and a
  // per-task feed must never be able to return one.
  //
  // `TaskGroup.createdBy` already answers "who made this group" for groups made
  // after that field existed, so this is not merely a second copy of the byline.
  // It records the two things the byline structurally cannot: a RENAME (the
  // byline is set once and never written again, so a group silently becoming a
  // different client leaves no trace) and a DELETE (which takes the byline, the
  // group, and every task in it with it — see deleteGroup's cascade). The row
  // outlives its subject, which is the whole point of an audit trail.
  'group.created',
  'group.renamed',
  'group.deleted',
  // An executive view — the FIFTH subject, and the first that is not a thing
  // living on a board at all. These rows carry `organisation` and no task: the
  // subject is a per-(organisation, user) PROFILE describing what one person's
  // screen looks like, which is not a task, a goal, a budget row or a group.
  //
  // WHAT THESE ROWS DO NOT SAY. The profile describes a VIEW and never a grant.
  // Reach stays exactly where it has always been — the org role AND the board's
  // own `memberAccess`, resolved by `resolveAccess` — so none of these rows may
  // ever be read as "this person was given access to that board".
  // `executive.board_added` records that a board was put on somebody's curated
  // list; whether they can open it is a separate fact with a separate writer
  // (the share path), and the two are deliberately not merged into one event.
  //
  // WHERE THEY SHOW UP. `executive.board_added` and `executive.board_removed`
  // each concern exactly one board, so they ALSO carry `board` and therefore
  // appear in that board's activity export, which reads by board id. The other
  // three are org-level, carry no board, and so appear in NO board export. That
  // is intended rather than an omission: "somebody's home page was rearranged"
  // is not an event about any one board, and hanging it off a board picked at
  // random would be worse than leaving it out.
  //
  // WHO WRITES THEM. `services/executiveActivity.js`, and not
  // `activityService.logActivity` like the other four subjects. That helper's
  // guard admits a row only when one of task / goal / adsBudget / group is
  // present and it never passes an `organisation` through, so handing it an
  // executive row does not fail — it returns null and writes nothing, and since
  // it swallows its own errors nobody finds out. If you are adding an
  // executive event, call the writers in that file. If you are widening
  // `logActivity` to admit this subject, that file's `writeRow` is written to
  // collapse into a delegation to it.
  'executive.declared',
  'executive.updated',
  'executive.removed',
  'executive.board_added',
  'executive.board_removed',
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
  // Tracker boards: which of the month's goals this task counted towards, and
  // the "not goal work" dismissal. Logged on the TASK, never on the goal — the
  // goal's own history is "who set the target, who moved it, who typed in the
  // number", and evidence moves none of those.
  'goalLinks',
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
  // ---- Ads budget rows -----------------------------------------------------
  // `name` (the campaign's) and `owner` above are shared and mean the same
  // thing here, so they are not repeated. These are the fields only a budget
  // row has.
  //
  // `allocated` and `spent` are the two the ledger is built from: a change to
  // either becomes a line in Budget Activity, with the delta as its amount. If
  // either is ever missing from this list the tab loses entries silently, since
  // `logActivity` swallows its own validation errors — see the note above.
  'allocated',
  'spent',
  'dailyBudget',
  'platform',
  'account',
  'objective',
  // Not `status`: that key is already above and means a TASK's board status,
  // which is a different vocabulary with different values. A budget row's
  // draft/active/paused is its lifecycle.
  'lifecycle',
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
  // Required for every event EXCEPT a goal's, a budget row's, a group's or an
  // executive view's, none of which has a task to hang off. Exactly one of
  // `task` / `goal` / `adsBudget` / `group` / `organisation` is set on any row.
  // (`board` is not on that list: it is the SCOPE a row is exported under, and
  // a task row carries one too.)
  //
  // Every new subject widens this condition. Forgetting to is not a subtle
  // failure: the writers swallow their own errors, so the row would simply
  // never be written and the feature's history would come back empty.
  task: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Task',
    required: function requireTaskUnlessSubjectRow() {
      return !this.goal && !this.adsBudget && !this.group && !this.organisation;
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
  // Set only on `ads_budget.*` rows — a platform or campaign budget line on a
  // tracker board. Its own pointer for the same reason `goal` has one: a
  // per-task query must never be able to return one of these.
  adsBudget: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'AdsBudget',
    default: null,
    index: true,
  },
  // Set only on `group.*` rows. Its own pointer for the same reason the two
  // above have one.
  //
  // NOT indexed, unlike the other three. Those each back a per-subject history
  // panel keyed on the id; a group has no such panel, and every read of these
  // rows goes through the board activity export's `{ board, createdAt }` index
  // instead. An index here would tax writes to serve a query nobody makes — the
  // same call `TaskGroup.ownerTimeline` makes about `ownerTimeline.user`. Add
  // one the day a per-group history view exists, not before.
  //
  // A `group.deleted` row deliberately points at an id that no longer resolves.
  // That is not dangling data: the row's `metadata.groupName` is what it is read
  // by, and the pointer is only there to tie the group's events together.
  group: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TaskGroup',
    default: null,
  },
  // Set only on `executive.*` rows — the workspace whose executive view was
  // declared, changed or removed. Its own pointer for the same reason the four
  // above have one: a per-task query must never be able to return one of these.
  //
  // NOT indexed, on exactly the reasoning written over `group`. No per-org
  // history view exists: the two board-scoped executive rows are read through
  // the board activity export's `{ board, createdAt }` index like every other
  // row, and the three org-level ones are read by nobody today. An index here
  // would tax every write in this collection — task events included, since they
  // all share it — to serve a query nobody makes. Add one the day a workspace
  // history screen exists, not before.
  //
  // Like a `group.deleted` row, an `executive.removed` row deliberately outlives
  // its subject: the profile document is gone, and `metadata.targetUserName` is
  // what the row is read by. The pointer only ties a workspace's events together.
  organisation: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organisation',
    default: null,
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

// One budget row's own history. The Budget Activity LEDGER is a different read
// — it wants a whole client-month, including rows since deleted, so it filters
// `metadata.monthKey` / `metadata.group` under the `board` index below rather
// than joining through this one.
activityLogSchema.index({ adsBudget: 1, createdAt: -1 });

// The board activity export reads one board over one date range, ordered by
// time. The single-field `board` index alone would leave that sort in memory.
activityLogSchema.index({ board: 1, createdAt: -1 });

const Model = mongoose.model('ActivityLog', activityLogSchema);
Model.ACTIVITY_TYPES = ACTIVITY_TYPES;
Model.FIELD_KEYS = FIELD_KEYS;
Model.COLUMN_FIELD_RE = COLUMN_FIELD_RE;
Model.CONFIG_FIELD_RE = CONFIG_FIELD_RE;

module.exports = Model;
