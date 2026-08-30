/**
 * Turning stored rank snapshots into the rows a table draws.
 *
 * Pure, and separated for exactly that reason: every rule here is one a rank
 * tracker can get quietly wrong, and "quietly" is the problem. A movement arrow
 * pointing the wrong way, a `null` rank sorted as a zero, or a "not ranking"
 * keyword counted as ranked at position 0 all render perfectly and all put a
 * wrong number in front of a client.
 *
 * ---- The three-way rule, restated because it is load-bearing ---------------
 *
 * `connectorFormat.js` says a rank has THREE outcomes, not two:
 *
 *   a number  — it ranks, and here is where
 *   `ranked`  — the provider answered, and the answer is "not in the depth we
 *               bought". A FINAL ANSWER.
 *   nothing   — we have no reading at all
 *
 * Everything below preserves that distinction. `null` never becomes `0`, and a
 * keyword we did not measure never becomes a keyword that does not rank.
 *
 * ---- Two providers, two spellings ------------------------------------------
 *
 * The first connector normalises to `position`, the second to `rank`
 * (`rank_group`, its API's own word, sitting beside `rankAbsolute`). Neither is
 * being renamed — see the note in `connectorDataController`'s keyword history.
 * `rankOf` is the one place that reads both, and it uses `typeof` rather than
 * `??` so a legitimate `position: null` is not mistaken for an absent field.
 */

/**
 * The rank on one normalised keyword row, whichever provider produced it.
 *
 * @param {Object} row
 * @returns {number|null}
 */
export const rankOf = (row) => {
  if (!row) return null;
  if (typeof row.rank === 'number') return row.rank;
  if (typeof row.position === 'number') return row.position;
  return null;
};

/**
 * Did the provider actually answer for this keyword?
 *
 * `ranked` is what separates "does not rank" from "we have nothing", and it is
 * the field that makes the three-way rendering possible at all. A row carrying
 * a number is ranked whatever the flag says — a rank IS the answer.
 *
 * @param {Object} row
 * @returns {boolean}
 */
export const answeredFor = (row) =>
  typeof rankOf(row) === 'number' ? true : !!(row && row.ranked);

/**
 * How a keyword moved between two readings.
 *
 * ---- The sign convention, set once ----------------------------------------
 *
 * Rank is INVERTED — 3 is better than 8 — so `change` is `previous - current`
 * and a POSITIVE number is an IMPROVEMENT. That is the same convention the
 * first provider's server-side normaliser uses and the same one
 * `connectorFormat.MOVEMENT` renders against. Flipping either half turns every
 * green arrow red, and the failure is invisible in a screenshot.
 *
 * ---- Why `entered` and `lost` are not "a big change" -----------------------
 *
 * Crossing into or out of the measured depth has no pair of numbers to subtract:
 * one side is `null`. Collapsing them into `flat` would hide the two largest
 * events that can happen to a keyword, and inventing a number for the missing
 * side (0? 101?) would put a fabricated measurement on a client report.
 *
 * @param {Object} current
 * @param {Object|null} previous
 * @returns {{movement: string, change: number|null, previousRank: number|null}}
 */
export const movementBetween = (current, previous) => {
  const now = rankOf(current);
  const before = previous ? rankOf(previous) : null;

  // Nothing to compare against. Not "flat" — we have one reading, not two.
  if (!previous) return { movement: 'none', change: null, previousRank: null };

  if (typeof now === 'number' && typeof before === 'number') {
    const change = before - now;
    if (change > 0) return { movement: 'up', change, previousRank: before };
    if (change < 0) return { movement: 'down', change, previousRank: before };
    return { movement: 'flat', change: 0, previousRank: before };
  }

  if (typeof now === 'number' && before === null) {
    // Only "entered" if the earlier reading was a real "does not rank". If the
    // keyword simply was not measured before, this is a first reading.
    return answeredFor(previous)
      ? { movement: 'entered', change: null, previousRank: null }
      : { movement: 'none', change: null, previousRank: null };
  }

  if (now === null && typeof before === 'number') {
    return answeredFor(current)
      ? { movement: 'lost', change: null, previousRank: before }
      : { movement: 'none', change: null, previousRank: before };
  }

  return { movement: 'none', change: null, previousRank: null };
};

/**
 * The rows the rank table draws, from the newest reading and the one before it.
 *
 * The previous reading is matched BY KEYWORD rather than by index. A keyword
 * added to a Site shifts every array position after it, and an index match would
 * silently compare one keyword's rank against another's — which produces
 * plausible movement arrows for keywords that did not move.
 *
 * @param {Object|null} snapshot - the newest positions/movement snapshot
 * @param {Object|null} previous - the one before it, same kind and variant
 * @returns {Array<Object>}
 */
