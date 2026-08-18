const jwt = require('jsonwebtoken');

/**
 * The SECOND lock on every vault-content route.
 *
 * There are now three token scopes signed with the same secret, and they are
 * mutually exclusive by design:
 *
 *   (no scope)      the app session      → middleware/auth.js
 *   scope 'portal'  a client contact     → middleware/portalAuth.js
 *   scope 'vault'   an unlocked vault    → here
 *
 * auth.js already rejects `scope: 'portal'`; it must reject `'vault'` too, and
 * this file must reject everything that is not `'vault'`. A vault token that
 * sailed through auth.js would be an app session nobody ever logged in for.
 *
 * WHY A SECOND TOKEN AT ALL, when the contents are encrypted anyway? Because
 * "the ciphertext is safe to hand out" is a claim about a KDF's cost, and an
 * attacker who can download it gets to attack it offline, unthrottled, forever.
 * Requiring proof-of-unlock to even LIST items keeps every guess on our side of
 * the wire, where the rate limiter and the per-vault lockout can see it.
 *
 * The token is bound to one board and one vault. It is not an identity — the app
 * JWT still has to be present and still names the user; this only answers "did
 * somebody type the vault password for THIS board recently".
 */

const VAULT_JWT_TTL = '15m';

/** Mint the short-lived proof-of-unlock token. */
const signVaultToken = (vault, userId) =>
  jwt.sign(
    {
      scope: 'vault',
      vaultId: String(vault._id),
      boardId: String(vault.board),
      userId: String(userId),
    },
    process.env.JWT_SECRET,
    { expiresIn: VAULT_JWT_TTL }
  );

/**
 * Guard for routes that touch vault CONTENT. Runs AFTER `authMiddleware`, never
 * instead of it — the app session says who you are, this says the vault is open.
 *
 * The token arrives in its own header rather than `Authorization`, which is
 * already carrying the app session. Controllers read `req.vault`, never the
 * request params, when deciding which vault they are in.
 */
const vaultAuth = (req, res, next) => {
  const raw = req.headers['x-vault-token'];
  const token = typeof raw === 'string' ? raw.trim() : '';
  if (!token) {
    return res.status(401).json({ code: 'VAULT_LOCKED', error: 'Vault is locked' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    // Expired is the common case (15 minutes), and the client turns this code
    // into "your vault locked, enter the password again" rather than an error.
    return res
      .status(401)
      .json({ code: 'VAULT_LOCKED', error: 'Vault session expired. Unlock again.' });
  }

  if (decoded.scope !== 'vault' || !decoded.vaultId || !decoded.boardId) {
    return res.status(401).json({ code: 'VAULT_LOCKED', error: 'Vault is locked' });
  }

  // The unlock was performed BY somebody. Handing that token to a colleague
  // would let them read the vault without ever knowing the password, so the
  // token is pinned to the user who unlocked it and checked against the app
  // session on every request.
  if (String(decoded.userId) !== String(req.user?.userId)) {
    return res.status(401).json({ code: 'VAULT_LOCKED', error: 'Vault is locked' });
  }

  req.vault = {
    vaultId: String(decoded.vaultId),
    boardId: String(decoded.boardId),
  };
  return next();
};

module.exports = vaultAuth;
module.exports.signVaultToken = signVaultToken;
module.exports.VAULT_JWT_TTL = VAULT_JWT_TTL;
