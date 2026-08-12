/**
 * Converting a board to (or from) the monthly type, and backfilling the month
 * every existing task belongs to.
 *
 * Shared by `POST /api/boards/:id/convert` and
 * `scripts/migrateMonthlyBoards.js`, so the preview a user approves and the
 * write a script performs can never disagree. The refusal RULES live in the pure
 * [utils/monthlyConvert.js](../utils/monthlyConvert.js); this file only does the
 * work once those rules have said yes.
 *
 * WHY `Task.createdAt` IS THE SIGNAL, and not the ActivityLog: the activity log
 * cannot answer "which month was this task in", for four independent reasons.
 * Group moves have never been logged at all — the only writer of
 * `field: 'group'` is reachable via `PUT /api/tasks/:id` with `group` in the
 * body, and no client sends that; both real move paths go through
 * `reorderTasks`, which writes `group` in a `bulkWrite` with no logging.
 * Activity logging began well after this repo did, so early tasks have no
 * `task.created` row. Automation-created tasks write no row ever. And
 * `logActivity` swallows its own errors. `Task.createdAt` is universal,
 * immutable and indexed, and it is the same signal the Trackers feature already
 * chose for this exact problem.
 */

const Task = require('../models/Task');
const { monthKeyOf, formatMonth } = require('../utils/monthKey');

/** Tasks that participate in month partitioning at all. */
const partitionableTasks = (boardId) => ({
  board: boardId,
  isPersonal: { $ne: true },
});

/**
 * Tasks still needing a month. `{ monthKey: null }` matches BOTH an explicit
 * null and a missing field, which is what makes this idempotent across boards
 * that predate the field and boards created after it.
 */
const unfiled = (boardId) => ({ ...partitionableTasks(boardId), monthKey: null });

/**
 * The month histogram, WITHOUT loading a single task document.
 *
 * Note the second month implementation here: `$dateToString` with a `timezone`
 * is Mongo's own bucketing, not `dayKeyOf`. That is deliberate and it is
 * confined to this function. tzDay.js warns against exactly this kind of
 * duplicate, so the containment matters: the preview may disagree with the
 * write by a task or two at a month boundary, but only the WRITE path
 * (`applyMonthKeys`) ever touches stored data, and it uses `dayKeyOf` alone.
 * Never reuse this aggregation to decide what to save.
 */
