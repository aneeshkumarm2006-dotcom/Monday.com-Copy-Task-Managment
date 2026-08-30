import { BLANK, sortRowsBy } from './rankRows.js';

/**
 * Turning stored Backlinks snapshots into the rows the Backlinks screen draws.
 *
 * ---- Why this is a third file beside `rankRows.js` and `labsRows.js` -------
 *
 * `rankRows.js` owns the three-way RANK rule — a number, a definite "not
 * ranking", and no reading at all — and `labsRows.js` owns the competitive
 * index's tables. Neither rule fits here, and one of them fits so badly that
 * borrowing it would be the phase's worst bug:
 *
 *   A BACKLINK RANK IS NOT A SERP POSITION. `connectorFormat.formatRank` renders
 *   a null as "Not in top 100" whenever the provider answered, because on a rank
 *   tracker a null IS an answer. A domain rank of null means we have no reading
 *   — the profile call failed, or the field was absent. Routed through
 *   `formatRank` every unreadable domain rank would read as "Not in top 100",
 *   which is a sentence about search results, on a panel about links, that is
 *   never true. So `formatDomainRank` below is its own two-way function and this
 *   file never imports `formatRank`.
 *
 * What IS shared is the blanks-last comparator, imported rather than copied for
 * the reason `labsRows.js` gives: another copy of "a null must not sort as a
 * zero" is another chance for one table to disagree with the others.
 *
 * ---- The three traps, on the client side -----------------------------------
 *
 * 1. `rank` IS 0-1000 AND IS DATAFORSEO'S OWN. Never DA, never DR — they say
 *    themselves that the values should not be expected to match Ahrefs. The
 *    scale is stored on the snapshot because the conversion to 0-100 is
 *    `sin(rank / 636.62) * 100` and is not recoverable from the number, so
 *    `rankCeiling` reads the stored scale rather than assuming one. And
 *    `linksRank` on a referring-domain row is NOT that domain's authority: it is
 *    the rank of the links it sends US, which is why the column is labelled
 *    "Link strength" and never "Authority".
 *
 * 2. DOFOLLOW IS NEVER COMPUTED HERE. It arrives from a second filtered call or
 *    it is null. `referringDomains - referringDomainsNofollow` is not the
 *    dofollow count, because `*_nofollow` means "at least one nofollow link" and
 *    so overlaps rather than partitions. There is deliberately no function in
 *    this file that could be mistaken for one that does it.
 *
 * 3. `backlinks_status_type` RECOMPUTES THE AGGREGATES. Two readings taken under
 *    different status types are two measurements of two different graphs, so
 *    `comparability` below is asked before any delta is drawn and the screen
 *    prints why rather than a number when the answer is no.
 *
 * ---- And the rule all three files share ------------------------------------
 *
 * A MISSING NUMBER IS NULL AND RENDERS AS AN EM DASH. "This site has no broken
 * backlinks" and "we could not read the broken-backlink field" are opposite
 * facts and `|| 0` makes them the same pixel.
 */

// ---------------------------------------------------------------------------
// Rank — 0-1000, theirs, and never anybody else's name for it
// ---------------------------------------------------------------------------

/** What the stored scale tops out at. Their two scales, their two ceilings. */
export const RANK_CEILINGS = { one_thousand: 1000, one_hundred: 100 };

export const rankCeiling = (scale) => RANK_CEILINGS[scale] || RANK_CEILINGS.one_thousand;

/**
 * A DataForSEO domain rank, or an em dash.
 *
 * ---- Why this is not `formatRank` -------------------------------------------
 *
 * `formatRank` owns the SERP three-way rule: a number, "Not in top 100" when the
 * provider answered with a null, and an em dash when there is no reading. That
 * middle case is the whole reason it exists and it is MEANINGLESS here — a
 * missing domain rank is a missing reading, and rendering it as "Not in top 100"
 * would put a sentence about search results on a panel about links.
 *
 * It is also never rendered bare. The caller pairs it with the scale, because
 * 562 and 56 are the same fact and the number cannot say which one it is.
 *
 * @param {number|null} value
 * @returns {string}
 */
export const formatDomainRank = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? String(Math.round(value)) : '—';

/**
 * The caption that travels with every rank on this screen.
 *
 * A sentence rather than a label, because the thing worth saying is not "0-1000"
 * — it is "this is DataForSEO's number and it is not the one your other tool
 * shows you". A client comparing a rank of 562 against an Ahrefs DR of 61 and
 * finding them different is right to; they are different measurements and
 * DataForSEO says so.
 */
