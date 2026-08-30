const C = require('./constants');
const { parseDfsTime } = require('./normalise');
const toxicity = require('./toxicity');

/**
 * Backlinks payloads, reduced to the rows the Backlinks screen draws.
 *
 * ---- Three metric traps, and each one ships a plausible wrong number --------
 *
 * This file exists more for the three paragraphs below than for the field
 * copying. Every one of them produces a number that looks right, survives code
 * review, and is wrong on a client report.
 *
 * 1. `rank` IS 0-1000, IT IS DATAFORSEO'S OWN METRIC, AND IT IS NEVER DA OR DR.
 *
 *    It is original PageRank with a damping factor of 0.5, logarithmically
 *    compressed, computed over DataForSEO's own crawl. They position it as an
 *    alternative to Ahrefs' Domain Rating and say in as many words that the
 *    values should not be expected to match. `rank_scale: 'one_hundred'` returns
 *    the same fact on a 0-100 scale through a NON-LINEAR conversion
 *    (`sin(rank / 636.62) * 100`), so a reader cannot tell from the number which
 *    scale it is on — which is why `rankScale` is stored beside every rank here
 *    and why the request sends it explicitly.
 *
 *    AND `referring_domains.rank` IS NOT DOMAIN AUTHORITY. On a referring-domain
 *    row that field is the rank of the LINKS THAT DOMAIN SENDS TO OUR TARGET,
 *    not the domain's own standing. Read as authority it puts a link farm that
 *    links to us fifty times above a national newspaper that links once. It is
 *    carried through as `linksRank`, and the authority of any other domain comes
 *    from `bulk_ranks` under the name `authorityRank`. Two names that cannot be
 *    typed for each other by accident.
 *
 *    It also never goes through `connectorFormat.formatRank` on the client. That
 *    function owns the SERP-position three-way rule — `#4`, `Not in top 100`,
 *    `—` — and a domain rank of null means "we have no reading", never "this
 *    domain does not rank".
 *
 * 2. `*_nofollow` MEANS "AT LEAST ONE NOFOLLOW LINK", SO IT IS NOT THE
 *    COMPLEMENT OF DOFOLLOW.
 *
 *    `referring_domains - referring_domains_nofollow` is the obvious line and it
 *    is wrong: a domain linking to us twice, once followed and once not, is
 *    counted in both terms, so the two sets overlap and their difference is not
 *    the followed set. The error is silent and always understates. The honest
 *    answer is a SECOND `summary` call carrying `backlinks_filters` — two
 *    independently computed aggregates, no subtraction — and `aggregateSummary`
 *    below will not accept one without the other having been asked for.
 *
 * 3. `backlinks_status_type` RECOMPUTES THE AGGREGATES, IT DOES NOT FILTER ROWS.
 *
 *    `all | live | lost` changes the corpus every number is computed over,
 *    including `rank` — DataForSEO's own example shows one domain at 509 under
 *    `lost` and 562 under `live`. So two readings taken under different status
 *    types are not comparable, and the only way to make that impossible to get
 *    wrong is to STORE the status type on every snapshot and refuse to diff two
 *    that disagree. `statusType` is on every aggregate here for that reason and
 *    for no other.
 *
 * ---- And the rule this file inherits from `labsNormalise` ------------------
 *
 * A MISSING NUMBER STAYS NULL. It never becomes 0. A backlink profile is full of
 * legitimate zeroes — a site really can have no broken backlinks — and a
 * normaliser reaching for `|| 0` makes "we could not read the field" and "the
 * answer is none" the same pixel.
 */

/** A finite number, or null. Never `0` for "we did not see one". */
const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const str = (value) =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

/**
 * A DataForSEO datetime, or null.
 *
 * `parseDfsTime` THROWS by design, because a SERP result filed under the wrong
 * day is a data-integrity bug that surfaces months later. None of the dates in
 * this file are that: `first_seen` and `lost_date` are descriptive columns on a
 * table row, and a `date` on a timeseries bucket is already carried as the day
 * key it came in as. So an unreadable one degrades to null rather than failing a
 * collection that has been paid for.
 */
const time = (value) => {
  if (!value) return null;
  try {
    return parseDfsTime(value).toISOString();
  } catch {
    return null;
  }
};

