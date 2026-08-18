const Vault = require('../models/Vault');
const VaultItem = require('../models/VaultItem');
const VaultAudit = require('../models/VaultAudit');
const VaultEscrow = require('../models/VaultEscrow');
const {
  loadBoardContext,
  loadOrgContext,
  requireCapability,
} = require('../utils/boardContext');
const {
  hashPassword,
  verifyPassword,
  verifyDummyPassword,
} = require('../utils/portalCrypto');
const { signVaultToken } = require('../middleware/vaultAuth');
const { cloudinary } = require('../config/cloudinary');

/**
 * Vault controller — the server half of the board vault.
 *
 * The unusual thing about this file is how little it does. It never decrypts,
 * never validates the SHAPE of an item (it cannot — the payload is opaque), and
 * has no way to answer "what is in this vault". It does exactly four things:
 *
 *   1. authorises the caller against the board (the same `loadBoardContext` +
 *      `requireCapability` idiom as every other controller),
 *   2. verifies a proof-of-password and mints a short-lived vault token,
 *      throttling and locking out guessers,
 *   3. stores and returns opaque blobs,
 *   4. records who did which of the above.
 *
 * Every route that touches CONTENT sits behind both `authMiddleware` and
 * `vaultAuth`, so reaching a ciphertext requires an app session AND a recent
 * unlock. See middleware/vaultAuth.js for why both.
 */

// Consecutive failures before the vault stops answering. Deliberately tighter
// than the portal's 5-then-15-minutes would be for a forgetful client: there is
// exactly one password per vault and everyone using it already knows it, so a
// run of wrong guesses is not a bad memory, it is someone trying passwords.
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

// One answer for every unlock failure. Distinguishing "no vault" from "wrong
// password" from "wrong recovery key" tells an attacker which door to keep
// knocking on.
const DENIED = 'That password is not right.';
const RECOVERY_DENIED = 'That recovery key is not right.';
const ESCROW_DENIED = 'That workspace recovery passphrase is not right.';

/**
 * Every 401 from this controller carries a code, and that is load-bearing on the
 * client rather than decoration.
 *
 * The browser's axios interceptor treats an uncoded 401 as "your session is
 * dead" and deletes the app token. On these routes a 401 means something else
 * entirely — a mistyped vault password, or a 15-minute unlock that lapsed — and
 * without a code to tell them apart, one wrong keystroke would sign the user out
 * of the entire application, and an idle vault would do it silently every
 * quarter of an hour.
 *
 * `VAULT_DENIED` — the secret was wrong.
 * `VAULT_LOCKED` — no unlock, or it expired (see middleware/vaultAuth.js).
 */
const denyUnlock = (res, error = DENIED) =>
  res.status(401).json({ code: 'VAULT_DENIED', error });

// A base64 blob is ~4/3 of its bytes; an item's JSON payload is text, and even a
// long doc lands far under this. It exists to stop one request eating the
// process, not to police content.
const MAX_CIPHERTEXT_CHARS = 4 * 1024 * 1024;

/** Best-effort request origin, matching rateLimit.js's view of the client. */
const clientIp = (req) => {
  const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.ip || req.socket?.remoteAddress || '';
};

/**
 * Append to the audit trail. Fire-and-forget on purpose — a failed audit write
 * must never turn a successful unlock into a 500. It is logged loudly instead,
 * because a silently empty audit trail is worse than a noisy one.
 */
const audit = (req, { vault, action, item = null, itemType = null }) => {
  VaultAudit.create({
    vault: vault._id,
    board: vault.board,
    actor: req.user.userId,
    action,
    item: item ? item._id || item : null,
    itemType,
    ip: clientIp(req),
  }).catch((err) => console.error('VaultAudit write failed:', action, err));
};

/**
 * Validate one AES-GCM payload arriving from the client. We cannot check that it
 * decrypts — that is the whole point — so we check only that it is the right
 * SHAPE and a sane size, and reject anything else rather than storing junk that
 * will fail to open months from now.
 */
const readSealed = (value, label) => {
  if (!value || typeof value !== 'object') return { error: `${label} is missing` };
  const { ciphertext, iv } = value;
  if (typeof ciphertext !== 'string' || !ciphertext) {
    return { error: `${label} is missing its ciphertext` };
  }
  if (typeof iv !== 'string' || !iv) return { error: `${label} is missing its IV` };
  if (ciphertext.length > MAX_CIPHERTEXT_CHARS) {
    return { error: `${label} is too large` };
  }
  return { value: { ciphertext, iv } };
};

/** Same, for the `{ algo, iterations, salt }` the client used. */
const readKdf = (value) => {
  if (!value || typeof value !== 'object') return { error: 'Missing KDF parameters' };
  const iterations = Number(value.iterations);
  const salt = value.salt;
  if (!Number.isFinite(iterations) || iterations < 100_000 || iterations > 5_000_000) {
    // A floor, not a preference. A client that derived with 1,000 iterations
    // would produce a vault that looks identical and is trivially crackable, and
    // nothing downstream would ever notice.
    return { error: 'KDF iterations out of range' };
  }
  if (typeof salt !== 'string' || salt.length < 16 || salt.length > 512) {
    return { error: 'Invalid KDF salt' };
  }
  const algo =
    typeof value.algo === 'string' && value.algo ? value.algo : 'PBKDF2-SHA256';
  return { value: { algo, iterations, salt } };
};

/**
 * Resolve board + vault + capability in one step, since every handler needs some
 * subset of it. Returns `{ status, error }` in the shape every caller already
 * checks.
 *
 * @param {Object} opts
 * @param {string} opts.capability      — 'vault.view' or 'vault.manage'
 * @param {boolean} [opts.requireVault] — 404 when the board has no vault yet
 * @param {boolean} [opts.withSecrets]  — also select proofHash/recoveryProofHash
 */
