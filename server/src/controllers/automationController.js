const mongoose = require('mongoose');
const Board = require('../models/Board');
const Task = require('../models/Task');
const TaskGroup = require('../models/TaskGroup');
const User = require('../models/User');
const Automation = require('../models/Automation');
const {
  createNotificationsForUsers,
  filterByEmailPreference,
} = require('../services/notificationService');
const { sendTaskAssignmentEmail } = require('../services/emailService');
const {
  computeNextRunAt,
  validateSchedule,
} = require('../services/automationSchedule');
const { resolveBoardAccess } = require('../utils/boardAccess');
const { loadBoardContext, requireCapability } = require('../utils/boardContext');
const { filterUsersWithBoardRead } = require('../utils/boardAudience');
const { buildTaskDeepLink } = require('../utils/taskDeepLink');

const VALID_PRIORITIES = ['critical', 'high', 'medium', 'low'];
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Automations are board CONTENT, not an org-wide admin power.
 *
 * Every gate on this file is the shared two-layer AND (`org role && board
 * level`) from `loadBoardContext`: reading a board's automations needs
 * `automation.view`, and creating, editing, deleting or running one needs
 * `automation.manage`. Permission used to be resolved with a bare
 * `isOrgAdmin(org, userId)` that never consulted the board at all, which got it
 * backwards in both directions — an org admin could manage automations on a
 * private board they cannot even open, while a board's own creator could not
 * manage automations on their own board unless they happened to be an admin.
 */

/**
 * Assignees must be able to READ the board, not merely belong to the org.
 * Assigning someone spawns a notification and an email deep-linking the board,
 * so an org-only check meant an automation on a private board could hand work to
 * a person who then hits a 403 when they click through.
 *
 * `board` may be null for callers that only have an org (none today) — in that
 * case we fall back to the org-membership check alone.
 */
const validateAssignees = async (assignedTo, org, board) => {
  if (!Array.isArray(assignedTo)) return { ids: [] };
  const memberIds = new Set(org.members.map((m) => m.toString()));
  const seen = new Set();
  const ids = [];
  for (const raw of assignedTo) {
    if (!raw) continue;
    const id = raw.toString();
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return { error: 'Invalid assignee id' };
    }
    if (!memberIds.has(id)) {
      return { error: 'Assignee is not a member of this organisation' };
    }
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (!ids.length || !board) return { ids };

  const readable = new Set(
    ids.filter((id) => resolveBoardAccess(board, org, id).canRead)
  );
  const blocked = ids.filter((id) => !readable.has(id));
  if (blocked.length) {
    return { error: 'Assignee does not have access to this board' };
  }
  return { ids };
};

const populateAutomation = (query) =>
  query
    .populate('taskTemplate.group', 'name')
    .populate('taskTemplate.assignedTo', 'name profilePic email')
    .populate('actions.config.group', 'name')
    .populate('actions.config.assignedTo', 'name profilePic email')
    .populate('groupCreatedTaskTemplates.assignedTo', 'name profilePic email')
    .populate('createdBy', 'name profilePic email');

const VALID_TRIGGER_TYPES = ['SCHEDULE', 'ITEM_CREATED', 'GROUP_CREATED'];
const VALID_CONDITION_TYPES = ['ITEM_IN_GROUP', 'ITEM_IN_STATUS', 'GROUP_NAME_MATCHES'];
const VALID_ACTION_TYPES = ['CREATE_TASK', 'CREATE_SUBITEM', 'POSITION_ITEM'];

// POSITION_ITEM strategies: how an automation (re)orders the triggering task's
// group when a task is created. `top` floats the new task first; the rest
// re-sort the whole group by that field.
const POSITION_STRATEGIES = ['top', 'dueDate', 'priority', 'assignee'];
// Ascending rank so `critical` sorts before `low` (mirrors the priority enum
// order used across the app).
const PRIORITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

// Map each triggerType to the condition types that are legal for it. Used by
// sanitizeConditions so a GROUP_CREATED automation can't carry an
// ITEM_IN_STATUS condition (and vice versa).
const CONDITION_TYPES_BY_TRIGGER = {
  ITEM_CREATED: ['ITEM_IN_GROUP', 'ITEM_IN_STATUS'],
  GROUP_CREATED: ['GROUP_NAME_MATCHES'],
};

/**
 * Validate + normalise a list of conditions. Returns { conditions } on
 * success, or { error } on failure.
 *   - ITEM_IN_GROUP      → value must be a TaskGroup id on `boardId`
 *   - ITEM_IN_STATUS     → value must be a status sub-doc id on `board.statuses`
 *   - GROUP_NAME_MATCHES → value must be a string compilable as a JS regex
 *
 * `allowedTypes` restricts which condition types are legal for the calling
 * trigger (e.g. only GROUP_NAME_MATCHES for GROUP_CREATED automations).
 */