export const rankRowsFrom = (snapshot, previous = null) => {
  const rows = Array.isArray(snapshot?.data?.keywords) ? snapshot.data.keywords : [];
  const beforeByKeyword = new Map(
    (Array.isArray(previous?.data?.keywords) ? previous.data.keywords : []).map((r) => [
      String(r.keyword || '').toLowerCase(),
      r,
    ])
  );

  return rows.map((row) => {
    const keyword = String(row.keyword || '');
    const before = beforeByKeyword.get(keyword.toLowerCase()) || null;
    const { movement, change, previousRank } = movementBetween(row, before);
    return {
      keyword,
      rank: rankOf(row),
      rankAbsolute: typeof row.rankAbsolute === 'number' ? row.rankAbsolute : null,
      url: row.url || null,
      ranked: answeredFor(row),
      /**
       * How many blocks sit between the organic position and the top of the
       * page. The gap between `rank` and `rankAbsolute` is a free measure of
       * SERP-feature pressure, and it is the only way to explain a traffic drop
       * where the organic position did not move.
       */
      features: Array.isArray(row.itemTypes) ? row.itemTypes : [],
      previousRank,
      change,
      movement,
    };
  });
};

/** The buckets the filter offers. Order is the order they render in. */
export const RANK_BUCKETS = [
  { key: 'top3', label: 'Top 3', test: (r) => typeof r.rank === 'number' && r.rank <= 3 },
  {
    key: 'top10',
    label: 'Top 10',
    test: (r) => typeof r.rank === 'number' && r.rank <= 10,
  },
  {
    key: 'top100',
    label: 'Ranking',
    test: (r) => typeof r.rank === 'number',
  },
  {
    /**
     * "The provider answered and the answer is no." Deliberately NOT the same as
     * "we have no reading" — a table that merged them would report a collection
     * gap as a ranking failure.
     */
    key: 'unranked',
    label: 'Not ranking',
    test: (r) => r.rank === null && r.ranked,
  },
  {
    key: 'improved',
    label: 'Improved',
    test: (r) => r.movement === 'up' || r.movement === 'entered',
  },
  {
    key: 'declined',
    label: 'Declined',
    test: (r) => r.movement === 'down' || r.movement === 'lost',
  },
];

const BUCKET_BY_KEY = new Map(RANK_BUCKETS.map((b) => [b.key, b]));

/**
 * Narrow the rows by a search phrase and a set of buckets.
 *
 * Buckets are OR'd with each other and AND'd with the search, which is the
 * shape every other filter bar in the app uses. An empty bucket set means "no
 * opinion" and matches everything — the same rule as an empty `kinds` array
 * server-side, and for the same reason: the state a screen opens in must not be
 * "show nothing".
 *
 * @param {Array<Object>} rows
 * @param {{query?: string, buckets?: string[]}} [filter]
 * @returns {Array<Object>}
 */
export const filterRankRows = (rows, { query = '', buckets = [] } = {}) => {
  const needle = query.trim().toLowerCase();
  const active = buckets.map((k) => BUCKET_BY_KEY.get(k)).filter(Boolean);

  return rows.filter((row) => {
    if (needle && !row.keyword.toLowerCase().includes(needle)) return false;
    if (!active.length) return true;
    return active.some((b) => b.test(row));
  });
};

/** What a column sorts on, and `BLANK` for a cell with nothing in it. */
export const BLANK = Symbol('blank');

/**
 * Sort any rows, with every blank cell at the bottom in BOTH directions.
 *
 * ---- Why this is the generic one and `sortRankRows` is a caller -------------
 *
 * The blanks-last rule is not a preference, it is the thing that stops a table
 * lying: a blank is not a value, so multiplying its placement by the direction
 * would put two hundred unmeasured rows above every measured one the moment
 * somebody clicked "descending". The rows a person is sorting to find are the
 * ones with numbers in them.
 *
 * Phase 6 added four more Labs tables — keywords, competitors, gap, pages — and
 * every one of them is FULL of legitimate nulls: a keyword the index has no
 * difficulty for, a competitor with no shared traffic value, a page with no
 * bucket data. Four more copies of this comparator is four more chances for one
 * of them to disagree. So the rule lives here once and the callers supply only
 * what a column reads.
 *
 * A tie keeps the incoming order, so a re-sort is stable and the table does not
 * reshuffle rows that compare equal.
 *
 * @param {Array<Object>} rows
 * @param {{key: string|null, dir: 'asc'|'desc'}} sort
 * @param {(row: Object, key: string) => any} valueOf - returns `BLANK` for empty
 * @returns {Array<Object>}
 */