const loadVaultContext = async (
  req,
  boardId,
  { capability, requireVault = true, withSecrets = false }
) => {
  const ctx = await loadBoardContext(boardId, req.user.userId);
  if (ctx.error) return ctx;

  const denied = requireCapability(
    ctx,
    capability,
    "You do not have permission to use this board's vault"
  );
  if (denied) return denied;

  let query = Vault.findOne({ board: ctx.board._id });
  if (withSecrets) query = query.select('+proofHash +recoveryProofHash');
  const vault = await query;

  if (requireVault && !vault) {
    return { status: 404, error: 'This board has no vault yet' };
  }
  return { ctx, vault };
};

/**
 * The vault a content route is operating on, re-derived from `req.vault` (the
 * unlock token) rather than trusted from the URL.
 *
 * Both are checked and both must agree. The token names the vault it was minted
 * for; the URL names the board the caller claims to be in. Comparing them is
 * what stops an unlock token for one board being replayed against another
 * board's items.
 */
const requireUnlockedVault = (req, vault) => {
  if (!req.vault || String(req.vault.vaultId) !== String(vault._id)) {
    return { status: 401, code: 'VAULT_LOCKED', error: 'Vault is locked' };
  }
  return null;
};

/**
 * The escrow record for a board's org, or null. Loaded by ORG rather than by
 * board, because one escrow serves the whole workspace.
 */
const loadEscrow = (orgId, { withSecrets = false } = {}) => {
  let query = VaultEscrow.findOne({ organisation: orgId });
  if (withSecrets) query = query.select('+proofHash');
  return query;
};

/**
 * Everything a client needs to know about escrow for ONE vault, folded into the
 * vault's own metadata so the lock screen makes a single call.
 *
 * `publicKey` is returned in the clear on purpose — sealing a vault key to the
 * org needs only the public half, and that is precisely what lets a board owner
 * turn escrow on without being handed the ability to open it. See
 * models/VaultEscrow.js.
 */
const escrowMetaFor = (escrow, vault) => {
  if (!escrow) return { orgHasEscrow: false, enabled: false };
  const wrap = vault?.escrow?.wrap || null;
  // A wrap sealed to an escrow record the org has since replaced cannot be
  // opened by the current private key. Say so rather than offering a door that
  // does not lead anywhere.
  const stale = !!wrap && String(vault.escrow.escrow || '') !== String(escrow._id);
  return {
    orgHasEscrow: true,
    enabled: !!wrap && !stale,
    stale,
    publicKey: escrow.publicKey,
    kdf: {
      algo: escrow.kdf.algo,
      iterations: escrow.kdf.iterations,
      salt: escrow.kdf.salt,
    },
  };
};

// ---------------------------------------------------------------------------
// Meta + setup
// ---------------------------------------------------------------------------

/**
 * GET /api/boards/:boardId/vault
 *
 * What the lock screen needs before anyone has typed anything: does a vault
 * exist, and with which public KDF parameters.
 *
 * It returns the SALT but not `wrappedVK`. A salt is not a secret — it exists to
 * make precomputed tables useless and allows nothing on its own. `wrappedVK` is
 * attackable offline, so it is withheld until the unlock proof lands. That is
 * why unlock returns it and this does not.
 */
