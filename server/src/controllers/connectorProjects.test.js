const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.CONNECTOR_MASTER_KEY_V1 = crypto.randomBytes(32).toString('base64');

const Board = require('../models/Board');
const Organisation = require('../models/Organisation');
const TaskGroup = require('../models/TaskGroup');
const ConnectorAccount = require('../models/ConnectorAccount');
const ConnectorProject = require('../models/ConnectorProject');
const { SYSTEM_ROLES, sanitizePermissions } = require('../utils/capabilities');

const {
  getBoardConnectorProjects,
  setConnectorProjectGroup,
} = require('./connectorController');

/**
 * The board-plane handlers, exercised through their real authorization gate.
 *
 * Only the model lookups are stubbed. `loadBoardContext` and `resolveAccess`
 * run for real against document-shaped fixtures, so these tests cover the thing
 * that actually decides who may map a project: the two-layer AND of org role and
 * board level, and the tracker-board check on top of it.
 *
 * The mapping rules are the other half. Binding a project decides WHOSE numbers
 * land on WHOSE row from phase 5 onward, so "the group must be on this board"
 * and "a group holds one project" are correctness properties, not niceties.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OWNER = '6a466b99ea3ab35ff1378d01';
const MEMBER = '6a466b99ea3ab35ff1378d02';
const VIEWER = '6a466b99ea3ab35ff1378d03';
const ORG = '6a466b99ea3ab35ff1378d10';
const BOARD = '6a466b99ea3ab35ff1378d20';
const OTHER_BOARD = '6a466b99ea3ab35ff1378d21';
const GROUP = '6a466b99ea3ab35ff1378d30';
const FOREIGN_GROUP = '6a466b99ea3ab35ff1378d31';
const PROJECT = '6a466b99ea3ab35ff1378d40';
const OTHER_PROJECT = '6a466b99ea3ab35ff1378d41';

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
  // loadBoardContext lazily heals an org with no roles. Ours has them.
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
 * Install stubs for one test and hand back a restore function. Mongoose statics
 * are replaced directly, which is enough — the handlers call them by name on the
 * imported model.
 */
const stubModels = ({
  board = makeBoard(),
  org = makeOrg(),
  projects = [],
  accounts = [],
  group = { _id: GROUP, board: BOARD, name: 'Acme' },
  conflictingProject = null,
  projectDoc = null,
} = {}) => {
  const originals = {
    boardFindById: Board.findById,
    orgFindById: Organisation.findById,
    groupFindById: TaskGroup.findById,
    projectFind: ConnectorProject.find,
    projectFindOne: ConnectorProject.findOne,
    accountFind: ConnectorAccount.find,
  };

  Board.findById = () => Promise.resolve(board);
  Organisation.findById = () => Promise.resolve(org);
  TaskGroup.findById = () => chain(group);
  ConnectorProject.find = () => chain(projects);
  ConnectorAccount.find = () => chain(accounts);
  // Two different call shapes share this static: the handler fetches the project
  // as a DOCUMENT (no chain, it gets saved), then looks for a conflict with
  // `.select().lean()`. `_id` in the filter tells them apart.
  ConnectorProject.findOne = (filter) =>
    filter && filter._id && !filter._id.$ne
      ? Promise.resolve(projectDoc)
      : chain(conflictingProject);

  return () => {
    Board.findById = originals.boardFindById;
    Organisation.findById = originals.orgFindById;
    TaskGroup.findById = originals.groupFindById;
    ConnectorProject.find = originals.projectFind;
    ConnectorProject.findOne = originals.projectFindOne;
    ConnectorAccount.find = originals.accountFind;
  };
};

/** A stand-in for a loaded ConnectorProject document. */
const makeProjectDoc = (overrides = {}) => {
  const doc = {
    _id: PROJECT,
    account: '6a466b99ea3ab35ff1378d50',
    organisation: ORG,
    provider: 'ubersuggest',
    externalId: '5512',
    name: 'Acme',
    domain: 'acme.com',
    group: null,
    board: null,
    boundBy: null,
    boundAt: null,
    saved: 0,
    ...overrides,
  };
  doc.save = async () => {
    doc.saved += 1;
    if (doc.saveError) throw doc.saveError;
  };
  return doc;
};

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

test('a standard board has no connectors to be refused access to', async () => {
  // 404 rather than 403, matching goalController: on a board where the feature
  // does not exist, "denied" would imply there is something there.
  const restore = stubModels({ board: makeBoard({ boardType: 'standard' }) });
  const res = fakeRes();
  await getBoardConnectorProjects(req(), res);
  restore();

  assert.equal(res.statusCode, 404);
  assert.equal(res.body.code, 'NOT_TRACKER_BOARD');
});

test('a viewer can READ the project list but is told they cannot manage it', async () => {
  // connector.view sits on the bottom rung: nothing this endpoint returns costs
  // anything, so anyone who can read the board can read what has been pulled.
  const restore = stubModels({
    board: makeBoard({ visibility: 'public', publicDefaultLevel: 'view' }),
    projects: [{ _id: PROJECT, provider: 'ubersuggest', externalId: '1', name: 'A' }],
  });
  const res = fakeRes();
  await getBoardConnectorProjects(req({ userId: VIEWER }), res);
  restore();

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.projects.length, 1);
  assert.equal(res.body.canManage, false);
});

