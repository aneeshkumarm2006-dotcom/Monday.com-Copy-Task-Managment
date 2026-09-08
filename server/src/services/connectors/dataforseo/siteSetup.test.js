const test = require('node:test');
const assert = require('node:assert/strict');

const sites = require('./sites');
const N = require('./normalise');
const L = require('./locations');

/**
 * The staged site setup: scopes, drafts, and the location catalog.
 *
 * Three things are being pinned here, and each one is pinned because getting it
 * wrong is expensive rather than merely wrong:
 *
 *   THE SCOPE PREDICATE, because it decides which SERP rows are read as the
 *     client's. Its default must stay bit-for-bit what it was before scopes
 *     existed, or every chart in the product gets a step change that looks like
 *     the client's SEO moving.
 *
 *   THE DRAFT READERS, because a draft is the one row shape allowed to be
 *     incomplete, and the guarantee that keeps that safe is that `readSiteForm`
 *     is still the ONLY way one becomes collectable.
 *
 *   THE COUNTRY CODES, because a wrong one is a valid code for a different
 *     country: nothing rejects it, and the first sign is a rank report that has
 *     been measuring the wrong market at full price.
 */

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

const item = (domain, url) => ({ domain, url });

test('the default scope is exactly the old behaviour: host plus subdomains', () => {
  const site = { domain: 'acme.com' };

  assert.equal(N.matchesTrackedSite(item('acme.com', 'https://acme.com/'), site), true);
  assert.equal(N.matchesTrackedSite(item('blog.acme.com', 'https://blog.acme.com/x'), site), true);

  // The two that `includes` would have got wrong, and which are exactly how a
  // rank tracker starts reporting a competitor's position as its client's.
  assert.equal(N.matchesTrackedSite(item('notacme.com', 'https://notacme.com/'), site), false);
  assert.equal(
    N.matchesTrackedSite(item('acme.com.evil.net', 'https://acme.com.evil.net/'), site),
    false
  );
});

test('an unknown scope falls back to the wide default rather than matching nothing', () => {
  /**
   * A snapshot taken before scopes existed, or a row written by a script that
   * does not know about them. Failing CLOSED here would silently blank the rank
   * history of every site in the workspace; the default is a real answer.
   */
  const site = { domain: 'acme.com', scope: 'something-else' };
  assert.equal(N.matchesTrackedSite(item('blog.acme.com', 'https://blog.acme.com/'), site), true);
});

test('`host` refuses subdomains, which is the whole point of it', () => {
  const site = { domain: 'acme.com', scope: 'host' };
  assert.equal(N.matchesTrackedSite(item('acme.com', 'https://acme.com/'), site), true);
  assert.equal(N.matchesTrackedSite(item('blog.acme.com', 'https://blog.acme.com/'), site), false);

  // `www.` is a different host and the domain normaliser deliberately keeps it,
  // so a site authored as the bare domain does not match the www one here.
  assert.equal(N.matchesTrackedSite(item('www.acme.com', 'https://www.acme.com/'), site), false);
});

test('`subfolder` narrows on the path, with the trailing slash forgiven', () => {
  const site = { domain: 'acme.com', scope: 'subfolder', scopePath: '/uk/' };

  assert.equal(N.matchesTrackedSite(item('acme.com', 'https://acme.com/uk/pricing'), site), true);
  // The folder itself, written without its trailing slash.
  assert.equal(N.matchesTrackedSite(item('acme.com', 'https://acme.com/uk'), site), true);
  assert.equal(N.matchesTrackedSite(item('acme.com', 'https://acme.com/de/pricing'), site), false);
  assert.equal(N.matchesTrackedSite(item('acme.com', 'https://acme.com/'), site), false);

  /**
   * THE PREFIX TRAP. `/uk` must not match `/ukraine`, which a bare
   * `startsWith` on the raw path would happily do — and would do silently,
   * folding a market nobody asked for into a client's numbers.
   */
  assert.equal(N.matchesTrackedSite(item('acme.com', 'https://acme.com/ukraine/x'), site), false);
});

test('a narrow scope treats a result with no URL as NOT ours', () => {
  /**
   * The safe direction to fail. The opposite would let a missing field widen a
   * scope back to the whole domain, which is the failure the field exists to
   * prevent.
   */
  const site = { domain: 'acme.com', scope: 'subfolder', scopePath: '/uk/' };
  assert.equal(N.matchesTrackedSite({ domain: 'acme.com' }, site), false);

  // The wide scopes need no URL and must not start requiring one.
  assert.equal(N.matchesTrackedSite({ domain: 'acme.com' }, { domain: 'acme.com' }), true);
});

