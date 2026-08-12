const mongoose = require('mongoose');

const Tracker = require('../models/Tracker');
const TrackerEntry = require('../models/TrackerEntry');
const Task = require('../models/Task');
const TaskGroup = require('../models/TaskGroup');
const ActivityLog = require('../models/ActivityLog');

const { loadBoardContext, requireCapability } = require('../utils/boardContext');
const { isMonthKey, lastDayKeyOf } = require('../utils/monthKey');
const {
  validateCadence,
  periodsBetween,
  periodKeyFor,
  CADENCE_TYPES,
  MAX_GRACE_DAYS,
  MAX_EVERY_N,
} = require('../utils/trackerPeriods');
const { evaluateTracker, REQUIREMENT_TYPES } = require('../utils/trackerEvaluate');
const {
  isValidTimezone,
  isDayKey,
  parseDayKey,
  dayKeyOf,
  dayKeyToUtcRange,
  addDays,
  compareDayKeys,
  minDayKey,
  maxDayKey,
} = require('../utils/tzDay');

/**
 * Trackers — per-board recurring commitments, and the Delivery grid that scores
 * them. See models/Tracker.js for why nothing here is named "daily" or
 * "monthly", utils/trackerPeriods.js for the period math, and
 * utils/trackerEvaluate.js for the scoring. Both of those are pure and tested;
 * this file only queries and gates.
 *
 * EVERY handler runs three gates, in this order:
 *   1. loadBoardContext    — can you reach this board at all?
 *   2. requireCapability   — does your role permit it? ('tracker.view'/'tracker.manage')
 *   3. requireMonthlyBoard — is this a board type that HAS a Delivery view?
 *
 * The order matters: a user who lacks the permission never learns what is on the
 * board. Hiding the tab in the UI is a courtesy; these are what make it real.
 *
 * Gate 3 replaced a `requireFeature('trackers', …)` check. Delivery used to be a
 * per-user opt-in listed in Settings → Extra features; it is now a view of the
 * monthly board type, so the question is about the BOARD, not the person. It
 * answers 404 rather than 403 because on a standard board the resource does not
 * exist — there is nothing here to be refused access to.
 */

const NOT_MONTHLY_MESSAGE =
  'Delivery is only available on monthly boards.';

/**
 * The response is groups x periods cells. A year of daily periods across fifty
 * clients is 18,000 of them — a 1.5MB payload and 18,000 DOM nodes, which bites
 * long before any query cost does. Capping on CELLS rather than days is what
 * makes the limit mean the same thing for a daily and a monthly tracker.
 */
const MAX_CELLS = 5000;
const MAX_WINDOW_DAYS = 366;

const MAX_NAME_LENGTH = 60;
const MAX_MATCH_LENGTH = 80;
const MAX_SKIP_DATES = 120;
const MAX_TARGET_COUNT = 100;

/** Default window per cadence type — roughly one screen's worth of history. */
const DEFAULT_WINDOW = { everyNDays: '4w', weekly: '13w', monthly: '12m' };

const WINDOW_RE = /^(\d{1,2})([wm])$/;

const isValidId = (value) => mongoose.Types.ObjectId.isValid(value);

const trimTo = (value, max) => String(value == null ? '' : value).trim().slice(0, max);

// ---------------------------------------------------------------------------
// Sanitizers — permissive schema, strict controller, exactly as
// automationController does it. Each returns { value } or { error }, and none
// of them throws.
// ---------------------------------------------------------------------------

