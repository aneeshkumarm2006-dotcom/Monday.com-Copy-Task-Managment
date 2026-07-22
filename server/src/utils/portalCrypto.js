const crypto = require('crypto');

/**
 * Crypto helpers for the Client Portal, built entirely on Node's `crypto` so we
 * add no dependency (the codebase already uses `crypto.randomBytes` for org
 * invite codes). Two secrets are handled here:
 *
 *  - Group passcode  → scrypt hash + per-group random salt, verified with a
 *    constant-time compare. Never stored or logged raw.
 *  - Magic-link token → a high-entropy random token emailed to the client; only
 *    its SHA-256 hash is persisted (PortalMagicToken.tokenHash).
 */

const SCRYPT_KEYLEN = 64;

/**
 * Hash a passcode for storage. Returns a fresh random salt (hex) and the scrypt
 * hash (hex). Store both on the group.
 * @param {string} passcode
 * @returns {{ salt: string, hash: string }}
 */
const hashPasscode = (passcode) => {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(passcode), salt, SCRYPT_KEYLEN).toString('hex');
  return { salt, hash };
};

/**
 * Constant-time verify of a candidate passcode against a stored salt+hash.
 * Returns false (never throws) on any missing input or length mismatch.
 * @param {string} passcode  candidate
 * @param {string} salt      stored salt (hex)
 * @param {string} hash      stored hash (hex)
 * @returns {boolean}
 */
const verifyPasscode = (passcode, salt, hash) => {
  if (passcode == null || !salt || !hash) return false;
  let derived;
  try {
    derived = crypto.scryptSync(String(passcode), salt, SCRYPT_KEYLEN);
  } catch {
    return false;
  }
  const stored = Buffer.from(hash, 'hex');
  if (stored.length !== derived.length) return false;
  return crypto.timingSafeEqual(stored, derived);
};

/**
 * Generate the public link id stamped into a group's portal URL.
 * @returns {string} 48-char hex
 */
const generatePortalToken = () => crypto.randomBytes(24).toString('hex');

/**
 * Generate a one-time magic-link token. Returns the RAW token (emailed to the
 * client) and its SHA-256 hash (stored). The raw token is never persisted.
 * @returns {{ raw: string, hash: string }}
 */
const generateMagicToken = () => {
  const raw = crypto.randomBytes(32).toString('hex');
  return { raw, hash: hashMagicToken(raw) };
};

/**
 * SHA-256 of a raw magic token — the value stored/looked-up in PortalMagicToken.
 * @param {string} raw
 * @returns {string} hex
 */
const hashMagicToken = (raw) =>
  crypto.createHash('sha256').update(String(raw)).digest('hex');

module.exports = {
  hashPasscode,
  verifyPasscode,
  generatePortalToken,
  generateMagicToken,
  hashMagicToken,
};
