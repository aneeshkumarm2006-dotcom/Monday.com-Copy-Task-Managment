const test = require('node:test');
const assert = require('node:assert/strict');

const ConnectorProject = require('../../../models/ConnectorProject');
const { diffProjects } = require('../projectMirror');
const C = require('./constants');
const { findSearchOperators, isPlainKeyword } = require('./operators');
const S = require('./sites');

/**
 * Sites — the project this provider has to author, because there is nothing to
 * mirror.
 *
 * Three properties are asserted here and each of them is about money or about
 * history:
 *
 *   1. SEARCH OPERATORS ARE REFUSED SERVER-SIDE. DataForSEO charges x5 per
 *      operator and they stack. A cost multiplier that only a browser checks is
 *      a cost multiplier.
 *   2. THE VARIANT KEY DERIVES FROM IMMUTABLE INPUTS ONLY. From phase 2 an open
 *      task is identified by `(project, kind, variant)`; a key that shifts when
 *      somebody renames a label is a cache miss, and a cache miss is a charge.
 *   3. THE MIRROR CAN NEVER MARK A SITE MISSING. Not because a branch says so,
 *      but because the listing is built from the stored rows and cannot omit
 *      one.
 */

// ---------------------------------------------------------------------------
// 1. Search operators
// ---------------------------------------------------------------------------

test('a plain keyword carries no operator', () => {
  const fine = [
    'best crm for agencies',
    'long-tail keyword research',
    'e-commerce seo',
    'seo agency near me',
    'what is a 301 redirect',
    'top 10 crms 2026',
    'b2b saas',
    'sword and shield',
    'coffee or tea shops london',
    'c# tutorial',
  ];
  for (const keyword of fine) {
    assert.deepEqual(findSearchOperators(keyword), [], `"${keyword}" was flagged`);
  }
});

test('every operator that multiplies the price is found, and named', () => {
  const caught = {
    'site:acme.com pricing': 'site:',
    'inurl:blog seo': 'inurl:',
    'intitle:"best crm"': 'intitle:',
    'filetype:pdf seo guide': 'filetype:',
    'related:acme.com': 'related:',
    'cache:acme.com': 'cache:',
    'link:acme.com': 'link:',
    '"best crm for agencies"': '"',
    'best * crm': '*',
    '(crm OR software)': '( )',
    'crm | software': '|',
    'crm OR software': 'OR',
    'crm AND software': 'AND',
    'best crm -free': '-',
    'best +crm': '+',
    'best ~crm': '~',
    'crm 100..200 users': '..',
  };

  for (const [keyword, operator] of Object.entries(caught)) {
    const found = findSearchOperators(keyword);
    assert.ok(found.length, `"${keyword}" was not flagged at all`);
    assert.ok(
      found.some((f) => f.operator === operator),
      `"${keyword}" did not report ${operator}, got ${JSON.stringify(found.map((f) => f.operator))}`
    );
    assert.equal(isPlainKeyword(keyword), false);
  }
});

test('operators STACK, and the refusal says so', () => {
  // `site:example.com` at depth 100 with rectangles on Live is $0.102 for one
  // call. The sentence has to make that visible or the fix is a shrug.
  const found = findSearchOperators('site:acme.com "best crm" -free');
  assert.equal(found.length, 3);

  const out = S.readKeywords(['site:acme.com "best crm" -free']);
  assert.equal(out.ok, false);
  assert.equal(out.code, 'SEARCH_OPERATOR');
  assert.match(out.error, /site:/);
  assert.match(out.error, /five times/);
});

// ---------------------------------------------------------------------------
// 2. Domains
// ---------------------------------------------------------------------------

test('a domain survives whatever somebody pasted', () => {
  const cases = {
    'acme.com': 'acme.com',
    'ACME.com': 'acme.com',
    '  acme.com  ': 'acme.com',
    'https://acme.com': 'acme.com',
    'http://acme.com/pricing?utm=x': 'acme.com',
    'https://acme.com:8443/a/b': 'acme.com',
    'https://user:pw@acme.com/': 'acme.com',
    'acme.com.': 'acme.com',
    'sub.acme.co.uk': 'sub.acme.co.uk',
  };
  for (const [input, expected] of Object.entries(cases)) {
    assert.equal(S.normaliseDomain(input), expected, `"${input}"`);
  }
});

test('www is NOT stripped, because it is a different rank-tracking target', () => {
  // A SERP result on www.acme.com is not a result on acme.com. Quietly
  // normalising one into the other would make every rank we report subtly about
  // a domain the user did not choose.
  assert.equal(S.normaliseDomain('https://www.acme.com'), 'www.acme.com');
});

