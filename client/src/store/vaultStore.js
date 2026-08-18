import { create } from 'zustand';
import * as vaultService from '../services/vaultService';
import {
  deriveKeys,
  deriveRecoveryKeys,
  decryptItem,
  encryptItem,
  generateVK,
  importVaultKey,
  newKdfParams,
  unwrapVK,
  buildRecoveryBlock,
  wrapVK,
  wrapVKToEscrow,
  unwrapVKWithEscrow,
  wipe,
} from '../utils/vaultCrypto';

/**
 * The unlocked vault, in memory.
 *
 * THE ONE RULE FOR THIS FILE: nothing in it may ever be persisted. No
 * `zustand/middleware` persist, no localStorage, no sessionStorage, no
 * IndexedDB. Every other store in the app is free to cache; this one caches the
 * key to a board's production credentials, and a vault that survives a browser
 * restart is a vault that survives a stolen laptop.
 *
 * What that buys, and what it costs: closing the tab locks the vault. Switching
 * boards locks it. Five idle minutes lock it. That is the intended behaviour,
 * not friction to be smoothed away later.
 *
 * `vaultKey` is a non-extractable CryptoKey (see vaultCrypto), so even the code
 * holding this store cannot read the key material back out of it — it can only
 * ask WebCrypto to use it. Whoever eventually adds a devtools dump of the store
 * will not leak the vault by accident.
 */

// How long the browser holds the key with nobody touching it. Shorter than the
// server token's 15 minutes on purpose: the token expiring is the backstop, an
// unattended screen is the actual risk.
const IDLE_LOCK_MS = 5 * 60 * 1000;
const TOKEN_LIFETIME_MS = 15 * 60 * 1000;

let idleTimer = null;

const clearIdleTimer = () => {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
};

/** True when the server says the vault token is gone or the vault is barred. */
const isLockedOut = (err) => {
  const code = err?.response?.data?.code;
  return code === 'VAULT_LOCKED' || code === 'VAULT_LOCKED_OUT';
};

/** The server's own sentence when there is one; ours only as a fallback. */
const readError = (err, fallback) =>
  err?.response?.data?.error || err?.message || fallback;

/** What to say when the current secret does not open the session's wrap. */
const WRONG_SECRET = {
  password: 'That current password is not right.',
  recovery: 'That recovery key is not right.',
  escrow: 'That workspace recovery passphrase is not right.',
};

/**
 * Re-open VK from whichever door was used this session, and produce the proof
 * the server will re-check.
 *
 * There are three, and they are not interchangeable — each has its own wrap, its
 * own KDF salt and its own stored proof hash:
 *
 *   { kind: 'password', wrap, kdf }
 *   { kind: 'recovery', wrap, kdf }                  — normalised hex input
 *   { kind: 'escrow',   wrap, kdf, privateKeyBlob }  — RSA, via the org key
 *
 * One resolver rather than three branches at each call site, because the only
 * caller that needs this is the password change, and getting the wrong salt
 * there would fail in a way that reads like a wrong password.
 */
const openSessionVK = async (session, secret) => {
  const params = { iterations: session.kdf.iterations };

  if (session.kind === 'escrow') {
    // The escrow passphrase opens the org private key, which opens VK. Its
    // proof is the org escrow's, not the vault's.
    const { proof } = await deriveKeys(secret, session.kdf.salt, params);
    const vkBytes = await unwrapVKWithEscrow(
      session.wrap,
      session.privateKeyBlob,
      secret,
      session.kdf
    );
    return { vkBytes, proof };
  }

  const derive = session.kind === 'recovery' ? deriveRecoveryKeys : deriveKeys;
  const { encryptionKey, proof } = await derive(secret, session.kdf.salt, params);
  return { vkBytes: await unwrapVK(session.wrap, encryptionKey), proof };
};

/**
 * Run a vault mutation, and LOCK if the server says the vault is no longer open.
 *
 * Without this, a 15-minute token expiring mid-session leaves the UI insisting
 * the vault is unlocked while every save fails — the user keeps retrying against
 * a door that shut behind them. Locking turns that into the lock screen, which
 * is both true and actionable.
 *
 * Only `VAULT_LOCKED` triggers it. An ordinary failure (a validation error, a
 * 500) must not throw away a decrypted vault the user is working in.
 */
