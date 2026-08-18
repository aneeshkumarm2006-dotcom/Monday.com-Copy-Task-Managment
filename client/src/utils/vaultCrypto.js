/**
 * vaultCrypto — THE crypto contract for the board vault.
 *
 * Nothing else in the application touches WebCrypto. That is a rule, not a
 * convention: crypto that is correct in one place and subtly wrong in another
 * fails silently, and the failure looks exactly like success until someone tries
 * to open a two-year-old item. One file, one set of parameters, one place to
 * audit.
 *
 * THE KEY HIERARCHY (Bitwarden/LastPass-style envelope encryption):
 *
 *     vault password (typed by a human, never transmitted)
 *        │  PBKDF2-SHA-256 · 600,000 iterations · per-vault random salt
 *        ▼
 *     stretched key (32 bytes)
 *        │  HKDF-SHA-256, two different `info` labels
 *        ├──► ENCRYPTION KEY — wraps/unwraps VK. NEVER leaves this module.
 *        └──► AUTH PROOF     — sent to the server, which stores only its scrypt
 *                              hash. Cracking it opens the unlock endpoint and
 *                              decrypts NOTHING.
 *
 *     Vault Key (VK) — 256 random bits, generated here at setup
 *        │  AES-256-GCM, a fresh random IV per payload
 *        ▼
 *     every vault item, including its title, and every uploaded file
 *
 * WHY TWO BRANCHES. If the server were sent the encryption key it could decrypt
 * everything, and the promise ("a database dump reveals nothing") would be
 * false. If it were sent nothing, it could not throttle guesses and an attacker
 * with a stolen session could download the ciphertext and grind offline forever.
 * HKDF gives us a value that proves knowledge of the password while being
 * computationally unrelated to the key that opens the data.
 *
 * WHY VK EXISTS AT ALL, rather than encrypting items with the password key
 * directly: changing the vault password would then mean re-encrypting every item
 * — slow, and catastrophic if it half-completes. With VK in the middle, a
 * password change re-wraps 32 bytes and touches nothing else. It is also what
 * makes per-user keys possible later without rewriting a single stored item.
 */

// PBKDF2 cost. 600k is the OWASP floor for PBKDF2-HMAC-SHA256 and takes roughly
// half a second on a laptop — deliberately noticeable, since it is paid once per
// unlock and multiplied by every guess an attacker makes.
export const KDF_ITERATIONS = 600_000;
export const KDF_ALGO = 'PBKDF2-SHA256';

// AES-GCM's standard IV length. 12 bytes is the size GCM is defined around;
// anything else forces an extra derivation step internally and buys nothing.
const IV_BYTES = 12;
const SALT_BYTES = 16;
const KEY_BITS = 256;

// The two HKDF labels. They are the ONLY thing separating the key that decrypts
// your data from the value handed to the server, so they must never be equal and
// must never change: changing one is equivalent to losing every vault.
const INFO_ENCRYPTION = 'macan-vault:encryption-key:v1';
const INFO_AUTH = 'macan-vault:auth-proof:v1';

const subtle = () => {
  const c = globalThis.crypto;
  if (!c?.subtle) {
    // Non-HTTPS origins get no WebCrypto at all. Failing loudly here beats
    // failing at `deriveBits` with a TypeError nobody can act on.
    throw new Error(
      'Secure storage is unavailable in this browser. The vault needs a secure (https) connection.'
    );
  }
  return c.subtle;
};

// ---- byte plumbing ---------------------------------------------------------

const utf8 = (str) => new TextEncoder().encode(str);

/** Uint8Array/ArrayBuffer → base64. Chunked; a big file blows the arg limit. */
export const toBase64 = (bytes) => {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < arr.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, arr.subarray(i, i + CHUNK));
  }
  return btoa(binary);
};

/** base64 → Uint8Array. */
export const fromBase64 = (b64) => {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
};

const randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

/**
 * Overwrite a byte array in place.
 *
 * Honest about its limits: JavaScript gives no control over the intermediate
 * copies an engine makes, so this reduces the window in which raw key material
 * sits in a reachable buffer rather than eliminating it. It costs nothing and is
 * worth doing for the few dozen bytes that matter most.
 */
export const wipe = (bytes) => {
  if (bytes instanceof Uint8Array) bytes.fill(0);
};

/** A fresh per-vault KDF salt, ready to store. */
export const randomSalt = () => toBase64(randomBytes(SALT_BYTES));

