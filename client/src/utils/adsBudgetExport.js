import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { saveBlob } from './fileUrl.js';
import { ledgerRows } from './adsBudgetDisplay.js';

/**
 * The Ads Budget tables as files — `rankExport.js`'s architecture, three
 * reports wide.
 *
 * ---- What is reused, and why it is a registry ------------------------------
 *
 * ONE `columns` ARRAY DRIVES BOTH FORMATS, exactly as in `rankExport.js` and
 * `labsExport.js`. The alternative — a CSV builder and a PDF builder each with
 * their own column list — is two lists that agree the day they are written and
 * disagree three months later, at which point a client receives a spreadsheet
 * and a printout of "the same report" carrying different columns.
 *
 * ---- The rules that survive from the other two exports ---------------------
 *
 * THE BOM IS NOT DECORATION. Without it Excel on Windows opens the file as
 * cp1252 and mangles every non-ASCII name — and a budget sheet is full of
 * client and campaign names people cannot retype.
 *
 * A NULL IS AN EM DASH IN PRINT AND AN EMPTY CELL IN A SHEET. An empty cell in
 * a printed grid reads as a rendering fault; in a spreadsheet it reads as "not
 * set", which is what it means.
 *
 * ---- And one rule this file adds -------------------------------------------
 *
 * EVERY SHEET CARRIES ITS CURRENCY AND ITS MONTH, in the subtitle of the PDF
 * and in a column of every CSV. A budget export outlives the screen it came
 * from — it gets filtered, pivoted and pasted into a client report by somebody
 * who never saw the header that said which month and which currency these
 * figures were in. A column of bare numbers labelled "Budget" is not a number
 * anybody can safely act on.
 */

/** Filename-safe slug. */
const slug = (name) =>
  String(name || 'board')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'board';

/**
 * A money cell. Never a currency symbol — the subtitle and the Currency column
 * say which one, once, instead of on every figure.
 *
 * SEPARATED FOR PRINT, BARE FOR A SPREADSHEET. `8,000` has to be quoted under
 * RFC 4180, which lands it in Excel as TEXT — and a budget sheet whose money
 * columns cannot be summed or pivoted is useless for the thing people export it
 * to do. The printed table has the opposite need: nobody sums a PDF, and
 * `10739.29` is harder to read across a row than `10,739.29`.
 *
 * Same shape of decision as the em dash below: the two formats want different
 * things from the same value, and one `columns` array serves both.
 */
const money = (value, plain) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  if (plain) return String(Math.round(value * 100) / 100);
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
};

const percent = (fraction) =>
  typeof fraction === 'number' && Number.isFinite(fraction)
    ? `${(fraction * 100).toFixed(1)}%`
    : '';

/** "24 Aug 2026", from an instant, in the reader's locale. */
const prettyDay = (value) => {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
};

/**
 * The three reports, as data.
 *
 * `width` is millimetres in the PDF. A4 landscape is 297mm and the table takes
 * 14mm margins either side, so the printed widths must total at most 269;
 * autoTable warns and squeezes when they do not. The last printed column is
 * left unset so it absorbs whatever is left over.
 *
 * `csvOnly` columns are context that is worth having in a spreadsheet — where
 * it will be filtered and pivoted — and would only crowd a printed page.
 */
