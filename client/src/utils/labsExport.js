import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { saveBlob } from './fileUrl.js';
import { marketLabel } from './connectorFormat.js';
import { signalLabel } from './toxicRows.js';

/**
 * The Labs tables as files — `rankExport.js`'s architecture, four reports wide.
 *
 * ---- What is being reused, and why it is a registry this time ---------------
 *
 * ONE `columns` ARRAY DRIVES BOTH FORMATS, exactly as in `rankExport.js`. The
 * alternative — a CSV builder and a PDF builder each with their own column list
 * — is two lists that agree the day they are written and disagree three months
 * later, at which point a client receives a spreadsheet and a printout of "the
 * same report" carrying different columns.
 *
 * What changed is that phase 6 has FOUR reports rather than one, so the shape
 * became a registry keyed by report name instead of a module-level constant.
 * That is the only difference: `csvOnly`, the UTF-8 BOM, RFC 4180 escaping, the
 * A4-landscape width budget and the page-number second pass are all the same
 * code doing the same job for the same reasons.
 *
 * ---- The rules that survive from the rank export ---------------------------
 *
 * THE BOM IS NOT DECORATION. Without it Excel on Windows opens the file as
 * cp1252 and mangles every non-ASCII keyword — which for an SEO export is most
 * of them, since the accented and non-Latin terms are exactly the ones people
 * track and cannot retype.
 *
 * A NULL IS AN EM DASH IN PRINT AND AN EMPTY CELL IN A SHEET. An empty cell in a
 * printed grid reads as a rendering fault; in a spreadsheet it reads as "not
 * set", which is what it means.
 *
 * ---- And one rule this file adds -------------------------------------------
 *
 * EVERY LABS EXPORT SAYS HOW OLD THE INDEX IS. These numbers come out of a
 * database DataForSEO's own documentation describes as both weekly and 30-90
 * days old, and a spreadsheet outlives the screen it was exported from — it gets
 * filtered, pivoted and pasted into a client report by somebody who never saw
 * the panel that carried the caption. So `indexUpdatedAt` is in the subtitle of
 * every PDF and in a column of every CSV.
 */

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** "24 Aug 2026", from a day key or an instant, read as UTC. */
const prettyDay = (value) => {
  if (!value) return '';
  const d =
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? new Date(`${value}T00:00:00Z`)
      : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

const number = (value) =>
  typeof value === 'number' && Number.isFinite(value)
    ? new Intl.NumberFormat('en-US').format(Math.round(value * 100) / 100)
    : '';

const money = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? `$${value.toFixed(2)}` : '';

const rank = (value) => (typeof value === 'number' ? `#${value}` : '');

const percent = (value) =>
  typeof value === 'number' ? `${Math.round(value * 100)}%` : '';

/**
 * The four reports, as data.
 *
 * `width` is millimetres in the PDF. A4 landscape is 297mm and the table takes
 * 14mm margins either side, so the printed widths must total at most 269;
 * autoTable warns and squeezes when they do not. The last printed column is
 * left unset so it absorbs whatever is left over.
 */
export const REPORTS = {
  keywords: {
    title: 'keyword research',
    noun: 'keyword',
    columns: [
      { key: 'keyword', header: 'Keyword', width: 70, read: (r) => r.keyword },
      { key: 'searchVolume', header: 'Volume', width: 24, read: (r) => number(r.searchVolume) },
      {
        key: 'keywordDifficulty',
        header: 'Difficulty',
        width: 24,
        read: (r) => number(r.keywordDifficulty),
      },
      { key: 'band', header: 'Band', width: 30, read: (r) => r.band?.label || '' },
      { key: 'intent', header: 'Intent', width: 30, read: (r) => r.intent || '' },
      { key: 'cpc', header: 'CPC', width: 22, read: (r) => money(r.cpc) },
      {
        key: 'competition',
        header: 'Ad competition',
        width: 28,
        read: (r) => percent(r.competition),
      },
      // CSV-only, each for its own reason: a probability vector and a
      // twelve-month series are datasets, and a SERP-feature list wraps to four
      // printed lines.
      {
        key: 'intentProbability',
        header: 'Intent confidence',
        csvOnly: true,
        read: (r) => percent(r.intentProbability),
      },
      {
        key: 'trendYearly',
        header: 'Volume trend (yr %)',
        csvOnly: true,
        read: (r) => number(r.trendYearly),
      },
      {
        key: 'seasonality',
        header: 'Monthly searches (12m)',
        csvOnly: true,
        read: (r) =>
          (r.monthlySearches || [])
            .map((m) => `${m.year}-${String(m.month).padStart(2, '0')}:${m.searchVolume ?? ''}`)
            .join(' '),
      },
      {
        key: 'features',
        header: 'SERP features',
        csvOnly: true,
        read: (r) => (r.features || []).join(', '),
      },
    ],
  },

  competitors: {
    title: 'competitors',
    noun: 'competitor',
    columns: [
      { key: 'domain', header: 'Domain', width: 62, read: (r) => r.domain },
      {
        key: 'intersections',
        header: 'Shared keywords',
        width: 30,
        read: (r) => number(r.intersections),
      },
      {
        key: 'avgPosition',
        header: 'Their avg position',
        width: 32,
        read: (r) => number(r.avgPosition),
      },
      {
        /**
         * The distinction the whole panel exists for, kept in the file as well
         * as on the screen: `shared*` is "does it compete with me",
         * `full*` is "is it a big site". A single "keywords" column would make
         * Wikipedia the closest competitor of every client.
         */
        key: 'sharedEtv',
        header: 'Shared traffic value',
        width: 34,
        read: (r) => number(r.sharedEtv),
      },
      {
        key: 'fullKeywords',
        header: 'All their keywords',
        width: 32,
        read: (r) => number(r.fullKeywords),
      },
      {
        key: 'fullEtv',
        header: 'All their traffic value',
        width: 36,
        read: (r) => number(r.fullEtv),
      },
      {
        key: 'overlap',
        header: 'Overlap',
        csvOnly: true,
        read: (r) => percent(r.overlap),
      },
      {
        key: 'medianPosition',
        header: 'Their median position',
        csvOnly: true,
        read: (r) => number(r.medianPosition),
      },
    ],
  },

  gap: {
    title: 'keyword gap',
    noun: 'keyword',
    columns: [
      { key: 'keyword', header: 'Keyword', width: 74, read: (r) => r.keyword },
      { key: 'searchVolume', header: 'Volume', width: 24, read: (r) => number(r.searchVolume) },
      {
        key: 'keywordDifficulty',
        header: 'Difficulty',
        width: 24,
        read: (r) => number(r.keywordDifficulty),
      },
      {
        key: 'competitorRank',
        header: 'Their rank',
        width: 26,
        read: (r) => rank(r.competitorRank),
      },
      {
        /**
         * Blank BY CONSTRUCTION — the gap report is the keywords we do not rank
         * for. The column is here so the file cannot be mistaken for a
         * side-by-side comparison that happens to be missing our numbers.
         */
        key: 'ourRank',
        header: 'Our rank',
        width: 24,
        read: (r) => rank(r.ourRank),
      },
      { key: 'cpc', header: 'CPC', width: 22, read: (r) => money(r.cpc) },
      {
        key: 'competitorUrl',
        header: 'Their ranking URL',
        csvOnly: true,
        read: (r) => r.competitorUrl || '',
      },
    ],
  },

  /**
   * ---- The two phase-7 reports, and why they live in this registry ----------
   *
   * They are not Labs. They come from the Backlinks API, they are genuinely
   * live, and their subtitle has to say something different from the other four.
   * What they share with them is everything else: one `columns` array driving
   * both formats, `csvOnly` for the datasets that wrap to four printed lines,
   * the UTF-8 BOM, RFC 4180 escaping and the A4-landscape width budget.
   *
   * A second export module for two more tables would have been two copies of the
   * column-drives-both-formats rule, and the day they disagreed a client would
   * receive a spreadsheet and a printout of "the same report" carrying different
   * columns. So the registry gained a `freshness` flag instead — see
   * `contextColumnsFor` and `subtitle`.
   */
  referringDomains: {
    title: 'referring domains',
    noun: 'domain',
    freshness: 'live',
    columns: [
      { key: 'domain', header: 'Referring domain', width: 76, read: (r) => r.domain },
      {
        /**
         * "Link strength", never "Authority". This is the rank of the links this
         * domain sends US, not the domain's own standing — a directory sending
         * four hundred sitewide links outranks a newspaper sending one. The
         * header carries that distinction into a spreadsheet that will outlive
         * the screen it came from.
         */
        key: 'linksRank',
        header: 'Link strength',
        width: 28,
        read: (r) => number(r.linksRank),
      },
      { key: 'backlinks', header: 'Links to us', width: 28, read: (r) => number(r.backlinks) },
      {
        key: 'brokenBacklinks',
        header: 'Broken',
        width: 22,
        read: (r) => number(r.brokenBacklinks),
      },
      { key: 'spamScore', header: 'Spam score', width: 28, read: (r) => number(r.spamScore) },
      { key: 'spamBand', header: 'Spam band', width: 34, read: (r) => r.spamBand?.label || '' },
      { key: 'firstSeen', header: 'First seen', width: 30, read: (r) => prettyDay(r.firstSeen) },
      {
        key: 'referringPages',
        header: 'Pages linking',
        csvOnly: true,
        read: (r) => number(r.referringPages),
      },
      {
        key: 'lostDate',
        header: 'Lost',
        csvOnly: true,
        read: (r) => prettyDay(r.lostDate),
      },
    ],
  },

  anchors: {
    title: 'anchor text',
    noun: 'anchor',
    freshness: 'live',
    columns: [
      {
        /**
         * An empty anchor is an image link with no alt text — a real anchor and
         * a real finding. Named in the file rather than exported as a blank
         * cell, which would read as a missing value.
         */
        key: 'anchor',
        header: 'Anchor',
        width: 84,
        read: (r) => (r.anchor === '' ? '(empty / image link)' : r.anchor),
      },
      { key: 'klass', header: 'Type', width: 30, read: (r) => r.klass || '' },
      {
        /**
         * THE WEIGHT, and the first numeric column deliberately. Sized by
         * `backlinks` instead, one sitewide footer repeated across forty
         * thousand pages is the whole anchor profile.
         */
        key: 'referringMainDomains',
        header: 'Root domains',
        width: 32,
        read: (r) => number(r.referringMainDomains),
      },
      { key: 'share', header: 'Share of domains', width: 34, read: (r) => percent(r.share) },
      { key: 'backlinks', header: 'Links', width: 26, read: (r) => number(r.backlinks) },
      { key: 'spamScore', header: 'Spam score', width: 28, read: (r) => number(r.spamScore) },
      {
        key: 'referringDomains',
        header: 'Referring domains',
        csvOnly: true,
        read: (r) => number(r.referringDomains),
      },
    ],
  },

  /**
   * ---- The two phase-8 reports, and the third `freshness` value --------------
   *
   * A crawl is neither Labs nor Backlinks: not a competitive index with a
   * rebuild date, and not a live index either. It is a measurement we ordered, of
   * one site, on a day, AT A CRAWL SIZE - and the crawl size is part of the
   * reading, because `onpage_score` is sample-size dependent by DataForSEO's own
   * admission.
   *
   * So `freshness: 'crawl'` puts the crawl size in the subtitle and on every CSV
   * row, for exactly the reason `statusType` is on every Backlinks row: a
   * spreadsheet outlives the panel it came from, gets pasted under another one
   * and summed, and without the crawl size beside it nothing in the file says
   * that the two halves are not comparable.
   */
  issues: {
    title: 'site audit issues',
    noun: 'issue',
    freshness: 'crawl',
    columns: [
      { key: 'label', header: 'Issue', width: 76, read: (r) => r.label },
      { key: 'severity', header: 'Severity', width: 26, read: (r) => r.severity },
      {
        /**
         * The number the whole phase turns on. For the ten POSITIVE counters it
         * is `pagesCrawled - counter`, computed once on the server; the raw
         * counter travels in its own CSV-only column so a reader can check the
         * subtraction rather than having to trust it.
         */
        key: 'pages',
        header: 'Pages affected',
        width: 30,
        read: (r) => number(r.pages),
      },
      { key: 'share', header: 'Share of site', width: 28, read: (r) => percent(r.share) },
      {
        key: 'impact',
        header: 'Score impact',
        width: 28,
        read: (r) => number(r.impact),
      },
      { key: 'weight', header: 'Weight', width: 22, read: (r) => number(r.weight) },
      {
        key: 'positive',
        header: 'Counter counts passes',
        csvOnly: true,
        read: (r) => (r.positive ? 'yes' : 'no'),
      },
      {
        key: 'rawCount',
        header: 'Raw counter',
        csvOnly: true,
        read: (r) => number(r.rawCount),
      },
      {
        key: 'known',
        header: 'Classified',
        csvOnly: true,
        read: (r) => (r.known ? 'yes' : 'no'),
      },
      { key: 'check', header: 'Check', csvOnly: true, read: (r) => r.key },
    ],
  },

  auditPages: {
    title: 'site audit pages',
    noun: 'page',
    freshness: 'crawl',
    columns: [
      { key: 'path', header: 'Page', width: 88, read: (r) => r.path },
      { key: 'statusCode', header: 'Status', width: 22, read: (r) => number(r.statusCode) },
      {
        key: 'onpageScore',
        header: 'Page score',
        width: 26,
        read: (r) => number(r.onpageScore),
      },
      {
        key: 'failingCount',
        header: 'Failing checks',
        width: 30,
        read: (r) => number(r.failingCount),
      },
      { key: 'clickDepth', header: 'Clicks deep', width: 26, read: (r) => number(r.clickDepth) },
      {
        key: 'inboundLinks',
        header: 'Internal links in',
        width: 32,
        read: (r) => number(r.inboundLinks),
      },
      { key: 'url', header: 'Full URL', csvOnly: true, read: (r) => r.url },
      { key: 'title', header: 'Title', csvOnly: true, read: (r) => r.title || '' },
      {
        key: 'failingChecks',
        header: 'Failing checks',
        csvOnly: true,
        read: (r) => (r.failingChecks || []).join(', '),
      },
      { key: 'size', header: 'Bytes', csvOnly: true, read: (r) => number(r.size) },
    ],
  },

  /**
   * ---- The four phase-10 reports, and the two `freshness` values they use ----
   *
   * AI visibility and cannibalization are readings of a SERP, so they take the
   * fourth freshness value (`serp`): not a competitive index, not a live link
   * index, not a crawl — a page as it stood on a day. The toxic report is
   * backlinks and takes `live`, with the link set in every row for the reason
   * every other Backlinks export carries it. The GBP report is `live` too.
   *
   * All four go in THIS registry rather than a second module, for the reason
   * phase 7 gave when it put the Backlinks reports here: one `columns` array
   * driving both formats is the only arrangement in which a client cannot
   * receive a spreadsheet and a printout of "the same report" carrying different
   * columns.
   */
  aiVisibility: {
    title: 'AI visibility',
    noun: 'keyword',
    freshness: 'serp',
    columns: [
      { key: 'keyword', header: 'Keyword', width: 74, read: (r) => r.keyword },
      {
        key: 'present',
        header: 'AI Overview shown',
        width: 34,
        read: (r) => (r.present ? 'yes' : 'no'),
      },
      {
        /**
         * TWO COLUMNS, and they are never one. Cited is a link in Google's own
         * reference list; named is the brand appearing in the prose with no link
         * at all. A spreadsheet outlives the panel that explained the
         * difference, so the headers carry it.
         */
        key: 'cited',
        header: 'Cited',
        width: 24,
        read: (r) => (r.present ? (r.cited ? 'yes' : 'no') : ''),
      },
      {
        key: 'mentioned',
        header: 'Named in the text',
        width: 34,
        read: (r) => (r.present ? (r.mentioned ? 'yes' : 'no') : ''),
      },
      {
        /**
         * NOT run through the rank formatter. A null here is "not cited", which
         * is a fact about a citation list of eight rather than about the top 100.
         */
        key: 'citationRank',
        header: 'Citation position',
        width: 34,
        read: (r) => (typeof r.citationRank === 'number' ? `#${r.citationRank}` : ''),
      },
      { key: 'rank', header: 'Organic rank', width: 30, read: (r) => rank(r.rank) },
      {
        key: 'citationCount',
        header: 'Sources cited',
        csvOnly: true,
        read: (r) => number(r.citationCount),
      },
      {
        key: 'references',
        header: 'Domains cited',
        csvOnly: true,
        read: (r) => (r.references || []).join(', '),
      },
    ],
  },

  cannibalization: {
    title: 'cannibalization',
    noun: 'keyword',
    freshness: 'serp',
    columns: [
      { key: 'keyword', header: 'Keyword', width: 70, read: (r) => r.keyword },
      { key: 'count', header: 'Our pages', width: 26, read: (r) => number(r.count) },
      { key: 'best', header: 'Best', width: 24, read: (r) => rank(r.best) },
      { key: 'worst', header: 'Worst', width: 24, read: (r) => rank(r.worst) },
      {
        /**
         * The severity signal. Two of our pages at 3 and 4 is a sitelink pair;
         * two at 3 and 61 is one page being held back by a page Google prefers
         * to ignore.
         */
        key: 'spread',
        header: 'Positions apart',
        width: 32,
        read: (r) => number(r.spread),
      },
      {
        key: 'urls',
        header: 'Best page',
        width: 80,
        read: (r) => r.urls?.[0]?.url || '',
      },
      {
        key: 'allUrls',
        header: 'All competing pages',
        csvOnly: true,
        read: (r) =>
          (r.urls || [])
            .map((u) => `${u.url}${typeof u.rank === 'number' ? ` (#${u.rank})` : ''}`)
            .join(' | '),
      },
      { key: 'surplus', header: 'Surplus pages', csvOnly: true, read: (r) => number(r.surplus) },
    ],
  },

  toxicDomains: {
    title: 'toxic backlinks',
    noun: 'domain',
    freshness: 'live',
    columns: [
      { key: 'domain', header: 'Referring domain', width: 66, read: (r) => r.domain },
      {
        /**
         * THE REASONS, and they are the first thing after the domain rather than
         * a footnote. A row that says "disavow" with no reason beside it is a row
         * nobody can argue with six months later — which is exactly when somebody
         * asks why a link was thrown away.
         */
        key: 'signals',
        header: 'Reasons',
        width: 72,
        read: (r) => (r.signals || []).map(signalLabel).join('; '),
      },
      {
        key: 'verdict',
        header: 'Suggestion',
        width: 34,
        read: (r) => {
          if (r.lost) return 'already gone';
          if (r.disavow) return 'disavow';
          if (r.watch) return 'watch';
          return '';
        },
      },
      { key: 'spamScore', header: 'Spam score', width: 28, read: (r) => number(r.spamScore) },
      { key: 'backlinks', header: 'Links to us', width: 28, read: (r) => number(r.backlinks) },
      {
        /** "Link strength", never "Authority". Phase 7's rule, unchanged. */
        key: 'linksRank',
        header: 'Link strength',
        width: 30,
        read: (r) => number(r.linksRank),
      },
      { key: 'score', header: 'Toxicity score', csvOnly: true, read: (r) => number(r.score) },
      {
        key: 'brokenPages',
        header: 'Broken linking pages',
        csvOnly: true,
        read: (r) => number(r.brokenPages),
      },
      {
        key: 'referringPages',
        header: 'Linking pages',
        csvOnly: true,
        read: (r) => number(r.referringPages),
      },
      { key: 'firstSeen', header: 'First seen', csvOnly: true, read: (r) => prettyDay(r.firstSeen) },
      { key: 'lostDate', header: 'Lost', csvOnly: true, read: (r) => prettyDay(r.lostDate) },
    ],
  },

  localReviews: {
    title: 'Google reviews',
    noun: 'rating',
    freshness: 'live',
    columns: [
      { key: 'label', header: 'Rating', width: 30, read: (r) => r.label },
      {
        /**
         * THE COUNT FIRST, and the whole panel's argument is in that ordering.
         * An average moves 0.07 when twenty new one-stars arrive; the count
         * doubles.
         */
        key: 'count',
        header: 'Reviews',
        width: 30,
        read: (r) => number(r.count),
      },
      {
        key: 'change',
        header: 'Change since last reading',
        width: 46,
        read: (r) =>
          typeof r.change === 'number' ? `${r.change > 0 ? '+' : ''}${r.change}` : '',
      },
      { key: 'share', header: 'Share', width: 26, read: (r) => percent(r.share) },
    ],
  },

  pages: {
    title: 'top pages',
    noun: 'page',
    columns: [
      { key: 'path', header: 'Page', width: 96, read: (r) => r.path },
      { key: 'keywords', header: 'Keywords', width: 26, read: (r) => number(r.keywords) },
      {
        key: 'etv',
        header: 'Est. traffic value',
        width: 32,
        read: (r) => number(r.etv),
      },
      { key: 'top10', header: 'In top 10', width: 26, read: (r) => number(r.top10) },
      {
        key: 'pos_1',
        header: 'At #1',
        width: 20,
        read: (r) => number(r.buckets?.pos_1),
      },
      { key: 'url', header: 'Full URL', csvOnly: true, read: (r) => r.url },
      {
        key: 'pos_2_3',
        header: 'Positions 2-3',
        csvOnly: true,
        read: (r) => number(r.buckets?.pos_2_3),
      },
      {
        key: 'pos_4_10',
        header: 'Positions 4-10',
        csvOnly: true,
        read: (r) => number(r.buckets?.pos_4_10),
      },
      {
        key: 'pos_11_20',
        header: 'Positions 11-20',
        csvOnly: true,
        read: (r) => number(r.buckets?.pos_11_20),
      },
    ],
  },
};

/**
 * The columns every export carries, appended to whichever report is asked for.
 * CSV-only, because they belong once in a PDF's subtitle and on every row of a
 * spreadsheet that will be sorted and pasted somewhere else.
 */
const BASE_CONTEXT_COLUMNS = [
  { key: 'domain', header: 'Site', csvOnly: true, read: (_r, meta) => meta.domain },
  { key: 'market', header: 'Market', csvOnly: true, read: (_r, meta) => meta.market },
  {
    key: 'collectedAt',
    header: 'Collected',
    csvOnly: true,
    read: (_r, meta) => meta.collectedAt,
  },
];

/**
 * WHEN DATAFORSEO LAST REBUILT THE INDEX, on every exported Labs row.
 *
 * Not the same fact as "collected", and the one that decides whether a number is
 * worth acting on. A spreadsheet outlives the panel it came from.
 */
const INDEX_CONTEXT_COLUMN = {
  key: 'indexUpdatedAt',
  header: 'Index updated',
  csvOnly: true,
  read: (_r, meta) => meta.indexUpdatedAt,
};

/**
 * WHICH LINK SET EVERY NUMBER WAS COMPUTED OVER, on every exported Backlinks row.
 *
 * The Backlinks equivalent of the column above, and it is not decoration:
 * `backlinks_status_type` (`all | live | lost`) RECOMPUTES every aggregate over
 * a different corpus rather than filtering rows, so two exports taken under
 * different settings cannot be pasted into one sheet and compared. A spreadsheet
 * that does not carry it is a spreadsheet where that is undetectable.
 */
const STATUS_CONTEXT_COLUMN = {
  key: 'statusType',
  header: 'Link set',
  csvOnly: true,
  read: (_r, meta) => meta.statusType,
};

/**
 * THE CRAWL SIZE, on every exported audit row.
 *
 * `onpage_score` is computed as a share of the pages crawled, so a reading at
 * 100 pages and a reading at 1,000 are two different measurements. Two exports
 * without this column can be pasted into one sheet and charted, and nothing in
 * the file would say the line is a chart of the crawl budget.
 */
const CRAWL_CONTEXT_COLUMN = {
  key: 'crawl',
  header: 'Pages crawled',
  csvOnly: true,
  read: (_r, meta) => meta.crawl,
};

/**
 * WHAT DEPTH A SERP READING WAS BOUGHT TO, on every exported row of one.
 *
 * The fourth context column, and the same argument as the three above it: a
 * keyword outside the depth we paid for reads as unranked, so two exports taken
 * at depth 10 and depth 100 cannot be pasted into one sheet and compared.
 * Cannibalization is the sharper case — a second URL at position 47 does not
 * exist at all in a ten-deep reading.
 */
const DEPTH_CONTEXT_COLUMN = {
  key: 'depth',
  header: 'Results bought',
  csvOnly: true,
  read: (_r, meta) => meta.depth,
};

const FRESHNESS_CONTEXT_COLUMNS = {
  live: STATUS_CONTEXT_COLUMN,
  crawl: CRAWL_CONTEXT_COLUMN,
  serp: DEPTH_CONTEXT_COLUMN,
};

const contextColumnsFor = (report) => [
  ...BASE_CONTEXT_COLUMNS,
  FRESHNESS_CONTEXT_COLUMNS[REPORTS[report]?.freshness] || INDEX_CONTEXT_COLUMN,
];

const CONTEXT_KEYS = new Set([
  ...BASE_CONTEXT_COLUMNS.map((c) => c.key),
  INDEX_CONTEXT_COLUMN.key,
  STATUS_CONTEXT_COLUMN.key,
  CRAWL_CONTEXT_COLUMN.key,
  DEPTH_CONTEXT_COLUMN.key,
]);

const columnsFor = (report) => [
  ...(REPORTS[report]?.columns || []),
  ...contextColumnsFor(report),
];

const metaFor = (payload) => ({
  domain: payload.domain || '',
  market: marketLabel(payload.variant),
  collectedAt: prettyDay(payload.collectedAt),
  indexUpdatedAt: prettyDay(payload.indexUpdatedAt),
  statusType: payload.statusType || '',
  /** Pages crawled / the ceiling asked for. Both, because the score needs both. */
  crawl:
    payload.pagesCrawled || payload.maxCrawlPages
      ? `${payload.pagesCrawled ?? '?'} of up to ${payload.maxCrawlPages ?? '?'}`
      : '',
  /** The SERP depth this reading was bought to. See `DEPTH_CONTEXT_COLUMN`. */
  depth: payload.depth ? `top ${payload.depth}` : '',
});

/** Filename-safe slug. */
const slug = (name) =>
  String(name || 'site')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'site';

export const exportFilename = (payload, report, extension) =>
  `${slug(payload.siteName)}-${slug(REPORTS[report]?.title || report)}-${
    payload.periodKey || 'latest'
  }.${extension}`;

/**
 * The freshness sentence, in the file, and the two families say different things.
 *
 * LABS: "competitive index" and never "live". DataForSEO's own docs put the age
 * of that database at both "weekly" and "30-90 days", so the file stamps the
 * rebuild date they report and reserves the word live for the two APIs that earn
 * it.
 *
 * BACKLINKS: live, with the link set named. That index really is rebuilt
 * continuously — but `backlinks_status_type` recomputes every aggregate over a
 * different corpus, so a sheet that does not say which corpus is a sheet that
 * can be pasted under a different one and summed.
 */
const freshnessLine = (payload, report, meta) => {
  if (REPORTS[report]?.freshness === 'serp') {
    /**
     * Neither "competitive index" nor "live link index". A SERP reading is the
     * page as it stood on a day, at the depth we bought — and the depth is the
     * part that has to travel, because everything past it reads as unranked.
     */
    return meta.depth
      ? `search results on the day shown, ${meta.depth}`
      : 'search results on the day shown';
  }
  if (REPORTS[report]?.freshness === 'crawl') {
    /**
     * Neither "live" nor "competitive index". A crawl is a measurement taken on
     * a day at a size, and the size is what makes two of them comparable.
     */
    return meta.crawl ? `crawl of ${meta.crawl} pages` : 'crawl';
  }
  if (REPORTS[report]?.freshness === 'live') {
    return meta.statusType
      ? `live link index — "${meta.statusType}" links`
      : 'live link index';
  }
  return meta.indexUpdatedAt
    ? `competitive index updated ${meta.indexUpdatedAt}`
    : 'competitive index — update date unknown';
};

/** The header line both formats carry, so they cannot describe different data. */
const subtitle = (payload, report) => {
  const meta = metaFor(payload);
  return [
    meta.domain,
    payload.subject ? `vs ${payload.subject}` : null,
    meta.market,
    meta.collectedAt ? `collected ${meta.collectedAt}` : null,
    freshnessLine(payload, report, meta),
    `${payload.rows.length} ${REPORTS[report]?.noun || 'row'}${
      payload.rows.length === 1 ? '' : 's'
    }`,
    payload.filtered ? 'filtered view' : null,
  ]
    .filter(Boolean)
    .join('   ·   ');
};

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * RFC 4180 field escaping: quote anything containing a comma, a quote or a
 * newline, and double any embedded quotes. A tracked keyword really can contain
 * all three — people paste keyword-research exports.
 */
const csvField = (value) => {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const BOM = '\uFEFF';

export const rowsToCsv = (payload, report) => {
  const columns = columnsFor(report);
  const meta = metaFor(payload);
  const lines = [columns.map((c) => csvField(c.header)).join(',')];

  if (!payload.rows.length) {
    // One row, so the sheet still parses as a single table rather than as a
    // header stranded above nothing. "Nothing found" is a finding, and it still
    // has to say which site, market and index date it is a finding about.
    const blank = columns.map((c) =>
      CONTEXT_KEYS.has(c.key) ? csvField(c.read(null, meta)) : ''
    );
    blank[0] = csvField(`No ${REPORTS[report]?.noun || 'row'} matched on ${meta.domain}.`);
    lines.push(blank.join(','));
  } else {
    for (const row of payload.rows) {
      lines.push(columns.map((c) => csvField(c.read(row, meta))).join(','));
    }
  }

  // Written as an escape rather than the literal character, which is invisible
  // in a diff and gets deleted by the next person tidying the file.
  return `${BOM}${lines.join('\r\n')}\r\n`;
};

export const downloadCsv = (payload, report) => {
  const blob = new Blob([rowsToCsv(payload, report)], {
    type: 'text/csv;charset=utf-8;',
  });
  saveBlob(blob, exportFilename(payload, report, 'csv'));
};

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

export const downloadPdf = (payload, report) => {
  const columns = columnsFor(report).filter((c) => !c.csvOnly);
  const meta = metaFor(payload);

  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.text(
    `${payload.siteName || 'Site'} — ${REPORTS[report]?.title || report}`,
    14,
    16
  );

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(110);
  doc.text(subtitle(payload, report), 14, 22);
  doc.setTextColor(0);

  if (!payload.rows.length) {
    doc.setFontSize(11);
    doc.setTextColor(90);
    doc.text(`Nothing matched on ${meta.domain || 'this site'}.`, 14, 36);
    saveBlob(doc.output('blob'), exportFilename(payload, report, 'pdf'));
    return;
  }

  autoTable(doc, {
    startY: 27,
    head: [columns.map((c) => c.header)],
    body: payload.rows.map((row) => columns.map((c) => c.read(row, meta) || '—')),
    styles: { fontSize: 8, cellPadding: 1.6, overflow: 'linebreak', valign: 'top' },
    headStyles: { fillColor: [45, 55, 72], textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [247, 248, 250] },
    columnStyles: Object.fromEntries(
      columns
        .map((c, i) => [i, c.width])
        .filter(([, width]) => width)
        .map(([i, width]) => [i, { cellWidth: width }])
    ),
    margin: { left: 14, right: 14, bottom: 16 },
  });

  // Page numbers in a second pass: during the draw the total is not known yet,
  // so "Page 1 of 1" would be stamped on every page of a twelve-page report.
  const pageCount = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i += 1) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(140);
    doc.text(`Page ${i} of ${pageCount}`, pageWidth - 14, pageHeight - 8, {
      align: 'right',
    });
  }

  saveBlob(doc.output('blob'), exportFilename(payload, report, 'pdf'));
};

export const downloadLabsExport = (payload, report, format) =>
  (format === 'pdf' ? downloadPdf : downloadCsv)(payload, report);
