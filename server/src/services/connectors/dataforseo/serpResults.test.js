const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const C = require('./constants');
const S = require('./serpResults');
const T = require('./tasks');
const { fetchKind } = require('./fetchers');
const { createDfsClient } = require('./client');
const { getKind } = require('./kinds');
const { variantKeyFor } = require('./sites');
const { aggregatePositions, normaliseSerpResult } = require('./normalise');
const DfsSerpResult = require('../../../models/DfsSerpResult');
const DfsTask = require('../../../models/DfsTask');
const ConnectorBudget = require('../../../models/ConnectorBudget');

/**
 * THE 16 MB TRAP, and the proof that it is closed.
 *
 * ---- The arithmetic this whole file exists for ------------------------------
 *
 * One organic item is ~1-2 KB. `depth: 100` is therefore ~100-200 KB per
 * keyword, and a 200-keyword Site is **20-40 MB — over Mongo's 16 MB document
 * ceiling by 2x.**
 *
 * The size is not the expensive part. The ORDERING is: the driver rejects the
 * write AFTER DataForSEO has been paid and AFTER `task_get` has consumed the
 * result. Money out, batch closed, stack trace about a document being too large,
 * and a reading for a day that has passed which can never be re-bought.
 *
 * So the assertion that matters is not "the write succeeded". It is:
 *
 *   AT 200 KEYWORDS x DEPTH 100, NO OVERSIZED WRITE IS EVER ATTEMPTED, AND THE
 *   SNAPSHOT BODY STAYS AGGREGATE-ONLY.
 *
 * Both halves. Capping the per-keyword documents while letting the items ride
 * along on `ConnectorSnapshot.data` would move the 40 MB document rather than
 * remove it.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VARIANT = { locationCode: 2840, languageCode: 'en', device: 'desktop' };
const VARIANT_KEY = variantKeyFor(VARIANT);

const project = (overrides = {}) => ({
  _id: 'proj-1',
  externalId: 'proj-1',
  domain: 'acme.com',
  organisation: 'org-1',
  account: 'acct-1',
  board: null,
  targets: [VARIANT],
  ...overrides,
});

/**
 * One organic block, at DataForSEO's own real weight.
 *
 * ~1.4 KB, which is inside the 1-2 KB the research note measured. The padding is
 * a `description` because that is genuinely where the bytes are in an advanced
 * payload — the title, the breadcrumb and the snippet — and a fixture that
 * cheated on the size would prove nothing at all about a ceiling measured in
 * bytes.
 */
const organicItem = (rank, domain = 'rival.com') => ({
  type: 'organic',
  rank_group: rank,
  rank_absolute: rank,
  domain,
  title: `Result ${rank} — a reasonably long page title of the kind Google shows`,
  url: `https://${domain}/page-${rank}?utm_source=serp&utm_medium=organic`,
  breadcrumb: `${domain} › blog › category › a-long-slug-${rank}`,
  description: `${'The snippet text that Google renders under a result. '.repeat(24)}`,
  links: [{ type: 'link_element', title: 'Sitelink', url: `https://${domain}/a` }],
});

/** A full depth-100 SERP with the tracked domain at rank 4. */
const deepSerp = (keyword, { depth = 100, datetime = '2026-09-01 04:12:07 +00:00' } = {}) => ({
  keyword,
  type: 'organic',
  location_code: 2840,
  language_code: 'en',
  datetime,
  item_types: ['organic', 'people_also_ask', 'ai_overview'],
  se_results_count: 1_240_000,
  items: Array.from({ length: depth }, (_, i) =>
    organicItem(i + 1, i === 3 ? 'acme.com' : 'rival.com')
  ),
});

const keywordsFor = (n) => Array.from({ length: n }, (_, i) => `keyword number ${i}`);

// ---------------------------------------------------------------------------
// 1. Trimming — render depth, not purchase depth
// ---------------------------------------------------------------------------

test('items are capped at RENDER depth, and the counts stay honest about it', () => {
  const { items } = deepSerp('x');
  const out = S.trimItems(items, C.SERP_RENDER_DEPTH);

  assert.equal(out.storedCount, C.SERP_RENDER_DEPTH);
  assert.equal(out.returnedCount, 100, 'what DataForSEO actually sent');
  assert.equal(out.truncated, true);
  assert.equal(
    out.items.filter((i) => i.type === 'organic').length,
    C.SERP_RENDER_DEPTH
  );
});