test('`url` is one page, and a query string is not part of its identity', () => {
  const site = { domain: 'acme.com', scope: 'url', scopePath: '/pricing' };
  assert.equal(N.matchesTrackedSite(item('acme.com', 'https://acme.com/pricing'), site), true);
  assert.equal(N.matchesTrackedSite(item('acme.com', 'https://acme.com/pricing/'), site), true);
  assert.equal(
    N.matchesTrackedSite(item('acme.com', 'https://acme.com/pricing?utm=x'), site),
    true
  );
  assert.equal(N.matchesTrackedSite(item('acme.com', 'https://acme.com/pricing/pro'), site), false);
});

test('the rank read honours the scope, so two sites on one domain differ', () => {
  const payload = {
    keyword: 'best crm',
    items: [
      { type: 'organic', domain: 'acme.com', url: 'https://acme.com/de/crm', rank_group: 2 },
      { type: 'organic', domain: 'acme.com', url: 'https://acme.com/uk/crm', rank_group: 7 },
    ],
  };

  const whole = N.normaliseSerpResult(payload, { domain: 'acme.com' });
  assert.equal(whole.rank, 2, 'the whole domain takes the best position it has');

  const uk = N.normaliseSerpResult(payload, {
    domain: 'acme.com',
    scope: 'subfolder',
    scopePath: '/uk/',
  });
  assert.equal(uk.rank, 7, 'the UK site cannot claim the German page’s position');
  assert.equal(uk.ownUrls.length, 1);
  assert.equal(uk.ownUrls[0].url, 'https://acme.com/uk/crm');
});

// ---------------------------------------------------------------------------
// The form readers
// ---------------------------------------------------------------------------

const validSite = () => ({
  domain: 'acme.com',
  trackedKeywords: ['best crm'],
  targets: [{ locationCode: 2840, languageCode: 'en', device: 'desktop' }],
});

test('a scope needing a path is REFUSED without one, never defaulted', () => {
  /**
   * The silent widening this exists to stop: a subfolder scope with no folder
   * matches the whole domain, under a name that says otherwise.
   */
  const out = sites.readSiteForm({ ...validSite(), scope: 'subfolder' });
  assert.equal(out.ok, false);
  assert.match(out.error, /whole domain/);
});

test('a pasted URL is reduced to the path, because the host already lives elsewhere', () => {
  const out = sites.readSiteForm({
    ...validSite(),
    scope: 'subfolder',
    scopePath: 'https://acme.com/UK/?x=1',
  });
  assert.equal(out.ok, true);
  assert.equal(out.values.scopePath, '/uk/');
});

test('a wide scope drops any path it was sent, so a later switch cannot resurrect it', () => {
  const out = sites.readSiteForm({ ...validSite(), scope: 'domain', scopePath: '/uk/' });
  assert.equal(out.ok, true);
  assert.equal(out.values.scopePath, '');
});

test('the draft reader takes the first step and asks for nothing else', () => {
  const out = sites.readSiteDraft({ domain: 'https://www.acme.com/pricing' });
  assert.equal(out.ok, true);
  // `www.` is kept: for a rank tracker it is a different target.
  assert.equal(out.values.domain, 'www.acme.com');
  assert.equal(out.values.name, 'www.acme.com', 'the name defaults to the domain');
  assert.equal(out.values.scope, 'domain');

  // No keywords and no markets, and that is the whole point.
  assert.equal(out.values.trackedKeywords, undefined);
  assert.equal(out.values.targets, undefined);
});

test('a draft can be emptied; a live site cannot', () => {
  /**
   * Clearing the keyword box mid-setup is ordinary. A LIVE site with no
   * keywords is one that cannot be collected, which is why the full reader
   * refuses it — and why the draft path had to be a different function rather
   * than a flag on that one.
   */
  const draft = sites.readSiteDraftPatch({ trackedKeywords: [] });
  assert.equal(draft.ok, true);
  assert.deepEqual(draft.values.trackedKeywords, []);
  assert.equal(draft.values.keywordCount, 0);

  const live = sites.readSiteForm({ ...validSite(), trackedKeywords: [] });
  assert.equal(live.ok, false);
});