const sanitizeCadence = (raw) => {
  if (!raw || typeof raw !== 'object') return { error: 'Cadence is required' };

  const type = raw.type;
  if (!CADENCE_TYPES.includes(type)) return { error: 'Invalid cadence type' };

  const cadence = { type };

  if (type === 'everyNDays') {
    const n = Number(raw.n);
    if (!Number.isInteger(n) || n < 1 || n > MAX_EVERY_N) {
      return { error: `Repeat every N days requires N between 1 and ${MAX_EVERY_N}` };
    }
    cadence.n = n;
    // Only meaningful for n > 1, but harmless to keep so the phase survives a
    // later edit from n=1 to n=2.
    if (raw.anchorDate) {
      if (!isDayKey(raw.anchorDate) || !parseDayKey(raw.anchorDate)) {
        return { error: 'Invalid anchor date' };
      }
      cadence.anchorDate = raw.anchorDate;
    }
  }

  if (type === 'weekly') {
    cadence.weekStartsOn = raw.weekStartsOn === 0 ? 0 : 1;
  }

  if (raw.weekdays !== undefined && raw.weekdays !== null) {
    if (!Array.isArray(raw.weekdays)) return { error: 'Working days must be a list' };
    const weekdays = [...new Set(raw.weekdays.map(Number))].filter(
      (d) => Number.isInteger(d) && d >= 0 && d <= 6
    );
    if (weekdays.length === 0) {
      return { error: 'At least one weekday must be a working day' };
    }
    cadence.weekdays = weekdays.sort();
  }

  if (raw.graceDays !== undefined && raw.graceDays !== null) {
    const g = Number(raw.graceDays);
    if (!Number.isInteger(g) || g < 0 || g > MAX_GRACE_DAYS) {
      return { error: `Grace days must be between 0 and ${MAX_GRACE_DAYS}` };
    }
    cadence.graceDays = g;
  }

  const verdict = validateCadence(cadence);
  if (!verdict.valid) return { error: verdict.error };
  return { value: cadence };
};

const sanitizeGroups = async (raw, boardId) => {
  if (raw === undefined || raw === null) return { value: [] };
  if (!Array.isArray(raw)) return { error: 'Clients must be a list' };

  const ids = [...new Set(raw.map(String))].filter(Boolean);
  if (ids.length === 0) return { value: [] }; // empty means every group

  if (ids.some((id) => !isValidId(id))) return { error: 'Invalid client id' };

  const found = await TaskGroup.find({ _id: { $in: ids }, board: boardId })
    .select('_id')
    .lean();
  if (found.length !== ids.length) {
    return { error: 'One or more selected clients are not on this board' };
  }
  return { value: ids };
};

const sanitizeMatch = (raw, board) => {
  const m = raw && typeof raw === 'object' ? raw : {};
  const out = {
    nameContains: trimTo(m.nameContains, MAX_MATCH_LENGTH),
    excludeNameContains: trimTo(m.excludeNameContains, MAX_MATCH_LENGTH),
    labels: [],
  };

  if (Array.isArray(m.labels) && m.labels.length > 0) {
    const known = new Set((board.labels || []).map((l) => String(l._id)));
    const ids = [...new Set(m.labels.map(String))].filter(Boolean);
    if (ids.some((id) => !known.has(id))) {
      return { error: 'One or more labels are not on this board' };
    }
    out.labels = ids;
  }

  return { value: out };
};

const sanitizeRequirements = (raw) => {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: 'Pick at least one thing that has to happen' };
  }
  const list = [...new Set(raw.map(String))];
  if (list.some((r) => !REQUIREMENT_TYPES.includes(r))) {
    return { error: 'Unknown requirement' };
  }
  return { value: list };
};

const sanitizeSkipDates = (raw) => {
  if (raw === undefined || raw === null) return { value: [] };
  if (!Array.isArray(raw)) return { error: 'Skipped dates must be a list' };
  const list = [...new Set(raw.map(String))];
  if (list.length > MAX_SKIP_DATES) {
    return { error: `At most ${MAX_SKIP_DATES} skipped dates` };
  }
  if (list.some((d) => !isDayKey(d) || !parseDayKey(d))) {
    return { error: 'Invalid skipped date' };
  }
  return { value: list.sort() };
};

/**
 * Build the full document body from a request. `partial` is true on update, so
 * an edit that omits a field leaves it alone rather than clearing it.
 */
