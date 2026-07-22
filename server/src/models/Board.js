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
 *
 * `canManage` upgrades an 'edit' grant to FULL access: that member may also
 * manage the board's sharing (grant/revoke other members), like the owner.
 * Only the owner can hand it out, and it is meaningless without level 'edit'.
 */
const boardAccessSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    /**
     * A rung on the board access ladder — see
     * [capabilities.js](../utils/capabilities.js) `BOARD_LEVELS`.
     *
     *   view       — read the board
     *   comment    — + post updates and mention people
     *   contribute — + create tasks, and edit/complete tasks assigned to them
     *   edit       — + any task, groups, columns, statuses, notes, automations
     *
     * `read` is the legacy spelling of `view` and is still accepted so existing
     * grants keep working untouched; `normaliseLevel` folds it in. The ladder
     * used to be `read | edit` and nothing else, which meant the only way to let
     * someone do their own work was to also let them delete your columns.
     */
    level: {
      type: String,
      enum: ['read', 'view', 'comment', 'contribute', 'edit'],
      required: true,
    },
    /**
     * Upgrades an `edit` grant to FULL access: that member may also manage the
     * board's sharing. Owner-granted only, and meaningless below `edit`.
     */
    canManage: {
      type: Boolean,
      default: false,
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
    /**
     * Client Portal boards ('client') add an external-collaboration plane on top
     * of a normal PRIVATE board: each group can expose a shareable link + passcode
     * so an external client (not an app user) can submit issues and hold a thread
     * with the team. A 'standard' board is an ordinary internal board.
     *
     * This is intentionally SEPARATE from `visibility` — a client board is still
     * `visibility: 'private'` internally, so the whole org access model (roles,
     * memberAccess, resolveAccess) is untouched. See utils/permissions.js.
     */
    boardType: {
      type: String,
      enum: ['standard', 'client'],
      default: 'standard',
    },
    /**
     * Optional categories a client may tag an issue with when submitting from the
     * portal (e.g. "Bug", "Concern", "Request"). Configured per client board by
     * the team; empty means the portal submit form omits the category field.
     * Client boards only.
     */
    portalCategories: {
      type: [String],
      default: [],
    },
    /**
     * What a PUBLIC board opens up to the org — the rung every member lands on
     * without an explicit grant. "Public" used to mean one hardcoded thing
     * (read everything, change status and nothing else), an arbitrary point on
     * the ladder that nobody chose. Now each board decides: an announcements
     * board is public/`view`, a team scratchpad is public/`edit`.
     *
     * Ignored entirely when `visibility` is 'private'. An explicit grant in
     * `memberAccess` always wins over this.
     */
    publicDefaultLevel: {
      type: String,
      enum: ['view', 'comment', 'contribute', 'edit'],
      default: 'contribute',
    },
    // Per-member access grants. Managed by the board's creator (and anyone the
    // creator gave full access). On a public board these UPGRADE a member above
    // `publicDefaultLevel`; on a private board they are the only way in.
    memberAccess: { type: [boardAccessSchema], default: [] },
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
