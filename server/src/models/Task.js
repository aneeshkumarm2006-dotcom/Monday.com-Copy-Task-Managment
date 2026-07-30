const mongoose = require('mongoose');

const taskSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    group: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaskGroup',
    },
    board: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Board',
    },
    priority: {
      type: String,
      enum: ['critical', 'high', 'medium', 'low'],
      default: 'medium',
    },
    order: { type: Number, default: 0, index: true },
    // Board tasks: ObjectId referencing Board.statuses._id.
    // Personal tasks: legacy enum string ('not_started', 'working_on_it',
    // 'done', 'stuck') — kept as strings because personal tasks don't have
    // a board to read statuses from. Mixed type accepts both shapes;
    // taskController validates per-context.
    status: {
      type: mongoose.Schema.Types.Mixed,
      default: 'not_started',
    },
    // Board tasks: ObjectIds referencing Board.labels._id.
    // Personal tasks: empty array (labels are board-scoped).
    labels: {
      type: [mongoose.Schema.Types.ObjectId],
      default: [],
    },
    checklist: {
      type: [
        new mongoose.Schema(
          {
            text: { type: String, default: '' },
            done: { type: Boolean, default: false },
          },
          { timestamps: { createdAt: true, updatedAt: false } }
        ),
      ],
      default: [],
    },
    assignedTo: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    }],
    dueDate: {
      type: Date,
    },
    note: {
      type: String,
    },
    // Flexible-columns engine (F1). Map of columnId → value. The exact
    // shape of `value` depends on the column's type — see columnTypes.js.
    // Empty for personal tasks and for board tasks until their board has
    // been migrated (board.useFlexibleColumns).
    columnValues: {
      type: Map,
      of: mongoose.Schema.Types.Mixed,
      default: {},
    },
    isPersonal: {
      type: Boolean,
      default: false,
    },
    // Subitems: when set, this task is a child of another Task on the same
    // board. Top-level tasks (the rows shown in TaskTable) have parent: null.
    // Indexed so the subitems lookup `find({ parent: id })` is cheap.
    parent: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Task',
      default: null,
      index: true,
    },
    // Loop guard for ITEM_CREATED automations: when an automation creates a
    // task via CREATE_TASK or CREATE_SUBITEM, the task is tagged so the
    // dispatcher can skip it and avoid recursive trigger loops.
    createdByAutomation: {
      type: Boolean,
      default: false,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    // Where this task originated. 'client' tasks were submitted by an external
    // ClientContact through a Client Portal group; they have `createdBy: null`
    // and a `portalSubmitter`. Everything else is 'internal'. Drives the "Client"
    // badge on the board and the client-facing email/notification hooks.
    source: {
      type: String,
      enum: ['internal', 'client'],
      default: 'internal',
    },
    // The external ClientContact who raised this issue (client tasks only). This
    // is the scoping key for "a client sees only their own issues".
    portalSubmitter: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ClientContact',
      default: null,
    },
    // Optional client-chosen category from the board's `portalCategories`
    // (client tasks only). Free string mirror kept simple; the team triages on it.
    portalCategory: {
      type: String,
      default: '',
    },
    // What kind of request the client raised (client tasks only): a bug, a
    // feature idea, a requirement/brief, or a question. Drives the portal's
    // type badge. Empty for internal tasks.
    portalType: {
      type: String,
      enum: [
        '',
        'bug',
        'feature',
        'requirement',
        'question',
        'meta_ads',
        'google_ads',
        'email_marketing',
        'website_development',
      ],
      default: '',
    },
    // Client satisfaction rating (1–5) captured when their issue is resolved.
    // null until they rate. Client tasks only.
    portalRating: {
      type: Number,
      min: 1,
      max: 5,
      default: null,
    },
    // Human-friendly sequential ticket number within the board (→ "#REQ-1042"),
    // assigned from Board.portalTicketSeq at creation. Client tasks only.
    portalRef: {
      type: Number,
      default: null,
    },
    // Files attached directly to the task (uploaded via the Files tab).
    // Mirrors the Update.attachments shape so the FE can share UI.
    //
    // Every file a Client Portal client uploads also lands here, whichever way
    // they sent it — so this array is the task's single file drawer, and `source`
    // is the only thing that says where a given file came in from. That matters
    // because the client's ORIGINAL REQUEST is rendered from this array (its
    // screenshots are not an Update), and it must not swallow files that arrived
    // later in the thread or from the team's own Files tab.
    attachments: {
      type: [
        new mongoose.Schema(
          {
            url: { type: String, required: true },
            name: { type: String, default: '' },
            mime: { type: String, default: '' },
            size: { type: Number, default: 0 },
            publicId: { type: String, default: '' },
            uploadedBy: {
              type: mongoose.Schema.Types.ObjectId,
              ref: 'User',
            },
            // Where the file entered the task:
            //   'request' — the client attached it while raising the request
            //   'thread'  — the client attached it to a portal thread message
            //               (also mirrored onto that Update's own attachments)
            //   'team'    — a team member uploaded it via the Files tab
            //
            // DELIBERATELY has no `default`. Mongoose applies schema defaults when
            // it hydrates a document, not just when one is created, so a default
            // here would hand every pre-existing row a confident answer — and the
            // rows that predate this field are precisely the client screenshots
            // this exists to find. Left undefined, they fall through to the
            // evidence-based fallback in utils/portalAttachments.js. Both writers
            // (the portal upload and the Files tab upload) set it explicitly.
            source: {
              type: String,
              enum: ['request', 'thread', 'team'],
            },
          },
          { _id: true, timestamps: { createdAt: true, updatedAt: false } }
        ),
      ],
      default: [],
    },
  },
  { timestamps: true }
);

