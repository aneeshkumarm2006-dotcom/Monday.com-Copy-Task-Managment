const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

process.env.CONNECTOR_MASTER_KEY_V1 = crypto.randomBytes(32).toString('base64');

const Organisation = require('../models/Organisation');
const connectorCrypto = require('../utils/connectorCrypto');
const { sanitizeFxSettings, keyPreviewOf, providerNeedsKey } = require('../utils/money');

/**
 * The workspace's FX credential must never reach a browser.
 *
 * A direct sibling of `connectorLeak.test.js`, for the same reason and against
 * the same two ways it erodes: somebody adds `.select('+fx.sealedApiKey')` while
 * debugging, or replaces the hand-built settings payload with a spread of
 * `org.fx` because it is shorter.
 *
 * The exposure here is slightly worse than the connector's, which is why it
 * gets its own file. A `ConnectorAccount` is only ever read by code that went
 * looking for it; `Organisation` is returned WHOLE by `getOrg` on every page
 * load, so a field without `select: false` would be on the wire immediately.
 */

const ORG = '69d4cd1aac4378a532868559';
const SECRET = 'fxk_this_must_never_reach_a_browser';

test('fx.sealedApiKey is select:false on the schema', () => {
  // The first line of defence, and the one that matters most here: `getOrg`
  // does not name its fields, so anything without this rides along.
  assert.strictEqual(Organisation.schema.path('fx.sealedApiKey').options.select, false);
});

test('a default org has no key and a keyless provider', () => {
  // An org that never opens the Currency screen must still get live rates.
  const org = new Organisation({ name: 'Davnoot', admin: ORG });
  assert.strictEqual(org.fx.provider, 'frankfurter');
  assert.strictEqual(providerNeedsKey(org.fx.provider), false);
  assert.strictEqual(org.fx.sealedApiKey, null);
  assert.strictEqual(org.fx.keyPreview, '');
});

test('the default base currency is rupees, and it is now a setting', () => {
  // Same default the templates hardcoded — the difference is that it moved.
  const org = new Organisation({ name: 'Davnoot', admin: ORG });
  assert.strictEqual(org.baseCurrency, 'INR');
});

test('a serialised org never carries the sealed key', () => {
  /**
   * The end-to-end version of the `select: false` assertion. A document that
   * HAS the field — because the controller just sealed one — must still not
   * expose it when the org goes over the wire.
   */
  const org = new Organisation({ name: 'Davnoot', admin: ORG });
  org.fx.sealedApiKey = connectorCrypto.seal(SECRET, { orgId: ORG, provider: 'fx' });
  org.fx.keyPreview = keyPreviewOf(SECRET);

  const wire = JSON.stringify(org.toJSON());
  assert.ok(!wire.includes(SECRET), 'the plaintext key leaked');
  assert.ok(!wire.includes(org.fx.sealedApiKey), 'the sealed key leaked');
  // The preview is fine, and is the whole point of having one.
  assert.ok(wire.includes(org.fx.keyPreview));
});

test('the preview identifies a key without revealing it', () => {
  const preview = keyPreviewOf(SECRET);
  assert.ok(preview.endsWith('wser'));
  assert.ok(preview.length < 8, `a preview should be short, got ${preview}`);
  assert.ok(!SECRET.startsWith(preview), 'a preview must not be a usable prefix');
  // Too short to have a meaningful tail — say nothing rather than most of it.
  assert.strictEqual(keyPreviewOf('abc'), '');
  assert.strictEqual(keyPreviewOf(null), '');
});

test('a sealed key round-trips only with the right workspace bound in', () => {
  // The AAD is what stops a row moving between workspaces.
  const sealed = connectorCrypto.seal(SECRET, { orgId: ORG, provider: 'fx' });
  assert.strictEqual(connectorCrypto.open(sealed, { orgId: ORG, provider: 'fx' }), SECRET);
  assert.throws(() =>
    connectorCrypto.open(sealed, { orgId: '69d4cd1aac4378a532868558', provider: 'fx' })
  );
});

// --- the partial-patch contract -------------------------------------------

test('an absent field is left alone, not cleared', () => {
  /**
   * The settings screen saves one control at a time. If this built a whole
   * object, changing the cadence would silently clear the base currency.
   */
  const r = sanitizeFxSettings({ cadence: 'daily' });
  assert.strictEqual(r.ok, true);
  assert.deepEqual(Object.keys(r.patch), ['fx.cadence']);
});

test('an empty body is a no-op rather than an error', () => {
  for (const body of [{}, null, undefined]) {
    const r = sanitizeFxSettings(body);
    assert.strictEqual(r.ok, true);
    assert.deepEqual(r.patch, {});
  }
});

test('a bad value is refused rather than coerced', () => {
  assert.strictEqual(sanitizeFxSettings({ baseCurrency: 'DOLLARS' }).ok, false);
  assert.strictEqual(sanitizeFxSettings({ provider: 'yahoo-finance' }).ok, false);
  assert.strictEqual(sanitizeFxSettings({ cadence: 'hourly' }).ok, false);
});

test('patch keys are dotted so they touch only their own field', () => {
  // `$set: { fx: {...} }` would replace the whole sub-document and drop the
  // sealed key along with it.
  const r = sanitizeFxSettings({ baseCurrency: 'cad', provider: 'exchangerate-api', cadence: 'daily' });
  assert.deepEqual(r.patch, {
    baseCurrency: 'CAD',
    'fx.provider': 'exchangerate-api',
    'fx.cadence': 'daily',
  });
});
