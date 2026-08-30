const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.CONNECTOR_MASTER_KEY_V1 = crypto.randomBytes(32).toString('base64');

const ConnectorProject = require('../../models/ConnectorProject');
const ConnectorSnapshot = require('../../models/ConnectorSnapshot');
const BoardConnector = require('../../models/BoardConnector');
const {
  syncProject,
  writeSnapshot,
  planProjectWork,
  scheduleForProvider,
  askedInterval,
  isFresh,
} = require('./snapshotService');

/**
 * The five generic-engine changes a per-call-billed provider needs, driven by a
 * descriptor that is NOT Ubersuggest and is NOT registered.
 *
 * ---- Why the fixture is deliberately foreign --------------------------------
 *
 * `registrySeam.test.js` next door makes the argument in full: a seam exercised
 * only by the provider it was written for passes by construction and proves
 * nothing. Everything below is asserted against a fetcher that posts work and
 * collects it later — three variants, its own cadence per kind, and a `pending`
 * answer — because that is the shape the seams exist for, and none of them may
 * require the generic side to know which provider is speaking.
 *
 * ---- The five, and the bug each one prevents --------------------------------
 *
 *   `pending`         — an unfinished request has no `collectedAt`, so a snapshot
 *                       written for it claims TODAY as its period. Once per UTC
 *                       day the request stays open, forever, each one outranking
 *                       the real reading underneath it.
 *   `queued`          — a pass that did nothing but poll reports 0/0/0 and reads
 *                       as a dead connector.
 *   `existing`/`force`— the planner's freshness rule is a schedule's rule. A
 *                       provider that pays per call has a second, stricter one,
 *                       and it is the only party that knows what a call costs.
 *   per-kind cadence  — one cadence per descriptor forces every kind onto the
 *                       fastest one, which for a metered provider is the
 *                       difference between one charge a week and seven.
 *   `intervalHoursFor`— a cadence a BOARD asked for. The snapshot service must
 *                       not learn that boards exist.
 */

const HOUR = 3_600_000;
const NOW = new Date('2026-08-27T12:00:00Z');
const WEEKLY = 168;

const project = (overrides = {}) => ({
  _id: 'p1',
  externalId: 'site-1',
  name: 'Acme',
  domain: 'acme.com',
  organisation: 'org1',
  account: 'acc1',
  ...overrides,
});

/**
 * A task-posting provider's kinds. `census` is the expensive weekly one and
 * `movement` the cheap daily one — the split that makes a single cadence per
 * descriptor wrong.
 */
const KINDS = [
  { key: 'census', label: 'Census', subject: 'project', dependsOn: [], intervalHours: 168 },
  { key: 'movement', label: 'Movement', subject: 'project', dependsOn: [], intervalHours: 24 },
  // No `intervalHours` at all: falls back to the connector's own.
  { key: 'backlinks', label: 'Backlinks', subject: 'domain', dependsOn: [] },
];

const variantsFor = (kindKey) => ({
  variants: kindKey === 'census' ? [{ key: 'us|desktop' }, { key: 'uk|mobile' }] : [{ key: 'all' }],
  skipped: 0,
});

/** A thenable answering `.select().sort().limit().lean()` in any order. */
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

const stubDb = ({ existing = [], stored = null } = {}) => {
  const writes = [];
  const originals = {
    find: ConnectorSnapshot.find,
    findOne: ConnectorSnapshot.findOne,
    updateOne: ConnectorSnapshot.updateOne,
    projectUpdate: ConnectorProject.updateOne,
  };
  ConnectorSnapshot.find = () => chain(existing);
  ConnectorSnapshot.findOne = () => chain(stored);
  ConnectorSnapshot.updateOne = async (filter, update) => {
    writes.push({ filter, set: update.$set });
    return { acknowledged: true };
  };
  ConnectorProject.updateOne = async () => ({ acknowledged: true });

  return {
    writes,
    restore: () => {
      ConnectorSnapshot.find = originals.find;
      ConnectorSnapshot.findOne = originals.findOne;
      ConnectorSnapshot.updateOne = originals.updateOne;
      ConnectorProject.updateOne = originals.projectUpdate;
    },
  };
};

const ok = (data = { rows: 1 }) => ({
  data,
  raw: null,
  status: 'ok',
  note: '',
  collectedAt: new Date('2026-08-26T04:00:00Z'),
});

