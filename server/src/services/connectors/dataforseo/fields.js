const K = require('./onpageChecks');

/**
 * The mappable field catalog — every value DataForSEO can produce that a person
 * may bind to somewhere on a goal.
 *
 * Same contract as `ubersuggest/fields.js`, one directory over, and deliberately
 * so: `fieldMapping.js` and `connectorGoalWriteback.js` know nothing about
 * either provider, so a second catalog is the whole of what a second provider
 * has to write. What is different here is the SCALE and the number of ways a
 * field can be read wrongly — twenty-six fields over five kinds became a
 * hundred-odd over eleven, and four of the traps phases 6-8 exist to stop are
 * reachable from this file.
 *
 * ---- The four things this file refuses to expose ---------------------------
 *
 * 1. `referring_domains[].rank`, under any name that sounds like authority. On
 *    a referring-domain row that number is the rank of the LINKS THAT DOMAIN
 *    SENDS US, not its own standing — a link farm sending four hundred sitewide
 *    links scores 940 and the New York Times sending one editorial link scores
 *    210. `backlinksNormalise` already carries it as `linksRank` for exactly
 *    that reason, and it is a per-ROW fact besides, so it is not a project-level
 *    field at all. Domain authority comes from `bulk_ranks` under
 *    `authority_rank` and from nowhere else.
 *
 * 2. Anything called DA or DR. `domain_rank` is DataForSEO's own 0-1000 metric —
 *    original PageRank, damping 0.5, logarithmically compressed over their own
 *    crawl — and they say in as many words that it should not be expected to
 *    match Ahrefs' Domain Rating. The label and the blurb both say 0-1000, and
 *    `rank_scale` is stored on the snapshot beside it because the conversion to
 *    0-100 is `sin(rank / 636.62) * 100`, which is not linear and therefore not
 *    recoverable from the number.
 *
 * 3. A DOFOLLOW COUNT COMPUTED BY SUBTRACTION. `*_nofollow` means "at least one
 *    nofollow link", so the two sets overlap and the difference is not the
 *    followed set. `dofollow_backlinks` reads the second, independently filtered
 *    `summary` call's own answer or reports null. There is no third branch here
 *    for the same reason there is none in `aggregateSummary`.
 *
 * 4. AN ISSUE COUNT THIS FILE INVERTED ITSELF. Ten of DataForSEO's check
 *    counters count pages that PASS, and the arithmetic that turns one into an
 *    issue count lives in exactly one function in the codebase
 *    (`onpageChecks.issueCountFor`), which has already run by the time a
 *    snapshot is written. Every audit-issue field below reads `issues[].pages`
 *    and does no arithmetic at all.
 *
 * ---- The audit issues are ADDRESSED, not flattened -------------------------
 *
 * `site_audit` is a new field shape: one object plus a KEYED list. "Get broken
 * links under 10" is a goal about `issues[key='broken_links'].pages`, not about
 * a top-level number, and the two available answers were to flatten the useful
 * ones onto `totals` in the normaliser or to address the keyed row from here.
 *
 * ADDRESSING WON, and the reason is that flattening freezes the list. A
 * flattened `totals.brokenLinks` is a field somebody chose to add; the checks
 * nobody thought of are unmappable forever, and the day DataForSEO ship a new
 * one it stays unmappable until a person edits a normaliser. Addressing makes
 * the catalog a FUNCTION of `onpageChecks.CHECKS`, so classifying a check is the
 * only act needed to make it goal-mappable.
 *
 * The line between which checks get an entry is DATAFORSEO'S OWN and not ours:
 * `weight > 0`, which is exactly the twelve errors summing to 78 and the
 * twenty-two warnings summing to 123 that their published formula
 * (`Sc = 100 - SUM(En/78)x55 - SUM(Wn/123)x45`) is computed over. A weight-0
 * notice does not move the score and is not a thing a month is promised on. It
 * also drops both `mirrors` rows automatically — `has_meta_title` mirrors
 * `no_title` — which is what stops the same population being bindable twice
 * under two names.
 *
 * ---- What is NOT here, and why it is a finding rather than an omission -----
 *
 * `domain_info.ssl.valid` and the eleven site-wide `domain_info.checks`
 * booleans are the only values DataForSEO returns that this catalog cannot
 * carry. `fieldMapping.SOURCE_TYPES` is `number | text | date | link` and has no
 * boolean, and `ACCEPTS` has no row for one — a `boolean` source type would have
 * to be added there, and with it a decision about what a `true` looks like in a
 * `text` column and whether a goal column may ever hold one. That is a change to
 * the generic engine on behalf of one provider's eleven booleans, and it is
 * recorded here rather than made quietly. `ssl_expires_on` carries the one fact
 * of the group anybody sets a goal on, as a date.
 */

/** A finite number, or null. Never NaN, never a coerced empty string. */
const numOrNull = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * A 0-1 fraction, as a PERCENTAGE, or null.
 *
 * The stored aggregates carry rates as fractions because that is what arithmetic
 * wants; a goal column carries what a person reads, and nobody sets a target of
 * 0.42. Rounded to a tenth, which is the precision a rate over a two-hundred
 * keyword set can honestly claim.
 */
const asPercent = (value) =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value * 1000) / 10
    : null;

/** A non-empty string, or null. */
const strOrNull = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

/**
 * `YYYY-MM-DD` from anything date-shaped, or null.
 *
 * Deliberately NOT `parseDfsTime`. That function throws, because a SERP result
 * filed under the wrong day is a data-integrity bug — and it has already run,
 * on the way in, before any of this was stored. What arrives here is our own
 * normalised value, and a reader that threw would take a whole weekly writeback
 * down over one unreadable caption.
 */
