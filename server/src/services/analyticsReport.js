/**
 * analyticsReport.js — the Analytics page's numbers, as a callable.
 *
 * This file contains no new logic. Every query, every bucket and every comment
 * below was lifted VERBATIM out of `controllers/analyticsController.getAnalytics`,
 * which was one 300-line handler. The move happened the moment a SECOND caller
 * appeared: the executive home's `workspaceNumbers` section, which needs the
 * four figures in `summary` (total tasks, completion rate, overdue, active
 * boards) for a range and an optional board filter.
 *
 * Why that second caller could not simply run its own queries:
 *
 *   - `summary` is NOT a standalone query. `completionRate` comes out of the
 *     status buckets, which come out of the legacy-key map built from every
 *     board's `statuses` subdoc; `activeBoards` comes out of `boardPerformance`,
 *     which comes out of the per-board aggregation; `overdueTasks` comes out of
 *     the overdue scan with its own filter (no `createdAt` floor). Four numbers,
 *     five aggregations, all interdependent. A re-implementation gets one of the
 *     joins subtly wrong and nobody notices.
 *   - If it did get them wrong, the failure is the worst kind: the executive
 *     home says 412 open tasks and 64% done, the Analytics page says 407 and
 *     67%, and neither screen is obviously the liar. Two sets of numbers for the
 *     same workspace is not a bug anyone can debug from a screenshot.
 *   - The reach rule (`resolveAccess(...).canRead` per board, below) is the part
 *     that MUST NOT be re-typed. It is what stops a private board's name,
 *     completion rate and overdue assignees leaking into a report. One copy.
 *
 * ZERO BEHAVIOUR CHANGE for every input the Analytics page can produce. The
 * object returned here is the exact object `getAnalytics` used to hand to
 * `res.json`, with its keys in the same order, so the wire bytes are unchanged.
 * If something in here looks like it wants improving, that is a separate commit
 * with its own tests.
 *
 * The one deliberate exception, made when the second caller arrived: `90d` is
 * now an accepted range (see `RANGE_DAYS`). No existing input's response
 * changes and no screen sends it; it is called out here so "unchanged" is not
 * read as "untouched".
 *
 * WHAT DELIBERATELY STAYED IN THE CONTROLLER: request parsing (`org`, `board`,
 * `range` off the query string), loading and populating the Organisation, the
 * membership check, `ensureSystemRoles`, the `analytics.view` gate, and the
 * `productivity.view_others` decision. Those are HTTP-request policy, and the
 * controller stays the single place that reads `req`. `canSeeOthers` is passed
 * IN rather than resolved here so the withholding below is decided once, by the
 * caller that knows who is asking.
 *
 * WHY REQUEST FAILURES ARE RETURNED, NOT THROWN: two of the outcomes below are
 * refusals about the caller's input (a malformed board id, a board outside their
 * reach), not faults. They come back as `{ error, status }` and the caller maps
 * them to a response. Throwing would put them in the controller's catch, which
 * exists for genuine faults (a dead database) and answers 500 — turning a
 * deliberate 404 into a server error.
 */

const mongoose = require('mongoose');
const Board = require('../models/Board');
const Task = require('../models/Task');
const TaskGroup = require('../models/TaskGroup');
const { resolveAccess } = require('../utils/permissions');

const LEGACY_STATUS_KEYS = ['not_started', 'working_on_it', 'done', 'stuck'];
const PRIORITIES = ['critical', 'high', 'medium', 'low'];

/**
 * The ranges this report understands, as `key → days back from now` (null =
 * no floor at all). ONE table, so the list callers validate against and the
 * date floor the queries use cannot disagree about what a range means.
 *
 * They disagreed once, which is why this is a table and no longer two
 * hand-maintained lists: the accepted list said `7d / 30d / all` while the
 * executive home's section config was specified as `7d / 30d / 90d / all`. A
 * section configured for 90 days therefore matched no branch, got no
 * `createdAt` floor, and reported ALL-TIME totals under a "90 days" heading —
 * no error, no log, nothing to compare it against. Silently-wrong numbers on a
 * reporting screen are the one failure this whole file exists to prevent (see
 * the header), so `90d` is a first-class range here.
 *
 * Widening this list also widens what `GET /api/analytics?range=` accepts,
 * which is deliberate and safe: it is purely additive (no existing input's
 * response changes — `90d` used to fall back to the `30d` default), and the
 * Analytics page's own dropdown still offers only 7d / 30d / all, so nothing
 * on screen changes until someone adds the option there.
 */
const RANGE_DAYS = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  all: null,
};
const VALID_RANGES = Object.keys(RANGE_DAYS);

/**
 * Convert a range string into a Date floor, or null for "all".
 *
 * An unrecognised range degrades to "all" rather than throwing. That is the
 * behaviour the endpoint has always had (the controller substitutes its own
 * default before we ever see it) and this function is not the place to start
 * refusing input — but it is why every caller must validate against
 * `VALID_RANGES` first, or a typo reports lifetime numbers under whatever
 * label it typed.
 */
