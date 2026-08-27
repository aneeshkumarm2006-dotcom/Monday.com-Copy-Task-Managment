const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.CONNECTOR_MASTER_KEY_V1 = crypto.randomBytes(32).toString('base64');

const Board = require('../models/Board');
const Organisation = require('../models/Organisation');
const Goal = require('../models/Goal');
const GoalConnectorLink = require('../models/GoalConnectorLink');
const ConnectorProject = require('../models/ConnectorProject');
const ConnectorSnapshot = require('../models/ConnectorSnapshot');
const ConnectorFieldMapping = require('../models/ConnectorFieldMapping');
const { SYSTEM_ROLES, sanitizePermissions } = require('../utils/capabilities');

const {
  getGoalLinks,
  getGoalLinkMatches,
  setGoalLink,
  bulkSetGoalLinks,
  clearGoalLink,
  acceptGoalSuggestions,
  runBoardWriteback,
  publicLink,
} = require('./connectorLinkController');

/**
 * The goal-link handlers, exercised through their real authorization gate.
 *
 * Only the model lookups are stubbed. `loadBoardContext` and `resolveAccess` run
 * for real against document-shaped fixtures, so these cover the thing that
 * actually decides who may point a goal at a keyword and who may accept a value
 * into a cell: the two-layer AND of org role and board level, the tracker-board
 * check on top of it, and — the part unique to this file — the PER-FIELD check
 * on accept, where filling a result and rewriting a promise are two different
 * permissions on the same request.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OWNER = '6c466b99ea3ab35ff1378d01';
const MEMBER = '6c466b99ea3ab35ff1378d02';
const VIEWER = '6c466b99ea3ab35ff1378d03';
const ORG = '6c466b99ea3ab35ff1378d10';
const BOARD = '6c466b99ea3ab35ff1378d20';
const GROUP = '6c466b99ea3ab35ff1378d30';
const GOAL = '6c466b99ea3ab35ff1378d40';
const GOAL_2 = '6c466b99ea3ab35ff1378d41';
const PROJECT = '6c466b99ea3ab35ff1378d50';
const LINK = '6c466b99ea3ab35ff1378d60';

const COL_VOLUME = '6c466b99ea3ab35ff1378e01';

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
  monthTimezone: 'UTC',
  goalColumns: [
    { _id: COL_VOLUME, name: 'Volume', key: 'volume', type: 'number', order: 0 },
  ],
  ...overrides,
});

const makeGoalDoc = (overrides = {}) => {
  const doc = {
    _id: GOAL,
    board: BOARD,
    organisation: ORG,
    group: GROUP,
    monthKey: '2026-08',
    type: 'numeric',
    actual: null,
    actualDayKey: null,
    config: {},
    columnValues: new Map(),
    saved: 0,
    markModified: () => {},
    ...overrides,
  };
  doc.save = async () => {
    doc.saved += 1;
    return doc;
  };
  return doc;
};

const makeLinkDoc = (overrides = {}) => {
  const doc = {
    _id: LINK,
    goal: GOAL,
    board: BOARD,
    organisation: ORG,
    group: GROUP,
    monthKey: '2026-08',
    provider: 'ubersuggest',
    project: PROJECT,
    keyword: 'best crm for agencies',
    variant: null,
    autoFill: true,
    claimedAt: null,
    applied: new Map(),
    suggested: new Map(),
    saved: 0,
    markModified: () => {},
    ...overrides,
  };
  doc.save = async () => {
    doc.saved += 1;
    return doc;
  };
  return doc;
};

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** A thenable answering `.sort().select().limit().lean()` in any order. */
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
  params: { boardId: BOARD, ...(overrides.params || {}) },
  query: overrides.query || {},
  body: overrides.body || {},
  user: { userId: overrides.userId || OWNER },
});

