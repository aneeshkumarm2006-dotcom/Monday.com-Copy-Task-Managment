const mongoose = require('mongoose');
const ActivityLog = require('../models/ActivityLog');
const Goal = require('../models/Goal');
const Task = require('../models/Task');
const TaskGroup = require('../models/TaskGroup');
const User = require('../models/User');
const { loadBoardContext, requireCapability } = require('../utils/boardContext');
const {
  resolveFieldValue,
  collectUserIds,
  describeActivity,
  eventLabel,
} = require('../services/activityFormat');
const { buildTaskThreads } = require('../services/updateThread');

/**
 * Board activity export.
 *
 * Everything recorded against a board inside a date window, flattened into rows
 * the client turns into a CSV or a PDF. The file itself is built client-side —
 * this endpoint's job is the part that must not be done in a browser: deciding
 * who may read it, and resolving ids into names.
 *
 * THREE GATES, all here, none of them inferable from the others:
 *
 *   1. Board read access      — `loadBoardContext`. The log carries task names,
 *                               note bodies and comment snippets, so this is the
 *                               same door the board itself uses.
 *   2. `board.export_activity`— the capability. Owner implicitly, admin by
 *                               preset, delegable in the permissions matrix.
 *   3. `features.activityExport` — the person's own opt-in. Hiding the button in
 *                               the UI is a courtesy; THIS is what makes "off by
 *                               default for everyone" true.
 *
 * A user holding the capability but not the flag gets a 403, deliberately: the
 * flag is the switch they were asked to throw, and honouring it only in the UI
 * would make it decorative.
 *
 * THREE KINDS OF ROW come back from one query. A tracker board's monthly goals
 * write to the same `ActivityLog` collection under `goal` instead of `task`,
 * and a group's own lifecycle writes under `group`, so "everything recorded
 * against this board" now genuinely means everything — including who moved a
 * target and who deleted a whole client. `itemType` is what tells them apart in
 * the sheet; the task-field columns are simply blank on a goal or group row,
 * exactly as they are for a task that has been deleted.
 */

/** Hard ceiling on rows in one export. Beyond this the response is truncated. */
const MAX_ROWS = 10000;

/** Widest range accepted, in days. Anything larger is almost certainly a typo. */
const MAX_RANGE_DAYS = 366;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The task-field columns for a row whose task no longer exists. Deleted tasks
 * keep their events — that is half of what an audit export is for — so the row
 * stays and reports blanks rather than being dropped or left ragged.
 */
const EMPTY_TASK_FIELDS = {
  status: '',
  priority: '',
  assignees: [],
  dueDate: '',
  labels: [],
  checklistDone: 0,
  checklistTotal: 0,
  note: '',
  taskSource: '',
  portalRef: '',
  portalType: '',
  taskCreatedAt: '',
  taskUpdatedAt: '',
};

/**
 * Parse a `YYYY-MM-DD` (or any Date-parseable) query value into a Date.
 * `endOfDay` makes `to` inclusive — a user asking for "1st to 5th" means through
 * the end of the 5th, not 00:00 on it.
 */
const parseDay = (value, { endOfDay = false } = {}) => {
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  // A bare YYYY-MM-DD parses as UTC midnight; anchor the boundary in the
  // server's local day so the range lines up with the timestamps being filtered.
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    const [y, m, day] = String(value).split('-').map(Number);
    return endOfDay
      ? new Date(y, m - 1, day, 23, 59, 59, 999)
      : new Date(y, m - 1, day, 0, 0, 0, 0);
  }
  return d;
};