test('a draft patch writes ONLY what it was sent', () => {
  const out = sites.readSiteDraftPatch({ trackedKeywords: ['Best CRM ', 'best   crm'] });
  assert.equal(out.ok, true);
  // Normalised and deduplicated the same way the live reader does it — Google
  // is case-insensitive, and two spellings would be bought twice.
  assert.deepEqual(out.values.trackedKeywords, ['best crm']);
  assert.equal('targets' in out.values, false, 'a step nobody sent must not be written');
  assert.equal('domain' in out.values, false);
});

test('a draft patch still refuses what the live reader refuses', () => {
  /**
   * Otherwise the wizard would let somebody finish four steps and then reject
   * the first one at launch.
   */
  const operator = sites.readSiteDraftPatch({ trackedKeywords: ['site:acme.com'] });
  assert.equal(operator.ok, false);
  assert.equal(operator.code, 'SEARCH_OPERATOR');

  const badTarget = sites.readSiteDraftPatch({
    targets: [{ locationCode: 0, languageCode: 'en', device: 'desktop' }],
  });
  assert.equal(badTarget.ok, false);
});

test('a draft patch keeps the counts in step with the lists it carried', () => {
  const out = sites.readSiteDraftPatch({
    targets: [
      { locationCode: 2840, languageCode: 'en', device: 'desktop', label: 'US' },
      { locationCode: 2826, languageCode: 'en', device: 'mobile' },
    ],
  });
  assert.equal(out.ok, true);
  assert.equal(out.values.locations.length, 2);
  assert.equal(out.values.locations[0].locId, 2840);
});

// ---------------------------------------------------------------------------
// The location catalog
// ---------------------------------------------------------------------------

test('country codes follow the rule: 2000 + the ISO 3166-1 numeric code', () => {
  /**
   * Spot-checked against the codes an operator would recognise. The point of
   * the rule is that there is no hand-copied table to drift — but a rule
   * implemented backwards is still wrong, so the arithmetic is pinned.
   */
  const byName = new Map(L.COUNTRIES.map((c) => [c.name, c.locationCode]));
  assert.equal(byName.get('United States'), 2840);
  assert.equal(byName.get('United Kingdom'), 2826);
  assert.equal(byName.get('Canada'), 2124);
  assert.equal(byName.get('Australia'), 2036);
  assert.equal(byName.get('India'), 2356);
  assert.equal(byName.get('Germany'), 2276);
});

test('every country is unique and carries at least one language', () => {
  const codes = new Set();
  for (const country of L.COUNTRIES) {
    assert.equal(codes.has(country.locationCode), false, `${country.name} is duplicated`);
    codes.add(country.locationCode);
    assert.ok(country.languages.length > 0, `${country.name} has no language`);
    assert.match(country.countryIso, /^[A-Z]{2}$/);
  }
});

test('searching finds a country by name, by code, and without its accents', () => {
  assert.equal(L.searchCountries('united states')[0].locationCode, 2840);
  assert.equal(L.searchCountries('2840')[0].name, 'United States');
  assert.equal(L.searchCountries('turkiye')[0].locationCode, 2792, 'accents are folded');

  // A prefix beats a substring, so the obvious answer is first.
  assert.equal(L.searchCountries('ind')[0].name, 'India');
});

test('a bare number is read as a code and nothing else', () => {
  /**
   * The escape hatch that keeps every market reachable for somebody who already
   * has the code — and the only confirmation available that the code they
   * pasted is the country they meant.
   */
  assert.deepEqual(L.searchCountries('999999'), []);
});

test('searching inside a country ranks a prefix above a substring', () => {
  const rows = [
    { locationCode: 1, name: 'New York,New York,United States', type: 'city' },
    { locationCode: 2, name: 'Yorkshire,England,United Kingdom', type: 'region' },
    { locationCode: 3, name: 'York,England,United Kingdom', type: 'city' },
  ];
  const hits = L.searchWithin(rows, 'york');
  assert.equal(hits[0].locationCode, 3, 'the exact-prefix name comes first');
  assert.ok(hits.some((r) => r.locationCode === 1), 'a word-boundary match still appears');
});

test('a stored target reads back as a sentence, not as an integer', () => {
  assert.equal(
    L.describeTarget({ locationCode: 2840, languageCode: 'en', device: 'desktop' }),
    'United States, English (desktop)'
  );
  // A city, whose code is not in the shipped catalog, still says something.
  assert.match(
    L.describeTarget({ locationCode: 1023191, languageCode: 'en', device: 'mobile' }),
    /^Location 1023191, English \(mobile\)$/
  );
});