test('a SHORT SERP is not marked truncated — that is what the flag is for', () => {
  const short = Array.from({ length: 8 }, (_, i) => organicItem(i + 1));
  const out = S.trimItems(short, C.SERP_RENDER_DEPTH);

  assert.equal(out.storedCount, 8);
  assert.equal(out.returnedCount, 8);
  assert.equal(
    out.truncated,
    false,
    'a reader finding eight items must be able to tell "the SERP was short" ' +
      'from "we kept eight of a hundred", and no count alone can say which'
  );
});

test('the cut counts ORGANIC results, so a feature-heavy SERP still yields 20 rows', () => {
  // The advanced payload interleaves a dozen block types. Slicing the first
  // twenty ARRAY entries would give eleven results on a busy SERP and twenty on
  // a bare one, and a table asking for twenty rows would get whichever.
  const mixed = [];
  for (let i = 1; i <= 60; i += 1) {
    mixed.push({ type: 'people_also_ask', rank_absolute: i * 2 - 1 });
    mixed.push(organicItem(i));
  }
  const out = S.trimItems(mixed, 20);
  assert.equal(out.items.filter((i) => i.type === 'organic').length, 20);
  assert.ok(out.items.some((i) => i.type === 'people_also_ask'), 'the page is kept, not a list');
});

test('a trailing tail of page furniture is dropped, so `truncated` means results', () => {
  const items = [organicItem(1), organicItem(2), { type: 'related_searches' }];
  const out = S.trimItems(items, 20);
  assert.equal(out.items.at(-1).type, 'organic');
});

// ---------------------------------------------------------------------------
// 2. The size is MEASURED, not discovered
// ---------------------------------------------------------------------------

test('bytes are measured with Buffer.byteLength, not string length', () => {
  // A SERP full of CJK is up to three times bigger than its UTF-16 length
  // suggests, and that is exactly the payload nobody tests with.
  const cjk = [{ type: 'organic', title: '検索結果'.repeat(100) }];
  const bytes = S.measureBytes(cjk);
  assert.ok(bytes > JSON.stringify(cjk).length, 'bytes, not code units');
});

test('a body that will not fit is trimmed further, and says so', () => {
  const trimmed = S.trimItems(deepSerp('x').items, 20);
  // A ceiling below the trimmed body, so the halving loop has to run.
  const fitted = S.fitToCeiling(trimmed, { maxBytes: 4_000 });

  assert.ok(fitted.bytes <= 4_000);
  assert.ok(fitted.storedCount < 20);
  assert.equal(fitted.truncated, true);
  assert.equal(fitted.oversized, false);
});

test('a single item that cannot fit stores an EMPTY body rather than losing the row', () => {
  const one = { items: [organicItem(1)], storedCount: 1, returnedCount: 1, truncated: false };
  const fitted = S.fitToCeiling(one, { maxBytes: 10 });

  assert.deepEqual(fitted.items, []);
  assert.equal(fitted.oversized, true);
  assert.equal(
    fitted.storedCount,
    0,
    'a row saying "there was a reading here and it would not fit" beats a failed write'
  );
});

// ---------------------------------------------------------------------------
// 3. THE TRAP: 200 keywords x depth 100
// ---------------------------------------------------------------------------

const stubSerpWrites = () => {
  const writes = [];
  const original = DfsSerpResult.updateOne;
  DfsSerpResult.updateOne = async (filter, update) => {
    // The number that matters: how big the document WOULD have been on the wire.
    writes.push({
      filter,
      set: update.$set,
      bytes: Buffer.byteLength(JSON.stringify(update.$set), 'utf8'),
    });
    return { acknowledged: true };
  };
  return { writes, restore: () => { DfsSerpResult.updateOne = original; } };
};

test('200 keywords at depth 100 attempts NO oversized write', async () => {
  const serps = stubSerpWrites();
  try {
    const keywords = keywordsFor(200);
    const bodies = keywords.map((keyword) => {
      const raw = deepSerp(keyword);
      const trimmed = S.trimItems(raw.items, C.SERP_RENDER_DEPTH);
      return {
        keyword,
        items: trimmed.items,
        itemTypes: raw.item_types,
        returnedCount: trimmed.returnedCount,
        truncated: trimmed.truncated,
        trimmed: true,
        collectedAt: new Date('2026-09-01T04:12:07Z'),
      };
    });

    const out = await S.storeSerpBodies({
      project: project(),
      job: { _id: 'dfs-1' },
      kind: getKind('positions'),
      variant: VARIANT_KEY,
      periodKey: '2026-09-01',
      bodies,
      now: new Date('2026-09-01T05:00:00Z'),
    });

    assert.equal(out.written, 200, 'two hundred SMALL documents, not one impossible one');
    assert.equal(out.oversized, 0);

    for (const write of serps.writes) {
      assert.ok(
        write.bytes < C.MAX_SERP_DOC_BYTES,
        `a ${write.bytes}-byte write was attempted against a ${C.MAX_SERP_DOC_BYTES}-byte ceiling`
      );
      assert.ok(
        write.bytes < 16 * 1024 * 1024,
        'and nothing anywhere near Mongo\'s own ceiling'
      );
    }

    // The whole collection, added up, is what the naive design would have tried
    // to put in ONE document.
    const total = serps.writes.reduce((sum, w) => sum + w.bytes, 0);
    assert.ok(total < 16 * 1024 * 1024, `200 keywords total ${Math.round(total / 1024)} KB`);
    assert.equal(
      serps.writes.every((w) => w.set.storedCount === C.SERP_RENDER_DEPTH),
      true
    );
    assert.equal(serps.writes.every((w) => w.set.truncated === true), true);
    assert.equal(serps.writes[0].set.purchasedDepth, C.DEPTH_CENSUS, 'what we paid for');
    assert.equal(serps.writes[0].set.renderDepth, C.SERP_RENDER_DEPTH, 'what we kept');
  } finally {
    serps.restore();
  }
});

