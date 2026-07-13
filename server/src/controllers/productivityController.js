const mongoose = require('mongoose');
const Board = require('../models/Board');
const Task = require('../models/Task');
const Organisation = require('../models/Organisation');
const { resolveAccess, resolveOrgAccess } = require('../utils/permissions');

const VALID_RANGES = ['7d', '30d', 'all'];

const rangeToSince = (range) => {
  const now = new Date();
  if (range === '7d') {
    const d = new Date(now);
    d.setDate(d.getDate() - 7);
    return d;
  }
  if (range === '30d') {
    const d = new Date(now);
    d.setDate(d.getDate() - 30);
    return d;
  }
  return null;
};

// Day-level comparison, matching the client's dateUtils.isOverdue and the
// board's due-date buckets. A task due *today* is NOT overdue — only a due
// date on an earlier calendar day is. Comparing raw timestamps (dueDate is
// stored at midnight) would wrongly flag every "due today" task as overdue
// here while the rest of the app treats it as on-time.
const startOfDay = (input) => {
  const d = new Date(input);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
};

/**
 * GET /api/productivity?org=:orgId&range=:range
 *
 * Per-member productivity breakdown, over the boards the caller can read.
 *
 * YOUR OWN numbers are always yours to see; everyone ELSE's needs
 * `productivity.view_others`. So this is no longer admin-or-403 — a plain member
 * gets a one-row report of themselves, and `filters.scope` tells the client which
 * of the two it is looking at.
 *
 * Status filters previously matched the enum string `'done'`. After Phase 2,
 * `task.status` is an ObjectId pointing into the task's board.statuses
 * subdoc. We resolve a per-board map of legacy keys → ObjectIds so we can
 * keep producing the same notStarted/inProgress/stuck/done buckets.
 */
