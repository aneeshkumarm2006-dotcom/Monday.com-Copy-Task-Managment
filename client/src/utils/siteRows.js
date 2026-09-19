import { BLANK, sortRowsBy } from './rankRows';

/**
 * THE SITES TABLE — its columns, its sort, and its filters.
 *
 * ---- Why the columns are data ----------------------------------------------
 *
 * Because there are eleven of them and every one needs four facts that have to
 * agree: what to print, what to sort on, whether a delta arrow points up when
 * the number goes up, and how wide the cell is. Spelling those out in JSX puts
 * the sort key next to the header and the value-reader next to the cell, forty
 * lines apart, and the failure that produces is the quietest one a table has —
 * a column that sorts by a different number than it shows.
 *
 * So a column is one object, and the header, the cell and the comparator all
 * read the same one.
 *
 * ---- `invert`, and why it is per column ------------------------------------
 *
 * Most of these are better when they go up. `averageRank` is better when it goes
 * DOWN — rank is inverted, 3 beats 8 — and so a `+2` on that column is a red
 * arrow while `+2` backlinks is a green one. This is the same convention
 * `connectorFormat.MOVEMENT` and `rankRows.movementBetween` already hold, and
 * getting it backwards turns every arrow on the page the wrong colour without
 * changing a single number.
 *
 * ---- What is NOT here ------------------------------------------------------
 *
 * The arithmetic. Every number in a row was computed once, server-side, by
 * `services/connectors/siteIndex.js` — which is the only scorer, for the same
 * reason `goalTypes.js` and `adsBudgetPacing.js` are. This file formats and
 * orders what arrived; it does not recompute it, and a column that needed a
 * number nobody sent belongs in that file rather than in this one.
 */

/** A finite number, or null. Never a coerced zero. */
const num = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** `1.2K`, `340`, or an em dash. Compact, because these sit in narrow cells. */
const compact = (value) => {
  const n = num(value);
  if (n === null) return '—';
  if (Math.abs(n) >= 1000) {
    return `${Math.round(n / 100) / 10}K`.replace('.0K', 'K');
  }
  return String(Math.round(n));
};

/** A percentage to one place, or an em dash. Never `0%` for a missing reading. */
const percent = (value) => {
  const n = num(value);
  return n === null ? '—' : `${Math.round(n * 10) / 10}%`;
};

/**
 * The columns, in the order they render.
 *
 * `key` is both the sort key and the field on `row.metrics`, deliberately —
 * one name, so a column cannot sort by something other than what it shows. The
 * two that are not metrics (`site`, `group`) say so with their own `valueOf`.
 *
 * @typedef {Object} SiteColumn
 * @property {string} key
 * @property {string} label
 * @property {string} [help] - the header's tooltip, for a number that needs one
 * @property {'text'|'number'} align
 * @property {(row: Object) => string} format
 * @property {boolean} [invert] - true when SMALLER is better
 * @property {boolean} [defaultOn] - shown before anybody picks
 */