const withLockOnExpiry = async (get, fn) => {
  try {
    return await fn();
  } catch (err) {
    if (isLockedOut(err)) get().lock();
    throw err;
  }
};

const useVaultStore = create((set, get) => ({
  /** Which board this unlocked state belongs to. Guards against a stale unlock. */
  boardId: null,
  /** Non-extractable AES-GCM CryptoKey, or null when locked. */
  vaultKey: null,
  /** The short-lived vault-scoped JWT for the item routes. */
  vaultToken: null,
  /** When the current token was minted, so the UI can warn before it lapses. */
  unlockedAt: null,
  /** Decrypted items: [{ ...serverRow, payload }] — never written to disk. */
  items: [],
  /** The server's `vault.manage` answer for this board. */
  canManage: false,
  /** Set after a recovery unlock: the vault is open but nobody knows a password. */
  needsPasswordReset: false,
  loading: false,
  /** Last failure, shown inline where the user is already looking. */
  error: null,

  /**
   * The wrap that opened the vault THIS session, plus the KDF parameters it was
   * made with and which secret opens it.
   *
   * Held because a password change must re-wrap VK, and the store's VK is
   * deliberately non-extractable — so the raw bytes have to be recovered by
   * unwrapping this again with the current secret. It cannot come from
   * `getVaultMeta`, which withholds every wrap until a proof lands; it only ever
   * arrives in an unlock/setup/recover response, which is exactly here.
   *
   * It is ciphertext. Keeping it costs nothing that unlocking had not already
   * spent.
   */
  session: null, // see openSessionVK for the three shapes

  isUnlocked: () => !!get().vaultKey,

  // ---- lifecycle -----------------------------------------------------------

  /**
   * Drop everything. Called on lock, logout, board change and idle timeout.
   * Sets rather than deletes so a mounted component re-renders into the locked
   * state instead of reading a half-cleared store.
   */
  lock: () => {
    clearIdleTimer();
    set({
      boardId: null,
      vaultKey: null,
      vaultToken: null,
      unlockedAt: null,
      items: [],
      canManage: false,
      needsPasswordReset: false,
      session: null,
      error: null,
    });
  },

  /**
   * Restart the idle countdown. Called on deliberate vault interactions —
   * opening an item, copying a field, saving — NOT on mouse movement. Watching
   * the whole document would hold a vault open on a screen nobody is reading,
   * which is the case this timer exists for.
   */
  touch: () => {
    if (!get().vaultKey) return;
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      // Read through the store rather than closing over `lock`, so a lock that
      // already happened for another reason is a no-op instead of a second one.
      if (useVaultStore.getState().vaultKey) useVaultStore.getState().lock();
    }, IDLE_LOCK_MS);
  },

  /** Seconds until the server token expires; 0 when locked. For the UI banner. */
  tokenSecondsLeft: () => {
    const at = get().unlockedAt;
    if (!at) return 0;
    return Math.max(0, Math.round((at + TOKEN_LIFETIME_MS - Date.now()) / 1000));
  },

  /**
   * Adopt a freshly-minted session. The ONLY place `vaultKey` is ever set, so
   * setup, unlock and recovery cannot drift in what "unlocked" means.
   */
  _adopt: async ({
    boardId,
    vkBytes,
    vaultToken,
    canManage,
    session,
    needsPasswordReset = false,
  }) => {
    const vaultKey = await importVaultKey(vkBytes);
    // The raw bytes have done their job. See wipe() for how much this is worth.
    wipe(vkBytes);
    set({
      boardId,
      vaultKey,
      vaultToken,
      unlockedAt: Date.now(),
      canManage: !!canManage,
      needsPasswordReset,
      session,
      error: null,
    });
    get().touch();
  },

  // ---- opening the vault ---------------------------------------------------

  /**
   * First-time setup. Generates VK, wraps it under the new password, optionally
   * builds the recovery block, and ships only ciphertext plus the auth proof.
   *
   * @returns {Promise<{ recoveryKey: string|null }>} the recovery key exists ONLY
   *          in this return value — shown once, stored nowhere, by anyone.
   */
  setup: async (
    boardId,
    password,
    { withRecovery = true, escrowPublicKey = null } = {}
  ) => {
    set({ loading: true, error: null });
    try {
      const kdf = newKdfParams();
      const { encryptionKey, proof } = await deriveKeys(password, kdf.salt, {
        iterations: kdf.iterations,
      });

      const vkBytes = generateVK();
      const wrappedVK = await wrapVK(vkBytes, encryptionKey);

      const payload = { kdf, wrappedVK, proof };
      let recoveryKey = null;
      if (withRecovery) {
        const rec = await buildRecoveryBlock(vkBytes);
        recoveryKey = rec.recoveryKey;
        payload.recoveryKdf = rec.recoveryKdf;
        payload.recoveryWrap = rec.recoveryWrap;
        payload.recoveryProof = rec.recoveryProof;
      }

      // Escrow at creation costs one RSA encrypt and needs only the PUBLIC key,
      // so the person setting the vault up covers it with the workspace
      // break-glass key without being able to open that key themselves.
      if (escrowPublicKey) {
        payload.escrowWrap = await wrapVKToEscrow(vkBytes, escrowPublicKey);
      }

      const res = await vaultService.createVault(boardId, payload);
      await get()._adopt({
        boardId,
        vkBytes,
        vaultToken: res.vaultToken,
        canManage: true,
        session: { kind: 'password', wrap: wrappedVK, kdf },
      });
      set({ items: [], loading: false });
      return { recoveryKey };
    } catch (err) {
      set({ loading: false, error: readError(err, 'Could not create the vault.') });
      throw err;
    }
  },

  /**
   * Unlock with the vault password.
   *
   * Note the order: derive locally, send only the proof, and receive `wrappedVK`
   * in the SAME response. The wrap is never handed out before the proof lands,
   * so a stolen app session cannot even collect the material to grind offline.
   */
  unlock: async (boardId, password, meta) => {
    set({ loading: true, error: null });
    try {
      const { encryptionKey, proof } = await deriveKeys(password, meta.kdf.salt, {
        iterations: meta.kdf.iterations,
      });
      const res = await vaultService.unlockVault(boardId, proof);

      let vkBytes;
      try {
        vkBytes = await unwrapVK(res.wrappedVK, encryptionKey);
      } catch {
        // The server accepted the proof but the wrap will not open. Both derive
        // from the same password, so this is NOT a wrong password — it is
        // corruption, and saying "wrong password" would send someone hunting for
        // a problem they do not have.
        throw new Error(
          'The vault key could not be opened. The stored key material may be damaged.'
        );
      }

      await get()._adopt({
        boardId,
        vkBytes,
        vaultToken: res.vaultToken,
        canManage: res.canManage,
        session: { kind: 'password', wrap: res.wrappedVK, kdf: meta.kdf },
      });
      set({ loading: false });
      await get().loadItems();
      return true;
    } catch (err) {
      set({ loading: false, error: readError(err, 'Could not unlock the vault.') });
      return false;
    }
  },

  /**
   * Unlock with the one-time recovery key.
   *
   * Leaves `needsPasswordReset` set: the caller holds VK, but nobody knows the
   * password any more, so without a new one the vault is open now and shut
   * forever afterwards. The UI turns that flag into an unskippable prompt.
   */
  recover: async (boardId, recoveryKey, meta) => {
    set({ loading: true, error: null });
    try {
      // One derivation for both halves — normalisation of the typed key lives in
      // deriveRecoveryKeys, so the proof and the unwrap cannot disagree about
      // what the user actually entered.
      const { encryptionKey, proof } = await deriveRecoveryKeys(
        recoveryKey,
        meta.recoveryKdf.salt,
        { iterations: meta.recoveryKdf.iterations }
      );
      const res = await vaultService.recoverVault(boardId, proof);

      let vkBytes;
      try {
        vkBytes = await unwrapVK(res.recoveryWrap, encryptionKey);
      } catch {
        throw new Error('The vault key could not be opened with that recovery key.');
      }

      await get()._adopt({
        boardId,
        vkBytes,
        vaultToken: res.vaultToken,
        canManage: true,
        needsPasswordReset: true,
        session: { kind: 'recovery', wrap: res.recoveryWrap, kdf: meta.recoveryKdf },
      });
      set({ loading: false });
      await get().loadItems();
      return true;
    } catch (err) {
      set({ loading: false, error: readError(err, 'Could not use that recovery key.') });
      return false;
    }
  },

  /**
   * Break glass: open the vault with the WORKSPACE escrow passphrase.
   *
   * Three unwraps deep — passphrase opens the org private key, which opens the
   * vault's escrow wrap, which is VK. All three happen here in the browser; the
   * server hands over two sealed blobs and never learns the passphrase.
   *
   * Like the recovery key, it leaves `needsPasswordReset` set: the vault is open
   * but nobody knows its password, so a new one has to be chosen now.
   */
  escrowRecover: async (boardId, passphrase, meta) => {
    set({ loading: true, error: null });
    try {
      const kdf = meta.escrow.kdf;
      const { proof } = await deriveKeys(passphrase, kdf.salt, {
        iterations: kdf.iterations,
      });
      const res = await vaultService.escrowRecoverVault(boardId, proof);

      let vkBytes;
      try {
        vkBytes = await unwrapVKWithEscrow(
          res.escrowWrap,
          res.wrappedPrivateKey,
          passphrase,
          res.kdf
        );
      } catch {
        throw new Error(
          'The workspace recovery key could not open this vault. Its key material may be damaged.'
        );
      }

      await get()._adopt({
        boardId,
        vkBytes,
        vaultToken: res.vaultToken,
        canManage: true,
        needsPasswordReset: true,
        session: {
          kind: 'escrow',
          wrap: res.escrowWrap,
          kdf: res.kdf,
          privateKeyBlob: res.wrappedPrivateKey,
        },
      });
      set({ loading: false });
      await get().loadItems();
      return true;
    } catch (err) {
      set({
        loading: false,
        error: readError(err, 'Could not use the workspace recovery key.'),
      });
      return false;
    }
  },

  /**
   * Cover this vault with the workspace escrow key, or stop covering it.
   *
   * Enabling asks for the vault password even though the vault is already open,
   * and that is deliberate rather than an oversight: producing the wrap needs
   * raw VK, and the store's copy is non-extractable by design. Re-deriving it
   * from the password is the only way — and proving you hold the primary secret
   * before adding a SECOND door to the vault is the right bar anyway.
   *
   * Disabling needs no secret. It removes a way in rather than adding one, and
   * a board's own administrators may always decline the workspace key.
   */
  setEscrow: async (boardId, { enabled, currentSecret, publicKey }) => {
    const { vaultKey, vaultToken, session } = get();
    if (!vaultKey || !session) throw new Error('The vault is locked.');
    get().touch();

    if (!enabled) {
      await withLockOnExpiry(get, () =>
        vaultService.setVaultEscrow(boardId, vaultToken, { enabled: false })
      );
      return { enabled: false };
    }

    let vkBytes;
    try {
      ({ vkBytes } = await openSessionVK(session, currentSecret));
    } catch {
      throw new Error(WRONG_SECRET[session.kind] || WRONG_SECRET.password);
    }

    const wrap = await wrapVKToEscrow(vkBytes, publicKey);
    wipe(vkBytes);

    await withLockOnExpiry(get, () =>
      vaultService.setVaultEscrow(boardId, vaultToken, { enabled: true, wrap })
    );
    return { enabled: true };
  },

  /**
   * Rotate the vault password — the offboarding path.
   *
   * VK is unchanged, so not one item is re-encrypted; only its wrap and the
   * stored proof change. That is the whole reason VK exists.
   *
   * `currentSecret` is whatever opened the vault this session — the password, or
   * the recovery key after a recovery unlock. `session` remembers which, so the
   * caller does not have to.
   *
   * @param {Object} opts
   * @param {string} opts.currentSecret
   * @param {boolean} [opts.rotateRecovery] mint a fresh recovery key too
   * @returns {Promise<{ recoveryKey: string|null }>}
   */
  changePassword: async (
    boardId,
    newPassword,
    { currentSecret, rotateRecovery = false } = {}
  ) => {
    const { vaultKey, vaultToken, session } = get();
    if (!vaultKey || !session) throw new Error('The vault is locked.');
    get().touch();

    // Re-open VK from whichever door is holding this session, and get the proof
    // the server re-checks, in one step. See openSessionVK.
    let vkBytes;
    let currentProof;
    try {
      ({ vkBytes, proof: currentProof } = await openSessionVK(session, currentSecret));
    } catch {
      throw new Error(WRONG_SECRET[session.kind] || WRONG_SECRET.password);
    }

    const kdf = newKdfParams();
    const { encryptionKey, proof } = await deriveKeys(newPassword, kdf.salt, {
      iterations: kdf.iterations,
    });
    const wrappedVK = await wrapVK(vkBytes, encryptionKey);

    const payload = { currentProof, kdf, wrappedVK, proof };
    let recoveryKey = null;
    if (rotateRecovery) {
      const rec = await buildRecoveryBlock(vkBytes);
      recoveryKey = rec.recoveryKey;
      payload.recoveryKdf = rec.recoveryKdf;
      payload.recoveryWrap = rec.recoveryWrap;
      payload.recoveryProof = rec.recoveryProof;
    }

    const res = await withLockOnExpiry(get, () =>
      vaultService.changeVaultPassword(boardId, vaultToken, payload)
    );

    // Re-adopt so the session now tracks the NEW password's wrap. Without this a
    // second rotation in the same sitting would re-prove the old secret and fail.
    await get()._adopt({
      boardId,
      vkBytes,
      vaultToken: res.vaultToken,
      canManage: true,
      needsPasswordReset: false,
      session: { kind: 'password', wrap: wrappedVK, kdf },
    });
    return { recoveryKey };
  },

  // ---- items ---------------------------------------------------------------

  /**
   * Fetch and decrypt the whole list.
   *
   * An item that fails to decrypt is KEPT and marked `broken`, never dropped.
   * Silently omitting it would tell the user their data vanished; showing an
   * undecryptable row tells them the truth and leaves them able to delete it.
   */
  loadItems: async () => {
    const { boardId, vaultToken, vaultKey } = get();
    if (!boardId || !vaultKey) return;
    set({ loading: true });
    try {
      const { items, canManage } = await vaultService.getVaultItems(boardId, vaultToken);
      const decrypted = await Promise.all(
        items.map(async (row) => {
          try {
            return { ...row, payload: await decryptItem(row, vaultKey), broken: false };
          } catch {
            return { ...row, payload: null, broken: true };
          }
        })
      );
      set({ items: decrypted, canManage: !!canManage, loading: false });
    } catch (err) {
      set({ loading: false });
      // An expired token means the vault closed under us; drop the key rather
      // than leave the UI showing an unlocked vault that answers nothing.
      if (isLockedOut(err)) get().lock();
      else set({ error: readError(err, 'Could not load the vault.') });
    }
  },

  /** Encrypt a payload and create the item. `file` is the already-uploaded handle. */
  createItem: async (type, payload, file = null) => {
    const { boardId, vaultToken, vaultKey } = get();
    if (!vaultKey) throw new Error('The vault is locked.');
    get().touch();

    const sealed = await encryptItem(payload, vaultKey);
    const body = { type, ...sealed };
    if (file) body.file = file;

    const row = await withLockOnExpiry(get, () =>
      vaultService.createVaultItem(boardId, vaultToken, body)
    );
    set((s) => ({ items: [{ ...row, payload, broken: false }, ...s.items] }));
    return row;
  },

  /**
   * Re-seal an item. Always a full replacement with a FRESH IV — there is no
   * partial update, because the server holds one opaque blob.
   */
  updateItem: async (itemId, payload) => {
    const { vaultToken, vaultKey } = get();
    if (!vaultKey) throw new Error('The vault is locked.');
    get().touch();

    const sealed = await encryptItem(payload, vaultKey);
    const row = await withLockOnExpiry(get, () =>
      vaultService.updateVaultItem(itemId, vaultToken, sealed)
    );
    set((s) => ({
      items: s.items.map((i) =>
        i._id === itemId ? { ...row, payload, broken: false } : i
      ),
    }));
    return row;
  },

  /**
   * Run a caller-supplied vault request under the same lock-on-expiry rule.
   * Exposed for the encrypted file upload, which talks to the service directly
   * because it needs per-chunk progress the store has no use for.
   */
  guarded: (fn) => withLockOnExpiry(get, fn),

  deleteItem: async (itemId) => {
    const { vaultToken, vaultKey } = get();
    if (!vaultKey) throw new Error('The vault is locked.');
    get().touch();

    await withLockOnExpiry(get, () =>
      vaultService.deleteVaultItem(itemId, vaultToken)
    );
    set((s) => ({ items: s.items.filter((i) => i._id !== itemId) }));
  },
}));

export default useVaultStore;
