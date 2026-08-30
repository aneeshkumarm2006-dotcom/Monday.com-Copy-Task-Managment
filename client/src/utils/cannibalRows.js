import { BLANK, sortRowsBy } from './rankRows.js';
import { isKindCollected } from './labsRows.js';

/**
 * The Cannibalization screen's rows.
 *
 * ---- Free, and free for two different reasons ------------------------------
 *
 * The DATA is free: more than one of our own URLs on one SERP is a fact sitting
 * inside the payload the weekly census already bought, and `normaliseSerpResult`
 * reads it on the way past.
 *
 * The MEANING is free only at depth. A second URL of ours at position 47 is
 * invisible to the daily ten-deep check, so this screen draws `positions` and
 * never `movement` — and the screen says which depth it is looking at, because
 * "we found nothing" reads very differently at 10 than at 100.
 *
 * ---- What cannibalization is, stated once ----------------------------------
 *
 * TWO OF OUR PAGES COMPETING FOR ONE QUERY. Not one page ranking for many
 * keywords, which is a healthy page; not two pages on similar topics, which is a
 * content question nobody can answer from a SERP. The measurement is per
 * keyword, and the finding is the SECOND URL.
 *
 * ---- And what a "health" number must be taken over -------------------------
 *
 * The keywords we appear for AT ALL. A site ranking for twelve of two hundred
 * tracked keywords, cleanly, scores 6% health against the whole set — which is a
 * ranking problem rendered as a duplication problem, on a panel headed
 * "cannibalization". The server computes it the right way; this file reads it
 * and never recomputes it.
 */

const numberOr = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

export { isKindCollected };

/**
 * The headline numbers, or null.
 *
 * @param {Object|null} snapshot - the `positions` snapshot
 * @returns {Object|null}
 */
export const cannibalSummaryFrom = (snapshot) => {
  const c = snapshot?.data?.cannibalization || null;
  if (!c) return null;
  return {
    ranking: numberOr(c.ranking) ?? 0,
    competing: numberOr(c.competing) ?? 0,
    extraUrls: numberOr(c.extraUrls) ?? 0,
    competingRate: numberOr(c.competingRate),
    /**
     * 100 = clean. NULL when nothing ranked, which is a real answer and not
     * zero — zero would mean every ranking keyword is cannibalised, the
     * opposite claim. `connectorFormat` renders it as an em dash.
     */
    healthPct: numberOr(c.healthPct),
    depth: numberOr(snapshot?.data?.depth),
    tracked: numberOr(snapshot?.data?.totals?.tracked) ?? 0,
  };
};

/**
 * One row per keyword where more than one of our URLs appears.
 *
 * Keywords with one URL, or none, are not rows on this screen — they are the
 * denominator. A table listing every tracked keyword with a "1" beside most of
 * them buries the finding it exists to surface.
 *
 * @param {Object|null} snapshot
 * @returns {Array<Object>}
 */
export const cannibalRowsFrom = (snapshot) => {
  const rows = Array.isArray(snapshot?.data?.keywords) ? snapshot.data.keywords : [];

  return rows
    .filter((row) => Array.isArray(row.ownUrls) && row.ownUrls.length > 1)
    .map((row) => {
      const urls = row.ownUrls.map((u) => ({
        url: typeof u.url === 'string' ? u.url : null,
        rank: numberOr(u.rank),
        rankAbsolute: numberOr(u.rankAbsolute),
      }));
      const ranks = urls.map((u) => u.rank).filter((r) => typeof r === 'number');

      return {
        keyword: String(row.keyword || ''),
        urls,
        count: urls.length,
        best: ranks.length ? Math.min(...ranks) : null,
        worst: ranks.length ? Math.max(...ranks) : null,
        /**
         * HOW FAR APART they are, which is the severity signal.
         *
         * Two of our pages at 3 and 4 is a rich result or a sitelink pair and is
         * usually fine. Two at 3 and 61 is one page being held back by a page
         * Google prefers to ignore — the same query, answered twice, with the
         * weaker answer taking the link equity.
         */
        spread: ranks.length > 1 ? Math.max(...ranks) - Math.min(...ranks) : null,
        /** How many URLs beyond the best one. The number that sums to the total. */
        surplus: urls.length - 1,
      };
    });
};

/** Filename-safe path of a URL, for a narrow column. */
export const pathOf = (url) => {
  if (typeof url !== 'string' || !url) return '—';
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}` || '/';
  } catch {
    return url;
  }
};

export const CANNIBAL_BUCKETS = [
  {
    key: 'severe',
    label: 'Far apart (20+)',
    match: (row) => typeof row.spread === 'number' && row.spread >= 20,
  },
  {
    key: 'adjacent',
    label: 'Adjacent (under 5)',
    match: (row) => typeof row.spread === 'number' && row.spread < 5,
  },
  { key: 'three_plus', label: 'Three or more pages', match: (row) => row.count >= 3 },
  {
    key: 'top10',
    label: 'Best is on page one',
    match: (row) => typeof row.best === 'number' && row.best <= 10,
  },
];

export const filterCannibalRows = (rows, { query = '', buckets = [] } = {}) => {
  const needle = query.trim().toLowerCase();
  const wanted = CANNIBAL_BUCKETS.filter((b) => buckets.includes(b.key));
  return rows.filter((row) => {
    if (
      needle &&
      !row.keyword.toLowerCase().includes(needle) &&
      !row.urls.some((u) => (u.url || '').toLowerCase().includes(needle))
    ) {
      return false;
    }
    if (wanted.length && !wanted.some((b) => b.match(row))) return false;
    return true;
  });
};

const cannibalValueOf = (row, key) => {
  switch (key) {
    case 'keyword':
      return row.keyword.toLowerCase();
    case 'count':
      return row.count;
    case 'best':
      return row.best === null ? BLANK : row.best;
    case 'worst':
      return row.worst === null ? BLANK : row.worst;
    case 'spread':
      return row.spread === null ? BLANK : row.spread;
    default:
      return BLANK;
  }
};

export const sortCannibalRows = (rows, sort) => sortRowsBy(rows, sort, cannibalValueOf);

/**
 * Which of our pages turn up on the most competing queries.
 *
 * The keyword table says which QUERIES are contested; this says which PAGES keep
 * turning up on somebody else's query, which is the list a consolidation plan is
 * written from.
 *
 * @param {Array<Object>} rows - from `cannibalRowsFrom`
 * @returns {Array<{url: string, keywords: number, bestRank: number|null}>}
 */
export const offendingPages = (rows) => {
  const map = new Map();
  for (const row of rows) {
    for (const entry of row.urls) {
      if (!entry.url) continue;
      const held = map.get(entry.url) || { url: entry.url, keywords: 0, bestRank: null };
      held.keywords += 1;
      if (typeof entry.rank === 'number') {
        held.bestRank =
          held.bestRank === null ? entry.rank : Math.min(held.bestRank, entry.rank);
      }
      map.set(entry.url, held);
    }
  }
  return [...map.values()].sort(
    (a, b) => b.keywords - a.keywords || a.url.localeCompare(b.url)
  );
};
