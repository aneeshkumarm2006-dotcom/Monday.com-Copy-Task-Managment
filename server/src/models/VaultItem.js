const mongoose = require('mongoose');

/**
 * VaultItem — one encrypted entry in a board's vault.
 *
 * The row is deliberately almost empty. `ciphertext` holds an AES-256-GCM
 * sealing of the ENTIRE item — its title, its fields, the real filename of an
 * upload, everything — so a full database dump reveals only that a board has N
 * items of certain kinds and when they were touched.
 *
 * That is why there is no `title` column, however tempting one is for sorting
 * and search: a plaintext title ("Stripe live secret key", "AWS root account")
 * is most of the secret. The list UI decrypts titles client-side after unlock,
 * which is slower to build and the only version that keeps the promise.
 *
 * `type` IS stored in the clear, on purpose. The client must know which decoder
 * to run before it can read anything, and "this board holds three credentials
 * and a file" is not a secret worth an extra round of complexity.
 *
 * `board` is denormalised from `vault` — the Note.js pattern — so every
 * board-scoped query and the cascade delete stay single-collection lookups.
 */

const ITEM_TYPES = ['credential', 'note', 'doc', 'sheet', 'file'];

const vaultItemSchema = new mongoose.Schema(
  {
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
    type: {
      type: String,
      enum: ITEM_TYPES,
      required: true,
    },

    // AES-256-GCM over the item's JSON payload, base64. The IV is random per
    // SAVE, never per item — reusing an IV with the same key breaks GCM
    // catastrophically, so every write generates a fresh one client-side.
    ciphertext: { type: String, required: true },
    iv: { type: String, required: true },

    // Only for type 'file'. The bytes at `url` are ciphertext too: the browser
    // encrypts before upload, so Cloudinary — whose URLs are public to anyone
    // holding them — stores an opaque blob under a random name. The real
    // filename, size and MIME live inside `ciphertext` above.
    file: {
      url: { type: String, default: null },
      publicId: { type: String, default: null },
      // Byte length of the ENCRYPTED blob. Kept in the clear for quota and for
      // "this download will be 4 MB"; it leaks only an approximate plaintext
      // size, which the Cloudinary object leaks anyway.
      size: { type: Number, default: 0 },
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    lastEditedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true }
);

// The list query: one vault, most recently edited first.
vaultItemSchema.index({ vault: 1, updatedAt: -1 });

const Model = mongoose.model('VaultItem', vaultItemSchema);
Model.ITEM_TYPES = ITEM_TYPES;

module.exports = Model;
