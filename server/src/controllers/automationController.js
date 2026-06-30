const mongoose = require('mongoose');
const Board = require('../models/Board');
const Task = require('../models/Task');
const TaskGroup = require('../models/TaskGroup');
const Organisation = require('../models/Organisation');
const User = require('../models/User');
const Automation = require('../models/Automation');
const {
  createNotificationsForUsers,
} = require('../services/notificationService');
const { sendTaskAssignmentEmail } = require('../services/emailService');
const {
  computeNextRunAt,
  validateSchedule,
} = require('../services/automationSchedule');

const VALID_PRIORITIES = ['critical', 'high', 'medium', 'low'];
const DAY_MS = 24 * 60 * 60 * 1000;

const isOrgAdmin = (org, userId) =>
  !!org &&
  (
    (org.admin && org.admin.toString() === userId) ||
    (Array.isArray(org.admins) && org.admins.some((a) => a.toString() === userId))
  );

const loadBoardContext = async (boardId, userId) => {
  const board = await Board.findById(boardId);
  if (!board) return { status: 404, error: 'Board not found' };

  const org = await Organisation.findById(board.organisation);
  if (!org) return { status: 404, error: 'Organisation not found' };

  const isMember = org.members.some((m) => m.toString() === userId);
  if (!isMember) {
    return { status: 403, error: 'Not a member of this organisation' };
  }

  return { board, org, isAdmin: isOrgAdmin(org, userId) };
};

const validateAssignees = (assignedTo, org) => {
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
const VALID_ACTION_TYPES = ['CREATE_TASK', 'CREATE_SUBITEM'];

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
const sanitizeGroupCreatedTemplates = (rawTemplates, org) => {
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
      const { ids, error } = validateAssignees(raw.assignedTo, org);
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
    const { ids, error } = validateAssignees(cfg.assignedTo, org);
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
  await createNotificationsForUsers({
    userIds: assigneeIds,
    type: 'assigned',
    message: `You were assigned to "${task.name}"`,
    taskId: task._id,
    orgId,
    // Automation has no human actor — the UI falls back to the type icon.
    actorId: null,
    boardId,
  });

  const taskLink = `${process.env.CLIENT_URL}/boards/${boardId}`;
  const assigneeUsers = await User.find({ _id: { $in: assigneeIds } })
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
    if (!ctx.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

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
    if (!ctx.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

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
      const tv = sanitizeGroupCreatedTemplates(
        body.groupCreatedTaskTemplates,
        ctx.org
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
      const { ids: assigneeIds, error: assigneeErr } = validateAssignees(
        tpl.assignedTo,
        ctx.org
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
    if (!ctx.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

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
      const tv = sanitizeGroupCreatedTemplates(
        body.groupCreatedTaskTemplates,
        ctx.org
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
      const { ids: assigneeIds, error: assigneeErr } = validateAssignees(
        tpl.assignedTo,
        ctx.org
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
    if (!ctx.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

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
    if (!ctx.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

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
};