const stubModels = ({
  board = makeBoard(),
  org = makeOrg(),
  goal = makeGoalDoc(),
  goals = null,
  link = null,
  links = [],
  project = { _id: PROJECT, group: GROUP, provider: 'ubersuggest', name: 'Acme', domain: 'acme.com' },
  projects = null,
  snapshots = [],
  mappings = [],
  upsertError = null,
} = {}) => {
  const originals = {
    boardFindById: Board.findById,
    orgFindById: Organisation.findById,
    goalFindById: Goal.findById,
    goalFind: Goal.find,
    linkFind: GoalConnectorLink.find,
    linkFindOne: GoalConnectorLink.findOne,
    linkUpsert: GoalConnectorLink.findOneAndUpdate,
    linkDelete: GoalConnectorLink.deleteOne,
    projFind: ConnectorProject.find,
    projFindOne: ConnectorProject.findOne,
    projDistinct: ConnectorProject.distinct,
    snapFind: ConnectorSnapshot.find,
    mapFind: ConnectorFieldMapping.find,
  };

  const calls = { upserts: [], deletes: [] };

  Board.findById = () => Promise.resolve(board);
  Organisation.findById = () => Promise.resolve(org);
  Goal.findById = () => Promise.resolve(goal);
  Goal.find = () => chain(goals || (goal ? [goal] : []));
  GoalConnectorLink.find = () => chain(links);
  GoalConnectorLink.findOne = () => chain(link);
  GoalConnectorLink.findOneAndUpdate = (filter, update) => {
    calls.upserts.push({ filter, update });
    if (upsertError) return chain(Promise.reject(upsertError));
    const set = update.$set || {};
    return chain({ _id: LINK, goal: GOAL, applied: {}, suggested: {}, ...set });
  };
  GoalConnectorLink.deleteOne = (filter) => {
    calls.deletes.push(filter);
    return Promise.resolve({ deletedCount: 1 });
  };
  ConnectorProject.find = () => chain(projects || (project ? [project] : []));
  ConnectorProject.findOne = () => chain(project);
  ConnectorProject.distinct = () => Promise.resolve([BOARD]);
  ConnectorSnapshot.find = () => chain(snapshots);
  ConnectorFieldMapping.find = () => chain(mappings);

  const restore = () => {
    Board.findById = originals.boardFindById;
    Organisation.findById = originals.orgFindById;
    Goal.findById = originals.goalFindById;
    Goal.find = originals.goalFind;
    GoalConnectorLink.find = originals.linkFind;
    GoalConnectorLink.findOne = originals.linkFindOne;
    GoalConnectorLink.findOneAndUpdate = originals.linkUpsert;
    GoalConnectorLink.deleteOne = originals.linkDelete;
    ConnectorProject.find = originals.projFind;
    ConnectorProject.findOne = originals.projFindOne;
    ConnectorProject.distinct = originals.projDistinct;
    ConnectorSnapshot.find = originals.snapFind;
    ConnectorFieldMapping.find = originals.mapFind;
  };

  return { restore, calls };
};

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

test('a standard board 404s rather than 403s — goals do not exist there', async () => {
  const { res } = await run(getGoalLinks, req(), {
    board: makeBoard({ boardType: 'standard' }),
  });
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.code, 'NOT_TRACKER_BOARD');
});

test('a viewer may READ links but not link a goal', async () => {
  const read = await run(getGoalLinks, req({ userId: VIEWER }));
  assert.equal(read.res.statusCode, 200);
  assert.equal(read.res.body.canManage, false);

  const write = await run(
    setGoalLink,
    req({ userId: VIEWER, params: { id: GOAL }, body: { provider: 'ubersuggest' } })
  );
  assert.equal(write.res.statusCode, 403);
});

test('an ordinary member holds connector.manage and may link', async () => {
  const { res } = await run(
    setGoalLink,
    req({
      userId: MEMBER,
      params: { id: GOAL },
      body: { provider: 'ubersuggest', keyword: 'best crm for agencies' },
    })
  );
  assert.equal(res.statusCode, 200);
});

// ---------------------------------------------------------------------------
// setGoalLink
// ---------------------------------------------------------------------------