/**
 * One of `summary`'s six breakdown maps, as a sorted list.
 *
 * They arrive as `{".com": 4211, ".org": 88}` and they are FREE — they ride
 * inside a call already being made, populated by `internal_list_limit`. Turned
 * into a list here because an object has no order and a donut needs one, and
 * because a stored Mongo document with user-controlled keys (a TLD is
 * user-controlled, and a country code is not always two letters) is a document
 * that can carry a dot in a key name.
 *
 * @param {any} node
 * @returns {Array<{key: string, count: number}>|null} null for an absent map
 */
const breakdown = (node) => {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
  const rows = Object.entries(node)
    .map(([key, value]) => ({ key: String(key), count: num(value) }))
    .filter((row) => row.count !== null)
    .sort((a, b) => b.count - a.count);
  return rows.length ? rows : null;
};

/** The six free breakdowns, by the name they arrive under. */
const BREAKDOWN_FIELDS = [
  ['tld', 'referring_links_tld'],
  ['types', 'referring_links_types'],
  ['attributes', 'referring_links_attributes'],
  ['platformTypes', 'referring_links_platform_types'],
  ['semanticLocations', 'referring_links_semantic_locations'],
  ['countries', 'referring_links_countries'],
];

const breakdownsOf = (row) =>
  Object.fromEntries(BREAKDOWN_FIELDS.map(([name, field]) => [name, breakdown(row[field])]));

// ---------------------------------------------------------------------------
// The profile — `backlinks/summary/live`
// ---------------------------------------------------------------------------

/**
 * One `summary` answer.
 *
 * Called TWICE per collection with two different filters, so it must be pure and
 * must not know which of the two it is reading — `aggregateSummary` labels them.
 *
 * @param {any} payload - `tasks[0].result[0]`
 * @returns {Object}
 */
const normaliseSummary = (payload) => {
  const row = payload && typeof payload === 'object' ? payload : {};
  const info = row.info && typeof row.info === 'object' ? row.info : {};

  return {
    target: str(row.target),
    firstSeen: time(row.first_seen),
    lostDate: time(row.lost_date),

    /**
     * 0-1000 BY DEFAULT, DataForSEO's own metric, never DA and never DR. The
     * scale it is on is stored beside it by `aggregateSummary`, because the
     * conversion between the two scales is not linear and the number alone
     * cannot say which one it is.
     */
    rank: num(row.rank),

    backlinks: num(row.backlinks),
    /** "At least one nofollow link", NOT the complement of dofollow. See header. */
    backlinksNofollow: num(row.backlinks_nofollow),
    brokenBacklinks: num(row.broken_backlinks),
    brokenPages: num(row.broken_pages),

    referringDomains: num(row.referring_domains),
    referringDomainsNofollow: num(row.referring_domains_nofollow),
    referringMainDomains: num(row.referring_main_domains),
    referringMainDomainsNofollow: num(row.referring_main_domains_nofollow),
    referringPages: num(row.referring_pages),
    referringPagesNofollow: num(row.referring_pages_nofollow),
    referringIps: num(row.referring_ips),
    referringSubnets: num(row.referring_subnets),

    /** 0-100 across 18 signals. Domain bands are 0-30 / 31-60 / 61-100. */
    spamScore: num(row.backlinks_spam_score),
    targetSpamScore: num(info.target_spam_score),

    crawledPages: num(row.crawled_pages),
    internalLinksCount: num(row.internal_links_count),
    externalLinksCount: num(row.external_links_count),

    /** Free with the call, and the whole of the donut row. */
    breakdowns: breakdownsOf(row),
  };
};

/**
 * The Backlinks hero snapshot body.
 *
 * ---- What this function refuses to do --------------------------------------
 *
 * It will not compute a dofollow count. It is handed the answer to a SECOND,
 * filtered `summary` call or it reports null, and there is no third branch. A
 * `dofollow` block derived by subtracting `referringDomainsNofollow` from
 * `referringDomains` would be an understatement whose size depends on how many
 * of our referrers link more than once — invisible on screen, largest exactly
 * where the profile is most interesting, and impossible to detect afterwards
 * from the stored row.
 *
 * @param {Object} args
 * @param {Object|null} args.profile - the unfiltered `summary` answer
 * @param {Object|null} args.dofollow - the `backlinks_filters` `summary` answer
 * @param {Array<Object>} [args.authority] - `bulk_ranks` rows
 * @param {string} args.domain
 * @param {Date|string|null} args.collectedAt
 * @param {Object|null} [args.index] - the free `backlinks/index` footnote
 * @returns {Object}
 */