export const RANK_CAPTION =
  "DataForSEO's own rank, 0–1000. It is not Domain Authority or Domain Rating and " +
  'is not expected to match them.';

// ---------------------------------------------------------------------------
// Spam score bands
// ---------------------------------------------------------------------------

/**
 * The DOMAIN-level bands. There is a second, different set at link level
 * (0-44 / 45-59 / 60-100) and using one for the other misreports by a whole
 * band, so this file carries only the one it draws.
 */
export const SPAM_BANDS = [
  { key: 'low', label: 'Low (0–30)', min: 0, max: 30, tone: 'positive' },
  { key: 'medium', label: 'Medium (31–60)', min: 31, max: 60, tone: 'neutral' },
  { key: 'high', label: 'High (61–100)', min: 61, max: 100, tone: 'negative' },
];

export const spamBandFor = (score) => {
  if (typeof score !== 'number' || !Number.isFinite(score)) return null;
  return SPAM_BANDS.find((b) => score >= b.min && score <= b.max) || null;
};

// ---------------------------------------------------------------------------
// Freshness, and what may be compared with what
// ---------------------------------------------------------------------------

/**
 * The freshness facts a Backlinks panel is stamped with.
 *
 * Deliberately NOT `labsRows.labsFreshness`. That one carries `indexUpdatedAt`,
 * which is the day DataForSEO last rebuilt the Labs database and is the whole
 * reason those panels say "competitive index" rather than "live". The backlink
 * index is rebuilt continuously, so there is no rebuild date to show and the
 * honest footnote is its SIZE plus one caveat: the per-domain recrawl interval
 * is undocumented, so "live" is a claim about the index and not a promise about
 * any one link in it.
 *
 * @param {Object|null} snapshot
 * @returns {Object}
 */
export const backlinkFreshness = (snapshot) => ({
  collectedAt: snapshot?.collectedAt || snapshot?.fetchedAt || null,
  statusType: snapshot?.data?.statusType || null,
  rankScale: snapshot?.data?.rankScale || null,
  index: snapshot?.data?.index || null,
  status: snapshot?.status || null,
  note: snapshot?.note || '',
});

/**
 * May these two readings be put beside each other as a change?
 *
 * ---- The trap this is the whole answer to ----------------------------------
 *
 * `backlinks_status_type` (`all | live | lost`) RECOMPUTES every aggregate over
 * a different corpus rather than filtering rows — DataForSEO's own documentation
 * example shows one domain at rank 509 under `lost` and 562 under `live`. So a
 * reading taken under one and a reading taken under the other are measurements
 * of two different graphs, and subtracting them draws a movement of 53 points
 * that never happened.
 *
 * `rankScale` is the same shape of problem one notch smaller: 562 and 56 are the
 * same fact, and a series that changed scale under itself would show a 90%
 * collapse.
 *
 * Both are stored on every snapshot for this one purpose. The answer is a REASON
 * rather than a boolean, because the screen prints it — "these two readings were
 * taken differently" is information, and a silently missing delta is not.
 *
 * A SECOND COPY OF THIS RULE NOW EXISTS, on the server, and it is named here so
 * the pair can be kept honest: `server/src/services/connectors/dataforseo/
 * comparability.js` asks the same question for the GOAL WRITEBACK, where
 * `config.baseline` and `actual` are the two ends of a graded score and there is
 * no caption for a refusal to print. There is no module both packages can
 * import, so what holds them together is the identical `{ok, reason}` shape.
 *
 * @param {Object|null} current - a snapshot's `data`
 * @param {Object|null} previous
 * @returns {{ok: boolean, reason: string}}
 */
export const comparability = (current, previous) => {
  if (!current || !previous) return { ok: false, reason: '' };

  if (current.statusType && previous.statusType && current.statusType !== previous.statusType) {
    return {
      ok: false,
      reason:
        `These two readings were taken over different link sets — "${previous.statusType}" ` +
        `then "${current.statusType}". Changing that recomputes every number rather than ` +
        'filtering rows, so the difference between them is not a change in the profile.',
    };
  }

  if (current.rankScale && previous.rankScale && current.rankScale !== previous.rankScale) {
    return {
      ok: false,
      reason:
        'These two readings are on different rank scales, so their difference is a change ' +
        'of units rather than a change in the profile.',
    };
  }

  return { ok: true, reason: '' };
};