test('linking refuses a provider that does not exist', async () => {
  const { res } = await run(
    setGoalLink,
    req({ params: { id: GOAL }, body: { provider: 'semrush' } })
  );
  assert.equal(res.statusCode, 400);
});

test('linking refuses a group with no project mapped, and says what to do', async () => {
  const { res } = await run(
    setGoalLink,
    req({ params: { id: GOAL }, body: { provider: 'ubersuggest' } }),
    { project: null }
  );
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'NO_PROJECT');
  assert.match(res.body.error, /Add-ons/);
});

test('a link with NO keyword is a real link — it binds the goal to the project', async () => {
  const { res, calls } = await run(
    setGoalLink,
    req({ params: { id: GOAL }, body: { provider: 'ubersuggest' } })
  );
  assert.equal(res.statusCode, 200);
  assert.equal(calls.upserts[0].update.$set.keyword, null);
  assert.equal(String(calls.upserts[0].update.$set.project), PROJECT);
});

test('the keyword is trimmed and the variant carried, and the upsert is keyed on the GOAL', async () => {
  const { res, calls } = await run(
    setGoalLink,
    req({
      params: { id: GOAL },
      body: {
        provider: 'ubersuggest',
        keyword: '  best crm for agencies  ',
        variant: 'desktop|en|2840',
        autoFill: false,
      },
    })
  );
  assert.equal(res.statusCode, 200);
  const { filter, update } = calls.upserts[0];
  // One link per goal — re-pointing REPLACES rather than adding a second.
  assert.deepEqual(Object.keys(filter), ['goal']);
  assert.equal(update.$set.keyword, 'best crm for agencies');
  assert.equal(update.$set.variant, 'desktop|en|2840');
  assert.equal(update.$set.autoFill, false);
  // The month comes from the GOAL, never from the caller.
  assert.equal(update.$set.monthKey, '2026-08');
});

test('re-linking never clears claimedAt', async () => {
  const { calls } = await run(
    setGoalLink,
    req({ params: { id: GOAL }, body: { provider: 'ubersuggest', keyword: 'x' } })
  );
  const { $set, $setOnInsert } = calls.upserts[0].update;
  // Otherwise re-linking would be a way to make the connector overwrite cells a
  // human corrected after the first sync, one goal at a time, with nothing on
  // screen to say so.
  assert.equal('claimedAt' in $set, false);
  assert.equal('claimedAt' in ($setOnInsert || {}), false);
});