const rangeToSince = (range) => {
  const days = RANGE_DAYS[range];
  // `null` ('all') and `undefined` (unknown) both mean "no floor". Tested for
  // type rather than truthiness so a future 0-day range would not read as one.
  if (typeof days !== 'number') return null;
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
};

/**
 * Build the whole Analytics payload for one workspace as ONE caller sees it.
 *
 * Reports ONLY over the boards that caller can read. That is a separate question
 * from whether they hold `analytics.view` — the capability buys you the report,
 * it does not buy you the boards — and the gate lives with the caller while the
 * per-board filtering lives here, because the filtering is what the numbers are
 * made of.
 *
 * Status distribution buckets each task by the `key` field on its board's
 * status subdoc (post Phase 2 migration). New user-defined statuses are
 * collapsed into a single "custom" bucket so the four canonical buckets
 * keep rendering as the UI expects.
 *
 * @param {Object} args
 * @param {Object} args.org  the loaded Organisation document. MUST have
 *   `members` populated with at least `name` and `profilePic` — the overdue
 *   assignee buckets read those off it, and an unpopulated ref renders as
 *   "Unknown" for every person.
 * @param {string} args.userId  the caller, for `resolveAccess` per board.
 * @param {string} args.range  one of VALID_RANGES. Validate against that export
 *   in the caller — anything unrecognised falls through `rangeToSince` to "all",
 *   which reports lifetime numbers under whatever label the caller printed.
 * @param {string|Object|null} [args.boardFilter]  a single board to narrow to,
 *   or null for every readable board. Accepts an id string, an ObjectId, or a
 *   loaded board; it is normalised with the `idOf` idiom before anything
 *   compares it, so a caller reading one out of a Mixed config field cannot
 *   hand over a shape that quietly matches nothing.
 * @param {boolean} [args.canSeeOthers]  does the caller hold
 *   `productivity.view_others`? Defaults to FALSE — fail closed, so a caller
 *   that forgets to resolve it withholds names rather than publishing them.
 * @returns {Promise<Object>} the payload
 *   `{ summary, statusDistribution, priorityDistribution, boardPerformance,
 *      overdue, boards, filters }`, or `{ error, status }` for a request-level
 *   refusal (see the header).
 */
