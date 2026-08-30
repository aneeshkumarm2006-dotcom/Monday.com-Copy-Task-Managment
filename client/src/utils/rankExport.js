import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { saveBlob } from './fileUrl';
import { formatRank, marketLabel } from './connectorFormat';

/**
 * The rank table as a file — the same architecture as `activityExport.js`.
 *
 * ---- What is being copied, and why on purpose -------------------------------
 *
 * ONE `COLUMNS` ARRAY DRIVES BOTH FORMATS. The alternative — a CSV builder and a
 * PDF builder each with their own column list — is two lists that agree on the
 * day they are written and disagree three months later, at which point a client
 * receives a spreadsheet and a printout of "the same report" carrying different
 * columns. The `csvOnly` flag is the release valve: the sheet is a dataset and
 * can be as wide as it needs to be, while A4 landscape has 269mm and a URL
 * column eats sixty of them.
 *
 * THE UTF-8 BOM IS NOT DECORATION. Without it Excel on Windows opens the file as
 * cp1252 and mangles every non-ASCII keyword — which for an SEO export is most
 * of them, since the accented and non-Latin terms are exactly the ones people
 * track and cannot retype.
 *
 * ---- The one rule this file adds -------------------------------------------
 *
 * A RANK OF `null` IS AN ANSWER. `formatRank` is imported rather than
 * reimplemented, so an exported cell says "Not in top 100" where the screen says
 * it, and "—" where we genuinely have no reading. A CSV that wrote 0 or a blank
 * for both would erase the distinction the entire feature turns on — and unlike
 * the screen, a spreadsheet gets filtered, pivoted and pasted into a report by
 * somebody who never saw the table it came from.
 */

/**
 * The report's columns, in order.
 *
 * `width` is millimetres in the PDF. A4 landscape is 297mm and the table takes
 * 14mm margins either side, so the printed widths must total at most 269;
 * autoTable warns and squeezes when they do not. The last column is left unset
 * so it absorbs whatever is left over.
 */
const COLUMNS = [
  { key: 'keyword', header: 'Keyword', width: 60 },
  { key: 'rank', header: 'Rank', width: 24 },
  { key: 'previousRank', header: 'Previous', width: 24 },
  { key: 'change', header: 'Change', width: 22 },
  { key: 'movement', header: 'Movement', width: 28 },
  // Absolute rank counts every block on the page, organic or not. The GAP
  // between it and the organic rank is the only free measure of SERP-feature
  // pressure, and it is the one number that explains a traffic drop where the
  // organic position did not move.
  { key: 'rankAbsolute', header: 'Absolute rank', width: 26 },
  // CSV-only, and each for its own reason. A URL is 80 characters and would take
  // a third of the printed page; the feature census is a list that wraps to four
  // lines; and the market and collection date are already in the PDF's header
  // line, where they belong once rather than on every row.
  { key: 'url', header: 'Ranking URL', csvOnly: true },
  { key: 'features', header: 'SERP features', csvOnly: true },
  { key: 'market', header: 'Market', csvOnly: true },
  { key: 'collectedAt', header: 'Collected', csvOnly: true },
  { key: 'domain', header: 'Domain', csvOnly: true },
];

/** The PDF's subset, in the same order. */
const PDF_COLUMNS = COLUMNS.filter((c) => !c.csvOnly);

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

/** How a movement reads in a file, where there is no colour to carry it. */
const MOVEMENT_WORDS = {
  up: 'Improved',
  down: 'Declined',
  flat: 'No change',
  entered: 'Entered',
  lost: 'Left',
  none: '',
};

const toCells = (row, meta) => ({
  keyword: row.keyword,
  // The three-way rendering, from the one function that owns it.
  rank: formatRank(row.rank, row.ranked),
  previousRank: typeof row.previousRank === 'number' ? `#${row.previousRank}` : '',
  // A sign, because "+5" and "5" read differently and the sign IS the meaning:
  // rank is inverted, so positive is an improvement.
  change:
    typeof row.change === 'number'
      ? `${row.change > 0 ? '+' : ''}${row.change}`
      : '',
  movement: MOVEMENT_WORDS[row.movement] ?? '',
  rankAbsolute: typeof row.rankAbsolute === 'number' ? `#${row.rankAbsolute}` : '',
  url: row.url || '',
  features: (row.features || []).join(', '),
  market: meta.market,
  collectedAt: meta.collectedAt,
  domain: meta.domain,
});

