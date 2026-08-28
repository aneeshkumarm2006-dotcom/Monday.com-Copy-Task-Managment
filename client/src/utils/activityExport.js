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
 * The report's columns, in order.
 *
 * Every row carries the full field snapshot of its task, so the sheet can be
 * filtered and pivoted on status, owner or due date without joining anything
 * back in. A field the task never had is blank, never absent.
 *
 * `csvOnly` is the release valve for that: the CSV is a dataset and can be as
 * wide as it needs to be, but the PDF is a printed page. Nineteen columns on A4
 * landscape squeezes Activity into a two-word ribbon, so the long-form and
 * rarely-printed fields (notes, timestamps, portal metadata) stay out of it.
 *
 * `width` is millimetres in the PDF. A4 landscape is 297mm wide and the table
 * takes 14mm margins either side, so the printed widths must total at most 269 —
 * autoTable warns and squeezes columns when they do not. Activity is left unset
 * so it absorbs whatever is left over.
 */
const COLUMNS = [
  { key: 'when', header: 'Date & time', width: 24 },
  { key: 'groupName', header: 'Group', width: 20 },
  // Two kinds of thing land in this column now. A tracker board's monthly goals
  // record their own activity against the same board, so the report covers both
  // — and the `Item type` column beside it is what tells a reader which of the
  // two a row is about. That column is CSV-only: the sheet is a dataset and
  // wants something to filter on, while on the printed page the Activity
  // sentence already says "added the goal" or "created the task" — and the PDF
  // has no millimetres to spare for a word it is already carrying.
  { key: 'taskName', header: 'Item', width: 32 },
  { key: 'itemType', header: 'Item type', csvOnly: true },
  { key: 'monthKey', header: 'Goal month', csvOnly: true },
  { key: 'isSubitem', header: 'Subitem', csvOnly: true },
  { key: 'status', header: 'Status', width: 18 },
  { key: 'priority', header: 'Priority', width: 14 },
  { key: 'assignees', header: 'Assignees', width: 26 },
  { key: 'dueDate', header: 'Due date', width: 18 },
  { key: 'labels', header: 'Labels', width: 22 },
  { key: 'checklist', header: 'Checklist', width: 14 },
  { key: 'note', header: 'Task notes', csvOnly: true },
  { key: 'updatesCount', header: 'Updates', csvOnly: true },
  { key: 'updates', header: 'Update thread', csvOnly: true },
  { key: 'taskSource', header: 'Task source', csvOnly: true },
  { key: 'portalRef', header: 'Ticket #', csvOnly: true },
  { key: 'portalType', header: 'Request type', csvOnly: true },
  { key: 'taskCreatedAt', header: 'Task created', csvOnly: true },
  { key: 'taskUpdatedAt', header: 'Task last updated', csvOnly: true },
  { key: 'actorName', header: 'Who', width: 20 },
  { key: 'eventLabel', header: 'Event', width: 20 },
  { key: 'field', header: 'Field changed', csvOnly: true },
  { key: 'description', header: 'Activity' },
];

/** The PDF's subset, in the same order. */
const PDF_COLUMNS = COLUMNS.filter((c) => !c.csvOnly);

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

/** A `YYYY-MM-DD` range boundary as prose: "6 Aug 2026". */
const prettyDay = (yyyyMmDd) => {
  const [y, m, d] = String(yyyyMmDd).split('-').map(Number);
  if (!y || !m || !d) return yyyyMmDd;
  return `${d} ${MONTHS[m - 1]} ${y}`;
};

/** Date only — a due date has no meaningful time of day. */
const formatDay = (iso) => {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
};

/** 'meta_ads' → 'Meta ads', 'dueDate' → 'Due date'. */
const humanize = (value) => {
  const s = String(value || '')
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : '';
};

/** Subitems are tasks too; mark them so the report doesn't read as duplicates. */
const displayTask = (row) => (row.isSubitem ? `↳ ${row.taskName}` : row.taskName);

/** 'goal' → 'Goal'. A row written before goals were logged has no type. */
const itemTypeLabel = (row) => (row.itemType === 'goal' ? 'Goal' : 'Task');

const list = (values) => (Array.isArray(values) ? values.join(', ') : '');

/**
 * One message of a task's discussion as a single line.
 *
 *   [12 Mar 2026, 14:05] Ann Smith: Looks right to me
 *   [12 Mar 2026, 14:20] Jane Doe (client): thanks! [attached: brief.pdf]
 *
 * Everything after the name is conditional, and each part earns its place by
 * answering something the name alone doesn't: whether the author was outside
 * the team, which of a client board's two threads this was said on, and
 * whether it was a reply rather than a new point.
 */
const messageLine = (m) => {
  let who = m.authorName || 'Unknown';
  if (m.isClient) who += ' (client)';
  if (m.replyToAuthor) who += ` (reply to ${m.replyToAuthor})`;
  if (m.edited) who += ' (edited)';

  const thread = m.thread === 'team'
    ? ' [team thread]'
    : m.thread === 'client' ? ' [client thread]' : '';

  const files = m.attachments?.length
    ? `[attached: ${m.attachments.join(', ')}]`
    : '';

  // A post can be nothing but a file, and a bare colon at the end of the line
  // reads as a message that failed to export.
  const text = (m.text || '').trim() || (files ? '' : '(no text)');
  // A multi-line message keeps its lines, indented: every message starts at
  // column zero with its timestamp, so the indent is what stops the second
  // paragraph of one post reading as somebody else's.
  const indented = text.replace(/\n/g, '\n    ');

  return `[${formatWhen(m.at)}]${thread} ${who}: ${[indented, files].filter(Boolean).join(' ')}`;
};

