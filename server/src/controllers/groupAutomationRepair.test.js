const { test } = require('node:test');
const assert = require('node:assert');

const { planAutomationRepair } = require('./groupController');

/**
 * What a group delete does to the board's automation rules.
 *
 * An Automation names a TaskGroup in three places — `taskTemplate.group`, a
 * CREATE_TASK action's `config.group`, and the `value` of an ITEM_IN_GROUP
 * condition — and the three fail in two opposite directions when the group
 * goes away. A SPAWNER keeps running and manufactures ghost tasks into an id
 * that resolves to nothing; a SCOPED rule can never match again and sits in
 * the list still reading Enabled. `planAutomationRepair` is the split, and
 * these tests pin it, because every wrong version of it is a plausible-looking
 * one-liner that either disables healthy rules or leaves harmful ones running.
 *
 * Pure: ids only need `.toString()`, so plain strings stand in for ObjectIds.
 */

const DEAD = 'group-dead';
const LIVE = 'group-live';

/** Shorthand for the shape `Automation.find().lean()` hands the planner. */
const rule = (over = {}) => ({ _id: 'a1', triggerType: 'SCHEDULE', ...over });

const createTask = (group) => ({ type: 'CREATE_TASK', config: { name: 'x', group } });

// ---------------------------------------------------------------------------
// Spawners — rules that PUT work into the dead group
// ---------------------------------------------------------------------------

test('a CREATE_TASK action aimed at the dead group is a spawner', () => {
  const plan = planAutomationRepair(
    [rule({ triggerType: 'ITEM_CREATED', actions: [createTask(DEAD)] })],
    DEAD
  );
  assert.deepStrictEqual(plan.spawnerIds, ['a1']);
  assert.deepStrictEqual(plan.scopedIds, []);
});

test('one dead CREATE_TASK among live ones still condemns the rule', () => {
  const plan = planAutomationRepair(
    [
      rule({
        triggerType: 'ITEM_CREATED',
        actions: [createTask(LIVE), createTask(DEAD)],
      }),
    ],
    DEAD
  );
  assert.deepStrictEqual(plan.spawnerIds, ['a1']);
});

test('a legacy taskTemplate aimed at the dead group is a spawner', () => {
  const plan = planAutomationRepair(
    [rule({ actions: [], taskTemplate: { name: 'Weekly report', group: DEAD } })],
    DEAD
  );
  assert.deepStrictEqual(plan.spawnerIds, ['a1']);
});

test('a missing actions array is treated as no actions, so the template runs', () => {
  // Mongoose defaults `actions` to [], but a lean doc from an older row can
  // simply not carry the field. The template is still what runs.
  const plan = planAutomationRepair(
    [rule({ taskTemplate: { name: 'Weekly report', group: DEAD } })],
    DEAD
  );
  assert.deepStrictEqual(plan.spawnerIds, ['a1']);
});

test('a VESTIGIAL taskTemplate on a rule with actions is left alone', () => {
  // `runAutomationOnce` runs `actions` when there are any and only otherwise
  // falls back to the template. A rule flipped SCHEDULE -> ITEM_CREATED keeps a
  // taskTemplate nothing reads; disabling it would switch off a working rule.
  const plan = planAutomationRepair(
    [
      rule({
        triggerType: 'ITEM_CREATED',
        actions: [createTask(LIVE)],
        taskTemplate: { name: 'Old', group: DEAD },
      }),
    ],
    DEAD
  );
  assert.deepStrictEqual(plan.spawnerIds, []);
  assert.deepStrictEqual(plan.scopedIds, []);
});

test('ObjectId-ish refs are compared by string, not by identity', () => {
  const asObjectId = { toString: () => DEAD };
  const plan = planAutomationRepair(
    [rule({ actions: [], taskTemplate: { group: asObjectId } })],
    { toString: () => DEAD }
  );
  assert.deepStrictEqual(plan.spawnerIds, ['a1']);
});

// ---------------------------------------------------------------------------
// Scoped rules — rules the dead group only GATED
// ---------------------------------------------------------------------------

test('an ITEM_IN_GROUP condition on the dead group scopes, it does not spawn', () => {
  const plan = planAutomationRepair(
    [
      rule({
        triggerType: 'ITEM_CREATED',
        actions: [createTask(LIVE)],
        conditions: [{ type: 'ITEM_IN_GROUP', value: DEAD }],
      }),
    ],
    DEAD
  );
  assert.deepStrictEqual(plan.spawnerIds, []);
  assert.deepStrictEqual(plan.scopedIds, ['a1']);
});

test('a rule that both spawns into and is gated on the dead group counts once, as a spawner', () => {
  // The two lists must stay disjoint: the caller clears `nextRunAt` on
  // spawners only, and a rule appearing in both would get contradictory writes.
  const plan = planAutomationRepair(
    [
      rule({
        triggerType: 'ITEM_CREATED',
        actions: [createTask(DEAD)],
        conditions: [{ type: 'ITEM_IN_GROUP', value: DEAD }],
      }),
    ],
    DEAD
  );
  assert.deepStrictEqual(plan.spawnerIds, ['a1']);
  assert.deepStrictEqual(plan.scopedIds, []);
});