const getVaultMeta = async (req, res) => {
  try {
    const loaded = await loadVaultContext(req, req.params.boardId, {
      capability: 'vault.view',
      requireVault: false,
    });
    if (loaded.error) return res.status(loaded.status).json({ error: loaded.error });

    const { ctx, vault } = loaded;
    const canManage = ctx.can('vault.manage');

    // Reported even when no vault exists yet, so the setup screen can offer the
    // "cover this with the workspace recovery key" choice at creation time —
    // which is the only moment it costs nothing.
    const escrow = await loadEscrow(ctx.board.organisation);

    if (!vault) {
      return res.json({ exists: false, canManage, escrow: escrowMetaFor(escrow, null) });
    }

    const lockedFor =
      vault.lockedUntil && vault.lockedUntil.getTime() > Date.now()
        ? Math.ceil((vault.lockedUntil.getTime() - Date.now()) / 1000)
        : 0;

    return res.json({
      exists: true,
      canManage,
      kdf: {
        algo: vault.kdf.algo,
        iterations: vault.kdf.iterations,
        salt: vault.kdf.salt,
      },
      // Enough to offer "use my recovery key" and to run the derivation, never
      // the wrap itself.
      hasRecovery: !!vault.recoveryWrap,
      recoveryKdf: vault.recoveryWrap
        ? {
            algo: vault.recoveryKdf?.algo || 'PBKDF2-SHA256',
            iterations: vault.recoveryKdf?.iterations,
            salt: vault.recoveryKdf?.salt,
          }
        : null,
      escrow: escrowMetaFor(escrow, vault),
      lockedFor,
      createdAt: vault.createdAt,
      passwordChangedAt: vault.passwordChangedAt,
    });
  } catch (err) {
    console.error('getVaultMeta error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/boards/:boardId/vault — one-time setup.
 *
 * Everything in the body was produced in the browser. The server's entire
 * contribution is to hash the proof and refuse to overwrite an existing vault:
 * a second POST would replace `wrappedVK` and orphan every item on the board
 * forever, so it is a conflict, not an update. Rotating the password is
 * `changeVaultPassword` below, which keeps VK.
 */
const createVault = async (req, res) => {
  try {
    const loaded = await loadVaultContext(req, req.params.boardId, {
      capability: 'vault.manage',
      requireVault: false,
    });
    if (loaded.error) return res.status(loaded.status).json({ error: loaded.error });

    const { ctx, vault: existing } = loaded;
    if (existing) {
      return res.status(409).json({ error: 'This board already has a vault' });
    }

    const {
      kdf,
      wrappedVK,
      proof,
      recoveryWrap,
      recoveryKdf,
      recoveryProof,
      escrowWrap,
    } = req.body || {};

    const kdfRead = readKdf(kdf);
    if (kdfRead.error) return res.status(400).json({ error: kdfRead.error });

    const wrapRead = readSealed(wrappedVK, 'Wrapped vault key');
    if (wrapRead.error) return res.status(400).json({ error: wrapRead.error });

    if (typeof proof !== 'string' || proof.length < 16) {
      return res.status(400).json({ error: 'Missing authentication proof' });
    }

    const doc = {
      board: ctx.board._id,
      kdf: kdfRead.value,
      wrappedVK: wrapRead.value,
      proofHash: await hashPassword(proof),
      createdBy: req.user.userId,
    };

    // The recovery key is optional, but partially-supplied recovery material is
    // not: a wrap with no proof would produce a recovery path that can never be
    // used, discovered only on the day it is needed.
    if (recoveryWrap || recoveryProof || recoveryKdf) {
      const recWrap = readSealed(recoveryWrap, 'Recovery wrap');
      if (recWrap.error) return res.status(400).json({ error: recWrap.error });
      const recKdf = readKdf(recoveryKdf);
      if (recKdf.error) return res.status(400).json({ error: recKdf.error });
      if (typeof recoveryProof !== 'string' || recoveryProof.length < 16) {
        return res.status(400).json({ error: 'Missing recovery proof' });
      }
      doc.recoveryWrap = recWrap.value;
      doc.recoveryKdf = recKdf.value;
      doc.recoveryProofHash = await hashPassword(recoveryProof);
    }

    // Escrow at creation. Only the org's PUBLIC key was needed to produce this,
    // so the person setting up the vault has covered it with the workspace
    // break-glass key without being able to open that key themselves.
    if (escrowWrap) {
      const escrow = await loadEscrow(ctx.board.organisation);
      if (!escrow) {
        return res.status(404).json({ error: 'This workspace has no recovery key' });
      }
      if (typeof escrowWrap !== 'string' || escrowWrap.length > MAX_CIPHERTEXT_CHARS) {
        return res.status(400).json({ error: 'Invalid escrow wrap' });
      }
      doc.escrow = {
        wrap: escrowWrap,
        escrow: escrow._id,
        addedAt: new Date(),
        addedBy: req.user.userId,
      };
    }

    const vault = await Vault.create(doc);
    audit(req, { vault, action: 'vault.created' });
    if (doc.escrow) audit(req, { vault, action: 'vault.escrow_added' });

    // Setup is also an unlock — the browser already holds VK, and making someone
    // immediately retype the password they just chose would be theatre.
    return res.status(201).json({
      vaultToken: signVaultToken(vault, req.user.userId),
      wrappedVK: vault.wrappedVK,
      kdf: vault.kdf,
    });
  } catch (err) {
    // The unique index on `board` is the real guard against two setups racing;
    // the check above only makes the common case a clean 409.
    if (err?.code === 11000) {
      return res.status(409).json({ error: 'This board already has a vault' });
    }
    console.error('createVault error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

// ---------------------------------------------------------------------------
// Unlock
// ---------------------------------------------------------------------------

/**
 * Shared tail of both unlock paths: count the failure, lock the vault out once
 * they pile up, and leave the caller with the one indistinguishable message.
 */
const registerFailure = async (req, vault, action) => {
  vault.failedAttempts = (vault.failedAttempts || 0) + 1;
  let lockedOut = false;
  if (vault.failedAttempts >= MAX_FAILED_ATTEMPTS) {
    vault.lockedUntil = new Date(Date.now() + LOCKOUT_MS);
    vault.failedAttempts = 0;
    lockedOut = true;
  }
  await vault.save();
  audit(req, { vault, action });
  if (lockedOut) audit(req, { vault, action: 'vault.locked_out' });
};

/**
 * The same brake, following the ESCROW record rather than a vault.
 *
 * Separate from `registerFailure` because escrow guessing is not about one
 * vault: the passphrase opens every escrowed vault in the workspace, so the
 * count has to live with the passphrase. Attempts made against three different
 * boards are three attempts on the same secret, and this is what makes them add
 * up instead of resetting.
 */
const registerEscrowFailure = async (escrow) => {
  escrow.failedAttempts = (escrow.failedAttempts || 0) + 1;
  if (escrow.failedAttempts >= MAX_FAILED_ATTEMPTS) {
    escrow.lockedUntil = new Date(Date.now() + LOCKOUT_MS);
    escrow.failedAttempts = 0;
  }
  await escrow.save();
};

/**
 * The lockout check every proof path runs first. Returns a response or null.
 * Takes any record carrying `lockedUntil` — a Vault or a VaultEscrow.
 */
const lockoutResponse = (vault, res) => {
  if (vault.lockedUntil && vault.lockedUntil.getTime() > Date.now()) {
    const mins = Math.max(
      1,
      Math.ceil((vault.lockedUntil.getTime() - Date.now()) / 60_000)
    );
    return res.status(429).json({
      code: 'VAULT_LOCKED_OUT',
      error: `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`,
    });
  }
  return null;
};

/**
 * POST /api/boards/:boardId/vault/unlock
 *
 * The client derived two independent values from the password; this verifies the
 * one it was willing to send. A cracked `proofHash` yields the auth proof, which
 * opens this endpoint but decrypts nothing — the encryption key is the other
 * HKDF branch and was never transmitted.
 *
 * Rate-limited at the route, locked out per-vault here. Both matter: the route
 * limiter follows the caller, the lockout follows the vault, and an attacker
 * with several accounts only sidesteps the first.
 */
const unlockVault = async (req, res) => {
  try {
    const loaded = await loadVaultContext(req, req.params.boardId, {
      capability: 'vault.view',
      withSecrets: true,
    });
    if (loaded.error) return res.status(loaded.status).json({ error: loaded.error });

    const { vault } = loaded;
    const locked = lockoutResponse(vault, res);
    if (locked) return locked;

    const { proof } = req.body || {};
    if (typeof proof !== 'string' || !proof) {
      // Burn the same time a real check would. Otherwise "no proof" returns in
      // microseconds while "wrong proof" spends ~100ms in scrypt, which is a
      // usable oracle even though the answer text is identical.
      await verifyDummyPassword('');
      return denyUnlock(res);
    }

    const ok = await verifyPassword(proof, vault.proofHash);
    if (!ok) {
      await registerFailure(req, vault, 'vault.unlock_failed');
      return denyUnlock(res);
    }

    vault.failedAttempts = 0;
    vault.lockedUntil = null;
    await vault.save();
    audit(req, { vault, action: 'vault.unlocked' });

    return res.json({
      vaultToken: signVaultToken(vault, req.user.userId),
      // Released only now, against proof. See getVaultMeta for why.
      wrappedVK: vault.wrappedVK,
      canManage: loaded.ctx.can('vault.manage'),
    });
  } catch (err) {
    console.error('unlockVault error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/boards/:boardId/vault/recover — the one escape hatch.
 *
 * Identical in shape to `unlockVault`, against the recovery key's own proof, and
 * it returns `recoveryWrap` instead of `wrappedVK`. The client unwraps VK with
 * the recovery key and is then expected to set a new password immediately —
 * which is `changeVaultPassword`, not a special case here.
 *
 * Failures count toward the SAME lockout counter as password attempts, so
 * switching between the two doors does not double an attacker's budget.
 */
const recoverVault = async (req, res) => {
  try {
    const loaded = await loadVaultContext(req, req.params.boardId, {
      capability: 'vault.manage',
      withSecrets: true,
    });
    if (loaded.error) return res.status(loaded.status).json({ error: loaded.error });

    const { vault } = loaded;
    if (!vault.recoveryWrap || !vault.recoveryProofHash) {
      return res
        .status(404)
        .json({ error: 'This vault has no recovery key. There is no way back in.' });
    }

    const locked = lockoutResponse(vault, res);
    if (locked) return locked;

    const { proof } = req.body || {};
    if (typeof proof !== 'string' || !proof) {
      await verifyDummyPassword('');
      return denyUnlock(res, RECOVERY_DENIED);
    }

    const ok = await verifyPassword(proof, vault.recoveryProofHash);
    if (!ok) {
      await registerFailure(req, vault, 'vault.unlock_failed');
      return denyUnlock(res, RECOVERY_DENIED);
    }

    vault.failedAttempts = 0;
    vault.lockedUntil = null;
    await vault.save();
    audit(req, { vault, action: 'vault.recovery_used' });

    return res.json({
      vaultToken: signVaultToken(vault, req.user.userId),
      recoveryWrap: vault.recoveryWrap,
      canManage: true,
    });
  } catch (err) {
    console.error('recoverVault error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/boards/:boardId/vault/password — rotate the vault password.
 *
 * The offboarding path: someone left, so the shared password changes. Note what
 * does NOT happen — no item is touched. Items are encrypted with VK, and VK is
 * merely re-wrapped under a key derived from the new password. That indirection
 * is why this is one small write instead of re-encrypting a vault full of files,
 * and why it cannot half-fail and leave items unreadable.
 *
 * Requires the vault to be currently unlocked AND the old proof to be presented
 * again. The second is not redundant: an unlock token lives 15 minutes and an
 * unattended laptop is exactly the threat here.
 *
 * `recoveryWrap` is untouched by default because VK has not changed — the old
 * recovery key still opens the vault, which is what you want when the password
 * was rotated for hygiene, and NOT what you want if the recovery key itself
 * leaked. Passing new recovery material replaces it.
 */
const changeVaultPassword = async (req, res) => {
  try {
    const loaded = await loadVaultContext(req, req.params.boardId, {
      capability: 'vault.manage',
      withSecrets: true,
    });
    if (loaded.error) return res.status(loaded.status).json({ error: loaded.error });

    const { vault } = loaded;
    const stale = requireUnlockedVault(req, vault);
    if (stale) {
      return res.status(stale.status).json({ code: stale.code, error: stale.error });
    }

    const locked = lockoutResponse(vault, res);
    if (locked) return locked;

    const {
      currentProof,
      kdf,
      wrappedVK,
      proof,
      recoveryWrap,
      recoveryKdf,
      recoveryProof,
    } = req.body || {};

    if (typeof currentProof !== 'string' || !currentProof) {
      await verifyDummyPassword('');
      return denyUnlock(res);
    }

    // A recovery-key or escrow unlock leaves the caller holding VK but NOT the
    // old password, so re-proving the password would make both useless — you
    // could open the vault and never be able to set a password again. Whichever
    // door was actually used is accepted in its place, and only here.
    //
    // The order is deliberate: the password first, so the ordinary case costs
    // one scrypt rather than three.
    let ok = await verifyPassword(currentProof, vault.proofHash);
    if (!ok && vault.recoveryProofHash) {
      ok = await verifyPassword(currentProof, vault.recoveryProofHash);
    }
    if (!ok && vault.escrow?.wrap) {
      const escrow = await loadEscrow(loaded.ctx.board.organisation, {
        withSecrets: true,
      });
      if (escrow && String(vault.escrow.escrow || '') === String(escrow._id)) {
        ok = await verifyPassword(currentProof, escrow.proofHash);
      }
    }
    if (!ok) {
      await registerFailure(req, vault, 'vault.unlock_failed');
      return denyUnlock(res);
    }

    const kdfRead = readKdf(kdf);
    if (kdfRead.error) return res.status(400).json({ error: kdfRead.error });
    const wrapRead = readSealed(wrappedVK, 'Wrapped vault key');
    if (wrapRead.error) return res.status(400).json({ error: wrapRead.error });
    if (typeof proof !== 'string' || proof.length < 16) {
      return res.status(400).json({ error: 'Missing authentication proof' });
    }

    vault.kdf = kdfRead.value;
    vault.wrappedVK = wrapRead.value;
    vault.proofHash = await hashPassword(proof);
    vault.failedAttempts = 0;
    vault.lockedUntil = null;
    vault.passwordChangedAt = new Date();
    vault.passwordChangedBy = req.user.userId;

    if (recoveryWrap || recoveryProof || recoveryKdf) {
      const recWrap = readSealed(recoveryWrap, 'Recovery wrap');
      if (recWrap.error) return res.status(400).json({ error: recWrap.error });
      const recKdf = readKdf(recoveryKdf);
      if (recKdf.error) return res.status(400).json({ error: recKdf.error });
      if (typeof recoveryProof !== 'string' || recoveryProof.length < 16) {
        return res.status(400).json({ error: 'Missing recovery proof' });
      }
      vault.recoveryWrap = recWrap.value;
      vault.recoveryKdf = recKdf.value;
      vault.recoveryProofHash = await hashPassword(recoveryProof);
    }

    await vault.save();
    audit(req, { vault, action: 'vault.password_changed' });

    // The old token still verifies (same vault, same user, not yet expired), but
    // handing back a fresh one keeps the client's lifecycle simple: one response
    // shape for "you are unlocked", whichever door you came through.
    return res.json({
      vaultToken: signVaultToken(vault, req.user.userId),
      wrappedVK: vault.wrappedVK,
      hasRecovery: !!vault.recoveryWrap,
    });
  } catch (err) {
    console.error('changeVaultPassword error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

/** The wire shape of an item. Ciphertext plus who-and-when; never a title. */
const POPULATE = [
  { path: 'createdBy', select: 'name profilePic email' },
  { path: 'lastEditedBy', select: 'name profilePic email' },
];

/**
 * GET /api/boards/:boardId/vault/items — every ciphertext in the vault.
 *
 * The whole list in one response, deliberately. Titles are encrypted, so the
 * server cannot sort, filter or paginate by anything a human recognises — the
 * client has to decrypt the set to show it at all. A vault holds tens of items,
 * not thousands.
 */
const getVaultItems = async (req, res) => {
  try {
    const loaded = await loadVaultContext(req, req.params.boardId, {
      capability: 'vault.view',
    });
    if (loaded.error) return res.status(loaded.status).json({ error: loaded.error });

    const { ctx, vault } = loaded;
    const stale = requireUnlockedVault(req, vault);
    if (stale) {
      return res.status(stale.status).json({ code: stale.code, error: stale.error });
    }

    const items = await VaultItem.find({ vault: vault._id })
      .populate(POPULATE)
      .sort({ updatedAt: -1 });

    return res.json({ items, canManage: ctx.can('vault.manage') });
  } catch (err) {
    console.error('getVaultItems error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/boards/:boardId/vault/items — store one opaque blob.
 *
 * `type` is the only field the server understands, and only well enough to know
 * which decoder the client should run. It cannot validate the payload, so it
 * does not pretend to.
 */
const createVaultItem = async (req, res) => {
  try {
    const loaded = await loadVaultContext(req, req.params.boardId, {
      capability: 'vault.manage',
    });
    if (loaded.error) return res.status(loaded.status).json({ error: loaded.error });

    const { vault } = loaded;
    const stale = requireUnlockedVault(req, vault);
    if (stale) {
      return res.status(stale.status).json({ code: stale.code, error: stale.error });
    }

    const { type, ciphertext, iv, file } = req.body || {};
    if (!VaultItem.ITEM_TYPES.includes(type)) {
      return res.status(400).json({ error: 'Unknown vault item type' });
    }
    const sealed = readSealed({ ciphertext, iv }, 'Item');
    if (sealed.error) return res.status(400).json({ error: sealed.error });

    const doc = {
      vault: vault._id,
      board: vault.board,
      type,
      ciphertext: sealed.value.ciphertext,
      iv: sealed.value.iv,
      createdBy: req.user.userId,
    };

    if (type === 'file') {
      // The blob was uploaded first (see uploadVaultBlob) and its handle passed
      // back here. Two steps rather than one multipart request because the item
      // payload is JSON that the upload middleware would have to parse around.
      if (!file || typeof file.url !== 'string' || !file.url) {
        return res.status(400).json({ error: 'File items need an uploaded blob' });
      }
      doc.file = {
        url: file.url,
        publicId: typeof file.publicId === 'string' ? file.publicId : null,
        size: Number(file.size) || 0,
      };
    }

    const item = await VaultItem.create(doc);
    await item.populate(POPULATE);
    audit(req, { vault, action: 'item.created', item, itemType: item.type });

    return res.status(201).json({ item });
  } catch (err) {
    console.error('createVaultItem error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Load an item and re-authorise from the item's OWN board, then confirm the
 * unlock token was minted for that same vault. `/api/vault/items/:id` carries no
 * board in the URL, so this is the only thing standing between a valid unlock on
 * one board and an item id belonging to another.
 */
const loadItemContext = async (req, capability) => {
  const item = await VaultItem.findById(req.params.id);
  if (!item) return { status: 404, error: 'Item not found' };

  const ctx = await loadBoardContext(item.board, req.user.userId);
  if (ctx.error) return ctx;

  const denied = requireCapability(
    ctx,
    capability,
    "You do not have permission to change this board's vault"
  );
  if (denied) return denied;

  const vault = await Vault.findById(item.vault);
  if (!vault) return { status: 404, error: 'Item not found' };

  const stale = requireUnlockedVault(req, vault);
  if (stale) return stale;

  return { item, vault, ctx };
};

/**
 * PATCH /api/vault/items/:id — replace the ciphertext.
 *
 * Always a full replacement, never a merge: the server holds one opaque blob and
 * has no way to patch a field inside it. The client decrypts, edits, re-encrypts
 * with a FRESH IV, and sends the whole thing back.
 */
const updateVaultItem = async (req, res) => {
  try {
    const loaded = await loadItemContext(req, 'vault.manage');
    if (loaded.error) {
      return res.status(loaded.status).json({ code: loaded.code, error: loaded.error });
    }

    const { item, vault } = loaded;
    const { ciphertext, iv } = req.body || {};
    const sealed = readSealed({ ciphertext, iv }, 'Item');
    if (sealed.error) return res.status(400).json({ error: sealed.error });

    item.ciphertext = sealed.value.ciphertext;
    item.iv = sealed.value.iv;
    item.lastEditedBy = req.user.userId;
    await item.save();
    await item.populate(POPULATE);
    audit(req, { vault, action: 'item.updated', item, itemType: item.type });

    return res.json({ item });
  } catch (err) {
    console.error('updateVaultItem error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * DELETE /api/vault/items/:id — remove the row and, for a file, the blob.
 *
 * The Cloudinary destroy is best-effort and deliberately does not block the
 * delete: a leftover blob is 32 hex characters of undecryptable bytes, whereas
 * refusing to delete the row because a third party is down leaves someone unable
 * to remove their own secret.
 */
const deleteVaultItem = async (req, res) => {
  try {
    const loaded = await loadItemContext(req, 'vault.manage');
    if (loaded.error) {
      return res.status(loaded.status).json({ code: loaded.code, error: loaded.error });
    }

    const { item, vault } = loaded;
    if (item.type === 'file' && item.file?.publicId) {
      cloudinary.uploader
        .destroy(item.file.publicId, { resource_type: 'raw' })
        .catch((err) => console.error('Vault blob destroy failed:', err));
    }

    await VaultItem.deleteOne({ _id: item._id });
    audit(req, { vault, action: 'item.deleted', item, itemType: item.type });

    return res.json({ ok: true });
  } catch (err) {
    console.error('deleteVaultItem error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/boards/:boardId/vault/items/upload — receive one encrypted blob.
 *
 * Multer has already streamed it to Cloudinary as `raw` under a random name by
 * the time this runs (see config/cloudinary.js `vaultBlobUpload`), so all that is
 * left is to hand back the handle the client will seal into the item payload.
 *
 * What arrives is ciphertext produced in the browser. This process never sees the
 * plaintext, and neither does Cloudinary.
 */
const uploadVaultBlob = async (req, res) => {
  try {
    const loaded = await loadVaultContext(req, req.params.boardId, {
      capability: 'vault.manage',
    });
    if (loaded.error) return res.status(loaded.status).json({ error: loaded.error });

    const { vault } = loaded;
    const stale = requireUnlockedVault(req, vault);
    if (stale) {
      return res.status(stale.status).json({ code: stale.code, error: stale.error });
    }

    if (!req.file) return res.status(400).json({ error: 'No file received' });

    audit(req, { vault, action: 'item.file_uploaded', itemType: 'file' });

    return res.status(201).json({
      file: {
        url: req.file.path,
        publicId: req.file.filename,
        size: req.file.size || 0,
      },
    });
  } catch (err) {
    console.error('uploadVaultBlob error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * GET /api/boards/:boardId/vault/audit — the trail.
 *
 * Requires `vault.manage` rather than `vault.view`: who opened the vault and
 * when is a management question. It is also the one vault surface readable
 * WITHOUT the password, which is safe precisely because there is nothing
 * encrypted in it to read — see VaultAudit.js for why it has nowhere to put a
 * secret.
 */
const getVaultAudit = async (req, res) => {
  try {
    const loaded = await loadVaultContext(req, req.params.boardId, {
      capability: 'vault.manage',
    });
    if (loaded.error) return res.status(loaded.status).json({ error: loaded.error });

    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const entries = await VaultAudit.find({ vault: loaded.vault._id })
      .populate({ path: 'actor', select: 'name profilePic email' })
      .sort({ createdAt: -1 })
      .limit(limit);

    return res.json({ entries });
  } catch (err) {
    console.error('getVaultAudit error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

// ---------------------------------------------------------------------------
// Organisation escrow — the break-glass key
// ---------------------------------------------------------------------------

/**
 * GET /api/orgs/:orgId/vault-escrow — does this workspace have a break-glass key.
 *
 * Readable by any member. What it discloses is the public key and a salt, which
 * is the same disclosure `getVaultMeta` makes and for the same reason: neither
 * allows anything on its own, and both are needed before anyone can type
 * anything.
 */
const getOrgEscrow = async (req, res) => {
  try {
    const ctx = await loadOrgContext(req.params.orgId, req.user.userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

    const escrow = await loadEscrow(ctx.org._id);
    const canManage = ctx.can('org.manage_settings');

    if (!escrow) return res.json({ exists: false, canManage });

    const vaultsCovered = await Vault.countDocuments({
      'escrow.escrow': escrow._id,
    });

    return res.json({
      exists: true,
      canManage,
      publicKey: escrow.publicKey,
      kdf: {
        algo: escrow.kdf.algo,
        iterations: escrow.kdf.iterations,
        salt: escrow.kdf.salt,
      },
      vaultsCovered,
      createdAt: escrow.createdAt,
      passphraseChangedAt: escrow.passphraseChangedAt,
    });
  } catch (err) {
    console.error('getOrgEscrow error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/orgs/:orgId/vault-escrow — create the break-glass key. Once.
 *
 * Everything arrives from the browser: a fresh RSA keypair whose private half
 * is already sealed under the chosen passphrase, plus the auth proof. This
 * process never sees the passphrase or the private key.
 *
 * Replacing an existing escrow is refused rather than allowed, because every
 * vault already sealed to the old public key would keep a wrap nothing can open
 * — a silent failure discovered on the one day escrow matters. Changing the
 * PASSPHRASE (below) keeps the keypair and so keeps every wrap working.
 */
const createOrgEscrow = async (req, res) => {
  try {
    const ctx = await loadOrgContext(req.params.orgId, req.user.userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    if (!ctx.can('org.manage_settings')) {
      return res
        .status(403)
        .json({ error: 'You do not have permission to manage workspace settings' });
    }

    const existing = await loadEscrow(ctx.org._id);
    if (existing) {
      return res
        .status(409)
        .json({ error: 'This workspace already has a recovery key' });
    }

    const { publicKey, kdf, wrappedPrivateKey, proof } = req.body || {};
    if (typeof publicKey !== 'string' || publicKey.length < 100) {
      return res.status(400).json({ error: 'Missing or invalid public key' });
    }
    const kdfRead = readKdf(kdf);
    if (kdfRead.error) return res.status(400).json({ error: kdfRead.error });
    const wrapRead = readSealed(wrappedPrivateKey, 'Wrapped private key');
    if (wrapRead.error) return res.status(400).json({ error: wrapRead.error });
    if (typeof proof !== 'string' || proof.length < 16) {
      return res.status(400).json({ error: 'Missing authentication proof' });
    }

    const escrow = await VaultEscrow.create({
      organisation: ctx.org._id,
      publicKey,
      kdf: kdfRead.value,
      wrappedPrivateKey: wrapRead.value,
      proofHash: await hashPassword(proof),
      createdBy: req.user.userId,
    });

    return res.status(201).json({
      exists: true,
      publicKey: escrow.publicKey,
      kdf: escrow.kdf,
      vaultsCovered: 0,
    });
  } catch (err) {
    if (err?.code === 11000) {
      return res
        .status(409)
        .json({ error: 'This workspace already has a recovery key' });
    }
    console.error('createOrgEscrow error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/orgs/:orgId/vault-escrow/unseal — hand back the sealed private key,
 * against proof of the passphrase.
 *
 * Its own endpoint rather than a field on the GET, for exactly the reason
 * `getVaultMeta` withholds `wrappedVK`: the wrapped private key is offline-
 * attackable, so an attacker who can merely READ it gets unthrottled guesses
 * forever. Releasing it only against a verified proof keeps every attempt on
 * this side of the wire, where the rate limiter and the lockout can see it.
 *
 * Rotation needs this because re-sealing the key requires first opening it, and
 * only the browser can do that — so it is inherently two round trips.
 */
const unsealOrgEscrow = async (req, res) => {
  try {
    const ctx = await loadOrgContext(req.params.orgId, req.user.userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    if (!ctx.can('org.manage_settings')) {
      return res
        .status(403)
        .json({ error: 'You do not have permission to manage workspace settings' });
    }

    const escrow = await loadEscrow(ctx.org._id, { withSecrets: true });
    if (!escrow) {
      return res.status(404).json({ error: 'This workspace has no recovery key' });
    }

    const locked = lockoutResponse(escrow, res);
    if (locked) return locked;

    const { proof } = req.body || {};
    if (typeof proof !== 'string' || !proof) {
      await verifyDummyPassword('');
      return denyUnlock(res, ESCROW_DENIED);
    }

    const ok = await verifyPassword(proof, escrow.proofHash);
    if (!ok) {
      await registerEscrowFailure(escrow);
      return denyUnlock(res, ESCROW_DENIED);
    }

    escrow.failedAttempts = 0;
    escrow.lockedUntil = null;
    await escrow.save();

    return res.json({
      wrappedPrivateKey: escrow.wrappedPrivateKey,
      kdf: escrow.kdf,
    });
  } catch (err) {
    console.error('unsealOrgEscrow error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/orgs/:orgId/vault-escrow/passphrase — rotate the escrow passphrase.
 *
 * Re-seals the SAME private key under a new passphrase, which is why every vault
 * already escrowed keeps working: the keypair never changes, only the lock on
 * it. Exactly the relationship VK has to a vault password.
 */
const changeEscrowPassphrase = async (req, res) => {
  try {
    const ctx = await loadOrgContext(req.params.orgId, req.user.userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    if (!ctx.can('org.manage_settings')) {
      return res
        .status(403)
        .json({ error: 'You do not have permission to manage workspace settings' });
    }

    const escrow = await loadEscrow(ctx.org._id, { withSecrets: true });
    if (!escrow) {
      return res.status(404).json({ error: 'This workspace has no recovery key' });
    }

    const locked = lockoutResponse(escrow, res);
    if (locked) return locked;

    const { currentProof, kdf, wrappedPrivateKey, proof } = req.body || {};
    if (typeof currentProof !== 'string' || !currentProof) {
      await verifyDummyPassword('');
      return denyUnlock(res, ESCROW_DENIED);
    }

    const ok = await verifyPassword(currentProof, escrow.proofHash);
    if (!ok) {
      await registerEscrowFailure(escrow);
      return denyUnlock(res, ESCROW_DENIED);
    }

    const kdfRead = readKdf(kdf);
    if (kdfRead.error) return res.status(400).json({ error: kdfRead.error });
    const wrapRead = readSealed(wrappedPrivateKey, 'Wrapped private key');
    if (wrapRead.error) return res.status(400).json({ error: wrapRead.error });
    if (typeof proof !== 'string' || proof.length < 16) {
      return res.status(400).json({ error: 'Missing authentication proof' });
    }

    escrow.kdf = kdfRead.value;
    escrow.wrappedPrivateKey = wrapRead.value;
    escrow.proofHash = await hashPassword(proof);
    escrow.failedAttempts = 0;
    escrow.lockedUntil = null;
    escrow.passphraseChangedAt = new Date();
    escrow.passphraseChangedBy = req.user.userId;
    await escrow.save();

    return res.json({ ok: true, kdf: escrow.kdf });
  } catch (err) {
    console.error('changeEscrowPassphrase error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/boards/:boardId/vault/escrow — turn escrow on or off for one vault.
 *
 * Turning it ON requires the vault to be UNLOCKED and the wrap to be supplied by
 * the client, which is the only party that can produce it: it holds VK, and the
 * org public key is public. The server cannot construct this wrap itself, and
 * that is the property that makes escrow safe to offer to every board owner.
 *
 * Turning it OFF just clears the wrap. It is deliberately not gated on the
 * escrow passphrase — a board's own administrators may always decline the
 * workspace's break-glass key for their vault, and needing the org's permission
 * to opt OUT would make "opt in" meaningless.
 */
const setVaultEscrow = async (req, res) => {
  try {
    const loaded = await loadVaultContext(req, req.params.boardId, {
      capability: 'vault.manage',
    });
    if (loaded.error) return res.status(loaded.status).json({ error: loaded.error });

    const { ctx, vault } = loaded;
    const stale = requireUnlockedVault(req, vault);
    if (stale) {
      return res.status(stale.status).json({ code: stale.code, error: stale.error });
    }

    const { enabled, wrap } = req.body || {};

    if (!enabled) {
      vault.escrow = { wrap: null, escrow: null, addedAt: null, addedBy: null };
      await vault.save();
      audit(req, { vault, action: 'vault.escrow_removed' });
      return res.json({ enabled: false });
    }

    const escrow = await loadEscrow(ctx.board.organisation);
    if (!escrow) {
      return res.status(404).json({ error: 'This workspace has no recovery key' });
    }
    if (typeof wrap !== 'string' || !wrap || wrap.length > MAX_CIPHERTEXT_CHARS) {
      return res.status(400).json({ error: 'Missing or invalid escrow wrap' });
    }

    vault.escrow = {
      wrap,
      escrow: escrow._id,
      addedAt: new Date(),
      addedBy: req.user.userId,
    };
    await vault.save();
    audit(req, { vault, action: 'vault.escrow_added' });

    return res.json({ enabled: true });
  } catch (err) {
    console.error('setVaultEscrow error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/boards/:boardId/vault/escrow-recover — open a vault with the
 * workspace's break-glass key.
 *
 * TWO THINGS ARE REQUIRED and neither is sufficient alone: `vault.manage` on
 * this board — the same gate the ordinary recovery key answers to — and the
 * escrow passphrase. The capability says you are entitled to administer this
 * vault; the passphrase says the workspace authorised the break-glass.
 *
 * Note what is NOT done here: no bypass of board access. An org admin who cannot
 * open the board cannot escrow-recover its vault either. The fix for that is a
 * board-access grant through the normal, visible machinery — not a second,
 * quieter path into private boards.
 *
 * Returns the sealed private key alongside the vault's wrap. Both are useless
 * without the passphrase the caller just proved they know, and handing them over
 * together is what lets the browser do the decryption we cannot.
 */
const escrowRecoverVault = async (req, res) => {
  try {
    const loaded = await loadVaultContext(req, req.params.boardId, {
      capability: 'vault.manage',
    });
    if (loaded.error) return res.status(loaded.status).json({ error: loaded.error });

    const { ctx, vault } = loaded;

    const escrow = await loadEscrow(ctx.board.organisation, { withSecrets: true });
    if (!escrow) {
      return res.status(404).json({ error: 'This workspace has no recovery key' });
    }
    if (!vault.escrow?.wrap) {
      return res
        .status(404)
        .json({ error: 'This vault was not covered by the workspace recovery key' });
    }
    if (String(vault.escrow.escrow || '') !== String(escrow._id)) {
      // Sealed to a keypair the workspace no longer has. Saying so beats a
      // decryption failure the user cannot interpret.
      return res.status(409).json({
        error:
          'This vault was sealed to an older workspace recovery key, which no longer exists.',
      });
    }

    const locked = lockoutResponse(escrow, res);
    if (locked) return locked;

    const { proof } = req.body || {};
    if (typeof proof !== 'string' || !proof) {
      await verifyDummyPassword('');
      return denyUnlock(res, ESCROW_DENIED);
    }

    const ok = await verifyPassword(proof, escrow.proofHash);
    if (!ok) {
      await registerEscrowFailure(escrow);
      audit(req, { vault, action: 'vault.unlock_failed' });
      return denyUnlock(res, ESCROW_DENIED);
    }

    escrow.failedAttempts = 0;
    escrow.lockedUntil = null;
    await escrow.save();
    audit(req, { vault, action: 'vault.escrow_used' });

    return res.json({
      vaultToken: signVaultToken(vault, req.user.userId),
      escrowWrap: vault.escrow.wrap,
      wrappedPrivateKey: escrow.wrappedPrivateKey,
      kdf: escrow.kdf,
      canManage: true,
    });
  } catch (err) {
    console.error('escrowRecoverVault error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

module.exports = {
  getVaultMeta,
  createVault,
  unlockVault,
  recoverVault,
  changeVaultPassword,
  getVaultItems,
  createVaultItem,
  updateVaultItem,
  deleteVaultItem,
  uploadVaultBlob,
  getVaultAudit,
  getOrgEscrow,
  createOrgEscrow,
  unsealOrgEscrow,
  changeEscrowPassphrase,
  setVaultEscrow,
  escrowRecoverVault,
};
