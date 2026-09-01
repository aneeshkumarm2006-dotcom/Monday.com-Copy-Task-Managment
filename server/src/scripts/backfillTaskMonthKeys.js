/**
 * backfillTaskMonthKeys.js
 *
 * Files tracker-board tasks that were created with no `monthKey` into a month.
 *
 * WHY THESE EXIST: three `Task.create` sites in automationController never set
 * `monthKey`, and `runAutomationOnce` loaded the board with `.select('statuses')`
 * so it could not have set one anyway. Five daily SCHEDULE automations produced
 * one such task per group per day.
 *
 * WHY IT MATTERS: on a tracker board `getTasks` filters `monthKey: month`, so a
 * task with none is INVISIBLE on every month of its own board — and
 * `goalEvidence.isAttachable` refuses it, so the task panel hides the Goal
 * section and it can never be attached to a goal. The rows are not lost, they
 * are unreachable.
 *
 * WHICH MONTH: `monthKeyOf(createdAt, board.monthTimezone)` — the month the task
 * was actually made, in the board's own timezone. For a daily automation that is
 * exactly right: the blog task spawned on 20 August is August's work. Derived
 * per task, never a blanket "current month", so a run today does not sweep
 * three weeks of August into September.
 *
 * A subitem takes its PARENT's month instead, which is the same rule
 * `createTask` and `moveTasksToMonth` already apply — a subitem is part of the
 * parent's work and must never sit in a different month from it.
 *
 * Only touches tasks on `boardType: 'tracker'` boards where `monthKey` is
 * null/absent. Idempotent: a second run finds nothing.
 *
 * Run from the server directory:
 *     node src/scripts/backfillTaskMonthKeys.js [--board <boardId>] [--apply]
 *
 * Dry run by DEFAULT — it prints what it would do and writes nothing unless
 * you pass --apply.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
require('../models'); // register all schemas

const Board = require('../models/Board');
const Task = require('../models/Task');
const { monthKeyOf } = require('../utils/monthKey');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const boardFlagIndex = args.indexOf('--board');
const onlyBoardId = boardFlagIndex !== -1 ? args[boardFlagIndex + 1] : null;

const run = async () => {
  await connectDB();

  const boardFilter = { boardType: 'tracker' };
  if (onlyBoardId) boardFilter._id = onlyBoardId;
  const boards = await Board.find(boardFilter)
    .select('name monthTimezone')
    .lean();

  console.log(
    `\n${apply ? '' : '[DRY RUN] '}Backfilling monthKey across `
    + `${boards.length} tracker board(s)\n`
  );

  let total = 0;
  let skipped = 0;

  for (const board of boards) {
    const tz = board.monthTimezone || 'UTC';
    const orphans = await Task.find({
      board: board._id,
      isPersonal: { $ne: true },
      $or: [{ monthKey: null }, { monthKey: { $exists: false } }],
    })
      .select('_id name parent createdAt')
      .lean();

    if (!orphans.length) continue;

    console.log(`${board.name}  (tz ${tz}) — ${orphans.length} task(s)`);

    // Parents first, so a subitem whose parent is ALSO being backfilled can
    // read the month its parent just received rather than inheriting a null.
    const parentMonths = new Map();
    const ordered = [
      ...orphans.filter((t) => !t.parent),
      ...orphans.filter((t) => t.parent),
    ];

    for (const task of ordered) {
      let monthKey;
      if (task.parent) {
        const key = String(task.parent);
        if (parentMonths.has(key)) {
          monthKey = parentMonths.get(key);
        } else {
          const parent = await Task.findById(task.parent)
            .select('monthKey')
            .lean();
          monthKey = parent?.monthKey || null;
        }
        // A parent with no month either (already handled above) or a missing
        // parent leaves nothing to inherit — fall back to the task's own date.
        if (!monthKey) monthKey = monthKeyOf(task.createdAt, tz);
      } else {
        monthKey = monthKeyOf(task.createdAt, tz);
      }

      if (!monthKey) {
        console.log(`   SKIP  (no createdAt)  ${task.name}`);
        skipped += 1;
        continue;
      }

      console.log(
        `   ${monthKey}  ${task.parent ? '(subitem) ' : ''}${task.name}`
      );
      if (apply) {
        await Task.updateOne({ _id: task._id }, { $set: { monthKey } });
      }
      if (!task.parent) parentMonths.set(String(task._id), monthKey);
      total += 1;
    }
    console.log('');
  }

  console.log(
    `${apply ? 'Filed' : 'Would file'} ${total} task(s)`
    + (skipped ? `, skipped ${skipped}` : '')
  );
  if (!apply && total) console.log('Re-run with --apply to write.\n');

  await mongoose.disconnect();
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