test('anything that is not a hostname is refused', () => {
  const bad = ['', '   ', 'acme', 'acme .com', 'not a domain', '-acme.com', 'acme-.com', null, 42, 'a'.repeat(300)];
  for (const value of bad) {
    assert.equal(S.normaliseDomain(value), null, `${JSON.stringify(value)} was accepted`);
  }
});

// ---------------------------------------------------------------------------
// 3. Keywords
// ---------------------------------------------------------------------------

test('keywords are lowercased, collapsed and deduped', () => {
  // Google is case-insensitive, so "Best CRM" and "best crm" are one keyword
  // that would otherwise be bought twice — every week, per target, forever.
  const out = S.readKeywords(['Best   CRM', 'best crm', '  BEST CRM ', 'seo audit']);
  assert.equal(out.ok, true);
  assert.deepEqual(out.keywords, ['best crm', 'seo audit']);
});

test('an empty list is refused, because a site with no keywords buys nothing', () => {
  assert.equal(S.readKeywords([]).ok, false);
  assert.equal(S.readKeywords(['   ', '']).ok, false);
  assert.equal(S.readKeywords('best crm').ok, false);
  assert.equal(S.readKeywords([{ keyword: 'best crm' }]).ok, false);
});

test('the keyword cap is a COST ceiling and the refusal counts', () => {
  const many = Array.from({ length: C.MAX_TRACKED_KEYWORDS + 1 }, (_, i) => `keyword ${i}`);
  const out = S.readKeywords(many);
  assert.equal(out.ok, false);
  assert.match(out.error, new RegExp(String(C.MAX_TRACKED_KEYWORDS + 1)));

  const exactly = Array.from({ length: C.MAX_TRACKED_KEYWORDS }, (_, i) => `keyword ${i}`);
  assert.equal(S.readKeywords(exactly).ok, true);
});

test('a single absurdly long keyword is refused rather than truncated', () => {
  const out = S.readKeywords(['x'.repeat(C.MAX_KEYWORD_LENGTH + 1)]);
  assert.equal(out.ok, false);
});

// ---------------------------------------------------------------------------
// 4. Targets and the variant key
// ---------------------------------------------------------------------------

const TARGET = { locationCode: 2840, languageCode: 'en', device: 'desktop' };

test('the variant key derives from the three immutable inputs and nothing else', () => {
  const base = S.variantKeyFor(TARGET);
  assert.equal(base, '2840|en|desktop');

  // A label is display text somebody will rename. If it moved the key, the whole
  // history of that market would split in two and the phase-2 open-task gate
  // would miss — which is a second charge for work already paid for.
  assert.equal(S.variantKeyFor({ ...TARGET, label: 'United States' }), base);
  assert.equal(S.variantKeyFor({ ...TARGET, label: 'US (desktop)' }), base);

  // Case is not identity either.
  assert.equal(S.variantKeyFor({ ...TARGET, languageCode: 'EN', device: 'DESKTOP' }), base);

  // But each of the three genuinely is.
  assert.notEqual(S.variantKeyFor({ ...TARGET, device: 'mobile' }), base);
  assert.notEqual(S.variantKeyFor({ ...TARGET, languageCode: 'es' }), base);
  assert.notEqual(S.variantKeyFor({ ...TARGET, locationCode: 2826 }), base);
});

test('a target list is validated, deduped on the key, and capped', () => {
  const out = S.readTargets([
    { locationCode: 2840, languageCode: 'EN', device: 'Desktop', label: 'United States' },
    // Same key, different label. One target, not two — storing both would buy
    // the same SERP twice a week forever.
    { locationCode: 2840, languageCode: 'en', device: 'desktop', label: 'US' },
    { locationCode: 2840, languageCode: 'en', device: 'mobile' },
  ]);
  assert.equal(out.ok, true);
  assert.deepEqual(out.targets.map(S.variantKeyFor), ['2840|en|desktop', '2840|en|mobile']);
  assert.equal(out.targets[0].label, 'United States');

  assert.equal(S.readTargets([]).ok, false);
  assert.equal(S.readTargets([{ languageCode: 'en' }]).ok, false);
  assert.equal(S.readTargets([{ locationCode: 2840 }]).ok, false);
  assert.equal(S.readTargets([{ locationCode: 0, languageCode: 'en' }]).ok, false);
  assert.equal(S.readTargets([{ locationCode: 2840, languageCode: 'english' }]).ok, false);
  // Tablet is not a device DataForSEO's SERP endpoints take. Offering it would
  // produce a target every task_post rejects with a 40501.
  assert.equal(
    S.readTargets([{ locationCode: 2840, languageCode: 'en', device: 'tablet' }]).ok,
    false
  );

  const many = Array.from({ length: C.MAX_TARGETS + 1 }, (_, i) => ({
    locationCode: 2840 + i,
    languageCode: 'en',
  }));
  assert.equal(S.readTargets(many).ok, false);
});