const previewMonths = async (boardId, timezone) => {
  const rows = await Task.aggregate([
    { $match: { ...partitionableTasks(boardId), parent: null } },
    {
      $group: {
        _id: {
          $ifNull: [
            '$monthKey',
            { $dateToString: { date: '$createdAt', format: '%Y-%m', timezone } },
          ],
        },
        count: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  return rows
    .filter((r) => typeof r._id === 'string')
    .map((r) => ({ monthKey: r._id, label: formatMonth(r._id, { long: true }), count: r.count }));
};

/** Counts for the preview panel, cheap enough to run alongside the histogram. */
const previewCounts = async (boardId) => {
  const [total, alreadyStamped, subitems, noGroup] = await Promise.all([
    Task.countDocuments({ ...partitionableTasks(boardId), parent: null }),
    Task.countDocuments({ ...partitionableTasks(boardId), monthKey: { $ne: null } }),
    Task.countDocuments({ ...partitionableTasks(boardId), parent: { $ne: null } }),
    Task.countDocuments({ ...partitionableTasks(boardId), group: null }),
  ]);
  return { total, alreadyStamped, subitems, noGroup };
};

const BATCH = 500;

const flush = async (ops) => {
  if (ops.length === 0) return;
  await Task.bulkWrite(ops, { ordered: false });
};

/**
 * Stamp `monthKey` on every task on the board that lacks one.
 *
 * Two passes, because subitems inherit their parent's month rather than
 * deriving their own — a subitem added in September to an August task does not
 * make that work September's. A subitem whose parent has vanished falls back to
 * its own `createdAt` rather than being left unfiled, since an unfiled task is
 * invisible in every month view.
 *
 * Uses `bulkWrite`, which bypasses `pre('save')`. That is correct here: the only
 * save hook on Task is the flexible-columns back-projection, which reads
 * `columnValues` and we are not writing those. Do not rewrite this as
 * `doc.save()` in a loop — on a three-year board that is thousands of round
 * trips and it would fire that hook needlessly on every one.
 *
 * @returns {{ topLevel, subitems, orphanSubitems, byMonth: Map<string, number> }}
 */
const applyMonthKeys = async (boardId, timezone, { dryRun = false, refile = false } = {}) => {
  const byMonth = new Map();
  const bump = (mk) => byMonth.set(mk, (byMonth.get(mk) || 0) + 1);

  // `refile` recomputes EVERY task instead of only the unfiled ones. It exists
  // for one case: the board's timezone changed, so the boundaries every existing
  // monthKey was derived from have moved and a task created near midnight on the
  // 1st is now in the wrong month. It is not the default precisely because it
  // also overwrites any month somebody corrected by hand.
  const scope = refile ? partitionableTasks(boardId) : unfiled(boardId);

  // ---- Pass 1: top-level tasks, from their own createdAt --------------------
  const parents = await Task.find({ ...scope, parent: null })
    .select('_id createdAt monthKey')
    .lean();

  let ops = [];
  let topLevel = 0;
  let moved = 0;
  // What pass 1 decided, so pass 2 can inherit the NEW month rather than
  // re-reading a parent's stale one (which on a dry run was never overwritten).
  const computedParentMonth = new Map();

  for (const t of parents) {
    const monthKey = monthKeyOf(t.createdAt, timezone);
    if (!monthKey) continue; // no createdAt at all — leave unfiled, counted below
    bump(monthKey);
    topLevel += 1;
    computedParentMonth.set(String(t._id), monthKey);
    if (t.monthKey && t.monthKey !== monthKey) moved += 1;
    if (dryRun) continue;
    ops.push({ updateOne: { filter: { _id: t._id }, update: { $set: { monthKey } } } });
    if (ops.length >= BATCH) { await flush(ops); ops = []; }
  }
  if (!dryRun) await flush(ops);

  // ---- Pass 2: subitems inherit the parent's month --------------------------
  const children = await Task.find({ ...scope, parent: { $ne: null } })
    .select('_id createdAt parent')
    .lean();

  let subitems = 0;
  let orphanSubitems = 0;

  if (children.length > 0) {
    // Read parents back rather than trusting the in-memory map: a parent may
    // already have had a monthKey (so it was not in pass 1's result set), or may
    // have been hand-corrected to a different month than its createdAt implies.
    // A month pass 1 just computed WINS, though — on a refile the stored value
    // is exactly the stale one we are replacing.
    const parentIds = [...new Set(children.map((c) => String(c.parent)))];
    const parentRows = await Task.find({ _id: { $in: parentIds } })
      .select('_id monthKey createdAt')
      .lean();
    const parentMonth = new Map(
      parentRows.map((p) => [
        String(p._id),
        computedParentMonth.get(String(p._id))
          || p.monthKey
          || monthKeyOf(p.createdAt, timezone),
      ])
    );

    ops = [];
    for (const c of children) {
      let monthKey = parentMonth.get(String(c.parent));
      if (!monthKey) {
        monthKey = monthKeyOf(c.createdAt, timezone);
        orphanSubitems += 1;
      }
      if (!monthKey) continue;
      subitems += 1;
      if (dryRun) continue;
      ops.push({ updateOne: { filter: { _id: c._id }, update: { $set: { monthKey } } } });
      if (ops.length >= BATCH) { await flush(ops); ops = []; }
    }
    if (!dryRun) await flush(ops);
  }

  return { topLevel, subitems, orphanSubitems, moved, byMonth };
};

/**
 * Build the dry-run payload the confirm dialog renders. Read-only.
 */
const buildPreview = async (board, timezone) => {
  const [months, counts] = await Promise.all([
    previewMonths(board._id, timezone),
    previewCounts(board._id),
  ]);
  return { months, ...counts };
};

/**
 * Perform the conversion. Assumes `checkConversion` has already said yes.
 *
 * Order matters: stamp the months FIRST, set `boardType` LAST, then sweep once
 * more. A task created by a teammate between the stamp and the flip would
 * otherwise have no month and be invisible in every month view — this is not
 * transactional, so the second sweep is the mitigation. The remaining gap is
 * reported by the `unfiled` count on the months endpoint rather than being
 * hidden.
 */
const convertBoard = async (board, { to, timezone }) => {
  let stamped = { topLevel: 0, subitems: 0, orphanSubitems: 0, byMonth: new Map() };

  if (to === 'monthly') {
    stamped = await applyMonthKeys(board._id, timezone);
    board.monthTimezone = timezone;
  }

  board.boardType = to;
  await board.save();

  let swept = null;
  if (to === 'monthly') {
    // Anything created mid-flight. Usually zero; when it is not, silently
    // losing those rows would be the worst failure this feature could have.
    swept = await applyMonthKeys(board._id, timezone);
  }

  return {
    stamped,
    sweptAfterFlip: swept ? swept.topLevel + swept.subitems : 0,
  };
};

/** Tasks left with no month on a monthly board. Should be zero; surfaced if not. */
const countUnfiled = (boardId) => Task.countDocuments(unfiled(boardId));

module.exports = {
  applyMonthKeys,
  buildPreview,
  convertBoard,
  countUnfiled,
  previewMonths,
  previewCounts,
  unfiled,
  partitionableTasks,
};