test('a SCHEDULE rule with a leftover ITEM_IN_GROUP condition is healthy', () => {
  // The cron runner never calls evaluateConditions, so this condition is read
  // by nothing at all. Disabling over it would kill a working scheduled rule.
  const plan = planAutomationRepair(
    [
      rule({
        actions: [],
        taskTemplate: { name: 'Weekly report', group: LIVE },
        conditions: [{ type: 'ITEM_IN_GROUP', value: DEAD }],
      }),
    ],
    DEAD
  );
  assert.deepStrictEqual(plan.spawnerIds, []);
  assert.deepStrictEqual(plan.scopedIds, []);
});

test('an ITEM_IN_STATUS condition is never a group reference', () => {
  const plan = planAutomationRepair(
    [
      rule({
        triggerType: 'ITEM_CREATED',
        actions: [createTask(LIVE)],
        conditions: [{ type: 'ITEM_IN_STATUS', value: DEAD }],
      }),
    ],
    DEAD
  );
  assert.deepStrictEqual(plan.scopedIds, []);
});

// ---------------------------------------------------------------------------
// Rules that must survive untouched
// ---------------------------------------------------------------------------

test('GROUP_CREATED rules are never touched, however empty they look', () => {
  // These are born with `actions: []` and no taskTemplate, so a predicate keyed
  // on an empty actions array would match every one of them on the board and
  // deleting any group would disable the lot.
  const plan = planAutomationRepair(
    [
      rule({
        triggerType: 'GROUP_CREATED',
        actions: [],
        groupCreatedTaskTemplates: [{ name: 'Kickoff' }],
      }),
    ],
    DEAD
  );
  assert.deepStrictEqual(plan.spawnerIds, []);
  assert.deepStrictEqual(plan.scopedIds, []);
});

test('a GROUP_CREATED rule carrying a stale taskTemplate is still skipped', () => {
  const plan = planAutomationRepair(
    [
      rule({
        triggerType: 'GROUP_CREATED',
        actions: [],
        taskTemplate: { name: 'Old', group: DEAD },
      }),
    ],
    DEAD
  );
  assert.deepStrictEqual(plan.spawnerIds, []);
});

test('a POST_TO_CHANNEL action naming the dead group is already safe', () => {
  // services/chatSystemPost.js returns null and posts nowhere when the group is
  // gone, so this rule still does its other work correctly.
  const plan = planAutomationRepair(
    [
      rule({
        triggerType: 'ITEM_CREATED',
        actions: [{ type: 'POST_TO_CHANNEL', config: { group: DEAD, message: 'hi' } }],
      }),
    ],
    DEAD
  );
  assert.deepStrictEqual(plan.spawnerIds, []);
  assert.deepStrictEqual(plan.scopedIds, []);
});

test('a CREATE_SUBITEM ignores config.group, so it is not a spawner', () => {
  // The subitem inherits the triggering task's group; `config.group` is unused.
  const plan = planAutomationRepair(
    [
      rule({
        triggerType: 'ITEM_CREATED',
        actions: [{ type: 'CREATE_SUBITEM', config: { name: 'QA', group: DEAD } }],
      }),
    ],
    DEAD
  );
  assert.deepStrictEqual(plan.spawnerIds, []);
});

test('a POSITION_ITEM action is not a spawner', () => {
  const plan = planAutomationRepair(
    [
      rule({
        triggerType: 'ITEM_CREATED',
        actions: [{ type: 'POSITION_ITEM', config: { strategy: 'top', group: DEAD } }],
      }),
    ],
    DEAD
  );
  assert.deepStrictEqual(plan.spawnerIds, []);
});

test('rules that never mention the group are untouched', () => {
  const plan = planAutomationRepair(
    [
      rule({ _id: 'a1', actions: [], taskTemplate: { group: LIVE } }),
      rule({ _id: 'a2', triggerType: 'ITEM_CREATED', actions: [createTask(LIVE)] }),
    ],
    DEAD
  );
  assert.deepStrictEqual(plan.spawnerIds, []);
  assert.deepStrictEqual(plan.scopedIds, []);
});

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

test('an empty or absent list plans nothing rather than throwing', () => {
  assert.deepStrictEqual(planAutomationRepair([], DEAD), {
    spawnerIds: [],
    scopedIds: [],
  });
  assert.deepStrictEqual(planAutomationRepair(undefined, DEAD), {
    spawnerIds: [],
    scopedIds: [],
  });
});

test('a mixed board sorts every rule into the right bucket', () => {
  const plan = planAutomationRepair(
    [
      rule({ _id: 'spawn-template', actions: [], taskTemplate: { group: DEAD } }),
      rule({
        _id: 'spawn-action',
        triggerType: 'ITEM_CREATED',
        actions: [createTask(DEAD)],
      }),
      rule({
        _id: 'scoped',
        triggerType: 'ITEM_CREATED',
        actions: [createTask(LIVE)],
        conditions: [{ type: 'ITEM_IN_GROUP', value: DEAD }],
      }),
      rule({ _id: 'healthy', actions: [], taskTemplate: { group: LIVE } }),
      rule({ _id: 'group-created', triggerType: 'GROUP_CREATED', actions: [] }),
    ],
    DEAD
  );
  assert.deepStrictEqual(plan.spawnerIds, ['spawn-template', 'spawn-action']);
  assert.deepStrictEqual(plan.scopedIds, ['scoped']);
});
