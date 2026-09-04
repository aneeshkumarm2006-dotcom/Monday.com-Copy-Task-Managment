const mongoose = require('mongoose');
const { PORTAL_TIERS } = require('../utils/clientBoard');

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
 * Per-board GROUP tag. The vocabulary a board's groups may be tagged with —
 * the same shape as `labelSchema`, and deliberately a separate collection from
 * it: labels file individual tasks, group tags file whole groups, and sharing
 * one list would force every task label into the group picker.
 *
 * Groups reference these by `_id` (`TaskGroup.tags`), so renaming or recolouring
 * a tag never breaks the link. Deleting one detaches it from every group.
 *
 * This is the catalog only — it exists on every board regardless of who has the
 * `groupTags` extra feature switched on. The feature flag gates who may WRITE
 * to it and who sees the chips, not whether the field is present.
 */
const groupTagSchema = new mongoose.Schema(
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
 * Per-board GOAL column — the extra detail columns a tracker board's Goals
 * table carries, on top of the built-in fields every goal has (name, type,
 * baseline, target, actual, weight, owner, score).
 *
 * Board-level and SHARED: every group's goals table on this board renders the
 * same columns, so an agency comparing two clients is comparing like with like.
 * Editing the list needs `goal.manage` on this board — the same permission that
 * sets a goal's target, because choosing what a goal promises and choosing what
 * is recorded beside it are one job.
 *
 * Deliberately NOT `columnSchema` above. That is the flexible-columns engine for
 * TASKS: 19 types including formula, mirror and connect_boards, a primary-column
 * invariant, and cell values keyed on `Task.columnValues`. A goals table needs
 * six plain types and a `required` flag, and borrowing the task engine would
 * have coupled goal rows to a system built entirely around tasks. Goal values
 * live in `Goal.columnValues`, keyed by these `_id`s.
 *
 * `required` is what "mandatory column" means: the goal controller refuses to
 * save a row while a required column is empty. Rows written BEFORE a column was
 * marked required are not retro-blocked — they surface through the unclosed-month
 * check instead, so flipping the switch never strands existing data.
 *
 * `requiredSince` is what makes that rule STORABLE rather than guessed. The
 * comparison is `goal.createdAt >= column.requiredSince`; without the timestamp
 * there is no way to tell a row that predates the rule from one that broke it,
 * and "flagged, not retro-blocked" collapses into "never enforced".
 *
 * Deleting a column that has values ARCHIVES it by default rather than dropping
 * the data. Labels and statuses hard-delete and `$pull`, and that is right for
 * them — losing a chip is a nuisance. Losing a number somebody already reported
 * to a client is not. Hard delete stays available behind an explicit purge.
 */
const goalColumnSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    type: {
      type: String,
      required: true,
      enum: ['text', 'number', 'date', 'dropdown', 'link', 'person'],
    },
    // Type-specific. `{ options: [{ id, label, color, order }] }` for dropdown;
    // `{ min, max }` for number. Empty for the rest.
    settings: { type: mongoose.Schema.Types.Mixed, default: {} },
    required: { type: Boolean, default: false },
    // Stamped when `required` flips false → true; cleared when it flips back.
    requiredSince: { type: Date, default: null },
    // Hidden from the grid and skipped by the required check, values retained.
    archived: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
    width: { type: Number, default: 160 },
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
     * of a normal PRIVATE board: each group exposes a shareable link (minted when
     * the group is created) that an external client opens, accepts, and signs into
     * with Google — no passcode — to submit issues and hold a thread with the
     * team. A 'standard' board is an ordinary internal board.
     *
     * This is intentionally SEPARATE from `visibility` — a client board is still
     * `visibility: 'private'` internally, so the whole org access model (roles,
     * memberAccess, resolveAccess) is untouched. See utils/permissions.js.
     *
     * Tracker boards ('tracker') partition everything by calendar month: each
     * task carries a `Task.monthKey` and the board shows one month at a time,
     * alongside a Delivery view and a Goals view scoped to the same month. Built
     * for retainer work (SEO/Ads and anything else cyclical) — deliberately
     * generic, so nothing in the engine knows what an "SEO board" is. The three
     * types are mutually exclusive: a tracker board has no client portal.
     */
    boardType: {
      type: String,
      enum: ['standard', 'client', 'tracker'],
      default: 'standard',
    },
    /**
     * The IANA zone whose calendar defines this board's month boundaries.
     * Tracker boards only, and REQUIRED on them (enforced by the hook below).
     *
     * Not defaulted to 'UTC', for the same reason `Tracker.timezone` is not: a
     * board silently on UTC while the team is on IST files every task created
     * before 05:30 into the previous month, and the error looks exactly like
     * data. The client sends its resolved browser zone at create/convert time
     * and the controller rejects anything Intl cannot parse.
     */
    monthTimezone: {
      type: String,
      default: null,
    },
    /**
     * ---- The client portal itself. Client boards only. --------------------
     *
     * A client board IS one client company, and these three fields are what the
     * outside world reaches it through. They used to live on `TaskGroup`, back
     * when a GROUP was the client; a board's groups are now that one client's
     * WORKSTREAMS (SEO, Ads, Web Development) and the link belongs to the board.
     *
     * Whether the shareable client link is currently live. Disabling instantly
     * closes the portal without discarding the token — and, because
     * `middleware/portalAuth.js` re-reads this on every request, it also ends
     * every signed-in client's session on their next call.
     */
    portalEnabled: {
      type: Boolean,
      default: false,
    },
    /**
     * The public link id (crypto.randomBytes hex), in the URL the client opens:
     * `${CLIENT_URL}/portal/${portalToken}`. Regenerating rotates it and kills
     * every live session, by the same mechanism as disabling.
     *
     * NO `default`, ON PURPOSE — the field must be ABSENT, not null. A sparse
     * index skips absent fields but DOES index null values, so `default: null`
     * would put every portal-less board's null into the unique index and the
     * second one would collide (E11000). This is the exact trap `TaskGroup`
     * documented before the field moved up here; it did not stop being true.
     *
     * `select: false` because this is a CREDENTIAL. `boardController`'s
     * `withPermissions` spreads `...board.toObject()` into the response of
     * every board read, so an ordinarily-selected token would ship a live
     * portal link to every member who can see the board. Failing closed here
     * means a new endpoint cannot leak it by accident — but it also means every
     * WRITE path that touches the token must load it explicitly with
     * `.select('+portalToken')`, or `if (!board.portalToken)` reads true on a
     * board that has one and silently rotates a live link.
     */
    portalToken: {
      type: String,
      select: false,
    },
    /**
     * Friendly client/company label shown on the client's own dashboard header.
     * Falls back to the board `name` when empty.
     */
    portalClientName: {
      type: String,
      default: '',
      trim: true,
    },
    /**
     * How much portal this client gets. See `utils/clientBoard.js`, which owns
     * the predicates — nothing should re-spell the tier test inline.
     *
     *   'basic'    — the task list and the per-task Client thread.
     *   'advanced' — plus chat: a team-only and a client-facing room per
     *                workstream, with the client's contacts in the latter.
     *
     * ONE-WAY. `advanced` is a deliberate statement that this board holds
     * exactly one company, which is what makes it safe for every contact on it
     * to read every workstream and share one set of rooms. The pre-save hook
     * below refuses the reverse, and there is no route that can express it.
     *
     * Every board that predates the field reads back as `basic`, which is
     * exactly what they already were — no migration.
     */
    portalTier: {
      type: String,
      enum: PORTAL_TIERS,
      default: 'basic',
    },
    /** When and by whom the one-way upgrade was made. Audit only. */
    portalTierUpgradedAt: {
      type: Date,
      default: null,
    },
    portalTierUpgradedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
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
     * Monotonic counter for human-friendly client ticket references (#REQ-1042).
     * Bumped atomically ($inc) as each client issue is created. Client boards only.
     */
    portalTicketSeq: {
      type: Number,
      default: 0,
    },
    /**
     * An optional announcement the team broadcasts to every client on this
     * board's portal (shown as a banner). Empty = no banner. Client boards only.
     */
    portalAnnouncement: {
      type: String,
      default: '',
    },
    /**
     * Optional FAQ / knowledge-base entries shown to clients in the portal's Help
     * section. Configured by the team. Client boards only.
     */
    portalFaqs: {
      type: [
        new mongoose.Schema(
          {
            q: { type: String, default: '' },
            a: { type: String, default: '' },
          },
          { _id: true, timestamps: false }
        ),
      ],
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
    // The tag vocabulary this board's GROUPS may be filed under. Empty on every
    // existing board — nothing seeds it, so a board only grows group tags once
    // somebody with the extra feature on adds one.
    groupTags: { type: [groupTagSchema], default: [] },
    // Flexible columns engine (F1). Empty until the board is migrated or
    // created from a template.
    columns: { type: [columnSchema], default: [] },
    // Gates the new code path. New boards created from templates flip this
    // to `true`; legacy boards stay on `false` until migrateLegacyColumns
    // runs against them. Two release cycles after migration completes, the
    // legacy path is removed and this flag becomes implicit.
    useFlexibleColumns: { type: Boolean, default: false },
    // The extra columns this board's Goals tables carry, shared by every group.
    // Empty on every board until an org admin adds one; tracker boards only.
    goalColumns: { type: [goalColumnSchema], default: [] },

    /**
     * The Ads Budget add-on — off until somebody switches it on in Add-ons.
     *
     * TWO FIELDS, and it is going to stay two. The budget rows themselves live
     * in their own collection (`models/AdsBudget.js`) precisely so this schema
     * does not grow again — it is already carrying labels, statuses, columns,
     * goalColumns, groupTags, portal categories and portal FAQs. What is here
     * is only what the BOARD READ must answer on first paint, without a second
     * request: whether the tab exists at all, and in what currency to render
     * every figure on it.
     *
     * `currency` is board-wide rather than per row because every number on both
     * of the tab's screens is a sum across rows, and rows in mixed currencies
     * cannot be added. One board, one currency is a real limitation; adding
     * numbers that do not share a unit is a bug.
     */
    adsBudget: {
      enabled: { type: Boolean, default: false },
      currency: { type: String, default: 'USD', trim: true, uppercase: true, maxlength: 3 },
    },

    /**
     * Which WORDING this board's Goals tab uses — see `GOAL_VOCABULARIES` in
     * utils/goalTypes.js. `null` is the default vocabulary, and it is what
     * every board that already exists resolves to, so adding a trade's wording
     * can never change a word on a board nobody opted in.
     *
     * NOT an enum, and no `required`. An unrecognised value falls back to the
     * default rather than failing validation, which is what lets a vocabulary
     * be retired without a migration over every board that named it.
     *
     * WORDING ONLY. It selects labels and examples; it cannot reach the scoring
     * table, so moving a board between vocabularies never re-scores a goal. It
     * lives on the BOARD rather than on each goal because a board is already
     * single-discipline in practice — an "Ads" workspace holding a "Meta Ads"
     * board has said so twice before a goal exists — and a per-goal copy would
     * be a third answer free to contradict both.
     */
    goalVocabulary: { type: String, default: null, trim: true, maxlength: 40 },
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

/**
 * Model-level invariant: a tracker board must know which calendar it is on.
 *
 * Defence-in-depth alongside the controller's validation, and the reason
 * `monthTimezone` has no default: every month boundary on this board — which
 * tasks belong to August, when the month-end goal reminder fires, where the
 * Delivery window ends — is computed from it. A board that reached the database
 * without one would bucket by whatever `dayKeyOf` did with `undefined`, and
 * that failure is silent. Better to refuse the save.
 */
boardSchema.pre('save', function enforceMonthTimezone() {
  if (this.boardType !== 'tracker') return;
  if (!this.monthTimezone) {
    throw new Error('Board.monthTimezone is required when boardType is "tracker"');
  }
});

/**
 * Unique only among boards that actually carry a portal token; absent tokens
 * are exempt. See the `portalToken` field comment for why it must be ABSENT
 * rather than null — a `default: null` collides here on the second board.
 */
boardSchema.index({ portalToken: 1 }, { unique: true, sparse: true });

/**
 * Model-level invariant: `portalTier` is one-way.
 *
 * The route layer already makes a downgrade inexpressible — upgrading is an
 * ACTION (`POST .../tier/upgrade`), not a settable property, and the write is a
 * conditional `updateOne` matching `portalTier: 'basic'`. This hook is the
 * third layer, and it catches the case the other two cannot: some future code
 * path doing `board.portalTier = 'basic'; await board.save()` by accident.
 *
 * `isModified` only fires when the value actually CHANGES, so re-saving a board
 * that is already basic is not caught — which is correct. Only a real
 * advanced → basic transition throws.
 *
 * Why refuse at all: advancing a board is the statement that it holds exactly
 * one client company, and every contact on it can then read every workstream
 * and post in its rooms. Reverting the flag would not un-send those messages,
 * so a "downgrade" would leave the board in a state the UI describes wrongly.
 */
boardSchema.pre('save', function enforceOneWayPortalTier() {
  if (this.isNew) return;
  if (this.isModified('portalTier') && this.portalTier === 'basic') {
    throw new Error(
      'Board.portalTier is one-way: an advanced client board cannot be downgraded to basic'
    );
  }
});

/**
 * The same refusal on the query path, which does not run `pre('save')`.
 *
 * The migration script deliberately writes through the raw driver collection
 * (`mongoose.connection.collection('boards')`), which bypasses hooks entirely —
 * the same escape hatch `scripts/renameMonthlyBoardType.js` already uses, and
 * for the same reason: a migration is the one caller allowed to set a field to
 * whatever the data actually requires.
 */
boardSchema.pre(['updateOne', 'updateMany', 'findOneAndUpdate'], function refuseTierDowngrade() {
  const update = this.getUpdate() || {};
  const set = update.$set || {};
  if (set.portalTier === 'basic' || update.portalTier === 'basic') {
    // A filter that already pins basic is a no-op upgrade guard, not a downgrade.
    const filter = this.getFilter() || {};
    if (filter.portalTier === 'basic') return;
    throw new Error(
      'Board.portalTier is one-way: an advanced client board cannot be downgraded to basic'
    );
  }
});

module.exports = mongoose.model('Board', boardSchema);