const sanitizeConditions = async (
  rawConditions,
  board,
  boardId,
  allowedTypes = VALID_CONDITION_TYPES
) => {
  if (!Array.isArray(rawConditions)) return { conditions: [] };
  const conditions = [];
  const statusIds = new Set(
    (board?.statuses || []).map((s) => s._id.toString())
  );
  for (const raw of rawConditions) {
    if (!raw || typeof raw !== 'object') {
      return { error: 'Invalid condition' };
    }
    if (!allowedTypes.includes(raw.type)) {
      return { error: `Invalid condition type "${raw.type}"` };
    }

    if (raw.type === 'GROUP_NAME_MATCHES') {
      const pattern = raw.value == null ? '' : String(raw.value).trim();
      if (!pattern) {
        return { error: 'Group name pattern cannot be empty' };
      }
      try {
        new RegExp(pattern);
      } catch (err) {
        return { error: `Invalid group name pattern: ${err.message}` };
      }
      conditions.push({ type: raw.type, value: pattern });
      continue;
    }

    if (!raw.value || !mongoose.Types.ObjectId.isValid(raw.value)) {
      return { error: 'Condition value must be an ObjectId' };
    }
    const valueId = raw.value.toString();
    if (raw.type === 'ITEM_IN_GROUP') {
      const group = await TaskGroup.findById(valueId);
      if (!group || group.board.toString() !== boardId.toString()) {
        return { error: 'Condition group does not belong to board' };
      }
    } else if (raw.type === 'ITEM_IN_STATUS') {
      if (!statusIds.has(valueId)) {
        return { error: 'Condition status does not belong to board' };
      }
    }
    conditions.push({ type: raw.type, value: valueId });
  }
  return { conditions };
};

/**
 * Validate + normalise a `groupCreatedTaskTemplates` array. Each template
 * seeds one task in the newly-created group when a GROUP_CREATED automation
 * fires. Empty arrays are rejected — an automation that spawns nothing is
 * not useful.
 */
const sanitizeGroupCreatedTemplates = async (rawTemplates, org, board) => {
  if (!Array.isArray(rawTemplates) || rawTemplates.length === 0) {
    return { error: 'At least one task template is required' };
  }
  const templates = [];
  for (const raw of rawTemplates) {
    if (!raw || typeof raw !== 'object') {
      return { error: 'Invalid task template' };
    }
    if (!raw.name || !String(raw.name).trim()) {
      return { error: 'Template task name is required' };
    }
    const out = { name: String(raw.name).trim() };

    if (raw.priority !== undefined && raw.priority !== null && raw.priority !== '') {
      if (!VALID_PRIORITIES.includes(raw.priority)) {
        return { error: 'Invalid priority' };
      }
      out.priority = raw.priority;
    } else {
      out.priority = 'medium';
    }

    if (raw.assignedTo !== undefined) {
      const { ids, error } = await validateAssignees(raw.assignedTo, org, board);
      if (error) return { error };
      out.assignedTo = ids;
    } else {
      out.assignedTo = [];
    }

    if (raw.note) out.note = String(raw.note);

    let dueInDays = null;
    if (raw.dueInDays !== undefined && raw.dueInDays !== null && raw.dueInDays !== '') {
      const n = Number(raw.dueInDays);
      if (!Number.isFinite(n) || n < 0) {
        return { error: 'dueInDays must be a non-negative number' };
      }
      dueInDays = n;
    }
    out.dueInDays = dueInDays;

    templates.push(out);
  }
  return { templates };
};

/**
 * Validate + normalise a single action's `config` block. CREATE_TASK
 * requires `group`; CREATE_SUBITEM does not (it inherits from the
 * triggering task). All other fields are optional.
 */