const aggregateSummary = ({
  profile,
  dofollow = null,
  authority = [],
  domain,
  collectedAt = null,
  index = null,
}) => {
  const own = profile || null;
  const ranks = Array.isArray(authority) ? authority : [];
  const self = String(domain || '').toLowerCase();

  return {
    domain: domain || null,
    collectedAt: collectedAt || null,

    /**
     * WHICH CORPUS EVERY NUMBER BELOW WAS COMPUTED OVER.
     *
     * Not decoration and not diagnostics. `backlinks_status_type` recomputes the
     * aggregates rather than filtering rows, so a reading taken under `live` and
     * one taken under `all` are two measurements of two different graphs. The
     * client compares this field before it draws a single delta.
     */
    statusType: C.BACKLINKS_STATUS_TYPE,

    /**
     * WHICH SCALE EVERY RANK BELOW IS ON. The conversion between the two is
     * `sin(rank / 636.62) * 100` — not linear, not recoverable from the number.
     */
    rankScale: C.BACKLINKS_RANK_SCALE,

    profile: own,

    /**
     * THE SECOND CALL'S OWN ANSWER, never a subtraction. Null when the filtered
     * call failed, which renders as an em dash — an honest absence rather than a
     * number that is wrong by an unknown amount.
     */
    dofollow: dofollow
      ? {
          backlinks: dofollow.backlinks,
          referringDomains: dofollow.referringDomains,
          referringMainDomains: dofollow.referringMainDomains,
          referringPages: dofollow.referringPages,
        }
      : null,

    /**
     * THE ONLY DOMAIN-AUTHORITY NUMBERS IN THE PRODUCT, from `bulk_ranks`.
     *
     * Our own domain and every competitor on the Site, in one call at one flat
     * request price. `referring_domains.rank` is deliberately not here and is
     * carried under a different name entirely — see the file header.
     */
    authority: ranks.map((row) => ({
      target: row.target,
      authorityRank: row.authorityRank,
      isSelf: !!row.target && row.target.toLowerCase() === self,
    })),

    /**
     * The size of the index this was read out of, from the free
     * `backlinks/index`. A footnote, and null when unreadable — the panel says
     * "live backlink index" either way.
     */
    index: index || null,
  };
};

// ---------------------------------------------------------------------------
// Authority — `backlinks/bulk_ranks/live`
// ---------------------------------------------------------------------------

/**
 * One `bulk_ranks` row: a target and its own rank.
 *
 * The field is named `authorityRank` here and NOWHERE ELSE in this file, which
 * is the whole mechanism that keeps it apart from `referring_domains.rank`.
 *
 * @param {any} payload
 * @returns {{target: string|null, authorityRank: number|null}}
 */
const normaliseBulkRank = (payload) => {
  const row = payload && typeof payload === 'object' ? payload : {};
  return {
    target: str(row.target),
    authorityRank: num(row.rank),
  };
};

// ---------------------------------------------------------------------------
// Referring domains — `backlinks/referring_domains/live`
// ---------------------------------------------------------------------------

/**
 * One referring-domain row.
 *
 * @param {any} payload
 * @returns {Object}
 */
const normaliseReferringDomain = (payload) => {
  const row = payload && typeof payload === 'object' ? payload : {};
  return {
    domain: str(row.domain) || '',

    /**
     * NOT DOMAIN AUTHORITY, and the name is the guard.
     *
     * This is the rank of the links THIS DOMAIN SENDS TO OUR TARGET — a measure
     * of what the link is worth to us, not of what the domain is worth on the
     * web. It is a reasonable thing to sort by and a wrong thing to label
     * "authority": a fifty-link sitewide footer from a directory outranks one
     * editorial link from a newspaper. The domain's own authority is a separate
     * purchase (`bulk_ranks`) that this table deliberately does not make for a
     * hundred rows.
     */
    linksRank: num(row.rank),

    backlinks: num(row.backlinks),
    brokenBacklinks: num(row.broken_backlinks),
    brokenPages: num(row.broken_pages),
    /** "At least one nofollow link from this domain". Not a follow ratio. */
    referringPages: num(row.referring_pages),
    referringPagesNofollow: num(row.referring_pages_nofollow),
    spamScore: num(row.backlinks_spam_score),
    firstSeen: time(row.first_seen),
    lostDate: time(row.lost_date),
    breakdowns: breakdownsOf(row),
  };
};

