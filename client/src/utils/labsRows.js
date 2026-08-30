import { BLANK, sortRowsBy } from './rankRows.js';

/**
 * Turning stored Labs snapshots into the rows the three phase-6 tables draw.
 *
 * ---- Why this is a second file beside `rankRows.js` ------------------------
 *
 * `rankRows.js` owns the three-way RANK rule — a number, a definite "not
 * ranking", and no reading at all — and that rule is about one column on one
 * kind of table. None of these tables has a rank in that sense: a keyword row
 * has a search volume and a difficulty, a competitor row has two parallel
 * metric trees, a page row has a traffic estimate.
 *
 * What they DO share is the blanks-last comparator, and that one is imported
 * rather than copied. Four more copies of "a null must not sort as a zero" is
 * four more chances for one table to disagree with the others on the day
 * somebody clicks "descending".
 *
 * ---- The rule every function here inherits ---------------------------------
 *
 * A MISSING NUMBER IS NULL AND RENDERS AS AN EM DASH. Labs answers are full of
 * legitimate nulls — a keyword the index has no SERP for, a keyword nobody bids
 * on, a page with no bucket data — and every one of them becomes a "0" the
 * moment something reaches for `|| 0`. A keyword table showing forty rows at
 * "0 volume, 0 difficulty, $0 CPC" looks like a finding and is a parsing bug.
 *
 * ---- And the one about freshness -------------------------------------------
 *
 * `indexUpdatedAt` and `collectedAt` are DIFFERENT FACTS and the screens show
 * both. The first is when DataForSEO last rebuilt the database the answer came
 * out of; the second is when we asked it. DataForSEO's own documentation says
 * the index is refreshed both "weekly" and "every 30-90 days", so we stamp what
 * they tell us and never call any of this live.
 */

/** The intent labels DataForSEO returns, in the order a chip row reads best. */
export const INTENTS = [
  { key: 'informational', label: 'Informational' },
  { key: 'commercial', label: 'Commercial' },
  { key: 'transactional', label: 'Transactional' },
  { key: 'navigational', label: 'Navigational' },
];

/**
 * Keyword difficulty bands.
 *
 * DataForSEO's `keyword_difficulty` is 0-100 on a LOG scale and is described as
 * "the chance of ranking in the top ten", which is why the bands are not
 * quarters: the distance from 60 to 80 is a different amount of work from the
 * distance from 10 to 30, and even quarters would imply otherwise.
 */
export const DIFFICULTY_BANDS = [
  { key: 'easy', label: 'Easy (0-14)', min: 0, max: 14, tone: 'positive' },
  { key: 'moderate', label: 'Moderate (15-29)', min: 15, max: 29, tone: 'positive' },
  { key: 'difficult', label: 'Difficult (30-49)', min: 30, max: 49, tone: 'neutral' },
  { key: 'hard', label: 'Hard (50-69)', min: 50, max: 69, tone: 'negative' },
  { key: 'veryHard', label: 'Very hard (70+)', min: 70, max: 100, tone: 'negative' },
];

export const bandFor = (difficulty) => {
  if (typeof difficulty !== 'number') return null;
  return DIFFICULTY_BANDS.find((b) => difficulty >= b.min && difficulty <= b.max) || null;
};

/** The twelve-bucket position ladder, in the order a bar reads. */
export const POSITION_BUCKETS = [
  { key: 'pos_1', label: '#1' },
  { key: 'pos_2_3', label: '2-3' },
  { key: 'pos_4_10', label: '4-10' },
  { key: 'pos_11_20', label: '11-20' },
  { key: 'pos_21_30', label: '21-30' },
  { key: 'pos_31_40', label: '31-40' },
  { key: 'pos_41_50', label: '41-50' },
  { key: 'pos_51_60', label: '51-60' },
  { key: 'pos_61_70', label: '61-70' },
  { key: 'pos_71_80', label: '71-80' },
  { key: 'pos_81_90', label: '81-90' },
  { key: 'pos_91_100', label: '91-100' },
];

/**
 * The freshness facts a Labs panel is stamped with.
 *
 * Returns nulls rather than a guess. "We do not know when this index was
 * rebuilt" is an honest caption; "updated today" inferred from our own
 * collection time is not, and it is the specific wrong thing this whole
 * arrangement exists to avoid saying.
 *
 * @param {Object|null} snapshot
 * @returns {{indexUpdatedAt: string|null, collectedAt: string|null,
 *   status: string|null, note: string}}
 */
export const labsFreshness = (snapshot) => ({
  indexUpdatedAt: snapshot?.data?.indexUpdatedAt || null,
  collectedAt: snapshot?.collectedAt || snapshot?.fetchedAt || null,
  status: snapshot?.status || null,
  note: snapshot?.note || '',
});

