const crypto = require('crypto');

/**
 * Sealing for external-service credentials — the OAuth tokens a connector needs
 * to call Ubersuggest (and, later, whatever else) on a schedule.
 *
 * THIS IS DELIBERATELY NOT THE VAULT, AND MUST NOT BECOME IT.
 *
 * The board Vault is genuinely zero-knowledge: the encryption key is derived in
 * the browser and the server only ever receives an auth proof, so the server
 * cannot read a vault item even in principle. That property is the whole point
 * of the Vault and it is worth protecting.
 *
 * It is also exactly what makes the Vault useless here. A connector's weekly
 * sync runs at 04:00 with no browser open and nobody to type a passphrase. For
 * the job to call Ubersuggest at all, the server must be able to decrypt the
 * refresh token unattended, which means the key must live server-side. That is
 * not a weakness in this design — it is the definition of the feature.
 *
 * So: a different store, a weaker promise, and a different name. If a future
 * change "fixes" this to match the Vault, every scheduled sync stops working and
 * the failure will look like an auth bug. The two must also stay visually
 * distinct in the UI, so nobody assumes a connector token is protected the way a
 * vault secret is.
 *
 * What this DOES give:
 *
 *   - AES-256-GCM, so tampering is detected rather than decrypted into garbage.
 *   - A VERSIONED KEYRING. The envelope carries the id of the key that sealed
 *     it, so a rotation can add a new key and keep reading old rows rather than
 *     requiring a big-bang re-encrypt.
 *   - AAD BINDING to `organisation|provider`. A ciphertext lifted out of one
 *     org's row and pasted into another's fails to open, because the additional
 *     authenticated data no longer matches. Without this, a database write
 *     primitive anywhere in the app would be enough to make one workspace's
 *     connector run with another workspace's credentials.
 *
 * Built on Node's own `crypto`, adding no dependency — the same reasoning as
 * `utils/portalCrypto.js`.
 */

const ENVELOPE_VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // 96-bit nonce, the GCM standard
const TAG_BYTES = 16;

/**
 * Env var per key id. To rotate: generate a new key, add it as
 * CONNECTOR_MASTER_KEY_V2, bump CURRENT_KEY_ID, and deploy. Rows sealed under v1
 * keep opening until they are next written, at which point they re-seal under
 * v2. Only remove a key once nothing references it.
 *
 * Generate one with:  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 */
const KEY_ENV_VARS = {
  1: 'CONNECTOR_MASTER_KEY_V1',
};

const CURRENT_KEY_ID = 1;

// Memoised per raw env value, so rotating in a long-lived process picks up a
// changed variable without a restart, while a steady state costs one Map lookup.
const keyCache = new Map();

/**
 * Resolve one keyring entry to a 32-byte Buffer.
 * @param {number|string} keyId
 * @returns {Buffer}
 * @throws {Error} when the key is absent or the wrong length
 */
const keyFor = (keyId) => {
  const envVar = KEY_ENV_VARS[keyId];
  if (!envVar) {
    throw new Error(`connectorCrypto: no keyring entry for key id ${keyId}`);
  }

  const raw = process.env[envVar];
  if (!raw) {
    throw new Error(
      `connectorCrypto: ${envVar} is not set. Connectors cannot seal or open ` +
        'credentials without it. Generate one with: node -e "console.log(' +
        'require(\'crypto\').randomBytes(32).toString(\'base64\'))"'
    );
  }

  const cached = keyCache.get(raw);
  if (cached) return cached;

  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `connectorCrypto: ${envVar} must decode to ${KEY_BYTES} bytes, got ${key.length}. ` +
        'It should be 32 random bytes, base64-encoded.'
    );
  }

  keyCache.set(raw, key);
  return key;
};

/**
 * The bytes bound into the ciphertext as additional authenticated data.
 *
 * Both parts are required. Binding to the org alone would let a row move between
 * providers within one workspace; binding to the provider alone would let it
 * move between workspaces. Neither is a likely accident, but the guarantee is
 * free and the failure mode it prevents is silent.
 */
