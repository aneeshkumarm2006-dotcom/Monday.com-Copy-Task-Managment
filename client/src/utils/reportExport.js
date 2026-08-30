import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { saveBlob } from './fileUrl.js';
import { FRESHNESS_CAPTIONS } from './reportWidgets.js';

/**
 * The client report as a PDF.
 *
 * ---- Why this is a second export module beside `labsExport.js` -------------
 *
 * `labsExport` is a REGISTRY OF TABLES: one `columns` array per report drives
 * both a CSV and a PDF, and the whole architecture exists so a client cannot
 * receive a spreadsheet and a printout of "the same report" carrying different
 * columns. Every entry in it is one table of rows.
 *
 * This is not a table. It is a laid-out document — a summary, then sections, then
 * tiles and charts and one table inside them — and there is no CSV of it,
 * because a spreadsheet of a page layout is not a thing anybody wants. Folding
 * it into that registry would mean either bending the registry to render
 * non-tabular widgets or bending the report into one flat table.
 *
 * What it DOES reuse is the mechanics that matter: the same `jsPDF` +
 * `jspdf-autotable` dependency pair, the same A4 page, the same page-number
 * second pass (during the draw the total is unknown, so "Page 1 of 1" would be
 * stamped on every page of a twelve-page report), and the same `saveBlob`.
 *
 * ---- Portrait, not landscape ------------------------------------------------
 *
 * The Labs exports are landscape because they are wide tables. A client report
 * is read like a document and is mostly prose and tiles, so it is A4 portrait —
 * which is also the shape it will be printed and emailed in.
 *
 * ---- Every refusal is printed ----------------------------------------------
 *
 * A tile whose two readings could not be compared carries `deltaReason`, and
 * this file prints it rather than dropping the row to a bare number. A PDF
 * outlives every caption on the screen it came from; a change that was declined
 * and is silently absent from the file is a change the reader will assume was
 * zero.
 */

const MARGIN = 16;

const number = (value) =>
  typeof value === 'number' && Number.isFinite(value)
    ? new Intl.NumberFormat('en-US').format(Math.round(value * 100) / 100)
    : '—';

const slug = (name) =>
  String(name || 'site')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'site';

export const reportFilename = (report) =>
  `${slug(report?.meta?.siteName)}-seo-report-${report?.meta?.periodLabel || 'latest'}.pdf`;

/**
 * Draw the whole report.
 *
 * @param {Object} report - from `reportWidgets.buildReport`
 * @param {Object} [opts]
 * @param {string} [opts.provider] - named in the footer, never in a heading
 */
