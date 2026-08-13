/**
 * The People scoreboard — a tracker board's month, per person.
 *
 * Every group on a tracker board already carries a score: goals from
 * [utils/goalTypes.js](../utils/goalTypes.js), delivery from
 * [utils/trackerEvaluate.js](../utils/trackerEvaluate.js) by way of
 * [services/deliveryReport.js](../services/deliveryReport.js). Once a group has
 * an owner ([utils/groupOwner.js](../utils/groupOwner.js)) those scores answer a
 * question no view could ask before: how did each PERSON do this month.
 *
 * Nothing is scored here. This file gates, queries, and hands the pieces to
 * [utils/scoreboard.js](../utils/scoreboard.js) — which itself calls
 * `scoreBoard()` verbatim rather than averaging anything of its own, so a
 * person's number and the Goals tab's number are the same arithmetic.
 *
 * THE GATES, in the same order as goalController and trackerController:
 *   1. loadBoardContext  — can you reach this board at all?
 *   2. goal.view         — does your role permit the goals half?
 *   3. boardType         — 404 on a standard board; it has no People to score.
 *
 * Then TWO capability-shaped narrowings rather than refusals, both borrowed
 * whole from productivityController because this is the same social question it
 * already answered:
 *
 *   productivity.view_others — without it you get ONLY YOUR OWN ROW
 *                              (`scope: 'self'`). A ranked, named table of
 *                              colleagues is a different artefact from a
 *                              client-delivery grid, and this codebase already
 *                              has a considered answer for who may see one. It
 *                              is an existing checkbox in the roles matrix, so
 *                              no new capability and no migration.
 *   tracker.view             — without it the delivery half is ABSENT
 *                              (`sections.delivery: false`), never zeroed. Zero
 *                              missed and unknown missed are different facts.
 */

const mongoose = require('mongoose');
const User = require('../models/User');
const Goal = require('../models/Goal');
const Tracker = require('../models/Tracker');
const TaskGroup = require('../models/TaskGroup');

const { loadBoardContext, requireCapability } = require('../utils/boardContext');
const { scoreGroup, scoreGoal } = require('../utils/goalTypes');
const { ownerForMonth } = require('../utils/groupOwner');
const { foldDeliveryByGroup, buildScoreboard } = require('../utils/scoreboard');
const {
  planDelivery,
  fetchDeliveryInputs,
  evaluatePlans,
} = require('../services/deliveryReport');
const {
  isMonthKey,
  monthKeyOf,
  monthKeyOfDayKey,
  firstDayKeyOf,
  lastDayKeyOf,
} = require('../utils/monthKey');
const { minDayKey, dayKeyOf } = require('../utils/tzDay');

const NOT_TRACKER = 'This board is not a tracker board.';

/**
 * A CPU guard, deliberately NOT the Delivery grid's MAX_CELLS.
 *
 * MAX_CELLS is 5,000 because a grid ships every cell to the browser and 18,000
 * of them is a 1.5MB payload. This endpoint ships no cells at all — only
 * per-person aggregates — so reusing that number would REJECT a legitimate
 * request: 200 groups x 31 daily periods is 6,200 and a 200-client board asking
 * for its own monthly scoreboard would 400 for no reason. A month window is
 * inherently bounded (<=31 daily, <=6 weekly, 1-2 monthly periods), so the
 * practical worst case is groups x 31 x trackers.
 */
const MAX_EVAL_CELLS = 20000;

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

/** The three gates, in order. Returns the context, or null having answered. */
const gate = async (req, res, capability) => {
  const boardId = req.params.boardId;
  if (!isValidId(boardId)) {
    res.status(400).json({ error: 'Invalid board id' });
    return null;
  }
  const ctx = await loadBoardContext(boardId, req.user.userId);
  if (ctx.error) {
    res.status(ctx.status).json({ error: ctx.error });
    return null;
  }
  const denied = requireCapability(ctx, capability);
  if (denied) {
    res.status(denied.status).json({ error: denied.error });
    return null;
  }
  // 404, not 403: on a standard board there is no scoreboard to be refused.
  if (ctx.board?.boardType !== 'tracker') {
    res.status(404).json({ error: NOT_TRACKER, code: 'NOT_TRACKER_BOARD' });
    return null;
  }
  return ctx;
};

/**
 * GET /api/boards/:boardId/scoreboard?month=YYYY-MM
 *
 * Two round trips after the gate, mirroring getDelivery's batching: everything
 * that does not depend on a previous result is issued together.
 */
