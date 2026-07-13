const mongoose = require('mongoose');

/**
 * Per-board label. Tasks reference labels by `_id` so renames/recolors
 * don't break the link. `order` is an integer used for client-side sorting
 * (smaller = earlier).
 */
const labelSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    color: { type: String, default: '#6B7280' },
    order: { type: Number, default: 0 },
  },
  { _id: true, timestamps: false }
);

/**
 * Per-board status. `key` is an optional stable handle preserved from the
 * legacy 4-status enum (`not_started`, `working_on_it`, `done`, `stuck`).
 * Analytics and automation code keys off `key` to resolve the "done"
 * status across boards even after the user renames it. New statuses
 * created by the user have `key: null`.
 *
 * `isDefault` flags the status that newly-created tasks fall back to when
 * no explicit status is supplied. Exactly one status per board should
 * carry `isDefault: true`; deletion of that status is blocked.
 */
const statusSchema = new mongoose.Schema(
  {
    key: { type: String, default: null },
    name: { type: String, required: true, trim: true },
    color: { type: String, default: '#6B7280' },
    order: { type: Number, default: 0 },
    isDefault: { type: Boolean, default: false },
  },
  { _id: true, timestamps: false }
);

/**
 * Generic per-board column (Phase 1, F1).
 *
 * `key` is the stable slug used by automations and the API (e.g. `stage`,
 * `due_date`). Slugs are unique within a board; the controller is
 * responsible for keeping renames from clobbering an existing key.
 *
 * `type` must be one of the entries in [columnTypes.js](../utils/columnTypes.js).
 * `settings` is type-specific (e.g. `{ options: [...] }` for `status` /
 * `dropdown`, `{ min, max }` for `number`).
 *
 * Exactly one column per board carries `isPrimary: true`. The primary
 * column cannot be deleted — it's the row title.
 */
const columnSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    type: { type: String, required: true },
    settings: { type: mongoose.Schema.Types.Mixed, default: {} },
    order: { type: Number, default: 0 },
    width: { type: Number, default: 160 },
    isPrimary: { type: Boolean, default: false },
  },
  { _id: true, timestamps: false }
);

/**
 * Per-board access grant (private boards only). The board's creator may grant
 * individual org members `read` (view-only) or `edit` (admin-equivalent over
 * board content) access. Absence of an entry means "no access" — the member
 * cannot see the private board at all. See [boardAccess.js](../utils/boardAccess.js).
 */
const boardAccessSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    level: {
      type: String,
      enum: ['read', 'edit'],
      required: true,
    },
  },
  { _id: false, timestamps: false }
);

const boardSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    description: {
      type: String,
      default: '',
    },
    organisation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organisation',
    },
    visibility: {
      type: String,
      enum: ['public', 'private'],
      default: 'private',
    },
    // Per-member access grants for private boards. Managed by the board's
    // creator; ignored for public boards (every member can already read those).
    memberAccess: { type: [boardAccessSchema], default: [] },
    // When true, members granted 'edit' may also manage the board's access list
    // (they still can't touch the owner's grant, their own, or this flag).
    // Owner-controlled: only the creator can flip it. Off for legacy boards.
    editorsCanManageAccess: { type: Boolean, default: false },
    order: { type: Number, default: 0, index: true },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    labels: { type: [labelSchema], default: [] },
    statuses: { type: [statusSchema], default: [] },
    // Flexible columns engine (F1). Empty until the board is migrated or
    // created from a template.
    columns: { type: [columnSchema], default: [] },
    // Gates the new code path. New boards created from templates flip this
    // to `true`; legacy boards stay on `false` until migrateLegacyColumns
    // runs against them. Two release cycles after migration completes, the
    // legacy path is removed and this flag becomes implicit.
    useFlexibleColumns: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Sparse index on the column slug so automations can resolve a column by
// its stable handle without scanning the whole boards collection.
boardSchema.index({ 'columns.key': 1 }, { sparse: true });

/**
 * Model-level invariant: when `columns` is non-empty, exactly one entry
 * must be marked `isPrimary`. The controller normally enforces this on
 * write; the hook is a defence-in-depth so a bad bulk update can't slip a
 * malformed board past validation.
 */
boardSchema.pre('save', function enforcePrimaryColumn() {
  if (!Array.isArray(this.columns) || this.columns.length === 0) {
    return;
  }
  const primaries = this.columns.filter((c) => c.isPrimary === true);
  if (primaries.length !== 1) {
    throw new Error(
      `Board.columns must have exactly one isPrimary column (found ${primaries.length})`
    );
  }
});

module.exports = mongoose.model('Board', boardSchema);
