const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.CONNECTOR_MASTER_KEY_V1 = crypto.randomBytes(32).toString('base64');

const Board = require('../models/Board');
const Organisation = require('../models/Organisation');
const BoardConnector = require('../models/BoardConnector');
const ConnectorFieldMapping = require('../models/ConnectorFieldMapping');
const { SYSTEM_ROLES, sanitizePermissions } = require('../utils/capabilities');

const {
  getConnectorFields,
  setConnectorFieldMapping,
  deleteConnectorFieldMapping,
  publicMapping,
} = require('./connectorFieldController');

/**
 * The field-mapping handlers, exercised through their real authorization gate.
 *
 * Only the model lookups are stubbed. `loadBoardContext` and `resolveAccess` run
 * for real against document-shaped fixtures, so these cover the thing that
 * actually decides who may bind a provider field to a goal cell: the two-layer
 * AND of org role and board level, and the tracker-board check on top of it.
 *
 * The other half is the refusal. A type-incompatible mapping breaks nothing at
 * save time — it breaks inside a weekly run, on one field of one board, with the
 * only symptom being a cell that never fills. So "refused at save, with a
 * sentence" is a correctness property here, not a nicety.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OWNER = '6a466b99ea3ab35ff1378d01';
const MEMBER = '6a466b99ea3ab35ff1378d02';
const VIEWER = '6a466b99ea3ab35ff1378d03';
const ORG = '6a466b99ea3ab35ff1378d10';
const BOARD = '6a466b99ea3ab35ff1378d20';

const COL_NUMBER = '6a466b99ea3ab35ff1378e01';
const COL_TEXT = '6a466b99ea3ab35ff1378e02';
const COL_PERSON = '6a466b99ea3ab35ff1378e03';
const COL_ARCHIVED = '6a466b99ea3ab35ff1378e04';
const FOREIGN_COL = '6a466b99ea3ab35ff1378eff';

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
  members: [OWNER, MEMBER, VIEWER],
  roles,
  memberRoles: [
    { user: MEMBER, role: roleId('member') },
    { user: VIEWER, role: roleId('viewer') },
  ],
  ensureSystemRoles: () => false,
});

const makeBoard = (overrides = {}) => ({
  _id: BOARD,
  createdBy: OWNER,
  organisation: ORG,
  boardType: 'tracker',
  visibility: 'public',
  publicDefaultLevel: 'edit',
  memberAccess: [],
  goalColumns: [
    { _id: COL_NUMBER, name: 'Volume', key: 'volume', type: 'number', order: 0 },
    { _id: COL_TEXT, name: 'Notes', key: 'notes', type: 'text', order: 1 },
    { _id: COL_PERSON, name: 'Owner', key: 'owner', type: 'person', order: 2 },
    {
      _id: COL_ARCHIVED,
      name: 'Old KD',
      key: 'keyword_difficultly',
      type: 'number',
      order: 3,
      archived: true,
    },
  ],
  ...overrides,
});

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** A thenable that answers `.sort().select().lean()` in any order. */
const chain = (value) => {
  const self = {
    sort: () => self,
    select: () => self,
    lean: () => Promise.resolve(value),
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
  };
  return self;
};

const fakeRes = () => {
  const res = { statusCode: 200, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    return res;
  };
  return res;
};

const req = (overrides = {}) => ({
  params: { boardId: BOARD, provider: 'ubersuggest', ...(overrides.params || {}) },
  query: overrides.query || {},
  body: overrides.body || {},
  user: { userId: overrides.userId || OWNER },
});

/**
 * Install stubs for one test and hand back a restore function, plus a record of
 * what the handler tried to write.
 */