const aggregateReferringDomains = (rows, { domain, collectedAt = null } = {}) => {
  /**
   * SCORED HERE, ON THE SERVER, ONCE — phase 10.
   *
   * `toxicity.scoreDomain` is the only implementation of "which of these links
   * look wrong and why", and it is applied at normalisation rather than on the
   * client for the reason `onpageChecks.issueCountFor` is: the answer ends up in
   * a `disavow.txt` somebody uploads to Google Search Console, and a rule that
   * exists in two places drifts into two different files with the same name.
   *
   * It is stamped on every stored row rather than computed for the toxic screen
   * alone, so the ordinary Backlinks table and the toxic report cannot disagree
   * about which domains are bad.
   */
  const domains = (Array.isArray(rows) ? rows : []).map((row) => ({
    ...row,
    toxicity: toxicity.scoreDomain(row),
  }));
  const withSpam = domains.filter((d) => typeof d.spamScore === 'number');
  const withBacklinks = domains.filter((d) => typeof d.backlinks === 'number');

  return {
    domain: domain || null,
    collectedAt: collectedAt || null,
    statusType: C.BACKLINKS_STATUS_TYPE,
    rankScale: C.BACKLINKS_RANK_SCALE,
    domains,
    totals: {
      /**
       * HOW MANY ROWS THIS TABLE HOLDS — deliberately not called "referring
       * domains".
       *
       * The profile's `referring_domains` is the whole count and can be tens of
       * thousands; this is the top hundred we asked for. Naming them the same
       * thing is how a hero tile saying 12,400 ends up beside a table footer
       * saying 100 with nothing to explain the gap.
       */
      shown: domains.length,
      broken: domains.filter((d) => (d.brokenBacklinks || 0) > 0).length,
      averageSpamScore: withSpam.length
        ? Math.round((withSpam.reduce((s, d) => s + d.spamScore, 0) / withSpam.length) * 10) /
          10
        : null,
      linksShown: withBacklinks.length
        ? withBacklinks.reduce((s, d) => s + d.backlinks, 0)
        : null,
    },
    /** The toxic census over the same hundred rows. See `./toxicity.js`. */
    toxic: toxicity.summariseToxicity(domains),
  };
};

// ---------------------------------------------------------------------------
// Referring networks — `backlinks/referring_networks/live`. Phase 10.
// ---------------------------------------------------------------------------

/**
 * One subnet row.
 *
 * ---- Why `rank` is `linksRank` here too ------------------------------------
 *
 * Identical trap to `normaliseReferringDomain`'s, one level up: the `rank` on a
 * network row is the rank of the LINKS THAT BLOCK SENDS US, not a standing of
 * any kind that the block itself has. There is no such thing as the authority of
 * a /24. Carried under the same name as the domain row's so that neither can be
 * mistaken for `authorityRank`, which comes only from `bulk_ranks`.
 *
 * @param {any} payload
 * @returns {Object}
 */
const normaliseReferringNetwork = (payload) => {
  const row = payload && typeof payload === 'object' ? payload : {};
  return {
    /**
     * `network_address` is the /24 when `network_address_type` was `subnet` and
     * a single address when it was `ip`. Which one it is is a property of the
     * REQUEST, so it is stamped on the aggregate rather than guessed from the
     * string — `10.0.0.0/24` and `10.0.0.7` are distinguishable, but a reader
     * should not have to parse a value to know what was asked for.
     */
    network: str(row.network_address) || '',
    referringDomains: num(row.referring_domains),
    referringMainDomains: num(row.referring_main_domains),
    backlinks: num(row.backlinks),
    brokenBacklinks: num(row.broken_backlinks),
    /** NOT authority. See the header. */
    linksRank: num(row.rank),
    firstSeen: time(row.first_seen),
    lostDate: time(row.lost_date),
  };
};

/**
 * The subnet snapshot body.
 *
 * `statusType` and `rankScale` travel exactly as they do on every other
 * Backlinks aggregate, because `comparability` refuses a delta between two
 * readings that disagree about either and this kind is subject to the same
 * recompute: `backlinks_status_type` changes what a network's link count IS.
 *
 * @param {Array<Object>} rows
 * @param {Object} ctx
 * @returns {Object}
 */
const aggregateReferringNetworks = (rows, { domain, collectedAt = null } = {}) => {
  const networks = (Array.isArray(rows) ? rows : []).map((n) => ({
    ...n,
    concentrated: (n.referringDomains ?? 0) >= C.TOXIC_NETWORK_MIN_DOMAINS,
  }));

  return {
    domain: domain || null,
    collectedAt: collectedAt || null,
    statusType: C.BACKLINKS_STATUS_TYPE,
    rankScale: C.BACKLINKS_RANK_SCALE,
    /** Which grouping was bought. See `normaliseReferringNetwork`. */
    addressType: C.BACKLINKS_NETWORK_ADDRESS_TYPE,
    networks,
    totals: toxicity.summariseNetworks(networks),
  };
};

