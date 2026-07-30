const mongoose = require('mongoose');

/**
 * ClientContact — an external client person who accesses a Client Portal group
 * via its shared link. This is deliberately NOT a `User`: clients never enter
 * the org-membership / permission graph. A contact is scoped to exactly one
 * group (one client company), and "their issues" are the Tasks whose
 * `portalSubmitter` points here.
 *
 * Identity is (group, email): the same person opening two different groups'
 * links is two separate contacts, and re-using a group's link with the same
 * email resolves back to the same contact (upsert on request-link).
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
    group: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaskGroup',
      required: true,
      index: true,
    },
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

// One contact per (group, email). The upsert in the request-link flow relies on
// this to reconcile repeat visitors instead of creating duplicates.
clientContactSchema.index({ group: 1, email: 1 }, { unique: true });

module.exports = mongoose.model('ClientContact', clientContactSchema);