const stubModels = ({
  board = makeBoard(),
  org = makeOrg(),
  mappings = [],
  boardConnector = { enabled: true, kinds: [] },
  clash = null,
  upsertError = null,
} = {}) => {
  const originals = {
    boardFindById: Board.findById,
    orgFindById: Organisation.findById,
    bcFindOne: BoardConnector.findOne,
    mapFind: ConnectorFieldMapping.find,
    mapFindOne: ConnectorFieldMapping.findOne,
    mapUpsert: ConnectorFieldMapping.findOneAndUpdate,
    mapDelete: ConnectorFieldMapping.deleteOne,
  };

  const calls = { upserts: [], deletes: [], clashFilters: [] };

  Board.findById = () => Promise.resolve(board);
  Organisation.findById = () => Promise.resolve(org);
  BoardConnector.findOne = () => chain(boardConnector);
  ConnectorFieldMapping.find = () => chain(mappings);
  ConnectorFieldMapping.findOne = (filter) => {
    calls.clashFilters.push(filter);
    return chain(clash);
  };
  ConnectorFieldMapping.findOneAndUpdate = (filter, update) => {
    calls.upserts.push({ filter, update });
    if (upsertError) return chain(Promise.reject(upsertError));
    const set = update.$set || {};
    return chain({
      _id: '6a466b99ea3ab35ff1378f01',
      board: BOARD,
      provider: filter.provider,
      sourceField: filter.sourceField,
      target: set.target,
      autoFill: set.autoFill !== undefined ? set.autoFill : true,
      updatedAt: new Date('2026-08-27T00:00:00.000Z'),
    });
  };
  ConnectorFieldMapping.deleteOne = (filter) => {
    calls.deletes.push(filter);
    return Promise.resolve({ deletedCount: 1 });
  };

  const restore = () => {
    Board.findById = originals.boardFindById;
    Organisation.findById = originals.orgFindById;
    BoardConnector.findOne = originals.bcFindOne;
    ConnectorFieldMapping.find = originals.mapFind;
    ConnectorFieldMapping.findOne = originals.mapFindOne;
    ConnectorFieldMapping.findOneAndUpdate = originals.mapUpsert;
    ConnectorFieldMapping.deleteOne = originals.mapDelete;
  };
  return { restore, calls };
};

/** Run one handler against one stubbed world. */
const run = async (handler, request, stubs = {}) => {
  const { restore, calls } = stubModels(stubs);
  const res = fakeRes();
  try {
    await handler(request, res);
  } finally {
    restore();
  }
  return { res, calls };
};

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

test('a standard board has no field mappings to be refused access to', async () => {
  // 404 rather than 403, matching goalController and the other two connector
  // controllers: on a board where the feature does not exist, "denied" would
  // imply there is something there.
  const { res } = await run(getConnectorFields, req(), {
    board: makeBoard({ boardType: 'standard' }),
  });
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.code, 'NOT_TRACKER_BOARD');
});

test('an unknown provider is a 400, not a 500 from a null descriptor', async () => {
  const { res } = await run(getConnectorFields, req({ params: { provider: 'nope' } }));
  assert.equal(res.statusCode, 400);
});

test('reading the catalog needs only connector.view', async () => {
  // The bottom rung. Nothing here contacts a provider or spends quota — the
  // catalog is static on the descriptor and the mappings are our own rows.
  const { res } = await run(getConnectorFields, req({ userId: VIEWER }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.canManage, false);
});

test('a viewer cannot bind a field, and is refused server-side', async () => {
  // Hiding the control was never the enforcement.
  const { res, calls } = await run(
    setConnectorFieldMapping,
    req({
      userId: VIEWER,
      params: { field: 'volume' },
      body: { targetId: `column:${COL_NUMBER}` },
    })
  );
  assert.equal(res.statusCode, 403);
  assert.equal(calls.upserts.length, 0);
});

test('a viewer cannot unbind one either', async () => {
  const { res, calls } = await run(
    deleteConnectorFieldMapping,
    req({ userId: VIEWER, params: { field: 'volume' } })
  );
  assert.equal(res.statusCode, 403);
  assert.equal(calls.deletes.length, 0);
});

test('an ordinary member with edit on the board may map', async () => {
  const { res } = await run(
    setConnectorFieldMapping,
    req({
      userId: MEMBER,
      params: { field: 'volume' },
      body: { targetId: `column:${COL_NUMBER}` },
    })
  );
  assert.equal(res.statusCode, 200);
});

// ---------------------------------------------------------------------------
// The catalog read
// ---------------------------------------------------------------------------

test('the catalog carries the fields, the targets and the refusals in one request', async () => {
  const { res } = await run(getConnectorFields, req());
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.fields.length > 0);
  assert.ok(res.body.targets.length > 0);
  const rank = res.body.fields.find((f) => f.key === 'rank');
  assert.equal(rank.type, 'number');
  assert.equal(rank.scope, 'keyword');
  assert.ok(rank.nullMeans);
  // The refusal the panel greys the option out with is the same sentence the
  // save would return — computed once, server-side.
  assert.ok(rank.refusals[`column:${COL_PERSON}`]);
  assert.equal(rank.refusals[`column:${COL_NUMBER}`], undefined);
});