const getProductivity = async (req, res) => {
  try {
    const userId = req.user.userId;
    const orgId = req.query.org;
    const range = VALID_RANGES.includes(req.query.range)
      ? req.query.range
      : '30d';

    if (!orgId) {
      return res.status(400).json({ error: 'Organisation ID required' });
    }

    const org = await Organisation.findById(orgId)
      .populate('members', 'name email profilePic');
    if (!org) return res.status(404).json({ error: 'Organisation not found' });

    // Membership was never checked here — the old admin gate implied it. Under
    // the role model it does not: an unknown user resolves to the DEFAULT role,
    // so without this any authenticated user could pull any org's productivity
    // by passing its id. `members` is populated, so compare on `_id`.
    const isMember = (org.members || []).some(
      (m) => (m._id || m).toString() === userId
    );
    if (!isMember) {
      return res.status(403).json({ error: 'Not a member of this organisation' });
    }

    // Orgs created before the role system carry no `roles`, and the resolver
    // fails closed with nothing to resolve against. Seed on first touch.
    if (org.ensureSystemRoles()) await org.save();

    const orgAccess = resolveOrgAccess(org, userId);
    const canViewOthers = orgAccess.can('productivity.view_others');

    // Counts are computed across boards, so they must be computed across the
    // boards this caller may open. Otherwise a private board they were never
    // granted shows up as somebody's task name and board name under
    // `currentTasks` — and inflates every total besides.
    const orgBoards = (
      await Board.find({ organisation: orgId })
        .select('_id name statuses visibility publicDefaultLevel memberAccess createdBy')
    ).filter((b) => resolveAccess(b, org, userId).canRead);
    const orgBoardIds = orgBoards.map((b) => b._id);
    const boardNameById = new Map(
      orgBoards.map((b) => [b._id.toString(), b.name])
    );

    // status ObjectId (string) → legacy key
    const statusKeyById = new Map();
    const doneStatusIds = [];
    for (const b of orgBoards) {
      for (const s of b.statuses || []) {
        statusKeyById.set(s._id.toString(), s.key || null);
        if (s.key === 'done') doneStatusIds.push(s._id);
      }
    }

    const since = rangeToSince(range);
    const baseFilter = {
      board: { $in: orgBoardIds },
      isPersonal: { $ne: true },
      // Top-level tasks only. Subitems (parent set) are nested children that the
      // board never lists as standalone rows (getTasks filters parent: null), so
      // counting them here inflated members' totals/overdue with items they
      // couldn't see or manage from the board. `parent: null` also matches docs
      // where the field is absent, matching the getTasks convention.
      parent: null,
    };

    const now = new Date();
    const dueSoonCutoff = new Date(now);
    dueSoonCutoff.setDate(dueSoonCutoff.getDate() + 3);
    // Day-level anchors so "due today" is treated as on-time, consistent with
    // the client (dateUtils.isOverdue) and the board's due-date buckets.
    const todayStart = startOfDay(now).getTime();
    const dueSoonCutoffStart = startOfDay(dueSoonCutoff).getTime();

    const openMatch = {
      ...baseFilter,
      status: { $nin: doneStatusIds.length ? doneStatusIds : ['done'] },
    };
    const doneMatch = {
      ...baseFilter,
      status: { $in: doneStatusIds.length ? doneStatusIds : ['done'] },
    };
    if (since) doneMatch.updatedAt = { $gte: since };

    const [openTasks, doneAgg, currentTasksByUser] = await Promise.all([
      // For breakdown counts (notStarted / inProgress / stuck / overdue /
      // dueSoon) we need to bucket by the legacy `key` of the task's status.
      // The aggregation can't dereference an embedded subdoc in another
      // collection in a single op, so we pull the lightweight task list and
      // bucket in JS.
      Task.find(openMatch)
        .select('status assignedTo dueDate')
        .lean(),
      Task.aggregate([
        { $match: doneMatch },
        { $unwind: '$assignedTo' },
        {
          $group: {
            _id: '$assignedTo',
            done: { $sum: 1 },
          },
        },
      ]),
      Task.aggregate([
        {
          $match: {
            ...baseFilter,
            status: { $nin: doneStatusIds.length ? doneStatusIds : ['done'] },
          },
        },
        { $unwind: '$assignedTo' },
        { $sort: { dueDate: 1, updatedAt: -1 } },
        {
          $group: {
            _id: '$assignedTo',
            tasks: {
              $push: {
                _id: '$_id',
                name: '$name',
                status: '$status',
                priority: '$priority',
                dueDate: '$dueDate',
                board: '$board',
              },
            },
          },
        },
        { $project: { tasks: { $slice: ['$tasks', 5] } } },
      ]),
    ]);

    const openByUser = new Map();
    for (const task of openTasks) {
      const key = task.status ? statusKeyById.get(task.status.toString()) : null;
      const assignees = Array.isArray(task.assignedTo) ? task.assignedTo : [];
      let overdueHit = false;
      let dueSoonHit = false;
      if (task.dueDate) {
        const dueDay = startOfDay(task.dueDate).getTime();
        // Overdue: due on an earlier calendar day than today.
        overdueHit = dueDay < todayStart;
        // Due soon: due today through the cutoff day (inclusive), not overdue.
        dueSoonHit = dueDay >= todayStart && dueDay <= dueSoonCutoffStart;
      }
      for (const u of assignees) {
        const uid = u.toString();
        const cur = openByUser.get(uid) || {
          inProgress: 0,
          notStarted: 0,
          stuck: 0,
          overdue: 0,
          dueSoon: 0,
        };
        if (key === 'working_on_it') cur.inProgress += 1;
        else if (key === 'not_started') cur.notStarted += 1;
        else if (key === 'stuck') cur.stuck += 1;
        // Custom statuses are open but don't fit a canonical bucket — they
        // still count toward total via done+inProgress+notStarted+stuck below
        // only if their key matches; otherwise we treat them as notStarted.
        else if (!key) cur.notStarted += 1;
        if (overdueHit) cur.overdue += 1;
        if (dueSoonHit) cur.dueSoon += 1;
        openByUser.set(uid, cur);
      }
    }

    const doneByUser = new Map(
      doneAgg.map((r) => [r._id.toString(), r.done])
    );
    const tasksByUser = new Map(
      currentTasksByUser.map((r) => [r._id.toString(), r.tasks])
    );

    const adminIdSet = new Set(
      [
        org.admin ? org.admin.toString() : null,
        ...((org.admins || []).map((a) => a.toString())),
      ].filter(Boolean)
    );
    const ownerId = org.admin ? org.admin.toString() : null;

    // Your own row is always yours to read. Without `productivity.view_others`
    // the report narrows to exactly one person — you — instead of 403ing, which
    // is what "a user may always see their own stats" means in practice.
    const visibleMembers = canViewOthers
      ? org.members || []
      : (org.members || []).filter((m) => m._id.toString() === userId);

    const members = visibleMembers.map((m) => {
      const id = m._id.toString();
      const open = openByUser.get(id) || {};
      const done = doneByUser.get(id) || 0;
      const inProgress = open.inProgress || 0;
      const notStarted = open.notStarted || 0;
      const stuck = open.stuck || 0;
      const overdue = open.overdue || 0;
      const dueSoon = open.dueSoon || 0;
      const total = done + inProgress + notStarted + stuck;
      const completionRate = total === 0 ? 0 : Math.round((done / total) * 100);
      const currentTasks = (tasksByUser.get(id) || []).map((t) => ({
        _id: t._id,
        name: t.name,
        // Surface the legacy key so existing UI chips keep colouring; if it's
        // a custom status, fall back to 'not_started' rather than the raw id.
        status: (t.status && statusKeyById.get(t.status.toString())) || 'not_started',
        priority: t.priority,
        dueDate: t.dueDate,
        boardId: t.board,
        boardName: boardNameById.get(t.board.toString()) || '',
      }));

      let role = 'member';
      if (id === ownerId) role = 'owner';
      else if (adminIdSet.has(id)) role = 'admin';

      return {
        user: {
          _id: m._id,
          name: m.name,
          email: m.email,
          profilePic: m.profilePic,
        },
        role,
        total,
        done,
        inProgress,
        notStarted,
        stuck,
        overdue,
        dueSoon,
        completionRate,
        currentTasks,
      };
    });

    members.sort((a, b) => {
      if (b.total !== a.total) return b.total - a.total;
      return (a.user.name || '').localeCompare(b.user.name || '');
    });

    const summary = members.reduce(
      (acc, m) => {
        acc.totalAssignments += m.total;
        acc.totalDone += m.done;
        acc.totalOverdue += m.overdue;
        acc.totalInProgress += m.inProgress;
        return acc;
      },
      {
        memberCount: members.length,
        totalAssignments: 0,
        totalDone: 0,
        totalOverdue: 0,
        totalInProgress: 0,
      }
    );
    summary.avgCompletionRate =
      summary.totalAssignments === 0
        ? 0
        : Math.round((summary.totalDone / summary.totalAssignments) * 100);

    return res.json({
      summary,
      members,
      // `scope` lets the client tell "the whole team" apart from "just you" —
      // a one-row team report and a personal report are otherwise identical on
      // the wire, and it would render the former as a broken version of itself.
      filters: { range, scope: canViewOthers ? 'org' : 'self' },
    });
  } catch (err) {
    console.error('getProductivity error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

module.exports = {
  getProductivity,
};