// ---------------------------------------------------------------------------
// Anchors — `backlinks/anchors/live`
// ---------------------------------------------------------------------------

/**
 * One anchor row.
 *
 * ---- Why `referringMainDomains` is the weight and `backlinks` is not -------
 *
 * An anchor cloud sized by `backlinks` is a picture of one website's footer.
 * A single sitewide link repeated across forty thousand pages arrives as forty
 * thousand backlinks carrying one anchor, and it will dominate every other
 * anchor on the site combined — for a profile in which exactly one person chose
 * that text, once. `referring_main_domains` counts how many DIFFERENT root
 * domains chose the anchor, which is the thing an anchor profile is actually
 * about, and it is what the screen sizes by.
 *
 * @param {any} payload
 * @returns {Object}
 */
const normaliseAnchor = (payload) => {
  const row = payload && typeof payload === 'object' ? payload : {};
  return {
    /**
     * An empty string is a REAL anchor — it is an image link with no alt text,
     * and a profile full of them is a finding. So it is kept as `''` and not
     * nulled, and the client labels it rather than hiding it.
     */
    anchor: typeof row.anchor === 'string' ? row.anchor : '',
    backlinks: num(row.backlinks),
    referringDomains: num(row.referring_domains),
    /** THE WEIGHT. See the block above. */
    referringMainDomains: num(row.referring_main_domains),
    referringPages: num(row.referring_pages),
    spamScore: num(row.backlinks_spam_score),
    brokenBacklinks: num(row.broken_backlinks),
    firstSeen: time(row.first_seen),
    lostDate: time(row.lost_date),
  };
};

const aggregateAnchors = (rows, { domain, collectedAt = null } = {}) => {
  const anchors = Array.isArray(rows) ? rows : [];
  const withDomains = anchors.filter((a) => typeof a.referringMainDomains === 'number');
  return {
    domain: domain || null,
    collectedAt: collectedAt || null,
    statusType: C.BACKLINKS_STATUS_TYPE,
    anchors,
    totals: {
      shown: anchors.length,
      /**
       * The denominator every share on the screen is computed against, in the
       * units the cloud is weighted in. Computed here so a percentage cannot be
       * taken against `backlinks` in one place and `referring_main_domains` in
       * another.
       */
      weight: withDomains.length
        ? withDomains.reduce((s, a) => s + a.referringMainDomains, 0)
        : null,
      empty: anchors.filter((a) => a.anchor === '').length,
    },
  };
};

// ---------------------------------------------------------------------------
// History — `timeseries_summary` and `timeseries_new_lost_summary`
// ---------------------------------------------------------------------------

/**
 * One timeseries bucket.
 *
 * ---- The date is theirs and is never re-derived -----------------------------
 *
 * `timeseries_summary` stamps each bucket with the LAST day of the period it
 * covers, and `history` (a different endpoint, not used here) stamps the FIRST.
 * A normaliser that inferred a month from a date would therefore be right for
 * one endpoint and off by one for the other, silently. The day key is carried
 * through exactly as it arrives and the chart labels it.
 *
 * @param {any} payload
 * @returns {Object}
 */
const normaliseTimeseriesPoint = (payload) => {
  const row = payload && typeof payload === 'object' ? payload : {};
  const at = time(row.date);
  return {
    /** The bucket's own stamp, as a day key. Their boundary, not ours. */
    date: at ? at.slice(0, 10) : str(row.date),
    rank: num(row.rank),
    backlinks: num(row.backlinks),
    referringDomains: num(row.referring_domains),
    referringMainDomains: num(row.referring_main_domains),
    brokenBacklinks: num(row.broken_backlinks),
    spamScore: num(row.backlinks_spam_score),
    newBacklinks: num(row.new_backlinks),
    lostBacklinks: num(row.lost_backlinks),
    newReferringDomains: num(row.new_referring_domains),
    lostReferringDomains: num(row.lost_referring_domains),
  };
};