/** @type {SiteColumn[]} */
export const SITE_COLUMNS = [
  {
    key: 'visibility',
    label: 'Visibility',
    help:
      'Our own score, not the provider’s: every tracked keyword weighted by a ' +
      'fixed click-through curve, over the whole tracked set. A measure of ' +
      'rankings — never an estimate of traffic.',
    align: 'number',
    format: (row) => percent(row.metrics?.visibility),
    defaultOn: true,
  },
  {
    key: 'tracked',
    label: 'Keywords',
    help: 'How many keywords this site is set up to collect for.',
    align: 'number',
    // Falls back to the authored list, so a site that has never been collected
    // for still says how big it is rather than showing a dash where its whole
    // configuration should be.
    format: (row) =>
      compact(row.metrics?.tracked ?? row.trackedKeywords?.length ?? null),
    defaultOn: true,
  },
  {
    key: 'ranking',
    label: 'Ranking',
    help: 'Keywords with a position in the depth we bought.',
    align: 'number',
    format: (row) => compact(row.metrics?.ranking),
    defaultOn: true,
  },
  {
    key: 'top3',
    label: 'Top 3',
    align: 'number',
    format: (row) => compact(row.metrics?.top3),
    defaultOn: true,
  },
  {
    key: 'top10',
    label: 'Top 10',
    align: 'number',
    format: (row) => compact(row.metrics?.top10),
    defaultOn: false,
  },
  {
    key: 'averageRank',
    label: 'Avg. position',
    help: 'Averaged over the keywords that rank. Smaller is better.',
    align: 'number',
    // Rank is inverted — see the header. This is the one column where a rise is
    // a fall.
    invert: true,
    format: (row) => {
      const n = num(row.metrics?.averageRank);
      return n === null ? '—' : `#${n}`;
    },
    defaultOn: true,
  },
  {
    key: 'siteHealth',
    label: 'Site health',
    help:
      'DataForSEO’s own on-page score, carried verbatim and computed over the ' +
      'pages the crawl actually reached.',
    align: 'number',
    format: (row) => percent(row.metrics?.siteHealth),
    defaultOn: true,
  },
  {
    key: 'backlinks',
    label: 'Backlinks',
    align: 'number',
    format: (row) => compact(row.metrics?.backlinks),
    defaultOn: true,
  },
  {
    key: 'referringDomains',
    label: 'Ref. domains',
    align: 'number',
    format: (row) => compact(row.metrics?.referringDomains),
    // Off by default, and this is where the default set stops: eleven columns
    // plus a name, a client and a date do not fit a laptop, and a table whose
    // last column is always past the right edge is a table whose row actions
    // nobody finds. The Columns menu turns this and the other two back on.
    defaultOn: false,
  },
  {
    key: 'authorityRank',
    label: 'Domain rank',
    help:
      'DataForSEO’s own 0-1000 rank for this domain. NOT Domain Authority and ' +
      'not Domain Rating — a different scale from a different vendor.',
    align: 'number',
    format: (row) => compact(row.metrics?.authorityRank),
    defaultOn: false,
  },
  {
    key: 'aiPresenceRate',
    label: 'AI Overviews',
    help:
      'How often an AI Overview appeared for these keywords. Counted out of the ' +
      'same SERP reading the rank table already paid for.',
    align: 'number',
    format: (row) => {
      const n = num(row.metrics?.aiPresenceRate);
      return n === null ? '—' : `${Math.round(n * 100)}%`;
    },
    defaultOn: false,
  },
];

export const DEFAULT_SITE_COLUMNS = SITE_COLUMNS.filter((c) => c.defaultOn).map(
  (c) => c.key
);

const COLUMN_BY_KEY = new Map(SITE_COLUMNS.map((c) => [c.key, c]));

/** One column's definition, or null for a key nothing declares. */
export const siteColumn = (key) => COLUMN_BY_KEY.get(key) || null;

/**
 * The four states a site row can be in, as data.
 *
 * Kept as four rather than collapsed into "ready / not", because the action
 * behind each is different: a draft needs finishing, an unmapped site needs a
 * decision about whether it ever belongs to a client, a missing one is somebody
 * else's deletion, and a live mapped one needs nothing.
 *
 * Order matters — `siteStateOf` returns the first that matches, and a draft that
 * also happens to be unmapped is a DRAFT. That is the state with the action.
 */
export const SITE_STATES = [
  { key: 'draft', label: 'Setup unfinished', tone: 'warning' },
  { key: 'missing', label: 'Gone at the provider', tone: 'muted' },
  { key: 'unmapped', label: 'Not mapped to a client', tone: 'muted' },
  { key: 'live', label: 'Collecting', tone: 'positive' },
];

/** Which of the four a row is in. */
export const siteStateOf = (row) => {
  if (!row) return 'live';
  if (row.status === 'draft') return 'draft';
  if (row.missing) return 'missing';
  if (!row.mappedHere && !row.mappedElsewhere) return 'unmapped';
  return 'live';
};

