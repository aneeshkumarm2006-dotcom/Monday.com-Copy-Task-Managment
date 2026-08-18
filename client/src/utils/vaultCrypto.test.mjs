/**
 * vaultCrypto.test.mjs — the invariants the vault cannot survive losing.
 *
 * This module is the one place in the app where a mistake is BOTH silent and
 * permanent. A wrong iteration count, a swapped HKDF label, a reused IV, a
 * recovery key normalised differently on the two sides — none of them throw,
 * none fail a build, and all of them are discovered on the day somebody needs
 * their data back. So the properties are pinned here rather than trusted.
 *
 * It runs on Node's WebCrypto, which is the same algorithm implementation the
 * browser exposes; nothing here is mocked. `.mjs` and no imports beyond the
 * module under test, so it needs no bundler.
 *
 * Run from the client directory:
 *     node --test src/utils/vaultCrypto.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildEscrowBlock,
  buildRecoveryBlock,
  decryptFile,
  decryptItem,
  deriveKeys,
  deriveRecoveryKeys,
  encryptFile,
  encryptItem,
  generateRecoveryKey,
  generateVK,
  importVaultKey,
  KDF_ITERATIONS,
  newKdfParams,
  normaliseRecoveryKey,
  passwordStrength,
  resealEscrowPrivateKey,
  unwrapVKWithEscrow,
  unwrapVK,
  unwrapWithRecovery,
  wipe,
  wrapVK,
  wrapVKToEscrow,
} from './vaultCrypto.js';

const PASSWORD = 'correct horse battery staple';

// One derivation costs ~0.5s by design, and these tests do a couple of dozen.
const TIMEOUT = 120_000;

test('the KDF cost is not silently lowered', () => {
  // A regression here is invisible: everything still works, and every vault
  // made afterwards is cheaper to attack. OWASP's floor for PBKDF2-SHA256.
  assert.ok(KDF_ITERATIONS >= 600_000, `${KDF_ITERATIONS} is below the 600k floor`);
  assert.equal(newKdfParams().iterations, KDF_ITERATIONS);
});

test('derivation is deterministic, and salted', { timeout: TIMEOUT }, async () => {
  const kdf = newKdfParams();
  const a = await deriveKeys(PASSWORD, kdf.salt, { iterations: kdf.iterations });
  const b = await deriveKeys(PASSWORD, kdf.salt, { iterations: kdf.iterations });
  assert.equal(a.proof, b.proof, 'same password + salt must give the same proof');

  const other = await deriveKeys(PASSWORD, newKdfParams().salt, {
    iterations: kdf.iterations,
  });
  assert.notEqual(other.proof, a.proof, 'the salt must participate');

  const wrong = await deriveKeys('a different password', kdf.salt, {
    iterations: kdf.iterations,
  });
  assert.notEqual(wrong.proof, a.proof);
});

test('every salt is unique', () => {
  const salts = new Set(Array.from({ length: 50 }, () => newKdfParams().salt));
  assert.equal(salts.size, 50);
});

test('VK wraps and unwraps; the wrong password cannot', { timeout: TIMEOUT }, async () => {
  const kdf = newKdfParams();
  const { encryptionKey } = await deriveKeys(PASSWORD, kdf.salt, {
    iterations: kdf.iterations,
  });
  const vk = generateVK();
  assert.equal(vk.length, 32, 'VK is 256 bits');
  const original = Uint8Array.from(vk);

  const wrapped = await wrapVK(vk, encryptionKey);
  assert.deepEqual([...(await unwrapVK(wrapped, encryptionKey))], [...original]);

  const { encryptionKey: wrongKey } = await deriveKeys('wrong password', kdf.salt, {
    iterations: kdf.iterations,
  });
  await assert.rejects(() => unwrapVK(wrapped, wrongKey));
});

test('items round trip, including unicode and nesting', { timeout: TIMEOUT }, async () => {
  const vaultKey = await importVaultKey(generateVK());
  const payload = {
    title: 'AWS root account',
    password: 'p@ss:w"rd\\',
    nested: { list: [1, 2, { deep: true }] },
    unicode: 'ключ 🔑 密码',
  };
  assert.deepEqual(await decryptItem(await encryptItem(payload, vaultKey), vaultKey), payload);
});

test('every seal uses a fresh IV', { timeout: TIMEOUT }, async () => {
  // Reusing an IV under the same AES-GCM key is catastrophic — it leaks the XOR
  // of the plaintexts AND the authentication key. No caller may supply one, so
  // the only thing to verify is that the module never repeats itself.
  const vaultKey = await importVaultKey(generateVK());
  const ivs = new Set();
  for (let i = 0; i < 40; i += 1) {
    ivs.add((await encryptItem({ title: 'same' }, vaultKey)).iv);
  }
  assert.equal(ivs.size, 40);
});

test('tampering is rejected, never silently mis-decrypted', { timeout: TIMEOUT }, async () => {
  const vaultKey = await importVaultKey(generateVK());
  const sealed = await encryptItem({ title: 'x' }, vaultKey);
  const flipped = sealed.ciphertext.slice(0, -4) +
    (sealed.ciphertext.endsWith('AAAA') ? 'BBBB' : 'AAAA');
  await assert.rejects(() => decryptItem({ ...sealed, ciphertext: flipped }, vaultKey));
});

test('files round trip, and the blob is self-describing', { timeout: TIMEOUT }, async () => {
  const vaultKey = await importVaultKey(generateVK());
  // Large enough to exercise the chunked base64 path, which a naive
  // String.fromCharCode(...bytes) would blow the argument limit on.
  const bytes = new Uint8Array(200_000).map((_, i) => i % 251);

  const blob = await encryptFile(bytes.buffer, vaultKey);
  assert.equal(blob.size, 12 + bytes.length + 16, 'iv(12) + ciphertext + GCM tag(16)');

  const back = await decryptFile(await blob.arrayBuffer(), vaultKey);
  assert.deepEqual([...back], [...bytes]);

  await assert.rejects(
    () => decryptFile(new Uint8Array(8).buffer, vaultKey),
    'a blob shorter than its IV must be refused, not indexed past'
  );
});

test('the recovery key opens the SAME vault key', { timeout: TIMEOUT }, async () => {
  const vk = generateVK();
  const original = Uint8Array.from(vk);
  const rec = await buildRecoveryBlock(vk);

  assert.match(rec.recoveryKey, /^[0-9A-F]{6}(-[0-9A-F]{6}){7}$/, 'human-transcribable form');
  assert.deepEqual(
    [...(await unwrapWithRecovery(rec.recoveryWrap, rec.recoveryKey, rec.recoveryKdf))],
    [...original]
  );
});

test('a recovery key typed off paper still works', { timeout: TIMEOUT }, async () => {
  // The realistic input: lowercase, spaces instead of dashes, a trailing
  // newline from a paste. If the wrap and the proof normalised differently the
  // server would accept the key and the browser would fail to decrypt — a bug
  // that only appears on the worst day.
  const vk = generateVK();
  const original = Uint8Array.from(vk);
  const rec = await buildRecoveryBlock(vk);
  const messy = ` ${rec.recoveryKey.toLowerCase().replace(/-/g, ' ')}\n`;

  assert.equal(normaliseRecoveryKey(messy), normaliseRecoveryKey(rec.recoveryKey));
  assert.deepEqual(
    [...(await unwrapWithRecovery(rec.recoveryWrap, messy, rec.recoveryKdf))],
    [...original]
  );

  const { proof } = await deriveRecoveryKeys(messy, rec.recoveryKdf.salt, {
    iterations: rec.recoveryKdf.iterations,
  });
  assert.equal(proof, rec.recoveryProof, 'the proof the server stored must match');
});

test('a wrong recovery key cannot unwrap', { timeout: TIMEOUT }, async () => {
  const vk = generateVK();
  const rec = await buildRecoveryBlock(vk);
  await assert.rejects(() =>
    unwrapWithRecovery(rec.recoveryWrap, generateRecoveryKey(), rec.recoveryKdf)
  );
});

test('recovery keys are unique', () => {
  const keys = new Set(Array.from({ length: 200 }, generateRecoveryKey));
  assert.equal(keys.size, 200);
});

test(
  'a password change re-wraps VK and leaves items readable',
  { timeout: TIMEOUT },
  async () => {
    // THE property that makes rotation instant and safe. If this ever fails,
    // changing a vault password silently destroys its contents.
    const vk = generateVK();
    const original = Uint8Array.from(vk);
    const vaultKey = await importVaultKey(original);
    const sealedItem = await encryptItem({ title: 'written under the old password' }, vaultKey);

    const rec = await buildRecoveryBlock(original);

    const newKdf = newKdfParams();
    const { encryptionKey: newEnc } = await deriveKeys('a brand new passphrase', newKdf.salt, {
      iterations: newKdf.iterations,
    });
    const rewrapped = await wrapVK(original, newEnc);

    const afterChange = await importVaultKey(await unwrapVK(rewrapped, newEnc));
    assert.deepEqual(await decryptItem(sealedItem, afterChange), {
      title: 'written under the old password',
    });

    // Documented behaviour: VK did not change, so the old recovery key still
    // opens the vault. Rotating it is a separate, explicit choice.
    assert.deepEqual(
      [...(await unwrapWithRecovery(rec.recoveryWrap, rec.recoveryKey, rec.recoveryKdf))],
      [...original]
    );
  }
);

test('wipe zeroes a buffer', () => {
  const bytes = new Uint8Array([1, 2, 3, 255]);
  wipe(bytes);
  assert.deepEqual([...bytes], [0, 0, 0, 0]);
  wipe(null); // must not throw on a non-array
});

test('passwordStrength rewards length', () => {
  assert.equal(passwordStrength('short').score, 0);
  assert.equal(passwordStrength('').score, 0);
  assert.equal(passwordStrength('a'.repeat(25)).score, 3);
  assert.ok(passwordStrength('Passw0rd!x').score >= 1);
});

// ---------------------------------------------------------------------------
// The organisation escrow key (break-glass)
// ---------------------------------------------------------------------------

const ESCROW_PASS = 'the workspace break-glass passphrase';

test(
  'a vault can be escrowed using ONLY the public key',
  { timeout: TIMEOUT },
  async () => {
    // THE property the whole design rests on. Sealing must not require the
    // escrow secret — otherwise every board owner would need it, and would
    // thereby hold the key to every other board's vault.
    const block = await buildEscrowBlock(ESCROW_PASS);
    const vk = generateVK();
    const original = Uint8Array.from(vk);

    const wrap = await wrapVKToEscrow(vk, block.publicKey);

    const recovered = await unwrapVKWithEscrow(
      wrap,
      block.wrappedPrivateKey,
      ESCROW_PASS,
      block.kdf
    );
    assert.deepEqual([...recovered], [...original]);
  }
);

test('a wrong passphrase cannot break glass', { timeout: TIMEOUT }, async () => {
  const block = await buildEscrowBlock(ESCROW_PASS);
  const wrap = await wrapVKToEscrow(generateVK(), block.publicKey);
  await assert.rejects(() =>
    unwrapVKWithEscrow(wrap, block.wrappedPrivateKey, 'wrong passphrase', block.kdf)
  );
});

test("another workspace's escrow cannot open this wrap", { timeout: TIMEOUT }, async () => {
  const mine = await buildEscrowBlock(ESCROW_PASS);
  const theirs = await buildEscrowBlock('a different workspace');
  const wrap = await wrapVKToEscrow(generateVK(), mine.publicKey);
  await assert.rejects(() =>
    unwrapVKWithEscrow(
      wrap,
      theirs.wrappedPrivateKey,
      'a different workspace',
      theirs.kdf
    )
  );
});

test('RSA-OAEP padding is randomised, so no IV is needed', { timeout: TIMEOUT }, async () => {
  // Justifies why Vault.escrow.wrap is a bare string where every other wrap in
  // the system is { ciphertext, iv }.
  const block = await buildEscrowBlock(ESCROW_PASS);
  const vk = generateVK();
  const a = await wrapVKToEscrow(vk, block.publicKey);
  const b = await wrapVKToEscrow(vk, block.publicKey);
  assert.notEqual(a, b);
  for (const wrap of [a, b]) {
    assert.deepEqual(
      [...(await unwrapVKWithEscrow(wrap, block.wrappedPrivateKey, ESCROW_PASS, block.kdf))],
      [...vk]
    );
  }
});

test(
  'rotating the escrow passphrase keeps every existing wrap working',
  { timeout: TIMEOUT },
  async () => {
    // The reason rotation re-seals the KEY rather than minting a new one. If
    // this fails, changing the passphrase silently orphans every escrowed vault.
    const block = await buildEscrowBlock(ESCROW_PASS);
    const vk = generateVK();
    const original = Uint8Array.from(vk);
    const wrap = await wrapVKToEscrow(vk, block.publicKey);

    const rotated = await resealEscrowPrivateKey(
      block.wrappedPrivateKey,
      ESCROW_PASS,
      block.kdf,
      'a brand new passphrase'
    );
    assert.equal(
      rotated.currentProof,
      block.proof,
      'the old proof must match what the server stored, or rotation is refused'
    );

    assert.deepEqual(
      [...(await unwrapVKWithEscrow(
        wrap,
        rotated.wrappedPrivateKey,
        'a brand new passphrase',
        rotated.kdf
      ))],
      [...original]
    );

    await assert.rejects(
      () => unwrapVKWithEscrow(wrap, rotated.wrappedPrivateKey, ESCROW_PASS, rotated.kdf),
      'the old passphrase must stop working'
    );
  }
);

test(
  'an escrow-recovered key opens items written under the vault password',
  { timeout: TIMEOUT },
  async () => {
    const block = await buildEscrowBlock(ESCROW_PASS);
    const vk = generateVK();
    const original = Uint8Array.from(vk);

    const payload = { title: 'AWS root', password: 'hunter2' };
    const sealed = await encryptItem(payload, await importVaultKey(original));

    const wrap = await wrapVKToEscrow(original, block.publicKey);
    const viaEscrow = await importVaultKey(
      await unwrapVKWithEscrow(wrap, block.wrappedPrivateKey, ESCROW_PASS, block.kdf)
    );
    assert.deepEqual(await decryptItem(sealed, viaEscrow), payload);
  }
);