const sanitizeTrackerPayload = async (body, board, { partial = false } = {}) => {
  const raw = body || {};
  const out = {};

  if (!partial || raw.name !== undefined) {
    const name = trimTo(raw.name, MAX_NAME_LENGTH);
    if (!name) return { error: 'Tracker name is required' };
    out.name = name;
  }

  if (!partial || raw.timezone !== undefined) {
    // NOT defaulted to UTC: a tracker silently on UTC while the team is on IST
    // is a five-and-a-half hour lie that looks exactly like data.
    if (!isValidTimezone(raw.timezone)) return { error: 'A valid timezone is required' };
    out.timezone = raw.timezone;
  }

  if (!partial || raw.startDate !== undefined) {
    if (!isDayKey(raw.startDate) || !parseDayKey(raw.startDate)) {
      return { error: 'A valid start date is required' };
    }
    out.startDate = raw.startDate;
  }

  if (!partial || raw.endDate !== undefined) {
    if (raw.endDate === null || raw.endDate === '') out.endDate = null;
    else if (!isDayKey(raw.endDate) || !parseDayKey(raw.endDate)) {
      return { error: 'Invalid end date' };
    } else out.endDate = raw.endDate;
  }

  if (out.startDate && out.endDate && compareDayKeys(out.endDate, out.startDate) < 0) {
    return { error: 'The end date cannot be before the start date' };
  }

  if (!partial || raw.cadence !== undefined) {
    const cadence = sanitizeCadence(raw.cadence);
    if (cadence.error) return { error: cadence.error };
    out.cadence = cadence.value;
  }

  if (!partial || raw.requirements !== undefined) {
    const requirements = sanitizeRequirements(raw.requirements);
    if (requirements.error) return { error: requirements.error };
    out.requirements = requirements.value;
  }

  if (!partial || raw.groups !== undefined) {
    const groups = await sanitizeGroups(raw.groups, board._id);
    if (groups.error) return { error: groups.error };
    out.groups = groups.value;
  }

  if (!partial || raw.match !== undefined) {
    const match = sanitizeMatch(raw.match, board);
    if (match.error) return { error: match.error };
    out.match = match.value;
  }

  if (!partial || raw.skipDates !== undefined) {
    const skipDates = sanitizeSkipDates(raw.skipDates);
    if (skipDates.error) return { error: skipDates.error };
    out.skipDates = skipDates.value;
  }

  if (!partial || raw.targetCount !== undefined) {
    const target = Number(raw.targetCount === undefined ? 1 : raw.targetCount);
    if (!Number.isInteger(target) || target < 1 || target > MAX_TARGET_COUNT) {
      return { error: `How many per period must be between 1 and ${MAX_TARGET_COUNT}` };
    }
    out.targetCount = target;
  }

  if (!partial || raw.requireSameTask !== undefined) {
    out.requireSameTask = raw.requireSameTask !== false;
  }

  if (raw.enabled !== undefined) out.enabled = !!raw.enabled;

  return { value: out };
};

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

/**
 * Run all three gates. Returns the board context, or null after having already
 * written the response.
 */
const gate = async (req, res, capability) => {
  const boardId = req.params.boardId || req.boardId;
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

  if (ctx.board?.boardType !== 'monthly') {
    res.status(404).json({ error: NOT_MONTHLY_MESSAGE, code: 'NOT_MONTHLY_BOARD' });
    return null;
  }

  return ctx;
};

/** Resolve a tracker id to its board first, then run the normal board gates. */
const gateByTracker = async (req, res, capability) => {
  const { id } = req.params;
  if (!isValidId(id)) {
    res.status(400).json({ error: 'Invalid tracker id' });
    return null;
  }
  const tracker = await Tracker.findById(id);
  if (!tracker) {
    res.status(404).json({ error: 'Tracker not found' });
    return null;
  }
  req.boardId = String(tracker.board);
  const ctx = await gate(req, res, capability);
  if (!ctx) return null;
  return { ctx, tracker };
};

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