/**
 * A signed change between two readings, or null.
 *
 * Returns null rather than a number whenever `comparability` says no, which is
 * what makes the refusal impossible to route around: a caller that forgets to
 * check gets no delta instead of a wrong one.
 *
 * @param {Object|null} current - a snapshot's `data`
 * @param {Object|null} previous
 * @param {(data: Object) => number|null} pick
 * @returns {number|null}
 */
export const deltaOf = (current, previous, pick) => {
  if (!comparability(current, previous).ok) return null;
  const now = pick(current);
  const then = pick(previous);
  if (typeof now !== 'number' || typeof then !== 'number') return null;
  return now - then;
};

/**
 * Is this board paying to collect the kind a panel draws?
 *
 * Re-exported from `labsRows` rather than reimplemented — `BoardConnector.kinds`
 * is what gets BOUGHT and `enabledScreens` is what gets RENDERED, and that rule
 * does not change per screen.
 */
export { isKindCollected } from './labsRows.js';

// ---------------------------------------------------------------------------
// The profile
// ---------------------------------------------------------------------------

const numberOr = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/**
 * The hero numbers, from the `backlinks_summary` snapshot.
 *
 * ---- What this function will not do ----------------------------------------
 *
 * Compute a dofollow count. `dofollow` is whatever the second, filtered `summary`
 * call answered, or null. There is no `else` branch and no arithmetic anywhere
 * in this file that could become one.
 *
 * @param {Object|null} snapshot
 * @returns {Object|null}
 */
export const profileFrom = (snapshot) => {
  const data = snapshot?.data || null;
  const profile = data?.profile || null;
  if (!profile) return null;

  const dofollow = data.dofollow || null;

  return {
    domain: data.domain || null,
    statusType: data.statusType || null,
    rankScale: data.rankScale || null,

    /** 0-1000, theirs, never DA or DR. See `RANK_CAPTION`. */
    rank: numberOr(profile.rank),
    rankCeiling: rankCeiling(data.rankScale),

    backlinks: numberOr(profile.backlinks),
    backlinksNofollow: numberOr(profile.backlinksNofollow),
    referringDomains: numberOr(profile.referringDomains),
    referringMainDomains: numberOr(profile.referringMainDomains),
    /**
     * "Referrers sending AT LEAST ONE nofollow link" — carried under a name that
     * says so, because the short name is what makes the subtraction look
     * reasonable.
     */
    referringDomainsWithAnyNofollow: numberOr(profile.referringDomainsNofollow),
    referringPages: numberOr(profile.referringPages),
    referringIps: numberOr(profile.referringIps),
    referringSubnets: numberOr(profile.referringSubnets),

    /** FROM THE SECOND CALL. Null is an em dash, never a subtraction. */
    dofollowBacklinks: dofollow ? numberOr(dofollow.backlinks) : null,
    dofollowReferringDomains: dofollow ? numberOr(dofollow.referringDomains) : null,
    dofollowMeasured: !!dofollow,

    brokenBacklinks: numberOr(profile.brokenBacklinks),
    brokenPages: numberOr(profile.brokenPages),
    spamScore: numberOr(profile.spamScore),
    spamBand: spamBandFor(numberOr(profile.spamScore)),
    crawledPages: numberOr(profile.crawledPages),
    firstSeen: profile.firstSeen || null,

    breakdowns: profile.breakdowns || null,
    index: data.index || null,
  };
};

/**
 * The share of referring domains that send at least one FOLLOWED link.
 *
 * ---- Why this is a ratio of two measured numbers and not a derived count ----
 *
 * Both terms come from a call that was actually made — the filtered `summary`
 * over the unfiltered one — so the ratio is two facts divided, not a fact and an
 * assumption. Null unless both are present, because a percentage with an
 * invented numerator is a made-up number wearing a percent sign.
 *
 * @param {Object|null} profile - from `profileFrom`
 * @returns {number|null} 0-1
 */
export const dofollowShare = (profile) => {
  const top = profile?.dofollowReferringDomains;
  const bottom = profile?.referringDomains;
  if (typeof top !== 'number' || typeof bottom !== 'number' || bottom <= 0) return null;
  return Math.round((top / bottom) * 1000) / 1000;
};

/**
 * The authority tiles: our own domain and the competitors it was bought beside.
 *
 * Sorted with ourselves first and everybody else by rank, so the comparison the
 * row exists to make is the one it reads as.
 *
 * @param {Object|null} snapshot
 * @returns {Array<Object>}
 */