test('the SNAPSHOT body for the same 200 keywords stays AGGREGATE-ONLY', () => {
  /**
   * The other half of the trap, and the one that is easy to miss: capping the
   * per-keyword documents while letting the items ride along on
   * `ConnectorSnapshot.data` would MOVE the 40 MB document rather than remove it.
   */
  const rows = keywordsFor(200).map((keyword) =>
    normaliseSerpResult(deepSerp(keyword), { domain: 'acme.com', keyword })
  );
  const data = aggregatePositions(rows, {
    domain: 'acme.com',
    depth: C.DEPTH_CENSUS,
    collectedAt: new Date('2026-09-01T04:12:07Z'),
  });

  const bytes = Buffer.byteLength(JSON.stringify(data), 'utf8');
  /**
   * THE BOUND MOVED IN PHASE 10, AND IT MOVED FOR TWO NAMED FIELDS.
   *
   * Phase 3 measured ~80 bytes a keyword and bounded this at 64 KB. Phase 10
   * added `aiOverview` (up to `AI_REFERENCES_PER_KEYWORD` citation domains) and
   * `ownUrls` (up to `CANNIBAL_URLS_PER_KEYWORD` of our own ranking URLs) to
   * every row, because both are readings of a payload that is thrown away
   * moments later and neither can be recovered afterwards.
   *
   * The bound is raised rather than removed, and it is raised to a number with
   * arithmetic behind it: twelve hostnames plus five URLs is a few hundred bytes
   * a keyword, so 256 KB at two hundred keywords still leaves a factor of five
   * in hand and is sixty times under Mongo's ceiling. The assertion below it —
   * that NOT ONE SERP ITEM reached the body — is the one that was ever really
   * load-bearing, and it is unchanged.
   */
  assert.ok(
    bytes < 256 * 1024,
    `the aggregate for 200 keywords is ${bytes} bytes — the per-keyword caps are ` +
      'AI_REFERENCES_PER_KEYWORD and CANNIBAL_URLS_PER_KEYWORD'
  );
  for (const row of data.keywords) {
    assert.ok(
      row.aiOverview.references.length <= C.AI_REFERENCES_PER_KEYWORD,
      'the citation list is capped, which is what keeps the bound above arithmetic'
    );
    assert.ok(row.ownUrls.length <= C.CANNIBAL_URLS_PER_KEYWORD, 'and so is the URL list');
  }
  assert.equal(
    JSON.stringify(data).includes('"description"'),
    false,
    'NOT ONE SERP ITEM reached the snapshot body'
  );
  assert.equal(data.keywords.length, 200);
  assert.equal(data.totals.ranked, 200);
  assert.equal(data.keywords[0].rank, 4, 'and the irreplaceable half — the rank — is all there');
});

// ---------------------------------------------------------------------------
// 4. End to end, through the fetcher
// ---------------------------------------------------------------------------

const thenable = (value) => {
  const self = {
    sort: () => self,
    select: () => self,
    limit: () => self,
    lean: () => Promise.resolve(value),
    then: (res, rej) => Promise.resolve(value).then(res, rej),
  };
  return self;
};

const same = (a, b) => String(a) === String(b);