const aadFor = ({ orgId, provider }) => {
  if (!orgId || !provider) {
    throw new Error('connectorCrypto: both orgId and provider are required');
  }
  return Buffer.from(`${String(orgId)}|${String(provider)}`, 'utf8');
};

/**
 * Seal a secret for storage.
 *
 * @param {string} plaintext - the token (or a JSON string of several)
 * @param {Object} ctx
 * @param {string} ctx.orgId - the owning organisation's id
 * @param {string} ctx.provider - e.g. 'ubersuggest'
 * @returns {string} `v1:<keyId>:<iv>:<tag>:<ciphertext>`, each part base64url
 */
const seal = (plaintext, ctx) => {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('connectorCrypto: plaintext must be a non-empty string');
  }

  const key = keyFor(CURRENT_KEY_ID);
  const iv = crypto.randomBytes(IV_BYTES);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(aadFor(ctx));

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    ENVELOPE_VERSION,
    CURRENT_KEY_ID,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
};

/**
 * Open a sealed secret.
 *
 * Throws on a tampered ciphertext, a mismatched org/provider, an unknown key id,
 * or a malformed envelope. It deliberately does NOT return null for these —
 * every one of them means something is wrong that a caller should not paper
 * over by treating the credential as merely absent.
 *
 * @param {string} sealed - the string produced by seal()
 * @param {Object} ctx - the SAME { orgId, provider } used to seal
 * @returns {string} the plaintext
 */
const open = (sealed, ctx) => {
  if (typeof sealed !== 'string' || !sealed) {
    throw new Error('connectorCrypto: nothing to open');
  }

  const parts = sealed.split(':');
  if (parts.length !== 5) {
    throw new Error('connectorCrypto: malformed envelope');
  }

  const [version, keyId, ivB64, tagB64, ctB64] = parts;
  if (version !== ENVELOPE_VERSION) {
    throw new Error(`connectorCrypto: unknown envelope version "${version}"`);
  }

  const key = keyFor(keyId);
  const iv = Buffer.from(ivB64, 'base64url');
  const tag = Buffer.from(tagB64, 'base64url');

  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('connectorCrypto: malformed envelope');
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAAD(aadFor(ctx));
  decipher.setAuthTag(tag);

  // `final()` is what throws on a bad tag — i.e. on tampering, on the wrong key,
  // or on the wrong org/provider. That throw is the security property.
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
};

/**
 * Seal an object (an OAuth token set) as JSON.
 * @param {Object} obj
 * @param {Object} ctx - { orgId, provider }
 * @returns {string}
 */
const sealJson = (obj, ctx) => seal(JSON.stringify(obj), ctx);

/**
 * Open a sealed object. Throws for the same reasons `open` does, plus malformed
 * JSON — which would mean the row was sealed by something other than sealJson.
 * @param {string} sealed
 * @param {Object} ctx - { orgId, provider }
 * @returns {Object}
 */
const openJson = (sealed, ctx) => JSON.parse(open(sealed, ctx));

/**
 * A non-secret fingerprint safe to show in a UI or a log line.
 *
 * Never return a sealed envelope or a token to the client. This gives support a
 * way to say "the key ending 4f2a" without the value itself, which is the only
 * thing anyone actually needs to identify a credential.
 *
 * @param {string} plaintext
 * @returns {string} e.g. '••••4f2a'
 */
const preview = (plaintext) => {
  const s = String(plaintext || '');
  if (s.length < 4) return '••••';
  return `••••${s.slice(-4)}`;
};

/**
 * Startup check. Call once at boot so a missing key is a loud failure at deploy
 * time rather than a silent one during the first 04:00 sync.
 *
 * @returns {{ ok: boolean, error?: string }}
 */
const checkConfigured = () => {
  try {
    keyFor(CURRENT_KEY_ID);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
};

module.exports = {
  seal,
  open,
  sealJson,
  openJson,
  preview,
  checkConfigured,
  // Exported for tests and for a future rotation script.
  CURRENT_KEY_ID,
  ENVELOPE_VERSION,
};