test('variantsFor fans a kind out over every target, opaquely to the planner', () => {
  const project = {
    targets: [
      { locationCode: 2840, languageCode: 'en', device: 'desktop', label: 'US' },
      { locationCode: 2826, languageCode: 'en', device: 'mobile', label: 'UK mobile' },
    ],
  };
  const { variants, skipped } = S.variantsFor('positions', project);
  assert.deepEqual(variants.map((v) => v.key), ['2840|en|desktop', '2826|en|mobile']);
  assert.equal(skipped, 0);
  assert.equal(variants[0].locationCode, 2840);

  // A site with no targets cannot be collected at all — every DataForSEO call
  // requires a location and a language, and there is no honest default.
  assert.deepEqual(S.variantsFor('positions', { targets: [] }), { variants: [], skipped: 0 });
  assert.deepEqual(S.variantsFor('positions', {}), { variants: [], skipped: 0 });
});

// ---------------------------------------------------------------------------
// 5. The whole form
// ---------------------------------------------------------------------------

const GOOD_SITE = {
  name: '  Acme  ',
  domain: 'https://acme.com/pricing',
  trackedKeywords: ['Best CRM', 'best crm', 'seo audit'],
  targets: [{ locationCode: 2840, languageCode: 'en', device: 'desktop' }],
  competitors: ['https://rival.com', 'RIVAL.com', 'acme.com'],
};

test('a whole site reads into exactly the fields the model carries', () => {
  const out = S.readSiteForm(GOOD_SITE);
  assert.equal(out.ok, true);

  assert.equal(out.values.name, 'Acme');
  assert.equal(out.values.domain, 'acme.com');
  assert.deepEqual(out.values.trackedKeywords, ['best crm', 'seo audit']);
  assert.deepEqual(out.values.targets, [
    { locationCode: 2840, languageCode: 'en', device: 'desktop', label: null },
  ]);
  // Deduped, and the site is not its own competitor.
  assert.deepEqual(out.values.competitors, ['rival.com']);

  // The generic tab renders these two and `publicProject` has always carried
  // them, so they are kept in step rather than left to drift.
  assert.equal(out.values.keywordCount, 2);
  assert.equal(out.values.competitorCount, 1);
  assert.deepEqual(out.values.locations, [{ locId: 2840, lang: 'en', label: null }]);

  /**
   * OPTIONAL, AND EMPTY IS THE GATE.
   *
   * Phase 10 added `businessName`, and it is the one `requires` in this
   * provider that actually stops a collection: `planProjectWork` gates on
   * truthiness, an empty ARRAY is truthy (which is why `trackedKeywords` never
   * gated anything) and an empty STRING is not. A site saved without one never
   * buys a Maps lookup.
   */
  assert.equal(out.values.businessName, '');

  // Built from what the provider declares, never from what the request sent.
  assert.deepEqual(Object.keys(out.values).sort(), [
    'businessName',
    'competitorCount',
    'competitors',
    'domain',
    'keywordCount',
    'locations',
    'name',
    'targets',
    'trackedKeywords',
  ]);
});

test('a business name is trimmed, capped, and NEVER defaulted to the domain', () => {
  const named = S.readSiteForm({ ...GOOD_SITE, businessName: '  Acme Plumbing, Leeds  ' });
  assert.equal(named.values.businessName, 'Acme Plumbing, Leeds');

  /**
   * The default is EMPTY, not the domain, and that is a money decision rather
   * than a tidiness one. `my_business_info` fuzzy-matches a text query, so a
   * domain query returns a card for whatever Google decides is closest — and a
   * confident card for the WRONG business gets stored, charted and put in front
   * of a client. An empty answer is recoverable; a plausible wrong one is not.
   */
  assert.equal(S.readSiteForm(GOOD_SITE).values.businessName, '');
  assert.notEqual(S.readSiteForm(GOOD_SITE).values.businessName, 'acme.com');

  const long = S.readSiteForm({ ...GOOD_SITE, businessName: 'x'.repeat(400) });
  assert.equal(long.values.businessName.length, 200);
});

test('a request cannot smuggle a field into the document', () => {
  const out = S.readSiteForm({
    ...GOOD_SITE,
    locallyAuthored: false,
    organisation: 'somebody else',
    externalId: 'theirs',
    missing: true,
  });
  assert.equal(out.ok, true);
  assert.equal('locallyAuthored' in out.values, false);
  assert.equal('organisation' in out.values, false);
  assert.equal('externalId' in out.values, false);
  assert.equal('missing' in out.values, false);
});

test('the name falls back to the domain rather than being empty', () => {
  assert.equal(S.readSiteForm({ ...GOOD_SITE, name: '   ' }).values.name, 'acme.com');
  assert.equal(S.readSiteForm({ ...GOOD_SITE, name: undefined }).values.name, 'acme.com');
});

