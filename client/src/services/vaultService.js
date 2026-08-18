import api from './api';

/**
 * Vault — thin wrappers over the vault API, in the noteService style.
 *
 * The one thing this layer adds beyond URL shapes is the vault token header.
 * Every request already carries the app session via api.js's interceptor; the
 * routes that touch ciphertext need a SECOND proof that somebody unlocked the
 * vault recently, and it travels in `X-Vault-Token` rather than `Authorization`
 * because the latter is occupied.
 *
 * Nothing here encrypts or decrypts. Payloads arrive already sealed from
 * [vaultCrypto.js](../utils/vaultCrypto.js) and leave still sealed — this file
 * moves opaque strings, which is exactly as much as the network layer should
 * understand about a vault.
 */

/** The header block for a route behind `vaultAuth`. */
const withVault = (vaultToken, config = {}) => ({
  ...config,
  headers: { ...(config.headers || {}), 'X-Vault-Token': vaultToken || '' },
});

// ---- meta / setup ----------------------------------------------------------

/**
 * GET /api/boards/:boardId/vault — does this board have a vault, and with which
 * KDF parameters. Returns `{ exists: false, canManage }` when it does not.
 *
 * Deliberately does NOT include `wrappedVK`; that arrives on unlock, against
 * proof. See the server controller for why.
 */
export const getVaultMeta = async (boardId) => {
  const { data } = await api.get(`/api/boards/${boardId}/vault`);
  return data;
};

/**
 * POST /api/boards/:boardId/vault — one-time setup.
 *
 * Every field was produced in the browser: `kdf` (public parameters), `wrappedVK`
 * (the vault key sealed under the password), `proof` (the transmittable HKDF
 * branch), and the optional recovery trio. Returns a vault token, so setup and
 * the first unlock are one step.
 */
export const createVault = async (boardId, payload) => {
  const { data } = await api.post(`/api/boards/${boardId}/vault`, payload);
  return data;
};

/**
 * POST /api/boards/:boardId/vault/unlock
 *
 * `suppressErrorToast` because a wrong password is the expected case on this
 * endpoint, and the lock screen shows the message inline where the user is
 * already looking.
 */
export const unlockVault = async (boardId, proof) => {
  const { data } = await api.post(
    `/api/boards/${boardId}/vault/unlock`,
    { proof },
    { suppressErrorToast: true }
  );
  return data;
};

/** POST /api/boards/:boardId/vault/recover — the same, via the recovery key. */
export const recoverVault = async (boardId, proof) => {
  const { data } = await api.post(
    `/api/boards/${boardId}/vault/recover`,
    { proof },
    { suppressErrorToast: true }
  );
  return data;
};

/**
 * POST /api/boards/:boardId/vault/password — rotate the password.
 * Needs the vault open AND the old proof; see the controller for why both.
 */
export const changeVaultPassword = async (boardId, vaultToken, payload) => {
  const { data } = await api.post(
    `/api/boards/${boardId}/vault/password`,
    payload,
    withVault(vaultToken, { suppressErrorToast: true })
  );
  return data;
};

// ---- items -----------------------------------------------------------------

/** GET /api/boards/:boardId/vault/items — every ciphertext, newest edit first. */
export const getVaultItems = async (boardId, vaultToken) => {
  const { data } = await api.get(
    `/api/boards/${boardId}/vault/items`,
    withVault(vaultToken)
  );
  return data;
};

/**
 * POST /api/boards/:boardId/vault/items
 * @param {Object} payload { type, ciphertext, iv, file? }
 */
export const createVaultItem = async (boardId, vaultToken, payload) => {
  const { data } = await api.post(
    `/api/boards/${boardId}/vault/items`,
    payload,
    withVault(vaultToken)
  );
  return data.item;
};

/**
 * PATCH /api/vault/items/:id — always a full ciphertext replacement. There is no
 * partial update: the server holds one opaque blob and cannot patch inside it.
 */
export const updateVaultItem = async (itemId, vaultToken, { ciphertext, iv }) => {
  const { data } = await api.patch(
    `/api/vault/items/${itemId}`,
    { ciphertext, iv },
    withVault(vaultToken)
  );
  return data.item;
};

/** DELETE /api/vault/items/:id */
export const deleteVaultItem = async (itemId, vaultToken) => {
  const { data } = await api.delete(
    `/api/vault/items/${itemId}`,
    withVault(vaultToken)
  );
  return data;
};

