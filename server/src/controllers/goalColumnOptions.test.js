const test = require('node:test');
const assert = require('node:assert/strict');

const Board = require('../models/Board');
const Organisation = require('../models/Organisation');
const Goal = require('../models/Goal');
const ActivityLog = require('../models/ActivityLog');
const { SYSTEM_ROLES, sanitizePermissions } = require('../utils/capabilities');

const {
  listGoalColumnOptions,
  addGoalColumnOption,
  updateGoalColumnOption,
  reorderGoalColumnOptions,
  deleteGoalColumnOption,
  updateGoalColumn,
} = require('./goalColumnController');

/**
 * The choices inside one `dropdown` goal column — the board's own tag
 * vocabulary, now editable after the fact.
 *
 * What is worth testing here is not "can you add a word to a list". It is the
 * three-way removal, because a goal stores the option's ID: get a removal wrong
 * and a value someone reported to a client renders as an empty cell with no
 * record of what it was. So these cover, specifically:
 *
 *   - an UNUSED choice goes on the first click, no ceremony
 *   - a USED choice changes NOTHING on the first click and reports the count
 *   - `purge` then clears the value off every goal holding it — and pulls it
 *     out of an array rather than unsetting the whole cell
 *   - retiring keeps the value and only takes the choice out of the pickers
 *   - a REQUIRED column can never be left with nothing to pick
 *   - renaming does not touch a goal, because the id is what is stored
 *   - ids are never reused, so a deleted choice cannot come back to life on a
 *     row still pointing at it
 *
 * Only the model lookups are stubbed. `loadBoardContext` and `resolveAccess`
 * run for real, so the `goal.manage` gate is exercised rather than assumed.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OWNER = '7b466b99ea3ab35ff1378d01';
const VIEWER = '7b466b99ea3ab35ff1378d03';
const ORG = '7b466b99ea3ab35ff1378d10';
const BOARD = '7b466b99ea3ab35ff1378d20';

const COL_TAGS = '7b466b99ea3ab35ff1378e01';
const COL_TEXT = '7b466b99ea3ab35ff1378e02';

const roles = SYSTEM_ROLES.map((r, i) => ({
  _id: `role${i}`,
  key: r.key,
  name: r.name,
  color: r.color,
  isSystem: true,
  permissions: sanitizePermissions(r.permissions),
}));
const roleId = (key) => roles.find((r) => r.key === key)._id;

const makeOrg = () => ({
  _id: ORG,
  admin: OWNER,
  admins: [],
  members: [OWNER, VIEWER],
  roles,
  memberRoles: [{ user: VIEWER, role: roleId('viewer') }],
  ensureSystemRoles: () => false,
});

const OPTIONS = () => [
  { id: 'technical_aaa111', label: 'Technical', color: '#2563EB', archived: false, order: 0 },
  { id: 'content_bbb222', label: 'Content', color: '#16A34A', archived: false, order: 1 },
  { id: 'links_ccc333', label: 'Links', color: '#DC2626', archived: false, order: 2 },
];

/** A goalColumn subdoc, with the two mongoose affordances the handlers use. */
const makeColumn = (over = {}) => ({
  _id: COL_TAGS,
  name: 'Channel',
  key: 'channel',
  type: 'dropdown',
  required: false,
  archived: false,
  order: 0,
  settings: { options: OPTIONS() },
  markModified() {},
  ...over,
});

const makeBoard = (columns = [makeColumn(), { ...makeColumn({ _id: COL_TEXT, name: 'Notes', type: 'text', settings: {} }) }]) => {
  const list = columns;
  // `board.goalColumns.id(...)` is a DocumentArray method the handlers rely on.
  list.id = (id) => list.find((c) => String(c._id) === String(id)) || null;
  const board = {
    _id: BOARD,
    createdBy: OWNER,
    organisation: ORG,
    boardType: 'tracker',
    visibility: 'public',
    publicDefaultLevel: 'edit',
    memberAccess: [],
    goalColumns: list,
    saves: 0,
    save() { board.saves += 1; return Promise.resolve(board); },
  };
  return board;
};

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

const chain = (value) => {
  const self = {
    sort: () => self,
    select: () => self,
    limit: () => self,
    lean: () => Promise.resolve(value),
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
  };
  return self;
};

const fakeRes = () => {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
};

const req = (overrides = {}) => ({
  params: { boardId: BOARD, cid: COL_TAGS, ...(overrides.params || {}) },
  query: overrides.query || {},
  body: overrides.body || {},
  user: { userId: overrides.userId || OWNER },
});

