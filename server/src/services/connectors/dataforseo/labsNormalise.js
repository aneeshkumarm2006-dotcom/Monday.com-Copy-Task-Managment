const { parseDfsTime } = require('./normalise');

/**
 * DataForSEO Labs payloads, reduced to the rows the three phase-6 screens draw.
 *
 * ---- The rule every function here is written under -------------------------
 *
 * A MISSING NUMBER STAYS NULL. It never becomes 0.
 *
 * That rule is already the whole argument of `connectorFormat.js` on the client
 * and it matters more on Labs than it did on SERP, because Labs answers are
 * FULL OF legitimate nulls. `keyword_difficulty` is null for a keyword the index
 * has no SERP for; `search_volume` is null where Google Ads reports nothing;
 * `cpc` is null for a keyword nobody bids on. Every one of those is a fact, and
 * every one of them renders as "0" if a normaliser reaches for `|| 0` on the way
 * past. A keyword-research table listing forty keywords at "0 volume, 0 KD, $0
 * CPC" looks like a finding and is a parsing bug.
 *
 * ---- And the rule about the buckets ----------------------------------------
 *
 * The position ladder (`pos_1`, `pos_2_3`, `pos_4_10`, … `pos_91_100`) IS
 * present on `competitors_domain` and `relevant_pages` and is NOT present on
 * everything — `bulk_traffic_estimation` has none at all. It is read defensively
 * and its absence is null rather than a row of zeroes, for the same reason.
 *
 * ---- The one trap that produces a plausible wrong number -------------------
 *
 * `competitors_domain` returns TWO PARALLEL METRIC TREES and they are easy to
 * confuse because they have the same shape:
 *
 *   `full_domain_metrics` — everything that domain ranks for, anywhere.
 *   `metrics`             — only the keywords it shares with US.
 *
 * The second is the one that answers "does this domain actually compete with
 * me". The first is the one that makes Wikipedia look like a competitor. Both
 * are carried through under names that cannot be mistaken for each other, and
 * the screen shows them side by side — which is the entire point of the panel.
 */