export const REPORTS = {
  clients: {
    title: 'ads budget by client',
    noun: 'client',
    rows: (payload) => payload.clients || [],
    columns: [
      { key: 'client', header: 'Client', width: 60, read: (r) => r.name || '' },
      { key: 'platforms', header: 'Platforms', width: 22, read: (r) => String(r.platformCount ?? '') },
      { key: 'budget', header: 'Budget', width: 28, read: (r, m, plain) => money(r.allocated, plain) },
      { key: 'spend', header: 'Spend', width: 28, read: (r, m, plain) => money(r.spent, plain) },
      { key: 'remaining', header: 'Remaining', width: 28, read: (r, m, plain) => money(r.remaining, plain) },
      { key: 'used', header: 'Used', width: 20, read: (r) => percent(r.usedPct) },
      { key: 'status', header: 'Status', width: 32, read: (r) => r.label || '' },
      { key: 'pacing', header: 'Pacing', csvOnly: true, read: (r) => r.verdict || '' },
      {
        key: 'projected',
        header: 'Projected spend',
        csvOnly: true,
        read: (r, m, plain) => money(r.projected, plain),
      },
      { key: 'dailyAverage', header: 'Average daily spend', csvOnly: true, read: (r, m, plain) => money(r.dailyAverage, plain) },
    ],
  },

  budgets: {
    title: 'platform and campaign budgets',
    noun: 'budget',
    /**
     * Platforms and their campaigns in ONE sheet, with a Level column, rather
     * than two sheets or two exports. A spreadsheet is filtered, and "show me
     * every campaign over budget across all channels" is the question this
     * export exists for — which two files cannot answer without a join.
     */
    rows: (payload) =>
      (payload.platforms || []).flatMap((p) => [
        { ...p, level: 'Platform' },
        ...(p.campaigns || []).map((c) => ({ ...c, level: 'Campaign' })),
      ]).concat((payload.orphans || []).map((c) => ({ ...c, level: 'Campaign' }))),
    columns: [
      { key: 'level', header: 'Level', width: 22, read: (r) => r.level },
      { key: 'platform', header: 'Platform', width: 40, read: (r) => r.platform || '' },
      { key: 'name', header: 'Campaign', width: 46, read: (r) => r.name || '' },
      { key: 'objective', header: 'Objective', width: 28, read: (r) => r.objective || '' },
      { key: 'budget', header: 'Budget', width: 26, read: (r, m, plain) => money(r.allocated, plain) },
      { key: 'spent', header: 'Spent', width: 26, read: (r, m, plain) => money(r.spent, plain) },
      { key: 'remaining', header: 'Remaining', width: 26, read: (r, m, plain) => money(r.remaining, plain) },
      { key: 'used', header: 'Used', width: 18, read: (r) => percent(r.usedPct) },
      { key: 'status', header: 'Status', read: (r) => r.label || '' },
      { key: 'account', header: 'Account', csvOnly: true, read: (r) => r.account || '' },
      { key: 'dailyBudget', header: 'Daily budget', csvOnly: true, read: (r, m, plain) => money(r.dailyBudget, plain) },
      { key: 'lifecycle', header: 'Lifecycle', csvOnly: true, read: (r) => r.lifecycle || '' },
      { key: 'owner', header: 'Owner', csvOnly: true, read: (r) => r.owner?.name || '' },
      { key: 'projected', header: 'Projected spend', csvOnly: true, read: (r, m, plain) => money(r.projected, plain) },
      { key: 'notes', header: 'Notes', csvOnly: true, read: (r) => r.notes || '' },
      { key: 'updatedAt', header: 'Last updated', csvOnly: true, read: (r) => prettyDay(r.updatedAt) },
    ],
  },

  activity: {
    title: 'budget activity',
    noun: 'movement',
    // The same derivation the on-screen ledger uses, so the sheet and the panel
    // cannot disagree about what moved or in which direction.
    rows: (payload) => ledgerRows(payload.activity),
    columns: [
      { key: 'date', header: 'Date', width: 30, read: (r) => prettyDay(r.createdAt) },
      { key: 'platform', header: 'Platform', width: 44, read: (r) => r.platform || '' },
      { key: 'name', header: 'Campaign', width: 48, read: (r) => (r.isCampaign ? r.name : '') },
      { key: 'activity', header: 'Activity', width: 40, read: (r) => r.activity },
      {
        key: 'amount',
        header: 'Amount',
        width: 30,
        // Signed, because a ledger where every figure is positive is not a
        // ledger. The sign is the whole content of the Direction column too,
        // which is there so a spreadsheet can filter on it.
        read: (r, m, plain) => `${r.direction === 'out' ? '-' : '+'}${money(r.amount, plain)}`,
      },
      { key: 'direction', header: 'Direction', csvOnly: true, read: (r) => (r.direction === 'out' ? 'Out' : 'In') },
      { key: 'user', header: 'User', read: (r) => r.actor?.name || '' },
    ],
  },
};

/** Context repeated on every CSV row, for a sheet that outlives its screen. */
const CONTEXT_COLUMNS = [
  { key: '_month', header: 'Month', read: (r, meta) => meta.monthLabel },
  { key: '_currency', header: 'Currency', read: (r, meta) => meta.currency },
  { key: '_client', header: 'Client scope', read: (r, meta) => meta.scope },
];

