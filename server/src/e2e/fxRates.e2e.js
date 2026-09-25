/**
 * End-to-end check of the exchange-rate pipeline, against a THROWAWAY in-memory
 * MongoDB and the REAL rate provider.
 *
 * Deliberately hits the live Frankfurter API rather than a fixture. The unit
 * tests already parse captured payloads; what those cannot tell you is whether
 * the endpoint still exists, still answers the shape we parse, and still serves
 * a historical date without a key — which is the entire premise of dating a
 * record's conversion. A green unit suite over a dead API is exactly the
 * failure this is here to catch.
 *
 * Run: npm run e2e:fx   (from server/)
 *
 * Needs a network. Nothing here reads server/.env, so it can never reach the
 * real cluster.
 */
process.env.CONNECTOR_MASTER_KEY_V1 = require('crypto').randomBytes(32).toString('base64');

const assert = require('node:assert');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

const ok = (label) => console.log(`  ok  ${label}`);

const run = async () => {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  require('../models');

  const Organisation = mongoose.models.Organisation;
  const rateService = require('../services/fx/rateService');

  console.log('\nFX rates, end to end\n');

  // ---- a workspace needs no setup at all -----------------------------------
  const org = await Organisation.create({
    name: 'Davnoot',
    admin: new mongoose.Types.ObjectId(),
    members: [],
    inviteCode: `e2e-${Date.now()}`,
  });
  assert.strictEqual(org.fx.provider, 'frankfurter');
  assert.strictEqual(org.fx.sealedApiKey, null);
  ok('a new workspace is ready to fetch rates with no credential');

  // ---- the live fetch ------------------------------------------------------
  const latest = await rateService.fetchAndStore({ orgId: org._id });
  assert.ok(latest.count > 100, `expected the whole table, got ${latest.count} codes`);
  ok(`latest rates fetched and stored (${latest.count} currencies, ${latest.dayKey})`);

  // Every code either picker can produce, because a board may hold any of them.
  const table = await rateService.rateTableOn(null);
  for (const code of ['INR', 'USD', 'CAD', 'EUR', 'GBP', 'AED', 'AUD', 'SGD', 'JPY']) {
    assert.ok(typeof table.rates[code] === 'number', `${code} missing from the table`);
  }
  assert.strictEqual(table.rates.USD, 1, 'the base must be asserted at 1');
  ok('every storable currency is present, and the base is 1');

  // ---- history, keyless ----------------------------------------------------
  const hist = await rateService.fetchAndStore({ orgId: org._id, dayKey: '2026-03-02' });
  assert.strictEqual(hist.dayKey, '2026-03-02');
  ok('a historical day is fetched on the same keyless endpoint');

  // ---- resolution ----------------------------------------------------------
  const mid = await rateService.rateTableOn('2026-03-15');
  assert.strictEqual(mid.dayKey, '2026-03-02', 'should resolve to the newest at or BEFORE');
  ok('a record resolves to the newest snapshot at or before its own day');

  const ancient = await rateService.rateTableOn('2020-01-01');
  assert.strictEqual(ancient, null, 'must refuse rather than reach forward');
  ok('a record older than every snapshot refuses, and never reaches forward');

  // ---- cadence -------------------------------------------------------------
  const due = await rateService.refreshIfDue(org._id);
  assert.strictEqual(due.skipped, true, 'a monthly workspace should skip once current');
  ok('the monthly cadence skips when the period already has a snapshot');

  // ---- the property the whole design exists for ----------------------------
  const march = await rateService.rateTableOn('2026-03-15');
  const now = await rateService.rateTableOn(null);
  const toUsd = (amt, t) => amt * (t.rates.USD / t.rates.INR);
  const marchValue = toUsd(100000, march);
  const nowValue = toUsd(100000, now);
  assert.ok(
    Math.abs(marchValue - nowValue) > 0.01,
    'the two months should not value identically, or this proves nothing'
  );
  // Re-reading March gives the same answer, today and forever.
  assert.strictEqual(toUsd(100000, await rateService.rateTableOn('2026-03-15')), marchValue);
  ok(
    `a March invoice holds its March value ($${marchValue.toFixed(2)}), ` +
      `while today's is $${nowValue.toFixed(2)}`
  );

  console.log('\nAll checks passed.\n');
  await mongoose.disconnect();
  await mem.stop();
};

/**
 * Guarded, like every other e2e in this directory.
 *
 * `capabilityUsage.test.js` sweeps every module under src/ and requires it, to
 * catch a dangling import or a cycle. Without this guard that sweep would BOOT
 * this script — opening a second Mongo on top of the one the sweep already has
 * — and the whole file would fail with a topology error that has nothing to do
 * with capabilities.
 */
if (require.main === module) {
  run().catch(async (err) => {
    console.error('FAILED:', err.message);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
}

module.exports = { run };
