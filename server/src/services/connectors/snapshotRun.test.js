const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.CONNECTOR_MASTER_KEY_V1 = crypto.randomBytes(32).toString('base64');

const ConnectorProject = require('../../models/ConnectorProject');
const ConnectorSnapshot = require('../../models/ConnectorSnapshot');
const { syncProject } = require('./snapshotService');
const { resolveKinds } = require('./ubersuggest/kinds');
const { variantsFor } = require('./ubersuggest/fetchers');

/**
 * `syncProject` — the stop conditions, and what does and does not get written.
 *
 * `snapshotService.test.js` next door covers the PURE half: what to fetch and
 * what to skip. This covers the half that has to touch the database, with both
 * collections stubbed, because the interesting behaviour is not in either the
 * plan or the write on its own — it is in how a failure partway through is
 * handled:
 *
 *   - quota exhausted and a dead grant END THE ACCOUNT, and are re-thrown so the
 *     caller can stop rather than grinding through every remaining project to
 *     collect the same error;
 *   - anything else is recorded against the one (project, kind) that failed and
 *     the run CONTINUES, because a week where 3 of 200 subjects failed is a
 *     successful sync with 3 gaps;
 *   - a failure NEVER becomes a snapshot row, because it would have to claim
 *     today's period and squat in the slot the real reading needs.
 */

const WEEKLY = 168;

