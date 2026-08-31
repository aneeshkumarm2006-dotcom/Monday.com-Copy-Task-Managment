/**
 * Ads budgets — the per-client budget tables on a tracker board's Ads Budget tab.
 *
 * The pacing lives in the pure [utils/adsBudgetPacing.js](../utils/adsBudgetPacing.js);
 * this file only queries and gates. Every handler runs the same three gates, in
 * this order, copied from goalController for the reason stated there:
 *
 *   1. loadBoardContext   — can you reach this board at all?
 *   2. requireCapability  — does your role permit it?
 *   3. tracker board?     — is this a board type that HAS ads budgets?
 *
 * Someone who cannot reach the board never learns what is on it.
 *
 * ---- The capability split, and why PATCH judges the DELTA ------------------
 *
 * `adsBudget.track` (contribute) may move `spent` and nothing else.
 * `adsBudget.manage` (edit) may do anything, including flipping the add-on on.
 *
 * That is decided from the fields the request actually TOUCHES, not from the
 * document it would produce — the same rule `requireAssignCapability` follows
 * for self-assignment. A body that re-sends `allocated` unchanged alongside a
 * new `spent` is a spend report, not a budget change, and refusing it would
 * make the edit form unusable for the very people it is for.
 *
 * ---- Nothing here rolls campaigns up into platforms ------------------------
 *
 * A platform's `allocated` is what was committed to the channel; its campaigns
 * are the part of it broken out so far, and the two are independent by design.
 * Every total below therefore sums `parent: null` rows ONLY. See the header of
 * models/AdsBudget.js.
 */

const mongoose = require('mongoose');
const ActivityLog = require('../models/ActivityLog');
const AdsBudget = require('../models/AdsBudget');
const TaskGroup = require('../models/TaskGroup');
const User = require('../models/User');
const { loadBoardContext, requireCapability } = require('../utils/boardContext');
const {
  snapshotRow, logRowCreated, logRowDeleted, logRowChanges,
} = require('../services/adsBudgetActivity');
// Value resolution is shared with the task feed and the board activity export,
// so one budget edit cannot be described three different ways.
const { resolveFieldValue, collectUserIds } = require('../services/activityFormat');
const { monthWindow, paceOf, rollUp } = require('../utils/adsBudgetPacing');
const { isMonthKey, monthKeyOf, formatMonth } = require('../utils/monthKey');

const NOT_TRACKER = 'This board is not a tracker board.';
const OFF =
  'The Ads Budget tracker is switched off for this board. Someone who can manage '
  + 'the board can turn it on under Add-ons.';

const MAX_PLATFORMS_PER_GROUP = 60;
const MAX_CAMPAIGNS_PER_PLATFORM = 200;
/** Page size for the Budget Activity ledger, mirroring the goal history panel. */
const MAX_ACTIVITY_PAGE = 200;
const DEFAULT_ACTIVITY_PAGE = 60;

const PEOPLE_FIELDS = 'name profilePic email';
const POPULATE_PEOPLE = [
  { path: 'owner', select: PEOPLE_FIELDS },
  { path: 'createdBy', select: PEOPLE_FIELDS },
  { path: 'updatedBy', select: PEOPLE_FIELDS },
];

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

/**
 * The gates. Returns the context, or null having already answered.
 *
 * `requireOn` is false for exactly one caller — the settings endpoint that
 * turns the add-on ON, which by definition runs while it is off.
 */
const gate = async (req, res, capability, { requireOn = true } = {}) => {
  const boardId = req.params.boardId || req.params.id;
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
  // 404, not 403: on a standard board ads budgets do not exist, so there is
  // nothing here to be refused access to.
  if (ctx.board?.boardType !== 'tracker') {
    res.status(404).json({ error: NOT_TRACKER, code: 'NOT_TRACKER_BOARD' });
    return null;
  }
  // Also 404 rather than 403, and for the same reason: an add-on nobody has
  // switched on is not a thing being withheld from this person.
  if (requireOn && !ctx.board?.adsBudget?.enabled) {
    res.status(404).json({ error: OFF, code: 'ADS_BUDGET_OFF' });
    return null;
  }
  return ctx;
};

