/**
 * Monthly boards: converting a board to the type, and listing its months.
 *
 * Kept out of boardController.js, which is already ~1,300 lines. The write core
 * is [services/monthlyConvert.js](../services/monthlyConvert.js) and the refusal
 * rules are the pure [utils/monthlyConvert.js](../utils/monthlyConvert.js) —
 * both shared with `scripts/migrateMonthlyBoards.js`, so a preview approved in
 * the UI and a conversion run from the terminal cannot disagree.
 */

const Board = require('../models/Board');
const Task = require('../models/Task');
const { loadBoardContext, requireCapability } = require('../utils/boardContext');
const { checkConversion, describeEffects } = require('../utils/monthlyConvert');
const {
  buildPreview, convertBoard, countUnfiled, applyMonthKeys, partitionableTasks,
} = require('../services/monthlyConvert');
const {
  monthKeyOf, formatMonth, addMonths, compareMonthKeys, monthKeysBetween, isMonthKey,
} = require('../utils/monthKey');
const eventBus = require('../services/eventBus');
const { isValidTimezone } = require('../utils/tzDay');
const Goal = require('../models/Goal');
const { missingFinalValues, monthIsUnclosed } = require('../utils/goalTypes');

/**
 * POST /api/boards/:id/convert
 * body: { to: 'monthly' | 'standard', timezone?, dryRun?: boolean }
 *
 * Gated on `board.change_visibility`. Converting changes what the board IS —
 * the same family of lifecycle decision as flipping public/private, which
 * `updateBoard` already gates on this capability. Deliberately NOT
 * `column.manage`: that is an edit-rung capability every member holds on boards
 * they can edit, and month-partitioning a shared board is not an ordinary edit.
 */