export const authorityRowsFrom = (snapshot) => {
  const rows = Array.isArray(snapshot?.data?.authority) ? snapshot.data.authority : [];
  return rows
    .map((row) => ({
      target: String(row.target || ''),
      /** From `bulk_ranks` and NOWHERE ELSE. Not a referring domain's rank. */
      authorityRank: numberOr(row.authorityRank),
      isSelf: !!row.isSelf,
    }))
    .sort((a, b) => {
      if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
      return (b.authorityRank ?? -1) - (a.authorityRank ?? -1);
    });
};

/**
 * One breakdown map as chart-ready slices, with a share each.
 *
 * @param {Array<{key: string, count: number}>|null} rows
 * @param {number} [top]
 * @returns {Array<Object>}
 */
export const breakdownSlices = (rows, top = 8) => {
  if (!Array.isArray(rows) || !rows.length) return [];
  const total = rows.reduce((sum, r) => sum + (r.count || 0), 0);
  if (!total) return [];
  return rows.slice(0, top).map((row) => ({
    key: row.key,
    count: row.count,
    share: Math.round((row.count / total) * 1000) / 1000,
  }));
};

// ---------------------------------------------------------------------------
// Referring domains
// ---------------------------------------------------------------------------

/**
 * @param {Object|null} snapshot - the `referring_domains` snapshot
 * @returns {Array<Object>}
 */
export const referringDomainRowsFrom = (snapshot) => {
  const rows = Array.isArray(snapshot?.data?.domains) ? snapshot.data.domains : [];
  return rows.map((row) => ({
    domain: String(row.domain || ''),
    /**
     * THE RANK OF THE LINKS THIS DOMAIN SENDS US — not its own authority. The
     * column header says "Link strength" for exactly this reason: read as
     * authority, a directory sending four hundred sitewide links outranks a
     * newspaper sending one editorial link.
     */
    linksRank: numberOr(row.linksRank),
    backlinks: numberOr(row.backlinks),
    referringPages: numberOr(row.referringPages),
    brokenBacklinks: numberOr(row.brokenBacklinks),
    spamScore: numberOr(row.spamScore),
    spamBand: spamBandFor(numberOr(row.spamScore)),
    firstSeen: row.firstSeen || null,
    lostDate: row.lostDate || null,
  }));
};

export const REFERRING_DOMAIN_BUCKETS = [
  ...SPAM_BANDS.map((band) => ({
    key: `spam:${band.key}`,
    group: 'Spam score',
    label: band.label,
    test: (r) => r.spamBand?.key === band.key,
  })),
  {
    key: 'broken',
    group: 'Health',
    label: 'Has a broken link to us',
    test: (r) => typeof r.brokenBacklinks === 'number' && r.brokenBacklinks > 0,
  },
  {
    key: 'single',
    group: 'Shape',
    label: 'Links to us once',
    test: (r) => r.backlinks === 1,
  },
  {
    /**
     * The sitewide-footer signature, and the reason the table is not sorted by
     * `backlinks`. Fifty links from one domain is one editorial decision
     * repeated, not fifty of them.
     */
    key: 'sitewide',
    group: 'Shape',
    label: 'Links 50+ times (likely sitewide)',
    test: (r) => typeof r.backlinks === 'number' && r.backlinks >= 50,
  },
];

const bucketTests = (buckets, catalog) =>
  buckets.map((k) => catalog.find((b) => b.key === k)).filter(Boolean);

export const filterReferringDomainRows = (rows, { query = '', buckets = [] } = {}) => {
  const needle = query.trim().toLowerCase();
  const active = bucketTests(buckets, REFERRING_DOMAIN_BUCKETS);
  return rows.filter((row) => {
    if (needle && !row.domain.toLowerCase().includes(needle)) return false;
    if (!active.length) return true;
    return active.some((b) => b.test(row));
  });
};

const referringDomainValueOf = (row, key) => {
  switch (key) {
    case 'domain':
      return row.domain.toLowerCase();
    case 'linksRank':
      return row.linksRank ?? BLANK;
    case 'backlinks':
      return row.backlinks ?? BLANK;
    case 'brokenBacklinks':
      return row.brokenBacklinks ?? BLANK;
    case 'spamScore':
      return row.spamScore ?? BLANK;
    case 'firstSeen':
      return row.firstSeen || BLANK;
    default:
      return BLANK;
  }
};

export const sortReferringDomainRows = (rows, sort) =>
  sortRowsBy(rows, sort, referringDomainValueOf);

// ---------------------------------------------------------------------------
// Anchors
// ---------------------------------------------------------------------------

