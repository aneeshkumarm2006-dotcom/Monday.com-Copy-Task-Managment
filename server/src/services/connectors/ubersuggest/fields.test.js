const test = require('node:test');
const assert = require('node:assert/strict');

const { FIELDS, FIELD_KEYS, getField, isField, readField } = require('./fields');
const { KIND_KEYS } = require('./kinds');
const { SOURCE_TYPES, ACCEPTS } = require('../fieldMapping');

/**
 * The mappable field catalog.
 *
 * Two halves worth testing, and they fail differently:
 *
 *   THE DECLARATIONS — a field naming a kind the provider does not collect, or
 *   a type no goal target accepts, is savable and then permanently unfillable.
 *   It looks exactly like "the sync has not run yet", which is why nobody
 *   reports it. These are the cheap tests that catch a typo in a new entry.
 *
 *   THE READERS — pure, and the part a provider shape change lands on. Every one
 *   must survive a payload it does not recognise by returning null, because a
 *   reader that threw would take an entire weekly run down with it. And the one
 *   null that is an ANSWER — a keyword outside the top 100 — must stay
 *   distinguishable from the null that means "we could not find it".
 */

// ---------------------------------------------------------------------------
// Fixtures — the normalised shapes fetchers.js actually stores
// ---------------------------------------------------------------------------

const positions = {
  done: true,
  updatedAt: new Date('2026-08-24T06:12:00.000Z'),
  keywords: [
    {
      keyword: 'seo agency london',
      status: 'ok',
      position: 4,
      previousPosition: 9,
      ranked: true,
      url: 'https://acme.com/seo',
      change: 5,
      movement: 'up',
    },
    {
      // Ranks nowhere in the top 100. `position: null` here is a FINAL answer.
      keyword: 'cheap seo',
      status: 'ok',
      position: null,
      previousPosition: null,
      ranked: true,
      url: null,
      change: null,
      movement: 'none',
    },
  ],
  averagePositions: [
    { date: '2026-08-10', value: 18.2 },
    { date: '2026-08-17', value: 16.4 },
    { date: '2026-08-24', value: null },
  ],
  totals: {
    tracked: 2,
    ranking: 1,
    notRanking: 1,
    pending: 0,
    improved: 1,
    declined: 0,
    unchanged: 0,
  },
  binned: {},
};

const keywordMetrics = {
  keywords: [
    {
      keyword: 'SEO Agency London',
      volume: 1400,
      cpc: 9.4,
      difficulty: 61,
      paidDifficulty: 38,
      competition: 0.72,
      intent: 'commercial',
    },
    {
      keyword: 'cheap seo',
      volume: null,
      cpc: null,
      difficulty: null,
      paidDifficulty: null,
      competition: null,
      intent: null,
    },
  ],
  trackedTotal: 2,
  truncated: false,
  cap: 100,
};

const domainOverview = {
  organicTraffic: 12400,
  organicKeywords: 830,
  domainAuthority: 41,
  backlinks: 9100,
  referringDomains: 320,
  trafficValue: 8600,
  overview: {},
};

const backlinks = {
  backlinks: 9100,
  referringDomains: 320,
  domainAuthority: 41,
  nofollow: 4000,
  dofollow: 5100,
  anchors: [],
  overview: {},
};

const siteAudit = {
  done: true,
  crawled: 148,
  crawlMaxPages: 150,
  extendedStatus: 'no_errors',
  healthScore: 78,
  categories: { errors: [], warnings: [], recommendations: [] },
  totals: { errors: 12, warnings: 41, recommendations: 6 },
  overview: {},
};

/** Which fixture belongs to which kind, so a test can loop the whole catalog. */
const DATA_BY_KIND = {
  positions,
  keyword_metrics: keywordMetrics,
  domain_overview: domainOverview,
  backlinks,
  site_audit: siteAudit,
};

// ---------------------------------------------------------------------------
// The declarations
// ---------------------------------------------------------------------------

test('every field names a kind this provider actually collects', () => {
  // A field whose kind is not collected can be mapped, saved, and then never
  // fills — and the symptom is indistinguishable from a sync that has not run.
  for (const field of FIELDS) {
    assert.ok(
      KIND_KEYS.includes(field.kind),
      `field "${field.key}" names kind "${field.kind}"`
    );
  }
});

test('every field has a type some goal target can accept', () => {
  for (const field of FIELDS) {
    assert.ok(
      SOURCE_TYPES.includes(field.type),
      `field "${field.key}" has type "${field.type}"`
    );
    assert.ok(ACCEPTS[field.type].length > 0);
  }
});