/** Resolve a row id to its board, then run the normal gates. */
const gateByRow = async (req, res, capability) => {
  const { id } = req.params;
  if (!isValidId(id)) {
    res.status(400).json({ error: 'Invalid budget id' });
    return null;
  }
  const row = await AdsBudget.findById(id);
  if (!row) {
    res.status(404).json({ error: 'Budget not found' });
    return null;
  }
  req.params.boardId = String(row.board);
  const ctx = await gate(req, res, capability);
  if (!ctx) return null;
  return { ctx, row };
};

/**
 * Which month this request is about.
 *
 * Falls back to the board's CURRENT month rather than to "all months": every
 * figure the tab shows is per-month, and a read that quietly spanned all of
 * them would sum three years of budgets into one reassuring total.
 */
const monthOf = (req, board) => {
  const raw = req.query.month;
  if (isMonthKey(raw)) return raw;
  return monthKeyOf(new Date(), board.monthTimezone || 'UTC');
};

/** The window every row on this response is paced against. One per request. */
const windowFor = (monthKey, board) =>
  monthWindow(monthKey, board.monthTimezone || 'UTC');

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** A lean row, with its computed money and state attached. */
const decorate = (row, window) => ({
  ...row,
  _id: String(row._id),
  parent: row.parent ? String(row.parent) : null,
  ...paceOf(row, window),
});

/**
 * GET /api/boards/:boardId/ads-budget?month=YYYY-MM
 *
 * The roster: every group on the board with its month rolled up, plus the
 * board-wide totals strip.
 *
 * Groups with NO budget rows are included, carrying zeros and the `unset`
 * state. That is most of this screen's value in the first week of a month —
 * "who has nobody looking after them yet" is the question it answers, and a
 * roster that only listed clients already set up could never answer it.
 */
