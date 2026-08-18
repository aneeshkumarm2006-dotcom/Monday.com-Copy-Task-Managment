const mongoose = require('mongoose');

/**
 * Vault — the per-board secure store's KEY MATERIAL. One document per board.
 *
 * THIS DOCUMENT IS THE WHOLE SECURITY MODEL, so read it before changing it.
 *
 * The requirement the vault exists to meet: someone who compromises a user's
 * EMAIL can reset the app password and sign in as them, and must still not be
 * able to read the vault. That rules out anything protected only by login, so
 * the vault is zero-knowledge — every byte of content is encrypted in the
 * browser and the server only ever holds ciphertext.
 *
 *   vault password (human, never transmitted)
 *      │ PBKDF2-SHA-256, per-vault random salt   (client-side WebCrypto)
 *      ▼
 *   stretched key ──HKDF──┬──► ENCRYPTION KEY — never leaves the browser
 *                         │      wraps/unwraps the Vault Key
 *                         └──► AUTH PROOF — sent on unlock; we store only its
 *                                scrypt hash (utils/portalCrypto.js)
 *   Vault Key (VK) — random 256-bit, generated client-side at setup
 *      │ AES-256-GCM
 *      ▼
 *   every VaultItem's ciphertext (see VaultItem.js)
 *
 * What lives here is therefore, deliberately, only:
 *   - `kdf`          — the PUBLIC parameters the client needs to redo the
 *                      derivation. A salt is not a secret; it exists to make
 *                      precomputation useless, and the client cannot derive
 *                      anything without it.
 *   - `wrappedVK`    — VK sealed with the encryption key. Useless without the
 *                      password.
 *   - `proofHash`    — scrypt of the auth proof. NOT the password, and not the
 *                      encryption key: the two HKDF branches are independent, so
 *                      cracking this hash yields the proof, not the key.
 *   - `recoveryWrap` — VK sealed with the one-time recovery key, shown once at
 *                      setup and never stored. Null if the user declined it.
 *
 * Consequences that are FEATURES, not gaps:
 *   - There is no password reset. Email recovery would hand the attacker the
 *     vault via the exact door this design closes. The recovery key is the only
 *     escape hatch, by design.
 *   - Changing the vault password re-wraps VK and rewrites `proofHash`. Items
 *     are never re-encrypted, because they were never encrypted with anything
 *     derived from the password — that indirection is the entire point of VK.
 */

/** A single AES-256-GCM payload. Both halves base64; the IV is per-payload. */
const sealedSchema = new mongoose.Schema(
  {
    ciphertext: { type: String, required: true },
    iv: { type: String, required: true },
  },
  { _id: false }
);

const vaultSchema = new mongoose.Schema(
  {
    board: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Board',
      required: true,
      unique: true,
      index: true,
    },

    // Public KDF parameters. Stored per-vault rather than as constants so
    // raising the iteration count later does not invalidate existing vaults —
    // the same reasoning as portalCrypto writing scrypt's N/r/p into the hash.
    kdf: {
      algo: { type: String, default: 'PBKDF2-SHA256' },
      iterations: { type: Number, required: true },
      salt: { type: String, required: true }, // base64
    },

    // VK sealed with the password-derived encryption key.
    wrappedVK: { type: sealedSchema, required: true },

    // scrypt hash of the auth proof, in portalCrypto's `scrypt$N$r$p$salt$key`
    // format. `select: false` so it can never ride along on an incidental read —
    // the unlock handler asks for it explicitly.
    proofHash: { type: String, required: true, select: false },

    // ---- The recovery key path -------------------------------------------
    //
    // Structurally identical to the password path above — its own salt, its own
    // wrap of the SAME VK, its own proof hash — because it is the same
    // derivation run over a different input. That symmetry is deliberate: the
    // client can reuse one `deriveKeys` function, and the server can reuse one
    // `verifyPassword`, so recovery is not a second, less-examined code path.
    //
    // All three are null together when the user declined a recovery key, which
    // is allowed and means "there is no way back".
    //
    // The key itself — 256 bits of randomness, shown once at setup — is never
    // stored. Its iteration count is the same as the password's purely so the
    // shared derivation needs no branch; the entropy, not the KDF, is what
    // makes it unguessable.
    recoveryWrap: { type: sealedSchema, default: null },
    recoveryKdf: {
      algo: { type: String, default: null },
      iterations: { type: Number, default: null },
      salt: { type: String, default: null }, // base64
    },
    recoveryProofHash: { type: String, default: null, select: false },

    // ---- The organisation escrow path -------------------------------------
    //
    // The third door, and the only one not held by this board's own people. VK
    // sealed to the ORG's escrow public key (see models/VaultEscrow.js), so any
    // board member can turn escrow on for their vault without being trusted
    // with the passphrase that opens it — that asymmetry is the entire reason
    // escrow uses a keypair rather than a shared secret.
    //
    // Null unless the vault opted in. RSA-OAEP output carries no IV, so unlike
    // every other wrap here this is a bare ciphertext.
    //
    // `escrow` names WHICH escrow record it was sealed to. Without it, an org
    // that ever replaced its escrow keypair would leave every vault holding a
    // wrap that silently cannot be opened, discovered only on the day it is
    // needed.
    escrow: {
      wrap: { type: String, default: null },
      escrow: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'VaultEscrow',
        default: null,
      },
      addedAt: { type: Date, default: null },
      addedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null,
      },
    },

    // Per-vault brake on password guessing. The route limiter keys on the
    // user/IP, which a determined attacker with several accounts sidesteps; this
    // one follows the VAULT. Mirrors ClientContact's fields and semantics.
    failedAttempts: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // Who last changed the vault password, and when. Metadata only — knowing a
    // rotation happened is what lets a team confirm an offboarding was done.
    passwordChangedAt: { type: Date, default: null },
    passwordChangedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Vault', vaultSchema);
