const mongoose = require('mongoose');

/**
 * VaultAudit — who touched a board's vault, and when.
 *
 * Separate from ActivityLog rather than folded into it, for two reasons. The
 * first is structural: every ActivityLog row `require`s a `task`, and a vault
 * has none. The second matters more — the vault's whole promise is that the
 * server cannot see its contents, and ActivityLog's `oldValue`/`newValue` exist
 * precisely to record what changed. Putting vault events in a collection shaped
 * to store before-and-after values invites someone to eventually store one.
 *
 * So this model has nowhere to put a secret. There is no value field, no
 * metadata blob, no item title — only WHICH item, WHAT happened, and BY WHOM.
 * A reader of this collection learns that Ann unlocked the vault at 09:14 and
 * deleted an item at 09:20. That is the entire point of an audit trail, and it
 * is also all of it.
 *
 * Failed unlocks are recorded too — a burst of them is the signal you actually
 * want this log for.
 */

const AUDIT_ACTIONS = [
  'vault.created',
  'vault.unlocked',
  'vault.unlock_failed',
  'vault.locked_out',
  'vault.password_changed',
  'vault.recovery_used',
  // The organisation break-glass path. `escrow_used` is the one every audit
  // review should look for: it means somebody opened this vault without the
  // board's own password or recovery key.
  'vault.escrow_added',
  'vault.escrow_removed',
  'vault.escrow_used',
  'item.created',
  'item.updated',
  'item.deleted',
  'item.file_uploaded',
];

const vaultAuditSchema = new mongoose.Schema({
  vault: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Vault',
    required: true,
    index: true,
  },
  board: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Board',
    required: true,
    index: true,
  },
  actor: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  action: {
    type: String,
    enum: AUDIT_ACTIONS,
    required: true,
  },
  // Which item the action was about, when it was about one. Never its title.
  item: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'VaultItem',
    default: null,
  },
  // The item's `type` ('credential', 'file', …) — already public on the item
  // row, repeated here so a deleted item's audit line still says what it was.
  itemType: { type: String, default: null },
  // Best-effort request origin. `trust proxy` is not set, so this is the socket
  // peer unless a forwarding header is present.
  ip: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now, index: true },
});

// The viewer reads one board's trail newest-first.
vaultAuditSchema.index({ board: 1, createdAt: -1 });

const Model = mongoose.model('VaultAudit', vaultAuditSchema);
Model.AUDIT_ACTIONS = AUDIT_ACTIONS;

module.exports = Model;