const convertBoardType = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    const { to, timezone, dryRun } = req.body || {};

    const ctx = await loadBoardContext(id, userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

    const denied = requireCapability(
      ctx,
      'board.change_visibility',
      'You do not have permission to change this board’s type'
    );
    if (denied) return res.status(denied.status).json({ error: denied.error });

    const { board } = ctx;
    const verdict = checkConversion({ board, to, timezone });

    // A dry run always answers 200, even when the conversion is refused: the
    // refusal IS the answer the preview dialog is asking for, and rendering it
    // inline beats a toast that says "400".
    if (dryRun) {
      const preview = verdict.ok && !verdict.noop && to === 'monthly'
        ? await buildPreview(board, verdict.timezone)
        : { months: [], total: 0, alreadyStamped: 0, subitems: 0, noGroup: 0 };

      const simulated = verdict.ok && !verdict.noop && to === 'monthly'
        ? await applyMonthKeys(board._id, verdict.timezone, { dryRun: true })
        : null;

      return res.json({
        preview: {
          boardId: String(board._id),
          from: board.boardType,
          to,
          timezone: verdict.timezone,
          canConvert: verdict.ok && !verdict.noop,
          noop: verdict.noop,
          refusals: verdict.refusals,
          warnings: verdict.warnings,
          effects: verdict.ok ? describeEffects(to) : [],
          ...preview,
          wouldFile: simulated
            ? { tasks: simulated.topLevel, subitems: simulated.subitems }
            : null,
        },
      });
    }

    if (!verdict.ok) {
      return res.status(409).json({ error: verdict.refusals[0], refusals: verdict.refusals });
    }
    if (verdict.noop) {
      return res.json({ board, converted: false, reason: `Already a ${to} board` });
    }

    const result = await convertBoard(board, { to, timezone: verdict.timezone });

    // Nudge the actor's own open tabs to refetch, the same way an automation
    // that mutates a board out of band does.
    eventBus.emit('board.changed', { userId, boardId: String(board._id) });

    return res.json({
      board,
      converted: true,
      filed: {
        tasks: result.stamped.topLevel,
        subitems: result.stamped.subitems,
        orphanSubitems: result.stamped.orphanSubitems,
        sweptAfterFlip: result.sweptAfterFlip,
      },
      unfiled: to === 'monthly' ? await countUnfiled(board._id) : 0,
      warnings: verdict.warnings,
    });
  } catch (err) {
    console.error('convertBoardType error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * PUT /api/boards/:id/month-timezone
 * body: { timezone, dryRun?: boolean }
 *
 * Change which calendar defines a monthly board's months, and re-file every
 * task accordingly.
 *
 * THIS IS NOT A FIELD UPDATE, which is the whole reason it is its own endpoint
 * rather than a key on `updateBoard`. Every stored `monthKey` was derived from
 * the OLD zone's boundaries; move those boundaries and a task created near
 * midnight on the 1st is silently in the wrong month. So the timezone write and
 * the re-file have to happen together or not at all.
 *
 * `dryRun` answers "how many tasks would actually change month", because that
 * number is the only thing that makes this decision informed — and because a
 * re-file also overwrites months somebody moved by hand.
 *
 * Gated on `board.change_visibility`, the same lifecycle-decision capability
 * that converting the board answers to.
 */
const setMonthTimezone = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { timezone, dryRun } = req.body || {};

    const ctx = await loadBoardContext(req.params.id, userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

    const denied = requireCapability(
      ctx,
      'board.change_visibility',
      'You do not have permission to change this board’s timezone'
    );
    if (denied) return res.status(denied.status).json({ error: denied.error });

    const { board } = ctx;
    if (board.boardType !== 'monthly') {
      return res.status(404).json({ error: 'This board is not organised by month' });
    }
    if (!isValidTimezone(timezone)) {
      return res.status(400).json({ error: 'That is not a timezone this server recognises' });
    }

    const unchanged = timezone === board.monthTimezone;

    if (dryRun) {
      // Simulate against the REQUESTED zone, refiling everything, and report how
      // many rows would land in a different month than they sit in now.
      const sim = unchanged
        ? { topLevel: 0, subitems: 0, moved: 0, byMonth: new Map() }
        : await applyMonthKeys(board._id, timezone, { dryRun: true, refile: true });

      return res.json({
        preview: {
          from: board.monthTimezone,
          to: timezone,
          unchanged,
          tasks: sim.topLevel,
          subitems: sim.subitems,
          moved: sim.moved,
          months: [...sim.byMonth]
            .sort()
            .map(([monthKey, count]) => ({
              monthKey,
              label: formatMonth(monthKey, { long: true }),
              count,
            })),
        },
      });
    }

    if (unchanged) return res.json({ board, changed: false, moved: 0 });

    board.monthTimezone = timezone;
    await board.save();
    const result = await applyMonthKeys(board._id, timezone, { refile: true });

    eventBus.emit('board.changed', { userId, boardId: String(board._id) });

    return res.json({
      board,
      changed: true,
      moved: result.moved,
      refiled: result.topLevel + result.subitems,
    });
  } catch (err) {
    console.error('setMonthTimezone error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * GET /api/boards/:id/months
 *
 * The month dropdown. Every month from the board's earliest task through the
 * current month, plus one ahead so next month can be planned before it starts.
 *
 * The server owns this list rather than the client deriving it, for the same
 * reason `trackerService` says the client never does date arithmetic of its
 * own: "which month is it" depends on the board's timezone, and there is no
 * timezone-aware day math on the client at all. It also owns the LABELS, so the
 * Delivery grid and this dropdown can never disagree about what to call August.
 *
 * Gated on board read only — the Board tab needs the dropdown too, not just
 * Goals.
 */
const getBoardMonths = async (req, res) => {
  try {
    const ctx = await loadBoardContext(req.params.id, req.user.userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

    const { board } = ctx;
    if (board.boardType !== 'monthly') {
      return res.status(404).json({ error: 'This board is not a monthly board' });
    }

    const tz = board.monthTimezone || 'UTC';
    const currentKey = monthKeyOf(new Date(), tz);

    // Counts per month, and the floor, in one pass. No task documents loaded.
    const rows = await Task.aggregate([
      { $match: { ...partitionableTasks(board._id), parent: null, monthKey: { $ne: null } } },
      { $group: { _id: '$monthKey', count: { $sum: 1 } } },
    ]);
    const counts = new Map(rows.map((r) => [r._id, r.count]));

    const earliestFromTasks = rows
      .map((r) => r._id)
      .filter(isMonthKey)
      .sort(compareMonthKeys)[0];

    const floor = earliestFromTasks
      || monthKeyOf(board.createdAt, tz)
      || currentKey;
    const ceiling = addMonths(currentKey, 1);

    const keys = monthKeysBetween(
      compareMonthKeys(floor, currentKey) <= 0 ? floor : currentKey,
      ceiling
    );

    // Which past months still owe their final numbers? Only worth asking of
    // someone who can see goals at all, and bounded by the number of goals
    // rather than tasks — a board with no goals costs one empty query.
    const unclosedByMonth = new Map();
    if (ctx.can('goal.view')) {
      const columns = (board.goalColumns || []).filter((c) => !c.archived);
      const pastGoals = await Goal.find({
        board: board._id,
        monthKey: { $lt: currentKey },
      })
        .select('monthKey type config actual actualDayKey columnValues createdAt')
        .lean();

      const byMonth = new Map();
      for (const g of pastGoals) {
        if (!byMonth.has(g.monthKey)) byMonth.set(g.monthKey, []);
        byMonth.get(g.monthKey).push(g);
      }
      for (const [key, goals] of byMonth) {
        const missing = goals.filter((g) => missingFinalValues(g, columns).length > 0);
        if (monthIsUnclosed(key, currentKey, goals, columns)) {
          unclosedByMonth.set(key, missing.length);
        }
      }
    }

    const months = keys
      .map((key) => ({
        key,
        label: formatMonth(key, { long: true }),
        short: formatMonth(key),
        isCurrent: key === currentKey,
        isFuture: compareMonthKeys(key, currentKey) > 0,
        taskCount: counts.get(key) || 0,
        unclosed: unclosedByMonth.has(key),
        unclosedCount: unclosedByMonth.get(key) || 0,
      }))
      .reverse(); // newest first

    return res.json({
      months,
      currentKey,
      defaultKey: currentKey,
      timezone: tz,
      // Tasks that somehow have no month on a monthly board. Should be zero.
      // Surfaced rather than hidden: an unfiled task is invisible in every
      // month view, and silently losing rows is the worst thing this feature
      // could do.
      unfiled: { count: await countUnfiled(board._id) },
    });
  } catch (err) {
    console.error('getBoardMonths error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

module.exports = { convertBoardType, getBoardMonths, setMonthTimezone };
