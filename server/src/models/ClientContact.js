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
    // Flipped true the first time a magic-link is verified for this contact.
    verified: {
      type: Boolean,
      default: false,
    },
    lastSeenAt: {
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