const sanitizeActionConfig = async (actionType, rawConfig, board, boardId, org) => {
  const cfg = rawConfig || {};

  // POSITION_ITEM doesn't create a task — it only carries a sort strategy and
  // repositions the triggering task's group at run time. No name/group needed.
  if (actionType === 'POSITION_ITEM') {
    if (!POSITION_STRATEGIES.includes(cfg.strategy)) {
      return { error: 'POSITION_ITEM action requires a valid strategy' };
    }
    return { config: { strategy: cfg.strategy } };
  }

  if (!cfg.name || !String(cfg.name).trim()) {
    return { error: 'Action task name is required' };
  }

  const out = { name: String(cfg.name).trim() };

  if (actionType === 'CREATE_TASK') {
    if (!cfg.group || !mongoose.Types.ObjectId.isValid(cfg.group)) {
      return { error: 'CREATE_TASK action requires a group' };
    }
    const group = await TaskGroup.findById(cfg.group);
    if (!group || group.board.toString() !== boardId.toString()) {
      return { error: 'Action group does not belong to board' };
    }
    out.group = cfg.group;
  } else if (actionType === 'CREATE_SUBITEM') {
    // group is inherited from the triggering task at run time, but if the
    // caller sent one we silently drop it rather than failing.
    if (cfg.group) out.group = undefined;
  }

  if (cfg.priority !== undefined && cfg.priority !== null && cfg.priority !== '') {
    if (!VALID_PRIORITIES.includes(cfg.priority)) {
      return { error: 'Invalid action priority' };
    }
    out.priority = cfg.priority;
  } else {
    out.priority = 'medium';
  }

  if (cfg.assignedTo !== undefined) {
    const { ids, error } = await validateAssignees(cfg.assignedTo, org, board);
    if (error) return { error };
    out.assignedTo = ids;
  } else {
    out.assignedTo = [];
  }

  if (cfg.status) {
    if (!mongoose.Types.ObjectId.isValid(cfg.status)) {
      return { error: 'Invalid action status' };
    }
    const known = (board?.statuses || []).some(
      (s) => s._id.toString() === cfg.status.toString()
    );
    if (!known) {
      return { error: 'Action status does not belong to board' };
    }
    out.status = cfg.status;
  }

  if (cfg.note) out.note = String(cfg.note);

  return { config: out };
};

/**
 * Validate + normalise an actions[] array. Returns { actions } or { error }.
 * Empty arrays are rejected — an event-driven automation with nothing to
 * do is not useful.
 */
const sanitizeActions = async (rawActions, board, boardId, org) => {
  if (!Array.isArray(rawActions) || rawActions.length === 0) {
    return { error: 'At least one action is required' };
  }
  const actions = [];
  for (const raw of rawActions) {
    if (!raw || typeof raw !== 'object') {
      return { error: 'Invalid action' };
    }
    if (!VALID_ACTION_TYPES.includes(raw.type)) {
      return { error: `Invalid action type "${raw.type}"` };
    }
    const { config, error } = await sanitizeActionConfig(
      raw.type,
      raw.config,
      board,
      boardId,
      org
    );
    if (error) return { error };
    actions.push({ type: raw.type, config });
  }
  return { actions };
};

const sanitizeSchedule = (raw) => {
  const s = {
    frequency: raw?.frequency,
    hour: Number.isInteger(raw?.hour) ? raw.hour : 9,
    timezone: raw?.timezone || 'UTC',
  };
  if (s.frequency === 'weekly') {
    s.daysOfWeek = Array.isArray(raw?.daysOfWeek)
      ? raw.daysOfWeek
          .map((d) => Number(d))
          .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
      : [];
  }
  if (s.frequency === 'monthly') {
    s.useLastDayOfMonth = raw?.useLastDayOfMonth === true;
    if (s.useLastDayOfMonth) {
      s.dayOfMonth = undefined;
    } else {
      s.dayOfMonth = Number(raw?.dayOfMonth);
    }
  }
  return s;
};

/**
 * Resolve the board's default status id. Returns the legacy enum string
 * 'not_started' as a fallback when the board has no statuses configured
 * (shouldn't happen post-migration).
 */
const resolveDefaultStatusId = (board) => {
  if (!board || !Array.isArray(board.statuses) || board.statuses.length === 0) {
    return 'not_started';
  }
  const def =
    board.statuses.find((s) => s.isDefault) ||
    board.statuses.find((s) => s.key === 'not_started') ||
    board.statuses[0];
  return def ? def._id : 'not_started';
};

/**
 * Send assignee notifications + emails after an automation-created task
 * is saved. Mirrors the side effects a manual create has so users still
 * get pinged for tasks generated by automations.
 */
const notifyAssignees = async (task, boardId, assigneeIds, orgId) => {
  if (!assigneeIds.length) return;

  // An automation can outlive the access that created it: the board may have
  // gone private, or an assignee's grant may have been revoked, long after the
  // automation was saved. Re-check read access at FIRE time, not just save time.
  const readable = await filterUsersWithBoardRead(boardId, assigneeIds);
  const recipients = assigneeIds.filter((id) => readable.has(String(id)));
  if (!recipients.length) return;

  await createNotificationsForUsers({
    userIds: recipients,
    type: 'assigned',
    message: `You were assigned to "${task.name}"`,
    taskId: task._id,
    orgId,
    // Automation has no human actor — the UI falls back to the type icon.
    actorId: null,
    boardId,
  });

  // The manual assignment path (taskController) filters email recipients through
  // notification preferences + DND; this one used to skip that entirely, so a user
  // who had turned assignment emails off still got mailed by automations.
  // Automation has no human actor, so mutedActors never applies here; board mute
  // and the master switch still do.
  const emailAllowed = await filterByEmailPreference(recipients, 'assigned', {
    boardId,
  });
  if (!emailAllowed.size) return;

  const taskLink = buildTaskDeepLink(task, { boardId });
  const assigneeUsers = await User.find({
    _id: { $in: recipients.filter((id) => emailAllowed.has(String(id))) },
  })
    .select('email')
    .lean();
  const emailResults = await Promise.allSettled(
    assigneeUsers
      .filter((u) => u.email)
      .map((u) =>
        sendTaskAssignmentEmail({
          to: u.email,
          taskName: task.name,
          priority: task.priority,
          dueDate: task.dueDate,
          taskLink,
          assignedByName: 'An automation',
        })
      )
  );
  emailResults.forEach((result, i) => {
    if (result.status === 'rejected') {
      console.error(
        `[email] Failed to send to ${assigneeUsers[i]?.email}:`,
        result.reason?.message || result.reason
      );
    }
  });
};