const metaFor = (payload) => ({
  monthLabel: payload.monthLabel || payload.monthKey || '',
  currency: payload.currency || 'USD',
  scope: payload.group?.name || 'All clients',
  boardName: payload.boardName || 'board',
});

export const exportFilename = (payload, report, extension) => {
  const meta = metaFor(payload);
  return `${slug(meta.boardName)}-${slug(REPORTS[report].title)}-${payload.monthKey || 'latest'}.${extension}`;
};

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * RFC 4180 field escaping: quote anything containing a comma, a quote or a
 * newline, and double any embedded quotes. A campaign name really can contain
 * all three — people paste them out of ad managers.
 */
const csvField = (value) => {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const BOM = '\uFEFF';

export const rowsToCsv = (payload, report) => {
  const spec = REPORTS[report];
  const meta = metaFor(payload);
  const columns = [...spec.columns, ...CONTEXT_COLUMNS];
  const rows = spec.rows(payload);

  const lines = [columns.map((c) => csvField(c.header)).join(',')];

  if (!rows.length) {
    // One row, so the sheet still parses as a single table rather than as a
    // header stranded above nothing. "Nothing budgeted" is a finding.
    const blank = columns.map((c) =>
      CONTEXT_COLUMNS.includes(c) ? csvField(c.read(null, meta)) : ''
    );
    blank[0] = csvField(`No ${spec.noun}s for ${meta.scope} in ${meta.monthLabel}.`);
    lines.push(blank.join(','));
  } else {
    for (const row of rows) {
      lines.push(columns.map((c) => csvField(c.read(row, meta, true))).join(','));
    }
  }

  // Written as an escape rather than the literal character, which is invisible
  // in a diff and gets deleted by the next person tidying the file.
  return `${BOM}${lines.join('\r\n')}\r\n`;
};

export const downloadCsv = (payload, report) => {
  const blob = new Blob([rowsToCsv(payload, report)], { type: 'text/csv;charset=utf-8;' });
  saveBlob(blob, exportFilename(payload, report, 'csv'));
};

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

export const downloadPdf = (payload, report) => {
  const spec = REPORTS[report];
  const meta = metaFor(payload);
  const rows = spec.rows(payload);
  const printed = spec.columns.filter((c) => !c.csvOnly);

  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.text(`${meta.scope} — ${spec.title}`, 14, 16);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(110);
  doc.text(
    [
      meta.monthLabel,
      `amounts in ${meta.currency}`,
      `${rows.length} ${spec.noun}${rows.length === 1 ? '' : 's'}`,
    ]
      .filter(Boolean)
      .join('   ·   '),
    14,
    22
  );
  doc.setTextColor(0);

  if (!rows.length) {
    doc.setFontSize(11);
    doc.setTextColor(90);
    doc.text(`No ${spec.noun}s for ${meta.scope} in ${meta.monthLabel}.`, 14, 36);
    saveBlob(doc.output('blob'), exportFilename(payload, report, 'pdf'));
    return;
  }

  autoTable(doc, {
    startY: 27,
    head: [printed.map((c) => c.header)],
    // An empty cell in a printed grid reads as a rendering fault; in a
    // spreadsheet it reads as "not set", which is why only the PDF dashes.
    body: rows.map((row) => printed.map((c) => c.read(row, meta, false) || '—')),
    styles: { fontSize: 8, cellPadding: 1.6, overflow: 'linebreak', valign: 'top' },
    headStyles: { fillColor: [45, 55, 72], textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [247, 248, 250] },
    columnStyles: Object.fromEntries(
      printed.filter((c) => c.width).map((c) => [printed.indexOf(c), { cellWidth: c.width }])
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
    doc.text(`Page ${i} of ${pageCount}`, pageWidth - 14, pageHeight - 8, { align: 'right' });
  }

  saveBlob(doc.output('blob'), exportFilename(payload, report, 'pdf'));
};

export const downloadAdsBudgetExport = (payload, report, format) =>
  (format === 'pdf' ? downloadPdf : downloadCsv)(payload, report);