const toDayString = (date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

/**
 * GET /api/boards/:id/activity-export?from=YYYY-MM-DD&to=YYYY-MM-DD&threads=1
 *
 * `threads=0` drops the discussion threads from the response. They are the
 * single biggest thing in it — a chatty task carries more text than every
 * other column of every one of its rows put together — so the caller may
 * say no.
 */
const getActivityExport = async (req, res) => {
  try {
    const userId = req.user.userId;
    const boardId = req.params.id;

    if (!boardId || !mongoose.Types.ObjectId.isValid(boardId)) {
      return res.status(400).json({ error: 'Invalid board id' });
    }

    // ── Gate 1: can this person open the board at all? ──────────────────────
    const ctx = await loadBoardContext(boardId, userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

    // ── Gate 2: capability ──────────────────────────────────────────────────
    const denied = requireCapability(
      ctx,
      'board.export_activity',
      'You do not have permission to export this board'
    );
    if (denied) return res.status(denied.status).json({ error: denied.error });

    // ── Gate 3: the person's own opt-in ─────────────────────────────────────
    const me = await User.findById(userId).select('features').lean();
    if (!me?.features?.activityExport) {
      return res.status(403).json({
        error: 'Activity export is off. Turn it on in Settings → Extra features.',
        code: 'FEATURE_DISABLED',
      });
    }

    // ── Range ───────────────────────────────────────────────────────────────
    const now = new Date();
    const to = parseDay(req.query.to, { endOfDay: true })
      || new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    const from = parseDay(req.query.from)
      || new Date(to.getTime() - 29 * DAY_MS);

    if (req.query.from && !parseDay(req.query.from)) {
      return res.status(400).json({ error: 'Invalid "from" date' });
    }
    if (req.query.to && !parseDay(req.query.to, { endOfDay: true })) {
      return res.status(400).json({ error: 'Invalid "to" date' });
    }
    if (from > to) {
      return res.status(400).json({ error: '"from" must be on or before "to"' });
    }
    if (to - from > MAX_RANGE_DAYS * DAY_MS) {
      return res.status(400).json({
        error: `Range too wide — ${MAX_RANGE_DAYS} days maximum`,
      });
    }

    // Opt-out rather than opt-in: someone exporting a board's activity wants
    // what was SAID as much as what changed, and the snippet the log stores is
    // 80 characters of it.
    const includeThreads = !['0', 'false', 'no'].includes(
      String(req.query.threads ?? '').toLowerCase()
    );

    // ── Fetch ───────────────────────────────────────────────────────────────
    // +1 to detect truncation without a second count query.
    const raw = await ActivityLog.find({
      board: boardId,
      createdAt: { $gte: from, $lte: to },
    })
      .sort({ createdAt: 1 })
      .limit(MAX_ROWS + 1)
      .lean();

    const truncated = raw.length > MAX_ROWS;
    const entries = truncated ? raw.slice(0, MAX_ROWS) : raw;

    // ── Hydrate, all in batch ───────────────────────────────────────────────
    const groups = await TaskGroup.find({ board: boardId }).select('name').lean();
    const groupMap = new Map(groups.map((g) => [g._id.toString(), g.name]));
    // Groups drive what is visible on a board, so a task whose group was deleted
    // is orphaned — it renders nowhere in the UI. Same filter analytics applies,
    // for the same reason: an export that lists rows nobody can find on the
    // board reads as a data leak or a bug, never as a feature.
    const liveGroupIds = new Set(groupMap.keys());

    const taskIds = [...new Set(entries.map((e) => e.task?.toString()).filter(Boolean))];
    // Goal rows name their goal and its group in metadata, so a goal deleted
    // since the event still exports with a name rather than as a bare id — the
    // same reason a deleted task's rows keep `metadata.taskName`. The live
    // documents are read anyway, because a goal RENAMED since the event should
    // export under the name it has now, matching what the board shows.
    const goalIds = [...new Set(entries.map((e) => e.goal?.toString()).filter(Boolean))];
    const goals = goalIds.length
      ? await Goal.find({ _id: { $in: goalIds } }).select('name group monthKey type').lean()
      : [];
    const goalMap = new Map(goals.map((g) => [g._id.toString(), g]));
    const tasks = taskIds.length
      ? await Task.find({ _id: { $in: taskIds } })
          .select(
            'name group parent isPersonal status priority assignedTo dueDate '
            + 'labels checklist note source portalRef portalType createdAt updatedAt'
          )
          .lean()
      : [];
    const taskMap = new Map(tasks.map((t) => [t._id.toString(), t]));

    /**
     * The tasks' discussions — every message in full, not the log's snippet.
     *
     * Keyed off the EVENT ids rather than the tasks that survived the lookup
     * above, so a task deleted since its messages were written still exports
     * the conversation held on it — the same reason its rows are kept.
     *
     * Sent once per task at the top level and deliberately NOT folded into the
     * rows the way the field snapshot is: a twenty-message thread copied onto
     * each of that task's forty event rows is the same text eight hundred
     * times. The CSV repeats it per row because a spreadsheet column has to;
     * the wire does not.
     */
    const threads = includeThreads
      ? await buildTaskThreads(taskIds, {
        // Only a client board has two threads to tell apart.
        labelThreads: ctx.board.boardType === 'client',
      })
      : {};

    // Users referenced by the log AND by the assignee snapshot below, resolved in
    // one query — the assignees of a task are frequently nobody who appears in
    // the window's events, so the log's own ids are not enough.
    const userIds = new Set(collectUserIds(entries));
    for (const t of tasks) {
      for (const id of t.assignedTo || []) userIds.add(id.toString());
    }
    const users = userIds.size
      ? await User.find({ _id: { $in: [...userIds] } }).select('name profilePic').lean()
      : [];
    const userMap = new Map(users.map((u) => [u._id.toString(), u]));

    /**
     * The task's fields as they stand NOW, repeated on every row for that task.
     *
     * Deliberately the current values, not the values at the moment of the event:
     * the log records changes, not snapshots, so an as-of reconstruction would be
     * a guess for any field whose history starts before the window. A task that
     * has never had a due date simply reports an empty one, which is the point —
     * every column is present on every row so the sheet can be filtered and
     * pivoted, and blank means "not set" rather than "not exported".
     */
    const taskFields = (task) => {
      if (!task) return EMPTY_TASK_FIELDS;
      const status = resolveFieldValue('status', task.status, ctx.board, userMap);
      const labels = resolveFieldValue('labels', task.labels, ctx.board, userMap);
      const assignees = resolveFieldValue('assignees', task.assignedTo, ctx.board, userMap);
      const checklist = task.checklist || [];
      return {
        status: (status && status.name) || '',
        priority: task.priority || '',
        assignees: (assignees || []).map((a) => a.name),
        dueDate: task.dueDate ? new Date(task.dueDate).toISOString() : '',
        labels: (labels || []).map((l) => l.name),
        checklistDone: checklist.filter((c) => c.done).length,
        checklistTotal: checklist.length,
        note: task.note || '',
        taskSource: task.source || 'internal',
        portalRef: task.portalRef || '',
        portalType: task.portalType || '',
        taskCreatedAt: task.createdAt ? new Date(task.createdAt).toISOString() : '',
        taskUpdatedAt: task.updatedAt ? new Date(task.updatedAt).toISOString() : '',
      };
    };

    const rows = [];
    for (const e of entries) {
      const isGoalRow = !!e.goal;
      // A group's own lifecycle row — created, renamed, deleted. It has neither
      // a task nor a goal, and it is EXEMPT from the orphaned-group filter
      // below: `group.deleted` points at a group that by definition no longer
      // exists, so applying that rule would silently drop the single event the
      // filter's own rationale ("an audit export exists for exactly this") most
      // wants kept.
      const isGroupRow = !!e.group;
      const task = e.task ? taskMap.get(e.task.toString()) : null;
      const goal = e.goal ? goalMap.get(e.goal.toString()) : null;

      // A task deleted since the event was logged has no document left. Keep the
      // row — "Ann deleted the task" is exactly the kind of thing an audit export
      // exists for — and fall back to the name captured in the metadata.
      if (task && task.group && !liveGroupIds.has(task.group.toString())) continue;

      // The same orphan rule for goals, read from whichever of the two knows:
      // the live goal, or the group id the row recorded at the time.
      const goalGroupId = goal?.group
        ? goal.group.toString()
        : (e.metadata?.group ? String(e.metadata.group) : null);
      if (isGoalRow && goalGroupId && !liveGroupIds.has(goalGroupId)) continue;

      const actorDoc = e.actor ? userMap.get(e.actor.toString()) : null;
      let actorName;
      if (actorDoc) actorName = actorDoc.name;
      else if (e.actorType === 'client') actorName = e.actorLabel || 'Client';
      // Nobody was behind it — a scheduled connector run filling in a goal's
      // numbers. Named, because "Unknown" in an audit column reads as data loss.
      else if (e.actorType === 'system') actorName = e.actorLabel || 'Automatic';
      else actorName = 'Unknown';

      const hydrated = {
        ...e,
        actor: { name: actorName },
        oldValue: resolveFieldValue(e.field, e.oldValue, ctx.board, userMap, e),
        newValue: resolveFieldValue(e.field, e.newValue, ctx.board, userMap, e),
      };

      // Group moves store raw ObjectIds on both sides; name them.
      const groupNames = e.field === 'group'
        ? {
          oldGroupName: e.oldValue ? groupMap.get(e.oldValue.toString()) : undefined,
          newGroupName: e.newValue ? groupMap.get(e.newValue.toString()) : undefined,
        }
        : {};

      // A goal row borrows the item columns: its name goes where a task's name
      // goes, so the sheet stays one table rather than two half-empty ones, and
      // `itemType` is the column that says which it is.
      //
      // A group row names ITSELF in both columns: the group is the item, so
      // repeating it is the honest answer rather than leaving the item column
      // blank. Its name comes from the live document where one survives (a
      // group renamed since the event exports under the name the board shows
      // today, matching the goal rule above) and from the captured metadata
      // where it does not — which is every `group.deleted` row.
      const liveGroupName = e.group ? groupMap.get(e.group.toString()) : null;
      const groupRowName = liveGroupName || e.metadata?.groupName || '(deleted group)';

      let itemName;
      if (isGroupRow) itemName = groupRowName;
      else if (isGoalRow) itemName = goal?.name || e.metadata?.goalName || '(deleted goal)';
      else itemName = task?.name || e.metadata?.taskName || '(deleted task)';

      let groupName;
      if (isGroupRow) groupName = groupRowName;
      else if (isGoalRow) {
        groupName = (goalGroupId && groupMap.get(goalGroupId)) || e.metadata?.groupName || '';
      } else groupName = (task?.group && groupMap.get(task.group.toString())) || '';

      rows.push({
        at: e.createdAt,
        // The join key for `threads`; blank on a goal row, which has no thread.
        taskId: e.task ? e.task.toString() : '',
        actorName,
        actorType: e.actorType || 'user',
        itemType: isGroupRow ? 'group' : (isGoalRow ? 'goal' : 'task'),
        // Which month a goal belongs to — the one thing about it that has no
        // task equivalent, and the thing that makes a row of them sortable.
        monthKey: isGoalRow ? (goal?.monthKey || e.metadata?.monthKey || '') : '',
        groupName,
        taskName: itemName,
        isSubitem: !!task?.parent,
        type: e.type,
        eventLabel: eventLabel(e.type),
        field: e.field || '',
        description: describeActivity(hydrated, groupNames),
        ...taskFields(task),
      });
    }

    // The orphaned-group filter above drops rows; their threads go with them,
    // so the payload never carries a conversation the report does not show.
    const exportedTaskIds = new Set(rows.map((r) => r.taskId).filter(Boolean));
    for (const key of Object.keys(threads)) {
      if (!exportedTaskIds.has(key)) delete threads[key];
    }

    return res.json({
      board: { id: ctx.board._id, name: ctx.board.name },
      range: { from: toDayString(from), to: toDayString(to) },
      generatedAt: new Date().toISOString(),
      totalCount: rows.length,
      truncated,
      maxRows: MAX_ROWS,
      threads,
      rows,
    });
  } catch (err) {
    console.error('getActivityExport error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

module.exports = {
  getActivityExport,
  MAX_ROWS,
  MAX_RANGE_DAYS,
};