/**
 * @param {Object} opts
 * @param {Object[]} opts.usage    - `[{ _id: <option id or array>, count }]`,
 *                                   exactly what the aggregate returns.
 * @param {Object[]} opts.goals    - goals the clear query should find.
 */
const stubModels = ({ board = makeBoard(), org = makeOrg(), usage = [], goals = [] } = {}) => {
  const originals = {
    boardFindById: Board.findById,
    orgFindById: Organisation.findById,
    goalAggregate: Goal.aggregate,
    goalFind: Goal.find,
    goalUpdateMany: Goal.updateMany,
    logCreate: ActivityLog.create,
  };
  const calls = { updates: [], logs: [], aggregates: [] };

  Board.findById = () => Promise.resolve(board);
  Organisation.findById = () => Promise.resolve(org);
  Goal.aggregate = (pipeline) => {
    calls.aggregates.push(pipeline);
    return Promise.resolve(usage);
  };
  Goal.find = () => chain(goals);
  Goal.updateMany = (filter, update) => {
    calls.updates.push({ filter, update });
    return Promise.resolve({ modifiedCount: goals.length });
  };
  ActivityLog.create = (doc) => {
    calls.logs.push(doc);
    return Promise.resolve(doc);
  };

  const restore = () => Object.assign(Board, { findById: originals.boardFindById })
    && Object.assign(Organisation, { findById: originals.orgFindById })
    && Object.assign(Goal, {
      aggregate: originals.goalAggregate,
      find: originals.goalFind,
      updateMany: originals.goalUpdateMany,
    })
    && Object.assign(ActivityLog, { create: originals.logCreate });

  return { restore, calls, board };
};

const run = async (handler, request, stubs = {}) => {
  const state = stubModels(stubs);
  const res = fakeRes();
  try {
    await handler(request, res);
  } finally {
    state.restore();
  }
  return { res, calls: state.calls, board: state.board };
};

const optionsOn = (board) => board.goalColumns.id(COL_TAGS).settings.options;

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

test('the list carries a per-choice usage count, in one query', async () => {
  const { res, calls } = await run(listGoalColumnOptions, req(), {
    usage: [{ _id: 'technical_aaa111', count: 4 }, { _id: 'content_bbb222', count: 1 }],
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.options.length, 3);
  assert.deepEqual(res.body.usage, { technical_aaa111: 4, content_bbb222: 1 });
  assert.equal(calls.aggregates.length, 1, 'one aggregate, not one per option');
});

test('a multi-value cell is counted per tag, not per array', async () => {
  const { res } = await run(listGoalColumnOptions, req(), {
    usage: [
      { _id: ['technical_aaa111', 'content_bbb222'], count: 2 },
      { _id: 'technical_aaa111', count: 1 },
    ],
  });
  assert.deepEqual(res.body.usage, { technical_aaa111: 3, content_bbb222: 2 });
});

test('a column that holds no list has no choices to edit', async () => {
  const { res } = await run(listGoalColumnOptions, req({ params: { cid: COL_TEXT } }));
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /does not hold a list of choices/);
});

test('reading needs no goal.manage, writing does', async () => {
  const read = await run(listGoalColumnOptions, req({ userId: VIEWER }));
  assert.equal(read.res.statusCode, 200);
  assert.equal(read.res.body.canManage, false);

  const write = await run(addGoalColumnOption, req({ userId: VIEWER, body: { label: 'Local' } }));
  assert.equal(write.res.statusCode, 403);
});

// ---------------------------------------------------------------------------
// Adding
// ---------------------------------------------------------------------------

test('a new choice lands with a minted id, its colour and the next order', async () => {
  const { res, board } = await run(
    addGoalColumnOption,
    req({ body: { label: '  Local  ', color: '#7C3AED' } })
  );
  assert.equal(res.statusCode, 201);
  const added = optionsOn(board).find((o) => o.label === 'Local');
  assert.ok(added, 'the choice was stored');
  assert.match(added.id, /^local_[0-9a-f]{6}$/, 'id is slug + random suffix');
  assert.equal(added.color, '#7C3AED');
  assert.equal(added.order, 3);
  assert.equal(added.archived, false);
  assert.equal(board.saves, 1);
});

test('a colour that is not a hex falls back rather than being stored', async () => {
  const { board } = await run(
    addGoalColumnOption,
    req({ body: { label: 'Local', color: 'javascript:alert(1)' } })
  );
  assert.equal(optionsOn(board).find((o) => o.label === 'Local').color, '#6B7280');
});