/**
 * Is this board paying to collect the kind a screen draws?
 *
 * `BoardConnector.kinds` is what gets BOUGHT and `enabledScreens` is what gets
 * RENDERED, and they are deliberately different switches — narrowing kinds
 * reaches across to any co-tenant board mapping the same site, while narrowing
 * screens cannot leave this board. So a screen can legitimately be switched on
 * for a kind nobody is collecting, and the honest answer is a sentence saying
 * so rather than an empty table that reads as a broken connector.
 *
 * AN EMPTY SELECTION MEANS EVERYTHING — the same rule the server applies, spelled
 * here only because the client must not read an absent array as "nothing".
 *
 * @param {Object} data - the connector data payload
 * @param {string} kindKey
 * @returns {boolean}
 */
export const isKindCollected = (data, kindKey) => {
  const selected = data?.selectedKinds;
  if (!Array.isArray(selected) || selected.length === 0) return true;
  return selected.includes(kindKey);
};

// ---------------------------------------------------------------------------
// Keyword research
// ---------------------------------------------------------------------------

/**
 * @param {Object|null} snapshot - the `keyword_metrics` snapshot
 * @returns {Array<Object>}
 */
export const keywordRowsFrom = (snapshot) => {
  const rows = Array.isArray(snapshot?.data?.keywords) ? snapshot.data.keywords : [];
  return rows.map((row) => ({
    keyword: String(row.keyword || ''),
    searchVolume: typeof row.searchVolume === 'number' ? row.searchVolume : null,
    keywordDifficulty:
      typeof row.keywordDifficulty === 'number' ? row.keywordDifficulty : null,
    cpc: typeof row.cpc === 'number' ? row.cpc : null,
    competition: typeof row.competition === 'number' ? row.competition : null,
    intent: row.intent || null,
    intentProbability:
      typeof row.intentProbability === 'number' ? row.intentProbability : null,
    /**
     * Twelve months, and it arrives FREE with every volume row. The sparkline
     * beside a keyword is the difference between "this is falling" and "this is
     * January", and buying it separately later would be a second call.
     */
    monthlySearches: Array.isArray(row.monthlySearches) ? row.monthlySearches : [],
    trendYearly: row.searchVolumeTrend?.yearly ?? null,
    features: Array.isArray(row.serpItemTypes) ? row.serpItemTypes : [],
    band: bandFor(row.keywordDifficulty),
  }));
};

/** The filters the keyword table offers. Buckets OR together, AND with search. */
export const KEYWORD_BUCKETS = [
  ...DIFFICULTY_BANDS.map((band) => ({
    key: `kd:${band.key}`,
    group: 'Difficulty',
    label: band.label,
    test: (r) => r.band?.key === band.key,
  })),
  ...INTENTS.map((intent) => ({
    key: `intent:${intent.key}`,
    group: 'Intent',
    label: intent.label,
    test: (r) => r.intent === intent.key,
  })),
  {
    key: 'hasVolume',
    group: 'Data',
    label: 'Has a volume reading',
    test: (r) => typeof r.searchVolume === 'number',
  },
  {
    /**
     * Kept as its own filter rather than folded into "has a volume reading",
     * because the two are opposite kinds of fact: one is about the keyword, the
     * other is about our data. A person auditing a thin keyword list needs to
     * see the second on its own.
     */
    key: 'unmeasured',
    group: 'Data',
    label: 'No reading at all',
    test: (r) => r.searchVolume === null && r.keywordDifficulty === null,
  },
];

const bucketTests = (buckets, catalog) =>
  buckets.map((k) => catalog.find((b) => b.key === k)).filter(Boolean);

export const filterKeywordRows = (rows, { query = '', buckets = [] } = {}) => {
  const needle = query.trim().toLowerCase();
  const active = bucketTests(buckets, KEYWORD_BUCKETS);
  return rows.filter((row) => {
    if (needle && !row.keyword.toLowerCase().includes(needle)) return false;
    if (!active.length) return true;
    return active.some((b) => b.test(row));
  });
};

const keywordValueOf = (row, key) => {
  switch (key) {
    case 'keyword':
      return row.keyword.toLowerCase();
    case 'searchVolume':
      return row.searchVolume ?? BLANK;
    case 'keywordDifficulty':
      return row.keywordDifficulty ?? BLANK;
    case 'cpc':
      return row.cpc ?? BLANK;
    case 'competition':
      return row.competition ?? BLANK;
    case 'intent':
      return row.intent || BLANK;
    case 'trendYearly':
      return row.trendYearly ?? BLANK;
    case 'features':
      return row.features.length;
    default:
      return BLANK;
  }
};

export const sortKeywordRows = (rows, sort) => sortRowsBy(rows, sort, keywordValueOf);

