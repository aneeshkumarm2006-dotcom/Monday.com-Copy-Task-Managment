const crypto = require('crypto');
const { promisify } = require('util');

/**
 * Crypto helpers for the Client Portal, built on Node's `crypto` so we add no
 * dependency (the codebase already uses `crypto.randomBytes` for org invite
 * codes). Two secrets live here:
 *
 *   - the public link id stamped into a group's portal URL, and
 *   - the credentials for clients who sign in with a password instead of Google.
 *
 * Password hashing is scrypt rather than bcrypt for the same reason: it ships
 * with Node, and it is a memory-hard KDF, which is what we want.
 */

const scrypt = promisify(crypto.scrypt);

/**
 * Generate the public link id stamped into a group's portal URL.
 * @returns {string} 48-char hex
 */
const generatePortalToken = () => crypto.randomBytes(24).toString('hex');

// ---- One-time setup / reset tokens -----------------------------------------

/**
 * Generate the raw one-time token that goes in a "set your password" email.
 * Never stored — only its hash is.
 * @returns {string} 64-char hex
 */
const generateSetupToken = () => crypto.randomBytes(32).toString('hex');

/**
 * The stored form of a setup token. Plain sha256 is right here (unlike for a
 * password): the input is 256 bits of our own randomness, so there is nothing
 * for a slow KDF to defend against.
 * @param {string} token
 * @returns {string} 64-char hex
 */
const hashSetupToken = (token) =>
  crypto.createHash('sha256').update(String(token)).digest('hex');

// ---- Passwords --------------------------------------------------------------

// scrypt cost. 128 * N * r = 16MB, comfortably under Node's 32MB `maxmem`
// default, so no option juggling is needed.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

/**
 * Hash a password for storage.
 *
 * The parameters are written into the string (`scrypt$N$r$p$salt$key`) so that
 * raising the cost later doesn't invalidate hashes made today — `verifyPassword`
 * reads whatever each record was made with.
 *
 * @param {string} plain
 * @returns {Promise<string>}
 */
const hashPassword = async (plain) => {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(plain), salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('hex'),
    key.toString('hex'),
  ].join('$');
};

/**
 * Check a password against a stored hash. Returns false — never throws — for a
 * malformed, empty or null hash, so callers can pass whatever the database gave
 * them.
 *
 * @param {string} plain
 * @param {string} stored — the `scrypt$...` string from hashPassword
 * @returns {Promise<boolean>}
 */
const verifyPassword = async (plain, stored) => {
  try {
    if (!plain || typeof stored !== 'string') return false;
    const [scheme, n, r, p, saltHex, keyHex] = stored.split('$');
    if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;

    const expected = Buffer.from(keyHex, 'hex');
    const actual = await scrypt(String(plain), Buffer.from(saltHex, 'hex'), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
    // Lengths always match here (we derived `actual` at `expected.length`), but
    // timingSafeEqual throws on a mismatch, so keep the guard.
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
};

/**
 * A real hash of a value nobody knows, verified against when the submitted email
 * matches no password contact. Without it, "unknown email" would return in
 * microseconds while "known email, wrong password" spent ~100ms in scrypt —
 * which is enough to enumerate who has portal access.
 */
const DUMMY_PASSWORD_HASH =
  'scrypt$16384$8$1$' +
  '00000000000000000000000000000000$' +
  '0'.repeat(128);

/** Burn the same time a real check would, then fail. */
const verifyDummyPassword = (plain) => verifyPassword(plain, DUMMY_PASSWORD_HASH);

module.exports = {
  generatePortalToken,
  generateSetupToken,
  hashSetupToken,
  hashPassword,
  verifyPassword,
  verifyDummyPassword,
};