test('unlinking is idempotent and touches no value', async () => {
  const { res, calls } = await run(clearGoalLink, req({ params: { id: GOAL } }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.deepEqual(calls.deletes[0], { goal: GOAL });
});

// ---------------------------------------------------------------------------
// acceptGoalSuggestions — the per-field capability check
// ---------------------------------------------------------------------------

const suggestedLink = () =>
  makeLinkDoc({
    suggested: new Map([
      ['volume', { value: 1400, targetId: `column:${COL_VOLUME}`, at: new Date() }],
      ['rank_previous', { value: 18, targetId: 'builtin:config.baseline', at: new Date() }],
    ]),
  });

test('accepting writes the value, moves it to applied, and clears the suggestion', async () => {
  const goal = makeGoalDoc();
  const link = suggestedLink();
  const { res } = await run(
    acceptGoalSuggestions,
    req({ params: { id: GOAL }, body: { fields: ['volume'] } }),
    { goal, link }
  );

  assert.equal(res.statusCode, 200);
  assert.equal(goal.columnValues.get(COL_VOLUME), 1400);
  assert.equal(link.applied.get('volume').value, 1400);
  assert.equal(link.suggested.has('volume'), false);
  assert.equal(goal.saved, 1);
  assert.equal(link.saved, 1);
});

test('accepting does NOT stamp claimedAt', async () => {
  const link = suggestedLink();
  await run(
    acceptGoalSuggestions,
    req({ params: { id: GOAL }, body: { fields: ['volume'] } }),
    { goal: makeGoalDoc(), link }
  );
  // Stamping it here would quietly cancel the first-sync claim for every other
  // field on the row.
  assert.equal(link.claimedAt, null);
});

test('a contributor may accept a RESULT and is refused the PROMISE, in the same request', async () => {
  const goal = makeGoalDoc();
  const link = suggestedLink();
  // `contribute` carries `goal.track` and stops short of `goal.manage` — the
  // exact rung this per-field check exists for. See BOARD_LEVEL_PRESETS.
  const { res } = await run(
    acceptGoalSuggestions,
    req({ userId: MEMBER, params: { id: GOAL } }),
    { goal, link, board: makeBoard({ publicDefaultLevel: 'contribute' }) }
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.accepted.map((a) => a.field), ['volume']);
  assert.deepEqual(res.body.refused.map((r) => r.field), ['rank_previous']);
  assert.match(res.body.refused[0].reason, /manage goals/);
  // Refusing five acceptable values because a sixth needed a higher rung would
  // be a worse answer than doing the five.
  assert.equal(goal.columnValues.get(COL_VOLUME), 1400);
  assert.equal(goal.config.baseline, undefined);
  assert.equal(link.suggested.has('rank_previous'), true);
});

test('an owner may accept the promise too', async () => {
  const goal = makeGoalDoc();
  const { res } = await run(
    acceptGoalSuggestions,
    req({ userId: OWNER, params: { id: GOAL } }),
    { goal, link: suggestedLink() }
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.refused.length, 0);
  assert.equal(goal.config.baseline, 18);
});

test('a suggestion whose column was purged is dropped, not offered forever', async () => {
  const link = makeLinkDoc({
    suggested: new Map([
      ['volume', { value: 1400, targetId: 'column:6c466b99ea3ab35ff1378eff', at: new Date() }],
    ]),
  });
  const { res } = await run(
    acceptGoalSuggestions,
    req({ params: { id: GOAL } }),
    { goal: makeGoalDoc(), link }
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.accepted.length, 0);
  assert.match(res.body.refused[0].reason, /no longer on this board/);
  assert.equal(link.suggested.has('volume'), false);
});

test('a viewer cannot accept anything', async () => {
  const { res } = await run(
    acceptGoalSuggestions,
    req({ userId: VIEWER, params: { id: GOAL } }),
    { link: suggestedLink() }
  );
  assert.equal(res.statusCode, 403);
});

test('accepting on an unlinked goal is a 404, not a silent success', async () => {
  const { res } = await run(
    acceptGoalSuggestions,
    req({ params: { id: GOAL } }),
    { link: null }
  );
  assert.equal(res.statusCode, 404);
});

test('accepting with nothing outstanding says so rather than reporting work done', async () => {
  const { res } = await run(
    acceptGoalSuggestions,
    req({ params: { id: GOAL } }),
    { link: makeLinkDoc() }
  );
  assert.equal(res.statusCode, 409);
});

// ---------------------------------------------------------------------------
// getGoalLinks
// ---------------------------------------------------------------------------

test('the read names the field and the column a suggestion belongs to', async () => {
  const { res } = await run(getGoalLinks, req({ query: { month: '2026-08' } }), {
    links: [
      {
        _id: LINK,
        goal: GOAL,
        group: GROUP,
        monthKey: '2026-08',
        provider: 'ubersuggest',
        project: PROJECT,
        keyword: 'best crm for agencies',
        applied: {},
        suggested: { volume: { value: 1400, targetId: `column:${COL_VOLUME}` } },
      },
    ],
    mappings: [
      {
        provider: 'ubersuggest',
        sourceField: 'volume',
        target: { kind: 'goalColumn', columnId: COL_VOLUME, builtin: null },
        autoFill: true,
      },
    ],
  });

  assert.equal(res.statusCode, 200);
  const suggestion = res.body.links[0].suggested.volume;
  // Resolved server-side: the client would otherwise have to hold the provider's
  // catalog and the board's target list and join them itself.
  assert.equal(suggestion.fieldLabel, 'Search volume');
  assert.equal(suggestion.targetLabel, 'Volume');
});

test('the read says which fields are mapped, so a link can promise what it will fill', async () => {
  const { res } = await run(getGoalLinks, req(), {
    mappings: [
      {
        provider: 'ubersuggest',
        sourceField: 'rank',
        target: { kind: 'goalBuiltin', columnId: null, builtin: 'actual' },
        autoFill: true,
      },
    ],
  });
  assert.deepEqual(res.body.mappedFields, [
    {
      provider: 'ubersuggest',
      key: 'rank',
      label: 'Current rank',
      scope: 'keyword',
      kind: 'positions',
      autoFill: true,
      targetId: 'builtin:actual',
      targetLabel: 'Result',
      targetCapability: 'goal.track',
      targetArchived: false,
    },
  ]);
});

test('the keyword picker reads a stored snapshot and spends nothing', async () => {
  const { res } = await run(getGoalLinks, req(), {
    snapshots: [
      {
        project: PROJECT,
        variant: 'desktop|en|2840',
        periodKey: '2026-08-14',
        data: {
          keywords: [
            { keyword: 'best crm for agencies' },
            { keyword: 'agency crm' },
            { keyword: 'best crm for agencies' },
          ],
        },
      },
    ],
  });

  const source = res.body.sources[0];
  assert.equal(source.group, GROUP);
  assert.equal(source.collectedOn, '2026-08-14');
  // De-duplicated and sorted, so the picker is stable between loads.
  assert.deepEqual(source.keywords, ['agency crm', 'best crm for agencies']);
  assert.deepEqual(source.variants, ['desktop|en|2840']);
});

test('an unknown provider on the read is a 400, not an empty answer', async () => {
  const { res } = await run(getGoalLinks, req({ query: { provider: 'semrush' } }));
  assert.equal(res.statusCode, 400);
});

// ---------------------------------------------------------------------------
// runBoardWriteback
// ---------------------------------------------------------------------------

test('the writeback endpoint needs connector.manage', async () => {
  const { res } = await run(
    runBoardWriteback,
    req({ userId: VIEWER, params: { boardId: BOARD, provider: 'ubersuggest' } })
  );
  assert.equal(res.statusCode, 403);
});

test('the writeback endpoint reports a month with no links rather than failing', async () => {
  const { res } = await run(
    runBoardWriteback,
    req({ params: { boardId: BOARD, provider: 'ubersuggest' }, body: { month: '2026-08' } }),
    { links: [] }
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.report.monthKey, '2026-08');
  assert.equal(res.body.report.linked, 0);
});

// ---------------------------------------------------------------------------
// publicLink
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// getGoalLinkMatches — proposes, and cannot write
// ---------------------------------------------------------------------------

/** A `positions` snapshot carrying the phrases a project actually tracks. */
const positionsSnapshot = (keywords) => [
  {
    project: PROJECT,
    variant: 'desktop|en|1',
    periodKey: '2026-08-27',
    data: { keywords },
  },
];

const leanGoal = (id, name, overrides = {}) => ({
  _id: id,
  name,
  group: GROUP,
  monthKey: '2026-08',
  type: 'numeric',
  ...overrides,
});

test('a match is proposed by EXACT name, and carries the rank it would fill', async () => {
  const { res, calls } = await run(getGoalLinkMatches, req({ query: { month: '2026-08' } }), {
    goals: [leanGoal(GOAL, 'thca quarter pound')],
    snapshots: positionsSnapshot([
      { keyword: 'thca quarter pound', position: 12, previousPosition: 19 },
      { keyword: 'unrelated phrase', position: 3, previousPosition: 3 },
    ]),
  });

  assert.equal(res.statusCode, 200);
  const [group] = res.body.groups;
  assert.equal(group.proposals.length, 1);
  assert.deepEqual(
    { keyword: group.proposals[0].keyword, position: group.proposals[0].position },
    { keyword: 'thca quarter pound', position: 12 }
  );
  assert.equal(group.unmatched.length, 0);
  // The whole safety property of this endpoint: it proposes and cannot write.
  assert.equal(calls.upserts.length, 0);
});

test('matching ignores case and repeated spaces — and NOTHING else', async () => {
  const { res } = await run(getGoalLinkMatches, req(), {
    goals: [
      leanGoal(GOAL, '  THCA   Quarter Pound '),
      // The near miss that matters. A matcher clever enough to join a singular
      // to its plural puts one keyword's rank on the other's row, and both are
      // real phrases that rank differently.
      leanGoal(GOAL_2, 'thca pound'),
    ],
    snapshots: positionsSnapshot([
      { keyword: 'thca quarter pound', position: 12, previousPosition: null },
      { keyword: 'thca pounds', position: 15, previousPosition: null },
    ]),
  });

  const [group] = res.body.groups;
  assert.deepEqual(
    group.proposals.map((p) => [p.goal, p.keyword]),
    [[GOAL, 'thca quarter pound']]
  );
  assert.deepEqual(
    group.unmatched.map((u) => [u.goal, u.reason]),
    [[GOAL_2, 'no-match']]
  );
});

test('a goal matching TWO tracked keywords is ambiguous, never resolved for you', async () => {
  const { res } = await run(getGoalLinkMatches, req(), {
    goals: [leanGoal(GOAL, 'thca pound')],
    snapshots: positionsSnapshot([
      { keyword: 'thca pound', position: 17, previousPosition: null },
      { keyword: 'THCA  POUND', position: 4, previousPosition: null },
    ]),
  });

  const [group] = res.body.groups;
  assert.equal(group.proposals.length, 0);
  assert.equal(group.unmatched[0].reason, 'ambiguous');
});

test('a goal already pointed at that exact keyword is flagged, not offered as new', async () => {
  const { res } = await run(getGoalLinkMatches, req(), {
    goals: [leanGoal(GOAL, 'thca pound')],
    links: [{ goal: GOAL, provider: 'ubersuggest', keyword: 'thca pound' }],
    snapshots: positionsSnapshot([
      { keyword: 'thca pound', position: 17, previousPosition: null },
    ]),
  });

  const [proposal] = res.body.groups[0].proposals;
  assert.equal(proposal.alreadyLinked, true);
  assert.equal(proposal.relinkFrom, null);
});

test('a goal pointed SOMEWHERE ELSE says so, so taking the match is a deliberate act', async () => {
  const { res } = await run(getGoalLinkMatches, req(), {
    goals: [leanGoal(GOAL, 'thca pound')],
    links: [{ goal: GOAL, provider: 'ubersuggest', keyword: 'thca pounds' }],
    snapshots: positionsSnapshot([
      { keyword: 'thca pound', position: 17, previousPosition: null },
    ]),
  });

  const [proposal] = res.body.groups[0].proposals;
  assert.equal(proposal.alreadyLinked, false);
  assert.equal(proposal.relinkFrom, 'thca pounds');
});

test('the proposal says what a link would FILL, so nobody links a month into nothing', async () => {
  const { res } = await run(getGoalLinkMatches, req(), {
    goals: [leanGoal(GOAL, 'thca pound')],
    snapshots: positionsSnapshot([{ keyword: 'thca pound', position: 17 }]),
    mappings: [
      {
        provider: 'ubersuggest',
        sourceField: 'rank',
        target: { kind: 'goalBuiltin', columnId: null, builtin: 'actual' },
        autoFill: true,
      },
    ],
  });

  assert.deepEqual(
    res.body.mappedFields.map((f) => [f.key, f.scope, f.targetLabel]),
    [['rank', 'keyword', 'Result']]
  );
});

test('proposing is connector.manage — a viewer who may READ links cannot ask for it', async () => {
  const { res } = await run(getGoalLinkMatches, req({ userId: VIEWER }));
  assert.equal(res.statusCode, 403);
});

// ---------------------------------------------------------------------------
// bulkSetGoalLinks — writes explicit pairs, and does no matching
// ---------------------------------------------------------------------------

test('the bulk write stores exactly the pairs it is handed, keyed on each GOAL', async () => {
  const { res, calls } = await run(
    bulkSetGoalLinks,
    req({
      params: { provider: 'ubersuggest' },
      body: {
        links: [
          { goal: GOAL, keyword: '  thca pound  ' },
          { goal: GOAL_2, keyword: 'thca pounds' },
        ],
      },
    }),
    { goals: [leanGoal(GOAL, 'thca pound'), leanGoal(GOAL_2, 'thca pounds')] }
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.linked.length, 2);
  assert.deepEqual(
    calls.upserts.map((u) => [String(u.filter.goal), u.update.$set.keyword]),
    [[GOAL, 'thca pound'], [GOAL_2, 'thca pounds']]
  );
  // Re-pointing a link must never hand the connector permission to overwrite a
  // cell a human corrected after the first sync.
  assert.ok(calls.upserts.every((u) => !('claimedAt' in u.update.$set)));
});

test('one stale row is skipped with a sentence; the rest are still linked', async () => {
  const { res, calls } = await run(
    bulkSetGoalLinks,
    req({
      params: { provider: 'ubersuggest' },
      body: {
        links: [
          { goal: GOAL, keyword: 'thca pound' },
          // Deleted, or on another board — either way `Goal.find` does not
          // return it, and refusing the good pair over it would be worse.
          { goal: GOAL_2, keyword: 'thca pounds' },
          { goal: 'not-an-id', keyword: 'x' },
        ],
      },
    }),
    { goals: [leanGoal(GOAL, 'thca pound')] }
  );

  assert.equal(res.body.linked.length, 1);
  assert.equal(calls.upserts.length, 1);
  assert.deepEqual(
    res.body.skipped.map((sk) => sk.goal).sort(),
    [GOAL_2, 'not-an-id'].sort()
  );
});

test('a goal whose group lost its project is skipped, not linked to nothing', async () => {
  const { res, calls } = await run(
    bulkSetGoalLinks,
    req({
      params: { provider: 'ubersuggest' },
      body: { links: [{ goal: GOAL, keyword: 'thca pound' }] },
    }),
    { goals: [leanGoal(GOAL, 'thca pound')], projects: [] }
  );

  assert.equal(res.body.linked.length, 0);
  assert.equal(calls.upserts.length, 0);
  assert.match(res.body.skipped[0].reason, /not mapped to a project/);
});

test('the bulk write refuses a batch bigger than one month of goals', async () => {
  const { res } = await run(
    bulkSetGoalLinks,
    req({
      params: { provider: 'ubersuggest' },
      body: { links: Array.from({ length: 301 }, () => ({ goal: GOAL, keyword: 'k' })) },
    })
  );
  assert.equal(res.statusCode, 400);
});

test('the bulk write is connector.manage, the same rung as linking one goal', async () => {
  const { res } = await run(
    bulkSetGoalLinks,
    req({
      userId: VIEWER,
      params: { provider: 'ubersuggest' },
      body: { links: [{ goal: GOAL, keyword: 'thca pound' }] },
    })
  );
  assert.equal(res.statusCode, 403);
});

test('publicLink is hand-built, so a field added to the model cannot leak', () => {
  const shaped = publicLink({
    _id: LINK,
    goal: GOAL,
    group: GROUP,
    monthKey: '2026-08',
    provider: 'ubersuggest',
    project: PROJECT,
    keyword: 'x',
    variant: null,
    autoFill: true,
    claimedAt: null,
    lastSyncAt: null,
    lastNote: '',
    applied: {},
    suggested: {},
    aSecretAddedLater: 'nope',
  });
  assert.equal('aSecretAddedLater' in shaped, false);
  assert.deepEqual(Object.keys(shaped).sort(), [
    '_id', 'applied', 'autoFill', 'claimedAt', 'goal', 'group', 'keyword',
    'lastNote', 'lastSyncAt', 'monthKey', 'project', 'provider', 'suggested',
    'variant',
  ]);
});