/**
 * The headline numbers, computed from the ROWS on screen rather than read off
 * the snapshot's stored totals.
 *
 * The stored totals describe the whole collection, which is the right thing on
 * an unfiltered table and the wrong thing under a filter — a summary that
 * disagrees with the table beneath it is worse than no summary. Averages run
 * over the rows that actually carry the number being averaged, so an average
 * difficulty cannot fall because the index failed to answer for ten keywords.
 */
export const summariseKeywordRows = (rows) => {
  const withVolume = rows.filter((r) => typeof r.searchVolume === 'number');
  const withKd = rows.filter((r) => typeof r.keywordDifficulty === 'number');
  const withCpc = rows.filter((r) => typeof r.cpc === 'number');
  const mean = (list, pick, dp = 1) =>
    list.length
      ? Math.round((list.reduce((s, r) => s + pick(r), 0) / list.length) * 10 ** dp) /
        10 ** dp
      : null;

  return {
    keywords: rows.length,
    measured: withVolume.length,
    unmeasured: rows.length - withVolume.length,
    totalVolume: withVolume.length
      ? withVolume.reduce((s, r) => s + r.searchVolume, 0)
      : null,
    averageDifficulty: mean(withKd, (r) => r.keywordDifficulty),
    averageCpc: mean(withCpc, (r) => r.cpc, 2),
    byIntent: INTENTS.map((intent) => ({
      ...intent,
      count: rows.filter((r) => r.intent === intent.key).length,
    })).filter((i) => i.count > 0),
  };
};

// ---------------------------------------------------------------------------
// Competitors
// ---------------------------------------------------------------------------

/**
 * @param {Object|null} snapshot - the `competitors` snapshot
 * @returns {Array<Object>}
 */
export const competitorRowsFrom = (snapshot) => {
  const rows = Array.isArray(snapshot?.data?.competitors) ? snapshot.data.competitors : [];
  return rows.map((row) => ({
    domain: String(row.domain || ''),
    intersections: typeof row.intersections === 'number' ? row.intersections : null,
    avgPosition: typeof row.avgPosition === 'number' ? row.avgPosition : null,
    medianPosition: typeof row.medianPosition === 'number' ? row.medianPosition : null,
    /**
     * THE TWO METRIC TREES, kept apart all the way to the cell.
     *
     * `shared*` is only the keywords this domain has in common with us —
     * "does it compete with me". `full*` is everything it ranks for — "is it a
     * big site". Merged into one column, Wikipedia is your closest competitor.
     */
    sharedKeywords: row.sharedMetrics?.count ?? null,
    sharedEtv: row.sharedMetrics?.etv ?? null,
    fullKeywords: row.fullMetrics?.count ?? null,
    fullEtv: row.fullMetrics?.etv ?? null,
    /**
     * How much of their whole footprint overlaps ours, 0-1. Null unless BOTH
     * sides are present — a ratio with an assumed denominator is a made-up
     * number wearing a percentage sign.
     */
    overlap:
      typeof row.sharedMetrics?.count === 'number' &&
      typeof row.fullMetrics?.count === 'number' &&
      row.fullMetrics.count > 0
        ? Math.round((row.sharedMetrics.count / row.fullMetrics.count) * 1000) / 1000
        : null,
  }));
};

const competitorValueOf = (row, key) => {
  switch (key) {
    case 'domain':
      return row.domain.toLowerCase();
    case 'intersections':
      return row.intersections ?? BLANK;
    case 'avgPosition':
      return row.avgPosition ?? BLANK;
    case 'sharedEtv':
      return row.sharedEtv ?? BLANK;
    case 'fullKeywords':
      return row.fullKeywords ?? BLANK;
    case 'fullEtv':
      return row.fullEtv ?? BLANK;
    case 'overlap':
      return row.overlap ?? BLANK;
    default:
      return BLANK;
  }
};

export const sortCompetitorRows = (rows, sort) => sortRowsBy(rows, sort, competitorValueOf);

export const filterCompetitorRows = (rows, { query = '' } = {}) => {
  const needle = query.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((r) => r.domain.toLowerCase().includes(needle));
};

// ---------------------------------------------------------------------------
// The keyword gap
// ---------------------------------------------------------------------------

/**
 * The comparisons stored on a `keyword_gap` snapshot, one per competitor.
 *
 * One entry per PAIR of domains, never a flat list. A keyword that three
 * competitors all rank for would otherwise appear three times with three
 * different "their rank" values and no column saying whose.
 *
 * @param {Object|null} snapshot
 * @returns {Array<Object>}
 */