const stubTasks = () => {
  const rows = [];
  let seq = 0;
  const originals = {
    create: DfsTask.create,
    findOne: DfsTask.findOne,
    find: DfsTask.find,
    updateOne: DfsTask.updateOne,
  };
  DfsTask.create = async (input) => {
    const row = {
      _id: `dfs-${(seq += 1)}`,
      budgetState: 'none',
      estimateUsd: 0,
      costUsd: 0,
      budgetDocs: [],
      items: [],
      ...input,
    };
    row.save = async () => row;
    rows.push(row);
    return row;
  };
  DfsTask.findOne = (filter) =>
    thenable(
      [...rows]
        .reverse()
        .find((r) =>
          Object.entries(filter).every(([k, v]) =>
            v && typeof v === 'object' ? true : same(v, r[k])
          )
        ) || null
    );
  DfsTask.find = () => thenable([]);
  DfsTask.updateOne = async (filter, update) => {
    const row = rows.find((r) => same(r._id, filter._id));
    if (!row) return { acknowledged: true };
    for (const [k, v] of Object.entries(update.$set || {})) row[k] = v;
    for (const [k, v] of Object.entries(update.$inc || {})) row[k] = (row[k] || 0) + v;
    for (const [k, v] of Object.entries(update.$push || {})) {
      row[k] = [...(row[k] || []), ...(v.$each || [v])];
    }
    return { acknowledged: true };
  };
  return { rows, restore: () => Object.assign(DfsTask, originals) };
};

const stubBudgets = () => {
  const originals = {
    updateOne: ConnectorBudget.updateOne,
    findOneAndUpdate: ConnectorBudget.findOneAndUpdate,
  };
  ConnectorBudget.updateOne = async () => ({ acknowledged: true });
  ConnectorBudget.findOneAndUpdate = () => ({
    lean: async () => ({ capUsd: 1000, reservedUsd: 0, spentUsd: 0 }),
  });
  return { restore: () => Object.assign(ConnectorBudget, originals) };
};