const fakeConnector = (script = {}) => {
  const calls = [];
  return {
    name: 'tasked',
    syncIntervalHours: WEEKLY,
    variantsFor,
    calls,
    fetch: async (kindKey, ctx) => {
      calls.push({
        kind: kindKey,
        variant: ctx.variant?.key,
        existing: ctx.existing,
        force: ctx.force,
      });
      const entry = script[kindKey];
      if (typeof entry === 'function') return entry(ctx);
      return entry || ok();
    },
  };
};

const run = (connector, overrides = {}) =>
  syncProject({
    session: { markNeedsReauth: async () => {} },
    connector,
    project: project(),
    kinds: KINDS,
    intervalHours: WEEKLY,
    now: NOW,
    ...overrides,
  });

const snapshotRow = (overrides = {}) => ({
  kind: 'census',
  variant: 'us|desktop',
  status: 'ok',
  fetchedAt: NOW,
  ...overrides,
});

const plan = (overrides = {}) =>
  planProjectWork({
    project: project(),
    kinds: KINDS,
    variantsFor,
    latest: new Map(),
    intervalHours: WEEKLY,
    now: NOW,
    ...overrides,
  });

// ---------------------------------------------------------------------------
// 1. The `pending` sentinel
// ---------------------------------------------------------------------------

test('a pending result writes NOTHING and claims no period', async () => {
  // The whole reason this exists. `periodKeyFrom` falls back to today for
  // anything with no `collectedAt`, so the alternative is a row under a
  // guessed key in a collection whose premise is that the key is authoritative.
  const db = stubDb();
  try {
    const out = await writeSnapshot({
      project: project(),
      provider: 'tasked',
      kind: KINDS[0],
      variant: { key: 'us|desktop' },
      result: { status: 'pending', data: null, note: 'queued at the provider' },
      now: NOW,
    });

    assert.deepEqual(out, { written: false, periodKey: null, pending: true });
    assert.equal(db.writes.length, 0);
  } finally {
    db.restore();
  }
});

test('the period is null rather than today — the two are not the same answer', async () => {
  const db = stubDb();
  try {
    const pending = await writeSnapshot({
      project: project(),
      provider: 'tasked',
      kind: KINDS[0],
      variant: { key: 'all' },
      result: { status: 'pending' },
      now: NOW,
    });
    const finished = await writeSnapshot({
      project: project(),
      provider: 'tasked',
      kind: KINDS[0],
      variant: { key: 'all' },
      result: { status: 'ok', data: {}, collectedAt: null },
      now: NOW,
    });

    // A finished reading with no `collectedAt` legitimately falls back to today.
    // An unfinished one must NOT reach that line, or the fallback mints a
    // plausible, wrong, authoritative-looking key.
    assert.equal(finished.periodKey, '2026-08-27');
    assert.equal(pending.periodKey, null);
  } finally {
    db.restore();
  }
});

test('ok and partial readings still report their period and are unchanged', async () => {
  const db = stubDb();
  try {
    const out = await writeSnapshot({
      project: project(),
      provider: 'tasked',
      kind: KINDS[0],
      variant: { key: 'all' },
      result: ok(),
      now: NOW,
    });
    assert.deepEqual(out, { written: true, periodKey: '2026-08-26', pending: false });
    assert.equal(db.writes.length, 1);
    assert.equal(db.writes[0].set.status, 'ok');
  } finally {
    db.restore();
  }
});

// ---------------------------------------------------------------------------
// 2. The `queued` counter
// ---------------------------------------------------------------------------

test('a pass that only polled is counted as queued, not as ok, failed or skipped', async () => {
  const db = stubDb();
  const connector = fakeConnector({
    census: { status: 'pending', data: null, note: 'queued at the provider' },
    movement: { status: 'pending', data: null, note: '' },
    backlinks: { status: 'pending', data: null, note: '' },
  });
  try {
    const report = await run(connector);

    // Four fetches: census fans out over two variants.
    assert.equal(report.queued, 4);
    assert.equal(report.ok, 0);
    assert.equal(report.failed, 0);
    assert.equal(report.written, 0);
    assert.equal(db.writes.length, 0);
    // And no error, so `syncAccount` cannot copy "queued" into
    // `ConnectorAccount.lastSyncReport.error` and show an operator a dead
    // account.
    assert.deepEqual(report.errors, []);
  } finally {
    db.restore();
  }
});

test('the note survives even though the row did not', async () => {
  // It is the only thing a person can see about an in-flight request.
  const db = stubDb();
  const connector = fakeConnector({
    census: { status: 'pending', data: null, note: 'available again in 6h' },
  });
  try {
    const report = await run(connector);
    assert.ok(report.notes.some((n) => /census: available again in 6h/.test(n)));
  } finally {
    db.restore();
  }
});

