const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');

require('../models');
const { cascadeDeleteOrg } = require('./orgCascade');

/**
 * orgCascade.test.js — the collections a workspace teardown must reach, and the
 * order two of them have to be reached in.
 *
 * There is no pure function to test here. `cascadeDeleteOrg` is a sequence of
 * deletes, and what went wrong with it was never a miscalculation: it was
 * collections nobody remembered — ExecutiveView, ServiceCatalogEntry, the
 * org-level ActivityLog rows, SavedMessage, and the muted-board ids on every
 * user's notification preferences. A list that can silently go one entry shorter
 * on the next edit is exactly the kind of thing a test should hold down, so this
 * file pins the list itself.
 *
 * The technique is the one `services/connectors/dataforseo/tasks.test.js`
 * already uses on this same function: replace every registered model's query
 * methods with recorders, run the cascade, and read back what it asked for. It
 * is not a database test — nothing connects — and it deliberately asserts on the
 * FILTERS rather than on any result, because the filter is the decision.
 */

const chain = (value) => {
  const self = {
    select: () => self,
    sort: () => self,
    limit: () => self,
    lean: () => Promise.resolve(value),
    then: (res, rej) => Promise.resolve(value).then(res, rej),
  };
  return self;
};

/**
 * Run the cascade with every model stubbed, and hand back every call it made.
 *
 * `Board.distinct` and `Task.distinct` answer with ids so the `if (boardIds
 * .length)` branch is actually entered — a run with no boards would skip the
 * half of this file that lives inside it, which is the same blind spot that let
 * the org-level ActivityLog rows survive in the first place.
 */
const runCascade = async () => {
  const boardIds = ['board-1', 'board-2'];
  const calls = [];
  const saved = [];

  for (const model of Object.values(mongoose.models)) {
    saved.push([model, { ...model }]);
    const name = model.modelName;
    model.distinct = async () => {
      if (name === 'Board') return boardIds;
      if (name === 'Task') return ['task-1'];
      // The org's NON-DM rooms. The cascade selects these itself (with
      // `kind: { $ne: 'dm' }`) and sweeps the bookmarks by channel rather than
      // by organisation — see the DM test below for why that distinction is the
      // whole point.
      if (name === 'Channel') return ['chan-1', 'chan-2'];
      return [];
    };
    model.find = () => chain([]);
    model.findOne = () => chain(null);
    model.countDocuments = async () => 0;
    model.aggregate = async () => [];
    model.bulkWrite = async () => ({ ok: 1 });
    model.deleteMany = async (filter) => {
      calls.push({ op: 'deleteMany', name, filter });
      return { deletedCount: 0 };
    };
    model.deleteOne = async (filter) => {
      calls.push({ op: 'deleteOne', name, filter });
      return { deletedCount: 1 };
    };
    model.updateMany = async (filter, update) => {
      calls.push({ op: 'updateMany', name, filter, update });
      return { acknowledged: true };
    };
    model.updateOne = async () => ({ acknowledged: true });
  }

  try {
    await cascadeDeleteOrg('org-1');
  } finally {
    for (const [model, original] of saved) Object.assign(model, original);
  }

  return { calls, boardIds };
};

test('the workspace-scoped collections nobody was collecting are collected', async () => {
  const { calls } = await runCascade();
  const byOrg = (name) =>
    calls.find(
      (c) =>
        c.name === name &&
        c.op === 'deleteMany' &&
        c.filter &&
        c.filter.organisation === 'org-1'
    );

  // Executive profiles. Before this line they were reached by NO cascade at
  // all, and the pair {organisation, user} is their identity — so once the org
  // document went, no query in the product could name them again.
  assert.ok(byOrg('ExecutiveView'), 'every executive profile in the workspace');
  // The agency's service vocabulary. It had no delete path anywhere in the
  // server: the service only reads, upserts and archives.
  assert.ok(byOrg('ServiceCatalogEntry'), 'the service catalog');
  // Chat bookmarks, which no teardown at any level collected. NOT `byOrg` —
  // this one is deliberately scoped by the org's non-DM channel ids instead, so
  // that a bookmark on a DM (which survives the teardown, as the DM itself does)
  // is not swept up with it. See the dedicated test below.
  assert.ok(
    calls.some(
      (c) => c.name === 'SavedMessage' && c.op === 'deleteMany' && c.filter?.channel
    ),
    'saved messages'
  );
  // The executive-subject activity rows, which carry no task and no board and
  // so fell through both of the sweeps that were already here.
  assert.ok(byOrg('ActivityLog'), 'the org-level activity rows');
});