/**
 * POST /api/boards/:boardId/vault/items/upload — send one ALREADY-ENCRYPTED blob.
 *
 * The caller passes the ciphertext Blob from `encryptFile`, never a File the user
 * picked. The filename on the wire is a throwaway constant for the same reason
 * the server stores a random public_id: a Cloudinary URL is public to whoever
 * holds it, and the real name is part of the secret.
 *
 * Returns `{ url, publicId, size }` to seal into the item payload.
 */
export const uploadVaultBlob = async (boardId, vaultToken, blob, onProgress) => {
  const form = new FormData();
  form.append('file', blob, 'blob.bin');
  const { data } = await api.post(
    `/api/boards/${boardId}/vault/items/upload`,
    form,
    withVault(vaultToken, {
      onUploadProgress: (e) => {
        if (onProgress && e.total) onProgress(Math.round((e.loaded / e.total) * 100));
      },
    })
  );
  return data.file;
};

/**
 * Fetch an encrypted blob back so the browser can decrypt it.
 *
 * Through the existing `/api/proxy/download` rather than straight at Cloudinary,
 * for the same reason every other attachment download uses it: the proxy signs
 * the URL server-side, follows redirects, and is already restricted to
 * `res.cloudinary.com`, so no CORS policy or delivery restriction can leave a
 * file undownloadable. Routing it through our server costs nothing here — what
 * passes over that hop is ciphertext.
 *
 * `name` is a throwaway: the response is read as bytes, never saved under this
 * name. The real filename comes out of the item payload after decryption.
 */
export const fetchVaultBlob = async (url) => {
  const { data } = await api.get('/api/proxy/download', {
    params: { url, name: 'blob.bin' },
    responseType: 'arraybuffer',
  });
  return data;
};

// ---- organisation escrow (the break-glass key) -----------------------------

/**
 * GET /api/orgs/:orgId/vault-escrow — does this workspace have a break-glass key.
 * Readable by any member; what it returns is a public key and a salt.
 */
export const getOrgEscrow = async (orgId) => {
  const { data } = await api.get(`/api/orgs/${orgId}/vault-escrow`);
  return data;
};

/**
 * POST /api/orgs/:orgId/vault-escrow — create it. One time, per workspace.
 * `payload` is `{ publicKey, kdf, wrappedPrivateKey, proof }` from
 * `buildEscrowBlock` — the private key is already sealed before it gets here.
 */
export const createOrgEscrow = async (orgId, payload) => {
  const { data } = await api.post(`/api/orgs/${orgId}/vault-escrow`, payload);
  return data;
};

/**
 * POST /api/orgs/:orgId/vault-escrow/unseal — get the sealed private key back,
 * against proof of the passphrase.
 *
 * Withheld from the GET on purpose (it is offline-attackable), which is why
 * rotation is two round trips: unseal, then re-seal.
 */
export const unsealOrgEscrow = async (orgId, proof) => {
  const { data } = await api.post(
    `/api/orgs/${orgId}/vault-escrow/unseal`,
    { proof },
    { suppressErrorToast: true }
  );
  return data;
};

/** POST /api/orgs/:orgId/vault-escrow/passphrase — rotate it, keeping the keypair. */
export const changeEscrowPassphrase = async (orgId, payload) => {
  const { data } = await api.post(
    `/api/orgs/${orgId}/vault-escrow/passphrase`,
    payload,
    { suppressErrorToast: true }
  );
  return data;
};

/**
 * POST /api/boards/:boardId/vault/escrow — cover this vault with the workspace
 * key, or stop covering it. Needs the vault open, because only VK can produce
 * the wrap.
 */
export const setVaultEscrow = async (boardId, vaultToken, { enabled, wrap }) => {
  const { data } = await api.post(
    `/api/boards/${boardId}/vault/escrow`,
    { enabled, wrap },
    withVault(vaultToken)
  );
  return data;
};

/**
 * POST /api/boards/:boardId/vault/escrow-recover — break glass.
 * Returns the vault's escrow wrap AND the sealed escrow private key; both are
 * inert without the passphrase the caller just proved they know.
 */
export const escrowRecoverVault = async (boardId, proof) => {
  const { data } = await api.post(
    `/api/boards/${boardId}/vault/escrow-recover`,
    { proof },
    { suppressErrorToast: true }
  );
  return data;
};

// ---- audit -----------------------------------------------------------------

/**
 * GET /api/boards/:boardId/vault/audit — who opened the vault and when.
 * Metadata only, and readable without unlocking; needs `vault.manage`.
 */
export const getVaultAudit = async (boardId, limit = 100) => {
  const { data } = await api.get(`/api/boards/${boardId}/vault/audit`, {
    params: { limit },
  });
  return data.entries || [];
};