/**
 * Spawn one task from a single action config. `actionType` controls whether
 * the new task is top-level (CREATE_TASK) or a child of `triggeringTask`
 * (CREATE_SUBITEM). Always tagged `createdByAutomation: true` so the
 * ITEM_CREATED dispatcher won't re-trigger on it.
 */
const runActionOnce = async (action, automation, board, triggeringTask) => {
  const cfg = action?.config || {};
  const assigneeIds = (cfg.assignedTo || []).map((u) => u.toString());

  let group;
  let parent = null;

  if (action.type === 'CREATE_SUBITEM') {
    if (!triggeringTask) {
      console.warn(
        '[automation] CREATE_SUBITEM skipped — no triggering task on automation',
        automation?._id?.toString()
      );
      return null;
    }
    group = triggeringTask.group;
    parent = triggeringTask._id;
  } else {
    // CREATE_TASK — config.group is required (validated on save).
    group = cfg.group;
  }

  if (!group) {
    console.warn(
      '[automation] action skipped — missing group on automation',
      automation?._id?.toString()
    );
    return null;
  }

  // Status: prefer config override, fall back to board default. Validate
  // override against the board's status set so a stale id from an old
  // automation doesn't poison the task.
  let status = resolveDefaultStatusId(board);
  if (cfg.status) {
    const cfgStatusId = cfg.status.toString();
    const match = (board?.statuses || []).find(
      (s) => s._id.toString() === cfgStatusId
    );
    if (match) status = match._id;
  }

  const task = await Task.create({
    name: cfg.name,
    board: automation.board,
    group,
    parent,
    priority: cfg.priority || 'medium',
    status,
    assignedTo: assigneeIds,
    note: cfg.note || undefined,
    isPersonal: false,
    createdBy: automation.createdBy,
    createdByAutomation: true,
  });

  await Board.updateOne(
    { _id: automation.board },
    { $set: { updatedAt: new Date() } }
  );

  await notifyAssignees(task, automation.board, assigneeIds, automation.organisation);
  return task;
};

/**
 * Compute the desired ordered array of task ids for a POSITION_ITEM strategy,
 * from a group's current top-level tasks. Index in the returned array maps to
 * the task's new `order` (0..n-1). Stable: ties fall back to the current order.
 *   - top      → the just-created task first, everything else unchanged.
 *   - dueDate  → soonest due first; tasks with no due date sink to the bottom.
 *   - priority → critical → high → medium → low.
 *   - assignee → grouped by first assignee (in first-seen order), unassigned last.
 * `tasks` must already be sorted by current `{ order, createdAt }`.
 */
const computePositionedOrder = (tasks, strategy, triggeringTaskId) => {
  const tid = triggeringTaskId.toString();

  if (strategy === 'top') {
    const moving = tasks.filter((t) => t._id.toString() === tid);
    const rest = tasks.filter((t) => t._id.toString() !== tid);
    return [...moving, ...rest].map((t) => t._id);
  }

  if (strategy === 'assignee') {
    // Bucket by first assignee, preserving the order each assignee first
    // appears; unassigned tasks go last. Stable within each bucket.
    const buckets = new Map();
    const unassigned = [];
    for (const t of tasks) {
      const key =
        Array.isArray(t.assignedTo) && t.assignedTo.length
          ? t.assignedTo[0].toString()
          : null;
      if (key === null) {
        unassigned.push(t);
      } else {
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(t);
      }
    }
    const out = [];
    for (const arr of buckets.values()) out.push(...arr);
    out.push(...unassigned);
    return out.map((t) => t._id);
  }

  // dueDate / priority — stable sort by decorating with the current index.
  const decorated = tasks.map((t, i) => ({ t, i }));
  const compare =
    strategy === 'dueDate'
      ? (a, b) => {
          const da = a.t.dueDate ? new Date(a.t.dueDate).getTime() : Infinity;
          const db = b.t.dueDate ? new Date(b.t.dueDate).getTime() : Infinity;
          return da - db || a.i - b.i;
        }
      : (a, b) => {
          const pa = PRIORITY_RANK[a.t.priority] ?? 99;
          const pb = PRIORITY_RANK[b.t.priority] ?? 99;
          return pa - pb || a.i - b.i;
        };
  decorated.sort(compare);
  return decorated.map((d) => d.t._id);
};