test('a queued kind feeds NOTHING to a dependant', async () => {
  // A dependant handed a queued kind's empty body would write an empty snapshot
  // that then looks current for a week — worse than not running it.
  const dependant = [
    KINDS[0],
    { key: 'derived', label: 'Derived', subject: 'project', dependsOn: ['census'] },
  ];
  const db = stubDb({ stored: null });
  const connector = fakeConnector({ census: { status: 'pending', data: null, note: '' } });
  try {
    const report = await run(connector, { kinds: dependant });

    assert.ok(!connector.calls.some((c) => c.kind === 'derived'));
    assert.ok(report.notes.some((n) => /derived: skipped, no census to work from/.test(n)));
    assert.equal(report.queued, 2);
  } finally {
    db.restore();
  }
});

test('a mixed pass reports all four outcomes separately', async () => {
  const db = stubDb();
  const connector = fakeConnector({
    census: ({ variant }) =>
      variant.key === 'us|desktop' ? ok() : { status: 'pending', data: null, note: '' },
    movement: () => {
      throw new Error('provider said no');
    },
  });
  try {
    const report = await run(connector);
    assert.equal(report.ok, 2); // one census variant + backlinks
    assert.equal(report.queued, 1);
    assert.equal(report.failed, 1);
    assert.equal(report.written, 2);
  } finally {
    db.restore();
  }
});

// ---------------------------------------------------------------------------
// 3. `existing` and `force` on the fetch context
// ---------------------------------------------------------------------------

test('the fetcher is handed the reading the planner already looked at', async () => {
  // `latest` was built and thrown away before this. Rebuilding it inside the
  // provider would be a second query per fetch for something already in hand.
  const previous = snapshotRow({
    variant: 'us|desktop',
    status: 'partial',
    fetchedAt: new Date(NOW.getTime() - 3 * HOUR),
  });
  const db = stubDb({ existing: [previous] });
  const connector = fakeConnector();
  try {
    await run(connector);
    const call = connector.calls.find(
      (c) => c.kind === 'census' && c.variant === 'us|desktop'
    );
    assert.equal(call.existing.status, 'partial');
    assert.equal(call.existing.fetchedAt, previous.fetchedAt);

    // Nothing stored for the other variant, and `undefined` would be a third
    // state a provider has to remember to handle.
    const other = connector.calls.find(
      (c) => c.kind === 'census' && c.variant === 'uk|mobile'
    );
    assert.equal(other.existing, null);
  } finally {
    db.restore();
  }
});

test('force is passed through rather than inferred — refusing a human is a different answer', async () => {
  const db = stubDb();
  const connector = fakeConnector();
  try {
    await run(connector);
    assert.ok(connector.calls.every((c) => c.force === false));

    connector.calls.length = 0;
    await run(connector, { force: true });
    assert.ok(connector.calls.every((c) => c.force === true));
  } finally {
    db.restore();
  }
});

// ---------------------------------------------------------------------------
// 4. Per-kind cadence
// ---------------------------------------------------------------------------

test('one provider, two cadences: the same age is fresh for one kind and stale for another', () => {
  const thirtyHoursAgo = new Date(NOW.getTime() - 30 * HOUR);
  const latest = new Map([
    ['census|us|desktop', snapshotRow({ fetchedAt: thirtyHoursAgo })],
    ['movement|all', snapshotRow({ kind: 'movement', variant: 'all', fetchedAt: thirtyHoursAgo })],
  ]);

  const { todo } = plan({ latest });
  const keys = todo.map((t) => `${t.kind.key}|${t.variant.key}`);

  // 30 hours: inside the census's weekly window, past the movement's daily one.
  assert.ok(!keys.includes('census|us|desktop'), 'the weekly census is still current');
  assert.ok(keys.includes('movement|all'), 'the daily movement is due again');
});

test('a kind with no opinion falls back to the connector-wide default', () => {
  const latest = new Map([
    ['backlinks|all', snapshotRow({ kind: 'backlinks', variant: 'all', fetchedAt: new Date(NOW.getTime() - 30 * HOUR) })],
  ]);
  assert.ok(!plan({ latest }).todo.some((t) => t.kind.key === 'backlinks'));

  // Same row, same age, against a daily connector default.
  assert.ok(
    plan({ latest, intervalHours: 24 }).todo.some((t) => t.kind.key === 'backlinks')
  );
});