/**
 * Maps the well-known column slugs we sync back onto legacy task fields.
 * Lookups are by `key`, not by `_id`, so the projection survives column
 * renames as long as the slug is preserved.
 *
 * The hook only runs when the parent board has `useFlexibleColumns: true`
 * AND the task has a board reference (personal tasks are skipped wholesale
 * per Phase 1 acceptance #6).
 */
const LEGACY_COLUMN_KEY_TO_TASK_FIELD = {
  status: 'status',
  priority: 'priority',
  assignees: 'assignedTo',
  due_date: 'dueDate',
  tags: 'labels',
};

/**
 * Pre-save: when the board uses flexible columns, project values from
 * `columnValues` back into the legacy task fields so analyticsController.js
 * and the existing automation dispatcher keep working until they're
 * rewritten to read `columnValues` directly (Phase 4 / F15).
 *
 * The lookup is intentionally lazy — `require` happens inside the hook so
 * Task.js stays cycle-free w.r.t. Board.js at module load.
 */
taskSchema.pre('save', async function syncLegacyFieldsFromColumnValues() {
  if (this.isPersonal || !this.board) return;
  if (!this.columnValues || this.columnValues.size === 0) return;

  const Board = mongoose.model('Board');
  const board = await Board.findById(this.board).select('useFlexibleColumns columns').lean();
  if (!board || !board.useFlexibleColumns) return;
  if (!Array.isArray(board.columns) || board.columns.length === 0) return;

  for (const col of board.columns) {
    const field = LEGACY_COLUMN_KEY_TO_TASK_FIELD[col.key];
    if (!field) continue;
    const colId = col._id ? col._id.toString() : null;
    if (!colId) continue;
    const value = this.columnValues.get(colId);
    if (value === undefined) continue;

    if (field === 'dueDate') {
      this.dueDate = value ? new Date(value) : undefined;
    } else if (field === 'assignedTo' || field === 'labels') {
      this.set(field, Array.isArray(value) ? value : []);
    } else {
      this.set(field, value);
    }
  }
});

module.exports = mongoose.model('Task', taskSchema);
