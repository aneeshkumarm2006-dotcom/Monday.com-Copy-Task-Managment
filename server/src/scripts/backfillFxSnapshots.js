/**
 * backfillFxSnapshots.js
 *
 * Fetches one exchange-rate snapshot per past period, so records that already
 * exist convert at the rate that was actually in force when they were made.
 *
 * WHY THIS IS WORTH RUNNING: without it, the oldest snapshot is whenever this
 * feature shipped, and `snapshotFor` deliberately REFUSES to reach forward —
 * so every invoice raised before today simply renders in its own currency,
 * unconverted, forever. That is safe (it never shows a wrong number) but it is
 * also useless on a board with a year of history. One run fixes the whole past.
 *
 * WHY IT IS POSSIBLE AT ALL: the default provider's historical endpoint is
 * keyless, on the same URL as the latest one — `?base=USD&date=2026-03-15`.
 * Verified live while this was written. There is no account, no quota and no
 * charge for asking about 2019.
 *
 * IDEMPOTENT: `FxSnapshot` is unique on `(base, dayKey)` and the write is an
 * upsert, so a second run updates in place rather than duplicating. Nobody has
 * to track which months were already done. Safe to run twice, or never.
 *
 * ONE FETCH SERVES EVERY WORKSPACE, because the snapshots are global — a rate
 * is a public fact. The `--org` flag picks whose PROVIDER and credential to
 * use, not who the rows are for.
 *
 * Run from the server directory:
 *     npm run migrate:fx-backfill
 *     node src/scripts/backfillFxSnapshots.js [--months 24] [--org <orgId>] [--daily] [--dry-run]
 */

require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
require('../models'); // register all schemas

const Organisation = require('../models/Organisation');
const FxSnapshot = require('../models/FxSnapshot');
const { fetchAndStore, todayKey } = require('../services/fx/rateService');
const { FX_BASE } = require('../utils/money');
const { FxError } = require('../services/fx/errors');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const daily = args.includes('--daily');

const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const months = Number(flag('--months', '24'));
const onlyOrgId = flag('--org', null);

/**
 * The days to ask about, oldest first.
 *
 * Monthly by default — the FIRST of each month, which is exactly what a record
 * dated anywhere in that month resolves to under "newest snapshot at or before
 * this day". Asking for 730 individual days to get the same answers would be a
 * discourtesy to a free endpoint.
 *
 * `--daily` is there for a workspace that genuinely tracks the market and wants
 * a dense history. It is deliberately not the default.
 */
const daysToFetch = () => {
  const out = [];
  const now = new Date();

  if (daily) {
    const total = Math.round(months * 30.44);
    for (let i = total; i >= 1; i -= 1) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
      out.push(d.toISOString().slice(0, 10));
    }
    return out;
  }

  for (let i = months; i >= 1; i -= 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
};

const run = async () => {
  if (!Number.isFinite(months) || months <= 0) {
    console.error('--months must be a positive number');
    process.exit(1);
  }

  await connectDB();

  const org = onlyOrgId
    ? await Organisation.findById(onlyOrgId).select('_id name fx').lean()
    : await Organisation.findOne({}).select('_id name fx').lean();

  if (!org) {
    console.error('No workspace found to borrow a provider from.');
    await mongoose.connection.close();
    process.exit(1);
  }

  const days = daysToFetch();
  const existing = new Set(
    (await FxSnapshot.find({ base: FX_BASE }).select('dayKey').lean()).map((r) => r.dayKey)
  );

  console.log(
    `Backfilling ${days.length} ${daily ? 'days' : 'months'} of ${FX_BASE} rates ` +
      `using ${org.name}'s provider (${org.fx?.provider || 'frankfurter'}).`
  );
  console.log(`Today is ${todayKey()}. ${existing.size} snapshot(s) already stored.`);
  if (dryRun) console.log('--dry-run: nothing will be written.\n');

  let stored = 0;
  let skipped = 0;
  let failed = 0;

  for (const dayKey of days) {
    // A day we already hold is skipped rather than re-fetched. The upsert would
    // make it harmless, but there is no reason to spend the request.
    if (existing.has(dayKey)) {
      skipped += 1;
      continue;
    }
    if (dryRun) {
      console.log(`  would fetch ${dayKey}`);
      stored += 1;
      continue;
    }

    try {
      const result = await fetchAndStore({ orgId: org._id, dayKey });
      // The day it lands under can differ from the day asked for — a weekend
      // request is answered with the previous business day, and we file the
      // provider's answer rather than our question.
      console.log(`  ${dayKey} -> ${result.dayKey} (${result.count} rates)`);
      existing.add(result.dayKey);
      stored += 1;
    } catch (err) {
      failed += 1;
      const msg = err instanceof FxError ? err.toDisplay() : err.message;
      console.error(`  ${dayKey}: ${msg}`);
      // A provider that needs configuration will fail identically for every
      // remaining day, so stop rather than printing the same sentence 24 times.
      if (err instanceof FxError && err.needsConfig) {
        console.error('\nThis will fail the same way for every date. Stopping.');
        break;
      }
    }
  }

  console.log(`\nDone. stored ${stored}, already had ${skipped}, failed ${failed}.`);
  await mongoose.connection.close();
};

run().catch(async (err) => {
  console.error('backfillFxSnapshots failed:', err);
  await mongoose.connection.close().catch(() => {});
  process.exit(1);
});