test('the org-scoped ActivityLog sweep can never precede the board-scoped one', async () => {
  const { calls, boardIds } = await runCascade();
  const activity = calls.filter((c) => c.name === 'ActivityLog' && c.op === 'deleteMany');

  const byTask = activity.findIndex((c) => c.filter && c.filter.task);
  const byBoard = activity.findIndex((c) => c.filter && c.filter.board);
  const byOrg = activity.findIndex((c) => c.filter && c.filter.organisation);

  assert.ok(byTask >= 0, 'the task-scoped sweep');
  assert.ok(byBoard >= 0, 'the board-scoped sweep');
  assert.ok(byOrg >= 0, 'the org-scoped sweep');
  // The board-scoped sweep's comment reasons about collecting rows whose
  // subject is already gone. That reasoning only holds while it still runs
  // first, so the org-scoped sweep goes last — outside the `if (boardIds
  // .length)` block, where an org with no boards left cannot skip it.
  assert.ok(byBoard < byOrg, 'the org sweep is last, not folded into the board block');
  assert.deepEqual(activity[byBoard].filter, { board: { $in: boardIds } });
  assert.deepEqual(activity[byOrg].filter, { organisation: 'org-1' });
});

test('saved bookmarks go before the channels and messages they point at', async () => {
  const { calls } = await runCascade();
  const order = calls.map((c) => `${c.name}.${c.op}`);
  const saved = order.indexOf('SavedMessage.deleteMany');
  const messages = order.indexOf('Message.deleteMany');
  const channels = order.indexOf('Channel.deleteMany');

  assert.ok(saved >= 0, 'bookmarks are swept');
  // Children before parents, like everything else in this file: a run that dies
  // halfway leaves bookmarks whose targets still exist rather than bookmarks
  // pointing into nothing.
  if (messages >= 0) assert.ok(saved < messages, 'bookmarks before messages');
  if (channels >= 0) assert.ok(saved < channels, 'bookmarks before channels');
});

test('stale muted-board ids are pulled while the boards still exist', async () => {
  const { calls, boardIds } = await runCascade();
  const order = calls.map((c) => `${c.name}.${c.op}`);
  const pull = calls.find(
    (c) => c.name === 'NotificationPreference' && c.op === 'updateMany'
  );

  assert.ok(pull, 'the $in counterpart of the single-board $pull in deleteBoard');
  assert.deepEqual(pull.filter, { mutedBoards: { $in: boardIds } });
  assert.deepEqual(pull.update, { $pull: { mutedBoards: { $in: boardIds } } });
  assert.ok(
    order.indexOf('NotificationPreference.updateMany') < order.indexOf('Board.deleteMany'),
    'pulled before the boards go, so a half-run leaves resolvable ids'
  );
});

test('a DM bookmark is not collected by a workspace sweep', async () => {
  const { calls } = await runCascade();
  const saved = calls.filter((c) => c.name === 'SavedMessage');

  // THE FILTER IS THE TEST, and the obvious one is wrong.
  //
  // `Channel.organisation` is REQUIRED on every room INCLUDING a DM — it records
  // where the DM was first opened — and `toggleSave` copies that field onto the
  // bookmark. So `{ organisation: orgId }`, which is what this sweep originally
  // used, reaches bookmarks on DM messages. This cascade deliberately does not
  // delete the DMs themselves (`deleteWorkspaceChannels` excludes `kind: 'dm'`,
  // because a direct line belongs to its two PEOPLE, not to the workspace), so
  // an org-scoped sweep produced the worst possible outcome: the conversation
  // and its messages survive, and one participant's bookmarks on them silently
  // vanish because a third party tore down an unrelated workspace.
  //
  // Scoping by the org's non-DM CHANNEL ids is what fixes it. A regression here
  // would show up as a filter naming `organisation` or `user` instead.
  assert.ok(saved.length >= 1, 'bookmarks are swept');
  for (const sweep of saved) {
    assert.ok(
      sweep.filter && sweep.filter.channel,
      'every SavedMessage sweep is scoped by channel, never by organisation'
    );
    assert.equal(sweep.filter.organisation, undefined);
    assert.equal(sweep.filter.user, undefined);
  }
  assert.deepEqual(saved[0].filter, { channel: { $in: ['chan-1', 'chan-2'] } });
});