/**
 * The five kinds of anchor text, in the order a report reads them.
 *
 * Classified on the CLIENT because it needs the site's own name, which is a fact
 * about the Site and not about the payload — and because the classification is a
 * judgement that will be argued with, so it belongs where it can be changed
 * without re-buying a hundred rows.
 */
export const ANCHOR_CLASSES = [
  { key: 'branded', label: 'Branded' },
  { key: 'url', label: 'Bare URL' },
  { key: 'generic', label: 'Generic' },
  { key: 'empty', label: 'Empty / image' },
  { key: 'other', label: 'Other' },
];

/**
 * The words that mean nothing on their own.
 *
 * A profile heavy in these is a profile built by people who could not think of
 * anything to say about the page, which is a finding — and it is a different
 * finding from an exact-match profile, so the two classes stay apart.
 */
const GENERIC_ANCHORS = new Set([
  'click here',
  'here',
  'this',
  'read more',
  'more',
  'link',
  'this link',
  'website',
  'this website',
  'visit',
  'visit site',
  'learn more',
  'source',
  'homepage',
  'home page',
  'see more',
  'find out more',
]);

/**
 * The brand terms a domain implies.
 *
 * `acme.com` gives `acme`; `acme-crm.co.uk` gives `acme-crm`, `acme` and `crm`.
 * Deliberately generous, because the failure that matters is the other way
 * round: a branded anchor misfiled as "other" inflates the number a person is
 * about to act on.
 *
 * @param {string} domain
 * @returns {string[]}
 */
export const brandTermsFor = (domain) => {
  const host = String(domain || '')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0];
  if (!host) return [];
  const name = host.split('.')[0];
  if (!name) return [];
  const parts = name.split(/[-_]/).filter((p) => p.length > 2);
  return [...new Set([name, ...parts])];
};

/**
 * Which of the five an anchor is.
 *
 * @param {string} anchor
 * @param {string[]} brandTerms
 * @returns {string}
 */
export const classifyAnchor = (anchor, brandTerms = []) => {
  const text = String(anchor ?? '').trim().toLowerCase();
  /** An image link with no alt text. A real anchor and a real finding. */
  if (!text) return 'empty';
  if (/^(https?:\/\/|www\.)/.test(text) || /^[a-z0-9-]+\.[a-z]{2,}(\/|$)/.test(text)) {
    return 'url';
  }
  if (brandTerms.some((term) => term && text.includes(term))) return 'branded';
  if (GENERIC_ANCHORS.has(text)) return 'generic';
  return 'other';
};

/**
 * @param {Object|null} snapshot - the `anchors` snapshot
 * @param {string} domain
 * @returns {Array<Object>}
 */
export const anchorRowsFrom = (snapshot, domain) => {
  const rows = Array.isArray(snapshot?.data?.anchors) ? snapshot.data.anchors : [];
  const brandTerms = brandTermsFor(domain);
  /**
   * THE DENOMINATOR, in the units the cloud is weighted in. Taken from the
   * snapshot's own total so a share on screen cannot be computed against
   * `backlinks` in one place and `referringMainDomains` in another.
   */
  const weight = snapshot?.data?.totals?.weight || null;

  return rows.map((row) => {
    const domains = numberOr(row.referringMainDomains);
    return {
      anchor: typeof row.anchor === 'string' ? row.anchor : '',
      /**
       * THE WEIGHT. Never `backlinks`: one sitewide footer repeated across forty
       * thousand pages would otherwise be the entire anchor profile, for a
       * phrase exactly one person chose.
       */
      referringMainDomains: domains,
      referringDomains: numberOr(row.referringDomains),
      backlinks: numberOr(row.backlinks),
      spamScore: numberOr(row.spamScore),
      spamBand: spamBandFor(numberOr(row.spamScore)),
      /** Rounded like every other ratio here, so an export prints 70% and not 0.699999. */
      share:
        typeof domains === 'number' && weight
          ? Math.round((domains / weight) * 1000) / 1000
          : null,
      klass: classifyAnchor(row.anchor, brandTerms),
    };
  });
};

/**
 * The anchor profile as five shares.
 *
 * Computed over `referringMainDomains` for the same reason the cloud is sized by
 * it — "38% of the domains linking to you use your brand name" is a sentence
 * about link builders, and the `backlinks` version is a sentence about one
 * website's template.
 *
 * @param {Array<Object>} rows
 * @returns {Array<Object>}
 */