/**
 * Run a POSITION_ITEM action: re-order the triggering task's group per the
 * configured strategy, writing `order` on every row (0..n-1) like
 * `reorderTasks` does. This is an UPDATE, never a create, so it can't re-emit
 * `item.created` and needs no `createdByAutomation` guard. Returns null —
 * there's no spawned task to notify about.
 */
const runPositionActionOnce = async (action, automation, triggeringTask) => {
  if (!triggeringTask) {
    console.warn(
      '[automation] POSITION_ITEM skipped — no triggering task on',
      automation?._id?.toString()
    );
    return null;
  }
  // Subitems aren't order-managed (reorderTasks rejects them too).
  if (triggeringTask.parent) return null;

  const groupId = triggeringTask.group;
  if (!groupId) return null;

  const strategy = action?.config?.strategy;
  if (!POSITION_STRATEGIES.includes(strategy)) {
    console.warn(
      '[automation] POSITION_ITEM skipped — invalid strategy',
      strategy,
      'on',
      automation?._id?.toString()
    );
    return null;
  }

  const tasks = await Task.find({
    group: groupId,
    parent: null,
    isPersonal: { $ne: true },
  })
    .select('_id order dueDate priority assignedTo createdAt')
    .sort({ order: 1, createdAt: 1 })
    .lean();
  if (tasks.length === 0) return null;

  const orderedIds = computePositionedOrder(tasks, strategy, triggeringTask._id);
  const ops = orderedIds.map((id, idx) => ({
    updateOne: {
      filter: { _id: id },
      update: { $set: { order: idx } },
    },
  }));
  if (ops.length > 0) await Task.bulkWrite(ops);

  await Board.updateOne(
    { _id: automation.board },
    { $set: { updatedAt: new Date() } }
  );
  return null;
};

/**
 * Spawn every template in `automation.groupCreatedTaskTemplates` into the
 * triggering group. Each spawned task is tagged `createdByAutomation: true`
 * for parity with other automation flows. Returns the last task created so
 * `runAutomationNow` keeps its single-taskId response shape.
 */
const runGroupCreatedTemplatesOnce = async (automation, board, group) => {
  const templates = Array.isArray(automation.groupCreatedTaskTemplates)
    ? automation.groupCreatedTaskTemplates
    : [];
  if (templates.length === 0) {
    console.warn(
      '[automation] GROUP_CREATED run skipped — no templates on automation',
      automation?._id?.toString()
    );
    return null;
  }

  const initialStatus = resolveDefaultStatusId(board);
  const now = new Date();
  let lastTask = null;

  for (const tpl of templates) {
    const assigneeIds = (tpl.assignedTo || []).map((u) => u.toString());
    const dueDate =
      Number.isFinite(tpl.dueInDays) && tpl.dueInDays !== null
        ? new Date(now.getTime() + tpl.dueInDays * DAY_MS)
        : undefined;

    const task = await Task.create({
      name: tpl.name,
      board: automation.board,
      group: group._id,
      priority: tpl.priority || 'medium',
      status: initialStatus,
      assignedTo: assigneeIds,
      dueDate,
      note: tpl.note || undefined,
      isPersonal: false,
      createdBy: automation.createdBy,
      createdByAutomation: true,
    });

    await Board.updateOne(
      { _id: automation.board },
      { $set: { updatedAt: new Date() } }
    );

    await notifyAssignees(task, automation.board, assigneeIds, automation.organisation);
    lastTask = task;
  }

  return lastTask;
};

/**
 * Run a legacy schedule-driven automation once: spawn a Task using the
 * `taskTemplate` shape and fire the same notification + email side
 * effects a manual create would. Returns the spawned task.
 */
const runLegacyTemplateOnce = async (automation, board) => {
  const tpl = automation.taskTemplate;
  const now = new Date();
  const dueDate =
    Number.isFinite(tpl.dueInDays) && tpl.dueInDays !== null
      ? new Date(now.getTime() + tpl.dueInDays * DAY_MS)
      : undefined;

  const assigneeIds = (tpl.assignedTo || []).map((u) => u.toString());
  const initialStatus = resolveDefaultStatusId(board);

  const task = await Task.create({
    name: tpl.name,
    board: automation.board,
    group: tpl.group,
    priority: tpl.priority || 'medium',
    status: initialStatus,
    assignedTo: assigneeIds,
    dueDate,
    note: tpl.note || undefined,
    isPersonal: false,
    createdBy: automation.createdBy,
    createdByAutomation: true,
  });

  await Board.updateOne(
    { _id: automation.board },
    { $set: { updatedAt: new Date() } }
  );

  await notifyAssignees(task, automation.board, assigneeIds, automation.organisation);
  return task;
};

