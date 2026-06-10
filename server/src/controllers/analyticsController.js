const mongoose = require('mongoose');
const Board = require('../models/Board');
const Task = require('../models/Task');
const TaskGroup = require('../models/TaskGroup');
const Organisation = require('../models/Organisation');

const LEGACY_STATUS_KEYS = ['not_started', 'working_on_it', 'done', 'stuck'];
const PRIORITIES = ['critical', 'high', 'medium', 'low'];
const VALID_RANGES = ['7d', '30d', 'all'];

/**
 * Convert a range string into a Date floor, or null for "all".
 */
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

/**
 * GET /api/analytics?org=:orgId&board=:boardId&range=:range
 *
 * Admin-only. Returns aggregated analytics for the org.
 *
 * Status distribution buckets each task by the `key` field on its board's
 * status subdoc (post Phase 2 migration). New user-defined statuses are
 * collapsed into a single "custom" bucket so the four canonical buckets
 * keep rendering as the UI expects.
 */
const getAnalytics = async (req, res) => {
  try {
    const userId = req.user.userId;
    const orgId = req.query.org;
    const boardFilter = req.query.board && req.query.board !== 'all'
      ? req.query.board
      : null;
    const range = VALID_RANGES.includes(req.query.range)
      ? req.query.range
      : '30d';

    if (!orgId) {
      return res.status(400).json({ error: 'Organisation ID required' });
    }

    const org = await Organisation.findById(orgId)
      .populate('members', 'name email profilePic');
    if (!org) return res.status(404).json({ error: 'Organisation not found' });
    const isAdmin =
      (org.admin && org.admin.toString() === userId) ||
      (Array.isArray(org.admins) && org.admins.some((a) => a.toString() === userId));
    if (!isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const orgBoards = await Board.find({ organisation: orgId })
      .select('_id name statuses')
      .sort({ createdAt: 1 });
    const orgBoardIds = orgBoards.map((b) => b._id);

    let scopedBoardIds = orgBoardIds;
    if (boardFilter) {
      if (!mongoose.Types.ObjectId.isValid(boardFilter)) {
        return res.status(400).json({ error: 'Invalid board id' });
      }
      const match = orgBoardIds.find((id) => id.toString() === boardFilter);
      if (!match) {
        return res.status(404).json({ error: 'Board not found in organisation' });
      }
      scopedBoardIds = [match];
    }

    const since = rangeToSince(range);
    // Count only tasks that are actually reachable on a board — i.e. those
    // whose group still exists. Groups drive the rows rendered in the board
    // UI, so a task whose group was deleted is orphaned: it never appears on
    // the board, yet it was still being counted here. That made "Board
    // Performance" disagree with what users see (a stray Not Started task in a
    // deleted group held REPORTS at 91% though every visible task was Done).
    const liveGroupIds = await TaskGroup.distinct('_id', {
      board: { $in: scopedBoardIds },
    });
    const baseFilter = {
      board: { $in: scopedBoardIds },
      isPersonal: { $ne: true },
      group: { $in: liveGroupIds },
    };
    const taskFilter = { ...baseFilter };
    if (since) taskFilter.createdAt = { $gte: since };
    // Overdue reflects current state — a task created before the analytics
    // window is still overdue today, so don't apply the createdAt range here.
    const overdueFilter = { ...baseFilter };

    // Build a map: status ObjectId (string) → legacy key (or null for custom).
    // Also pluck the "done" ObjectIds per board for the overdue + per-board
    // completion counts.
    const statusKeyById = new Map();
    const doneIdsByBoard = new Map(); // boardId → Set<doneStatusId>
    const allDoneIds = [];
    for (const b of orgBoards) {
      const doneSet = new Set();
      for (const s of b.statuses || []) {
        statusKeyById.set(s._id.toString(), s.key || null);
        if (s.key === 'done') {
          doneSet.add(s._id.toString());
          allDoneIds.push(s._id);
        }
      }
      doneIdsByBoard.set(b._id.toString(), doneSet);
    }

    const [tasksForStatus, priorityAgg, overdueTasks, perBoardAgg, totalTasks] =
      await Promise.all([
        Task.find(taskFilter).select('status board').lean(),
        Task.aggregate([
          { $match: taskFilter },
          { $group: { _id: '$priority', count: { $sum: 1 } } },
        ]),
        Task.find({
          ...overdueFilter,
          status: { $nin: allDoneIds.length ? allDoneIds : ['done'] },
          dueDate: { $ne: null, $lt: new Date() },
        })
          .select('priority assignedTo dueDate')
          .lean(),
        Task.aggregate([
          { $match: taskFilter },
          {
            $group: {
              _id: { board: '$board', status: '$status' },
              count: { $sum: 1 },
            },
          },
        ]),
        Task.countDocuments(taskFilter),
      ]);

    // Overdue breakdown: by priority, by assignee, average days overdue.
    const nowMs = Date.now();
    const MS_PER_DAY = 86400000;
    const overdueByPriority = Object.fromEntries(PRIORITIES.map((p) => [p, 0]));
    const overdueByAssignee = new Map();
    let unassignedOverdue = 0;
    let daysOverdueSum = 0;
    for (const t of overdueTasks) {
      if (t.priority && overdueByPriority[t.priority] !== undefined) {
        overdueByPriority[t.priority] += 1;
      }
      const dayDiff = Math.floor(
        (nowMs - new Date(t.dueDate).getTime()) / MS_PER_DAY
      );
      daysOverdueSum += Math.max(0, dayDiff);
      const assignees = Array.isArray(t.assignedTo) ? t.assignedTo : [];
      if (assignees.length === 0) {
        unassignedOverdue += 1;
      } else {
        for (const u of assignees) {
          const uid = u.toString();
          overdueByAssignee.set(uid, (overdueByAssignee.get(uid) || 0) + 1);
        }
      }
    }
    const memberById = new Map(
      (org.members || []).map((m) => [m._id.toString(), m])
    );
    const assigneeBuckets = [...overdueByAssignee.entries()].map(([uid, count]) => {
      const m = memberById.get(uid);
      return {
        _id: uid,
        name: m?.name || 'Unknown',
        profilePic: m?.profilePic || null,
        count,
        unassigned: false,
      };
    });
    if (unassignedOverdue > 0) {
      assigneeBuckets.push({
        _id: '__unassigned__',
        name: 'Unassigned',
        profilePic: null,
        count: unassignedOverdue,
        unassigned: true,
      });
    }
    const topOverdueAssignees = assigneeBuckets
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
    const avgDaysOverdue =
      overdueTasks.length === 0
        ? 0
        : Math.round(daysOverdueSum / overdueTasks.length);

    // Bucket status counts by legacy key (custom statuses are dropped from
    // the canonical 4 buckets, but still counted in totalTasks).
    const statusCounts = Object.fromEntries(LEGACY_STATUS_KEYS.map((k) => [k, 0]));
    for (const t of tasksForStatus) {
      if (t.status == null) continue;
      const key = statusKeyById.get(t.status.toString());
      if (key && statusCounts[key] !== undefined) {
        statusCounts[key] += 1;
      } else if (typeof t.status === 'string' && statusCounts[t.status] !== undefined) {
        // Personal-style legacy strings — shouldn't happen on board tasks,
        // but tolerate them.
        statusCounts[t.status] += 1;
      }
    }
    const statusDistribution = LEGACY_STATUS_KEYS.map((status) => ({
      status,
      count: statusCounts[status] || 0,
    }));

    const priorityMap = Object.fromEntries(
      priorityAgg.map((r) => [r._id, r.count])
    );
    const priorityDistribution = PRIORITIES.map((priority) => ({
      priority,
      count: priorityMap[priority] || 0,
    }));

    // Per-board total + done counts
    const perBoardStats = new Map();
    for (const row of perBoardAgg) {
      const bId = row._id.board.toString();
      const sId = row._id.status ? row._id.status.toString() : null;
      const stat = perBoardStats.get(bId) || { total: 0, done: 0 };
      stat.total += row.count;
      const doneSet = doneIdsByBoard.get(bId);
      if (sId && doneSet && doneSet.has(sId)) stat.done += row.count;
      perBoardStats.set(bId, stat);
    }
    const boardPerformance = orgBoards
      .filter((b) => scopedBoardIds.some((id) => id.toString() === b._id.toString()))
      .map((b) => {
        const stat = perBoardStats.get(b._id.toString()) || { total: 0, done: 0 };
        const total = stat.total;
        const done = stat.done;
        const percent = total === 0 ? 0 : Math.round((done / total) * 100);
        return { _id: b._id, name: b.name, total, done, percent };
      });

    const activeBoards = boardPerformance.filter((b) => b.total > 0).length;
    const doneTotal = statusCounts.done || 0;
    const completionRate =
      totalTasks === 0 ? 0 : Math.round((doneTotal / totalTasks) * 100);

    return res.json({
      summary: {
        totalTasks,
        completionRate,
        overdueTasks: overdueTasks.length,
        activeBoards,
      },
      statusDistribution,
      priorityDistribution,
      boardPerformance,
      overdue: {
        count: overdueTasks.length,
        avgDaysOverdue,
        byPriority: PRIORITIES.map((priority) => ({
          priority,
          count: overdueByPriority[priority] || 0,
        })),
        topAssignees: topOverdueAssignees,
      },
      boards: orgBoards.map((b) => ({ _id: b._id, name: b.name })),
      filters: {
        board: boardFilter || 'all',
        range,
      },
    });
  } catch (err) {
    console.error('getAnalytics error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

module.exports = {
  getAnalytics,
};