export const sortRowsBy = (rows, { key = null, dir = 'asc' } = {}, valueOf) => {
  if (!key) return rows;
  const mul = dir === 'desc' ? -1 : 1;

  return rows
    .map((row, index) => ({ row, index, value: valueOf(row, key) }))
    .sort((a, b) => {
      const aBlank = a.value === BLANK || a.value === null || a.value === undefined;
      const bBlank = b.value === BLANK || b.value === null || b.value === undefined;
      if (aBlank || bBlank) {
        // Never multiplied by `mul`. See the header.
        if (aBlank !== bBlank) return aBlank ? 1 : -1;
        return a.index - b.index;
      }
      const cmp =
        typeof a.value === 'string'
          ? a.value.localeCompare(b.value)
          : a.value - b.value;
      return cmp !== 0 ? cmp * mul : a.index - b.index;
    })
    .map((entry) => entry.row);
};

const sortValueOf = (row, key) => {
  switch (key) {
    case 'keyword':
      return row.keyword.toLowerCase();
    case 'rank':
      return typeof row.rank === 'number' ? row.rank : BLANK;
    case 'rankAbsolute':
      return typeof row.rankAbsolute === 'number' ? row.rankAbsolute : BLANK;
    case 'change':
      return typeof row.change === 'number' ? row.change : BLANK;
    case 'previousRank':
      return typeof row.previousRank === 'number' ? row.previousRank : BLANK;
    case 'features':
      return row.features.length;
    case 'url':
      return row.url ? row.url.toLowerCase() : BLANK;
    default:
      return BLANK;
  }
};

/**
 * Sort the rows, with every blank cell at the bottom in BOTH directions.
 *
 * The same rule `goalSort.js` settled on, and it is worth restating why: a
 * blank is not a value, so multiplying its placement by the direction would put
 * two hundred unmeasured keywords above every measured one the moment somebody
 * clicked "descending". The rows a person is sorting to find are the ones with
 * numbers in them.
 *
 * A tie keeps the incoming order, so a re-sort is stable and the table does not
 * reshuffle rows that compare equal.
 *
 * @param {Array<Object>} rows
 * @param {{key: string|null, dir: 'asc'|'desc'}} sort
 * @returns {Array<Object>}
 */
export const sortRankRows = (rows, sort = { key: null, dir: 'asc' }) =>
  sortRowsBy(rows, sort, sortValueOf);

/**
 * One page of rows, plus everything a pager needs to render itself.
 *
 * ---- Why pages rather than "Load more" -------------------------------------
 *
 * The app's other long lists are feeds, where "Load more" is right: they are
 * read newest-first and nobody goes back to page four of an activity log. A
 * rank table is not a feed. It is sorted, it is compared week to week, and the
 * question is "where is this keyword" — which needs a stable, addressable
 * position and a total, not an ever-growing scroll.
 *
 * The page is CLAMPED rather than trusted, so deleting keywords out from under
 * somebody sitting on page nine shows them the last page instead of a blank one.
 *
 * @param {Array<Object>} rows
 * @param {{page?: number, pageSize?: number}} [opts]
 */
export const paginate = (rows, { page = 1, pageSize = 25 } = {}) => {
  const size = Math.max(1, pageSize);
  const total = rows.length;
  const pageCount = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(1, Math.floor(page) || 1), pageCount);
  const start = (current - 1) * size;
  return {
    rows: rows.slice(start, start + size),
    page: current,
    pageCount,
    pageSize: size,
    total,
    // 1-based and inclusive, because that is how the caption reads them:
    // "26-50 of 200". Both are 0 when there is nothing.
    from: total ? start + 1 : 0,
    to: Math.min(start + size, total),
  };
};

/**
 * The headline counts, computed from the ROWS rather than read off the snapshot.
 *
 * The snapshot carries its own `totals`, and they are the right thing to show
 * for the collection as a whole. These are for the FILTERED view, where the
 * stored totals would describe a different set of keywords than the one on
 * screen — a summary that disagrees with the table under it is worse than no
 * summary.
 *
 * `averageRank` is over the RANKING keywords only, and null when none rank.
 * Averaging an unranked keyword in as 0 or as 101 both produce a number that
 * moves for reasons nobody can explain.
 *
 * @param {Array<Object>} rows
 */
export const summariseRankRows = (rows) => {
  const ranking = rows.filter((r) => typeof r.rank === 'number');
  const inTop = (n) => ranking.filter((r) => r.rank <= n).length;
  return {
    tracked: rows.length,
    ranking: ranking.length,
    notRanking: rows.filter((r) => r.rank === null && r.ranked).length,
    unmeasured: rows.filter((r) => r.rank === null && !r.ranked).length,
    top3: inTop(3),
    top10: inTop(10),
    improved: rows.filter((r) => r.movement === 'up' || r.movement === 'entered').length,
    declined: rows.filter((r) => r.movement === 'down' || r.movement === 'lost').length,
    averageRank: ranking.length
      ? Math.round((ranking.reduce((sum, r) => sum + r.rank, 0) / ranking.length) * 10) / 10
      : null,
  };
};
