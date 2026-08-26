const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

// Set the key BEFORE requiring the module under test — it reads process.env
// lazily, but a test run should not depend on the developer's real environment.
process.env.CONNECTOR_MASTER_KEY_V1 = crypto.randomBytes(32).toString('base64');

const {
  seal,
  open,
  sealJson,
  openJson,
  preview,
  checkConfigured,
} = require('./connectorCrypto');

const ORG_A = '69d4cd1aac4378a532868559';
const ORG_B = '6a2900f384b12104e52f8369';
const CTX_A = { orgId: ORG_A, provider: 'ubersuggest' };

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

test('seal then open returns the original plaintext', () => {
  const secret = 'ya29.a0AfB_refresh_token_value';
  assert.strictEqual(open(seal(secret, CTX_A), CTX_A), secret);
});

test('the envelope never contains the plaintext', () => {
  const secret = 'super-secret-refresh-token';
  const sealed = seal(secret, CTX_A);
  assert.ok(!sealed.includes(secret));
  assert.ok(!Buffer.from(sealed).toString('utf8').includes(secret));
});

test('the envelope is versioned and carries its key id', () => {
  const parts = seal('x', CTX_A).split(':');
  assert.strictEqual(parts.length, 5);
  assert.strictEqual(parts[0], 'v1');
  assert.strictEqual(parts[1], '1');
});

test('sealing the same value twice produces different ciphertexts', () => {
  // A fresh random IV every time. Equal envelopes would leak that two orgs use
  // the same credential.
  assert.notStrictEqual(seal('same', CTX_A), seal('same', CTX_A));
});

test('sealJson/openJson round-trip an OAuth token set', () => {
  const tokens = {
    access_token: 'at_123',
    refresh_token: 'rt_456',
    expires_in: 3600,
    scope: 'profile projects',
  };
  assert.deepStrictEqual(openJson(sealJson(tokens, CTX_A), CTX_A), tokens);
});

test('unicode survives the round trip', () => {
  const secret = 'clé-secrète-🔑-日本語';
  assert.strictEqual(open(seal(secret, CTX_A), CTX_A), secret);
});

// ---------------------------------------------------------------------------
// AAD binding — the property that stops a row being replayed
// ---------------------------------------------------------------------------

test('a row sealed for org A does NOT open for org B', () => {
  const sealed = seal('org-a-token', CTX_A);
  assert.throws(() => open(sealed, { orgId: ORG_B, provider: 'ubersuggest' }));
});

test('a row sealed for one provider does NOT open for another', () => {
  const sealed = seal('ubersuggest-token', CTX_A);
  assert.throws(() => open(sealed, { orgId: ORG_A, provider: 'semrush' }));
});

test('sealing without an org or provider is refused', () => {
  assert.throws(() => seal('x', { provider: 'ubersuggest' }), /orgId and provider/);
  assert.throws(() => seal('x', { orgId: ORG_A }), /orgId and provider/);
});

// ---------------------------------------------------------------------------
// Tamper detection — GCM's whole reason for being here
// ---------------------------------------------------------------------------

test('a flipped ciphertext byte is rejected, not decrypted to garbage', () => {
  const parts = seal('tamper-me', CTX_A).split(':');
  const ct = Buffer.from(parts[4], 'base64url');
  ct[0] ^= 0xff;
  parts[4] = ct.toString('base64url');
  assert.throws(() => open(parts.join(':'), CTX_A));
});

test('a forged auth tag is rejected', () => {
  const parts = seal('tamper-me', CTX_A).split(':');
  const tag = Buffer.from(parts[3], 'base64url');
  tag[0] ^= 0xff;
  parts[3] = tag.toString('base64url');
  assert.throws(() => open(parts.join(':'), CTX_A));
});

test('a swapped IV is rejected', () => {
  const a = seal('first', CTX_A).split(':');
  const b = seal('second', CTX_A).split(':');
  a[2] = b[2];
  assert.throws(() => open(a.join(':'), CTX_A));
});

// ---------------------------------------------------------------------------
// Malformed input
// ---------------------------------------------------------------------------

test('malformed envelopes throw rather than returning null', () => {
  // Every one of these means something is wrong. Returning null would let a
  // caller treat a corrupted credential as merely absent and carry on.
  assert.throws(() => open('', CTX_A), /nothing to open/);
  assert.throws(() => open(null, CTX_A), /nothing to open/);
  assert.throws(() => open('not-an-envelope', CTX_A), /malformed/);
  assert.throws(() => open('v1:1:a:b', CTX_A), /malformed/);
  assert.throws(() => open('v9:1:a:b:c', CTX_A), /unknown envelope version/);
});

test('an unknown key id is named in the error', () => {
  const parts = seal('x', CTX_A).split(':');
  parts[1] = '99';
  assert.throws(() => open(parts.join(':'), CTX_A), /no keyring entry for key id 99/);
});

test('empty plaintext is refused', () => {
  assert.throws(() => seal('', CTX_A), /non-empty string/);
  assert.throws(() => seal(null, CTX_A), /non-empty string/);
});

// ---------------------------------------------------------------------------
// Preview and configuration
// ---------------------------------------------------------------------------

test('preview shows only the last four characters', () => {
  assert.strictEqual(preview('abcdef4f2a'), '••••4f2a');
  assert.strictEqual(preview('abc'), '••••');
  assert.strictEqual(preview(''), '••••');
  assert.strictEqual(preview(null), '••••');
});

test('checkConfigured passes with a valid key', () => {
  assert.deepStrictEqual(checkConfigured(), { ok: true });
});

test('checkConfigured reports a wrong-length key rather than throwing', () => {
  const saved = process.env.CONNECTOR_MASTER_KEY_V1;
  try {
    process.env.CONNECTOR_MASTER_KEY_V1 = Buffer.from('too short').toString('base64');
    const result = checkConfigured();
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /must decode to 32 bytes/);
  } finally {
    process.env.CONNECTOR_MASTER_KEY_V1 = saved;
  }
});

test('checkConfigured reports an absent key rather than throwing', () => {
  const saved = process.env.CONNECTOR_MASTER_KEY_V1;
  try {
    delete process.env.CONNECTOR_MASTER_KEY_V1;
    const result = checkConfigured();
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /is not set/);
  } finally {
    process.env.CONNECTOR_MASTER_KEY_V1 = saved;
  }
});