/**
 * A task's whole thread in one cell, oldest first.
 *
 * Newlines inside a quoted CSV field are legal (RFC 4180) and Excel wraps
 * them in place, so the conversation stays readable as a conversation rather
 * than being flattened onto one line or split across rows.
 */
const threadText = (thread) => {
  if (!thread?.messages?.length) return '';
  const lines = thread.messages.map(messageLine);
  const dropped = (thread.count || 0) - thread.messages.length;
  if (thread.truncated && dropped > 0) {
    lines.unshift(`… ${dropped} earlier message${dropped === 1 ? '' : 's'} not exported.`);
  }
  return lines.join('\n');
};

const toCells = (row, threads = {}) => ({
  when: formatWhen(row.at),
  groupName: row.groupName,
  taskName: displayTask(row),
  itemType: itemTypeLabel(row),
  // Only a goal has one; a task row leaves the column blank rather than
  // inventing a month for something that is not filed under one.
  monthKey: row.monthKey || '',
  isSubitem: row.isSubitem ? 'Yes' : '',
  status: row.status || '',
  priority: humanize(row.priority),
  assignees: list(row.assignees),
  dueDate: row.dueDate ? formatDay(row.dueDate) : '',
  labels: list(row.labels),
  // A task with no checklist reports blank, not "0/0" — the distinction between
  // "nothing ticked" and "no checklist" is the one a reader actually needs.
  checklist: row.checklistTotal ? `${row.checklistDone}/${row.checklistTotal}` : '',
  note: row.note || '',
  // Repeated on every row of a task, like the field snapshot above it: a
  // spreadsheet column has no other shape, and it is what lets any single row
  // be read without hunting for the one that carries the conversation.
  updatesCount: threads[row.taskId]?.count ? String(threads[row.taskId].count) : '',
  updates: threadText(threads[row.taskId]),
  taskSource: humanize(row.taskSource),
  portalRef: row.portalRef ? `#${row.portalRef}` : '',
  portalType: humanize(row.portalType),
  taskCreatedAt: row.taskCreatedAt ? formatWhen(row.taskCreatedAt) : '',
  taskUpdatedAt: row.taskUpdatedAt ? formatWhen(row.taskUpdatedAt) : '',
  actorName: row.actorType === 'client' ? `${row.actorName} (client)` : row.actorName,
  eventLabel: row.eventLabel,
  field: humanize(row.field),
  description: row.description,
});

/** Filename-safe slug of a board name. */
const slug = (name) =>
  String(name || 'board')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'board';

export const exportFilename = (payload, extension) => {
  const { from, to } = payload.range;
  // A single-day export ("Today") would otherwise repeat the same date twice.
  const window = from === to ? from : `${from}-to-${to}`;
  return `${slug(payload.board?.name)}-activity-${window}.${extension}`;
};

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

/**
 * What an empty window says.
 *
 * A quiet day is a finding, not an error: "nobody touched this board today" is
 * the answer to a real question, and a report that refuses to exist cannot be
 * filed, attached to an email or diffed against yesterday's. So the file is
 * always written, and it names the board and the window it found nothing in.
 */
const emptyNotice = (payload) => {
  const { from, to } = payload.range;
  const when = from === to ? `on ${prettyDay(from)}` : `between ${prettyDay(from)} and ${prettyDay(to)}`;
  return `No activity was recorded on ${payload.board?.name || 'this board'} ${when}.`;
};

export const rowsToCsv = (payload) => {
  const lines = [COLUMNS.map((c) => csvField(c.header)).join(',')];
  if (!payload.rows.length) {
    // One row, so the sheet still parses as a single table rather than as a
    // header stranded above nothing.
    const blank = Object.fromEntries(COLUMNS.map((c) => [c.key, '']));
    blank.when = prettyDay(payload.range.from);
    blank.description = emptyNotice(payload);
    lines.push(COLUMNS.map((c) => csvField(blank[c.key])).join(','));
    return `${BOM}${lines.join('\r\n')}\r\n`;
  }
  for (const row of payload.rows) {
    const cells = toCells(row, payload.threads || {});
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

export const downloadPdf = (payload) => {
  // Landscape: this many columns of prose do not fit portrait without wrapping
  // the description into an unreadable ribbon.
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
    (payload.range.from === payload.range.to
      ? prettyDay(payload.range.from)
      : `${prettyDay(payload.range.from)} to ${prettyDay(payload.range.to)}`) +
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

  if (!payload.rows.length) {
    // The title and the range line above already name the board and the window;
    // this is the sentence that stops a one-line PDF reading as a failed export.
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    doc.setTextColor(90);
    doc.text(emptyNotice(payload), 14, 40);
    saveBlob(doc.output('blob'), exportFilename(payload, 'pdf'));
    return;
  }

  autoTable(doc, {
    startY: payload.truncated ? 32 : 27,
    head: [PDF_COLUMNS.map((c) => c.header)],
    body: payload.rows.map((row) => {
      const cells = toCells(row);
      // An empty cell in a printed grid reads as a rendering fault; on screen in
      // a spreadsheet it reads as "not set", which is why only the PDF dashes.
      return PDF_COLUMNS.map((c) => cells[c.key] || '—');
    }),
    styles: { fontSize: 7, cellPadding: 1.4, overflow: 'linebreak', valign: 'top' },
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