test('a duplicate label is refused — two identical chips cannot be told apart', async () => {
  const { res, board } = await run(addGoalColumnOption, req({ body: { label: 'content' } }));
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /already a choice/);
  assert.equal(optionsOn(board).length, 3);
});

test('a retired twin is offered back instead of duplicated', async () => {
  const col = makeColumn();
  col.settings.options[2].archived = true;
  const { res } = await run(addGoalColumnOption, req({ body: { label: 'Links' } }), {
    board: makeBoard([col]),
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /retired/);
  assert.equal(res.body.restorableId, 'links_ccc333');
});

test('an id is never reused, so a deleted choice cannot revive on a stale row', async () => {
  // Delete "Links", then add a choice by the same name: the new id must differ,
  // or a goal still holding `links_ccc333` would silently show the new tag.
  const board = makeBoard([makeColumn()]);
  await run(deleteGoalColumnOption, req({ params: { oid: 'links_ccc333' } }), { board });
  const after = await run(addGoalColumnOption, req({ body: { label: 'Links' } }), { board });
  assert.equal(after.res.statusCode, 201);
  const revived = optionsOn(board).find((o) => o.label === 'Links');
  assert.notEqual(revived.id, 'links_ccc333');
});

// ---------------------------------------------------------------------------
// Renaming, recolouring, reordering — free, because the id is what is stored
// ---------------------------------------------------------------------------

test('a rename touches the vocabulary and not one goal', async () => {
  const { res, calls, board } = await run(
    updateGoalColumnOption,
    req({ params: { oid: 'content_bbb222' }, body: { label: 'Content & PR' } })
  );
  assert.equal(res.statusCode, 200);
  const opt = optionsOn(board).find((o) => o.id === 'content_bbb222');
  assert.equal(opt.label, 'Content & PR');
  assert.equal(opt.id, 'content_bbb222', 'the id is NOT re-slugged on rename');
  assert.equal(calls.updates.length, 0, 'no goal was written');
});

test('renaming onto an existing label is refused', async () => {
  const { res } = await run(
    updateGoalColumnOption,
    req({ params: { oid: 'content_bbb222' }, body: { label: 'Technical' } })
  );
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /already a choice/);
});

test('reordering rewrites order only, and tolerates ids it was not given', async () => {
  const { res, board } = await run(
    reorderGoalColumnOptions,
    req({ body: { orderedIds: ['links_ccc333', 'technical_aaa111'] } })
  );
  assert.equal(res.statusCode, 200);
  const by = Object.fromEntries(optionsOn(board).map((o) => [o.id, o.order]));
  assert.equal(by.links_ccc333, 0);
  assert.equal(by.technical_aaa111, 1);
  assert.equal(by.content_bbb222, 1, 'an id left out keeps the order it had');
  assert.equal(res.body.options.length, 3);
});

test('reorder refuses anything that is not a list', async () => {
  const { res } = await run(reorderGoalColumnOptions, req({ body: { orderedIds: 'nope' } }));
  assert.equal(res.statusCode, 400);
});

// ---------------------------------------------------------------------------
// Removing — the three outcomes
// ---------------------------------------------------------------------------

test('an unused choice goes on the first click', async () => {
  const { res, calls, board } = await run(
    deleteGoalColumnOption,
    req({ params: { oid: 'links_ccc333' } }),
    { usage: [{ _id: 'technical_aaa111', count: 2 }] }
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.removed, true);
  assert.equal(res.body.clearedCount, 0);
  assert.equal(optionsOn(board).length, 2);
  assert.equal(calls.updates.length, 0, 'nothing to clear, so no goal was touched');
});

test('a used choice changes NOTHING on the first click and reports the count', async () => {
  const { res, calls, board } = await run(
    deleteGoalColumnOption,
    req({ params: { oid: 'technical_aaa111' } }),
    { usage: [{ _id: 'technical_aaa111', count: 7 }] }
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.confirmRequired, true);
  assert.equal(res.body.usedByCount, 7);
  assert.equal(res.body.removed, undefined);
  assert.equal(optionsOn(board).length, 3, 'the choice is still there');
  assert.equal(board.saves, 0, 'and nothing was saved');
  assert.equal(calls.updates.length, 0);
});

