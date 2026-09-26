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
 * YOU MAY NOT NEED TO: `services/fxRateRunner.js` now runs the same backfill
 * once at boot whenever the stored history is shallow (see `isShallowHistory`
 * in services/fx/rateService.js). This script is still the way to ask for more
 * than the runner's two years, for `--daily` density, or to borrow a particular
 * workspace's provider.
 *
 * WHY IT IS POSSIBLE AT ALL: the default provider's historical endpoint is
 * keyless, on the same URL as the latest one — `?base=USD&date=2026-03-15`.
 * Verified live while this was written. There is no account, no quota and no
 * charge for asking about 2019.
 *
 * IDEMPOTENT: `FxSnapshot` is unique on `(base, dayKey)` and the write is an
 * upsert, so a second run updates in place rather than duplicating. And a day
 * already answered is not asked again — including a Sunday the 1st whose answer
 * was filed under Friday the 30th (`backfillPlan`). Safe to run twice, or never.
 *
 * ONE FETCH SERVES EVERY WORKSPACE, because the snapshots are global — a rate
 * is a public fact. The `--org` flag picks whose PROVIDER and credential to
 * use, not who the rows are for.
 *
 * The policy — which days, which to skip, when to give up — lives in
 * services/fx/rateService.js (`daysToFetch`, `backfillPlan`, `backfillHistory`)
 * and is shared with the runner. This file is only the command line around it,
 * and it still exports `daysToFetch` for anything that required it from here.
 *
 * Run from the server directory:
 *     npm run migrate:fx-backfill
 *     node src/scripts/backfillFxSnapshots.js [--months 24] [--org <orgId>] [--daily] [--dry-run]
 */

const mongoose = require('mongoose');
const {
  todayKey,
  daysToFetch,
  backfillPlan,
  backfillHistory,
  PUBLICATION_SLACK_DAYS,
} = require('../services/fx/rateService');
const { FX_BASE } = require('../utils/money');

/**
 * Parse the command line. Pure, so the flags can be read without a database.
 *
 * @param {string[]} args  process.argv.slice(2)
 */
const parseArgs = (args = []) => {
  const flag = (name, fallback) => {
    const i = args.indexOf(name);
    return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
  };
  return {
    dryRun: args.includes('--dry-run'),
    daily: args.includes('--daily'),
    months: Number(flag('--months', '24')),
    onlyOrgId: flag('--org', null),
  };
};

const run = async ({ dryRun, daily, months, onlyOrgId }) => {
  if (!Number.isFinite(months) || months <= 0) {
    console.error('--months must be a positive number');
    process.exit(1);
  }

  require('dotenv').config();
  const connectDB = require('../config/db');
  require('../models'); // register all schemas
  const Organisation = require('../models/Organisation');
  const FxSnapshot = require('../models/FxSnapshot');

  await connectDB();

  const org = onlyOrgId
    ? await Organisation.findById(onlyOrgId).select('_id name fx').lean()
    : await Organisation.findOne({}).select('_id name fx').lean();

  if (!org) {
    console.error('No workspace found to borrow a provider from.');
    await mongoose.connection.close();
    process.exit(1);
  }

  const days = daysToFetch({ months, daily });
  const held = (await FxSnapshot.find({ base: FX_BASE }).select('dayKey').lean()).map((r) => r.dayKey);
  // A day we already hold is skipped rather than re-fetched. The upsert would
  // make it harmless, but there is no reason to spend the request. A monthly
  // run also counts a snapshot a few days BEFORE the 1st as the 1st's answer;
  // a daily one does not, since there the day before is a different rate.
  const todo = backfillPlan(days, held, { slack: daily ? 0 : PUBLICATION_SLACK_DAYS });

  console.log(
    `Backfilling ${days.length} ${daily ? 'days' : 'months'} of ${FX_BASE} rates ` +
      `using ${org.name}'s provider (${org.fx?.provider || 'frankfurter'}).`
  );
  console.log(`Today is ${todayKey()}. ${held.length} snapshot(s) already stored.`);
  if (dryRun) console.log('--dry-run: nothing will be written.\n');

  const result = await backfillHistory({
    orgId: org._id,
    days: todo,
    dryRun,
    log: (line) => console.log(line),
    logError: (line) => console.error(line),
  });
  // A provider that needs configuration fails identically for every remaining
  // day, so the loop stops rather than printing the same sentence 24 times.
  if (result.stopped === 'needs-config') {
    console.error('\nThis will fail the same way for every date. Stopping.');
  }

  console.log(
    `\nDone. stored ${result.stored}, already had ${days.length - todo.length}, failed ${result.failed}.`
  );
  await mongoose.connection.close();
};

module.exports = { parseArgs, daysToFetch };

// Run only when invoked directly, so requiring this file (a test, or anything
// that wants `parseArgs`) never connects to the database named in server/.env.
if (require.main === module) {
  run(parseArgs(process.argv.slice(2))).catch(async (err) => {
    console.error('backfillFxSnapshots failed:', err);
    await mongoose.connection.close().catch(() => {});
    process.exit(1);
  });
}