export const gapComparisonsFrom = (snapshot) => {
  const list = Array.isArray(snapshot?.data?.comparisons) ? snapshot.data.comparisons : [];
  return list.map((c) => ({
    competitor: String(c.competitor || ''),
    missing: c.totals?.missing ?? 0,
    volumeAtStake: c.totals?.volumeAtStake ?? null,
    inTheirTop10: c.totals?.inTheirTop10 ?? null,
    keywords: Array.isArray(c.keywords) ? c.keywords : [],
  }));
};

export const gapRowsFrom = (comparison) =>
  (comparison?.keywords || []).map((row) => ({
    keyword: String(row.keyword || ''),
    searchVolume: typeof row.searchVolume === 'number' ? row.searchVolume : null,
    keywordDifficulty:
      typeof row.keywordDifficulty === 'number' ? row.keywordDifficulty : null,
    cpc: typeof row.cpc === 'number' ? row.cpc : null,
    competitorRank: typeof row.competitorRank === 'number' ? row.competitorRank : null,
    competitorUrl: row.competitorUrl || null,
    /**
     * NULL IS THE POINT OF THIS REPORT — the gap is the keywords we do not rank
     * for. Rendered as an em dash and never as a zero, or every row would claim
     * a position of nought.
     */
    ourRank: typeof row.ourRank === 'number' ? row.ourRank : null,
    band: bandFor(row.keywordDifficulty),
  }));

const gapValueOf = (row, key) => {
  switch (key) {
    case 'keyword':
      return row.keyword.toLowerCase();
    case 'searchVolume':
      return row.searchVolume ?? BLANK;
    case 'keywordDifficulty':
      return row.keywordDifficulty ?? BLANK;
    case 'cpc':
      return row.cpc ?? BLANK;
    case 'competitorRank':
      return row.competitorRank ?? BLANK;
    default:
      return BLANK;
  }
};

export const sortGapRows = (rows, sort) => sortRowsBy(rows, sort, gapValueOf);

export const GAP_BUCKETS = [
  {
    key: 'theirTop10',
    group: 'Their position',
    label: 'They rank top 10',
    test: (r) => typeof r.competitorRank === 'number' && r.competitorRank <= 10,
  },
  {
    key: 'theirTop3',
    group: 'Their position',
    label: 'They rank top 3',
    test: (r) => typeof r.competitorRank === 'number' && r.competitorRank <= 3,
  },
  ...DIFFICULTY_BANDS.slice(0, 3).map((band) => ({
    key: `kd:${band.key}`,
    group: 'Difficulty',
    label: band.label,
    test: (r) => r.band?.key === band.key,
  })),
];

export const filterGapRows = (rows, { query = '', buckets = [] } = {}) => {
  const needle = query.trim().toLowerCase();
  const active = bucketTests(buckets, GAP_BUCKETS);
  return rows.filter((row) => {
    if (needle && !row.keyword.toLowerCase().includes(needle)) return false;
    if (!active.length) return true;
    return active.some((b) => b.test(row));
  });
};


// ---------------------------------------------------------------------------
// Top pages
// ---------------------------------------------------------------------------

/**
 * @param {Object|null} snapshot - the `top_pages` snapshot
 * @returns {Array<Object>}
 */
export const pageRowsFrom = (snapshot) => {
  const rows = Array.isArray(snapshot?.data?.pages) ? snapshot.data.pages : [];
  return rows.map((row) => {
    const buckets = row.buckets || null;
    const top10 = buckets
      ? ['pos_1', 'pos_2_3', 'pos_4_10'].reduce(
          (sum, key) => (typeof buckets[key] === 'number' ? sum + buckets[key] : sum),
          0
        )
      : null;
    return {
      url: String(row.url || ''),
      /** The path alone, for a table cell. The host is on every row. */
      path: (() => {
        try {
          const parsed = new URL(row.url);
          return `${parsed.pathname}${parsed.search}` || '/';
        } catch {
          return String(row.url || '');
        }
      })(),
      keywords: typeof row.keywords === 'number' ? row.keywords : null,
      /** THEIR estimate of traffic value, not measured traffic. Labelled as such. */
      etv: typeof row.etv === 'number' ? row.etv : null,
      buckets,
      top10,
      isUp: typeof row.isUp === 'number' ? row.isUp : null,
      isDown: typeof row.isDown === 'number' ? row.isDown : null,
    };
  });
};

const pageValueOf = (row, key) => {
  switch (key) {
    case 'url':
      return row.path.toLowerCase();
    case 'keywords':
      return row.keywords ?? BLANK;
    case 'etv':
      return row.etv ?? BLANK;
    case 'top10':
      return row.top10 ?? BLANK;
    default:
      return BLANK;
  }
};

export const sortPageRows = (rows, sort) => sortRowsBy(rows, sort, pageValueOf);

export const filterPageRows = (rows, { query = '' } = {}) => {
  const needle = query.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((r) => r.url.toLowerCase().includes(needle));
};