/**
 * Run an automation once. Dispatches on the automation shape:
 *   - triggerType GROUP_CREATED → run every template in
 *     `groupCreatedTaskTemplates` against `ctx.triggeringGroup`. Skips when
 *     no triggering group is supplied (e.g. "Run now" from the modal).
 *   - `actions[]` non-empty → new event-driven path. Runs every action
 *     in order. For CREATE_SUBITEM actions, `ctx.triggeringTask` must be
 *     supplied (the dispatcher passes it in).
 *   - otherwise → legacy `taskTemplate` path used by SCHEDULE triggers.
 * Returns the last task created so the existing `runAutomationNow`
 * endpoint can keep returning a single `taskId` for backwards compat.
 *
 * There is deliberately NO actor here: the scheduler and the event dispatcher
 * both call this with no human behind them, so execution runs as a system
 * principal and asks no capability question. The authorization that matters at
 * fire time is the assignee fan-out, and `notifyAssignees` re-checks every
 * recipient against board READ access then — because an automation outlives the
 * access that created it.
 */
const runAutomationOnce = async (automation, ctx = {}) => {
  const board = await Board.findById(automation.board).select('statuses');

  if (automation.triggerType === 'GROUP_CREATED') {
    if (!ctx.triggeringGroup) {
      console.warn(
        '[automation] GROUP_CREATED run skipped — no triggering group on',
        automation?._id?.toString()
      );
      return null;
    }
    return runGroupCreatedTemplatesOnce(automation, board, ctx.triggeringGroup);
  }

  const actions = Array.isArray(automation.actions) ? automation.actions : [];
  if (actions.length > 0) {
    let lastTask = null;
    for (const action of actions) {
      // POSITION_ITEM repositions the triggering task's group instead of
      // creating anything, so it runs on its own path and yields no task.
      if (action.type === 'POSITION_ITEM') {
        await runPositionActionOnce(action, automation, ctx.triggeringTask);
        continue;
      }
      const created = await runActionOnce(
        action,
        automation,
        board,
        ctx.triggeringTask
      );
      if (created) lastTask = created;
    }
    return lastTask;
  }

  if (!automation.taskTemplate) {
    console.warn(
      '[automation] nothing to run — automation has no actions[] and no taskTemplate',
      automation?._id?.toString()
    );
    return null;
  }

  return runLegacyTemplateOnce(automation, board);
};

/**
 * GET /api/boards/:boardId/automations
 */
