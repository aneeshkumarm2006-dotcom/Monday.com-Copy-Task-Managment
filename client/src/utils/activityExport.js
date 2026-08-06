// jsPDF is a NAMED export — the package's default is the module namespace
// object, so `import jsPDF from 'jspdf'` gives you something that is not a
// constructor and fails only at call time.
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { saveBlob } from './fileUrl';

/**
 * Turn the board activity export payload into a downloadable file.
 *
 * The server already did the hard part — permission, resolution of ids into
 * names, and the plain-English description of each event. Everything here is
 * presentation, which is why it lives in the browser: no server-side PDF
 * toolchain, and the download needs no second authenticated round-trip.
 *
 * Both formats render the SAME columns in the same order, so a CSV and a PDF of
 * one range are the same report in two shapes.
 */

/**
 * The report's columns, in order, for both formats.
 *
 * `width` is millimetres in the PDF. A4 landscape is 297mm wide and the table
 * takes 14mm margins either side, so the fixed widths must total at most 269 —
 * autoTable warns and squeezes columns when they do not. Activity is left
 * unset so it absorbs whatever is left over.
 */
const COLUMNS = [
  { key: 'when', header: 'Date & time', width: 32 },
  { key: 'groupName', header: 'Group', width: 28 },
  { key: 'taskName', header: 'Task', width: 44 },
  { key: 'actorName', header: 'Who', width: 28 },
  { key: 'eventLabel', header: 'Event', width: 28 },
  { key: 'description', header: 'Activity' },
];

/** "12 Mar 2026, 14:05" — sortable-ish, unambiguous, and locale-independent. */
const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

const formatWhen = (iso) => {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${hh}:${mm}`;
};

/** Subitems are tasks too; mark them so the report doesn't read as duplicates. */
const displayTask = (row) => (row.isSubitem ? `↳ ${row.taskName}` : row.taskName);

const toCells = (row) => ({
  when: formatWhen(row.at),
  groupName: row.groupName || '—',
  taskName: displayTask(row),
  actorName: row.actorType === 'client' ? `${row.actorName} (client)` : row.actorName,
  eventLabel: row.eventLabel,
  description: row.description,
});

/** Filename-safe slug of a board name. */
const slug = (name) =>
  String(name || 'board')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'board';

export const exportFilename = (payload, extension) =>
  `${slug(payload.board?.name)}-activity-${payload.range.from}-to-${payload.range.to}.${extension}`;

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * RFC 4180 field escaping: quote anything containing a comma, a quote, or a
 * newline, and double any embedded quotes. Descriptions are free text quoting
 * task names and comment snippets, so all three cases really do occur.
 */
const csvField = (value) => {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const BOM = '\uFEFF';

export const rowsToCsv = (payload) => {
  const lines = [COLUMNS.map((c) => csvField(c.header)).join(',')];
  for (const row of payload.rows) {
    const cells = toCells(row);
    lines.push(COLUMNS.map((c) => csvField(cells[c.key])).join(','));
  }
  // The BOM is not decoration: without it Excel on Windows opens UTF-8 as
  // cp1252 and mangles every non-ASCII name in the report. Written as an escape
  // rather than the literal character, which is invisible in a diff.
  return `${BOM}${lines.join('\r\n')}\r\n`;
};

export const downloadCsv = (payload) => {
  const blob = new Blob([rowsToCsv(payload)], { type: 'text/csv;charset=utf-8;' });
  saveBlob(blob, exportFilename(payload, 'csv'));
};

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

const prettyDay = (yyyyMmDd) => {
  const [y, m, d] = String(yyyyMmDd).split('-').map(Number);
  if (!y || !m || !d) return yyyyMmDd;
  return `${d} ${MONTHS[m - 1]} ${y}`;
};

export const downloadPdf = (payload) => {
  // Landscape: six columns of prose do not fit portrait without wrapping the
  // description into an unreadable ribbon.
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.text(`${payload.board?.name || 'Board'} — activity`, 14, 16);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(110);
  doc.text(
    `${prettyDay(payload.range.from)} to ${prettyDay(payload.range.to)}` +
      `   ·   ${payload.totalCount} event${payload.totalCount === 1 ? '' : 's'}` +
      `   ·   generated ${formatWhen(payload.generatedAt)}`,
    14,
    22
  );
  if (payload.truncated) {
    doc.setTextColor(180, 60, 40);
    doc.text(
      `Showing the first ${payload.maxRows} events — narrow the date range for the rest.`,
      14,
      27
    );
  }
  doc.setTextColor(0);

  autoTable(doc, {
    startY: payload.truncated ? 32 : 27,
    head: [COLUMNS.map((c) => c.header)],
    body: payload.rows.map((row) => {
      const cells = toCells(row);
      return COLUMNS.map((c) => cells[c.key]);
    }),
    styles: { fontSize: 8, cellPadding: 1.8, overflow: 'linebreak', valign: 'top' },
    headStyles: { fillColor: [45, 55, 72], textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [247, 248, 250] },
    columnStyles: Object.fromEntries(
      COLUMNS.filter((c) => c.width).map((c) => [
        COLUMNS.indexOf(c),
        { cellWidth: c.width },
      ])
    ),
    margin: { left: 14, right: 14, bottom: 16 },
  });

  // Page numbers go in a second pass, not in `didDrawPage`: during the draw the
  // total page count is not known yet, so "Page 1 of 1" would be stamped on
  // every page of a twelve-page report.
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

export const downloadExport = (payload, format) =>
  (format === 'pdf' ? downloadPdf : downloadCsv)(payload);