test('every required half is refused with a sentence somebody can act on', () => {
  assert.match(S.readSiteForm({ ...GOOD_SITE, domain: 'nope' }).error, /site domain/);
  assert.match(S.readSiteForm({ ...GOOD_SITE, trackedKeywords: [] }).error, /at least one keyword/);
  assert.match(S.readSiteForm({ ...GOOD_SITE, targets: [] }).error, /location and language/);
  assert.match(
    S.readSiteForm({ ...GOOD_SITE, competitors: ['not a domain'] }).error,
    /not a domain/
  );
  assert.equal(S.readSiteForm(null).ok, false);
  assert.equal(S.readSiteForm('nope').ok, false);
});

test('an operator anywhere in the list refuses the WHOLE save', () => {
  const out = S.readSiteForm({
    ...GOOD_SITE,
    trackedKeywords: ['best crm', 'site:acme.com', 'seo audit'],
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'SEARCH_OPERATOR');
  // Naming the keyword matters — this is a two-hundred-line paste.
  assert.match(out.error, /site:acme\.com/);
});

test('competitors are optional, and an omitted list is an empty one', () => {
  const out = S.readSiteForm({ ...GOOD_SITE, competitors: undefined });
  assert.equal(out.ok, true);
  assert.deepEqual(out.values.competitors, []);
  assert.equal(out.values.competitorCount, 0);
});

// ---------------------------------------------------------------------------
// 6. The mirror, inverted
// ---------------------------------------------------------------------------

const stubFind = (rows) => {
  const original = ConnectorProject.find;
  const filters = [];
  ConnectorProject.find = (filter) => {
    filters.push(filter);
    return { select: () => ({ lean: async () => rows }) };
  };
  return { filters, restore: () => { ConnectorProject.find = original; } };
};

const storedSite = (externalId, overrides = {}) => ({
  externalId,
  name: `Site ${externalId}`,
  domain: `${externalId}.com`,
  trackedKeywords: ['best crm', 'seo audit'],
  targets: [{ locationCode: 2840, languageCode: 'en', device: 'desktop', label: 'US' }],
  competitors: ['rival.com'],
  ...overrides,
});

test('listProjects reads OUR rows, scoped to the account', async () => {
  const stub = stubFind([storedSite('a'), storedSite('b')]);
  try {
    const out = await S.listProjects({ accountId: 'acc-1' });
    assert.deepEqual(stub.filters[0], { account: 'acc-1', provider: 'dataforseo' });
    assert.deepEqual(out.projects.map((p) => p.externalId), ['a', 'b']);
    assert.equal(out.projects[0].keywordCount, 2);
    assert.equal(out.projects[0].competitorCount, 1);
    assert.deepEqual(out.projects[0].locations, [{ locId: 2840, lang: 'en', label: 'US' }]);
    // Nothing came from an API, so there is no payload to keep.
    assert.equal(out.projects[0].raw, null);
  } finally {
    stub.restore();
  }
});

test('the listing carries NO authored field, so a refresh cannot overwrite one', async () => {
  // `projectMirror`'s `$set` writes exactly the keys it is handed. Keeping the
  // keyword list out of the listing is what makes a reconciliation a no-op on
  // the half of the row a person typed.
  const stub = stubFind([storedSite('a')]);
  try {
    const { projects } = await S.listProjects({ accountId: 'acc-1' });
    for (const key of ['trackedKeywords', 'targets', 'competitors', 'locallyAuthored']) {
      assert.equal(key in projects[0], false, `${key} leaked into the listing`);
    }
  } finally {
    stub.restore();
  }
});

test('the mirror can NEVER mark a site missing — by construction, not by a branch', async () => {
  // The property that matters. `diffProjects` computes the gone set as the
  // stored rows absent from the listing; a listing built FROM the stored rows
  // cannot omit one. So `missing` is unreachable here without a generic file
  // ever learning this provider's name.
  const rows = [storedSite('a'), storedSite('b'), storedSite('c')];
  const stub = stubFind(rows);
  try {
    const { projects } = await S.listProjects({ accountId: 'acc-1' });
    const existing = rows.map((r) => ({ externalId: r.externalId, missing: false }));
    const { upserts, goneIds } = diffProjects(existing, projects);

    assert.deepEqual(goneIds, []);
    assert.equal(upserts.length, 3);
  } finally {
    stub.restore();
  }
});

test('an account with no sites is an empty listing, and still marks nothing missing', async () => {
  // The shape that WOULD flag everything for a mirrored provider: an empty list.
  // Here it can only mean there are no sites, because there is nowhere else the
  // rows could have come from.
  const stub = stubFind([]);
  try {
    const { projects } = await S.listProjects({ accountId: 'acc-1' });
    assert.deepEqual(diffProjects([], projects).goneIds, []);
  } finally {
    stub.restore();
  }
});
