const test = require('node:test');
const assert = require('node:assert');

/**
 * The grant write, after it was lifted out of `boardController.setBoardAccess`.
 *
 * This file exists for one reason above the others: to prove the REVOKE CLEANUP
 * survived the extraction. Losing it is a silent failure — `memberAccess` still
 * loses the entry, the board still disappears from the person's list, every
 * visible symptom of a working revoke is still there — and the only evidence
 * that anything is wrong arrives weeks later as "why am I still being notified
 * about tasks I cannot open?". Nothing else in the suite would catch that, so it
 * is pinned here with one assertion per deletion.
 *
 * `createNotification` is stubbed BEFORE boardGrants is required, because the
 * module destructures it at load time and would otherwise hold a reference to
 * the real one. The three model statics are stubbed per test on the Model
 * objects themselves, which works because the service reaches them through the
 * module binding at call time (the pattern in controllers/connectorData.test.js
 * and controllers/boardFileUpload.test.js). Nothing here touches a database —
 * there is no connection to touch.
 */

const notificationService = require('./notificationService');

const notifications = [];
notificationService.createNotification = async (args) => {
  notifications.push(args);
  return args;
};

// Required AFTER the stub is in place.
const { grant, revoke } = require('./boardGrants');

const Task = require('../models/Task');
const ItemFollow = require('../models/ItemFollow');
const Notification = require('../models/Notification');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BOARD = '6a466b99ea3ab35ff1378e20';
const ORG = '6a466b99ea3ab35ff1378e10';
const OWNER = '6a466b99ea3ab35ff1378e01';
const TARGET = '6a466b99ea3ab35ff1378e02';
const BYSTANDER = '6a466b99ea3ab35ff1378e03';
const TASKS = ['6a466b99ea3ab35ff1378f01', '6a466b99ea3ab35ff1378f02'];

/**
 * A board that behaves like the Mongoose document the controller hands over:
 * `memberAccess` is a plain array the service rewrites, and `save()` is the
 * thing that has to have happened before any cleanup runs.
 */
const makeBoard = (memberAccess = []) => ({
  _id: BOARD,
  name: 'SEO Tracker 2026',
  organisation: ORG,
  createdBy: OWNER,
  memberAccess,
  saves: 0,
  async save() {
    this.saves += 1;
  },
});

const entryFor = (board, userId) =>
  board.memberAccess.find((e) => String(e.user?._id || e.user) === String(userId));

/**
 * Stub the three collections the revoke path reaches into, recording every call
 * so a MISSING one is as visible as a wrong one. Returns the call log and the
 * restore function.
 */
const stubModels = ({ taskIds = TASKS } = {}) => {
  const originals = {
    distinct: Task.distinct,
    followDelete: ItemFollow.deleteMany,
    notifDelete: Notification.deleteMany,
  };
  const calls = { distinct: [], itemFollowDeletes: [], notificationDeletes: [] };

  Task.distinct = async (field, filter) => {
    calls.distinct.push({ field, filter });
    return taskIds;
  };
  ItemFollow.deleteMany = async (filter) => {
    calls.itemFollowDeletes.push(filter);
    return { deletedCount: 0 };
  };
  Notification.deleteMany = async (filter) => {
    calls.notificationDeletes.push(filter);
    return { deletedCount: 0 };
  };

  const restore = () => {
    Task.distinct = originals.distinct;
    ItemFollow.deleteMany = originals.followDelete;
    Notification.deleteMany = originals.notifDelete;
  };
  return { calls, restore };
};

const reset = () => {
  notifications.length = 0;
};

// ---------------------------------------------------------------------------
// grant — the first time, and every time after
// ---------------------------------------------------------------------------

test('a fresh grant pushes one entry and tells the person once', async () => {
  reset();
  const { restore } = stubModels();
  try {
    const board = makeBoard();
    const result = await grant({
      board,
      targetUserId: TARGET,
      level: 'edit',
      canManage: true,
      actorId: OWNER,
    });

    assert.strictEqual(board.memberAccess.length, 1);
    const entry = entryFor(board, TARGET);
    assert.strictEqual(entry.level, 'edit');
    assert.strictEqual(entry.canManage, true);
    assert.strictEqual(board.saves, 1, 'the board must be saved');
    assert.strictEqual(result.existed, false);

    assert.strictEqual(notifications.length, 1, 'exactly one notification');
    const n = notifications[0];
    assert.strictEqual(n.userId, TARGET);
    assert.strictEqual(n.type, 'invited');
    assert.strictEqual(
      n.message,
      'You were given access to the board "SEO Tracker 2026"'
    );
    assert.strictEqual(n.boardId, BOARD);
    assert.strictEqual(n.orgId, ORG);
    assert.strictEqual(n.actorId, OWNER);
  } finally {
    restore();
  }
});

test('changing an existing grant updates the entry and stays quiet', async () => {
  reset();
  const { restore } = stubModels();
  try {
    // Somebody the owner is moving down a rung while setting the board up.
    const board = makeBoard([{ user: TARGET, level: 'edit', canManage: true }]);
    const result = await grant({
      board,
      targetUserId: TARGET,
      level: 'view',
      canManage: false,
      actorId: OWNER,
    });

    assert.strictEqual(board.memberAccess.length, 1, 'still one entry, not two');
    assert.strictEqual(entryFor(board, TARGET).level, 'view');
    assert.strictEqual(result.existed, true);
    assert.strictEqual(
      notifications.length,
      0,
      'a level change is not a new invitation'
    );
  } finally {
    restore();
  }
});

