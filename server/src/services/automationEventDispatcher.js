const Automation = require('../models/Automation');
const Task = require('../models/Task');
const TaskGroup = require('../models/TaskGroup');
const Board = require('../models/Board');
const eventBus = require('./eventBus');
const {
  runAutomationOnce,
  runPositionActionOnce,
} = require('../controllers/automationController');

let mounted = false;

/**
 * Read a task's current status id, accounting for the flexible-columns
 * engine (F1). When `board.useFlexibleColumns === true`, walk the board's
 * `columns` to find the `status`-typed column (preferring `key === 'status'`)
 * and return the value from `task.columnValues[colId]`. Otherwise fall back
 * to the legacy `task.status` field.
 *
 * Returns a string (or null). Used by ITEM_IN_STATUS condition evaluation
 * downstream of the create payload so re-evaluating against a refetched task
 * picks up the right value regardless of which storage owns it.
 */
const readCurrentStatusId = (task, board) => {
  if (board && board.useFlexibleColumns && Array.isArray(board.columns) && board.columns.length > 0) {
    const statusCol =
      board.columns.find((c) => c.key === 'status' && c.type === 'status') ||
      board.columns.find((c) => c.type === 'status');
    if (statusCol && task && task.columnValues) {
      const raw =
        typeof task.columnValues.get === 'function'
          ? task.columnValues.get(statusCol._id.toString())
          : task.columnValues[statusCol._id.toString()];
      if (raw != null) return raw.toString();
    }
  }
  return task && task.status ? task.status.toString() : null;
};

/**
 * True if every condition on the automation matches the triggering task.
 * An empty `conditions` array is treated as "match everything" — the
 * automation fires on every item creation for its board.
 */
const evaluateConditions = (automation, payload) => {
  const conds = Array.isArray(automation.conditions) ? automation.conditions : [];
  if (conds.length === 0) return true;
  for (const c of conds) {
    if (!c?.type || !c?.value) return false;
    const target = c.value.toString();
    if (c.type === 'ITEM_IN_GROUP') {
      if (!payload.groupId || payload.groupId.toString() !== target) return false;
    } else if (c.type === 'ITEM_IN_STATUS') {
      if (!payload.statusId || payload.statusId.toString() !== target) return false;
    } else {
      // Unknown condition types are treated as failing matches so we
      // don't accidentally run automations the user can't see.
      return false;
    }
  }
  return true;
};

/**
 * True if every condition on a GROUP_CREATED automation matches the new
 * group. Conditions for this trigger only support GROUP_NAME_MATCHES today
 * (value is a regex string). An empty conditions array matches every group.
 */
const evaluateGroupCreatedConditions = (automation, payload) => {
  const conds = Array.isArray(automation.conditions) ? automation.conditions : [];
  if (conds.length === 0) return true;
  const name = payload.groupName == null ? '' : String(payload.groupName);
  for (const c of conds) {
    if (!c?.type || c.value == null) return false;
    if (c.type === 'GROUP_NAME_MATCHES') {
      let re;
      try {
        re = new RegExp(String(c.value));
      } catch (err) {
        console.error(
          '[automation/dispatcher] invalid GROUP_NAME_MATCHES regex',
          c.value,
          err.message
        );
        return false;
      }
      if (!re.test(name)) return false;
    } else {
      // Unknown condition types — treat as failing matches so the
      // automation can't fire on payloads it wasn't designed for.
      return false;
    }
  }
  return true;
};

const handleGroupCreated = async (payload) => {
  if (!payload || !payload.groupId || !payload.boardId) return;

  let triggeringGroup;
  try {
    triggeringGroup = await TaskGroup.findById(payload.groupId);
  } catch (err) {
    console.error('[automation/dispatcher] failed to load triggering group:', err);
    return;
  }
  if (!triggeringGroup) return;

  let automations;
  try {
    automations = await Automation.find({
      board: payload.boardId,
      enabled: true,
      triggerType: 'GROUP_CREATED',
    });
  } catch (err) {
    console.error('[automation/dispatcher] failed to query automations:', err);
    return;
  }

  for (const automation of automations) {
    if (!evaluateGroupCreatedConditions(automation, payload)) continue;
    try {
      await runAutomationOnce(automation, { triggeringGroup });
      automation.lastRunAt = new Date();
      await automation.save();
    } catch (err) {
      console.error(
        '[automation/dispatcher] failed to run automation',
        automation?._id?.toString(),
        err
      );
    }
  }
};