/** Filename-safe slug. */
const slug = (name) =>
  String(name || 'site')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'site';

export const exportFilename = (payload, extension) =>
  `${slug(payload.siteName)}-rankings-${payload.periodKey || 'latest'}.${extension}`;

/** The header line both formats carry, so they cannot describe different data. */
const subtitle = (payload) =>
  [
    payload.domain,
    marketLabel(payload.variant),
    payload.collectedAt ? `collected ${prettyDay(payload.collectedAt)}` : null,
    `${payload.rows.length} keyword${payload.rows.length === 1 ? '' : 's'}`,
    payload.filtered ? 'filtered view' : null,
  ]
    .filter(Boolean)
    .join('   ·   ');

const metaFor = (payload) => ({
  market: marketLabel(payload.variant),
  collectedAt: prettyDay(payload.collectedAt),
  domain: payload.domain || '',
});

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

export const rowsToCsv = (payload) => {
  const meta = metaFor(payload);
  const lines = [COLUMNS.map((c) => csvField(c.header)).join(',')];

  if (!payload.rows.length) {
    // One row, so the sheet still parses as a single table rather than as a
    // header stranded above nothing. "Nothing ranked" is a finding.
    const blank = Object.fromEntries(COLUMNS.map((c) => [c.key, '']));
    blank.keyword = `No keywords matched on ${payload.siteName || 'this site'}.`;
    blank.market = meta.market;
    blank.collectedAt = meta.collectedAt;
    lines.push(COLUMNS.map((c) => csvField(blank[c.key])).join(','));
  } else {
    for (const row of payload.rows) {
      const cells = toCells(row, meta);
      lines.push(COLUMNS.map((c) => csvField(cells[c.key])).join(','));
    }
  }

  // Written as an escape rather than the literal character, which is invisible
  // in a diff and gets deleted by the next person tidying the file.
  return `${BOM}${lines.join('\r\n')}\r\n`;
};

export const downloadCsv = (payload) => {
  const blob = new Blob([rowsToCsv(payload)], { type: 'text/csv;charset=utf-8;' });
  saveBlob(blob, exportFilename(payload, 'csv'));
};

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

export const downloadPdf = (payload) => {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const meta = metaFor(payload);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.text(`${payload.siteName || 'Site'} — rankings`, 14, 16);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(110);
  doc.text(subtitle(payload), 14, 22);
  doc.setTextColor(0);

  if (!payload.rows.length) {
    doc.setFontSize(11);
    doc.setTextColor(90);
    doc.text(
      `No keywords matched on ${payload.siteName || 'this site'}.`,
      14,
      36
    );
    saveBlob(doc.output('blob'), exportFilename(payload, 'pdf'));
    return;
  }

  autoTable(doc, {
    startY: 27,
    head: [PDF_COLUMNS.map((c) => c.header)],
    body: payload.rows.map((row) => {
      const cells = toCells(row, meta);
      // An empty cell in a printed grid reads as a rendering fault; in a
      // spreadsheet it reads as "not set", which is why only the PDF dashes.
      return PDF_COLUMNS.map((c) => cells[c.key] || '—');
    }),
    styles: { fontSize: 8, cellPadding: 1.6, overflow: 'linebreak', valign: 'top' },
    headStyles: { fillColor: [45, 55, 72], textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [247, 248, 250] },
    columnStyles: Object.fromEntries(
      PDF_COLUMNS.filter((c) => c.width).map((c) => [
        PDF_COLUMNS.indexOf(c),
        { cellWidth: c.width },
      ])
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

  saveBlob(doc.output('blob'), exportFilename(payload, 'pdf'));
};

export const downloadRankExport = (payload, format) =>
  (format === 'pdf' ? downloadPdf : downloadCsv)(payload);