test('full access is cleared on any rung below edit', async () => {
  reset();
  const { restore } = stubModels();
  try {
    const board = makeBoard();
    await grant({
      board,
      targetUserId: TARGET,
      level: 'contribute',
      canManage: true,
      actorId: OWNER,
    });
    // A contributor who could hand out access would be a hole, not a feature.
    assert.strictEqual(entryFor(board, TARGET).canManage, false);
  } finally {
    restore();
  }
});

test('an internal caller can suppress the notification', async () => {
  reset();
  const { restore } = stubModels();
  try {
    const board = makeBoard();
    await grant({
      board,
      targetUserId: TARGET,
      level: 'edit',
      canManage: false,
      actorId: OWNER,
      notify: false,
    });
    assert.strictEqual(board.memberAccess.length, 1, 'the grant is still written');
    assert.strictEqual(notifications.length, 0);
  } finally {
    restore();
  }
});

test('granting one person leaves everybody else alone', async () => {
  reset();
  const { restore } = stubModels();
  try {
    const board = makeBoard([{ user: BYSTANDER, level: 'view', canManage: false }]);
    await grant({ board, targetUserId: TARGET, level: 'edit', actorId: OWNER });

    assert.strictEqual(board.memberAccess.length, 2);
    assert.strictEqual(entryFor(board, BYSTANDER).level, 'view');
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// revoke — the reason this file exists
// ---------------------------------------------------------------------------

test('revoking takes the grant AND the derived subscriptions with it', async () => {
  reset();
  const { calls, restore } = stubModels();
  try {
    const board = makeBoard([
      { user: TARGET, level: 'edit', canManage: false },
      { user: BYSTANDER, level: 'view', canManage: false },
    ]);
    const result = await revoke({ board, targetUserId: TARGET });

    // The visible half.
    assert.strictEqual(entryFor(board, TARGET), undefined);
    assert.strictEqual(entryFor(board, BYSTANDER).level, 'view');
    assert.strictEqual(board.saves, 1);
    assert.strictEqual(result.existed, true);

    // The half nothing else would catch. Their ItemFollow rows on this board's
    // tasks are what kept the task-audience fan-out pinging them about work
    // they could no longer open.
    assert.strictEqual(calls.distinct.length, 1);
    assert.deepStrictEqual(calls.distinct[0].filter, { board: BOARD });
    assert.strictEqual(calls.itemFollowDeletes.length, 1);
    assert.deepStrictEqual(calls.itemFollowDeletes[0], {
      user: TARGET,
      task: { $in: TASKS },
    });

    // And the notifications already sitting in their feed, every one of which
    // now deep-links into a 403.
    assert.strictEqual(calls.notificationDeletes.length, 1);
    assert.deepStrictEqual(calls.notificationDeletes[0], {
      user: TARGET,
      board: BOARD,
    });
  } finally {
    restore();
  }
});

test('revoking a grant that was never there deletes nothing', async () => {
  reset();
  const { calls, restore } = stubModels();
  try {
    // Both the Share modal and a curated board list will send a revoke for
    // somebody who never had a grant, because neither always knows.
    const board = makeBoard([{ user: BYSTANDER, level: 'view', canManage: false }]);
    const result = await revoke({ board, targetUserId: TARGET });

    assert.strictEqual(result.existed, false);
    assert.strictEqual(board.memberAccess.length, 1, 'nobody else was touched');
    assert.strictEqual(calls.distinct.length, 0, 'no sweep over the board tasks');
    assert.strictEqual(calls.itemFollowDeletes.length, 0);
    assert.strictEqual(
      calls.notificationDeletes.length,
      0,
      'a revoke of nothing must not wipe a feed'
    );
  } finally {
    restore();
  }
});

test('a board with no tasks skips the follow sweep but still clears notifications', async () => {
  reset();
  // An empty `$in` would match nothing anyway; not issuing the query at all is
  // the behaviour the controller shipped, and the one worth keeping.
  const { calls, restore } = stubModels({ taskIds: [] });
  try {
    const board = makeBoard([{ user: TARGET, level: 'edit', canManage: false }]);
    await revoke({ board, targetUserId: TARGET });

    assert.strictEqual(calls.itemFollowDeletes.length, 0);
    assert.strictEqual(calls.notificationDeletes.length, 1);
  } finally {
    restore();
  }
});

test('ids are compared through the populated-ref idiom, not toString()', async () => {
  reset();
  const { calls, restore } = stubModels();
  try {
    // `memberAccess.user` is populated on the way out of these endpoints, so a
    // caller handing back a board it already populated is a question of when,
    // not if — and `String(doc)` on a populated Document is its inspect string,
    // never the hex id.
    const board = makeBoard([
      { user: { _id: TARGET, name: 'Ann' }, level: 'edit', canManage: false },
    ]);
    const result = await revoke({ board, targetUserId: TARGET });

    assert.strictEqual(result.existed, true, 'the populated entry was found');
    assert.strictEqual(board.memberAccess.length, 0);
    assert.strictEqual(calls.notificationDeletes.length, 1);
  } finally {
    restore();
  }
});