const serialiseTracker = (tracker) => ({
  _id: tracker._id,
  name: tracker.name,
  board: tracker.board,
  enabled: tracker.enabled,
  timezone: tracker.timezone,
  startDate: tracker.startDate,
  endDate: tracker.endDate || null,
  cadence: tracker.cadence,
  skipDates: tracker.skipDates || [],
  groups: tracker.groups || [],
  match: tracker.match || {},
  requirements: tracker.requirements || [],
  requireSameTask: tracker.requireSameTask !== false,
  targetCount: tracker.targetCount || 1,
  createdBy: tracker.createdBy,
  createdAt: tracker.createdAt,
  updatedAt: tracker.updatedAt,
});

/** GET /api/boards/:boardId/trackers */
const listTrackers = async (req, res) => {
  try {
    const ctx = await gate(req, res, 'tracker.view');
    if (!ctx) return undefined;

    const trackers = await Tracker.find({ board: ctx.board._id })
      .sort({ createdAt: 1 })
      .lean();

    return res.json({ trackers: trackers.map(serialiseTracker) });
  } catch (err) {
    console.error('listTrackers error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/** POST /api/boards/:boardId/trackers */
const createTracker = async (req, res) => {
  try {
    const ctx = await gate(req, res, 'tracker.manage');
    if (!ctx) return undefined;

    const payload = await sanitizeTrackerPayload(req.body, ctx.board);
    if (payload.error) return res.status(400).json({ error: payload.error });

    const tracker = await Tracker.create({
      ...payload.value,
      board: ctx.board._id,
      organisation: ctx.board.organisation,
      createdBy: req.user.userId,
    });

    return res.status(201).json({ tracker: serialiseTracker(tracker) });
  } catch (err) {
    console.error('createTracker error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/** PUT /api/trackers/:id */
const updateTracker = async (req, res) => {
  try {
    const gated = await gateByTracker(req, res, 'tracker.manage');
    if (!gated) return undefined;
    const { ctx, tracker } = gated;

    const payload = await sanitizeTrackerPayload(req.body, ctx.board, { partial: true });
    if (payload.error) return res.status(400).json({ error: payload.error });

    // Re-check the pair even when only one side was sent.
    const nextStart = payload.value.startDate || tracker.startDate;
    const nextEnd =
      payload.value.endDate !== undefined ? payload.value.endDate : tracker.endDate;
    if (nextStart && nextEnd && compareDayKeys(nextEnd, nextStart) < 0) {
      return res.status(400).json({ error: 'The end date cannot be before the start date' });
    }

    Object.assign(tracker, payload.value);
    await tracker.save();

    return res.json({ tracker: serialiseTracker(tracker) });
  } catch (err) {
    console.error('updateTracker error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/** DELETE /api/trackers/:id */
const deleteTracker = async (req, res) => {
  try {
    const gated = await gateByTracker(req, res, 'tracker.manage');
    if (!gated) return undefined;
    const { tracker } = gated;

    // The confirmations and waivers are meaningless without their tracker, and
    // leaving them would collide the unique index if the id were ever reused.
    await TrackerEntry.deleteMany({ tracker: tracker._id });
    await Tracker.deleteOne({ _id: tracker._id });

    return res.json({ success: true });
  } catch (err) {
    console.error('deleteTracker error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

// ---------------------------------------------------------------------------
// Manual entries — confirm / excuse one cell
// ---------------------------------------------------------------------------

/** PUT /api/trackers/:id/entries */
const setTrackerEntry = async (req, res) => {
  try {
    const gated = await gateByTracker(req, res, 'tracker.manage');
    if (!gated) return undefined;
    const { ctx, tracker } = gated;

    const { group, periodKey, state } = req.body || {};

    if (!isValidId(group)) return res.status(400).json({ error: 'Invalid client id' });
    const groupDoc = await TaskGroup.findOne({ _id: group, board: ctx.board._id })
      .select('_id')
      .lean();
    if (!groupDoc) {
      return res.status(400).json({ error: 'That client is not on this board' });
    }

    if (state !== 'confirmed' && state !== 'excused') {
      return res.status(400).json({ error: 'Invalid state' });
    }

    // A period key must be one this tracker's own cadence could produce —
    // otherwise a stale client could write an entry that nothing will ever read
    // and the cell would stay stubbornly red with no explanation.
    if (typeof periodKey !== 'string' || !periodKey.includes(':')) {
      return res.status(400).json({ error: 'Invalid period' });
    }
    const startDayKey = periodKey.slice(periodKey.indexOf(':') + 1);
    if (!isDayKey(startDayKey) || periodKeyFor(startDayKey, tracker.cadence) !== periodKey) {
      return res.status(400).json({ error: 'That period does not belong to this tracker' });
    }

    const entry = await TrackerEntry.findOneAndUpdate(
      { tracker: tracker._id, group, periodKey },
      {
        $set: {
          state,
          by: req.user.userId,
          at: new Date(),
          link: trimTo(req.body?.link, 2048),
          note: trimTo(req.body?.note, 500),
        },
        $setOnInsert: {
          tracker: tracker._id,
          board: ctx.board._id,
          organisation: ctx.board.organisation,
          group,
          periodKey,
        },
      },
      { new: true, upsert: true }
    ).lean();

    return res.json({ entry });
  } catch (err) {
    console.error('setTrackerEntry error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/** DELETE /api/trackers/:id/entries?group=&periodKey= */
const deleteTrackerEntry = async (req, res) => {
  try {
    const gated = await gateByTracker(req, res, 'tracker.manage');
    if (!gated) return undefined;
    const { tracker } = gated;

    const { group, periodKey } = req.query;
    if (!isValidId(group) || !periodKey) {
      return res.status(400).json({ error: 'Client and period are required' });
    }

    await TrackerEntry.deleteOne({ tracker: tracker._id, group, periodKey });
    return res.json({ success: true });
  } catch (err) {
    console.error('deleteTrackerEntry error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

// ---------------------------------------------------------------------------
// The Delivery grid
// ---------------------------------------------------------------------------

/**
 * Turn a window token ('4w', '12m') into a start day key, counting back from
 * `anchorKey` in the tracker's own timezone. Presets rather than a free range on
 * purpose: a shared dashboard everyone reads the same way beats one everyone
 * configures differently.
 *
 * The anchor is normally today. On a monthly board it is the last day of the
 * SELECTED month instead, so the grid ends where the month picker says it does
 * — pick July and the last column is July, not whatever month it happens to be
 * now. The window token still controls the window's LENGTH; the month controls
 * its END.
 */
const resolveWindowStart = (token, anchorKey, cadenceType) => {
  const raw = typeof token === 'string' && WINDOW_RE.test(token)
    ? token
    : DEFAULT_WINDOW[cadenceType] || '4w';
  const [, countStr, unit] = raw.match(WINDOW_RE);
  const count = Math.max(1, Math.min(24, parseInt(countStr, 10)));

  if (unit === 'w') return addDays(anchorKey, -(count * 7 - 1));

  const parsed = parseDayKey(anchorKey);
  const monthsBack = count - 1;
  let year = parsed.year;
  let month = parsed.month - monthsBack;
  while (month < 1) {
    month += 12;
    year -= 1;
  }
  return `${year}-${String(month).padStart(2, '0')}-01`;
};

/** Parse `?windows=id:4w,id2:12m` into a map. Unparseable entries are ignored. */
const parseWindows = (value) => {
  const out = new Map();
  if (typeof value !== 'string' || !value) return out;
  for (const chunk of value.split(',')) {
    const [id, token] = chunk.split(':');
    if (id && token && WINDOW_RE.test(token)) out.set(id.trim(), token.trim());
  }
  return out;
};

/**
 * GET /api/boards/:boardId/delivery?windows=<trackerId>:4w,...
 *
 * Computed on read. At this scale that is comfortably the right call — a board
 * with a few thousand tasks resolves in tens of milliseconds. The trigger for
 * materialising a rollup is not performance but history: `Task.group` is the
 * CURRENT group, so moving a task between clients retroactively rewrites an old
 * cell, and deleting a task destroys its updates. Until then, a TrackerEntry is
 * how a human overrules the grid.
 */
const getDelivery = async (req, res) => {
  try {
    const ctx = await gate(req, res, 'tracker.view');
    if (!ctx) return undefined;

    const board = ctx.board;

    // ROUND TRIP 1 of 2. Server-side these queries are ~1ms; what actually costs
    // is the round trip to a hosted cluster, so the whole endpoint is
    // deliberately shaped as two parallel batches rather than five sequential
    // awaits. Anything that does not depend on a previous result goes in the
    // same batch.
    const [trackers, allGroups] = await Promise.all([
      Tracker.find({ board: board._id }).sort({ createdAt: 1 }).lean(),
      TaskGroup.find({ board: board._id })
        .select('name order createdAt')
        .sort({ order: 1, createdAt: 1 })
        .lean(),
    ]);

    if (trackers.length === 0) {
      return res.json({
        delivery: { generatedAt: new Date(), trackers: [] },
      });
    }

    const groupById = new Map(allGroups.map((g) => [String(g._id), g]));

    const windows = parseWindows(req.query.windows);
    const now = new Date();

    // The board's month picker sets where the grid ENDS. Clamped to today so
    // the "one month ahead" entry in that dropdown does not paint a run of
    // empty columns that all read as missed.
    const monthParam = isMonthKey(req.query.month) ? req.query.month : null;
    const monthEndKey = monthParam ? lastDayKeyOf(monthParam) : null;

    // Work out each tracker's window first, so the task and update queries can
    // be issued once across the union rather than once per tracker.
    const plans = [];
    for (const tracker of trackers) {
      const tz = tracker.timezone;
      const todayKey = dayKeyOf(now, tz);
      if (!todayKey) continue;

      // Where the grid ends: the selected month's last day, never later than
      // today. `minDayKey(null, x)` returns x, so no month means today as before.
      const anchorKey = monthEndKey ? minDayKey(monthEndKey, todayKey) : todayKey;

      const windowStart = resolveWindowStart(
        windows.get(String(tracker._id)),
        anchorKey,
        tracker.cadence?.type
      );

      // Never scan before the tracker existed, and never past its end.
      let from = maxDayKey(windowStart, tracker.startDate);
      let to = tracker.endDate ? minDayKey(anchorKey, tracker.endDate) : anchorKey;
      // A tracker that has not started yet still renders its (empty) columns.
      if (compareDayKeys(from, to) > 0) to = from;

      const periods = periodsBetween(tracker.cadence, from, to, {
        skipDates: tracker.skipDates || [],
      });

      const scoped = (tracker.groups || []).length > 0
        ? (tracker.groups || []).map((g) => groupById.get(String(g))).filter(Boolean)
        : allGroups;

      plans.push({ tracker, tz, todayKey, from, to, periods, groups: scoped });
    }

    const overCap = plans.find((p) => p.groups.length * p.periods.length > MAX_CELLS);
    if (overCap) {
      return res.status(400).json({
        error:
          `"${overCap.tracker.name}" would show ${overCap.groups.length * overCap.periods.length} `
          + `cells. Pick a shorter window or fewer clients (limit ${MAX_CELLS}).`,
      });
    }

    // One task read and one update read across the union of every window. The
    // last period may extend past today via graceDays, so the upper bound comes
    // from the periods rather than from `to`.
    let scanFrom = null;
    let scanTo = null;
    for (const p of plans) {
      scanFrom = minDayKey(scanFrom, p.periods[0]?.startDayKey || p.from);
      const last = p.periods[p.periods.length - 1];
      scanTo = maxDayKey(scanTo, last?.dueDayKey || p.to);
    }

    // ROUND TRIP 2 of 2 — every remaining read, issued together.
    const scanTz = plans[0].tz;
    const startRange = scanFrom ? dayKeyToUtcRange(scanFrom, scanTz) : null;
    const endRange = scanTo ? dayKeyToUtcRange(scanTo, scanTz) : null;
    const range =
      startRange && endRange ? { $gte: startRange.start, $lt: endRange.end } : null;

    const [tasks, updateRows, entryRows] = await Promise.all([
      // Task.createdAt is the signal, not ActivityLog: automation-created tasks
      // never write an activity row, and a board that auto-creates its daily
      // item would otherwise read as entirely missed.
      // Rides { board: 1, createdAt: -1 } — an IXSCAN returning only the window.
      range
        ? Task.find({
          board: board._id,
          parent: null,
          isPersonal: { $ne: true },
          createdAt: range,
        })
          // Never select columnValues / attachments / checklist / note — the
          // last three are unbounded arrays and this is thousands of rows.
          .select('_id group name createdAt status labels')
          .lean()
        : [],
      // Updates come from ActivityLog rather than the Update collection: it is
      // the only board-and-day query with an index behind it
      // ({ board: 1, createdAt: -1 }), it needs no $in over every task id, and
      // it excludes authorType 'system' auto-posts by construction — "Status
      // changed to Done" is not somebody writing an update.
      range
        ? ActivityLog.find({
          board: board._id,
          createdAt: range,
          type: { $in: ['update.added', 'client.update_added'] },
        })
          .select('task createdAt')
          .lean()
        : [],
      // Manual confirmations and waivers. Bounded by what humans have actually
      // clicked, so this stays small — no period filter needed.
      TrackerEntry.find({
        board: board._id,
        tracker: { $in: plans.map((p) => p.tracker._id) },
      })
        .populate('by', 'name email profilePic')
        .lean(),
    ]);

    const entriesByTracker = new Map();
    for (const entry of entryRows) {
      const key = String(entry.tracker);
      if (!entriesByTracker.has(key)) entriesByTracker.set(key, []);
      entriesByTracker.get(key).push(entry);
    }

    const payload = plans.map(({ tracker, tz, periods, groups }) => {
      // Day keys are timezone-dependent, so the update index is rebuilt per
      // tracker. In practice every tracker on a board shares a timezone and this
      // is a few thousand cheap string ops.
      const updateDayKeys = new Map();
      for (const row of updateRows) {
        const taskId = String(row.task);
        const dayKey = dayKeyOf(row.createdAt, tz);
        if (!dayKey) continue;
        let set = updateDayKeys.get(taskId);
        if (!set) {
          set = new Set();
          updateDayKeys.set(taskId, set);
        }
        set.add(dayKey);
      }

      const entries = entriesByTracker.get(String(tracker._id)) || [];

      const { rows, summary } = tracker.enabled
        ? evaluateTracker({
          tracker,
          periods,
          groups,
          tasks,
          updateDayKeys,
          entries,
          board,
          timezone: tz,
          now,
        })
        : { rows: [], summary: null };

      return {
        ...serialiseTracker(tracker),
        periods: tracker.enabled ? periods : [],
        rows,
        summary,
      };
    });

    return res.json({
      delivery: {
        generatedAt: now,
        boardId: String(board._id),
        trackers: payload,
      },
    });
  } catch (err) {
    console.error('getDelivery error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

module.exports = {
  listTrackers,
  createTracker,
  updateTracker,
  deleteTracker,
  setTrackerEntry,
  deleteTrackerEntry,
  getDelivery,
  // Exported for unit testing.
  sanitizeCadence,
  sanitizeMatch,
  sanitizeRequirements,
  sanitizeSkipDates,
  resolveWindowStart,
  parseWindows,
};
