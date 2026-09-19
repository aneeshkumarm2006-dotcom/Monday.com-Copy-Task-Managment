const test = require('node:test');
const assert = require('node:assert/strict');

const ConnectorSnapshot = require('../../models/ConnectorSnapshot');
const {
  buildSiteIndex,
  visibilityOf,
  deltaBetween,
  CTR_CURVE,
} = require('./siteIndex');

/**
 * The site index — the arithmetic behind one row of the sites table.
 *
 * Everything asserted here is a rule that would be invisible if it broke. A
 * visibility score with the wrong denominator, a delta computed against a
 * missing reading, or two markets averaged into one number all render as a
 * perfectly plausible figure in a cell, and the cell is what somebody quotes to
 * a client.
 */

const PROJECT = '6a466b99ea3ab35ff1378e40';
const OTHER = '6a466b99ea3ab35ff1378e41';

const chain = (value) => {
  const self = {
    sort: () => self,
    select: () => self,
    lean: () => Promise.resolve(value),
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
  };
  return self;
};

const stubSnapshots = (rows) => {
  const original = ConnectorSnapshot.find;
  ConnectorSnapshot.find = () => chain(rows);
  return () => {
    ConnectorSnapshot.find = original;
  };
};

const positions = (overrides = {}) => ({
  project: PROJECT,
  kind: 'positions',
  variant: 'desktop|en|2840',
  collectedAt: new Date('2026-08-24T06:00:00Z'),
  fetchedAt: new Date('2026-08-24T07:00:00Z'),
  ...overrides,
  data: {
    totals: { tracked: 4, ranked: 3, top3: 1, top10: 2, averageRank: 6.3 },
    keywords: [
      { keyword: 'a', rank: 1 },
      { keyword: 'b', rank: 8 },
      { keyword: 'c', rank: 10 },
      { keyword: 'd', rank: null },
    ],
    ...(overrides.data || {}),
  },
});

const project = (overrides = {}) => ({
  _id: PROJECT,
  name: 'Acme',
  domain: 'acme.com',
  status: 'live',
  ...overrides,
});

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

test('visibility divides by what is TRACKED, not by what ranks', async () => {
  /**
   * The rule that decides whether the column means anything. One keyword at #1
   * out of a hundred is not a visible site — and dividing by the ranked count
   * would score it 100, which is the same number a site ranking first for
   * everything would get.
   */
  const one = visibilityOf([{ rank: 1 }]);
  const oneOfHundred = visibilityOf([
    { rank: 1 },
    ...Array.from({ length: 99 }, () => ({ rank: null })),
  ]);
  assert.equal(one, 100);
  assert.ok(oneOfHundred < 2, `expected a low score, got ${oneOfHundred}`);
});

test('an unmeasured keyword scores zero rather than being dropped', () => {
  // Dropping it would silently shrink the denominator and inflate the score of
  // exactly the sites whose collections are failing.
  assert.ok(visibilityOf([{ rank: 1 }, { rank: null }]) < visibilityOf([{ rank: 1 }]));
});

test('a rank past the end of the curve earns nothing, and does not throw', () => {
  assert.equal(visibilityOf([{ rank: CTR_CURVE.length + 40 }]), 0);
});

test('no keywords is null, never zero', () => {
  // "We looked and found nothing" and "we did not look" are opposite findings.
  assert.equal(visibilityOf([]), null);
  assert.equal(visibilityOf(null), null);
});

test('the other provider’s spelling of a rank is read too', () => {
  // The first connector normalises to `position`, the second to `rank`. Neither
  // is being renamed — see `rankRows.js`.
  assert.equal(visibilityOf([{ position: 1 }]), 100);
});

// ---------------------------------------------------------------------------
// Deltas
// ---------------------------------------------------------------------------

test('a delta needs a number on BOTH sides', () => {
  const out = deltaBetween(
    { backlinks: 120, siteHealth: 91, visibility: 40 },
    { backlinks: 100, siteHealth: null }
  );
  assert.equal(out.backlinks, 20);
  // Not 91, and not 0. An absent key is how "unknown" is said.
  assert.equal('siteHealth' in out, false);
  assert.equal('visibility' in out, false);
});

test('there is no delta at all against a first collection', () => {
  assert.deepEqual(deltaBetween({ backlinks: 120 }, null), {});
});

// ---------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------

test('a row carries the stored totals rather than a second count of them', async () => {
  const restore = stubSnapshots([positions()]);
  try {
    const index = await buildSiteIndex([project()]);
    const row = index.get(PROJECT);
    assert.equal(row.metrics.tracked, 4);
    assert.equal(row.metrics.ranking, 3);
    assert.equal(row.metrics.averageRank, 6.3);
    assert.equal(row.has.positions, true);
    assert.equal(row.has.backlinks, false);
  } finally {
    restore();
  }
});

test('two markets are not averaged into a market that does not exist', async () => {
  /**
   * A US rank and a UK rank for the same keyword are two facts. The table shows
   * the newest one's and says which; mixing them would produce a number that is
   * about no market at all.
   */
  const restore = stubSnapshots([
    positions({ variant: 'desktop|en|2840' }),
    positions({
      variant: 'desktop|en-GB|2826',
      collectedAt: new Date('2026-08-24T05:00:00Z'),
      data: { totals: { tracked: 4, ranked: 4, top3: 4, top10: 4, averageRank: 1.2 } },
    }),
  ]);
  try {
    const index = await buildSiteIndex([project()]);
    const row = index.get(PROJECT);
    assert.equal(row.variant, 'desktop|en|2840');
    assert.equal(row.metrics.averageRank, 6.3);
    // The other market contributed nothing — not to the numbers and not to the
    // delta, which would otherwise read as a collapse between two collections.
    assert.deepEqual(row.deltas, {});
  } finally {
    restore();
  }
});

test('a draft is a row of nothing, and is never queried for', async () => {
  let asked = null;
  const original = ConnectorSnapshot.find;
  ConnectorSnapshot.find = (filter) => {
    asked = filter;
    return chain([]);
  };
  try {
    const index = await buildSiteIndex([project({ status: 'draft' })]);
    assert.equal(index.get(PROJECT).metrics, null);
    // Nothing to ask about, so nothing was asked.
    assert.equal(asked, null);
  } finally {
    ConnectorSnapshot.find = original;
  }
});

test('a site with no readings gets a row, not an absence', async () => {
  // The table has to draw it — that is the whole point of listing unmapped and
  // never-collected sites — so the row exists and its cells are em dashes.
  const restore = stubSnapshots([]);
  try {
    const index = await buildSiteIndex([project({ _id: OTHER })]);
    const row = index.get(OTHER);
    assert.ok(row);
    assert.equal(row.metrics, null);
    assert.equal(row.collectedAt, null);
  } finally {
    restore();
  }
});