const getRoster = async (req, res) => {
  try {
    const ctx = await gate(req, res, 'adsBudget.view');
    if (!ctx) return undefined;
    const { board } = ctx;

    const monthKey = monthOf(req, board);
    const window = windowFor(monthKey, board);

    const groups = await TaskGroup.find({ board: board._id })
      .select('name order')
      .sort({ order: 1 })
      .lean();

    // Platform rows only — campaigns are a breakdown WITHIN a platform, and
    // summing both levels double-counts them. See models/AdsBudget.js.
    const rows = await AdsBudget.find({
      board: board._id,
      monthKey,
      parent: null,
    })
      .select('group allocated spent lifecycle')
      .lean();

    const byGroup = new Map();
    for (const row of rows) {
      const key = String(row.group);
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key).push(row);
    }

    const clients = groups.map((group) => {
      const own = byGroup.get(String(group._id)) || [];
      return {
        _id: String(group._id),
        name: group.name,
        platformCount: own.length,
        ...rollUp(own, window),
      };
    });

    // The strip at the top of the roster is the same rollup over every row on
    // the board, NOT the sum of the per-client rollups — which would be the
    // same number today and would quietly drift the moment the two rollups
    // treated a lifecycle differently.
    const totals = rollUp(rows, window);

    return res.json({
      monthKey,
      monthLabel: formatMonth(monthKey, { long: true }),
      currency: board.adsBudget?.currency || 'USD',
      window,
      clients,
      totals,
      canTrack: !!ctx.can('adsBudget.track'),
      canManage: !!ctx.can('adsBudget.manage'),
    });
  } catch (err) {
    console.error('getRoster error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * GET /api/boards/:boardId/ads-budget/:groupId?month=YYYY-MM
 *
 * One client, one month: the KPI figures, every platform, and each platform's
 * campaigns nested under it.
 */
const getClient = async (req, res) => {
  try {
    const ctx = await gate(req, res, 'adsBudget.view');
    if (!ctx) return undefined;
    const { board } = ctx;

    const { groupId } = req.params;
    if (!isValidId(groupId)) {
      return res.status(400).json({ error: 'Invalid group id' });
    }
    const group = await TaskGroup.findOne({ _id: groupId, board: board._id })
      .select('name')
      .lean();
    if (!group) return res.status(404).json({ error: 'Group not found on this board' });

    const monthKey = monthOf(req, board);
    const window = windowFor(monthKey, board);

    const all = await AdsBudget.find({ board: board._id, monthKey, group: groupId })
      .populate(POPULATE_PEOPLE)
      .sort({ order: 1, createdAt: 1 })
      .lean();

    const platformRows = all.filter((r) => !r.parent);
    const campaignRows = all.filter((r) => r.parent);

    const childrenOf = new Map();
    for (const row of campaignRows) {
      const key = String(row.parent);
      if (!childrenOf.has(key)) childrenOf.set(key, []);
      childrenOf.get(key).push(decorate(row, window));
    }

    const platforms = platformRows.map((row) => ({
      ...decorate(row, window),
      campaigns: childrenOf.get(String(row._id)) || [],
    }));

    /**
     * A campaign whose platform row is gone.
     *
     * Should not happen — deleting a platform takes its campaigns with it — but
     * if it ever does, the money must still appear somewhere rather than
     * vanishing from a page whose entire job is to account for it.
     */
    const platformIds = new Set(platformRows.map((r) => String(r._id)));
    const orphans = campaignRows
      .filter((r) => !platformIds.has(String(r.parent)))
      .map((r) => decorate(r, window));

    return res.json({
      monthKey,
      monthLabel: formatMonth(monthKey, { long: true }),
      currency: board.adsBudget?.currency || 'USD',
      window,
      group: { _id: String(group._id), name: group.name },
      totals: rollUp(platformRows, window),
      platforms,
      orphans,
      canTrack: !!ctx.can('adsBudget.track'),
      canManage: !!ctx.can('adsBudget.manage'),
    });
  } catch (err) {
    console.error('getClient error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * GET /api/boards/:boardId/ads-budget/:groupId/activity?month=YYYY-MM
 *
 * The Budget Activity ledger for one client's month.
 *
 * Filters on `metadata.monthKey` / `metadata.group` rather than joining through
 * `AdsBudget`, because a deleted row's movements still belong in the month they
 * happened in — and a deleted row has no document left to join to. The `board`
 * half of the filter is what keeps it under an index.
 */
const getClientActivity = async (req, res) => {
  try {
    const ctx = await gate(req, res, 'adsBudget.view');
    if (!ctx) return undefined;
    const { board } = ctx;

    const { groupId } = req.params;
    if (!isValidId(groupId)) {
      return res.status(400).json({ error: 'Invalid group id' });
    }
    const monthKey = monthOf(req, board);

    const requested = parseInt(req.query.limit, 10);
    const limit = Math.min(
      Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_ACTIVITY_PAGE,
      MAX_ACTIVITY_PAGE
    );

    const filter = {
      board: board._id,
      adsBudget: { $ne: null },
      'metadata.monthKey': monthKey,
      'metadata.group': String(groupId),
    };
    if (req.query.cursor) {
      const cursorDate = new Date(req.query.cursor);
      if (!isNaN(cursorDate.getTime())) filter.createdAt = { $lt: cursorDate };
    }

    // +1 to detect another page without a second count query.
    const raw = await ActivityLog.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit + 1)
      .lean();

    const hasMore = raw.length > limit;
    const slice = hasMore ? raw.slice(0, limit) : raw;

    const userIds = new Set(collectUserIds(slice));
    const users = userIds.size
      ? await User.find({ _id: { $in: [...userIds] } }).select(PEOPLE_FIELDS).lean()
      : [];
    const userMap = new Map(users.map((u) => [u._id.toString(), u]));

    const items = slice.map((e) => {
      const actorDoc = e.actor ? userMap.get(e.actor.toString()) : null;
      let actor;
      if (actorDoc) {
        actor = { _id: actorDoc._id, name: actorDoc.name, profilePic: actorDoc.profilePic };
      } else if (e.actorType === 'system') {
        actor = { _id: null, name: e.actorLabel || 'Automatic', profilePic: null, isSystem: true };
      } else if (e.actorType === 'client') {
        actor = { _id: null, name: e.actorLabel || 'Client', profilePic: null, isClient: true };
      } else {
        actor = { _id: e.actor, name: 'Unknown', profilePic: null };
      }
      return {
        _id: String(e._id),
        adsBudget: e.adsBudget ? String(e.adsBudget) : null,
        type: e.type,
        field: e.field,
        oldValue: resolveFieldValue(e.field, e.oldValue, board, userMap, e),
        newValue: resolveFieldValue(e.field, e.newValue, board, userMap, e),
        metadata: e.metadata,
        actor,
        createdAt: e.createdAt,
      };
    });

    return res.json({
      monthKey,
      items,
      nextCursor: hasMore ? slice[slice.length - 1].createdAt.toISOString() : null,
    });
  } catch (err) {
    console.error('getClientActivity error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/** Trim, clamp and coerce one submitted field set. Returns { patch, errors }. */
const readBody = (body, { creating = false } = {}) => {
  const errors = [];
  const patch = {};

  const str = (key, max, label) => {
    if (body[key] === undefined) return;
    const value = String(body[key] ?? '').trim();
    if (value.length > max) {
      errors.push({ field: key, message: `${label} must be ${max} characters or fewer.` });
      return;
    }
    patch[key] = value;
  };

  const money = (key, label, { nullable = false } = {}) => {
    if (body[key] === undefined) return;
    if (nullable && (body[key] === null || body[key] === '')) {
      patch[key] = null;
      return;
    }
    const value = Number(body[key]);
    if (!Number.isFinite(value)) {
      errors.push({ field: key, message: `${label} must be a number.` });
      return;
    }
    if (value < 0) {
      errors.push({ field: key, message: `${label} cannot be negative.` });
      return;
    }
    // Money, not a float with seventeen decimal places. Rounded here rather
    // than at render time so the stored figure and the exported one agree.
    patch[key] = Math.round(value * 100) / 100;
  };

  str('platform', 80, 'The platform name');
  str('account', 120, 'The account');
  str('name', 200, 'The campaign name');
  str('objective', 80, 'The objective');
  str('notes', 2000, 'Notes');

  money('allocated', 'The budget');
  money('spent', 'The spend');
  money('dailyBudget', 'The daily budget', { nullable: true });

  if (body.lifecycle !== undefined) {
    if (!AdsBudget.LIFECYCLES.includes(body.lifecycle)) {
      errors.push({ field: 'lifecycle', message: 'That is not a status a budget can be in.' });
    } else {
      patch.lifecycle = body.lifecycle;
    }
  }

  if (body.owner !== undefined) {
    if (body.owner === null || body.owner === '') patch.owner = null;
    else if (!isValidId(body.owner)) {
      errors.push({ field: 'owner', message: 'That is not a valid person.' });
    } else patch.owner = body.owner;
  }

  if (creating && !patch.platform) {
    errors.push({ field: 'platform', message: 'Say which platform this budget is for.' });
  }

  return { patch, errors };
};

/**
 * Which capability a PATCH needs, judged on the fields it TOUCHES.
 *
 * `spent` alone is a spend report and sits on `adsBudget.track`. Anything else
 * — including raising the allocation, renaming the campaign, or parking it — is
 * `adsBudget.manage`. A body re-sending `allocated` UNCHANGED alongside a new
 * `spent` is still a spend report, which is why the current row is compared
 * against rather than the key list alone.
 */
const capabilityForPatch = (patch, row) => {
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'spent') continue;
    const current = key === 'owner'
      ? (row.owner ? String(row.owner) : null)
      : row[key];
    const next = key === 'owner' ? (value ? String(value) : null) : value;
    // Loose on purpose: a form re-sending '' for a field that is already ''
    // must not escalate the request to `manage`.
    if (String(current ?? '') !== String(next ?? '')) return 'adsBudget.manage';
  }
  return 'adsBudget.track';
};

/** POST /api/boards/:boardId/ads-budget */
const createRow = async (req, res) => {
  try {
    const ctx = await gate(req, res, 'adsBudget.manage');
    if (!ctx) return undefined;
    const { board } = ctx;

    const body = req.body || {};
    const errors = [];

    /**
     * THE PARENT IS RESOLVED FIRST, and it is what makes the rest optional.
     *
     * A campaign inherits its platform's channel, client and month — it is the
     * same channel, for the same client, in the same month, by construction.
     * Demanding them again would make the caller keep four fields in step, and
     * any disagreement between them would file a campaign under a month its
     * parent is not in, where it would show up in neither.
     */
    let parent = null;
    if (body.parent) {
      if (!isValidId(body.parent)) {
        errors.push({ field: 'parent', message: 'That is not a valid platform.' });
      } else {
        parent = await AdsBudget.findOne({ _id: body.parent, board: board._id }).lean();
        if (!parent) {
          errors.push({ field: 'parent', message: 'That platform is not on this board.' });
        } else if (parent.parent) {
          // One level of nesting, deliberately. A campaign inside a campaign has
          // no meaning here, and allowing it would make every total recursive.
          errors.push({ field: 'parent', message: 'A campaign cannot sit inside another campaign.' });
          parent = null;
        }
      }
    }

    // `creating` here means "this row must name its own platform" — which a
    // campaign does not, because the line above already answered it.
    const { patch, errors: fieldErrors } = readBody(body, { creating: !parent });
    errors.push(...fieldErrors);

    if (!parent) {
      if (!isValidId(body.group)) {
        errors.push({ field: 'group', message: 'Say which client this budget belongs to.' });
      }
      if (!isMonthKey(body.monthKey)) {
        errors.push({ field: 'monthKey', message: 'That is not a valid month.' });
      }
    }

    if (errors.length > 0) return res.status(422).json({ error: errors[0].message, errors });

    const effectiveMonth = parent ? parent.monthKey : body.monthKey;
    const effectiveGroup = parent ? String(parent.group) : String(body.group);

    const group = await TaskGroup.findOne({ _id: effectiveGroup, board: board._id })
      .select('name')
      .lean();
    if (!group) return res.status(404).json({ error: 'Group not found on this board' });

    const siblingFilter = {
      board: board._id,
      monthKey: effectiveMonth,
      group: effectiveGroup,
      parent: parent ? parent._id : null,
    };
    const count = await AdsBudget.countDocuments(siblingFilter);
    const cap = parent ? MAX_CAMPAIGNS_PER_PLATFORM : MAX_PLATFORMS_PER_GROUP;
    if (count >= cap) {
      return res.status(422).json({
        error: parent
          ? `A platform can hold ${cap} campaigns.`
          : `A client can hold ${cap} platforms in one month.`,
      });
    }

    const last = await AdsBudget.findOne(siblingFilter).sort({ order: -1 }).select('order').lean();

    const row = await AdsBudget.create({
      ...patch,
      // A campaign inherits the channel it ran on rather than being asked for
      // it twice, unless it was given one explicitly.
      platform: patch.platform || (parent ? parent.platform : ''),
      board: board._id,
      organisation: board.organisation,
      group: effectiveGroup,
      monthKey: effectiveMonth,
      parent: parent ? parent._id : null,
      order: (last?.order ?? -1) + 1,
      createdBy: req.user.userId,
    });

    // Who committed this, and how much. Awaited rather than left to settle on
    // its own, so the ledger is not empty seconds after the money went in.
    // `logActivity` swallows its own failures, so waiting can never fail the
    // create.
    await logRowCreated({ row, actor: req.user.userId, groupName: group.name });

    await row.populate(POPULATE_PEOPLE);
    const window = windowFor(effectiveMonth, board);
    return res.status(201).json({ row: decorate(row.toObject(), window) });
  } catch (err) {
    console.error('createRow error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/** PATCH /api/ads-budget/:id */
const updateRow = async (req, res) => {
  try {
    // Gate on the LOWER rung first, so someone holding only `track` gets past
    // the door and is judged on what they actually asked to change.
    const loaded = await gateByRow(req, res, 'adsBudget.track');
    if (!loaded) return undefined;
    const { ctx, row } = loaded;
    const { board } = ctx;

    const { patch, errors } = readBody(req.body || {});
    if (errors.length > 0) return res.status(422).json({ error: errors[0].message, errors });
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'Nothing to change.' });
    }

    const needed = capabilityForPatch(patch, row);
    if (needed === 'adsBudget.manage') {
      const denied = requireCapability(
        ctx,
        'adsBudget.manage',
        'You can record spend on this board, but not change what was budgeted.'
      );
      if (denied) return res.status(denied.status).json({ error: denied.error });
    }

    // Taken BEFORE the assign, or the diff compares the row to its own mutated
    // self and finds nothing — and the ledger loses the entry.
    const before = snapshotRow(row);

    Object.assign(row, patch);
    row.updatedBy = req.user.userId;
    await row.save();

    const group = await TaskGroup.findById(row.group).select('name').lean();
    await logRowChanges({
      row,
      before,
      actor: req.user.userId,
      groupName: group?.name || '',
    });

    await row.populate(POPULATE_PEOPLE);
    const window = windowFor(row.monthKey, board);
    return res.json({ row: decorate(row.toObject(), window) });
  } catch (err) {
    console.error('updateRow error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/** DELETE /api/ads-budget/:id — takes a platform's campaigns with it. */
const deleteRow = async (req, res) => {
  try {
    const loaded = await gateByRow(req, res, 'adsBudget.manage');
    if (!loaded) return undefined;
    const { row } = loaded;

    const group = await TaskGroup.findById(row.group).select('name').lean();

    // Logged BEFORE the delete, while there is still a row to describe.
    await logRowDeleted({ row, actor: req.user.userId, groupName: group?.name || '' });

    // A platform's campaigns go with it. Left behind they would be money
    // attributed to a channel the board no longer lists — visible in no table
    // and counted in no total, which is the worst of both.
    let removedCampaigns = 0;
    if (!row.parent) {
      const children = await AdsBudget.find({ parent: row._id }).lean();
      for (const child of children) {
        await logRowDeleted({ row: child, actor: req.user.userId, groupName: group?.name || '' });
      }
      const result = await AdsBudget.deleteMany({ parent: row._id });
      removedCampaigns = result.deletedCount || 0;
    }

    await AdsBudget.deleteOne({ _id: row._id });
    return res.json({ ok: true, removedCampaigns });
  } catch (err) {
    console.error('deleteRow error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * PUT /api/boards/:boardId/ads-budget/reorder — body { orderedIds }
 *
 * The order rows sit in, for EVERYONE. Stored rather than kept in the mover's
 * browser, because "put the channel we actually care about at the top" is a
 * statement about the client's month, not about one person's screen.
 */
const reorderRows = async (req, res) => {
  try {
    const ctx = await gate(req, res, 'adsBudget.manage');
    if (!ctx) return undefined;
    const { board } = ctx;

    const { orderedIds } = req.body || {};
    if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
      return res.status(400).json({ error: 'orderedIds must be a non-empty array' });
    }
    if (!orderedIds.every(isValidId)) {
      return res.status(400).json({ error: 'orderedIds contains an invalid id' });
    }

    // Scoped to this board, so a crafted list cannot reorder another board's
    // rows through an endpoint this board's members can reach.
    const rows = await AdsBudget.find({ _id: { $in: orderedIds }, board: board._id })
      .select('_id')
      .lean();
    const known = new Set(rows.map((r) => String(r._id)));

    const ops = orderedIds
      .filter((id) => known.has(String(id)))
      .map((id, index) => ({
        updateOne: { filter: { _id: id }, update: { $set: { order: index } } },
      }));

    if (ops.length > 0) await AdsBudget.bulkWrite(ops);
    return res.json({ ok: true, reordered: ops.length });
  } catch (err) {
    console.error('reorderRows error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * PUT /api/boards/:id/ads-budget-settings — body { enabled, currency }
 *
 * The add-on's switch, and the one currency every figure on it is rendered in.
 * Gated WITHOUT the on-check, since turning it on necessarily happens while it
 * is off.
 */
const setSettings = async (req, res) => {
  try {
    const ctx = await gate(req, res, 'adsBudget.manage', { requireOn: false });
    if (!ctx) return undefined;
    const { board } = ctx;

    const { enabled, currency } = req.body || {};

    if (enabled !== undefined) {
      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'enabled must be true or false' });
      }
      board.adsBudget.enabled = enabled;
    }

    if (currency !== undefined) {
      const code = String(currency || '').trim().toUpperCase();
      // Three letters, which is what ISO 4217 is and what `Intl.NumberFormat`
      // will accept. Validated rather than trusted: an unknown code makes the
      // client's formatter throw on every cell of the page.
      if (!/^[A-Z]{3}$/.test(code)) {
        return res.status(400).json({ error: 'Currency must be a three-letter code, like USD.' });
      }
      board.adsBudget.currency = code;
    }

    await board.save();
    return res.json({ adsBudget: { enabled: board.adsBudget.enabled, currency: board.adsBudget.currency } });
  } catch (err) {
    console.error('setSettings error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

module.exports = {
  getRoster,
  getClient,
  getClientActivity,
  createRow,
  updateRow,
  deleteRow,
  reorderRows,
  setSettings,
  // Exported for the route table's own tests and for reuse by the boards router.
  capabilityForPatch,
  readBody,
};