// ---- derivation ------------------------------------------------------------

/**
 * Turn a typed password into the two values the rest of the system needs.
 *
 * @param {string} password  the vault password, or a normalised recovery key
 * @param {string} salt      base64, from the server's stored KDF parameters
 * @param {Object} [params]
 * @param {number} [params.iterations]
 * @returns {Promise<{ encryptionKey: CryptoKey, proof: string }>}
 *          `encryptionKey` is non-extractable — it cannot be read back out of
 *          JavaScript, only used. `proof` is base64 and is the ONLY derived
 *          value that may ever be transmitted.
 */
export const deriveKeys = async (password, salt, { iterations = KDF_ITERATIONS } = {}) => {
  const s = subtle();

  const passwordKey = await s.importKey('raw', utf8(password), 'PBKDF2', false, [
    'deriveBits',
  ]);

  const stretched = await s.deriveBits(
    {
      name: 'PBKDF2',
      salt: fromBase64(salt),
      iterations,
      hash: 'SHA-256',
    },
    passwordKey,
    KEY_BITS
  );

  // HKDF over an already-uniform 256-bit secret, so the extract step has nothing
  // left to do and an empty salt is correct here (this is HKDF-Expand in
  // practice). The `info` labels are what make the two outputs independent.
  const hkdfKey = await s.importKey('raw', stretched, 'HKDF', false, ['deriveBits']);
  const expand = (info) =>
    s.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8(info) },
      hkdfKey,
      KEY_BITS
    );

  const [encBits, authBits] = await Promise.all([
    expand(INFO_ENCRYPTION),
    expand(INFO_AUTH),
  ]);

  const encryptionKey = await s.importKey(
    'raw',
    encBits,
    { name: 'AES-GCM', length: KEY_BITS },
    false, // non-extractable: nothing, including our own code, can read it back
    ['encrypt', 'decrypt']
  );

  return { encryptionKey, proof: toBase64(new Uint8Array(authBits)) };
};

/** The KDF parameter block to store alongside a new vault. */
export const newKdfParams = () => ({
  algo: KDF_ALGO,
  iterations: KDF_ITERATIONS,
  salt: randomSalt(),
});

// ---- the vault key ---------------------------------------------------------

/** A brand-new Vault Key: 256 raw bits. Wrap it, import it, then wipe it. */
export const generateVK = () => randomBytes(32);

/**
 * Raw VK bytes → the AES-GCM key everything else uses.
 *
 * Non-extractable on purpose. Once the store holds this, the vault key cannot be
 * read out of JavaScript by anything — not by our own code, not by an injected
 * script reading through the store. It can only be handed back to WebCrypto.
 */
export const importVaultKey = async (bytes) =>
  subtle().importKey('raw', bytes, { name: 'AES-GCM', length: KEY_BITS }, false, [
    'encrypt',
    'decrypt',
  ]);

// ---- the sealing primitive -------------------------------------------------

/**
 * AES-256-GCM one payload. Every call generates a FRESH IV — reusing an IV under
 * the same key breaks GCM completely (it leaks the XOR of the plaintexts and the
 * authentication key), so no caller is ever given the option of supplying one.
 *
 * @returns {Promise<{ ciphertext: string, iv: string }>} both base64
 */
export const seal = async (bytes, key) => {
  const iv = randomBytes(IV_BYTES);
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv }, key, bytes);
  return { ciphertext: toBase64(ct), iv: toBase64(iv) };
};

/**
 * The inverse. Throws on ANY tampering — GCM authenticates, so a flipped bit in
 * the database is a thrown error, never a silently wrong plaintext.
 *
 * @returns {Promise<Uint8Array>}
 */
export const open = async ({ ciphertext, iv }, key) => {
  const plain = await subtle().decrypt(
    { name: 'AES-GCM', iv: fromBase64(iv) },
    key,
    fromBase64(ciphertext)
  );
  return new Uint8Array(plain);
};

/** VK sealed under a password-derived encryption key. */
export const wrapVK = (vkBytes, encryptionKey) => seal(vkBytes, encryptionKey);

/** @returns {Promise<Uint8Array>} the raw VK — import it and wipe it promptly. */
export const unwrapVK = (wrapped, encryptionKey) => open(wrapped, encryptionKey);

// ---- items -----------------------------------------------------------------

