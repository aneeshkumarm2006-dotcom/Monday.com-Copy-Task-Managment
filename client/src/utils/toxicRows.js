import { BLANK, sortRowsBy } from './rankRows.js';
import { isKindCollected } from './labsRows.js';
import { spamBandFor } from './backlinkRows.js';

/**
 * The Toxic backlinks screen, and the disavow file it can produce.
 *
 * ---- The rule is NOT in this file, and that is the design ------------------
 *
 * `toxicity.scoreDomain` runs on the SERVER, at normalisation time, and stamps
 * `row.toxicity` onto every stored referring domain. This file reads that field.
 * It contains no threshold, no spam-score comparison and no signal test.
 *
 * The reason is the artefact. A disavow file is one of the very few things in
 * SEO that can make a site measurably worse, and it leaves this application
 * entirely — somebody uploads it to Google Search Console and nothing here ever
 * hears about it again. `onpageChecks.issueCountFor` makes the same argument for
 * the inverted counters: a rule whose output is a deliverable exists once.
 *
 * That is deliberately UNLIKE `comparability`, which had to be copied onto the
 * client because a screen needed the answer with no round trip. This screen has
 * the answer already, sitting on the rows.
 *
 * ---- What the file may contain, and what it may not ------------------------
 *
 * DOMAINS ONLY, and only ones still linking. Google's format accepts
 * `domain:example.com` lines and bare URLs, and nothing else — there is no line
 * type for an IP block, which is why the subnet panel is a warning beside this
 * table rather than a second source of rows.
 *
 * And every file carries COMMENT LINES naming the reasons, the thresholds and
 * the reading it was built from. A disavow file with no provenance is a list of
 * domains somebody has to take on faith six months later.
 */

const numberOr = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

export { isKindCollected };

/** The signals the server can attach, with the sentence each one means. */
export const SIGNAL_LABELS = {
  spam: 'High spam score',
  sitewide: 'Sitewide placement',
  dead: 'Linking pages are broken',
};

export const signalLabel = (key) => SIGNAL_LABELS[key] || key;

/**
 * The per-domain rows, already scored.
 *
 * @param {Object|null} snapshot - the `referring_domains` snapshot
 * @returns {Array<Object>}
 */
export const toxicRowsFrom = (snapshot) => {
  const rows = Array.isArray(snapshot?.data?.domains) ? snapshot.data.domains : [];
  return rows
    .map((row) => {
      const tox = row.toxicity || null;
      return {
        domain: String(row.domain || ''),
        backlinks: numberOr(row.backlinks),
        brokenBacklinks: numberOr(row.brokenBacklinks),
        brokenPages: numberOr(row.brokenPages),
        referringPages: numberOr(row.referringPages),
        spamScore: numberOr(row.spamScore),
        spamBand: spamBandFor(numberOr(row.spamScore)),
        /** NOT authority. The rank of the links this domain sends US. */
        linksRank: numberOr(row.linksRank),
        firstSeen: row.firstSeen || null,
        lostDate: row.lostDate || null,
        score: numberOr(tox?.score) ?? 0,
        signals: Array.isArray(tox?.signals) ? tox.signals : [],
        disavow: !!tox?.disavow,
        watch: !!tox?.watch,
        lost: !!tox?.lost,
      };
    })
    /**
     * Clean domains are dropped. This is a report about what looks wrong, and a
     * hundred rows of "no signals" is the finding buried under the denominator —
     * which the summary tile carries instead.
     */
    .filter((row) => row.disavow || row.watch || row.signals.length > 0);
};

/** The census the server computed, for the tiles. */
export const toxicSummaryFrom = (snapshot) => {
  const t = snapshot?.data?.toxic || null;
  if (!t) return null;
  return {
    shown: numberOr(t.shown) ?? 0,
    disavow: numberOr(t.disavow) ?? 0,
    watch: numberOr(t.watch) ?? 0,
    lost: numberOr(t.lost) ?? 0,
    disavowBacklinks: numberOr(t.disavowBacklinks) ?? 0,
    bySignal: t.bySignal || {},
    thresholds: t.thresholds || {},
  };
};

/** The subnet rows, from the second kind. */
export const networkRowsFrom = (snapshot) => {
  const rows = Array.isArray(snapshot?.data?.networks) ? snapshot.data.networks : [];
  return rows.map((row) => ({
    network: String(row.network || ''),
    referringDomains: numberOr(row.referringDomains),
    backlinks: numberOr(row.backlinks),
    brokenBacklinks: numberOr(row.brokenBacklinks),
    linksRank: numberOr(row.linksRank),
    firstSeen: row.firstSeen || null,
    lostDate: row.lostDate || null,
    concentrated: !!row.concentrated,
  }));
};

export const networkSummaryFrom = (snapshot) => {
  const t = snapshot?.data?.totals || null;
  if (!t) return null;
  return {
    shown: numberOr(t.shown) ?? 0,
    concentrated: numberOr(t.concentrated) ?? 0,
    domainsInConcentrated: numberOr(t.domainsInConcentrated) ?? 0,
    largest: numberOr(t.largest),
    thresholds: t.thresholds || {},
    addressType: snapshot?.data?.addressType || null,
  };
};

