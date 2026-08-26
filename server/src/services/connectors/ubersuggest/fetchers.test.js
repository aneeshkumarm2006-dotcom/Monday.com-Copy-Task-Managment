const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.CONNECTOR_MASTER_KEY_V1 = crypto.randomBytes(32).toString('base64');

const F = require('./fetchers');
const { resolveKinds, getKind, KIND_KEYS } = require('./kinds');
const { McpCallError } = require('./mcpClient');

/**
 * The fetchers, against a stub MCP client.
 *
 * ---- The property these tests exist for ------------------------------------
 *
 * A FETCHER MUST NOT SWALLOW A QUOTA ERROR. `mcpClient.callTool` throws an
 * `McpCallError` carrying `.quotaExhausted`, `.retryable` and `.needsReauth`,
 * and those flags are the runner's stop conditions. A fetcher that caught
 * everything and returned an empty result would turn "this account is out of
 * quota, stop for today" into "every project returned nothing" — and the next
 * run would spend the same wall of quota to learn the same thing.
 *
 * The narrow exception is a SECONDARY call whose absence degrades a snapshot
 * rather than emptying it: anchor texts beside a backlink total, traffic value
 * beside a traffic estimate. Those are caught. The primary call's error never
 * is, and quota and dead grants are never caught at all.
 *
 * Quota is the other theme. Every assertion about how many calls were made is
 * an assertion about somebody's monthly bill, because a report subject is
 * charged per day and the whole workspace shares the allowance.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A stub client that records every call and answers from a script.
 *
 * @param {Object<string, any|Function>} script - tool name → payload or thrower
 */
const stubClient = (script = {}) => {
  const calls = [];
  return {
    calls,
    callTool: async (name, args) => {
      calls.push({ name, args });
      const entry = script[name];
      if (entry === undefined) {
        throw new McpCallError(`no stub for ${name}`, { tool: name });
      }
      if (typeof entry === 'function') return entry(args, calls.length);
      return { data: entry, text: '' };
    },
  };
};

const project = (overrides = {}) => ({
  _id: 'p1',
  externalId: '5512',
  name: 'Acme',
  domain: 'acme.com',
  organisation: 'org1',
  account: 'acc1',
  locations: [{ locId: 2840, lang: 'en', label: 'United States' }],
  ...overrides,
});

const quotaError = () =>
  new McpCallError('out of quota', { quotaExhausted: true });

// ---------------------------------------------------------------------------
// The kind catalog
// ---------------------------------------------------------------------------

test('resolveKinds: an empty selection means EVERYTHING, not nothing', () => {
  // `BoardConnector.kinds` defaults to []. Reading that as "fetch nothing" would
  // leave the tab blank on a board that just switched the connector on, with no
  // error anywhere to explain it.
  assert.deepEqual(resolveKinds([]).map((k) => k.key), KIND_KEYS);
  assert.deepEqual(resolveKinds(undefined).map((k) => k.key), KIND_KEYS);
});

test('resolveKinds: a dependency is pulled in, not assumed present', () => {
  // keyword_metrics reads its keyword list out of the positions result. A board
  // that narrowed to metrics alone would otherwise get an empty section that is
  // indistinguishable from a provider failure.
  const keys = resolveKinds(['keyword_metrics']).map((k) => k.key);
  assert.deepEqual(keys, ['positions', 'keyword_metrics']);
  // And in dependency order, so the runner can walk the list once.
  assert.ok(keys.indexOf('positions') < keys.indexOf('keyword_metrics'));
});

test('resolveKinds: a selection of nothing but junk falls back to everything', () => {
  // A misconfiguration is not a request for silence.
  assert.deepEqual(resolveKinds(['nope', 'also_nope']).map((k) => k.key), KIND_KEYS);
});

test('every kind names the tools it spends, for the audit trail', () => {
  for (const key of KIND_KEYS) {
    const kind = getKind(key);
    assert.ok(kind.tools.length > 0, `${key} declares no tools`);
    assert.ok(['project', 'domain'].includes(kind.subject));
  }
});

// ---------------------------------------------------------------------------
// variantsFor
// ---------------------------------------------------------------------------

test('variantsFor: only positions fans out; everything else has one variant', () => {
  const p = project({
    locations: [
      { locId: 2840, lang: 'en' },
      { locId: 2826, lang: 'en' },
    ],
  });
  assert.equal(F.variantsFor('positions', p).variants.length, 2);
  for (const key of ['site_audit', 'domain_overview', 'backlinks', 'keyword_metrics']) {
    assert.equal(F.variantsFor(key, p).variants.length, 1, key);
  }
});

test('variantsFor: the variant key is readable and encodes device, lang and loc', () => {
  const [v] = F.variantsFor('positions', project()).variants;
  assert.equal(v.key, 'desktop|en|2840');
  // Readable rather than hashed on purpose — "why did this project's history
  // split into two series" is a question somebody asks with a shell open.
});