/**
 * Seal an item's whole payload — title included.
 *
 * The title is in here rather than in a column of its own precisely because it
 * is the most revealing field: "AWS root account" tells you nearly everything
 * without a single byte being decrypted. The cost is that the server can neither
 * sort nor search, which the item list absorbs by decrypting client-side.
 */
export const encryptItem = (payload, vaultKey) =>
  seal(utf8(JSON.stringify(payload)), vaultKey);

/** @returns {Promise<Object>} the payload object. Throws if it was tampered with. */
export const decryptItem = async (sealed, vaultKey) => {
  const bytes = await open(sealed, vaultKey);
  return JSON.parse(new TextDecoder().decode(bytes));
};

// ---- files -----------------------------------------------------------------

/**
 * Encrypt a file's bytes for upload.
 *
 * The IV is PREPENDED to the ciphertext rather than stored beside it, making the
 * blob self-describing: there is no second place for the two halves to drift
 * apart, and a blob restored from a backup still opens. An IV is public by
 * design, so putting it in the file costs nothing.
 *
 * The real filename, MIME type and plaintext size are NOT here — they live in
 * the item payload above, sealed. What reaches Cloudinary is bytes under a
 * random name.
 *
 * @returns {Promise<Blob>} iv ‖ ciphertext
 */
export const encryptFile = async (arrayBuffer, vaultKey) => {
  const iv = randomBytes(IV_BYTES);
  const ct = await subtle().encrypt(
    { name: 'AES-GCM', iv },
    vaultKey,
    arrayBuffer
  );
  const out = new Uint8Array(IV_BYTES + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), IV_BYTES);
  return new Blob([out], { type: 'application/octet-stream' });
};

/**
 * Reverse `encryptFile` — split the prefix back off and decrypt.
 * @returns {Promise<Uint8Array>} the original bytes
 */
export const decryptFile = async (arrayBuffer, vaultKey) => {
  const all = new Uint8Array(arrayBuffer);
  if (all.length <= IV_BYTES) throw new Error('This file is corrupt or incomplete.');
  const plain = await subtle().decrypt(
    { name: 'AES-GCM', iv: all.subarray(0, IV_BYTES) },
    vaultKey,
    all.subarray(IV_BYTES)
  );
  return new Uint8Array(plain);
};

// ---- the recovery key ------------------------------------------------------

// Uppercase hex, in groups. Hex rather than a friendlier base32 alphabet for one
// reason: there is no character to confuse. 0/O, 1/I/l and 5/S all cost support
// tickets on the one day of a vault's life when the user is already panicking.
const RECOVERY_BYTES = 24; // 192 bits — unguessable, and 48 characters to write down
const RECOVERY_GROUP = 6;

/**
 * A fresh recovery key, formatted for a human to write on paper.
 * Shown exactly once, at setup, and never stored anywhere by us.
 */
export const generateRecoveryKey = () => {
  const hex = Array.from(randomBytes(RECOVERY_BYTES))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
  return hex.match(new RegExp(`.{1,${RECOVERY_GROUP}}`, 'g')).join('-');
};

/**
 * Accept a recovery key however it was typed — spaces, lowercase, missing
 * dashes, pasted with a trailing newline — and reduce it to the canonical form
 * the KDF ran over. Anything that is not a hex digit is dropped, so the format
 * is a readability aid rather than something the user has to reproduce.
 */
export const normaliseRecoveryKey = (input) =>
  String(input || '')
    .toUpperCase()
    .replace(/[^0-9A-F]/g, '');

/**
 * Recovery uses the SAME derivation as the password — its own salt, its own
 * wrap of the same VK, its own proof. The symmetry is the point: recovery is not
 * a second, less-tested code path that only runs on the worst day.
 *
 * The full iteration count is kept even though 192 bits of randomness needs no
 * stretching. It costs one extra half-second on an operation performed once in a
 * vault's lifetime, and it keeps the derivation branch-free.
 */
export const deriveRecoveryKeys = (recoveryKey, salt, params) =>
  deriveKeys(normaliseRecoveryKey(recoveryKey), salt, params);

/**
 * Build the complete recovery block for a new (or rotated) vault.
 * @returns {Promise<{ recoveryKey: string, recoveryKdf: Object, recoveryWrap: Object, recoveryProof: string }>}
 *          `recoveryKey` is the only copy in existence — show it, then drop it.
 */