test('field keys are unique — they are the mapping row’s identity', () => {
  assert.equal(new Set(FIELD_KEYS).size, FIELD_KEYS.length);
});

test('every field declares a scope, because a rank and a traffic figure are not the same shape of fact', () => {
  // Keyword-scoped fields need phase 5's goal-to-keyword link before they can
  // resolve; project-scoped ones do not. Collapsing the two would mean filling a
  // keyword field from whichever row happened to be first.
  for (const field of FIELDS) {
    assert.ok(
      field.scope === 'keyword' || field.scope === 'project',
      `field "${field.key}" has scope "${field.scope}"`
    );
  }
});

test('every field has a label and a blurb — the panel renders both', () => {
  for (const field of FIELDS) {
    assert.ok(field.label && field.label.trim(), field.key);
    assert.ok(field.blurb && field.blurb.trim(), field.key);
  }
});

test('a keyword-scoped field always belongs to a kind that carries keyword rows', () => {
  for (const field of FIELDS.filter((f) => f.scope === 'keyword')) {
    assert.ok(
      ['positions', 'keyword_metrics'].includes(field.kind),
      `field "${field.key}" is keyword-scoped but reads ${field.kind}`
    );
  }
});

// ---------------------------------------------------------------------------
// The readers
// ---------------------------------------------------------------------------

test('rank, previous rank and movement come off the matching keyword row', () => {
  const ctx = { keyword: 'seo agency london' };
  assert.equal(readField('rank', positions, ctx), 4);
  assert.equal(readField('rank_previous', positions, ctx), 9);
  // Positive is an improvement — rank is inverted, and `movementOf` in
  // normalise.js states that convention once. Flipping it here would turn every
  // green arrow red.
  assert.equal(readField('rank_change', positions, ctx), 5);
  assert.equal(readField('ranking_url', positions, ctx), 'https://acme.com/seo');
});

test('a keyword outside the top 100 reads as null, and that null is the answer', () => {
  // The provider says `status: 'ok'` with a null position, and `llms.md` is
  // explicit that this is NOT a loading state. `nullMeans` carries the sentence
  // so every consumer says the same thing rather than rendering an empty cell.
  assert.equal(readField('rank', positions, { keyword: 'cheap seo' }), null);
  assert.ok(getField('rank').nullMeans);
  assert.match(getField('rank').nullMeans, /top 100/i);
});

test('rank_change does NOT claim the not-in-top-100 sentence', () => {
  // Its null means something else entirely — a keyword that entered or left the
  // top 100, where there is no pair of ranks to subtract. Reusing the sentence
  // would put "not in the top 100" on a keyword that is ranking.
  assert.ok(!getField('rank_change').nullMeans);
  assert.equal(readField('rank_change', positions, { keyword: 'cheap seo' }), null);
});

test('a keyword the snapshot has never seen reads as null, not as a throw', () => {
  // A keyword added to a project after the last collection is the normal case.
  assert.equal(readField('rank', positions, { keyword: 'brand new phrase' }), null);
  assert.equal(readField('volume', keywordMetrics, { keyword: 'brand new phrase' }), null);
});

test('keyword matching is case-insensitive', () => {
  // The phrase arrives from the provider on one side and is typed by a person on
  // the other. `match_keywords` has already been seen returning a different case
  // from the one the project tracks.
  assert.equal(readField('volume', keywordMetrics, { keyword: 'seo agency london' }), 1400);
  assert.equal(readField('volume', keywordMetrics, { keyword: 'SEO AGENCY LONDON' }), 1400);
});

test('SD and PD stay apart', () => {
  // `sd` is SEO difficulty and `pd` is paid difficulty. Mapping them the wrong
  // way round puts a paid number in a column labelled KD — a silent error of
  // exactly the class this whole feature exists to remove.
  const ctx = { keyword: 'seo agency london' };
  assert.equal(readField('seo_difficulty', keywordMetrics, ctx), 61);
  assert.equal(readField('paid_difficulty', keywordMetrics, ctx), 38);
});

test('a keyword-scoped read with no keyword is null rather than the first row', () => {
  // Guessing here would silently attribute one keyword's volume to a goal about
  // a different one, and the number would look perfectly plausible.
  assert.equal(readField('rank', positions, {}), null);
  assert.equal(readField('volume', keywordMetrics, {}), null);
});