test('isFresh stays PURE and two-argument — the policy lives in the planner', () => {
  // The reason the override is resolved at the call site. `isFresh` answers "is
  // this row younger than N hours", a fact about the row; WHICH N applies is a
  // quota decision, and quota decisions are asserted in the planner.
  const row = snapshotRow({ fetchedAt: new Date(NOW.getTime() - 30 * HOUR) });
  assert.equal(isFresh(row, 24, NOW), false);
  assert.equal(isFresh(row, 168, NOW), true);
  // Two required parameters (the clock is defaulted). It reads nothing off a
  // kind, and there is no kind in scope to read one off.
  assert.equal(isFresh.length, 2);
});

// ---------------------------------------------------------------------------
// 5. `intervalHoursFor` — a cadence a BOARD asked for
// ---------------------------------------------------------------------------

test('askedInterval refuses the values that would turn an hourly tick into an hourly spend', () => {
  assert.equal(askedInterval(24), 24);
  assert.equal(askedInterval(0.5), 0.5);
  assert.equal(askedInterval(0), null);
  assert.equal(askedInterval(-1), null);
  assert.equal(askedInterval(NaN), null);
  assert.equal(askedInterval(Infinity), null);
  assert.equal(askedInterval('24'), null);
  assert.equal(askedInterval(null), null);
  assert.equal(askedInterval(undefined), null);
});

test('scheduleForProvider takes the MIN across the boards that share a project', async () => {
  const original = { bc: BoardConnector.find, cp: ConnectorProject.find };
  BoardConnector.find = () =>
    chain([
      { board: 'bA', kinds: ['census'], intervalHours: 168 },
      { board: 'bB', kinds: ['movement'], intervalHours: 24 },
    ]);
  // One project row per board, which is how the runner sees a project mapped to
  // two boards: `ConnectorProject.board` is the binding, not the identity.
  ConnectorProject.find = () =>
    chain([
      { _id: 'p1', board: 'bA' },
      { _id: 'p1', board: 'bB' },
    ]);

  try {
    const schedule = await scheduleForProvider('tasked');
    assert.equal(schedule.length, 1);
    // The eager board's cadence wins, and its cost is subsidised by the frugal
    // one. Fine while budgets are per organisation; not the day anyone bills per
    // board.
    assert.equal(schedule[0].intervalHours, 24);
    // The kinds are still unioned, unchanged.
    assert.deepEqual([...schedule[0].kinds].sort(), ['census', 'movement']);
  } finally {
    BoardConnector.find = original.bc;
    ConnectorProject.find = original.cp;
  }
});

test('a board with no opinion contributes nothing, and null means the descriptor default', async () => {
  const original = { bc: BoardConnector.find, cp: ConnectorProject.find };
  BoardConnector.find = () =>
    chain([
      { board: 'bA', kinds: [] }, // no `intervalHours` field at all
      { board: 'bB', kinds: [], intervalHours: 72 },
    ]);
  ConnectorProject.find = () =>
    chain([
      { _id: 'p1', board: 'bA' },
      { _id: 'p1', board: 'bB' },
      { _id: 'p2', board: 'bA' },
    ]);

  try {
    const schedule = await scheduleForProvider('tasked');
    const byId = new Map(schedule.map((e) => [String(e.project._id), e]));
    assert.equal(byId.get('p1').intervalHours, 72);
    // Nobody asked, so nobody is answered — and the snapshot service turns null
    // back into the descriptor's own cadence.
    assert.equal(byId.get('p2').intervalHours, null);
  } finally {
    BoardConnector.find = original.bc;
    ConnectorProject.find = original.cp;
  }
});