/**
 * Narrow the rows by a search phrase and a set of states.
 *
 * States are OR'd with each other and AND'd with the search — the shape every
 * other filter bar in the app uses (`rankRows.filterRankRows`,
 * `myWorkFilters`). An empty state set means "no opinion" and matches
 * everything, because the state a screen opens in must never be "show nothing".
 *
 * The search covers the name, the domain AND the mapped group's name. The third
 * is the one people actually type: on a board holding two dozen clients, the
 * thing somebody remembers is the client, not the domain.
 *
 * @param {Array<Object>} rows
 * @param {{query?: string, states?: string[]}} [filter]
 * @returns {Array<Object>}
 */
export const filterSiteRows = (rows, { query = '', states = [] } = {}) => {
  const needle = query.trim().toLowerCase();
  const active = new Set(states);

  return rows.filter((row) => {
    if (active.size && !active.has(siteStateOf(row))) return false;
    if (!needle) return true;
    return [row.name, row.domain, row.groupName]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle));
  });
};

/**
 * What a column sorts on, with `BLANK` for a cell that has nothing in it.
 *
 * Reading `row.metrics[key]` by the column's own key is what keeps the sort and
 * the cell honest with each other — see the header. `site` and `group` are the
 * two that are not metrics.
 */
const sortValueOf = (row, key) => {
  if (key === 'site') {
    return String(row.name || row.domain || '').toLowerCase() || BLANK;
  }
  if (key === 'group') return row.groupName ? row.groupName.toLowerCase() : BLANK;
  if (key === 'collectedAt') {
    return row.collectedAt ? new Date(row.collectedAt).getTime() : BLANK;
  }
  if (key === 'tracked') {
    // Matches what the cell prints, including the fallback. A column that sorted
    // on the snapshot total alone would drop every never-collected site to the
    // bottom of a column showing them a number.
    return num(row.metrics?.tracked) ?? num(row.trackedKeywords?.length) ?? BLANK;
  }
  return num(row.metrics?.[key]) ?? BLANK;
};

/**
 * Sort the rows, blanks last in both directions.
 *
 * Delegates to `rankRows.sortRowsBy`, which is the one comparator this app has
 * for "a table full of legitimate nulls". A second copy of the blanks-last rule
 * is a second chance for it to disagree with itself, and this table is mostly
 * blanks on the day a workspace is set up.
 *
 * @param {Array<Object>} rows
 * @param {{key: string|null, dir: 'asc'|'desc'}} sort
 * @returns {Array<Object>}
 */
export const sortSiteRows = (rows, sort = { key: null, dir: 'asc' }) =>
  sortRowsBy(rows, sort, sortValueOf);

/**
 * The totals strip above the table.
 *
 * Counts, never averages. An average visibility across twenty sites of wildly
 * different sizes is a number with no meaning that nonetheless looks like a KPI,
 * and it would be the first thing somebody screenshotted.
 *
 * @param {Array<Object>} rows - the UNFILTERED set
 * @returns {Object}
 */
export const summariseSiteRows = (rows = []) => {
  const live = rows.filter((r) => siteStateOf(r) === 'live');
  return {
    sites: rows.length,
    live: live.length,
    drafts: rows.filter((r) => r.status === 'draft').length,
    unmapped: rows.filter((r) => siteStateOf(r) === 'unmapped').length,
    /**
     * What the whole workspace is set up to buy on every collection: keywords
     * times markets, per site, summed. The number that decides the bill, on the
     * screen where sites are added rather than only inside the form that sets
     * it.
     */
    resultsPerCollection: rows.reduce((sum, row) => {
      if (row.status === 'draft') return sum;
      const keywords = row.trackedKeywords?.length || 0;
      const markets = row.targets?.length || 0;
      return sum + keywords * markets;
    }, 0),
  };
};