test('project-scoped fields need no keyword', () => {
  assert.equal(readField('keywords_tracked', positions), 2);
  assert.equal(readField('keywords_ranking', positions), 1);
  assert.equal(readField('keywords_improved', positions), 1);
  assert.equal(readField('keywords_declined', positions), 0);
  assert.equal(readField('organic_traffic', domainOverview), 12400);
  assert.equal(readField('domain_authority', domainOverview), 41);
  assert.equal(readField('traffic_value', domainOverview), 8600);
  assert.equal(readField('backlinks_total', backlinks), 9100);
  assert.equal(readField('referring_domains', backlinks), 320);
  assert.equal(readField('health_score', siteAudit), 78);
  assert.equal(readField('audit_errors', siteAudit), 12);
  assert.equal(readField('audit_warnings', siteAudit), 41);
  assert.equal(readField('pages_crawled', siteAudit), 148);
});

test('the project average takes the last DATED point that has a value', () => {
  // The series legitimately carries a trailing null for a period the provider
  // has not filled in yet. Reading the last element blindly would report "no
  // average" on a project that has one.
  assert.equal(readField('average_position', positions), 16.4);
});

test('the project average is never recomputed from our own ranks', () => {
  // Ubersuggest counts a keyword outside the top 100 as +100 in this mean, so it
  // cannot be derived from the two ranks in the fixture. It is passed through
  // and labelled as the provider's own number.
  assert.match(getField('average_position').blurb, /provider|100/i);
  assert.notEqual(readField('average_position', positions), 4);
});

test('collected_on is the provider’s own collection day, as YYYY-MM-DD', () => {
  assert.equal(readField('collected_on', positions), '2026-08-24');
});

test('every reader survives a payload it does not recognise', () => {
  // A renamed field at the provider must be one null, not a failed weekly sync
  // for every account. Same rule the normalisers next door follow.
  const junk = [null, undefined, 42, 'nope', [], {}, { keywords: 'not an array' }];
  for (const field of FIELDS) {
    for (const data of junk) {
      assert.doesNotThrow(
        () => readField(field.key, data, { keyword: 'x' }),
        `${field.key} threw on ${JSON.stringify(data)}`
      );
      assert.equal(
        readField(field.key, data, { keyword: 'x' }),
        null,
        `${field.key} invented a value from ${JSON.stringify(data)}`
      );
    }
  }
});

test('a reader that throws is caught rather than escaping', () => {
  // Defence in depth around a future entry that dereferences too eagerly.
  const hostile = {
    get keywords() {
      throw new Error('boom');
    },
  };
  assert.doesNotThrow(() => readField('rank', hostile, { keyword: 'x' }));
  assert.equal(readField('rank', hostile, { keyword: 'x' }), null);
});

test('every field reads its own kind’s real shape without throwing', () => {
  for (const field of FIELDS) {
    const data = DATA_BY_KIND[field.kind];
    assert.doesNotThrow(
      () => readField(field.key, data, { keyword: 'seo agency london' }),
      field.key
    );
  }
});

test('a number field never returns NaN or a stringified number', () => {
  // A NaN in a goal cell scores as untracked and reads as a bug in the maths.
  const dirty = {
    keywords: [{ keyword: 'k', position: '4', volume: 'lots', difficulty: NaN }],
    totals: { tracked: '2' },
    healthScore: '78',
    organicTraffic: undefined,
  };
  for (const field of FIELDS.filter((f) => f.type === 'number')) {
    const value = readField(field.key, dirty, { keyword: 'k' });
    assert.ok(
      value === null || (typeof value === 'number' && Number.isFinite(value)),
      `${field.key} returned ${JSON.stringify(value)}`
    );
  }
});

test('a text or link field never returns an empty string', () => {
  // An empty string in a cell is indistinguishable from a value somebody typed
  // and then cleared, which is exactly the distinction phase 5's provenance
  // rules turn on.
  const blank = {
    keywords: [{ keyword: 'k', url: '   ', intent: '' }],
  };
  for (const field of FIELDS.filter((f) => f.type === 'text' || f.type === 'link')) {
    assert.equal(readField(field.key, blank, { keyword: 'k' }), null, field.key);
  }
});

// ---------------------------------------------------------------------------
// The lookup surface
// ---------------------------------------------------------------------------

test('an unknown field key reads null rather than throwing', () => {
  // A mapping row can outlive the field it names — somebody removes an entry
  // while a board still has it bound. A weekly run that crashed there would take
  // every other field down with it.
  assert.equal(getField('no_such_field'), null);
  assert.equal(isField('no_such_field'), false);
  assert.equal(readField('no_such_field', positions, { keyword: 'x' }), null);
});

test('getField and isField agree with the catalog', () => {
  for (const key of FIELD_KEYS) {
    assert.equal(isField(key), true);
    assert.equal(getField(key).key, key);
  }
});