test('nothing executable reaches the client', async () => {
  // Every catalog entry carries a pure `read` function. A spread would drop it
  // silently through JSON and leave an entry that looks complete and cannot
  // extract anything.
  const { res } = await run(getConnectorFields, req());
  for (const field of res.body.fields) {
    assert.equal('read' in field, false, field.key);
  }
  assert.ok(!JSON.stringify(res.body).includes('function'));
});

test('a field whose kind this board switched off is flagged, not hidden', async () => {
  // Hiding it would make the mapping unreachable; leaving it unmarked would make
  // an empty cell a mystery. `collected` is how the panel says which it is.
  const { res } = await run(getConnectorFields, req(), {
    boardConnector: { enabled: true, kinds: ['positions'] },
  });
  const byKey = new Map(res.body.fields.map((f) => [f.key, f]));
  assert.equal(byKey.get('rank').collected, true);
  assert.equal(byKey.get('volume').collected, false);
  assert.equal(byKey.get('health_score').collected, false);
});

test('an empty kind selection means EVERYTHING, so nothing reads as uncollected', async () => {
  // `resolveKinds` treats `[]` as the full set — a board that just enabled the
  // connector has expressed no opinion. Reading it as "collect nothing" here
  // would tell a freshly enabled board that none of its fields will ever fill.
  const { res } = await run(getConnectorFields, req(), {
    boardConnector: { enabled: true, kinds: [] },
  });
  for (const field of res.body.fields) assert.equal(field.collected, true, field.key);
});

test('a keyword-scoped field depending on positions still resolves its dependency', async () => {
  // `keyword_metrics` reads its keyword list out of `positions`, so narrowing a
  // board to metrics alone still collects positions — and the panel must agree.
  const { res } = await run(getConnectorFields, req(), {
    boardConnector: { enabled: true, kinds: ['keyword_metrics'] },
  });
  const byKey = new Map(res.body.fields.map((f) => [f.key, f]));
  assert.equal(byKey.get('volume').collected, true);
  assert.equal(byKey.get('rank').collected, true);
});

test('existing mappings come back flattened to a single wire id', async () => {
  const { res } = await run(getConnectorFields, req(), {
    mappings: [
      {
        _id: '6a466b99ea3ab35ff1378f01',
        provider: 'ubersuggest',
        sourceField: 'volume',
        target: { kind: 'goalColumn', columnId: COL_NUMBER, builtin: null },
        autoFill: true,
      },
    ],
  });
  assert.equal(res.body.mappings[0].targetId, `column:${COL_NUMBER}`);
  assert.equal(res.body.mappings[0].sourceField, 'volume');
});

// ---------------------------------------------------------------------------
// Saving a mapping
// ---------------------------------------------------------------------------