const handleItemCreated = async (payload) => {
  if (!payload || !payload.taskId || !payload.boardId) return;

  // Fetch the triggering task so action handlers (CREATE_SUBITEM) have the
  // full doc. Skip automation-created tasks outright — the flag is the
  // primary defence against infinite trigger loops.
  let triggeringTask;
  try {
    triggeringTask = await Task.findById(payload.taskId);
  } catch (err) {
    console.error('[automation/dispatcher] failed to load triggering task:', err);
    return;
  }
  if (!triggeringTask) return;
  if (triggeringTask.createdByAutomation) return;
  if (triggeringTask.parent) return; // subitems never trigger

  // F1 shim: on flexible-columns boards the create payload's `statusId`
  // can be stale relative to columnValues. Refresh from the board's
  // status column so ITEM_IN_STATUS conditions evaluate consistently.
  let board = null;
  try {
    board = await Board.findById(payload.boardId).select('useFlexibleColumns columns').lean();
  } catch (err) {
    console.error('[automation/dispatcher] failed to load board for shim:', err);
  }
  if (board && board.useFlexibleColumns) {
    const refreshedStatusId = readCurrentStatusId(triggeringTask, board);
    if (refreshedStatusId) {
      payload = { ...payload, statusId: refreshedStatusId };
    }
  }

  let automations;
  try {
    automations = await Automation.find({
      board: payload.boardId,
      enabled: true,
      triggerType: 'ITEM_CREATED',
    });
  } catch (err) {
    console.error('[automation/dispatcher] failed to query automations:', err);
    return;
  }

  let ranAny = false;
  for (const automation of automations) {
    if (!evaluateConditions(automation, payload)) continue;
    try {
      await runAutomationOnce(automation, { triggeringTask });
      automation.lastRunAt = new Date();
      await automation.save();
      ranAny = true;
    } catch (err) {
      console.error(
        '[automation/dispatcher] failed to run automation',
        automation?._id?.toString(),
        err
      );
    }
  }

  // Automations run a beat AFTER the create response has already returned, so
  // the creator's board view can't know a task was moved/created out-of-band.
  // Ping their live stream to refetch. Scoped to the creator (the SSE registry
  // is keyed by user); other viewers still reconcile on their next load.
  if (ranAny && payload.createdByUserId) {
    eventBus.emit('board.changed', {
      userId: payload.createdByUserId,
      boardId: payload.boardId,
    });
  }
};

/**
 * Synchronously apply any matching POSITION_ITEM automations for a freshly
 * created task, so the create RESPONSE can return the task already in its final
 * spot (no bottom-then-top hop on the client). Positioning is idempotent —
 * re-sorting an already-ordered group is a no-op — so it's safe that the async
 * `item.created` path runs it again a beat later.
 *
 * Returns the target groupId (so the caller can re-read that group) when a
 * reposition ran, else null. Cheap-gates on the automation query first so
 * boards without positioning automations pay only one indexed lookup.
 */
const applyItemCreatedPositioning = async (payload) => {
  if (!payload || !payload.taskId || !payload.boardId) return null;

  let automations;
  try {
    automations = await Automation.find({
      board: payload.boardId,
      enabled: true,
      triggerType: 'ITEM_CREATED',
    });
  } catch (err) {
    console.error('[automation/dispatcher] sync positioning query failed:', err);
    return null;
  }
  const positioners = automations.filter((a) =>
    (Array.isArray(a.actions) ? a.actions : []).some(
      (act) => act.type === 'POSITION_ITEM'
    )
  );
  if (positioners.length === 0) return null;

  let triggeringTask;
  try {
    triggeringTask = await Task.findById(payload.taskId);
  } catch (err) {
    return null;
  }
  if (!triggeringTask || triggeringTask.createdByAutomation || triggeringTask.parent) {
    return null;
  }

  // Same flexible-columns status shim as handleItemCreated, so ITEM_IN_STATUS
  // conditions evaluate consistently.
  let board = null;
  try {
    board = await Board.findById(payload.boardId)
      .select('useFlexibleColumns columns')
      .lean();
  } catch (err) {
    // fall through with the legacy status on the payload
  }
  let evalPayload = payload;
  if (board && board.useFlexibleColumns) {
    const refreshedStatusId = readCurrentStatusId(triggeringTask, board);
    if (refreshedStatusId) evalPayload = { ...payload, statusId: refreshedStatusId };
  }

  let ran = false;
  for (const automation of positioners) {
    if (!evaluateConditions(automation, evalPayload)) continue;
    for (const action of automation.actions) {
      if (action.type !== 'POSITION_ITEM') continue;
      try {
        await runPositionActionOnce(action, automation, triggeringTask);
        ran = true;
      } catch (err) {
        console.error(
          '[automation/dispatcher] sync positioning failed',
          automation?._id?.toString(),
          err
        );
      }
    }
  }
  return ran ? triggeringTask.group : null;
};

/**
 * Subscribe the dispatcher to the event bus. Idempotent — safe to call
 * multiple times across hot-reloads.
 */
const mountAutomationEventDispatcher = () => {
  if (mounted) return;
  mounted = true;
  eventBus.on('item.created', (payload) => {
    handleItemCreated(payload).catch((err) =>
      console.error('[automation/dispatcher] unhandled error:', err)
    );
  });
  eventBus.on('group.created', (payload) => {
    handleGroupCreated(payload).catch((err) =>
      console.error('[automation/dispatcher] unhandled error:', err)
    );
  });
  console.log('automation event dispatcher mounted');
};

module.exports = {
  mountAutomationEventDispatcher,
  applyItemCreatedPositioning,
  evaluateConditions,
  evaluateGroupCreatedConditions,
  readCurrentStatusId,
};
