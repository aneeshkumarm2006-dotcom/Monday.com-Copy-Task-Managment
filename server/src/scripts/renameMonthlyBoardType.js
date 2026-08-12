/**
 * renameMonthlyBoardType.js
 *
 * One-off: rewrites `Board.boardType` from the old `'monthly'` value to
 * `'tracker'`.
 *
 * WHY THIS IS NOT OPTIONAL. The board type was renamed in code — the enum on
 * `Board.boardType` no longer accepts `'monthly'`, and every check in the app
 * now compares against `'tracker'`. A board left on the old value is broken in
 * two directions at once: it loses its month picker, its Delivery tab and its
 * Goals tab (every gate reads `boardType === 'tracker'` and gets false), and the
 * next time anything saves that document Mongoose rejects it for failing the
 * enum. Nothing else about the board changes — tasks keep their `monthKey`, the
 * timezone stays, goals and trackers are untouched.
 *
 * Idempotent: it matches on the old value, so a second run finds nothing.
 *
 * Run from the server directory:
 *   node src/scripts/renameMonthlyBoardType.js --dry-run
 *   node src/scripts/renameMonthlyBoardType.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
require('../models');

const Board = require('../models/Board');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run') || args.includes('-n');

const run = async () => {
  await connectDB();

  // Query the raw collection rather than through the model: `'monthly'` is no
  // longer in the enum, so a model-level find still works but any doc we then
  // `.save()` would fail validation. A direct updateMany sidesteps that
  // entirely — which is exactly what a value rename needs.
  const collection = mongoose.connection.collection(Board.collection.name);
  const stale = await collection
    .find({ boardType: 'monthly' })
    .project({ name: 1, monthTimezone: 1 })
    .toArray();

  console.log(
    `\n${dryRun ? '[DRY RUN] ' : ''}Renaming boardType 'monthly' → 'tracker' `
    + `on ${stale.length} board(s)\n`
  );

  for (const b of stale) {
    console.log(`  ${b.name}  (${b._id})  tz: ${b.monthTimezone || '—'}`);
  }

  if (stale.length === 0) {
    console.log('  Nothing to do — no board is still on the old value.\n');
    await mongoose.disconnect();
    return;
  }

  if (!dryRun) {
    const res = await collection.updateMany(
      { boardType: 'monthly' },
      { $set: { boardType: 'tracker' } }
    );
    console.log(`\nDone. ${res.modifiedCount} board(s) updated.\n`);
  } else {
    console.log('\nNo changes were written. Re-run without --dry-run to apply.\n');
  }

  await mongoose.disconnect();
};

run().catch((err) => {
  console.error('renameMonthlyBoardType failed:', err);
  process.exit(1);
});
