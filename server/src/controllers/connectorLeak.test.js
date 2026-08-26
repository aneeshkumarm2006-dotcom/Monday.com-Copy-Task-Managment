const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

process.env.CONNECTOR_MASTER_KEY_V1 = crypto.randomBytes(32).toString('base64');

const { publicAccount } = require('./connectorController');
const ConnectorAccount = require('../models/ConnectorAccount');
const connectorCrypto = require('../utils/connectorCrypto');

/**
 * The one property that matters most in this feature: a connector's OAuth tokens
 * must never reach a client.
 *
 * `select: false` on the model is the first line of defence, but it only helps
 * for queries that do not ask for the field — and the sync runner has to ask.
 * `publicAccount` is the second line, and it is hand-built rather than a spread
 * precisely so a field added to the schema later cannot leak by default.
 *
 * These tests exist because both defences are easy to erode by accident: someone
 * adds `.select('+sealedTokens')` for debugging, or replaces the projection with
 * `{ ...account }` because it is shorter.
 */

const ORG = '69d4cd1aac4378a532868559';
const SECRET = 'rt_this_must_never_reach_a_browser';

const buildAccount = () =>
  new ConnectorAccount({
    organisation: ORG,
    provider: 'ubersuggest',
    label: 'Main',
    externalEmail: 'seo@davnoot.com',
    tier: 'enterprise',
    sealedTokens: connectorCrypto.sealJson(
      { accessToken: 'at_x', refreshToken: SECRET },
      { orgId: ORG, provider: 'ubersuggest' }
    ),
    scopes: ['profile', 'projects'],
    createdBy: '6a466b99ea3ab35ff1378df6',
  });

test('sealedTokens is select:false on the schema', () => {
  assert.strictEqual(
    ConnectorAccount.schema.path('sealedTokens').options.select,
    false
  );
});

test('publicAccount omits sealedTokens entirely', () => {
  const out = publicAccount(buildAccount());
  assert.strictEqual('sealedTokens' in out, false);
});

test('no serialisation of publicAccount contains the secret', () => {
  // The real leak is transitive — a token nested inside some field that got
  // copied along. Check the whole JSON, not just the top-level keys.
  const json = JSON.stringify(publicAccount(buildAccount()));
  assert.ok(!json.includes(SECRET));
  assert.ok(!json.includes('sealedTokens'));
  assert.ok(!json.includes('refreshToken'));
});

test('publicAccount still carries what the UI actually needs', () => {
  const out = publicAccount(buildAccount());
  assert.strictEqual(out.label, 'Main');
  assert.strictEqual(out.provider, 'ubersuggest');
  assert.strictEqual(out.externalEmail, 'seo@davnoot.com');
  assert.strictEqual(out.tier, 'enterprise');
  assert.strictEqual(out.status, 'active');
  assert.deepStrictEqual(out.scopes, ['profile', 'projects']);
});

test('publicAccount does not blow up on a freshly-created row', () => {
  // createdAt/updatedAt/lastSync* are all absent until mongoose or a sync fills
  // them. The projection must tolerate that rather than throwing on undefined.
  const bare = new ConnectorAccount({
    organisation: ORG,
    provider: 'ubersuggest',
    label: 'Agency 2',
    sealedTokens: 'v1:1:a:b:c',
    createdBy: '6a466b99ea3ab35ff1378df6',
  });
  const out = publicAccount(bare);
  assert.strictEqual(out.externalEmail, null);
  assert.strictEqual(out.tier, null);
  assert.strictEqual(out.lastSyncAt, null);
  assert.deepStrictEqual(out.lastSeenQuota, {});
});

test('a sealed token set round-trips only with its own org and provider', () => {
  // The same guarantee connectorCrypto.test.js covers, asserted here against a
  // real model document — so a future change to how the field is populated
  // cannot quietly break the AAD binding.
  const account = buildAccount();
  const ctx = { orgId: ORG, provider: 'ubersuggest' };
  assert.strictEqual(
    connectorCrypto.openJson(account.sealedTokens, ctx).refreshToken,
    SECRET
  );
  assert.throws(() =>
    connectorCrypto.openJson(account.sealedTokens, {
      orgId: '6a2900f384b12104e52f8369',
      provider: 'ubersuggest',
    })
  );
});