test('a viewer cannot map a project', async () => {
  const restore = stubModels({
    board: makeBoard({ visibility: 'public', publicDefaultLevel: 'view' }),
    projectDoc: makeProjectDoc(),
  });
  const res = fakeRes();
  await setConnectorProjectGroup(
    req({ userId: VIEWER, params: { projectId: PROJECT }, body: { group: GROUP } }),
    res
  );
  restore();

  assert.equal(res.statusCode, 403);
});

test('an unknown provider is a 400, not a crash', async () => {
  const restore = stubModels();
  const res = fakeRes();
  await getBoardConnectorProjects(req({ params: { provider: 'semrush' } }), res);
  restore();

  assert.equal(res.statusCode, 400);
});

// ---------------------------------------------------------------------------
// The raw payload
// ---------------------------------------------------------------------------

test('the raw provider payload is withheld unless explicitly requested', async () => {
  const stored = {
    _id: PROJECT,
    provider: 'ubersuggest',
    externalId: '1',
    name: 'A',
    raw: { undocumented: true },
  };

  let restore = stubModels({ projects: [stored] });
  const plain = fakeRes();
  await getBoardConnectorProjects(req(), plain);
  restore();
  assert.equal('raw' in plain.body.projects[0], false);

  restore = stubModels({ projects: [stored] });
  const withRaw = fakeRes();
  await getBoardConnectorProjects(req({ query: { includeRaw: '1' } }), withRaw);
  restore();
  assert.deepEqual(withRaw.body.projects[0].raw, { undocumented: true });
});

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

test('mapping a project records the group, the board and who did it', async () => {
  const doc = makeProjectDoc();
  const restore = stubModels({ projectDoc: doc });
  const res = fakeRes();
  await setConnectorProjectGroup(
    req({ params: { projectId: PROJECT }, body: { group: GROUP } }),
    res
  );
  restore();

  assert.equal(res.statusCode, 200);
  assert.equal(String(doc.group), GROUP);
  assert.equal(String(doc.board), BOARD);
  assert.equal(String(doc.boundBy), OWNER);
  assert.ok(doc.boundAt instanceof Date);
  assert.equal(doc.saved, 1);
});

test('a group on ANOTHER board is refused', async () => {
  // Without this a board editor could point a project at a group on a private
  // board they cannot open — and from phase 5 that binding decides whose numbers
  // land on whose row.
  const doc = makeProjectDoc();
  const restore = stubModels({
    projectDoc: doc,
    group: { _id: FOREIGN_GROUP, board: OTHER_BOARD, name: 'Somewhere else' },
  });
  const res = fakeRes();
  await setConnectorProjectGroup(
    req({ params: { projectId: PROJECT }, body: { group: FOREIGN_GROUP } }),
    res
  );
  restore();

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /not on this board/);
  assert.equal(doc.saved, 0);
});

test('a group already mapped is a 409 that names the project holding it', async () => {
  const doc = makeProjectDoc();
  const restore = stubModels({
    projectDoc: doc,
    conflictingProject: { _id: OTHER_PROJECT, name: 'Rival', domain: 'rival.com' },
  });
  const res = fakeRes();
  await setConnectorProjectGroup(
    req({ params: { projectId: PROJECT }, body: { group: GROUP } }),
    res
  );
  restore();

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'GROUP_TAKEN');
  // The sentence has to say WHICH project, or the only way to resolve it is to
  // check every row by hand.
  assert.match(res.body.error, /Rival/);
  assert.equal(doc.saved, 0);
});

test('losing the race to the unique index is still a 409, not a 500', async () => {
  // Two admins mapping the same group at the same moment both pass the check
  // above. The index is the real authority, and its error has to be translated.
  const doc = makeProjectDoc();
  doc.saveError = Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
  const restore = stubModels({ projectDoc: doc });
  const res = fakeRes();
  await setConnectorProjectGroup(
    req({ params: { projectId: PROJECT }, body: { group: GROUP } }),
    res
  );
  restore();

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'GROUP_TAKEN');
});

test('unmapping clears the whole binding, not just the group', async () => {
  // A stale `board` or `boundBy` left behind would make the row look mapped to
  // the Add-ons tab's `boundElsewhere` check on some other board.
  const doc = makeProjectDoc({
    group: GROUP,
    board: BOARD,
    boundBy: OWNER,
    boundAt: new Date(),
  });
  const restore = stubModels({ projectDoc: doc });
  const res = fakeRes();
  await setConnectorProjectGroup(
    req({ params: { projectId: PROJECT }, body: { group: null } }),
    res
  );
  restore();

  assert.equal(res.statusCode, 200);
  assert.equal(doc.group, null);
  assert.equal(doc.board, null);
  assert.equal(doc.boundBy, null);
  assert.equal(doc.boundAt, null);
  assert.equal(doc.saved, 1);
});

test('a malformed group id is rejected before anything is loaded', async () => {
  const doc = makeProjectDoc();
  const restore = stubModels({ projectDoc: doc });
  const res = fakeRes();
  await setConnectorProjectGroup(
    req({ params: { projectId: PROJECT }, body: { group: 'not-an-id' } }),
    res
  );
  restore();

  assert.equal(res.statusCode, 400);
  assert.equal(doc.saved, 0);
});

test('a project from another organisation is not found, whatever its id', async () => {
  // The query is scoped by organisation, so a valid id from another workspace
  // reads as absent rather than as forbidden.
  const restore = stubModels({ projectDoc: null });
  const res = fakeRes();
  await setConnectorProjectGroup(
    req({ params: { projectId: PROJECT }, body: { group: GROUP } }),
    res
  );
  restore();

  assert.equal(res.statusCode, 404);
});