export const downloadReportPdf = (report, { provider = '' } = {}) => {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const usable = pageWidth - MARGIN * 2;

  let y = 20;

  /** Start a new page when the next block will not fit. */
  const room = (needed) => {
    if (y + needed > pageHeight - 20) {
      doc.addPage();
      y = 20;
    }
  };

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.text(report.meta.siteName || 'SEO report', MARGIN, y);
  y += 7;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(110);
  doc.text(
    [report.meta.domain, report.meta.periodLabel ? `reading of ${report.meta.periodLabel}` : null]
      .filter(Boolean)
      .join('   ·   '),
    MARGIN,
    y
  );
  doc.setTextColor(0);
  y += 9;

  // ---- The summary --------------------------------------------------------
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('Summary', MARGIN, y);
  y += 6;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  for (const line of report.narrative.lines) {
    const wrapped = doc.splitTextToSize(line, usable);
    room(wrapped.length * 5 + 2);
    doc.text(wrapped, MARGIN, y);
    y += wrapped.length * 5 + 1;
  }

  if (report.narrative.caveats.length) {
    y += 2;
    doc.setFontSize(8.5);
    doc.setTextColor(120);
    for (const caveat of report.narrative.caveats) {
      const wrapped = doc.splitTextToSize(caveat, usable);
      room(wrapped.length * 4 + 2);
      doc.text(wrapped, MARGIN, y);
      y += wrapped.length * 4 + 1;
    }
    doc.setTextColor(0);
  }
  y += 6;

  // ---- The sections -------------------------------------------------------
  for (const section of report.sections) {
    room(20);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.text(section.title, MARGIN, y);
    y += 5;

    /**
     * THE FRESHNESS SENTENCE, per section rather than once at the top. A report
     * mixing a competitive index, a live link graph and a crawl cannot be
     * honestly captioned in one line.
     */
    const caption = FRESHNESS_CAPTIONS[section.widgets[0]?.freshness];
    if (caption) {
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(8.5);
      doc.setTextColor(120);
      doc.text(caption, MARGIN, y);
      doc.setTextColor(0);
      y += 5;
    }

    const tiles = section.widgets.filter((w) => w.type === 'number');
    if (tiles.length) {
      autoTable(doc, {
        startY: y,
        head: [['', 'Now', 'Change']],
        body: tiles.map((tile) => [
          [tile.title, tile.sub].filter(Boolean).join(' — '),
          number(tile.value),
          typeof tile.delta === 'number'
            ? `${tile.delta > 0 ? '+' : ''}${number(tile.delta)}`
            : tile.deltaReason
              ? 'not comparable'
              : '—',
        ]),
        styles: { fontSize: 9, cellPadding: 1.8, overflow: 'linebreak' },
        headStyles: { fillColor: [45, 55, 72], textColor: 255, fontStyle: 'bold' },
        alternateRowStyles: { fillColor: [247, 248, 250] },
        columnStyles: { 1: { halign: 'right', cellWidth: 26 }, 2: { halign: 'right', cellWidth: 32 } },
        margin: { left: MARGIN, right: MARGIN },
      });
      y = doc.lastAutoTable.finalY + 4;

      /** Every declined comparison, named under the table it belongs to. */
      const refused = tiles.filter((t) => t.deltaReason);
      if (refused.length) {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
        doc.setTextColor(120);
        for (const tile of refused) {
          const wrapped = doc.splitTextToSize(`${tile.title}: ${tile.deltaReason}`, usable);
          room(wrapped.length * 3.6 + 2);
          doc.text(wrapped, MARGIN, y);
          y += wrapped.length * 3.6 + 1;
        }
        doc.setTextColor(0);
        y += 3;
      }
    }

    for (const w of section.widgets) {
      if (w.type === 'bar' || w.type === 'donut') {
        const rows =
          w.type === 'bar'
            ? w.bars.map((b) => [b.label, number(b.value)])
            : w.slices.map((s) => [s.label, number(s.value)]);
        if (!rows.length) continue;
        room(16);
        autoTable(doc, {
          startY: y,
          head: [[w.title, w.type === 'bar' ? 'Keywords' : 'Keywords cited']],
          body: rows,
          styles: { fontSize: 9, cellPadding: 1.6 },
          headStyles: { fillColor: [90, 100, 120], textColor: 255 },
          columnStyles: { 1: { halign: 'right', cellWidth: 32 } },
          margin: { left: MARGIN, right: MARGIN },
        });
        y = doc.lastAutoTable.finalY + 4;
      }

      if (w.type === 'table' && w.rows.length) {
        room(16);
        autoTable(doc, {
          startY: y,
          head: [w.columns.map((c) => c.label)],
          body: w.rows.map((row) =>
            w.columns.map((c) => (c.format === 'number' ? number(row[c.key]) : row[c.key] ?? '—'))
          ),
          styles: { fontSize: 9, cellPadding: 1.6, overflow: 'linebreak' },
          headStyles: { fillColor: [90, 100, 120], textColor: 255 },
          margin: { left: MARGIN, right: MARGIN },
        });
        y = doc.lastAutoTable.finalY + 4;
        if (w.truncated) {
          doc.setFontSize(8);
          doc.setTextColor(120);
          doc.text(`Showing ${w.rows.length} of ${w.totalRows}.`, MARGIN, y);
          doc.setTextColor(0);
          y += 5;
        }
      }

      /**
       * A LINE IS NOT DRAWN. Rendering a chart into a PDF means rasterising a
       * DOM node or reimplementing the axis, and the series it would draw is
       * already in the table above it. A report that says "average position went
       * 16.1 to 14.2" needs no picture of the same two numbers, and a wrong
       * picture would be worse than none.
       */
    }

    y += 4;
  }

  // Page numbers in a second pass: during the draw the total is not known yet,
  // so "Page 1 of 1" would be stamped on every page of a twelve-page report.
  const pageCount = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i += 1) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(140);
    if (provider) doc.text(`Data: ${provider}`, MARGIN, pageHeight - 10);
    doc.text(`Page ${i} of ${pageCount}`, pageWidth - MARGIN, pageHeight - 10, {
      align: 'right',
    });
  }

  saveBlob(doc.output('blob'), reportFilename(report));
};
