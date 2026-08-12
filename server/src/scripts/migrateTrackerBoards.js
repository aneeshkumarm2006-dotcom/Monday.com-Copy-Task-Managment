/**
 * migrateMonthlyBoards.js
 *
 * Converts existing boards to the tracker board type, filing every task into
 * the calendar month it was created in.
 *
 * WHY THIS EXISTS: tracker boards partition tasks by `Task.monthKey`, and every
 * board that predates the feature has none. Without a backfill a converted
 * board looks empty in every single month — the tasks are all still there, they
 * are just filed nowhere.
 *
 * WHY `Task.createdAt` AND NOT THE ACTIVITY LOG: the activity log cannot answer
 * "which month was this task in". Group moves have NEVER been logged (both real
 * move paths go through `reorderTasks`, which writes `group` in a bulkWrite with
 * no logging call); activity logging started months after the repo did, so early
 * tasks have no `task.created` row at all; automation-created tasks write no row
 * ever; and `logActivity` swallows its own errors. `Task.createdAt` is universal,
 * immutable and indexed. It is the same signal the Trackers feature already
 * chose for this same problem.
 *
 * THE ONE THING TO KNOW BEFORE RUNNING IT: `createdAt` is when the task was
 * CREATED, not what month the work was FOR. A task created on 31 July for
 * August's work lands in July. Run with --dry-run first, read the histogram,
 * and expect to move a handful of tasks by hand afterwards.
 *
 * IDEMPOTENT. The criterion is "the task has no monthKey", not "the board is
 * standard" — so re-running is a no-op, a board converted in the app and then
 * re-run only picks up what was created since, and a month somebody corrected by
 * hand is never clobbered.
 *
 * `--refile` deliberately BREAKS that idempotency, and is the one case where
 * that is correct: changing a board's timezone moves the month boundaries every
 * stored monthKey was derived from, so a task created near midnight on the 1st
 * is now sitting in the wrong month. It rewrites every task, which also means it
 * overwrites months somebody moved by hand — so run the dry run first and read
 * the "would CHANGE month" count before committing.
 *     node src/scripts/migrateMonthlyBoards.js --board <id> \
 *          --timezone Asia/Calcutta --refile --dry-run
 *
 * DELIBERATELY NOT TOUCHED:
 *   - Client Portal boards. Refused outright, no override — a client would lose
 *     sight of their own open requests the moment the month rolled over.
 *   - Trackers and TrackerEntries. Never read, never written, never deleted.
 *   - Personal tasks. They have no board and are excluded by construction.
 *   - Custom roles and permissions. See grantGoalCapabilities.js for those.
 *
 * Run from the server directory:
 *   node src/scripts/migrateMonthlyBoards.js --report-trackers
 *   node src/scripts/migrateMonthlyBoards.js --board <id> --timezone Asia/Kolkata --dry-run
 *   node src/scripts/migrateMonthlyBoards.js --board <id> --timezone Asia/Kolkata
 *   node src/scripts/migrateMonthlyBoards.js --board <id> --revert
 */

require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
require('../models'); // register all schemas

const Board = require('../models/Board');
const Tracker = require('../models/Tracker');
const TrackerEntry = require('../models/TrackerEntry');
const { checkConversion } = require('../utils/trackerBoardConvert');
const {
  applyMonthKeys, buildPreview, convertBoard, countUnfiled,
} = require('../services/trackerBoardConvert');

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : null;
};

const dryRun = args.includes('--dry-run') || args.includes('-n');
const revert = args.includes('--revert');
// Re-derive EVERY task's month instead of only the unfiled ones. For when the
// board's timezone changed and the boundaries every stored monthKey came from
// have moved underneath them.
const refile = args.includes('--refile');
const reportTrackers = args.includes('--report-trackers');
const onlyBoardId = flag('--board');
const onlyOrgId = flag('--org');
const timezoneArg = flag('--timezone');

const prefix = dryRun ? '[DRY RUN] ' : '';

/**
 * Which boards currently have Trackers configured?
 *
 * Delivery is moving from an opt-in extra feature to a surface of the monthly
 * board type, which means standard boards LOSE the Delivery tab. Nothing is
 * deleted, but anyone relying on it is broken until their board is converted.
 * Run this BEFORE shipping the de-flag, not after.
 */
const runTrackerReport = async () => {
  const grouped = await Tracker.aggregate([
    {
      $group: {
        _id: '$board',
        trackers: { $sum: 1 },
        names: { $push: '$name' },
        timezones: { $addToSet: '$timezone' },
      },
    },
  ]);

  if (grouped.length === 0) {
    console.log('\nNo board has any Trackers configured. The de-flag is safe.\n');
    return;
  }

  const boards = await Board.find({ _id: { $in: grouped.map((g) => g._id) } })
    .select('name boardType organisation')
    .lean();
  const byId = new Map(boards.map((b) => [String(b._id), b]));

  // One pass for every board's entry count, rather than two queries per board.
  const entryCounts = new Map(
    (await TrackerEntry.aggregate([
      { $lookup: { from: 'trackers', localField: 'tracker', foreignField: '_id', as: 't' } },
      { $unwind: '$t' },
      { $group: { _id: '$t.board', entries: { $sum: 1 } } },
    ])).map((r) => [String(r._id), r.entries])
  );

  const rows = grouped.map((g) => ({
    board: byId.get(String(g._id)),
    g,
    entries: entryCounts.get(String(g._id)) || 0,
  }));
  // Boards with human confirmations are the highest-value conversions.
  rows.sort((a, b) => b.entries - a.entries);

  console.log(`\n${rows.length} board(s) have Trackers configured:\n`);
  for (const { board, g, entries } of rows) {
    const affected = board && board.boardType !== 'tracker';
    console.log(`  ${affected ? '⚠ ' : '  '}${board?.name ?? '(deleted board)'}  [${board?.boardType ?? '?'}]`);
    console.log(`      board:     ${g._id}`);
    console.log(`      trackers:  ${g.trackers} — ${g.names.join(', ')}`);
    console.log(`      entries:   ${entries} human confirmation(s)`);
    console.log(`      timezones: ${g.timezones.join(', ')}${g.timezones.length > 1 ? '  ← trackers disagree on zone' : ''}`);
  }
  console.log(
    '\n  ⚠ = this board is not monthly, so it will LOSE its Delivery tab.'
    + '\n      Convert it, or accept that its trackers become unreachable.'
    + '\n      No tracker data is deleted either way.\n'
  );
};