export const buildRecoveryBlock = async (vkBytes) => {
  const recoveryKey = generateRecoveryKey();
  const recoveryKdf = newKdfParams();
  const { encryptionKey, proof } = await deriveRecoveryKeys(
    recoveryKey,
    recoveryKdf.salt,
    { iterations: recoveryKdf.iterations }
  );
  const recoveryWrap = await wrapVK(vkBytes, encryptionKey);
  return { recoveryKey, recoveryKdf, recoveryWrap, recoveryProof: proof };
};

/** @returns {Promise<Uint8Array>} VK, recovered from the one-time key. */
export const unwrapWithRecovery = async (wrapped, recoveryKey, kdf) => {
  const { encryptionKey } = await deriveRecoveryKeys(recoveryKey, kdf.salt, {
    iterations: kdf.iterations,
  });
  return unwrapVK(wrapped, encryptionKey);
};

// ---- the organisation escrow key -------------------------------------------

/**
 * RSA-OAEP, 4096-bit, SHA-256. The one place this module is asymmetric, and the
 * asymmetry is the entire reason escrow can exist safely.
 *
 * Escrowing a vault happens when the vault is CREATED, by whoever created it. A
 * shared org secret would mean that person must know it — so every board owner
 * would hold the key to every other board's vault. A keypair lets them seal to
 * the public half while being unable to open it, which is the property that
 * makes the feature offerable at all.
 *
 * 4096 rather than 2048 because this key is long-lived by design (rotating it
 * invalidates every wrap), so it should outlive the vaults it protects. It only
 * ever encrypts 32 bytes, so the cost is one keygen and never shows up again.
 */
const ESCROW_KEY_PARAMS = {
  name: 'RSA-OAEP',
  modulusLength: 4096,
  publicExponent: new Uint8Array([1, 0, 1]), // 65537
  hash: 'SHA-256',
};

/**
 * Mint a fresh escrow keypair.
 *
 * @returns {Promise<{ publicKey: string, privateKeyPkcs8: Uint8Array }>}
 *          `publicKey` is SPKI base64 and is stored in the clear — it must be,
 *          since every vault creation needs it. `privateKeyPkcs8` is raw and
 *          the caller must seal it immediately and wipe it.
 */
export const generateEscrowKeypair = async () => {
  const s = subtle();
  const pair = await s.generateKey(ESCROW_KEY_PARAMS, true, ['encrypt', 'decrypt']);
  const [spki, pkcs8] = await Promise.all([
    s.exportKey('spki', pair.publicKey),
    s.exportKey('pkcs8', pair.privateKey),
  ]);
  return {
    publicKey: toBase64(spki),
    privateKeyPkcs8: new Uint8Array(pkcs8),
  };
};

/** Import a stored SPKI public key, ready to seal a vault key to. */
export const importEscrowPublicKey = (publicKeyB64) =>
  subtle().importKey(
    'spki',
    fromBase64(publicKeyB64),
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt']
  );

/** Import a decrypted PKCS8 private key, ready to open a wrap. */
export const importEscrowPrivateKey = (pkcs8Bytes) =>
  subtle().importKey(
    'pkcs8',
    pkcs8Bytes,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['decrypt']
  );

/**
 * Seal VK to the organisation's public key.
 *
 * RSA-OAEP output carries no IV — the padding is randomised internally, so two
 * seals of the same VK differ without one. That is why `Vault.escrow.wrap` is a
 * bare string where every other wrap in this system is `{ ciphertext, iv }`.
 *
 * @returns {Promise<string>} base64
 */
export const wrapVKToEscrow = async (vkBytes, publicKeyB64) => {
  const key = await importEscrowPublicKey(publicKeyB64);
  const ct = await subtle().encrypt({ name: 'RSA-OAEP' }, key, vkBytes);
  return toBase64(ct);
};

/** @returns {Promise<Uint8Array>} VK, opened with the escrow private key. */
export const unwrapVKFromEscrow = async (wrapB64, privateKey) => {
  const plain = await subtle().decrypt(
    { name: 'RSA-OAEP' },
    privateKey,
    fromBase64(wrapB64)
  );
  return new Uint8Array(plain);
};

/**
 * Build the complete escrow record for a workspace that is turning it on.
 *
 * The private key is sealed under the passphrase before this function returns,
 * and the raw bytes are wiped — so the only thing that ever leaves is
 * ciphertext, a public key, and a proof.
 *
 * @returns {Promise<{ publicKey, kdf, wrappedPrivateKey, proof }>}
 */
