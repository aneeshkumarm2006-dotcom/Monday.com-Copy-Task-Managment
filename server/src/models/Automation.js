const mongoose = require('mongoose');

const scheduleSchema = new mongoose.Schema(
  {
    frequency: {
      type: String,
      enum: ['daily', 'weekly', 'monthly'],
      required: true,
    },
    daysOfWeek: [
      {
        type: Number,
        min: 0,
        max: 6,
      },
    ],
    dayOfMonth: {
      type: Number,
      min: 1,
      max: 31,
    },
    useLastDayOfMonth: {
      type: Boolean,
      default: false,
    },
    hour: {
      type: Number,
      min: 0,
      max: 23,
      default: 9,
    },
    timezone: {
      type: String,
      default: 'UTC',
    },
  },
  { _id: false }
);

const taskTemplateSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    group: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaskGroup',
      required: true,
    },
    priority: {
      type: String,
      enum: ['critical', 'high', 'medium', 'low'],
      default: 'medium',
    },
    assignedTo: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
    note: {
      type: String,
    },
    dueInDays: {
      type: Number,
      default: null,
    },
  },
  { _id: false }
);

/**
 * Task template for GROUP_CREATED automations. Mirrors taskTemplateSchema but
 * drops the `group` requirement — the spawned task always lands in the
 * newly-created triggering group, so the group is supplied at run time, not
 * at config time.
 */
const groupCreatedTaskTemplateSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    priority: {
      type: String,
      enum: ['critical', 'high', 'medium', 'low'],
      default: 'medium',
    },
    assignedTo: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
    note: {
      type: String,
    },
    dueInDays: {
      type: Number,
      default: null,
    },
  },
  { _id: false }
);

/**
 * Condition row evaluated against the trigger payload. `value` is stored as
 * Mixed because the per-type semantics differ:
 *   - ITEM_IN_GROUP      → ObjectId matching task.group        (TaskGroup._id)
 *   - ITEM_IN_STATUS     → ObjectId matching task.status       (Board.statuses._id)
 *   - GROUP_NAME_MATCHES → string regex tested against the new group's name
 */
const conditionSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ['ITEM_IN_GROUP', 'ITEM_IN_STATUS', 'GROUP_NAME_MATCHES'],
      required: true,
    },
    value: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
  },
  { _id: false }
);

/**
 * Per-action config, shared across every action type:
 *   - CREATE_TASK    → `name` required, `group` required (the new task's home).
 *   - CREATE_SUBITEM → `name` required, `group` ignored (inherits the parent's).
 *   - POSITION_ITEM  → `strategy` required; repositions the triggering task's
 *     group at run time instead of creating anything (`name`/`group` unused).
 * `name` is optional at the schema level because POSITION_ITEM carries none;
 * it's enforced per-type in the controller's `sanitizeActionConfig`.
 */
const actionConfigSchema = new mongoose.Schema(
  {
    name: { type: String },
    group: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaskGroup',
    },
    priority: {
      type: String,
      enum: ['critical', 'high', 'medium', 'low'],
      default: 'medium',
    },
    assignedTo: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
    status: {
      type: mongoose.Schema.Types.ObjectId,
    },
    note: { type: String },
    // POSITION_ITEM only: how to (re)order the triggering task's group when a
    // task is created. `top` floats the new task first; the rest re-sort the
    // whole group by that field.
    strategy: {
      type: String,
      enum: ['top', 'dueDate', 'priority', 'assignee'],
    },
  },
  { _id: false }
);

const actionSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ['CREATE_TASK', 'CREATE_SUBITEM', 'POSITION_ITEM'],
      required: true,
    },
    config: { type: actionConfigSchema, required: true },
  },
  { _id: false }
);

const automationSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    board: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Board',
      required: true,
      index: true,
    },
    organisation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organisation',
      required: true,
      index: true,
    },
    enabled: {
      type: Boolean,
      default: true,
    },
    // What fires this automation. SCHEDULE is the legacy cron-style trigger;
    // ITEM_CREATED runs in response to a task being created on the board;
    // GROUP_CREATED runs in response to a new group being created on the board.
    triggerType: {
      type: String,
      enum: ['SCHEDULE', 'ITEM_CREATED', 'GROUP_CREATED'],
      default: 'SCHEDULE',
      index: true,
    },
    // Legacy schedule/template: required only for SCHEDULE triggers, kept
    // optional in the schema so ITEM_CREATED automations can save without
    // them.
    schedule: {
      type: scheduleSchema,
    },
    taskTemplate: {
      type: taskTemplateSchema,
    },
    // New event-driven shape: only used when actions[] is non-empty. If set,
    // runAutomationOnce runs every action in order and ignores taskTemplate.
    conditions: {
      type: [conditionSchema],
      default: [],
    },
    actions: {
      type: [actionSchema],
      default: [],
    },
    // Task templates spawned when a GROUP_CREATED trigger fires. Each
    // template seeds a top-level task in the newly-created group.
    groupCreatedTaskTemplates: {
      type: [groupCreatedTaskTemplateSchema],
      default: [],
    },
    lastRunAt: {
      type: Date,
      default: null,
    },
    nextRunAt: {
      type: Date,
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Automation', automationSchema);