test('variantsFor: a project with no mirrored locales still gets one unfiltered ask', () => {
  const { variants } = F.variantsFor('positions', project({ locations: [] }));
  assert.equal(variants.length, 1);
  // The filters are optional on the tool, so this is a valid request.
  assert.equal(variants[0].locId, undefined);
});

test('variantsFor: locales beyond the cap are REPORTED, never silently dropped', () => {
  const many = Array.from({ length: F.MAX_POSITION_VARIANTS + 3 }, (_, i) => ({
    locId: 2000 + i,
    lang: 'en',
  }));
  const { variants, skipped } = F.variantsFor('positions', project({ locations: many }));
  assert.equal(variants.length, F.MAX_POSITION_VARIANTS);
  assert.equal(skipped, 3);
});

test('variantsFor: mobile is never polled blind', () => {
  // It is off by default per project at the provider, costs its own report, and
  // `list_projects` does not say whether a project tracks it — so asking would
  // spend a report per project per week to receive an error.
  const { variants } = F.variantsFor('positions', project());
  assert.ok(variants.every((v) => v.device === 'desktop'));
});

// ---------------------------------------------------------------------------
// positions
// ---------------------------------------------------------------------------

test('positions: sends the required date range and the variant filters', async () => {
  const client = stubClient({ [F.TOOL_POSITIONS]: { done: true, keywords: [] } });
  const [variant] = F.variantsFor('positions', project()).variants;

  await F.fetchPositions(client, { project: project(), range: {}, variant });

  const [call] = client.calls;
  assert.equal(call.name, F.TOOL_POSITIONS);
  assert.equal(call.args.project_id, '5512');
  // Both are REQUIRED by the tool; omitting either is a fatal error that still
  // costs a report.
  assert.match(call.args.startDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(call.args.endDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(call.args.locId, 2840);
  assert.equal(call.args.language, 'en');
  assert.equal(call.args.device, 'desktop');
});

test('positions: the provider’s updated_at becomes the period, not our clock', async () => {
  // This is what makes two polls in one week resolve to ONE data point rather
  // than inventing a second out of when we happened to ask.
  const client = stubClient({
    [F.TOOL_POSITIONS]: {
      done: true,
      updated_at: '2026-08-24T06:12:00.000Z',
      keywords: [],
    },
  });
  const res = await F.fetchPositions(client, { project: project(), range: {}, variant: {} });
  assert.equal(res.collectedAt.toISOString(), '2026-08-24T06:12:00.000Z');
});

test('positions: an unfinished report is stored PARTIAL, not discarded', async () => {
  const client = stubClient({
    [F.TOOL_POSITIONS]: { done: false, keywords: [{ keyword: 'a', status: 'ok' }] },
  });
  const res = await F.fetchPositions(client, { project: project(), range: {}, variant: {} });
  assert.equal(res.status, 'partial');
  // The rows it did return are real; throwing them away would blank the section
  // for a week rather than showing what arrived.
  assert.equal(res.data.keywords.length, 1);
  assert.ok(res.note);
});

test('positions: a quota error propagates untouched', async () => {
  const client = stubClient({ [F.TOOL_POSITIONS]: () => { throw quotaError(); } });
  await assert.rejects(
    () => F.fetchPositions(client, { project: project(), range: {}, variant: {} }),
    (err) => err.quotaExhausted === true
  );
});

// ---------------------------------------------------------------------------
// keyword_metrics
// ---------------------------------------------------------------------------

const positionsResult = (keywords) => ({
  keywords: keywords.map((k) => ({ keyword: k, status: 'ok', position: null })),
});

test('keyword_metrics: takes its keyword list from the positions result', async () => {
  // The alternative is `get_project`, which is a second report for a list we
  // already hold. There is no third way to enumerate tracked keywords.
  const client = stubClient({
    [F.TOOL_MATCH_KEYWORDS]: {
      searched_keywords: [
        { keyword: 'alpha', volume: 100, sd: 20 },
        { keyword: 'beta', volume: 200, sd: 30 },
      ],
    },
  });

  const res = await F.fetchKeywordMetrics(client, {
    project: project(),
    variant: { lang: 'en', locId: 2840 },
    previous: { positions: positionsResult(['alpha', 'beta']) },
  });

  assert.equal(client.calls.length, 1);
  assert.deepEqual(client.calls[0].args.keywords, ['alpha', 'beta']);
  assert.deepEqual(res.data.keywords.map((k) => k.volume), [100, 200]);
});

test('keyword_metrics: asks in the SAME locale the ranks were measured in', async () => {
  // Otherwise the table shows US volume beside a UK rank on one row.
  const client = stubClient({ [F.TOOL_MATCH_KEYWORDS]: { searched_keywords: [] } });
  await F.fetchKeywordMetrics(client, {
    project: project(),
    variant: { lang: 'pt', locId: 2076 },
    previous: { positions: positionsResult(['x']) },
  });
  assert.equal(client.calls[0].args.language, 'pt');
  assert.equal(client.calls[0].args.locId, 2076);
});

test('keyword_metrics: batches, and never asks about more than the cap', async () => {
  // A keyword is its own report SUBJECT. 300 tracked keywords across 15 projects
  // would be 4,500 subjects against a 900/day ceiling — the run would die a
  // third of the way through the first project having spent the whole day.
  const many = Array.from({ length: 250 }, (_, i) => `kw-${i}`);
  const client = stubClient({ [F.TOOL_MATCH_KEYWORDS]: { searched_keywords: [] } });

  const res = await F.fetchKeywordMetrics(client, {
    project: project(),
    variant: {},
    previous: { positions: positionsResult(many) },
  });

  const asked = client.calls.reduce((n, c) => n + c.args.keywords.length, 0);
  assert.equal(asked, F.KEYWORD_METRICS_MAX);
  assert.equal(client.calls.length, F.KEYWORD_METRICS_MAX / F.KEYWORD_BATCH_SIZE);

  // And the truncation is REPORTED. A cap nobody can see reads as "we covered
  // everything" — somebody would conclude the other 150 stopped being tracked.
  assert.equal(res.data.truncated, true);
  assert.equal(res.data.trackedTotal, 250);
  assert.match(res.note, /100 of 250/);
});

test('keyword_metrics: a keyword the provider skipped still gets a row', async () => {
  // The Keywords table and the Positions table have to read down in the same
  // order, or comparing them by eye is impossible.
  const client = stubClient({
    [F.TOOL_MATCH_KEYWORDS]: { searched_keywords: [{ keyword: 'b', volume: 5 }] },
  });
  const res = await F.fetchKeywordMetrics(client, {
    project: project(),
    variant: {},
    previous: { positions: positionsResult(['a', 'b']) },
  });
  assert.deepEqual(res.data.keywords.map((k) => k.keyword), ['a', 'b']);
  assert.equal(res.data.keywords[0].volume, null);
});

test('keyword_metrics: no tracked keywords spends nothing at all', async () => {
  const client = stubClient({});
  const res = await F.fetchKeywordMetrics(client, {
    project: project(),
    variant: {},
    previous: { positions: positionsResult([]) },
  });
  assert.equal(client.calls.length, 0);
  // Recorded as a successful empty reading, so the runner does not come back
  // hourly for a project that simply has nothing to price.
  assert.equal(res.status, 'ok');
  assert.deepEqual(res.data.keywords, []);
});

test('keyword_metrics: duplicate phrases are asked about once', async () => {
  const client = stubClient({ [F.TOOL_MATCH_KEYWORDS]: { searched_keywords: [] } });
  await F.fetchKeywordMetrics(client, {
    project: project(),
    variant: {},
    previous: { positions: positionsResult(['dup', 'dup', 'other']) },
  });
  assert.deepEqual(client.calls[0].args.keywords, ['dup', 'other']);
});

// ---------------------------------------------------------------------------
// site_audit
// ---------------------------------------------------------------------------

test('site_audit: the scheduled read NEVER starts a crawl', async () => {
  // A crawl is minutes of somebody else's compute and is capped by plan. An
  // unattended weekly job that started one for every domain in the workspace is
  // how an integration gets switched off from the far side.
  const client = stubClient({
    [F.TOOL_SITE_AUDIT_STATUS]: { result: { done: true, report: {} } },
  });
  await F.fetchSiteAudit(client, { project: project() });
  assert.deepEqual(client.calls.map((c) => c.name), [F.TOOL_SITE_AUDIT_STATUS]);
});

test('site_audit: a domain nobody has audited is a sentence, not a failure', async () => {
  const client = stubClient({
    [F.TOOL_SITE_AUDIT_STATUS]: () => {
      throw new McpCallError('Ubersuggest: Error: Task has not been set');
    },
  });
  const res = await F.fetchSiteAudit(client, { project: project() });
  assert.equal(res.status, 'partial');
  assert.match(res.note, /Run audit/);
  // Nothing is broken; somebody just has to press the button once.
  assert.equal(res.data, null);
});

test('site_audit: quota still propagates through the not-yet-audited branch', async () => {
  const client = stubClient({ [F.TOOL_SITE_AUDIT_STATUS]: () => { throw quotaError(); } });
  await assert.rejects(
    () => F.fetchSiteAudit(client, { project: project() }),
    (err) => err.quotaExhausted === true
  );
});

test('runAudit: the BUTTON forces a fresh crawl', async () => {
  const client = stubClient({ [F.TOOL_SITE_AUDIT]: { result: { done: false } } });
  const res = await F.runAudit({ project: project(), client });
  assert.equal(client.calls[0].name, F.TOOL_SITE_AUDIT);
  // Without `recrawl` the tool may answer from cache — which is what the
  // scheduled read already does, making the button a no-op.
  assert.equal(client.calls[0].args.recrawl, true);
  assert.equal(res.status, 'partial');
});

test('runAudit: refuses a project with no domain before spending a call', async () => {
  const client = stubClient({});
  await assert.rejects(
    () => F.runAudit({ project: project({ domain: null }), client }),
    (err) => err.status === 400
  );
  assert.equal(client.calls.length, 0);
});

// ---------------------------------------------------------------------------
// The secondary-call rule
// ---------------------------------------------------------------------------

test('domain_overview: a failed traffic_value degrades the card, not the run', async () => {
  const client = stubClient({
    [F.TOOL_DOMAIN_OVERVIEW]: { organic_traffic: 900 },
    [F.TOOL_TRAFFIC_VALUE]: () => { throw new McpCallError('boom'); },
  });
  const res = await F.fetchDomainOverview(client, { project: project() });
  assert.equal(res.status, 'ok');
  assert.equal(res.data.organicTraffic, 900);
  assert.equal(res.data.trafficValue, null);
  assert.match(res.note, /Traffic value/);
});

test('domain_overview: a failed PRIMARY call is not caught', async () => {
  const client = stubClient({
    [F.TOOL_DOMAIN_OVERVIEW]: () => { throw new McpCallError('boom'); },
  });
  await assert.rejects(() => F.fetchDomainOverview(client, { project: project() }));
});

test('domain_overview: quota on the SECONDARY call still stops the account', async () => {
  // The degrade-gracefully rule is about incomplete data. Being out of quota is
  // not incomplete data — it is a signal to stop, and swallowing it here would
  // let the runner grind through every remaining project to rediscover it.
  const client = stubClient({
    [F.TOOL_DOMAIN_OVERVIEW]: { organic_traffic: 1 },
    [F.TOOL_TRAFFIC_VALUE]: () => { throw quotaError(); },
  });
  await assert.rejects(
    () => F.fetchDomainOverview(client, { project: project() }),
    (err) => err.quotaExhausted === true
  );
});

test('backlinks: a failed anchor_texts degrades, quota does not', async () => {
  const soft = stubClient({
    [F.TOOL_BACKLINKS_OVERVIEW]: { backlinks: 10 },
    [F.TOOL_ANCHOR_TEXTS]: () => { throw new McpCallError('boom'); },
  });
  const res = await F.fetchBacklinks(soft, { project: project() });
  assert.equal(res.data.backlinks, 10);
  assert.deepEqual(res.data.anchors, []);

  const hard = stubClient({
    [F.TOOL_BACKLINKS_OVERVIEW]: { backlinks: 10 },
    [F.TOOL_ANCHOR_TEXTS]: () => { throw quotaError(); },
  });
  await assert.rejects(
    () => F.fetchBacklinks(hard, { project: project() }),
    (err) => err.quotaExhausted === true
  );
});

// ---------------------------------------------------------------------------
// The dispatcher
// ---------------------------------------------------------------------------

test('fetchKind: an unknown kind is a clear error, not undefined', async () => {
  await assert.rejects(
    () => F.fetchKind('not_a_kind', { client: stubClient({}), project: project() }),
    /Unknown Ubersuggest snapshot kind/
  );
});

test('fetchKind: routes to the right tool for each kind', async () => {
  const expected = {
    positions: F.TOOL_POSITIONS,
    site_audit: F.TOOL_SITE_AUDIT_STATUS,
    domain_overview: F.TOOL_DOMAIN_OVERVIEW,
    backlinks: F.TOOL_BACKLINKS_OVERVIEW,
  };
  for (const [kind, tool] of Object.entries(expected)) {
    const client = stubClient({
      [tool]: { done: true, report: {} },
      [F.TOOL_TRAFFIC_VALUE]: {},
      [F.TOOL_ANCHOR_TEXTS]: {},
    });
    // eslint-disable-next-line no-await-in-loop
    await F.fetchKind(kind, { client, project: project(), variant: {}, range: {} });
    assert.equal(client.calls[0].name, tool, kind);
  }
});

test('resolveRange: defaults to the documented 30-day window, ending today', () => {
  const { from, to } = F.resolveRange({}, new Date('2026-08-27T10:00:00Z'));
  assert.equal(to, '2026-08-27');
  assert.equal(from, '2026-07-28');
});

test('resolveRange: an explicit range is honoured', () => {
  const r = F.resolveRange({ from: '2026-01-01', to: '2026-02-01' });
  assert.deepEqual(r, { from: '2026-01-01', to: '2026-02-01' });
});