/** A finite number, or null. Never `0` for "we did not see one". */
const num = (value) => {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

const str = (value) =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

/** The twelve-bucket position ladder, in the order a chart draws it. */
const POSITION_BUCKETS = [
  'pos_1',
  'pos_2_3',
  'pos_4_10',
  'pos_11_20',
  'pos_21_30',
  'pos_31_40',
  'pos_41_50',
  'pos_51_60',
  'pos_61_70',
  'pos_71_80',
  'pos_81_90',
  'pos_91_100',
];

/**
 * One `metrics.organic`-shaped node.
 *
 * Returns null for an absent tree rather than an object of nulls, so a caller
 * can say "this endpoint does not carry buckets" and mean it.
 *
 * @param {any} node
 * @returns {Object|null}
 */
const readMetrics = (node) => {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
  const buckets = {};
  let sawOne = false;
  for (const key of POSITION_BUCKETS) {
    const value = num(node[key]);
    buckets[key] = value;
    if (value !== null) sawOne = true;
  }
  const count = num(node.count);
  const etv = num(node.etv);
  if (!sawOne && count === null && etv === null) return null;
  return {
    count,
    /** Estimated traffic value — their model, not measured traffic. */
    etv,
    /** Integers inside `metrics.*`; booleans inside `rank_changes`. Not the same. */
    isNew: num(node.is_new),
    isUp: num(node.is_up),
    isDown: num(node.is_down),
    isLost: num(node.is_lost),
    buckets,
  };
};

/**
 * `dataforseo_labs/status`, reduced to the date a panel is stamped with.
 *
 * ---- Why this is not thrown away when it is unreadable ---------------------
 *
 * `parseDfsTime` throws by design, because a SERP result filed under the wrong
 * DAY is a data-integrity bug that surfaces months later. This is not that: it
 * is a caption. A `/status` payload we cannot read must degrade to "we do not
 * know when this index was rebuilt", which the screen renders as an honest
 * absence — never to a failed collection of data we already paid for.
 *
 * @param {any} payload - `tasks[0].result[0]`
 * @returns {{google: string|null, bing: string|null, amazon: string|null}}
 */
const normaliseLabsStatus = (payload) => {
  const row = payload && typeof payload === 'object' ? payload : {};
  const read = (node) => {
    const raw = node && typeof node === 'object' ? node.date_update : null;
    if (typeof raw !== 'string' || !raw.trim()) return null;
    try {
      return parseDfsTime(raw, 'Labs index date').toISOString();
    } catch {
      return null;
    }
  };
  return {
    google: read(row.google),
    bing: read(row.bing),
    amazon: read(row.amazon),
  };
};

// ---------------------------------------------------------------------------
// Keyword Research — `keyword_overview/live`
// ---------------------------------------------------------------------------

/**
 * One keyword row, out of the four nested trees `keyword_overview` returns.
 *
 * ---- Why the whole intent VECTOR is kept, not the winner -------------------
 *
 * `search_intent_info` gives a label and a PROBABILITY, plus a list of secondary
 * intents. Storing only the argmax throws away the difference between "78%
 * commercial" and "31% commercial, 29% informational, 28% transactional" — and
 * the second one is a keyword whose SERP is contested, which is exactly the
 * thing a person planning content wants to know. Keeping the vector costs a few
 * bytes a keyword and cannot be recovered later without buying the row again.
 *
 * ---- And why `monthly_searches` is kept whole ------------------------------
 *
 * It arrives FREE with every volume row — twelve months of seasonality at no
 * marginal API cost — and buying it separately later is a second call. The
 * sparkline on the screen is drawn from it; so is the answer to "is this
 * keyword's volume falling or is it just January".
 *
 * @param {any} payload - one element of `tasks[0].result[0].items`
 * @returns {Object}
 */
const normaliseKeywordOverview = (payload) => {
  const row = payload && typeof payload === 'object' ? payload : {};
  const info = row.keyword_info && typeof row.keyword_info === 'object' ? row.keyword_info : {};
  const props =
    row.keyword_properties && typeof row.keyword_properties === 'object'
      ? row.keyword_properties
      : {};
  const intent =
    row.search_intent_info && typeof row.search_intent_info === 'object'
      ? row.search_intent_info
      : {};
  const serp = row.serp_info && typeof row.serp_info === 'object' ? row.serp_info : {};

  return {
    keyword: str(row.keyword) || '',
    searchVolume: num(info.search_volume),
    cpc: num(info.cpc),
    /** Google Ads competition, 0-1. NOT difficulty — a paid-auction measure. */
    competition: num(info.competition),
    competitionLevel: str(info.competition_level),
    /**
     * 0-100 log scale, "chance of ranking top 10". A different number from
     * `competition` above and routinely confused with it on a client report.
     */
    keywordDifficulty: num(props.keyword_difficulty),
    /** `commercial | informational | navigational | transactional`, plus odds. */
    intent: str(intent.main_intent) || str(intent.se_type) || null,
    intentProbability: num(intent.probability),
    secondaryIntents: Array.isArray(intent.foreign_intent)
      ? intent.foreign_intent.filter((i) => typeof i === 'string')
      : [],
    /** Twelve months, free with the row. See the header. */
    monthlySearches: Array.isArray(info.monthly_searches)
      ? info.monthly_searches
          .map((m) => ({
            year: num(m?.year),
            month: num(m?.month),
            searchVolume: num(m?.search_volume),
          }))
          .filter((m) => m.year !== null && m.month !== null)
      : [],
    searchVolumeTrend:
      info.search_volume_trend && typeof info.search_volume_trend === 'object'
        ? {
            monthly: num(info.search_volume_trend.monthly),
            quarterly: num(info.search_volume_trend.quarterly),
            yearly: num(info.search_volume_trend.yearly),
          }
        : null,
    /** The SERP-feature census for the keyword, from the index rather than live. */
    serpItemTypes: Array.isArray(serp.serp_item_types)
      ? serp.serp_item_types.filter((t) => typeof t === 'string')
      : [],
    serpResultsCount: num(serp.se_results_count),
  };
};

/**
 * The Keyword Research snapshot body.
 *
 * `totals` are computed over the keywords that ACTUALLY CARRY the number being
 * averaged, not over the whole list. An average difficulty that counted every
 * null as zero would fall every time the index failed to answer for a keyword —
 * a number that improves when the data gets worse.
 *
 * @param {Array<Object>} rows
 * @param {Object} opts
 * @returns {Object}
 */
const aggregateKeywordMetrics = (rows, { collectedAt = null, indexUpdatedAt = null } = {}) => {
  const keywords = Array.isArray(rows) ? rows : [];
  const withVolume = keywords.filter((k) => typeof k.searchVolume === 'number');
  const withKd = keywords.filter((k) => typeof k.keywordDifficulty === 'number');

  const sum = (list, pick) => list.reduce((total, row) => total + pick(row), 0);
  const mean = (list, pick) =>
    list.length ? Math.round((sum(list, pick) / list.length) * 10) / 10 : null;

  const byIntent = new Map();
  for (const row of keywords) {
    const key = row.intent || 'unknown';
    byIntent.set(key, (byIntent.get(key) || 0) + 1);
  }

  return {
    collectedAt: collectedAt || null,
    /**
     * WHEN DATAFORSEO LAST REBUILT THE INDEX THIS CAME OUT OF — not when we
     * collected it. The two are different questions and the screen shows both,
     * because Labs is a database and the SERP API is a crawl.
     */
    indexUpdatedAt: indexUpdatedAt || null,
    keywords,
    totals: {
      tracked: keywords.length,
      measured: withVolume.length,
      totalVolume: withVolume.length ? sum(withVolume, (k) => k.searchVolume) : null,
      averageVolume: mean(withVolume, (k) => k.searchVolume),
      averageDifficulty: mean(withKd, (k) => k.keywordDifficulty),
      averageCpc: (() => {
        const withCpc = keywords.filter((k) => typeof k.cpc === 'number');
        return withCpc.length
          ? Math.round((sum(withCpc, (k) => k.cpc) / withCpc.length) * 100) / 100
          : null;
      })(),
      byIntent: [...byIntent.entries()]
        .map(([intent, count]) => ({ intent, count }))
        .sort((a, b) => b.count - a.count),
    },
  };
};

// ---------------------------------------------------------------------------
// Competitors — `competitors_domain/live`
// ---------------------------------------------------------------------------

/**
 * One competitor row. See the header for the two-metric-trees trap.
 *
 * @param {any} payload - one element of `items`
 * @returns {Object}
 */
const normaliseCompetitor = (payload) => {
  const row = payload && typeof payload === 'object' ? payload : {};
  return {
    domain: str(row.domain) || '',
    /** How many of OUR keywords this domain also ranks for. */
    intersections: num(row.intersections),
    avgPosition: num(row.avg_position),
    medianPosition: num(row.median_position),
    /** Their own 0-1 relevance score for the comparison. */
    rating: num(row.rating),
    /** ONLY the shared keywords. "Does it compete with me." */
    sharedMetrics: readMetrics(row.metrics?.organic),
    /** EVERYTHING they rank for. "Is it a big site." Not the same question. */
    fullMetrics: readMetrics(row.full_domain_metrics?.organic),
  };
};

const aggregateCompetitors = (
  rows,
  { domain, collectedAt = null, indexUpdatedAt = null } = {}
) => {
  const competitors = Array.isArray(rows) ? rows : [];
  return {
    domain: domain || null,
    collectedAt: collectedAt || null,
    indexUpdatedAt: indexUpdatedAt || null,
    competitors,
    totals: {
      found: competitors.length,
      /**
       * The single most-overlapping domain, named. A table of a hundred rows
       * needs one sentence above it and this is the sentence.
       */
      topDomain: competitors[0]?.domain || null,
      maxIntersections: competitors.length
        ? competitors.reduce(
            (best, c) =>
              typeof c.intersections === 'number' && (best === null || c.intersections > best)
                ? c.intersections
                : best,
            null
          )
        : null,
    },
  };
};

// ---------------------------------------------------------------------------
// Keyword gap — `domain_intersection/live` with `intersections: false`
// ---------------------------------------------------------------------------

/**
 * One gap row: a keyword the competitor ranks for and we do not.
 *
 * ---- Which side is which, and why it is spelled out ------------------------
 *
 * `domain_intersection` takes `target1` and `target2` and returns
 * `first_domain_serp_element` / `second_domain_serp_element`. With
 * `intersections: false` the report is "keywords target1 ranks for that target2
 * does not", so THE COMPETITOR MUST BE `target1` and we must be `target2`.
 * Swapped, the same call returns a perfectly plausible table of keywords WE rank
 * for and they do not — the opposite report, with no field anywhere that says
 * so. `labs.js` builds the request; this file names the sides so a reader of
 * either can check them against each other.
 *
 * @param {any} payload
 * @returns {Object}
 */
const normaliseGapRow = (payload) => {
  const row = payload && typeof payload === 'object' ? payload : {};
  const info =
    row.keyword_data?.keyword_info && typeof row.keyword_data.keyword_info === 'object'
      ? row.keyword_data.keyword_info
      : {};
  const props =
    row.keyword_data?.keyword_properties &&
    typeof row.keyword_data.keyword_properties === 'object'
      ? row.keyword_data.keyword_properties
      : {};
  const theirs =
    row.first_domain_serp_element && typeof row.first_domain_serp_element === 'object'
      ? row.first_domain_serp_element
      : {};
  const ours =
    row.second_domain_serp_element && typeof row.second_domain_serp_element === 'object'
      ? row.second_domain_serp_element
      : {};

  return {
    keyword: str(row.keyword_data?.keyword) || '',
    searchVolume: num(info.search_volume),
    cpc: num(info.cpc),
    keywordDifficulty: num(props.keyword_difficulty),
    /** `target1` — the competitor. */
    competitorRank: num(theirs.rank_group),
    competitorUrl: str(theirs.url),
    competitorEtv: num(theirs.etv),
    /**
     * `target2` — us. NULL IS THE POINT OF THIS REPORT: with
     * `intersections: false` this side is empty by construction, and a
     * normaliser that filled it with 0 would turn "we do not rank" into
     * "we rank at position zero".
     */
    ourRank: num(ours.rank_group),
    ourUrl: str(ours.url),
  };
};

const aggregateGap = (
  rows,
  { domain, competitor, collectedAt = null, indexUpdatedAt = null } = {}
) => {
  const keywords = Array.isArray(rows) ? rows : [];
  const withVolume = keywords.filter((k) => typeof k.searchVolume === 'number');
  return {
    domain: domain || null,
    /** WHOSE gap this is. A gap table with no competitor named is unreadable. */
    competitor: competitor || null,
    collectedAt: collectedAt || null,
    indexUpdatedAt: indexUpdatedAt || null,
    keywords,
    totals: {
      missing: keywords.length,
      /** The prize, in monthly searches, of closing the whole gap. */
      volumeAtStake: withVolume.length
        ? withVolume.reduce((sum, k) => sum + k.searchVolume, 0)
        : null,
      /** How much of it sits in their top ten — the reachable half. */
      inTheirTop10: keywords.filter(
        (k) => typeof k.competitorRank === 'number' && k.competitorRank <= 10
      ).length,
    },
  };
};

// ---------------------------------------------------------------------------
// Top pages — `relevant_pages/live`
// ---------------------------------------------------------------------------

/**
 * One page row: a URL on OUR domain, with the position ladder for it.
 *
 * @param {any} payload
 * @returns {Object}
 */
const normaliseRelevantPage = (payload) => {
  const row = payload && typeof payload === 'object' ? payload : {};
  const metrics = readMetrics(row.metrics?.organic);
  return {
    url: str(row.page_address) || str(row.url) || '',
    keywords: metrics?.count ?? null,
    etv: metrics?.etv ?? null,
    /** `pos_1` first. What a page's ranking profile looks like at a glance. */
    buckets: metrics?.buckets || null,
    isNew: metrics?.isNew ?? null,
    isUp: metrics?.isUp ?? null,
    isDown: metrics?.isDown ?? null,
    isLost: metrics?.isLost ?? null,
  };
};

const aggregateTopPages = (
  rows,
  { domain, collectedAt = null, indexUpdatedAt = null } = {}
) => {
  const pages = Array.isArray(rows) ? rows : [];
  const withEtv = pages.filter((p) => typeof p.etv === 'number');
  return {
    domain: domain || null,
    collectedAt: collectedAt || null,
    indexUpdatedAt: indexUpdatedAt || null,
    pages,
    totals: {
      pages: pages.length,
      totalEtv: withEtv.length ? Math.round(withEtv.reduce((s, p) => s + p.etv, 0)) : null,
      totalKeywords: (() => {
        const withCount = pages.filter((p) => typeof p.keywords === 'number');
        return withCount.length ? withCount.reduce((s, p) => s + p.keywords, 0) : null;
      })(),
      topPage: pages[0]?.url || null,
    },
  };
};

module.exports = {
  POSITION_BUCKETS,
  readMetrics,
  normaliseLabsStatus,
  normaliseKeywordOverview,
  aggregateKeywordMetrics,
  normaliseCompetitor,
  aggregateCompetitors,
  normaliseGapRow,
  aggregateGap,
  normaliseRelevantPage,
  aggregateTopPages,
};