test('a project-level cadence overrides the descriptor, PER PROJECT, inside the loop', async () => {
  // Hoisting this out of the project loop would hand one account's every project
  // whichever cadence happened to be resolved first — and two projects on one
  // account really can be mapped to boards that asked for different ones.
  //
  // Driven through the real `syncAccount`, which means going through the real
  // registry: `getConnector` is destructured at module load, so the descriptor
  // itself is what gets stood in for. Restored in `finally`, and `node --test`
  // gives each file its own process, so nothing here escapes.
  const { syncAccount } = require('./snapshotService');
  const { getConnector } = require('./index');
  const ConnectorAccount = require('../../models/ConnectorAccount');
  const connectorCrypto = require('../../utils/connectorCrypto');

  const descriptor = getConnector('ubersuggest');
  const saved = {
    fetch: descriptor.fetch,
    variantsFor: descriptor.variantsFor,
    createClient: descriptor.createClient,
    syncIntervalHours: descriptor.syncIntervalHours,
    findById: ConnectorAccount.findById,
    updateOne: ConnectorAccount.updateOne,
  };

  // The same 30-hour-old reading is visible to BOTH projects. Everything that
  // follows is decided by the cadence and by nothing else.
  const db = stubDb({
    existing: [
      snapshotRow({
        kind: 'backlinks',
        variant: 'all',
        fetchedAt: new Date(NOW.getTime() - 30 * HOUR),
      }),
    ],
  });

  const fetched = [];
  try {
    descriptor.fetch = async (kindKey, ctx) => {
      fetched.push(String(ctx.project._id));
      return ok();
    };
    descriptor.variantsFor = variantsFor;
    descriptor.createClient = undefined;
    descriptor.syncIntervalHours = 168;

    ConnectorAccount.findById = () => ({
      select: async () => ({
        _id: 'acc1',
        organisation: 'org1',
        provider: 'ubersuggest',
        label: 'Main',
        status: 'active',
        sealedTokens: connectorCrypto.sealJson(
          { accessToken: 'x' },
          { orgId: 'org1', provider: 'ubersuggest' }
        ),
      }),
    });
    ConnectorAccount.updateOne = async () => ({ acknowledged: true });

    const report = await syncAccount({
      account: { _id: 'acc1', label: 'Main', provider: 'ubersuggest' },
      projects: [project({ _id: 'p1' }), project({ _id: 'p2' })],
      // One kind, no per-kind override, so the only thing deciding anything is
      // the per-project cadence.
      kindsFor: () => [KINDS[2]],
      intervalHoursFor: (p) => (String(p._id) === 'p1' ? 24 : null),
      now: NOW,
    });

    assert.deepEqual(fetched, ['p1'], 'only the project whose board asked for daily');
    assert.equal(report.ok, 1);
    assert.equal(report.skipped, 1);
    assert.equal(report.queued, 0);
  } finally {
    db.restore();
    Object.assign(descriptor, {
      fetch: saved.fetch,
      variantsFor: saved.variantsFor,
      createClient: saved.createClient,
      syncIntervalHours: saved.syncIntervalHours,
    });
    ConnectorAccount.findById = saved.findById;
    ConnectorAccount.updateOne = saved.updateOne;
  }
});

test('the account report rolls queued up alongside ok, failed and skipped', async () => {
  const { syncAccount } = require('./snapshotService');
  const { getConnector } = require('./index');
  const ConnectorAccount = require('../../models/ConnectorAccount');
  const connectorCrypto = require('../../utils/connectorCrypto');

  const descriptor = getConnector('ubersuggest');
  const saved = {
    fetch: descriptor.fetch,
    variantsFor: descriptor.variantsFor,
    createClient: descriptor.createClient,
    findById: ConnectorAccount.findById,
    updateOne: ConnectorAccount.updateOne,
  };
  const db = stubDb();
  let written = null;

  try {
    descriptor.fetch = async () => ({ status: 'pending', data: null, note: 'queued' });
    descriptor.variantsFor = variantsFor;
    descriptor.createClient = undefined;

    ConnectorAccount.findById = () => ({
      select: async () => ({
        _id: 'acc1',
        organisation: 'org1',
        provider: 'ubersuggest',
        label: 'Main',
        status: 'active',
        sealedTokens: connectorCrypto.sealJson(
          { accessToken: 'x' },
          { orgId: 'org1', provider: 'ubersuggest' }
        ),
      }),
    });
    ConnectorAccount.updateOne = async (_filter, update) => {
      written = update.$set;
      return { acknowledged: true };
    };

    const report = await syncAccount({
      account: { _id: 'acc1', label: 'Main', provider: 'ubersuggest' },
      projects: [project({ _id: 'p1' })],
      kindsFor: () => [KINDS[2]],
      now: NOW,
    });

    assert.equal(report.queued, 1);
    assert.equal(report.ok, 0);
    assert.equal(report.failed, 0);
    // And it reaches the row an operator actually looks at, so a connector that
    // is only ever polling does not read as one that has stopped.
    assert.equal(written.lastSyncReport.queued, 1);
    assert.equal(written.lastSyncReport.error, '');
  } finally {
    db.restore();
    Object.assign(descriptor, {
      fetch: saved.fetch,
      variantsFor: saved.variantsFor,
      createClient: saved.createClient,
    });
    ConnectorAccount.findById = saved.findById;
    ConnectorAccount.updateOne = saved.updateOne;
  }
});