const dayKeyOf = (value) => {
  if (!value) return null;
  if (typeof value === 'string') {
    const m = value.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

/**
 * The row for one keyword inside a rank or keyword-research snapshot.
 *
 * Matched case-insensitively, because the phrase arrives from DataForSEO on one
 * side and is typed by a person into a goal link on the other. Null for a
 * keyword the snapshot has no row for — a keyword added to a Site after the last
 * collection is the normal case, not a fault.
 */
const rowFor = (data, keyword) => {
  const needle = strOrNull(keyword);
  if (!needle) return null;
  const rows = Array.isArray(data?.keywords) ? data.keywords : [];
  const lower = needle.toLowerCase();
  return rows.find((r) => strOrNull(r?.keyword)?.toLowerCase() === lower) || null;
};

/** A list of strings as one readable cell, or null for an empty list. */
const listAsText = (value) => {
  if (!Array.isArray(value)) return null;
  const parts = value.map(strOrNull).filter(Boolean);
  return parts.length ? parts.join(', ') : null;
};

const NOT_IN_DEPTH =
  'Not inside the results we bought — a final answer from the provider, not a missing reading.';

const NOT_COLLECTED =
  'The second, dofollow-filtered call did not answer. It is never derived by ' +
  'subtracting the nofollow count, because those two sets overlap.';

/**
 * @typedef {Object} ConnectorField
 * @property {string} key       - stored on the mapping row AND used as a URL path
 *   segment, so `[a-z0-9_]` only; renaming one is a migration
 * @property {string} label
 * @property {string} blurb
 * @property {'number'|'text'|'date'|'link'} type
 * @property {string} kind      - the snapshot kind that carries it
 * @property {'keyword'|'project'} scope
 * @property {boolean} [derived]
 * @property {string} [nullMeans]
 * @property {(data: any, ctx: {keyword?: string}) => any} read
 */

// ---------------------------------------------------------------------------
// Rank tracking — `positions` (weekly census) and `movement` (daily check)
// ---------------------------------------------------------------------------

/**
 * The two rank kinds share `aggregatePositions`' body exactly, so their readers
 * are one set of functions used twice rather than two sets that could drift.
 *
 * They are still separate FIELDS, and that is not duplication for its own sake:
 * `positions` is a `depth: 100` census and `movement` is a `depth: 10` check, so
 * a keyword at 40 reads 40 in one and null in the other. Those are two different
 * measurements of the same keyword and a goal has to say which one it means —
 * and a frugal board that switched the weekly census off still needs its daily
 * ranks to reach a goal column.
 */
const rankReaders = {
  rank: (data, { keyword } = {}) => numOrNull(rowFor(data, keyword)?.rank),
  rankAbsolute: (data, { keyword } = {}) => numOrNull(rowFor(data, keyword)?.rankAbsolute),
  url: (data, { keyword } = {}) => strOrNull(rowFor(data, keyword)?.url),
  features: (data, { keyword } = {}) => listAsText(rowFor(data, keyword)?.itemTypes),
  total: (name) => (data) => numOrNull(data?.totals?.[name]),
  collectedOn: (data) => dayKeyOf(data?.collectedAt),
};

const rankFields = (kind, prefix, labelSuffix) => [
  {
    key: `${prefix}rank`,
    label: `Rank${labelSuffix}`,
    blurb:
      kind === 'positions'
        ? 'Where this keyword ranks in the weekly hundred-result census.'
        : 'Where this keyword ranks in the daily top-ten check. Null once it leaves the top ten.',
    type: 'number',
    kind,
    scope: 'keyword',
    nullMeans: NOT_IN_DEPTH,
    read: rankReaders.rank,
  },
  {
    key: `${prefix}rank_absolute`,
    label: `Rank counting every block${labelSuffix}`,
    blurb:
      'Position counting ads, snippets and every other block on the page, not ' +
      'just the organic results. The gap between this and the organic rank is ' +
      'how much SERP-feature pressure the keyword is under.',
    type: 'number',
    kind,
    scope: 'keyword',
    nullMeans: NOT_IN_DEPTH,
    read: rankReaders.rankAbsolute,
  },
  {
    key: `${prefix}ranking_url`,
    label: `Ranking page${labelSuffix}`,
    blurb: 'The URL of ours that ranks for this keyword.',
    type: 'link',
    kind,
    scope: 'keyword',
    read: rankReaders.url,
  },
  {
    key: `${prefix}keywords_ranked`,
    label: `Keywords ranking${labelSuffix}`,
    blurb: 'How many tracked keywords placed at all.',
    type: 'number',
    kind,
    scope: 'project',
    read: rankReaders.total('ranked'),
  },
  {
    key: `${prefix}keywords_top3`,
    label: `Keywords in the top 3${labelSuffix}`,
    blurb: 'How many tracked keywords sit at position 3 or better.',
    type: 'number',
    kind,
    scope: 'project',
    read: rankReaders.total('top3'),
  },
  {
    key: `${prefix}keywords_top10`,
    label: `Keywords on page one${labelSuffix}`,
    blurb: 'How many tracked keywords sit at position 10 or better.',
    type: 'number',
    kind,
    scope: 'project',
    read: rankReaders.total('top10'),
  },
  {
    key: `${prefix}average_rank`,
    label: `Average rank${labelSuffix}`,
    blurb:
      'Averaged over the keywords that RANKED, and null when none did. ' +
      'Counting an unranked keyword as 0 or as 101 produces a number that moves ' +
      'for reasons nobody can explain.',
    type: 'number',
    kind,
    scope: 'project',
    read: rankReaders.total('averageRank'),
  },
  // ---- Phase 10: AI Visibility ---------------------------------------------
  //
  // On BOTH rank kinds, because the `ai_overview` block sits above the organic
  // results and rides in at either depth — the daily check sees it as reliably
  // as the weekly census does. That is the opposite of the cannibalization
  // fields below, which exist only on `positions`.
  //
  // CITED AND MENTIONED ARE TWO FIELDS WITH TWO BLURBS. There is deliberately no
  // combined "AI visibility" number anywhere in this catalog: cited is fixed by
  // earning links, mentioned by covering the entity, and one figure that moves
  // for either reason tells a reader to do neither.
  {
    key: `${prefix}ai_overview_keywords`,
    label: `Keywords showing an AI Overview${labelSuffix}`,
    blurb:
      'How many tracked keywords now return an AI Overview at all. The market ' +
      'fact, and the denominator the two below are taken against.',
    type: 'number',
    kind,
    scope: 'project',
    read: (data) => numOrNull(data?.aiVisibility?.withOverview),
  },
  {
    key: `${prefix}ai_overview_rate`,
    label: `Share of keywords with an AI Overview${labelSuffix}`,
    blurb:
      'As a percentage of EVERY tracked keyword — how much of this keyword set ' +
      'Google now answers itself.',
    type: 'number',
    kind,
    scope: 'project',
    read: (data) => asPercent(data?.aiVisibility?.presenceRate),
  },
  {
    key: `${prefix}ai_cited`,
    label: `Keywords where the AI Overview CITES this site${labelSuffix}`,
    blurb:
      'Our domain appears in the reference list Google attached to its own ' +
      'summary. Exact, and the half that carries a link.',
    type: 'number',
    kind,
    scope: 'project',
    read: (data) => numOrNull(data?.aiVisibility?.cited),
  },
  {
    key: `${prefix}ai_cited_rate`,
    label: `Citation rate inside AI Overviews${labelSuffix}`,
    blurb:
      'As a percentage of the keywords that HAVE an overview, never of all ' +
      'tracked keywords — divided the other way this falls whenever Google ' +
      'shows fewer overviews, which reads as our visibility collapsing on a ' +
      'week nothing happened.',
    type: 'number',
    kind,
    scope: 'project',
    read: (data) => asPercent(data?.aiVisibility?.citedRate),
  },
  {
    key: `${prefix}ai_mentioned`,
    label: `Keywords where the AI Overview NAMES this brand${labelSuffix}`,
    blurb:
      'The brand word appears in the summary text. A DIFFERENT metric from ' +
      'being cited: it carries no link, and it is inferred from prose rather ' +
      'than read from a field.',
    type: 'number',
    kind,
    scope: 'project',
    read: (data) => numOrNull(data?.aiVisibility?.mentioned),
  },
  {
    key: `${prefix}ai_mentioned_rate`,
    label: `Mention rate inside AI Overviews${labelSuffix}`,
    blurb: 'As a percentage of the keywords that have an overview. See above.',
    type: 'number',
    kind,
    scope: 'project',
    read: (data) => asPercent(data?.aiVisibility?.mentionedRate),
  },
  {
    key: `${prefix}ai_mentioned_not_cited`,
    label: `Named but not cited${labelSuffix}`,
    blurb:
      'Recall with no click. Named rather than folded into either count, ' +
      'because it is the one combination with an obvious action behind it.',
    type: 'number',
    kind,
    scope: 'project',
    read: (data) => numOrNull(data?.aiVisibility?.mentionedNotCited),
  },
  {
    key: `${prefix}ai_citation_position`,
    label: `Position in the AI Overview citation list${labelSuffix}`,
    blurb:
      'Where this keyword’s overview cites us, counting from the top of the ' +
      'reference list. Null when it does not cite us — which is NOT "not in the ' +
      'top 100", so this never goes through the rank formatter.',
    type: 'number',
    kind,
    scope: 'keyword',
    nullMeans: 'This keyword’s AI Overview does not cite this site.',
    read: (data, { keyword } = {}) =>
      numOrNull(rowFor(data, keyword)?.aiOverview?.citationRank),
  },
  {
    key: `${prefix}collected_on`,
    label: `Rankings collected on${labelSuffix}`,
    blurb: 'The day DataForSEO read the SERP, which is theirs and not ours.',
    type: 'date',
    kind,
    scope: 'project',
    read: rankReaders.collectedOn,
  },
];

// ---------------------------------------------------------------------------
// Site audit — the keyed issue list
// ---------------------------------------------------------------------------

/** The issue row for one check key, or null when the crawl did not carry it. */
const issueRow = (data, checkKey) => {
  const rows = Array.isArray(data?.issues) ? data.issues : [];
  return rows.find((row) => row?.key === checkKey) || null;
};

/**
 * One mappable field per check DataForSEO's own formula gives a weight to.
 *
 * GENERATED, which is the point — see the header. `CHECKS` is the catalog, the
 * severity and the label come from it, and the reader takes `pages` verbatim
 * because `issueCountFor` has already applied the direction. A positive check
 * that ever gained a weight would arrive here already inverted.
 */
const auditIssueFields = () =>
  K.CHECKS.filter((spec) => spec.weight > 0).map((spec) => ({
    key: `issue_${spec.key}`,
    label: spec.label,
    blurb:
      `Pages affected by this ${spec.severity}, out of the pages the last crawl ` +
      'reached. Null when the crawl has no usable page count, never 0.',
    type: 'number',
    kind: 'site_audit',
    scope: 'project',
    /** The severity bucket, so the panel can group a long list. Display only. */
    severity: spec.severity,
    read: (data) => numOrNull(issueRow(data, spec.key)?.pages),
  }));

/** @type {ConnectorField[]} */
const FIELDS = [
  // ---- positions — the weekly hundred-result census ------------------------
  ...rankFields('positions', '', ''),
  {
    key: 'keywords_tracked',
    label: 'Keywords tracked',
    blurb: 'How many keywords this Site follows in this market.',
    type: 'number',
    kind: 'positions',
    scope: 'project',
    read: (data) => numOrNull(data?.totals?.tracked),
  },
  {
    key: 'keywords_top100',
    label: 'Keywords in the top 100',
    blurb: 'How many tracked keywords placed inside the hundred results we bought.',
    type: 'number',
    kind: 'positions',
    scope: 'project',
    read: (data) => numOrNull(data?.totals?.top100),
  },
  {
    key: 'serp_features',
    label: 'Search features on the page',
    blurb:
      'Every block type DataForSEO saw on this keyword’s results page — ' +
      'featured snippets, People Also Ask, local packs and the rest.',
    type: 'text',
    kind: 'positions',
    scope: 'keyword',
    read: rankReaders.features,
  },
  {
    key: 'serp_results_count',
    label: 'Results Google reports',
    blurb: 'Google’s own claimed result count for the keyword.',
    type: 'number',
    kind: 'positions',
    scope: 'keyword',
    read: (data, { keyword } = {}) => numOrNull(rowFor(data, keyword)?.resultsCount),
  },

  // ---- movement — the daily top-ten check ---------------------------------
  ...rankFields('movement', 'daily_', ' (daily)'),

  // ---- keyword_metrics — the Labs competitive index ------------------------
  {
    key: 'volume',
    label: 'Search volume',
    blurb: 'Estimated monthly searches. A twelve-month rolling average, not last month.',
    type: 'number',
    kind: 'keyword_metrics',
    scope: 'keyword',
    read: (data, { keyword } = {}) => numOrNull(rowFor(data, keyword)?.searchVolume),
  },
  {
    key: 'keyword_difficulty',
    label: 'Keyword difficulty',
    blurb:
      'DataForSEO’s 0-100 log-scale estimate of the chance of ranking in the ' +
      'top ten. A DIFFERENT number from paid competition below, and routinely ' +
      'confused with it.',
    type: 'number',
    kind: 'keyword_metrics',
    scope: 'keyword',
    read: (data, { keyword } = {}) => numOrNull(rowFor(data, keyword)?.keywordDifficulty),
  },
  {
    key: 'cpc',
    label: 'Cost per click',
    blurb: 'What advertisers pay for this keyword.',
    type: 'number',
    kind: 'keyword_metrics',
    scope: 'keyword',
    read: (data, { keyword } = {}) => numOrNull(rowFor(data, keyword)?.cpc),
  },
  {
    key: 'paid_competition',
    label: 'Paid competition',
    blurb:
      'Google Ads auction competition, 0-1. A measure of the AD auction and not ' +
      'of how hard the keyword is to rank for organically.',
    type: 'number',
    kind: 'keyword_metrics',
    scope: 'keyword',
    read: (data, { keyword } = {}) => numOrNull(rowFor(data, keyword)?.competition),
  },
  {
    key: 'search_intent',
    label: 'Search intent',
    blurb: 'What the searcher is trying to do — informational, commercial, and so on.',
    type: 'text',
    kind: 'keyword_metrics',
    scope: 'keyword',
    read: (data, { keyword } = {}) => strOrNull(rowFor(data, keyword)?.intent),
  },
  {
    key: 'intent_confidence',
    label: 'How sure the intent is',
    blurb:
      'The probability behind the intent above. 31% is a contested SERP; 78% is ' +
      'a settled one, and the difference is the whole reason the number is kept.',
    type: 'number',
    kind: 'keyword_metrics',
    scope: 'keyword',
    read: (data, { keyword } = {}) => numOrNull(rowFor(data, keyword)?.intentProbability),
  },
  {
    key: 'volume_trend_yearly',
    label: 'Volume change over a year',
    blurb: 'Percentage change in searches against the same period a year ago.',
    type: 'number',
    kind: 'keyword_metrics',
    scope: 'keyword',
    read: (data, { keyword } = {}) =>
      numOrNull(rowFor(data, keyword)?.searchVolumeTrend?.yearly),
  },
  {
    key: 'keywords_total_volume',
    label: 'Total searches across the list',
    blurb: 'Every tracked keyword’s volume added up. Keywords with no reading are left out.',
    type: 'number',
    kind: 'keyword_metrics',
    scope: 'project',
    read: (data) => numOrNull(data?.totals?.totalVolume),
  },
  {
    key: 'keywords_average_volume',
    label: 'Average searches per keyword',
    blurb: 'Averaged over the keywords that carry a volume, never over the whole list.',
    type: 'number',
    kind: 'keyword_metrics',
    scope: 'project',
    read: (data) => numOrNull(data?.totals?.averageVolume),
  },
  {
    key: 'keywords_average_difficulty',
    label: 'Average keyword difficulty',
    blurb:
      'Averaged over the keywords that carry a difficulty. Counting a missing ' +
      'one as zero would make the number improve when the data got worse.',
    type: 'number',
    kind: 'keyword_metrics',
    scope: 'project',
    read: (data) => numOrNull(data?.totals?.averageDifficulty),
  },
  {
    key: 'keywords_average_cpc',
    label: 'Average cost per click',
    blurb: 'Averaged over the keywords anybody bids on.',
    type: 'number',
    kind: 'keyword_metrics',
    scope: 'project',
    read: (data) => numOrNull(data?.totals?.averageCpc),
  },
  {
    key: 'keywords_measured',
    label: 'Keywords the index could answer for',
    blurb: 'How many of the tracked keywords came back with a volume at all.',
    type: 'number',
    kind: 'keyword_metrics',
    scope: 'project',
    read: (data) => numOrNull(data?.totals?.measured),
  },
  {
    key: 'keyword_index_updated_on',
    label: 'Index last rebuilt on',
    blurb:
      'When DATAFORSEO last rebuilt the competitive index this came out of — a ' +
      'different fact from when we collected it, and the reason Labs numbers are ' +
      'never labelled live.',
    type: 'date',
    kind: 'keyword_metrics',
    scope: 'project',
    read: (data) => dayKeyOf(data?.indexUpdatedAt),
  },

  // ---- competitors ---------------------------------------------------------
  {
    key: 'top_competitor',
    label: 'Closest competitor',
    blurb: 'The domain sharing the most SERPs with this site.',
    type: 'text',
    kind: 'competitors',
    scope: 'project',
    read: (data) => strOrNull(data?.totals?.topDomain),
  },
  {
    key: 'competitors_found',
    label: 'Competing domains found',
    blurb: 'How many domains the index says own the same SERPs as this site.',
    type: 'number',
    kind: 'competitors',
    scope: 'project',
    read: (data) => numOrNull(data?.totals?.found),
  },
  {
    key: 'competitor_shared_keywords',
    label: 'Keywords the closest competitor shares',
    blurb:
      'How many of OUR keywords that domain also ranks for. Read off `metrics`, ' +
      'which counts only the shared set — never off `full_domain_metrics`, which ' +
      'is everything they rank for and makes Wikipedia everyone’s competitor.',
    type: 'number',
    kind: 'competitors',
    scope: 'project',
    read: (data) => numOrNull(data?.totals?.maxIntersections),
  },

  // ---- keyword_gap ---------------------------------------------------------
  {
    key: 'gap_competitors',
    label: 'Competitors compared',
    blurb: 'How many competitors this month’s gap report covered.',
    type: 'number',
    kind: 'keyword_gap',
    scope: 'project',
    read: (data) => numOrNull(data?.totals?.competitors),
  },
  {
    key: 'gap_widest_competitor',
    label: 'Widest gap is against',
    blurb:
      'The competitor with the most keywords we do not rank for. ONE comparison, ' +
      'named — the report’s own total adds the comparisons up, so a keyword two ' +
      'competitors both rank for is in it twice.',
    type: 'text',
    kind: 'keyword_gap',
    scope: 'project',
    derived: true,
    read: (data) => strOrNull(widestGap(data)?.competitor),
  },
  {
    key: 'gap_widest_missing',
    label: 'Keywords missing against them',
    blurb: 'How many keywords that one competitor ranks for and this site does not.',
    type: 'number',
    kind: 'keyword_gap',
    scope: 'project',
    derived: true,
    read: (data) => numOrNull(widestGap(data)?.totals?.missing),
  },
  {
    key: 'gap_widest_volume',
    label: 'Monthly searches at stake',
    blurb: 'What closing that one gap would put in front of us, in monthly searches.',
    type: 'number',
    kind: 'keyword_gap',
    scope: 'project',
    derived: true,
    read: (data) => numOrNull(widestGap(data)?.totals?.volumeAtStake),
  },

  // ---- top_pages -----------------------------------------------------------
  {
    key: 'top_pages_count',
    label: 'Pages ranking for anything',
    blurb: 'How many of our own URLs the index has ranking keywords for.',
    type: 'number',
    kind: 'top_pages',
    scope: 'project',
    read: (data) => numOrNull(data?.totals?.pages),
  },
  {
    key: 'top_pages_traffic_value',
    label: 'Estimated traffic value',
    blurb:
      'DataForSEO’s estimated traffic value across those pages. Their model, ' +
      'not measured traffic, and not comparable with an analytics figure.',
    type: 'number',
    kind: 'top_pages',
    scope: 'project',
    read: (data) => numOrNull(data?.totals?.totalEtv),
  },
  {
    key: 'top_pages_keywords',
    label: 'Ranking keywords across those pages',
    blurb: 'Every keyword those pages rank for, added up.',
    type: 'number',
    kind: 'top_pages',
    scope: 'project',
    read: (data) => numOrNull(data?.totals?.totalKeywords),
  },
  {
    key: 'best_page',
    label: 'Best performing page',
    blurb: 'The URL with the most estimated traffic value.',
    type: 'link',
    kind: 'top_pages',
    scope: 'project',
    read: (data) => strOrNull(data?.totals?.topPage),
  },

  // ---- backlinks_summary — the profile ------------------------------------
  {
    key: 'domain_rank',
    label: 'Domain rank (0-1000)',
    blurb:
      'DATAFORSEO’S OWN 0-1000 metric: original PageRank with damping 0.5, ' +
      'logarithmically compressed over their crawl. It is NOT Domain Authority ' +
      'and NOT Domain Rating, and they say themselves it should not be expected ' +
      'to match Ahrefs’ DR. Never put it on a report under either name.',
    type: 'number',
    kind: 'backlinks_summary',
    scope: 'project',
    read: (data) => numOrNull(data?.profile?.rank),
  },
  {
    key: 'authority_rank',
    label: 'Our own rank from bulk ranks',
    blurb:
      'The same 0-1000 scale, read from `bulk_ranks` — the one place in this ' +
      'product a domain’s OWN standing comes from. A referring domain’s `rank` ' +
      'is the rank of the links it sends us and is deliberately not offered here.',
    type: 'number',
    kind: 'backlinks_summary',
    scope: 'project',
    read: (data) => {
      const rows = Array.isArray(data?.authority) ? data.authority : [];
      return numOrNull(rows.find((row) => row?.isSelf)?.authorityRank);
    },
  },
  {
    key: 'backlinks_total',
    label: 'Total backlinks',
    blurb: 'Every inbound link in the live index.',
    type: 'number',
    kind: 'backlinks_summary',
    scope: 'project',
    read: (data) => numOrNull(data?.profile?.backlinks),
  },
  {
    key: 'dofollow_backlinks',
    label: 'Dofollow backlinks',
    blurb:
      'From a SECOND, independently filtered call — never `backlinks` minus ' +
      '`backlinks_nofollow`. A domain linking twice, once followed and once not, ' +
      'is counted in both, so that subtraction always understates.',
    type: 'number',
    kind: 'backlinks_summary',
    scope: 'project',
    nullMeans: NOT_COLLECTED,
    read: (data) => numOrNull(data?.dofollow?.backlinks),
  },
  {
    key: 'referring_domains_total',
    label: 'Referring domains',
    blurb: 'How many distinct domains link to this site.',
    type: 'number',
    kind: 'backlinks_summary',
    scope: 'project',
    read: (data) => numOrNull(data?.profile?.referringDomains),
  },
  {
    key: 'dofollow_referring_domains',
    label: 'Dofollow referring domains',
    blurb: 'The filtered call’s own answer, for the reason above.',
    type: 'number',
    kind: 'backlinks_summary',
    scope: 'project',
    nullMeans: NOT_COLLECTED,
    read: (data) => numOrNull(data?.dofollow?.referringDomains),
  },
  {
    key: 'referring_root_domains',
    label: 'Referring root domains',
    blurb:
      'Root domains rather than hosts, so twenty subdomains of one site count ' +
      'once. The honest denominator for "how many different people link to us".',
    type: 'number',
    kind: 'backlinks_summary',
    scope: 'project',
    read: (data) => numOrNull(data?.profile?.referringMainDomains),
  },
  {
    key: 'broken_backlinks',
    label: 'Broken backlinks',
    blurb: 'Inbound links pointing at a page of ours that does not answer.',
    type: 'number',
    kind: 'backlinks_summary',
    scope: 'project',
    read: (data) => numOrNull(data?.profile?.brokenBacklinks),
  },
  {
    key: 'broken_pages',
    label: 'Broken pages being linked to',
    blurb: 'How many distinct pages of ours those broken links point at.',
    type: 'number',
    kind: 'backlinks_summary',
    scope: 'project',
    read: (data) => numOrNull(data?.profile?.brokenPages),
  },
  {
    key: 'referring_ips',
    label: 'Referring IP addresses',
    blurb: 'Distinct IPs behind the referring domains.',
    type: 'number',
    kind: 'backlinks_summary',
    scope: 'project',
    read: (data) => numOrNull(data?.profile?.referringIps),
  },
  {
    key: 'referring_subnets',
    label: 'Referring subnets',
    blurb:
      'Distinct subnets. Far fewer subnets than domains is the classic ' +
      'private-network signature.',
    type: 'number',
    kind: 'backlinks_summary',
    scope: 'project',
    read: (data) => numOrNull(data?.profile?.referringSubnets),
  },
  {
    key: 'backlink_spam_score',
    label: 'Backlink spam score',
    blurb: 'DataForSEO’s 0-100 score across eighteen signals. Lower is better.',
    type: 'number',
    kind: 'backlinks_summary',
    scope: 'project',
    read: (data) => numOrNull(data?.profile?.spamScore),
  },
  {
    key: 'first_backlink_seen_on',
    label: 'First backlink seen on',
    blurb: 'The oldest link in the index for this domain.',
    type: 'date',
    kind: 'backlinks_summary',
    scope: 'project',
    read: (data) => dayKeyOf(data?.profile?.firstSeen),
  },

  // ---- backlinks_timeseries — growth --------------------------------------
  {
    key: 'new_backlinks',
    label: 'New backlinks in the window',
    blurb:
      'Counted against the window’s own start date, which travels on the ' +
      'snapshot — the same month’s figure differs under a different window.',
    type: 'number',
    kind: 'backlinks_timeseries',
    scope: 'project',
    read: (data) => numOrNull(data?.totals?.newBacklinks),
  },
  {
    key: 'lost_backlinks',
    label: 'Lost backlinks in the window',
    blurb: 'Links that were in the index at the start of the window and are not now.',
    type: 'number',
    kind: 'backlinks_timeseries',
    scope: 'project',
    read: (data) => numOrNull(data?.totals?.lostBacklinks),
  },
  {
    key: 'net_new_backlinks',
    label: 'Net new backlinks',
    blurb: 'New minus lost. Null unless both halves were read.',
    type: 'number',
    kind: 'backlinks_timeseries',
    scope: 'project',
    derived: true,
    read: (data) => {
      const gained = numOrNull(data?.totals?.newBacklinks);
      const lost = numOrNull(data?.totals?.lostBacklinks);
      return gained === null || lost === null ? null : gained - lost;
    },
  },
  {
    key: 'backlinks_at_window_end',
    label: 'Backlinks at the end of the window',
    blurb: 'The last LEVEL reading in the series, which is a different fact from the flows above it.',
    type: 'number',
    kind: 'backlinks_timeseries',
    scope: 'project',
    read: (data) => numOrNull(data?.totals?.lastBacklinks),
  },

  // ---- referring_domains ---------------------------------------------------
  {
    key: 'referrers_with_broken_links',
    label: 'Referring domains linking to something broken',
    blurb:
      'Of the domains in the table we bought, how many point at a page of ours ' +
      'that does not answer. A reclaimable link each.',
    type: 'number',
    kind: 'referring_domains',
    scope: 'project',
    read: (data) => numOrNull(data?.totals?.broken),
  },
  {
    key: 'referrers_average_spam_score',
    label: 'Average spam score of referrers',
    blurb: 'Averaged over the domains in the table that carry a score.',
    type: 'number',
    kind: 'referring_domains',
    scope: 'project',
    read: (data) => numOrNull(data?.totals?.averageSpamScore),
  },
  {
    key: 'referrers_listed',
    label: 'Referring domains in the table',
    blurb:
      'How many rows the table holds — the top hundred we asked for, NOT the ' +
      'whole referring-domain count, which is on the profile and can be tens of ' +
      'thousands.',
    type: 'number',
    kind: 'referring_domains',
    scope: 'project',
    read: (data) => numOrNull(data?.totals?.shown),
  },

  // ---- anchors -------------------------------------------------------------
  {
    key: 'anchor_root_domains',
    label: 'Root domains behind the anchor cloud',
    blurb:
      'The denominator every anchor share is taken against, in root domains ' +
      'rather than links — one sitewide footer link repeated forty thousand ' +
      'times is one domain’s opinion, not forty thousand.',
    type: 'number',
    kind: 'anchors',
    scope: 'project',
    read: (data) => numOrNull(data?.totals?.weight),
  },
  {
    key: 'empty_anchors',
    label: 'Links with no anchor text',
    blurb:
      'Image links with no alt text. A finding rather than a missing value, ' +
      'which is why the empty anchor is kept and named rather than dropped.',
    type: 'number',
    kind: 'anchors',
    scope: 'project',
    read: (data) => numOrNull(data?.totals?.empty),
  },

  // ---- site_audit — the headline numbers ----------------------------------
  {
    key: 'onpage_score',
    label: 'Site health score',
    blurb:
      'DataForSEO’s own score, carried verbatim and never recomputed. It is a ' +
      'SHARE OF THE PAGES CRAWLED, so two readings taken at different crawl ' +
      'sizes are two measurements of two different things — the writeback ' +
      'refuses to fill a starting point from a crawl that is not comparable.',
    type: 'number',
    kind: 'site_audit',
    scope: 'project',
    read: (data) => numOrNull(data?.totals?.onpageScore),
  },
  {
    key: 'pages_crawled',
    label: 'Pages crawled',
    blurb: 'How many pages the last crawl reached. The denominator every issue share is taken against.',
    type: 'number',
    kind: 'site_audit',
    scope: 'project',
    read: (data) => numOrNull(data?.totals?.pagesCrawled),
  },
  {
    key: 'audit_error_pages',
    label: 'Pages with an error',
    blurb:
      'Affected pages summed across every error-level finding, so a page with ' +
      'two problems counts twice. That is the right number for "how much work is ' +
      'there" and the wrong one for "how many pages are broken".',
    type: 'number',
    kind: 'site_audit',
    scope: 'project',
    read: (data) => numOrNull(data?.issueTotals?.error?.pages),
  },
  {
    key: 'audit_warning_pages',
    label: 'Pages with a warning',
    blurb: 'The same sum, one severity down.',
    type: 'number',
    kind: 'site_audit',
    scope: 'project',
    read: (data) => numOrNull(data?.issueTotals?.warning?.pages),
  },
  {
    key: 'audit_error_findings',
    label: 'Kinds of error found',
    blurb:
      'How many DISTINCT error checks fired. The other half of the sentence ' +
      'above — either number alone gets misread as the other.',
    type: 'number',
    kind: 'site_audit',
    scope: 'project',
    read: (data) => numOrNull(data?.issueTotals?.error?.findings),
  },
  {
    key: 'audit_warning_findings',
    label: 'Kinds of warning found',
    blurb: 'How many distinct warning checks fired.',
    type: 'number',
    kind: 'site_audit',
    scope: 'project',
    read: (data) => numOrNull(data?.issueTotals?.warning?.findings),
  },
  {
    key: 'internal_links',
    label: 'Internal links',
    blurb: 'Links between our own pages. Not a problem count.',
    type: 'number',
    kind: 'site_audit',
    scope: 'project',
    read: (data) => numOrNull(data?.totals?.linksInternal),
  },
  {
    key: 'external_links',
    label: 'Outbound links',
    blurb: 'Links from our pages to somebody else’s. Not a problem count.',
    type: 'number',
    kind: 'site_audit',
    scope: 'project',
    read: (data) => numOrNull(data?.totals?.linksExternal),
  },
  {
    key: 'crawl_ended_on',
    label: 'Crawl finished on',
    blurb:
      'The day the crawl ENDED, which is what the reading is of. A nine-hour ' +
      'crawl can start and finish on different days.',
    type: 'date',
    kind: 'site_audit',
    scope: 'project',
    read: (data) => dayKeyOf(data?.crawl?.endedAt),
  },
  {
    key: 'ssl_expires_on',
    label: 'SSL certificate expires on',
    blurb:
      'From the crawl’s own certificate read. The other eleven site-wide checks ' +
      'DataForSEO return are booleans, and no goal target can hold one — see this ' +
      'file’s header.',
    type: 'date',
    kind: 'site_audit',
    scope: 'project',
    read: (data) => dayKeyOf(data?.domainInfo?.ssl?.expiresAt),
  },

  // ---- site_audit — one field per weighted check, generated ---------------
  // ---- Phase 10: cannibalization, on the CENSUS only -----------------------
  //
  // `positions` and not `movement`, and the asymmetry with the AI fields above
  // is the point. An AI Overview sits above the results and is visible at either
  // depth; a second URL of ours at position 47 is invisible to a ten-deep daily
  // check, so the same fields on `movement` would report a clean site every day
  // and a cannibalised one once a week.
  {
    key: 'cannibalization_health',
    label: 'Cannibalization health',
    blurb:
      '100 means every keyword this site ranks for is answered by exactly one ' +
      'of its pages. Taken over the keywords we appear for AT ALL, not over ' +
      'every tracked keyword — otherwise a ranking problem is reported as a ' +
      'duplication problem.',
    type: 'number',
    kind: 'positions',
    scope: 'project',
    nullMeans: 'Nothing ranked in this reading, so there is nothing to be clean about.',
    read: (data) => numOrNull(data?.cannibalization?.healthPct),
  },
  {
    key: 'cannibalized_keywords',
    label: 'Keywords with more than one of our pages',
    blurb:
      'Keywords where two or more of this site’s URLs appear in the hundred ' +
      'results bought.',
    type: 'number',
    kind: 'positions',
    scope: 'project',
    read: (data) => numOrNull(data?.cannibalization?.competing),
  },
  {
    key: 'cannibalized_extra_urls',
    label: 'Surplus URLs competing with our own',
    blurb:
      'How many pages beyond the best one are on those SERPs in total. Two ' +
      'keywords with three of our URLs each is four, not two.',
    type: 'number',
    kind: 'positions',
    scope: 'project',
    read: (data) => numOrNull(data?.cannibalization?.extraUrls),
  },

  // ---- Phase 10: the toxic census, on `referring_domains` ------------------
  //
  // These read `data.toxic`, which `toxicity.summariseToxicity` wrote at
  // normalisation time. Nothing here re-applies a threshold — the rule that ends
  // up in a disavow file exists once, on the server, for the reason
  // `issueCountFor` does.
  {
    key: 'toxic_domains_suggested',
    label: 'Referring domains suggested for disavow',
    blurb:
      'Domains carrying more than one independent reason against them and still ' +
      'linking. A suggestion, never a verdict — a disavow file is one of the few ' +
      'things in SEO that can make a site worse.',
    type: 'number',
    kind: 'referring_domains',
    scope: 'project',
    read: (data) => numOrNull(data?.toxic?.disavow),
  },
  {
    key: 'toxic_domains_watch',
    label: 'Referring domains worth watching',
    blurb:
      'One signal against them, or a raised spam score with nothing else. Worth ' +
      'showing, not worth acting on.',
    type: 'number',
    kind: 'referring_domains',
    scope: 'project',
    read: (data) => numOrNull(data?.toxic?.watch),
  },
  {
    key: 'toxic_backlinks_suggested',
    label: 'Backlinks behind the suggested domains',
    blurb:
      'How many LINKS the suggested rows account for. One sitewide referrer is ' +
      'one line in a disavow file and forty thousand links, and the domain count ' +
      'alone hides which situation this is.',
    type: 'number',
    kind: 'referring_domains',
    scope: 'project',
    read: (data) => numOrNull(data?.toxic?.disavowBacklinks),
  },

  // ---- Phase 10: referring networks ----------------------------------------
  {
    key: 'concentrated_networks',
    label: 'IP blocks carrying several of our referrers',
    blurb:
      'Subnets with three or more referring domains on them — the private blog ' +
      'network signature per-domain spam scoring structurally cannot see. It is ' +
      'also what a reseller host looks like, so this is a count and not an ' +
      'accusation.',
    type: 'number',
    kind: 'referring_networks',
    scope: 'project',
    read: (data) => numOrNull(data?.totals?.concentrated),
  },
  {
    key: 'domains_in_concentrated_networks',
    label: 'Referring domains sitting on those blocks',
    blurb:
      'The number of referrers accounted for by the concentrated blocks. This ' +
      'is the number that says whether the concentration matters.',
    type: 'number',
    kind: 'referring_networks',
    scope: 'project',
    read: (data) => numOrNull(data?.totals?.domainsInConcentrated),
  },
  {
    key: 'largest_network_domains',
    label: 'Referrers on the single busiest block',
    blurb: 'How many referring domains share the most crowded subnet.',
    type: 'number',
    kind: 'referring_networks',
    scope: 'project',
    read: (data) => numOrNull(data?.totals?.largest),
  },
  {
    key: 'networks_listed',
    label: 'IP blocks in the table',
    blurb:
      'How many rows the table holds — the top hundred asked for, ordered by ' +
      'how many referrers sit on each. Not the whole network count.',
    type: 'number',
    kind: 'referring_networks',
    scope: 'project',
    read: (data) => numOrNull(data?.totals?.shown),
  },

  // ---- Phase 10: the Google Business Profile -------------------------------
  //
  // THE STAR BREAKDOWN IS FIVE FIELDS AND THE AVERAGE IS ONE. That ordering is
  // the whole argument of the Local screen: a business at 4.6 over 800 reviews
  // that takes twenty new one-stars moves to 4.53 and still displays as 4.5, so
  // a goal bound to the average cannot see the one event worth acting on. A goal
  // bound to `gbp_one_star_reviews` can.
  {
    key: 'gbp_one_star_reviews',
    label: 'One-star reviews',
    blurb:
      'The count, not a share. This is the number that answers "did something ' +
      'go wrong last month" — the average cannot, because it barely moves.',
    type: 'number',
    kind: 'business_profile',
    scope: 'project',
    read: (data) => numOrNull(data?.totals?.oneStar),
  },
  {
    key: 'gbp_two_star_reviews',
    label: 'Two-star reviews',
    blurb: 'The count.',
    type: 'number',
    kind: 'business_profile',
    scope: 'project',
    read: (data) => numOrNull(data?.totals?.twoStar),
  },
  {
    key: 'gbp_three_star_reviews',
    label: 'Three-star reviews',
    blurb: 'The count.',
    type: 'number',
    kind: 'business_profile',
    scope: 'project',
    read: (data) => numOrNull(data?.totals?.threeStar),
  },
  {
    key: 'gbp_four_star_reviews',
    label: 'Four-star reviews',
    blurb: 'The count.',
    type: 'number',
    kind: 'business_profile',
    scope: 'project',
    read: (data) => numOrNull(data?.totals?.fourStar),
  },
  {
    key: 'gbp_five_star_reviews',
    label: 'Five-star reviews',
    blurb: 'The count.',
    type: 'number',
    kind: 'business_profile',
    scope: 'project',
    read: (data) => numOrNull(data?.totals?.fiveStar),
  },
  {
    key: 'gbp_rating',
    label: 'Google star rating',
    blurb:
      'Google’s own average, carried because a client will ask why our number ' +
      'differs from the one on their listing. Never the number a change should ' +
      'be computed from — see the five counts above.',
    type: 'number',
    kind: 'business_profile',
    scope: 'project',
    read: (data) => numOrNull(data?.totals?.rating),
  },
  {
    key: 'gbp_reviews',
    label: 'Reviews on the listing',
    blurb:
      'Google’s own total. It does not always equal the sum of the five buckets ' +
      '— ratings left without review text are counted differently — so both are ' +
      'stored and neither is derived from the other.',
    type: 'number',
    kind: 'business_profile',
    scope: 'project',
    read: (data) => numOrNull(data?.totals?.ratingVotes),
  },
  {
    key: 'gbp_photos',
    label: 'Photos on the listing',
    blurb: 'How many photos Google holds for this business.',
    type: 'number',
    kind: 'business_profile',
    scope: 'project',
    read: (data) => numOrNull(data?.totals?.totalPhotos),
  },
  {
    key: 'gbp_review_themes',
    label: 'Themes Google mined from the reviews',
    blurb:
      'How many `place_topics` Google attached to this listing — its own ' +
      'summary of what people say this business is about.',
    type: 'number',
    kind: 'business_profile',
    scope: 'project',
    read: (data) => numOrNull(data?.totals?.topics),
  },
  {
    key: 'gbp_listing_name',
    label: 'Listing name',
    blurb:
      'The business name as Google holds it, which is not necessarily the one ' +
      'we searched for.',
    type: 'text',
    kind: 'business_profile',
    scope: 'project',
    read: (data) => strOrNull(data?.profile?.title),
  },

  ...auditIssueFields(),
];

/**
 * The comparison with the most missing keywords.
 *
 * Its own function because three fields read it and they MUST agree about which
 * competitor they are describing — "widest gap is against acme.com" beside a
 * count taken from a different comparison is worse than no answer at all.
 */
function widestGap(data) {
  const rows = Array.isArray(data?.comparisons) ? data.comparisons : [];
  let best = null;
  for (const row of rows) {
    const missing = numOrNull(row?.totals?.missing);
    if (missing === null) continue;
    if (!best || missing > numOrNull(best.totals?.missing)) best = row;
  }
  return best;
}

const FIELD_KEYS = FIELDS.map((f) => f.key);
const BY_KEY = new Map(FIELDS.map((f) => [f.key, f]));

/** @param {string} key @returns {ConnectorField|null} */
const getField = (key) => BY_KEY.get(key) || null;

/** @param {string} key @returns {boolean} */
const isField = (key) => BY_KEY.has(key);

/**
 * Read one field out of a snapshot's normalised body.
 *
 * The only entry point the writeback needs. An unknown key reads null rather
 * than throwing — a mapping row can outlive the field it names, and a weekly run
 * that crashed on that would take every other field down with it.
 *
 * @param {string} key
 * @param {any} data
 * @param {{keyword?: string}} [ctx]
 * @returns {number|string|null}
 */
const readField = (key, data, ctx = {}) => {
  const field = getField(key);
  if (!field) return null;
  try {
    const value = field.read(data, ctx);
    return value === undefined ? null : value;
  } catch {
    // A shape we did not anticipate is a null, not a failed sync. Same rule as
    // every normaliser next door.
    return null;
  }
};

module.exports = { FIELDS, FIELD_KEYS, getField, isField, readField, widestGap };