/**
 * The growth snapshot body: one series per call, merged on the day key.
 *
 * ---- Why the two calls are merged rather than stored side by side ----------
 *
 * `timeseries_summary` gives the LEVELS (how many links there are) and
 * `timeseries_new_lost_summary` gives the FLOWS (how many arrived and left).
 * They are bucketed the same way over the same window, so a chart wants one row
 * per month carrying both — and merging them here rather than on the client is
 * what stops two arrays of different lengths being zipped by index, which is
 * the bug that silently shifts a whole series by one month the first time one
 * endpoint returns a bucket the other does not.
 *
 * @param {Object} args
 * @param {Array<Object>} args.levels
 * @param {Array<Object>} args.flows
 * @returns {Object}
 */
const aggregateTimeseries = ({
  levels = [],
  flows = [],
  domain,
  collectedAt = null,
  from = null,
  to = null,
} = {}) => {
  const byDate = new Map();

  const put = (row) => {
    if (!row?.date) return;
    const existing = byDate.get(row.date) || { date: row.date };
    for (const [key, value] of Object.entries(row)) {
      if (key === 'date') continue;
      // First non-null wins, so a flow series carrying nulls for the levels
      // cannot blank a level that was already read.
      if (value !== null && existing[key] == null) existing[key] = value;
      else if (!(key in existing)) existing[key] = value;
    }
    byDate.set(row.date, existing);
  };

  for (const row of Array.isArray(levels) ? levels : []) put(row);
  for (const row of Array.isArray(flows) ? flows : []) put(row);

  const points = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  const withBacklinks = points.filter((p) => typeof p.backlinks === 'number');

  return {
    domain: domain || null,
    collectedAt: collectedAt || null,
    statusType: C.BACKLINKS_STATUS_TYPE,
    rankScale: C.BACKLINKS_RANK_SCALE,
    /**
     * THE WINDOW EVERY "NEW" AND "LOST" NUMBER IS RELATIVE TO.
     *
     * DataForSEO computes new/lost against `date_from`, so the same month's
     * "new backlinks" is a different number depending on where the request
     * started. Stored with the series because it cannot be recovered from it.
     */
    window: { from: from || null, to: to || null, group: C.BACKLINKS_TIMESERIES_GROUP },
    points,
    totals: {
      buckets: points.length,
      newBacklinks: points.reduce(
        (s, p) => (typeof p.newBacklinks === 'number' ? s + p.newBacklinks : s),
        0
      ),
      lostBacklinks: points.reduce(
        (s, p) => (typeof p.lostBacklinks === 'number' ? s + p.lostBacklinks : s),
        0
      ),
      /**
       * The first and last LEVEL readings, so a screen can say "grew by N" from
       * the series it drew rather than from a second computation. Null where
       * there is nothing to measure between.
       */
      firstBacklinks: withBacklinks.length ? withBacklinks[0].backlinks : null,
      lastBacklinks: withBacklinks.length
        ? withBacklinks[withBacklinks.length - 1].backlinks
        : null,
    },
  };
};

// ---------------------------------------------------------------------------
// The free footnote — `backlinks/index`
// ---------------------------------------------------------------------------

/**
 * The size of the live link index.
 *
 * A CAPTION, exactly like `labsNormalise.normaliseLabsStatus`, and unreadable is
 * null rather than an error for the same reason: failing a collection that has
 * been paid for because a free footnote endpoint answered oddly would be the
 * most expensive possible reading of "be careful about provenance".
 *
 * Their field names for this one are not fully documented and their examples
 * disagree, so both spellings are probed and neither is required.
 *
 * @param {any} payload - `tasks[0].result[0]`
 * @returns {{backlinks: number|null, referringDomains: number|null,
 *   pages: number|null, updatedAt: string|null}|null}
 */
const normaliseIndex = (payload) => {
  const row = payload && typeof payload === 'object' ? payload : null;
  if (!row) return null;

  const out = {
    backlinks: num(row.live_backlinks) ?? num(row.backlinks),
    referringDomains: num(row.live_referring_domains) ?? num(row.referring_domains),
    pages: num(row.live_pages) ?? num(row.pages),
    updatedAt: time(row.date) || time(row.datetime),
  };

  return Object.values(out).some((v) => v !== null) ? out : null;
};

module.exports = {
  breakdown,
  normaliseSummary,
  aggregateSummary,
  normaliseBulkRank,
  normaliseReferringDomain,
  aggregateReferringDomains,
  normaliseReferringNetwork,
  aggregateReferringNetworks,
  normaliseAnchor,
  aggregateAnchors,
  normaliseTimeseriesPoint,
  aggregateTimeseries,
  normaliseIndex,
};