test('a compatible mapping is stored as a structured target', async () => {
  const { res, calls } = await run(
    setConnectorFieldMapping,
    req({ params: { field: 'volume' }, body: { targetId: `column:${COL_NUMBER}` } })
  );
  assert.equal(res.statusCode, 200);
  const { filter, update } = calls.upserts[0];
  // Upserted against (board, provider, sourceField), which is what makes
  // re-pointing a field REPLACE its binding rather than add a second one — the
  // property behind "remap it and the old column stops updating".
  assert.deepEqual(filter, {
    board: BOARD,
    provider: 'ubersuggest',
    sourceField: 'volume',
  });
  assert.equal(update.$set.target.kind, 'goalColumn');
  assert.equal(update.$set.target.columnId, COL_NUMBER);
  assert.equal(update.$set.target.builtin, null);
});

test('an incompatible mapping is refused at SAVE time with a readable sentence', async () => {
  // The whole point of the phase. Search intent is text; Volume holds a number.
  const { res, calls } = await run(
    setConnectorFieldMapping,
    req({ params: { field: 'search_intent' }, body: { targetId: `column:${COL_NUMBER}` } })
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'INCOMPATIBLE_TYPE');
  assert.match(res.body.error, /Search intent/);
  assert.match(res.body.error, /Volume/);
  assert.equal(calls.upserts.length, 0);
});

test('a person column is refused for every field', async () => {
  const { res } = await run(
    setConnectorFieldMapping,
    req({ params: { field: 'rank' }, body: { targetId: `column:${COL_PERSON}` } })
  );
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /team/i);
});

test('a number widens into a text column', async () => {
  const { res } = await run(
    setConnectorFieldMapping,
    req({ params: { field: 'rank' }, body: { targetId: `column:${COL_TEXT}` } })
  );
  assert.equal(res.statusCode, 200);
});

test('an archived column is refused, because nothing could see what landed there', async () => {
  const { res } = await run(
    setConnectorFieldMapping,
    req({ params: { field: 'seo_difficulty' }, body: { targetId: `column:${COL_ARCHIVED}` } })
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'COLUMN_ARCHIVED');
});

test('a column on another board cannot be named', async () => {
  // The target is resolved against THIS board, which is the reason it is an
  // `_id` and not a key: a slug would resolve on any board using the same word.
  const { res, calls } = await run(
    setConnectorFieldMapping,
    req({ params: { field: 'volume' }, body: { targetId: `column:${FOREIGN_COL}` } })
  );
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /not on this board/i);
  assert.equal(calls.upserts.length, 0);
});

test('an invented builtin is refused', async () => {
  // Otherwise a client could point the writeback at a path nobody vetted.
  const { res } = await run(
    setConnectorFieldMapping,
    req({ params: { field: 'rank' }, body: { targetId: 'builtin:organisation.admin' } })
  );
  assert.equal(res.statusCode, 400);
});

test('a field the provider does not declare is refused', async () => {
  const { res } = await run(
    setConnectorFieldMapping,
    req({ params: { field: 'made_up' }, body: { targetId: `column:${COL_NUMBER}` } })
  );
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /made_up/);
});

test('a missing target is a 400 rather than a mapping that names nowhere', async () => {
  for (const body of [{}, { targetId: '' }, { targetId: 42 }, { targetId: 'nope' }]) {
    const { res } = await run(
      setConnectorFieldMapping,
      req({ params: { field: 'rank' }, body })
    );
    assert.equal(res.statusCode, 400, JSON.stringify(body));
  }
});

test('rank may fill the result, and the config targets accept numbers too', async () => {
  for (const key of ['actual', 'config.baseline', 'config.target']) {
    const { res } = await run(
      setConnectorFieldMapping,
      req({ params: { field: 'rank' }, body: { targetId: `builtin:${key}` } })
    );
    assert.equal(res.statusCode, 200, key);
  }
});