test('purge removes the choice and clears it off every goal holding it', async () => {
  const goals = [
    {
      _id: 'g1', board: BOARD, name: 'Rank top 3', type: 'increase_to', monthKey: '2026-09',
      group: 'grp1', config: {}, columnValues: { [COL_TAGS]: 'technical_aaa111' },
    },
  ];
  const { res, calls, board } = await run(
    deleteGoalColumnOption,
    req({ params: { oid: 'technical_aaa111' }, query: { purge: 'true' } }),
    { usage: [{ _id: 'technical_aaa111', count: 1 }], goals }
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.removed, true);
  assert.equal(res.body.clearedCount, 1);
  assert.equal(optionsOn(board).length, 2);

  // The $pull runs BEFORE the $unset: `{ field: id }` matches an array
  // containing the id too, so unsetting first would wipe a whole multi-value
  // cell to remove one tag from it.
  assert.equal(calls.updates.length, 2);
  assert.ok(calls.updates[0].update.$pull, 'arrays are pulled from first');
  assert.ok(calls.updates[1].update.$unset, 'then scalars are unset');
  assert.deepEqual(
    Object.keys(calls.updates[1].update.$unset),
    [`columnValues.${COL_TAGS}`]
  );
});

test('every cleared goal gets a history row naming what it lost', async () => {
  const goals = [
    {
      _id: 'g1', board: BOARD, name: 'Rank top 3', type: 'increase_to', monthKey: '2026-09',
      group: 'grp1', config: {}, columnValues: { [COL_TAGS]: 'technical_aaa111' },
    },
    {
      _id: 'g2', board: BOARD, name: 'Fix crawl', type: 'increase_to', monthKey: '2026-09',
      group: 'grp1', config: {}, columnValues: { [COL_TAGS]: 'technical_aaa111' },
    },
  ];
  const { calls } = await run(
    deleteGoalColumnOption,
    req({ params: { oid: 'technical_aaa111' }, query: { purge: 'true' } }),
    { usage: [{ _id: 'technical_aaa111', count: 2 }], goals }
  );
  assert.equal(calls.logs.length, 2);
  for (const row of calls.logs) {
    assert.equal(row.type, 'goal.field_changed');
    assert.equal(row.field, `column:${COL_TAGS}`);
    assert.equal(row.oldValue, 'technical_aaa111');
    assert.equal(row.newValue, null);
    assert.equal(row.actor, OWNER);
    assert.equal(row.metadata.columnLabel, 'Channel');
    // The WORD, pinned before the choice was taken off the column — otherwise
    // the one row explaining what a goal lost reads "technical_aaa111".
    assert.equal(row.metadata.oldLabel, 'Technical');
    assert.equal(row.metadata.newLabel, null);
  }
});

test('a multi-value cell loses the one tag, not the whole cell, in its history', async () => {
  const goals = [{
    _id: 'g1', board: BOARD, name: 'Rank top 3', type: 'increase_to', monthKey: '2026-09',
    group: 'grp1', config: {},
    columnValues: { [COL_TAGS]: ['technical_aaa111', 'content_bbb222'] },
  }];
  const { calls } = await run(
    deleteGoalColumnOption,
    req({ params: { oid: 'technical_aaa111' }, query: { purge: 'true' } }),
    { usage: [{ _id: ['technical_aaa111', 'content_bbb222'], count: 1 }], goals }
  );
  assert.equal(calls.logs.length, 1);
  assert.deepEqual(calls.logs[0].newValue, ['content_bbb222']);
});

test('retiring keeps every value and only takes the choice out of the pickers', async () => {
  const { res, calls, board } = await run(
    updateGoalColumnOption,
    req({ params: { oid: 'technical_aaa111' }, body: { archived: true } }),
    { usage: [{ _id: 'technical_aaa111', count: 7 }] }
  );
  assert.equal(res.statusCode, 200);
  const opt = optionsOn(board).find((o) => o.id === 'technical_aaa111');
  assert.equal(opt.archived, true);
  assert.equal(optionsOn(board).length, 3, 'nothing was removed');
  assert.equal(calls.updates.length, 0, 'and no goal was written');
  assert.equal(res.body.usage.technical_aaa111, 7, 'the count is still reported');
});

test('a retired choice can be brought back', async () => {
  const col = makeColumn();
  col.settings.options[0].archived = true;
  const { res, board } = await run(
    updateGoalColumnOption,
    req({ params: { oid: 'technical_aaa111' }, body: { archived: false } }),
    { board: makeBoard([col]) }
  );
  assert.equal(res.statusCode, 200);
  assert.equal(optionsOn(board).find((o) => o.id === 'technical_aaa111').archived, false);
});