export const anchorMix = (rows) => {
  const weighted = rows.filter((r) => typeof r.referringMainDomains === 'number');
  const total = weighted.reduce((sum, r) => sum + r.referringMainDomains, 0);
  return ANCHOR_CLASSES.map((klass) => {
    const mine = weighted.filter((r) => r.klass === klass.key);
    const count = mine.reduce((sum, r) => sum + r.referringMainDomains, 0);
    return {
      ...klass,
      anchors: rows.filter((r) => r.klass === klass.key).length,
      domains: count,
      share: total ? Math.round((count / total) * 1000) / 1000 : null,
    };
  }).filter((k) => k.anchors > 0);
};

export const ANCHOR_BUCKETS = ANCHOR_CLASSES.map((klass) => ({
  key: `class:${klass.key}`,
  group: 'Anchor type',
  label: klass.label,
  test: (r) => r.klass === klass.key,
}));

export const filterAnchorRows = (rows, { query = '', buckets = [] } = {}) => {
  const needle = query.trim().toLowerCase();
  const active = bucketTests(buckets, ANCHOR_BUCKETS);
  return rows.filter((row) => {
    if (needle && !row.anchor.toLowerCase().includes(needle)) return false;
    if (!active.length) return true;
    return active.some((b) => b.test(row));
  });
};

const anchorValueOf = (row, key) => {
  switch (key) {
    case 'anchor':
      return row.anchor ? row.anchor.toLowerCase() : BLANK;
    case 'referringMainDomains':
      return row.referringMainDomains ?? BLANK;
    case 'backlinks':
      return row.backlinks ?? BLANK;
    case 'spamScore':
      return row.spamScore ?? BLANK;
    case 'klass':
      return row.klass;
    default:
      return BLANK;
  }
};

export const sortAnchorRows = (rows, sort) => sortRowsBy(rows, sort, anchorValueOf);

// ---------------------------------------------------------------------------
// The growth series
// ---------------------------------------------------------------------------

/**
 * The stored timeseries as chart points.
 *
 * ---- Why nothing here fills a gap -------------------------------------------
 *
 * A month the index has no LEVEL for is a month with no reading, and the chart
 * draws it as a gap (`connectNulls={false}`, the same rule the rank chart
 * follows). Carrying the previous month forward would draw a flat line, which is
 * a claim that nothing changed — and "we have no reading" is not that claim.
 *
 * @param {Object|null} snapshot - the `backlinks_timeseries` snapshot
 * @returns {Array<Object>}
 */
export const growthPointsFrom = (snapshot) => {
  const points = Array.isArray(snapshot?.data?.points) ? snapshot.data.points : [];
  return points.map((p) => ({
    date: String(p.date || ''),
    backlinks: numberOr(p.backlinks),
    referringDomains: numberOr(p.referringDomains),
    rank: numberOr(p.rank),
    newBacklinks: numberOr(p.newBacklinks),
    /**
     * A POSITIVE COUNT of links lost, kept positive.
     *
     * The bar chart negates it at draw time so gains and losses read as up and
     * down from a shared zero; the flip stays in the chart because a CSV column
     * headed "lost backlinks" carrying -600 is a spreadsheet nobody can sum.
     */
    lostBacklinks: numberOr(p.lostBacklinks),
    newReferringDomains: numberOr(p.newReferringDomains),
    lostReferringDomains: numberOr(p.lostReferringDomains),
  }));
};

/**
 * The growth headline: what the window did, in the window's own units.
 *
 * ---- Why the window is quoted back ------------------------------------------
 *
 * "New" and "lost" are computed by DataForSEO RELATIVE TO `date_from`, so the
 * same month's new-backlink count is a different number under a different start
 * date. The snapshot stores the window for exactly this reason and the summary
 * carries it forward so a caption can say which two years it is about.
 *
 * @param {Object|null} snapshot
 * @returns {Object|null}
 */
export const growthSummary = (snapshot) => {
  const data = snapshot?.data || null;
  if (!data) return null;
  const totals = data.totals || {};
  const first = numberOr(totals.firstBacklinks);
  const last = numberOr(totals.lastBacklinks);

  return {
    window: data.window || null,
    statusType: data.statusType || null,
    buckets: totals.buckets || 0,
    newBacklinks: numberOr(totals.newBacklinks),
    lostBacklinks: numberOr(totals.lostBacklinks),
    firstBacklinks: first,
    lastBacklinks: last,
    /** Null unless BOTH ends exist — a change needs two readings, not one. */
    change: typeof first === 'number' && typeof last === 'number' ? last - first : null,
  };
};