const project = (overrides = {}) => ({
  _id: 'p1',
  externalId: '5512',
  name: 'Acme',
  domain: 'acme.com',
  organisation: 'org1',
  account: 'acc1',
  locations: [{ locId: 2840, lang: 'en' }],
  ...overrides,
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

/**
 * Stub the two collections `syncProject` touches, recording every write.
 *
 * @param {Object} opts
 * @param {Array} [opts.existing] - rows the freshness check will see
 * @param {Object|null} [opts.stored] - what `findOne` returns for a dependency
 */
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

/** A provider descriptor whose `fetch` is a script, so calls can be counted. */
const fakeConnector = (script = {}) => {
  const calls = [];
  return {
    name: 'ubersuggest',
    syncIntervalHours: WEEKLY,
    variantsFor,
    calls,
    fetch: async (kindKey, ctx) => {
      calls.push({ kind: kindKey, variant: ctx.variant?.key, previous: ctx.previous });
      const entry = script[kindKey];
      if (typeof entry === 'function') return entry(ctx);
      return (
        entry || { data: { ok: true }, raw: null, status: 'ok', note: '', collectedAt: null }
      );
    },
  };
};

const run = (connector, overrides = {}) =>
  syncProject({
    session: { markNeedsReauth: async () => {} },
    connector,
    project: project(),
    kinds: resolveKinds([]),
    intervalHours: WEEKLY,
    now: new Date('2026-08-27T12:00:00Z'),
    ...overrides,
  });

const thrower = (flag) => () => {
  const err = new Error(flag || 'boom');
  if (flag) err[flag] = true;
  throw err;
};

// ---------------------------------------------------------------------------
// The stop conditions
// ---------------------------------------------------------------------------

test('quota exhaustion stops the account rather than being logged per project', async () => {
  const db = stubDb();
  const connector = fakeConnector({ positions: thrower('quotaExhausted') });
  try {
    await assert.rejects(() => run(connector), (err) => err.quotaExhausted === true);
    // Nothing was written for the kinds that never ran.
    assert.equal(db.writes.length, 0);
  } finally {
    db.restore();
  }
});

test('a dead grant stops the account too', async () => {
  const db = stubDb();
  const connector = fakeConnector({ positions: thrower('needsReauth') });
  try {
    await assert.rejects(() => run(connector), (err) => err.needsReauth === true);
  } finally {
    db.restore();
  }
});

test('an ordinary failure is recorded and the run CONTINUES', async () => {
  const db = stubDb();
  const connector = fakeConnector({ site_audit: thrower(null) });
  try {
    const report = await run(connector);
    assert.equal(report.failed, 1);
    assert.ok(report.errors[0].startsWith('site_audit:'));
    // The other four kinds still landed. Turning this into a thrown error would
    // discard four readings to report one.
    assert.equal(report.ok, 4);
    assert.equal(db.writes.length, 4);
  } finally {
    db.restore();
  }
});

test('a failure NEVER becomes a snapshot row', async () => {
  // It would have to claim today's periodKey, which would then sit in the slot
  // the real reading needs when the provider recovers — and the unique index
  // would keep the good data out.
  const db = stubDb();
  const connector = fakeConnector({ positions: thrower(null) });
  try {
    await run(connector);
    assert.ok(!db.writes.some((w) => w.filter.kind === 'positions'));
  } finally {
    db.restore();
  }
});

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

test('a dependant is skipped when its dependency failed and nothing is stored', async () => {
  const db = stubDb({ stored: null });
  const connector = fakeConnector({ positions: thrower(null) });
  try {
    const report = await run(connector);
    assert.ok(!connector.calls.some((c) => c.kind === 'keyword_metrics'));
    assert.ok(report.notes.some((n) => /keyword_metrics: skipped/.test(n)));
    assert.ok(!db.writes.some((w) => w.filter.kind === 'keyword_metrics'));
  } finally {
    db.restore();
  }
});

test('a dependant falls back to the STORED dependency when it was skipped as fresh', async () => {
  // The hole this closes: freshness is per (kind, variant), so if positions
  // succeeds and keyword_metrics fails in the same pass, the next hour finds
  // positions current and does not re-fetch it. Without the fallback, metrics
  // would be skipped for "no positions to work from" every hour until positions
  // went stale again a week later.
  const db = stubDb({
    existing: [
      {
        kind: 'positions',
        variant: 'desktop|en|2840',
        status: 'ok',
        fetchedAt: new Date('2026-08-27T06:00:00Z'),
      },
    ],
    stored: { data: { keywords: [{ keyword: 'stored kw' }] } },
  });
  const connector = fakeConnector();
  try {
    await run(connector);
    const metrics = connector.calls.find((c) => c.kind === 'keyword_metrics');
    assert.ok(metrics, 'keyword_metrics should still run');
    // And it got the stored keyword list. Reading it costs a database query and
    // no quota at all.
    assert.deepEqual(metrics.previous.positions.keywords, [{ keyword: 'stored kw' }]);
    // positions itself was NOT re-fetched: it was current.
    assert.ok(!connector.calls.some((c) => c.kind === 'positions'));
  } finally {
    db.restore();
  }
});

test('a dependant is handed THIS pass’s result in preference to a stored one', async () => {
  const db = stubDb({ stored: { data: { keywords: [{ keyword: 'stale kw' }] } } });
  const connector = fakeConnector({
    positions: {
      data: { keywords: [{ keyword: 'fresh kw' }] },
      raw: null,
      status: 'ok',
      note: '',
      collectedAt: null,
    },
  });
  try {
    await run(connector);
    const metrics = connector.calls.find((c) => c.kind === 'keyword_metrics');
    assert.deepEqual(metrics.previous.positions.keywords, [{ keyword: 'fresh kw' }]);
  } finally {
    db.restore();
  }
});

// ---------------------------------------------------------------------------
// The write
// ---------------------------------------------------------------------------

test('a partial reading uses a filter that cannot overwrite a finished one', async () => {
  const db = stubDb();
  const connector = fakeConnector({
    positions: {
      data: { x: 1 },
      raw: null,
      status: 'partial',
      note: 'still running',
      collectedAt: null,
    },
  });
  try {
    await run(connector);
    const write = db.writes.find((w) => w.filter.kind === 'positions');
    // The narrowing is what makes the loser of a race collide with the unique
    // index instead of clobbering better data.
    assert.deepEqual(write.filter.status, { $ne: 'ok' });
    assert.equal(write.set.status, 'partial');
  } finally {
    db.restore();
  }
});

test('an ok reading is written without that narrowing', async () => {
  const db = stubDb();
  const connector = fakeConnector();
  try {
    await run(connector);
    const write = db.writes.find((w) => w.filter.kind === 'backlinks');
    assert.equal('status' in write.filter, false);
    assert.equal(write.set.status, 'ok');
  } finally {
    db.restore();
  }
});

test('the write carries every part of the row identity explicitly', async () => {
  // Not left to the driver's upsert-document derivation: the partial branch's
  // filter is not four equalities, so an insert there would otherwise be short
  // of fields the unique index needs.
  const db = stubDb();
  const connector = fakeConnector();
  try {
    await run(connector);
    const write = db.writes[0];
    for (const field of [
      'project', 'kind', 'variant', 'periodKey', 'organisation', 'provider', 'account',
    ]) {
      assert.ok(field in write.set, `${field} missing from the write`);
    }
  } finally {
    db.restore();
  }
});

test('the subject records WHAT was asked about, per kind', async () => {
  // A domain kind names the domain and a project kind names the project id.
  // Worth storing: it is the only record of which subject a reading was billed
  // against, and the domain on a project can change under us.
  const db = stubDb();
  const connector = fakeConnector();
  try {
    await run(connector);
    assert.equal(
      db.writes.find((w) => w.filter.kind === 'positions').set.subject,
      'project:5512'
    );
    assert.equal(
      db.writes.find((w) => w.filter.kind === 'backlinks').set.subject,
      'domain:acme.com'
    );
  } finally {
    db.restore();
  }
});
