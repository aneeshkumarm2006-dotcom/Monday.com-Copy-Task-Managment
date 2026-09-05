const mongoose = require('mongoose');

/**
 * ClientContact — an external client person who accesses a Client Portal BOARD
 * via its shared link. This is deliberately NOT a `User`: clients never enter
 * the org-membership / permission graph. A contact is scoped to exactly one
 * board (one client company), and "their issues" are the Tasks whose
 * `portalSubmitter` points here.
 *
 * Identity is (board, email): the same person opening two different clients'
 * links is two separate contacts, and re-using a board's link with the same
 * email resolves back to the same contact (upsert on sign-in).
 *
 * It used to be (group, email), back when a GROUP was the client company. A
 * board's groups are now that one client's SERVICES (SEO, Meta Ads, Google Ads,
 * Web Development), and a contact sees ALL of them — which is exactly why
 * identity had to move up with the link. See `utils/clientBoard.js`.
 *
 * `services` below records which of those services this person was invited on.
 * It is routing and labelling ONLY — read its comment before using it for
 * anything, because the obvious use is the wrong one.
 *
 * A contact signs in one of two ways, recorded in `authMethod`:
 *   'google'   — the default. Clicks "Continue with Google" on the landing page.
 *                The contact is born on first sign-in (or pre-created by an invite).
 *   'password' — for clients whose email isn't a Google account. The team marks
 *                them as such when inviting; they get a one-time link to choose
 *                a password, then sign in with email + password thereafter.
 *
 * `authMethod` gates ONLY the password form — Google sign-in stays open to anyone
 * holding the group link, exactly as before. A verified Google identity is no
 * weaker than a password, so there is nothing to gain by blocking it.
 */
const clientContactSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    // Optional display name the client may provide; falls back to the email
    // local-part in the UI when absent.
    name: {
      type: String,
      default: '',
      trim: true,
    },
    /**
     * The SERVICES this person was invited on — ids of groups on this contact's
     * own board.
     *
     * ---- IT CONFERS NOTHING. THIS IS LOAD-BEARING. --------------------------
     *
     * Every contact on a client board has full access to every service on it:
     * `portalTaskFilter` is board-scoped, `chatAudience` returns every
     * ClientContact on the board for any client-facing surface, and
     * `Task.portalShared` is board-wide by design. NOTHING may ever be gated on
     * this array.
     *
     * In particular, do NOT filter client chat or mail notifications by it. That
     * looks like the obvious use and is the dangerous one: it would withhold
     * messages from contacts who can and do read the room — a filter with no
     * authorisation behind it, whose only effect is silently dropping messages
     * people are entitled to see.
     *
     * WHAT IT IS ACTUALLY FOR, honestly, in descending order of weight:
     *
     *   1. THE INVITE EMAIL. Four rows naming one address produce ONE email
     *      listing four services. This is the load-bearing use and the reason
     *      the field exists at all.
     *   2. THE TEAM'S ROSTER. "Asha — SEO, Meta Ads" in People with access.
     *      Without persistence the team loses the (service, email) pairing they
     *      typed the moment they hit send.
     *   3. A default landing service, when a contact has exactly one. Weak, but
     *      free once 1 and 2 are paid for.
     *
     * GROUP IDS rather than names or slugs, so renaming a service never orphans
     * the link — the same reason `TaskGroup.tags` stores ids into
     * `Board.groupTags`. `groupController.deleteGroup` $pulls a deleted id from
     * every contact on the board; an id that somehow survives is skipped by the
     * serializer rather than throwing, because losing one chip beats failing a
     * roster read.
     *
     * No index. Read only via `_id` or `{ board }`, both already served by the
     * unique index below; a multikey index would tax every contact write for a
     * query nobody makes.
     *
     * (This replaces a vestigial single `group` field, from back when a group
     * WAS the client company. A scalar could not express a person who manages
     * two services, which is the entire shape this rewrite exists to support.)
     */
    services: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'TaskGroup',
      },
    ],
    /**
     * The client board this person has access to — half of their identity, and
     * the only scope any portal read is allowed to use. Already present and
     * required on every row that predates the move, so nothing to backfill.
     *
     * Deliberately NOT `index: true`: the unique `{board:1, email:1}` below
     * already serves every board-only query through its leading prefix, and a
     * second index on the same prefix would be pure write cost.
     */
    board: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Board',
      required: true,
    },
    organisation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organisation',
    },
    // Flipped true the first time this contact actually signs in, by either
    // method. Purely informational — the team's "People with access" list uses
    // it to separate "invited" from "has been in".
    verified: {
      type: Boolean,
      default: false,
    },
    lastSeenAt: {
      type: Date,
      default: null,
    },

    /**
     * Whether to email this person when a message is waiting for them in the
     * portal. Default ON — a client who is never told will not come back.
     *
     * A per-contact opt-out, surfaced in the portal itself, is NOT a nicety.
     * These emails go out over the team's own Gmail, and a client who cannot
     * turn them off marks them as spam instead; a spam complaint against the
     * sending domain is a far more expensive outcome than a missed notification.
     */
    notifyEmail: {
      type: Boolean,
      default: true,
    },

    // ---- Sign-in method -----------------------------------------------------
    // How this person was invited. Existing contacts predate the field and all
    // signed in with Google, so the default is correct for them with no migration.
    authMethod: {
      type: String,
      enum: ['google', 'password'],
      default: 'google',
    },
    // When the team last sent this contact an invitation.
    invitedAt: {
      type: Date,
      default: null,
    },

    // ---- Password credentials (authMethod === 'password' only) --------------
    // `select: false` keeps both secrets out of every ordinary read. That is safe
    // alongside portalAuth's `contact.save()`: Mongoose only $sets modified paths,
    // so a field that was never selected is never unset.
    passwordHash: {
      type: String,
      default: null,
      select: false,
    },
    passwordSetAt: {
      type: Date,
      default: null,
    },

    // One-time link for choosing ('setup') or replacing ('reset') the password.
    // Only the sha256 of the token is stored — the raw value exists solely inside
    // the URL we email, so a database read can't be turned into a sign-in.
    setupTokenHash: {
      type: String,
      default: null,
      select: false,
      index: true,
      sparse: true,
    },
    setupTokenExpires: {
      type: Date,
      default: null,
    },
    setupTokenPurpose: {
      type: String,
      enum: ['setup', 'reset', null],
      default: null,
    },

    // Per-contact brake on password guessing. The route limiter only sees an IP,
    // which a distributed attempt sidesteps; this follows the account instead.
    failedLogins: {
      type: Number,
      default: 0,
    },
    lockedUntil: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

// One contact per (board, email). Every sign-in path upserts on this pair, so
// it is what reconciles a repeat visitor instead of minting a second row.
//
// MIGRATION NOTE: the old `{group:1, email:1}` unique index must be DROPPED in
// the same maintenance window this index is created — not later. New contacts
// are written with `group` absent, and a compound unique index that is not
// partial treats a missing field as null, so two new contacts sharing an email
// on DIFFERENT boards would both key as {group:null, email:x} and collide.
// See scripts/migratePortalToBoard.js.
clientContactSchema.index({ board: 1, email: 1 }, { unique: true });

module.exports = mongoose.model('ClientContact', clientContactSchema);