test('restoring is refused when a live choice has since taken the name', async () => {
  const col = makeColumn({
    settings: {
      options: [
        { id: 'technical_aaa111', label: 'Technical', archived: true, order: 0 },
        { id: 'technical_zzz999', label: 'technical', archived: false, order: 1 },
      ],
    },
  });
  const { res } = await run(
    updateGoalColumnOption,
    req({ params: { oid: 'technical_aaa111' }, body: { archived: false } }),
    { board: makeBoard([col]) }
  );
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /already a live choice/);
});

// ---------------------------------------------------------------------------
// The required-column guard
// ---------------------------------------------------------------------------

test('a required column cannot be left with nothing to pick — retire', async () => {
  const col = makeColumn({
    required: true,
    settings: { options: [{ id: 'only_aaa111', label: 'Only', archived: false, order: 0 }] },
  });
  const { res, board } = await run(
    updateGoalColumnOption,
    req({ params: { oid: 'only_aaa111' }, body: { archived: true } }),
    { board: makeBoard([col]) }
  );
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /at least one choice/);
  assert.equal(optionsOn(board).find((o) => o.id === 'only_aaa111').archived, false);
});

test('a required column cannot be left with nothing to pick — delete, even unused', async () => {
  const col = makeColumn({
    required: true,
    settings: { options: [{ id: 'only_aaa111', label: 'Only', archived: false, order: 0 }] },
  });
  const { res, board } = await run(
    deleteGoalColumnOption,
    req({ params: { oid: 'only_aaa111' } }),
    { board: makeBoard([col]), usage: [] }
  );
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /at least one choice/);
  assert.equal(optionsOn(board).length, 1);
});

test('the last choice on a NOT-required column may go', async () => {
  const col = makeColumn({
    settings: { options: [{ id: 'only_aaa111', label: 'Only', archived: false, order: 0 }] },
  });
  const { res, board } = await run(
    deleteGoalColumnOption,
    req({ params: { oid: 'only_aaa111' } }),
    { board: makeBoard([col]), usage: [] }
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.removed, true);
  assert.equal(optionsOn(board).length, 0);
});

test('a purge on a required column says the month will be blocked', async () => {
  const col = makeColumn({ required: true });
  const { res } = await run(
    deleteGoalColumnOption,
    req({ params: { oid: 'technical_aaa111' } }),
    { board: makeBoard([col]), usage: [{ _id: 'technical_aaa111', count: 3 }] }
  );
  assert.equal(res.body.confirmRequired, true);
  assert.equal(res.body.columnRequired, true);
});

test('an unknown option id is a 404, not a silent no-op', async () => {
  const del = await run(deleteGoalColumnOption, req({ params: { oid: 'nope' } }));
  assert.equal(del.res.statusCode, 404);
  const patch = await run(
    updateGoalColumnOption,
    req({ params: { oid: 'nope' }, body: { label: 'x' } })
  );
  assert.equal(patch.res.statusCode, 404);
});

// ---------------------------------------------------------------------------
// The legacy whole-list write
// ---------------------------------------------------------------------------

test('the column PATCH refuses to rewrite a vocabulary that is already in use', async () => {
  const { res, board } = await run(
    updateGoalColumn,
    req({ body: { settings: { options: [{ label: 'Something else' }] } } })
  );
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /one at a time/);
  assert.equal(optionsOn(board).length, 3, 'the ids goals point at are untouched');
});

test('Required cannot be turned on while a list column has nothing to pick', async () => {
  const col = makeColumn({ settings: { options: [] } });
  const { res, board } = await run(
    updateGoalColumn,
    req({ body: { required: true } }),
    { board: makeBoard([col]) }
  );
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /no choices to pick from/);
  assert.equal(board.goalColumns.id(COL_TAGS).required, false);
});

test('Required is unaffected on a list column that does have choices', async () => {
  const { res, board } = await run(updateGoalColumn, req({ body: { required: true } }));
  assert.equal(res.statusCode, 200);
  assert.equal(board.goalColumns.id(COL_TAGS).required, true);
  assert.ok(board.goalColumns.id(COL_TAGS).requiredSince, 'still stamped');
});

test('the column PATCH still seeds choices on a column that has none', async () => {
  const col = makeColumn({ settings: {} });
  const { res, board } = await run(
    updateGoalColumn,
    req({ body: { settings: { options: [{ label: 'A' }, { label: 'a' }, { label: 'B' }] } } }),
    { board: makeBoard([col]) }
  );
  assert.equal(res.statusCode, 200);
  const stored = optionsOn(board);
  assert.deepEqual(stored.map((o) => o.label), ['A', 'B'], 'the duplicate is dropped');
  assert.match(stored[0].id, /^a_[0-9a-f]{6}$/);
});