const listAutomations = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { boardId } = req.params;

    const ctx = await loadBoardContext(boardId, userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    const denied = requireCapability(
      ctx,
      'automation.view',
      "You do not have permission to view this board's automations"
    );
    if (denied) return res.status(denied.status).json({ error: denied.error });

    const automations = await populateAutomation(
      Automation.find({ board: boardId })
    ).sort({ createdAt: -1 });

    return res.json({ automations });
  } catch (err) {
    console.error('listAutomations error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/boards/:boardId/automations
 *
 * Two shapes are accepted on this endpoint:
 *   - SCHEDULE: legacy cron-style automation. Requires `schedule` + `taskTemplate`.
 *   - ITEM_CREATED: event-driven automation. Requires `actions[]`; `conditions[]`
 *     filter which item creations fire it.
 */
const createAutomation = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { boardId } = req.params;
    const body = req.body || {};

    const ctx = await loadBoardContext(boardId, userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    const denied = requireCapability(
      ctx,
      'automation.manage',
      'You do not have permission to create automations'
    );
    if (denied) return res.status(denied.status).json({ error: denied.error });

    if (!body.name || !String(body.name).trim()) {
      return res.status(400).json({ error: 'Automation name is required' });
    }

    const triggerType = VALID_TRIGGER_TYPES.includes(body.triggerType)
      ? body.triggerType
      : 'SCHEDULE';

    const doc = {
      name: String(body.name).trim(),
      board: boardId,
      organisation: ctx.board.organisation,
      enabled: body.enabled !== false,
      triggerType,
      createdBy: userId,
    };

    if (triggerType === 'ITEM_CREATED') {
      const cv = await sanitizeConditions(
        body.conditions,
        ctx.board,
        boardId,
        CONDITION_TYPES_BY_TRIGGER.ITEM_CREATED
      );
      if (cv.error) return res.status(400).json({ error: cv.error });
      const av = await sanitizeActions(body.actions, ctx.board, boardId, ctx.org);
      if (av.error) return res.status(400).json({ error: av.error });
      doc.conditions = cv.conditions;
      doc.actions = av.actions;
      doc.nextRunAt = null;
    } else if (triggerType === 'GROUP_CREATED') {
      const cv = await sanitizeConditions(
        body.conditions,
        ctx.board,
        boardId,
        CONDITION_TYPES_BY_TRIGGER.GROUP_CREATED
      );
      if (cv.error) return res.status(400).json({ error: cv.error });
      const tv = await sanitizeGroupCreatedTemplates(
        body.groupCreatedTaskTemplates,
        ctx.org,
        ctx.board
      );
      if (tv.error) return res.status(400).json({ error: tv.error });
      doc.conditions = cv.conditions;
      doc.groupCreatedTaskTemplates = tv.templates;
      doc.nextRunAt = null;
    } else {
      const schedule = sanitizeSchedule(body.schedule);
      const sv = validateSchedule(schedule);
      if (!sv.valid) return res.status(400).json({ error: sv.error });

      const tpl = body.taskTemplate || {};
      if (!tpl.name || !String(tpl.name).trim()) {
        return res.status(400).json({ error: 'Template task name is required' });
      }
      if (!tpl.group || !mongoose.Types.ObjectId.isValid(tpl.group)) {
        return res.status(400).json({ error: 'Template group is required' });
      }
      const group = await TaskGroup.findById(tpl.group);
      if (!group || group.board.toString() !== boardId) {
        return res.status(400).json({ error: 'Group does not belong to board' });
      }
      if (tpl.priority && !VALID_PRIORITIES.includes(tpl.priority)) {
        return res.status(400).json({ error: 'Invalid priority' });
      }
      const { ids: assigneeIds, error: assigneeErr } = await validateAssignees(
        tpl.assignedTo,
        ctx.org,
        ctx.board
      );
      if (assigneeErr) return res.status(400).json({ error: assigneeErr });

      let dueInDays = null;
      if (tpl.dueInDays !== undefined && tpl.dueInDays !== null && tpl.dueInDays !== '') {
        const n = Number(tpl.dueInDays);
        if (!Number.isFinite(n) || n < 0) {
          return res.status(400).json({ error: 'dueInDays must be a non-negative number' });
        }
        dueInDays = n;
      }

      doc.schedule = schedule;
      doc.taskTemplate = {
        name: String(tpl.name).trim(),
        group: tpl.group,
        priority: tpl.priority || 'medium',
        assignedTo: assigneeIds,
        note: tpl.note ? String(tpl.note) : undefined,
        dueInDays,
      };
      doc.nextRunAt = computeNextRunAt(schedule, new Date());
    }

    const automation = await Automation.create(doc);
    const populated = await populateAutomation(Automation.findById(automation._id));
    return res.status(201).json({ automation: populated });
  } catch (err) {
    console.error('createAutomation error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * PUT /api/automations/:id
 */
const updateAutomation = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    const body = req.body || {};

    const automation = await Automation.findById(id);
    if (!automation) return res.status(404).json({ error: 'Automation not found' });

    const ctx = await loadBoardContext(automation.board, userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    // Covers the enabled toggle too — flipping an automation on or off is a
    // change to what the board does on its own, not a read.
    const denied = requireCapability(
      ctx,
      'automation.manage',
      'You do not have permission to edit automations'
    );
    if (denied) return res.status(denied.status).json({ error: denied.error });

    let scheduleChanged = false;
    let enabledChanged = false;
    let triggerTypeChanged = false;

    if (typeof body.name === 'string') {
      if (!body.name.trim()) {
        return res.status(400).json({ error: 'Automation name cannot be empty' });
      }
      automation.name = body.name.trim();
    }

    if (body.enabled !== undefined) {
      const next = !!body.enabled;
      if (next !== automation.enabled) enabledChanged = true;
      automation.enabled = next;
    }

    if (body.triggerType !== undefined) {
      if (!VALID_TRIGGER_TYPES.includes(body.triggerType)) {
        return res.status(400).json({ error: 'Invalid triggerType' });
      }
      if (body.triggerType !== automation.triggerType) triggerTypeChanged = true;
      automation.triggerType = body.triggerType;
    }

    if (body.conditions !== undefined) {
      const allowed =
        CONDITION_TYPES_BY_TRIGGER[automation.triggerType] || VALID_CONDITION_TYPES;
      const cv = await sanitizeConditions(
        body.conditions,
        ctx.board,
        automation.board,
        allowed
      );
      if (cv.error) return res.status(400).json({ error: cv.error });
      automation.conditions = cv.conditions;
    }

    if (body.actions !== undefined) {
      const av = await sanitizeActions(body.actions, ctx.board, automation.board, ctx.org);
      if (av.error) return res.status(400).json({ error: av.error });
      automation.actions = av.actions;
    }

    if (body.groupCreatedTaskTemplates !== undefined) {
      const tv = await sanitizeGroupCreatedTemplates(
        body.groupCreatedTaskTemplates,
        ctx.org,
        ctx.board
      );
      if (tv.error) return res.status(400).json({ error: tv.error });
      automation.groupCreatedTaskTemplates = tv.templates;
    }

    if (body.schedule !== undefined) {
      const schedule = sanitizeSchedule(body.schedule);
      const sv = validateSchedule(schedule);
      if (!sv.valid) return res.status(400).json({ error: sv.error });
      automation.schedule = schedule;
      scheduleChanged = true;
    }

    if (body.taskTemplate !== undefined) {
      const tpl = body.taskTemplate || {};
      if (!tpl.name || !String(tpl.name).trim()) {
        return res.status(400).json({ error: 'Template task name is required' });
      }
      if (!tpl.group || !mongoose.Types.ObjectId.isValid(tpl.group)) {
        return res.status(400).json({ error: 'Template group is required' });
      }
      const group = await TaskGroup.findById(tpl.group);
      if (!group || group.board.toString() !== automation.board.toString()) {
        return res.status(400).json({ error: 'Group does not belong to board' });
      }
      if (tpl.priority && !VALID_PRIORITIES.includes(tpl.priority)) {
        return res.status(400).json({ error: 'Invalid priority' });
      }
      const { ids: assigneeIds, error: assigneeErr } = await validateAssignees(
        tpl.assignedTo,
        ctx.org,
        ctx.board
      );
      if (assigneeErr) return res.status(400).json({ error: assigneeErr });

      let dueInDays = null;
      if (tpl.dueInDays !== undefined && tpl.dueInDays !== null && tpl.dueInDays !== '') {
        const n = Number(tpl.dueInDays);
        if (!Number.isFinite(n) || n < 0) {
          return res.status(400).json({ error: 'dueInDays must be a non-negative number' });
        }
        dueInDays = n;
      }

      automation.taskTemplate = {
        name: String(tpl.name).trim(),
        group: tpl.group,
        priority: tpl.priority || 'medium',
        assignedTo: assigneeIds,
        note: tpl.note ? String(tpl.note) : undefined,
        dueInDays,
      };
    }

    // Recompute nextRunAt only when relevant. Event-driven automations
    // (ITEM_CREATED, GROUP_CREATED) don't use it — clear to null so the
    // cron runner doesn't pick them up.
    if (triggerTypeChanged || scheduleChanged || enabledChanged) {
      if (
        automation.triggerType === 'ITEM_CREATED' ||
        automation.triggerType === 'GROUP_CREATED'
      ) {
        automation.nextRunAt = null;
      } else if (!automation.enabled) {
        automation.nextRunAt = null;
      } else if (automation.schedule) {
        automation.nextRunAt = computeNextRunAt(automation.schedule, new Date());
      }
    }

    await automation.save();
    const populated = await populateAutomation(Automation.findById(automation._id));
    return res.json({ automation: populated });
  } catch (err) {
    console.error('updateAutomation error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * DELETE /api/automations/:id
 */
const deleteAutomation = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;

    const automation = await Automation.findById(id);
    if (!automation) return res.status(404).json({ error: 'Automation not found' });

    const ctx = await loadBoardContext(automation.board, userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    const denied = requireCapability(
      ctx,
      'automation.manage',
      'You do not have permission to delete automations'
    );
    if (denied) return res.status(denied.status).json({ error: denied.error });

    await Automation.deleteOne({ _id: id });
    return res.json({ success: true });
  } catch (err) {
    console.error('deleteAutomation error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/automations/:id/run-now
 */
const runAutomationNow = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;

    const automation = await Automation.findById(id);
    if (!automation) return res.status(404).json({ error: 'Automation not found' });

    const ctx = await loadBoardContext(automation.board, userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    // Firing an automation writes tasks and notifies people, so it is gated as a
    // mutation — `automation.view` alone is not enough to pull the trigger.
    const denied = requireCapability(
      ctx,
      'automation.manage',
      'You do not have permission to run automations'
    );
    if (denied) return res.status(denied.status).json({ error: denied.error });

    // "Run now" on ITEM_CREATED automations runs every action without a
    // triggering task. CREATE_SUBITEM actions silently skip in that mode
    // (no parent to attach to); CREATE_TASK actions still fire.
    const task = await runAutomationOnce(automation);
    automation.lastRunAt = new Date();
    await automation.save();

    const populated = await populateAutomation(Automation.findById(automation._id));
    return res.json({ automation: populated, taskId: task?._id || null });
  } catch (err) {
    console.error('runAutomationNow error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

module.exports = {
  listAutomations,
  createAutomation,
  updateAutomation,
  deleteAutomation,
  runAutomationNow,
  runAutomationOnce,
  // Used by the dispatcher's synchronous positioning path (createTask response).
  runPositionActionOnce,
  // Exported for unit testing the POSITION_ITEM sort + validation logic.
  computePositionedOrder,
  sanitizeActionConfig,
};