test('a finished poll stores the bodies and returns an items-free snapshot', async () => {
  const db = stubTasks();
  const money = stubBudgets();
  const serps = stubSerpWrites();

  const KEYWORDS = keywordsFor(4);

  const impl = async (url, init) => {
    let body;
    if (url.includes('/task_post')) {
      const tags = JSON.parse(init.body).map((t) => t.tag);
      body = {
        status_code: 20000,
        status_message: 'Ok.',
        cost: 0.006 * tags.length,
        tasks_count: tags.length,
        tasks: tags.map((tag) => ({
          id: `task-${tag}`,
          status_code: 20100,
          status_message: 'Task Created.',
          cost: 0.006,
          data: { tag },
          result: null,
        })),
      };
    } else if (url.includes('/task_get/')) {
      const index = Number(url.split('/').pop().split('.').pop());
      body = {
        status_code: 20000,
        status_message: 'Ok.',
        cost: 0,
        tasks_count: 1,
        tasks: [
          {
            id: 'x',
            status_code: 20000,
            status_message: 'Ok.',
            cost: 0,
            data: {},
            result: [deepSerp(KEYWORDS[index] ?? KEYWORDS[0])],
          },
        ],
      };
    } else {
      throw new Error(`unexpected URL ${url}`);
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };

  const session = { accountId: 'acct-1', getCredentials: () => ({ login: 'l', password: 'p' }) };
  const client = createDfsClient(session, { fetchImpl: impl, retryDelaysMs: [] });
  const proj = project({ trackedKeywords: KEYWORDS });

  try {
    // Tick one buys the batch; tick two collects it.
    await fetchKind('positions', {
      session,
      client,
      project: proj,
      variant: { key: VARIANT_KEY, ...VARIANT },
      now: new Date('2026-09-01T00:17:00Z'),
    });
    const done = await fetchKind('positions', {
      session,
      client,
      project: proj,
      variant: { key: VARIANT_KEY, ...VARIANT },
      now: new Date('2026-09-01T06:17:00Z'),
    });

    assert.equal(done.status, 'ok');
    assert.equal(done.raw, null, '`raw` stays null forever for a batched kind');
    assert.equal(
      JSON.stringify(done.data).includes('"description"'),
      false,
      'the snapshot body carries no SERP items'
    );

    assert.equal(serps.writes.length, KEYWORDS.length, 'one document per keyword');
    assert.equal(
      serps.writes.every((w) => w.set.periodKey === '2026-09-01'),
      true,
      "filed under THE PROVIDER'S OWN day, the same key the snapshot gets"
    );
    assert.equal(
      serps.writes.every((w) => w.filter.keyword && w.filter.periodKey && w.filter.variant),
      true,
      'and keyed on the MEASUREMENT, so a re-delivered result rewrites one row'
    );
    assert.equal(serps.writes[0].set.task, 'dfs-1', 'traceable back to the money that bought it');
    assert.ok(serps.writes[0].set.expiresAt instanceof Date, 'evidence ages out');
  } finally {
    serps.restore();
    money.restore();
    db.restore();
  }
});

test('a storage failure loses the EVIDENCE and never the measurement', async () => {
  const original = DfsSerpResult.updateOne;
  const warnings = [];
  const originalWarn = console.warn;
  try {
    DfsSerpResult.updateOne = async () => {
      throw new Error('the disk is on fire');
    };
    console.warn = (m) => warnings.push(m);

    const out = await S.storeSerpBodies({
      project: project(),
      job: { _id: 'dfs-1' },
      kind: getKind('positions'),
      variant: VARIANT_KEY,
      periodKey: '2026-09-01',
      bodies: [{ keyword: 'x', items: [organicItem(1)], itemTypes: ['organic'] }],
      now: new Date(),
    });

    assert.equal(out.written, 0);
    assert.equal(out.skipped, 1, 'reported, not thrown');
    assert.match(warnings.join(' '), /could not store the SERP body/);
  } finally {
    console.warn = originalWarn;
    DfsSerpResult.updateOne = original;
  }
});

test('a concurrent writer taking the same key is not an error', async () => {
  const original = DfsSerpResult.updateOne;
  try {
    DfsSerpResult.updateOne = async () => {
      const err = new Error('E11000 duplicate key');
      err.code = 11000;
      throw err;
    };
    const out = await S.storeSerpBodies({
      project: project(),
      job: { _id: 'dfs-1' },
      kind: getKind('positions'),
      variant: VARIANT_KEY,
      periodKey: '2026-09-01',
      bodies: [{ keyword: 'x', items: [organicItem(1)] }],
      now: new Date(),
    });
    assert.equal(out.skipped, 1);
    assert.equal(out.written, 0);
  } finally {
    DfsSerpResult.updateOne = original;
  }
});

// ---------------------------------------------------------------------------
// 5. The model's own contract
// ---------------------------------------------------------------------------

test('DfsSerpResult carries the indexes the design depends on', () => {
  const indexes = DfsSerpResult.schema.indexes();
  const has = (keys, opts = null) =>
    indexes.some(
      ([k, o]) =>
        JSON.stringify(k) === JSON.stringify(keys) &&
        (!opts || Object.entries(opts).every(([n, v]) => o?.[n] === v))
    );

  assert.ok(
    has({ project: 1, kind: 1, variant: 1, periodKey: 1, keyword: 1 }, { unique: true }),
    'ONE ROW PER MEASUREMENT — a re-delivered result rewrites it rather than doubling it'
  );
  assert.ok(
    has({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    'the 90-day sweep, expiring AT the stored date so the writer picks the horizon'
  );
  assert.ok(has({ organisation: 1 }), 'orgCascade deletes by this and nothing else');
  assert.ok(has({ task: 1 }), 'the audit trail back to the money');
});

test('expiresAt is nullable, and null is the whole implementation of pinning', () => {
  const now = new Date('2026-09-01T00:00:00Z');

  const ages = S.expiryFor(now);
  assert.ok(ages instanceof Date);
  assert.equal(
    Math.round((ages.getTime() - now.getTime()) / 86_400_000),
    C.SERP_RETENTION_DAYS
  );

  assert.equal(
    S.expiryFor(now, { pinned: true }),
    null,
    'a TTL index skips a document whose field is not a date — no second collection, no sweep'
  );

  const path = DfsSerpResult.schema.path('expiresAt');
  assert.equal(path.isRequired, undefined, 'nullable by schema, not only by convention');
});

test('organisation is REQUIRED, because the cascade deletes by it', () => {
  const doc = new DfsSerpResult({
    project: new mongoose.Types.ObjectId(),
    kind: 'positions',
    variant: VARIANT_KEY,
    periodKey: '2026-09-01',
    keyword: 'x',
  });
  const err = doc.validateSync();
  assert.ok(err?.errors?.organisation, 'a SERP body must not outlive its workspace');
});

test('orgCascade deletes DfsSerpResult and ConnectorBudget by organisation', async () => {
  // The cascade is a long sequence of deletes; what is asserted is that these two
  // collections are IN it and scoped by `organisation`, which is the only thing a
  // new collection can get wrong.
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../../orgCascade.js'),
    'utf8'
  );
  assert.match(source, /DfsSerpResult\.deleteMany\(\{\s*organisation: orgId\s*\}\)/);
  assert.match(source, /ConnectorBudget\.deleteMany\(\{\s*organisation: orgId\s*\}\)/);
  assert.ok(
    source.indexOf('DfsSerpResult.deleteMany') < source.indexOf('DfsTask.deleteMany'),
    'children before parents, like everything else in that file'
  );
});