const getScoreboard = async (req, res) => {
  try {
    const ctx = await gate(req, res, 'goal.view');
    if (!ctx) return undefined;

    const { board } = ctx;
    const month = req.query.month;
    if (!isMonthKey(month)) {
      return res.status(400).json({ error: 'A month (YYYY-MM) is required' });
    }

    const tz = board.monthTimezone || 'UTC';
    const now = new Date();
    const currentKey = monthKeyOf(now, tz);
    const canSeeOthers = ctx.can('productivity.view_others');
    const canSeeDelivery = ctx.can('tracker.view');
    const selfId = String(req.user.userId);

    // BATCH 1. Groups carry `ownerTimeline` here — the ONE place outside
    // groupController that reads it, and it never leaves this function.
    const [groups, goals, trackers] = await Promise.all([
      TaskGroup.find({ board: board._id })
        .select('name order createdAt ownerTimeline')
        .sort({ order: 1, createdAt: 1 })
        .lean(),
      Goal.find({ board: board._id, monthKey: month })
        .select('group type config unit unitLabel actual actualDayKey weight')
        .lean(),
      canSeeDelivery
        ? Tracker.find({ board: board._id }).sort({ createdAt: 1 }).lean()
        : [],
    ]);

    // Resolve ownership for the requested month. Carry-forward is structural —
    // see utils/groupOwner.js; nothing here needs to know how it works.
    const ownerByGroupId = new Map();
    for (const g of groups) {
      const owner = ownerForMonth(g, month);
      ownerByGroupId.set(String(g._id), {
        userId: owner.userId,
        inherited: owner.inherited,
      });
    }

    // Goal summaries per group, via the ONLY scorer.
    const goalsByGroup = new Map(groups.map((g) => [String(g._id), []]));
    for (const goal of goals) {
      const list = goalsByGroup.get(String(goal.group));
      if (list) list.push({ ...goal, computed: scoreGoal(goal) });
    }
    const goalSummaryByGroupId = new Map(
      [...goalsByGroup].map(([gid, rows]) => [gid, scoreGroup(rows)])
    );

    // Delivery over EXACTLY the requested month. The Delivery tab's window
    // tokens are its own business; a monthly report's window is the month.
    let deliveryByGroupId = null;
    let trackerList = [];
    let range = null;

    if (canSeeDelivery && trackers.length > 0) {
      const monthFrom = firstDayKeyOf(month);
      const monthTo = lastDayKeyOf(month);

      const { plans, scanFrom, scanTo, overCap } = planDelivery({
        trackers,
        allGroups: groups,
        now,
        maxCells: MAX_EVAL_CELLS,
        // Clamped to today so a month still running does not paint the rest of
        // itself as missed — the same reason the Delivery grid clamps.
        resolveRange: ({ todayKey }) => ({
          from: monthFrom,
          to: minDayKey(monthTo, todayKey),
        }),
      });

      if (overCap) {
        return res.status(400).json({
          error:
            `"${overCap.tracker.name}" spans ${overCap.cells} group-periods this month. `
            + 'Scope the tracker to fewer clients.',
        });
      }

      const inputs = await fetchDeliveryInputs({ board, plans, scanFrom, scanTo });
      const results = evaluatePlans({ board, plans, now, ...inputs });

      // A period belongs to the month containing its START day — the month its
      // own key is named after ('w:2026-07-28' is July's). Without this rule a
      // week straddling a boundary is counted in BOTH months and a year's
      // totals exceed reality. Applied at fold time rather than by trimming the
      // periods, so planDelivery stays exactly what the Delivery grid needs.
      deliveryByGroupId = foldDeliveryByGroup(results, {
        keepPeriod: (p) => monthKeyOfDayKey(p.startDayKey) === month,
      });

      trackerList = results.map(({ tracker }) => ({
        _id: String(tracker._id),
        name: tracker.name,
        enabled: tracker.enabled,
      }));

      range = { fromDayKey: monthFrom, toDayKey: minDayKey(monthTo, dayKeyOf(now, tz)) };
    }

    // One batched lookup for the owners actually being displayed.
    const ownerIds = [...new Set(
      [...ownerByGroupId.values()].map((o) => o.userId).filter(Boolean)
    )];
    const users = ownerIds.length
      ? await User.find({ _id: { $in: ownerIds } }).select('name profilePic email').lean()
      : [];
    const usersById = new Map(users.map((u) => [String(u._id), u]));

    const built = buildScoreboard({
      groups,
      ownerByGroupId,
      usersById,
      goalSummaryByGroupId,
      deliveryByGroupId,
    });

    // Narrow AFTER building, so the caller's own rank stays their rank among
    // everyone rather than becoming a meaningless "1 of 1". The totals stay too:
    // knowing the board scored 78% is not knowing how any colleague did.
    const people = canSeeOthers
      ? built.people
      : built.people.filter((p) => String(p.user?._id) === selfId);

    return res.json({
      scoreboard: {
        boardId: String(board._id),
        monthKey: month,
        // "Computed now", not "the August report": Task.group is the CURRENT
        // group, so moving a task between clients rewrites an old cell. See
        // getDelivery's docstring.
        generatedAt: now,
        timezone: tz,
        range,
        // The month is still running, so these numbers are a progress report.
        partialMonth: month === currentKey,
        sections: { goals: true, delivery: canSeeDelivery },
        scope: canSeeOthers ? 'org' : 'self',
        trackers: trackerList,
        people,
        unassigned: canSeeOthers ? built.unassigned : null,
        totals: built.totals,
      },
    });
  } catch (err) {
    console.error('getScoreboard error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

module.exports = { getScoreboard };
