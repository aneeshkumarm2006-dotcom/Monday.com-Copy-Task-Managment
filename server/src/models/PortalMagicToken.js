const mongoose = require('mongoose');

/**
 * PortalMagicToken — a short-lived, single-use email verification token for the
 * Client Portal login flow. The raw token is emailed to the client; only its
 * SHA-256 hash is stored, so a database leak never yields a usable link.
 *
 * Lifecycle: created on `request-link`, consumed on `verify` (sets `usedAt`),
 * and auto-reaped by the TTL index once `expiresAt` passes. A token is valid
 * only while `usedAt === null` AND `expiresAt` is in the future.
 */
const portalMagicTokenSchema = new mongoose.Schema(
  {
    // sha256(rawToken). Looked up directly on verify — indexed for that.
    tokenHash: {
      type: String,
      required: true,
      index: true,
    },
    contact: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ClientContact',
      required: true,
    },
    group: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaskGroup',
      required: true,
    },
    board: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Board',
      required: true,
    },
    // Set once when the token is redeemed; a non-null value means "already used".
    usedAt: {
      type: Date,
      default: null,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  { timestamps: true }
);

// TTL index: Mongo reaps the doc as soon as `expiresAt` passes. `expireAfterSeconds: 0`
// means "expire exactly at the stored time" (the field is an absolute timestamp).
portalMagicTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('PortalMagicToken', portalMagicTokenSchema);