const convertOne = async (board) => {
  const to = revert ? 'standard' : 'tracker';
  const verdict = checkConversion({ board, to, timezone: timezoneArg });

  console.log(`  ${board.name}  [${board.boardType}]  ${board._id}`);

  if (!verdict.ok) {
    for (const r of verdict.refusals) console.log(`      REFUSED: ${r}`);
    return 'refused';
  }
  // An already-tracker board is normally a no-op — UNLESS we are refiling,
  // which is the whole point of that flag: the board type is already right and
  // it is the timezone underneath it that changed.
  if (verdict.noop && !(refile && to === 'tracker')) {
    console.log(`      already ${to} — nothing to do`);
    return 'noop';
  }
  for (const w of verdict.warnings) console.log(`      note: ${w}`);

  if (to === 'standard') {
    if (!dryRun) {
      board.boardType = 'standard';
      await board.save();
    }
    console.log('      reverted to standard (months, goals and trackers all kept)');
    return 'converted';
  }

  const preview = await buildPreview(board, verdict.timezone);
  console.log(`      timezone:  ${verdict.timezone}`);
  console.log(`      ${preview.total} top-level task(s), ${preview.subitems} subitem(s)`);
  if (preview.alreadyStamped > 0) {
    console.log(`      ${preview.alreadyStamped} already filed — will be left alone`);
  }
  if (preview.noGroup > 0) {
    console.log(`      ⚠ ${preview.noGroup} task(s) are in no group — they will be filed but render nowhere`);
  }
  for (const m of preview.months) {
    console.log(`        ${m.label.padEnd(16)} ${String(m.count).padStart(5)}`);
  }

  if (dryRun) {
    const sim = await applyMonthKeys(board._id, verdict.timezone, { dryRun: true, refile });
    console.log(
      `      would ${refile ? 're-file' : 'file'} ${sim.topLevel} task(s) `
      + `and ${sim.subitems} subitem(s)`
      + (refile ? `, ${sim.moved} of which would CHANGE month` : '')
    );
    return 'converted';
  }

  // A refile on an already-tracker board: the type is right, so only the stored
  // timezone and every task's month need rewriting.
  if (refile && board.boardType === 'tracker') {
    board.monthTimezone = verdict.timezone;
    await board.save();
    const sim = await applyMonthKeys(board._id, verdict.timezone, { refile: true });
    console.log(
      `      re-filed ${sim.topLevel} task(s) and ${sim.subitems} subitem(s) in `
      + `${verdict.timezone} — ${sim.moved} changed month`
    );
    for (const [monthKey, count] of [...sim.byMonth].sort()) {
      console.log(`        ${monthKey}  ${String(count).padStart(5)}`);
    }
    return 'converted';
  }

  const result = await convertBoard(board, { to, timezone: verdict.timezone });
  console.log(
    `      filed ${result.stamped.topLevel} task(s), ${result.stamped.subitems} subitem(s)`
    + (result.stamped.orphanSubitems > 0
      ? `, ${result.stamped.orphanSubitems} orphan subitem(s) fell back to their own date`
      : '')
  );
  if (result.sweptAfterFlip > 0) {
    console.log(`      swept ${result.sweptAfterFlip} task(s) created mid-conversion`);
  }
  const left = await countUnfiled(board._id);
  if (left > 0) console.log(`      ⚠ ${left} task(s) still have no month`);
  return 'converted';
};

const run = async () => {
  await connectDB();

  if (reportTrackers) {
    await runTrackerReport();
    await mongoose.disconnect();
    return;
  }

  const filter = {};
  if (onlyBoardId) filter._id = onlyBoardId;
  if (onlyOrgId) filter.organisation = onlyOrgId;
  if (!onlyBoardId && !onlyOrgId) {
    console.error(
      '\nRefusing to convert every board in the database.'
      + '\nPass --board <id> or --org <id>. Use --report-trackers to see candidates.\n'
    );
    await mongoose.disconnect();
    process.exit(1);
  }

  const boards = await Board.find(filter);
  console.log(
    `\n${prefix}${revert ? 'Reverting' : 'Converting'} ${boards.length} board(s)`
    + `${revert ? '' : ` to monthly${timezoneArg ? ` in ${timezoneArg}` : ''}`}\n`
  );

  const tally = { converted: 0, refused: 0, noop: 0 };
  for (const board of boards) {
    // eslint-disable-next-line no-await-in-loop
    tally[await convertOne(board)] += 1;
  }

  console.log(
    `\n${prefix}Done. ${tally.converted} converted, `
    + `${tally.noop} already done, ${tally.refused} refused.\n`
  );
  if (dryRun) console.log('No changes were written. Re-run without --dry-run to apply.\n');

  await mongoose.disconnect();
};

run().catch((err) => {
  console.error('migrateMonthlyBoards failed:', err);
  process.exit(1);
});