test('a target already claimed by another field is refused, naming that field', async () => {
  // A column filled by two sources would have its winner decided by document
  // order. The friendlier pre-check names the culprit; the unique index is still
  // the authority.
  const { res } = await run(
    setConnectorFieldMapping,
    req({ params: { field: 'rank' }, body: { targetId: `column:${COL_NUMBER}` } }),
    {
      clash: {
        _id: '6a466b99ea3ab35ff1378f02',
        provider: 'ubersuggest',
        sourceField: 'volume',
      },
    }
  );
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'TARGET_TAKEN');
  assert.match(res.body.error, /Search volume/);
});

test('the clash check excludes the field being saved, so re-saving a mapping works', async () => {
  const { calls } = await run(
    setConnectorFieldMapping,
    req({ params: { field: 'volume' }, body: { targetId: `column:${COL_NUMBER}` } })
  );
  assert.deepEqual(calls.clashFilters[0].sourceField, { $ne: 'volume' });
  // Scoped to the BOARD, not to (board, provider): the column belongs to the
  // board, so two connectors fighting over it is the same bug as one connector
  // fighting with itself.
  assert.equal(calls.clashFilters[0].board, BOARD);
  assert.equal('provider' in calls.clashFilters[0], false);
});

test('a duplicate-key race answers 409 rather than 500', async () => {
  const err = new Error('E11000 duplicate key');
  err.code = 11000;
  const { res } = await run(
    setConnectorFieldMapping,
    req({ params: { field: 'rank' }, body: { targetId: `column:${COL_NUMBER}` } }),
    { upsertError: err }
  );
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'TARGET_TAKEN');
});

test('autoFill is stored when given and left to the model default when not', async () => {
  const withFlag = await run(
    setConnectorFieldMapping,
    req({
      params: { field: 'rank' },
      body: { targetId: 'builtin:config.target', autoFill: false },
    })
  );
  assert.equal(withFlag.calls.upserts[0].update.$set.autoFill, false);
  assert.equal(withFlag.res.body.mapping.autoFill, false);

  const without = await run(
    setConnectorFieldMapping,
    req({ params: { field: 'rank' }, body: { targetId: 'builtin:actual' } })
  );
  assert.equal('autoFill' in without.calls.upserts[0].update.$set, false);
});

// ---------------------------------------------------------------------------
// Removing a mapping
// ---------------------------------------------------------------------------

test('unbinding removes only the wiring, scoped to this board and provider', async () => {
  const { res, calls } = await run(
    deleteConnectorFieldMapping,
    req({ params: { field: 'volume' } })
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls.deletes[0], {
    board: BOARD,
    provider: 'ubersuggest',
    sourceField: 'volume',
  });
});

test('unbinding something already unbound is a success, not a 404', async () => {
  // Idempotent: it is the outcome the caller asked for.
  const { res } = await run(
    deleteConnectorFieldMapping,
    req({ params: { field: 'never_mapped' } })
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
});

// ---------------------------------------------------------------------------
// The public shape
// ---------------------------------------------------------------------------

test('publicMapping is hand-built, so an added field cannot leak by default', () => {
  const out = publicMapping({
    _id: '6a466b99ea3ab35ff1378f01',
    board: BOARD,
    organisation: ORG,
    provider: 'ubersuggest',
    sourceField: 'volume',
    target: { kind: 'goalColumn', columnId: COL_NUMBER, builtin: null },
    autoFill: true,
    createdBy: OWNER,
    updatedBy: MEMBER,
    secretFutureField: 'must not appear',
  });
  const json = JSON.stringify(out);
  assert.ok(!json.includes('must not appear'));
  assert.ok(!json.includes(OWNER));
  assert.equal(out.targetId, `column:${COL_NUMBER}`);
});

test('publicMapping survives a builtin target', () => {
  const out = publicMapping({
    _id: '6a466b99ea3ab35ff1378f02',
    provider: 'ubersuggest',
    sourceField: 'rank',
    target: { kind: 'goalBuiltin', columnId: null, builtin: 'actual' },
    autoFill: false,
  });
  assert.equal(out.targetId, 'builtin:actual');
  assert.equal(out.target.columnId, null);
  assert.equal(out.autoFill, false);
});
