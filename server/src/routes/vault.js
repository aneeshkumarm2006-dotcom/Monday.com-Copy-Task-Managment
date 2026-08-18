const express = require('express');
const authMiddleware = require('../middleware/auth');
const vaultAuth = require('../middleware/vaultAuth');
const rateLimit = require('../middleware/rateLimit');
const { vaultBlobUpload, handleUploadError } = require('../config/cloudinary');
const vault = require('../controllers/vaultController');

/**
 * Vault router — the board's secure store.
 *
 * TWO LOCKS, and the split between them is the point of this file:
 *
 *   authMiddleware  — who you are (the app session)
 *   vaultAuth       — the vault is open (somebody typed its password recently)
 *
 * `router.use(authMiddleware)` covers everything, so every route below has an
 * identified caller. `vaultAuth` is then applied PER ROUTE, because three of
 * them must work while the vault is still locked — you cannot ask for proof of a
 * password before showing the screen that asks for the password.
 *
 * The rule for adding a route here: if it can return or accept CIPHERTEXT, it
 * takes `vaultAuth`. If it only reports whether a vault exists, or is itself the
 * act of proving the password, it does not.
 */
const router = express.Router();

// Unlock is the guessable surface, so it gets a brake in front of the per-vault
// lockout in the controller. The two are complementary: this one follows the
// CALLER (keyed on the authenticated user, since authMiddleware has already
// run), the lockout follows the VAULT. An attacker with several accounts walks
// past the first and straight into the second.
const unlockLimit = rateLimit({
  bucket: 'vault:unlock',
  windowMs: 60_000,
  max: 5,
  message: 'Too many unlock attempts. Please wait a minute and try again.',
});
// Setup and rotation both write key material and both run scrypt. Neither is a
// guessing surface, but neither should be scriptable either.
const writeKeyLimit = rateLimit({
  bucket: 'vault:key',
  windowMs: 60_000,
  max: 10,
  message: 'Too many vault key changes. Please wait a minute and try again.',
});
const uploadLimit = rateLimit({
  bucket: 'vault:upload',
  windowMs: 60_000,
  max: 20,
  message: 'Too many uploads. Please wait a moment.',
});

router.use(authMiddleware);

// ---- Locked-vault surface (app session only) --------------------------------
// GET  meta      — does a vault exist, and with which KDF parameters
// POST /vault    — one-time setup
// POST /unlock   — verify the proof, mint the vault token
// POST /recover  — the same, against the one-time recovery key
router.get('/boards/:boardId/vault', vault.getVaultMeta);
router.post('/boards/:boardId/vault', writeKeyLimit, vault.createVault);
router.post('/boards/:boardId/vault/unlock', unlockLimit, vault.unlockVault);
router.post('/boards/:boardId/vault/recover', unlockLimit, vault.recoverVault);

// ---- Unlocked-vault surface (app session AND vault token) -------------------
router.get('/boards/:boardId/vault/items', vaultAuth, vault.getVaultItems);
router.post('/boards/:boardId/vault/items', vaultAuth, vault.createVaultItem);
router.post(
  '/boards/:boardId/vault/items/upload',
  vaultAuth,
  uploadLimit,
  vaultBlobUpload.single('file'),
  handleUploadError,
  vault.uploadVaultBlob
);
// Rotating the password needs the vault OPEN as well as the old proof — see the
// controller for why re-proving is not redundant.
router.post(
  '/boards/:boardId/vault/password',
  vaultAuth,
  writeKeyLimit,
  vault.changeVaultPassword
);

// The audit trail holds no ciphertext, so it answers to `vault.manage` alone —
// reviewing who opened the vault should not require opening it.
router.get('/boards/:boardId/vault/audit', vault.getVaultAudit);

// ---- Organisation escrow: the break-glass key -------------------------------
//
// Mounted here rather than in routes/orgs.js so every line of vault machinery
// lives in one place. `/api/orgs` is mounted first in app.js, but none of its
// routes match `/:id/vault-escrow`, so the request falls through to this router.
//
// Turning escrow ON for a vault needs the vault OPEN — the client has to produce
// the wrap and only VK can make one. Recovering THROUGH escrow does not: that is
// the whole point of a break-glass key, and its own passphrase is the gate.
router.get('/orgs/:orgId/vault-escrow', vault.getOrgEscrow);
router.post('/orgs/:orgId/vault-escrow', writeKeyLimit, vault.createOrgEscrow);
// Releasing the sealed private key is a guessable surface, so it shares the
// unlock bucket with the vault's own doors.
router.post('/orgs/:orgId/vault-escrow/unseal', unlockLimit, vault.unsealOrgEscrow);
router.post(
  '/orgs/:orgId/vault-escrow/passphrase',
  unlockLimit,
  vault.changeEscrowPassphrase
);
router.post('/boards/:boardId/vault/escrow', vaultAuth, vault.setVaultEscrow);
router.post(
  '/boards/:boardId/vault/escrow-recover',
  unlockLimit,
  vault.escrowRecoverVault
);

// Item routes carry no board in the URL. The controller re-derives the board
// from the item and re-checks the vault token against it; see loadItemContext.
router.patch('/vault/items/:id', vaultAuth, vault.updateVaultItem);
router.delete('/vault/items/:id', vaultAuth, vault.deleteVaultItem);

module.exports = router;