const buildAnalytics = async ({
  org,
  userId,
  range,
  boardFilter = null,
  canSeeOthers = false,
}) => {
  // Take the id off the loaded document rather than accepting a second string:
  // the caller found `org` BY that id, so this is the same value, already cast.
  const orgId = org._id;

  // Every figure below aggregates ACROSS boards, so it must aggregate only
  // across boards this caller may open. A private board they were never
  // granted would otherwise surface here as its name in the board picker, its
  // completion rate in Board Performance, and — worst — its overdue tasks by
  // name and assignee. The numbers are the leak.
  const allOrgBoards = await Board.find({ organisation: orgId })
    .select('_id name statuses visibility publicDefaultLevel memberAccess createdBy')
    .sort({ createdAt: 1 });
  const orgBoards = allOrgBoards.filter(
    (b) => resolveAccess(b, org, userId).canRead
  );
  const orgBoardIds = orgBoards.map((b) => b._id);

  // Normalise the caller's board id to a string ONCE, here, because three
  // things below have to agree about it: the validity check, the match against
  // the readable boards, and the echo in `filters`.
  //
  // `String(x?._id || x)` is the house idiom (`idOf`, utils/permissions.js) and
  // it is load-bearing on THIS side of the comparison. While `getAnalytics` was
  // the only caller the value was always a query-string string; the executive
  // home reads it out of a Mixed section-config field, which preserves whatever
  // BSON type was written, so it can arrive as an ObjectId — or, if a caller
  // ever hands over a board it already loaded, as a whole document. A bare
  // `=== boardFilter` against any of those matches NO board, and the caller is
  // then told the board does not exist: an access-denied message for a board
  // they can read perfectly well, with nothing in any log to contradict it.
  // (The ids on the other side of the comparison come straight out of Mongo and
  // are always ObjectIds — it is only the caller's value that can be anything.)
  const wantedBoardId = boardFilter
    ? String(boardFilter?._id || boardFilter)
    : null;

  let scopedBoardIds = orgBoardIds;
  if (wantedBoardId) {
    if (!mongoose.Types.ObjectId.isValid(wantedBoardId)) {
      return { error: 'Invalid board id', status: 400 };
    }
    // `orgBoardIds` is already narrowed to what the caller can read, so a board
    // that exists but is closed to them 404s here rather than 403s. That is
    // deliberate: a 403 would confirm the board exists.
    const match = orgBoardIds.find((id) => String(id) === wantedBoardId);
    if (!match) {
      return { error: 'Board not found in workspace', status: 404 };
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
  const statusMetaById = new Map(); // statusId → { name, color } (for overdue detail chips)
  const boardNameById = new Map(); // boardId → name (for overdue task rows)
  const doneIdsByBoard = new Map(); // boardId → Set<doneStatusId>
  const allDoneIds = [];
  for (const b of orgBoards) {
    boardNameById.set(b._id.toString(), b.name);
    const doneSet = new Set();
    for (const s of b.statuses || []) {
      statusKeyById.set(s._id.toString(), s.key || null);
      statusMetaById.set(s._id.toString(), { name: s.name, color: s.color });
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
        .select('name priority assignedTo dueDate board status')
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
  // Detailed per-assignee task lists power the full-screen "Overdue Tasks"
  // breakdown that opens when the viewer clicks the overdue stat card.
  const overdueTasksByAssignee = new Map(); // uid → [taskDetail]
  const unassignedTaskDetails = [];
  let unassignedOverdue = 0;
  let daysOverdueSum = 0;
  for (const t of overdueTasks) {
    if (t.priority && overdueByPriority[t.priority] !== undefined) {
      overdueByPriority[t.priority] += 1;
    }
    const dayDiff = Math.max(
      0,
      Math.floor((nowMs - new Date(t.dueDate).getTime()) / MS_PER_DAY)
    );
    daysOverdueSum += dayDiff;
    const statusMeta = t.status ? statusMetaById.get(t.status.toString()) : null;
    const detail = {
      _id: t._id,
      name: t.name,
      boardId: t.board || null,
      boardName: (t.board && boardNameById.get(t.board.toString())) || 'Board',
      dueDate: t.dueDate,
      daysOverdue: dayDiff,
      priority: t.priority || null,
      status: statusMeta ? { name: statusMeta.name, color: statusMeta.color } : null,
    };
    const assignees = Array.isArray(t.assignedTo) ? t.assignedTo : [];
    if (assignees.length === 0) {
      unassignedOverdue += 1;
      unassignedTaskDetails.push(detail);
    } else {
      for (const u of assignees) {
        const uid = u.toString();
        overdueByAssignee.set(uid, (overdueByAssignee.get(uid) || 0) + 1);
        const arr = overdueTasksByAssignee.get(uid) || [];
        arr.push(detail);
        overdueTasksByAssignee.set(uid, arr);
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

  // Full per-person breakdown (every assignee, every overdue task) for the
  // drill-down popup. Tasks are ordered most-overdue first; people by load.
  const sortTasks = (tasks) =>
    tasks.slice().sort((a, b) => b.daysOverdue - a.daysOverdue);
  const overdueByAssigneeDetail = [...overdueTasksByAssignee.entries()]
    .map(([uid, tasks]) => {
      const m = memberById.get(uid);
      return {
        _id: uid,
        name: m?.name || 'Unknown',
        profilePic: m?.profilePic || null,
        unassigned: false,
        count: tasks.length,
        tasks: sortTasks(tasks),
      };
    })
    .sort((a, b) => b.count - a.count);
  if (unassignedTaskDetails.length > 0) {
    overdueByAssigneeDetail.push({
      _id: '__unassigned__',
      name: 'Unassigned',
      profilePic: null,
      unassigned: true,
      count: unassignedTaskDetails.length,
      tasks: sortTasks(unassignedTaskDetails),
    });
  }
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

  // Key order is part of the contract here: this object used to be the literal
  // handed straight to `res.json`, and it still is. Do not reorder.
  return {
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
      // Naming individuals and how much late work each is carrying is a
      // different question from "may you open the dashboard", and it is the one
      // `productivity.view_others` exists to answer. Withholding it in the UI
      // alone would have been theatre — the names were still on the wire.
      ...(canSeeOthers
        ? {
            topAssignees: topOverdueAssignees,
            byAssignee: overdueByAssigneeDetail,
          }
        : { topAssignees: [], byAssignee: {} }),
    },
    boards: orgBoards.map((b) => ({ _id: b._id, name: b.name })),
    filters: {
      // The NORMALISED id, so this echo is a string for every caller. For the
      // HTTP endpoint that is byte-identical to what it always sent (the value
      // arrived as a string); for a caller whose id came out of a Mixed field
      // it is the difference between a board id and a serialised ObjectId.
      board: wantedBoardId || 'all',
      range,
    },
  };
};

module.exports = {
  buildAnalytics,
  // Exported so the controller stays the ONE place that parses request params:
  // it validates `?range=` against this list before calling in, and any other
  // caller (the executive home's section config) validates against the same
  // list rather than keeping its own copy that can drift.
  //
  // It is derived from `RANGE_DAYS`, not typed out beside it, so validating
  // against it can never accept a range the queries do not actually implement.
  // That is the failure it had: a list saying one thing, the date floor saying
  // another, and a report that answered with lifetime numbers either way.
  VALID_RANGES,
};