export const TOXIC_BUCKETS = [
  { key: 'disavow', label: 'Suggested for disavow', match: (r) => r.disavow },
  { key: 'watch', label: 'Watch only', match: (r) => r.watch },
  { key: 'lost', label: 'Already gone', match: (r) => r.lost },
  { key: 'spam', label: 'High spam score', match: (r) => r.signals.includes('spam') },
  { key: 'sitewide', label: 'Sitewide placement', match: (r) => r.signals.includes('sitewide') },
  { key: 'dead', label: 'Linking pages broken', match: (r) => r.signals.includes('dead') },
];

export const filterToxicRows = (rows, { query = '', buckets = [] } = {}) => {
  const needle = query.trim().toLowerCase();
  const wanted = TOXIC_BUCKETS.filter((b) => buckets.includes(b.key));
  return rows.filter((row) => {
    if (needle && !row.domain.toLowerCase().includes(needle)) return false;
    if (wanted.length && !wanted.some((b) => b.match(row))) return false;
    return true;
  });
};

const toxicValueOf = (row, key) => {
  switch (key) {
    case 'domain':
      return row.domain;
    case 'score':
      return row.score;
    case 'spamScore':
      return row.spamScore === null ? BLANK : row.spamScore;
    case 'backlinks':
      return row.backlinks === null ? BLANK : row.backlinks;
    case 'linksRank':
      return row.linksRank === null ? BLANK : row.linksRank;
    case 'signals':
      return row.signals.length;
    default:
      return BLANK;
  }
};

export const sortToxicRows = (rows, sort) => sortRowsBy(rows, sort, toxicValueOf);

const networkValueOf = (row, key) => {
  switch (key) {
    case 'network':
      return row.network;
    case 'referringDomains':
      return row.referringDomains === null ? BLANK : row.referringDomains;
    case 'backlinks':
      return row.backlinks === null ? BLANK : row.backlinks;
    case 'linksRank':
      return row.linksRank === null ? BLANK : row.linksRank;
    default:
      return BLANK;
  }
};

export const sortNetworkRows = (rows, sort) => sortRowsBy(rows, sort, networkValueOf);

// ---------------------------------------------------------------------------
// disavow.txt
// ---------------------------------------------------------------------------

/** Google's own comment marker. One `#` at the start of a line. */
const comment = (line) => `# ${line}`;

/**
 * Build a `disavow.txt` from the rows the report SUGGESTS.
 *
 * ---- Four rules, and each one is somebody's site --------------------------
 *
 * ONLY `disavow` ROWS. Not `watch`, not "everything in the table". Two
 * independent signals is the floor, and the floor is on the server.
 *
 * NEVER A LOST LINK. Disavowing a link that no longer exists achieves nothing
 * and pads the file with rows nobody can verify. `toxicity.scoreDomain` already
 * refuses to mark one, and this is the second door on the same rule.
 *
 * ONE LINE PER DOMAIN, prefixed `domain:`. That form covers every URL on the
 * host, which is what "this whole referrer is bad" means — listing individual
 * URLs from a domain we have decided against is both longer and weaker.
 *
 * COMMENTS CARRY THE PROVENANCE. The site, the reading date, the thresholds and
 * the reasons per domain. A file somebody opens in six months with nothing but
 * hostnames in it cannot be checked, argued with, or partially undone.
 *
 * @param {Array<Object>} rows - from `toxicRowsFrom`
 * @param {Object} meta
 * @returns {string}
 */
export const buildDisavow = (rows, meta = {}) => {
  const suggested = (Array.isArray(rows) ? rows : []).filter((r) => r.disavow && !r.lost);
  const t = meta.thresholds || {};

  const header = [
    comment(`Disavow file for ${meta.domain || 'this site'}`),
    comment(
      `Generated from a ${meta.provider || 'DataForSEO'} referring-domain reading` +
        (meta.collectedAt ? ` collected ${meta.collectedAt}` : '') +
        (meta.statusType ? ` over the "${meta.statusType}" link set` : '')
    ),
    comment(
      `${suggested.length} domain${suggested.length === 1 ? '' : 's'} out of ` +
        `${meta.shown ?? rows.length} examined.`
    ),
    comment(
      'A domain is listed only when at least ' +
        `${t.minSignals ?? 2} independent signals apply to it and it is still linking.`
    ),
    comment(
      `Signals: spam score at or above ${t.spamScore ?? 61}; more than ` +
        `${t.sitewideLinks ?? 200} links from one domain; most linking pages broken.`
    ),
    comment(''),
    comment(
      'REVIEW EVERY LINE BEFORE UPLOADING. Disavowing a good link removes its ' +
        'value permanently, and this is a suggestion rather than a verdict.'
    ),
    comment(''),
  ];

  if (!suggested.length) {
    return `${[
      ...header,
      comment('Nothing in this reading met the bar. There is nothing to upload.'),
    ].join('\n')}\n`;
  }

  const body = suggested.flatMap((row) => [
    comment(
      `${row.domain} — ${row.signals.map(signalLabel).join('; ')}` +
        (typeof row.spamScore === 'number' ? ` (spam score ${row.spamScore})` : '') +
        (typeof row.backlinks === 'number' ? `, ${row.backlinks} links` : '')
    ),
    `domain:${row.domain}`,
  ]);

  return `${[...header, ...body].join('\n')}\n`;
};

/** `acme-com-disavow-2026-09-03.txt`. */
export const disavowFilename = (meta = {}) => {
  const slug = String(meta.domain || 'site')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'site';
  return `${slug}-disavow-${meta.periodKey || 'latest'}.txt`;
};