export const buildEscrowBlock = async (passphrase) => {
  const kdf = newKdfParams();
  const { encryptionKey, proof } = await deriveKeys(passphrase, kdf.salt, {
    iterations: kdf.iterations,
  });
  const { publicKey, privateKeyPkcs8 } = await generateEscrowKeypair();
  const wrappedPrivateKey = await seal(privateKeyPkcs8, encryptionKey);
  wipe(privateKeyPkcs8);
  return { publicKey, kdf, wrappedPrivateKey, proof };
};

/** @returns {Promise<Uint8Array>} the PKCS8 bytes, opened with the passphrase. */
export const openEscrowPrivateKey = async (wrappedPrivateKey, passphrase, kdf) => {
  const { encryptionKey } = await deriveKeys(passphrase, kdf.salt, {
    iterations: kdf.iterations,
  });
  return open(wrappedPrivateKey, encryptionKey);
};

/**
 * Re-seal the SAME private key under a new passphrase.
 *
 * Keeping the keypair is what keeps every existing wrap working — the exact
 * relationship a vault password has to VK. Minting a new KEY instead would
 * leave every escrowed vault holding a wrap nothing can open, discovered on the
 * one day escrow matters.
 *
 * @returns {Promise<{ currentProof, kdf, wrappedPrivateKey, proof }>}
 */
export const resealEscrowPrivateKey = async (
  wrappedPrivateKey,
  currentPassphrase,
  currentKdf,
  newPassphrase
) => {
  const { encryptionKey: currentEnc, proof: currentProof } = await deriveKeys(
    currentPassphrase,
    currentKdf.salt,
    { iterations: currentKdf.iterations }
  );
  const pkcs8 = await open(wrappedPrivateKey, currentEnc);

  const kdf = newKdfParams();
  const { encryptionKey, proof } = await deriveKeys(newPassphrase, kdf.salt, {
    iterations: kdf.iterations,
  });
  const resealed = await seal(pkcs8, encryptionKey);
  wipe(pkcs8);

  return { currentProof, kdf, wrappedPrivateKey: resealed, proof };
};

/**
 * Open a vault via the workspace break-glass key: passphrase → private key →
 * VK. One function so the three-step chain has a single implementation.
 *
 * @returns {Promise<Uint8Array>} VK
 */
export const unwrapVKWithEscrow = async (
  escrowWrap,
  wrappedPrivateKey,
  passphrase,
  kdf
) => {
  const pkcs8 = await openEscrowPrivateKey(wrappedPrivateKey, passphrase, kdf);
  const privateKey = await importEscrowPrivateKey(pkcs8);
  wipe(pkcs8);
  return unwrapVKFromEscrow(escrowWrap, privateKey);
};

// ---- password strength -----------------------------------------------------

/**
 * A blunt strength estimate for the setup screen.
 *
 * Deliberately not zxcvbn: this password has no reset path, so the honest advice
 * is "make it long", and a 400KB dictionary that scolds you about `Tr0ub4dor&3`
 * would imply a precision we do not have. Length dominates, because against
 * 600,000 PBKDF2 iterations it genuinely does.
 *
 * @returns {{ score: 0|1|2|3, label: string, hint: string }}
 */
export const passwordStrength = (password) => {
  const pw = String(password || '');
  const classes =
    (/[a-z]/.test(pw) ? 1 : 0) +
    (/[A-Z]/.test(pw) ? 1 : 0) +
    (/[0-9]/.test(pw) ? 1 : 0) +
    (/[^a-zA-Z0-9]/.test(pw) ? 1 : 0);

  if (pw.length < 10) {
    return {
      score: 0,
      label: 'Too short',
      hint: 'Use at least 10 characters — there is no way to reset this one.',
    };
  }
  if (pw.length >= 20 || (pw.length >= 16 && classes >= 3)) {
    return { score: 3, label: 'Strong', hint: 'Store it in a password manager.' };
  }
  if (pw.length >= 14 || classes >= 3) {
    return { score: 2, label: 'Good', hint: 'A few more characters would help.' };
  }
  return {
    score: 1,
    label: 'Weak',
    hint: 'Length beats complexity here — try a passphrase of several words.',
  };
};

export const MIN_PASSWORD_LENGTH = 10;
