const mongoose = require('mongoose');

/**
 * VaultEscrow — the organisation's break-glass key. One per org, and there is
 * none until somebody deliberately creates it.
 *
 * WHAT IT IS FOR. The vault has exactly two doors: its password, and its
 * one-time recovery key. Both live with the people who use that board. When the
 * one person who knew them leaves, or is hit by a bus, the board's production
 * credentials are gone — permanently and by design. Escrow is the org's answer
 * to that: a third door, held at the workspace level rather than the board.
 *
 * WHY IT IS ASYMMETRIC, which is the whole design.
 *
 *   escrow passphrase (a human, once, at the org level)
 *      │ PBKDF2 → HKDF, the same split as everything else
 *      ▼
 *   encryption key ──unwraps──► the escrow PRIVATE key (RSA-OAEP, stored here
 *                               sealed and useless without the passphrase)
 *   auth proof     ──scrypt──► proofHash, so guessing is throttled server-side
 *
 *   escrow PUBLIC key — stored in the clear, and that is correct
 *      │ RSA-OAEP
 *      ▼
 *   each vault's own Vault Key, sealed into Vault.escrow.wrap
 *
 * A symmetric org key could not work here, and the reason is worth stating
 * plainly: escrowing a vault happens when the vault is CREATED, by whoever
 * created it. With a shared secret, that person would have to know the escrow
 * passphrase — so every board owner in the workspace would hold the key to
 * every other board's vault. With a keypair, sealing needs only the public half,
 * so a vault can be escrowed by someone who cannot open the escrow at all.
 *
 * WHAT IT COSTS, stated honestly because it is a real widening of the threat
 * model: one passphrase now opens every vault that opted in. It is never
 * emailed and never derivable from a login, so the original promise — a
 * compromised email account cannot reach vault contents — still holds. But the
 * blast radius of THIS secret is the whole workspace, and the UI says so.
 *
 * Losing the escrow passphrase loses only the escrow. Every vault still opens
 * with its own password or recovery key; escrow is a safety net, never a
 * primary path.
 */

const vaultEscrowSchema = new mongoose.Schema(
  {
    organisation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organisation',
      required: true,
      unique: true,
      index: true,
    },

    // SPKI, base64. PUBLIC — deliberately readable by any member, because every
    // vault creation needs it and none of them may be trusted with more.
    publicKey: { type: String, required: true },

    // Public KDF parameters for the passphrase, same shape and reasoning as
    // Vault.kdf: stored per-record so the cost can be raised later without
    // invalidating what exists.
    kdf: {
      algo: { type: String, default: 'PBKDF2-SHA256' },
      iterations: { type: Number, required: true },
      salt: { type: String, required: true },
    },

    // PKCS8 private key, AES-256-GCM sealed under the passphrase-derived key.
    // Never useful to anyone holding the database.
    wrappedPrivateKey: {
      ciphertext: { type: String, required: true },
      iv: { type: String, required: true },
    },

    // scrypt hash of the passphrase's auth proof, portalCrypto format.
    // `select: false` for the same reason Vault.proofHash is.
    proofHash: { type: String, required: true, select: false },

    // Guessing brake, following the org rather than the caller. Mirrors Vault's.
    failedAttempts: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    passphraseChangedAt: { type: Date, default: null },
    passphraseChangedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('VaultEscrow', vaultEscrowSchema);
