import { useMemo } from 'react';

import SectionFrame from '../SectionFrame';
import { ReportWidget } from '../ReportWidgetRenderer';
import { FRESHNESS_CAPTIONS, buildReport } from '../../../utils/reportWidgets';

/**
 * ReportWidgetSection — one widget off one client's connector report.
 *
 * Payload (`executiveHome.runReportWidget`):
 *   { boardId, boardName, groupId, groupName, provider,
 *     widget: { type, title },          // what was CONFIGURED
 *     report: {                         // the READINGS, or null when no site
 *       project: { name, domain },      // is mapped to this client yet
 *       variant, snapshots, previousSnapshots, trend } }
 *
 * ---- THE SERVER SHIPS READINGS; THE WIDGET IS BUILT HERE ------------------
 *
 * Every other section in this folder draws a payload a server-side scorer
 * produced. This one is the exception, and deliberately: `buildReport`,
 * `buildWidget` and the three `comparability` guards that decide whether two
 * readings may be subtracted all live in `utils/reportWidgets.js` and the row
 * modules beside it — client code, with no server twin. A server that built the
 * widget would therefore be a SECOND implementation of those guards, and the
 * failure would be a tile printing "+12 since the last reading" directly above
 * an "Open board" link to the panel that refused to draw that same subtraction
 * because the two readings were bought to different depths.
 *
 * So the composer ships exactly the shape `buildReport` consumes, this file
 * calls the real `buildReport`, and the tile and the board's Report tab are the
 * same widget built by the same function from the same rows.
 *
 * ---- AND IT STILL BUYS NOTHING --------------------------------------------
 *
 * `buildReport` makes no request of any kind; it rearranges a payload it is
 * handed. The payload came out of `ConnectorSnapshot`, which the weekly
 * collection pass paid for hours or days ago. That matters more here than
 * anywhere else in the app: on this provider a render that reached the provider
 * would BUY SERPS, per viewer, per render, and this is the first page its owner
 * opens every morning.
 *
 * ---- WHY THE WIDGET IS FOUND BY TITLE -------------------------------------
 *
 * `config.widget` is `{ type, title }` — a POINTER into the report rather than a
 * description of a chart. A report carries several `number` tiles and the titles
 * are what tell them apart (`ClientReportScreen` keys its own tiles on
 * `w.title`, so they are unique within a report by construction).
 *
 * A blank title is legal and means "the first widget of that type", which is
 * what lets somebody choose a shape without knowing what this month's report
 * happens to contain. And a title that matches nothing is NOT an error: a report
 * is built only from the kinds that actually have a reading, so a site that has
 * not had a crawl this month genuinely has no "Site health score" panel. The
 * tile says which widget it was looking for rather than drawing an empty box.
 */

/** Every widget in the report, flattened. Sections are a layout, not a filter. */
const widgetsOf = (report) =>
  (report?.sections || []).flatMap((s) => (Array.isArray(s.widgets) ? s.widgets : []));

/**
 * The configured widget, or the first of its type, or nothing.
 *
 * Compared case-insensitively and trimmed, because the title is stored text: it
 * is chosen from a list today, and a hand-edited profile or an older client
 * should not miss a match over a trailing space.
 */
const findWidget = (report, want) => {
  if (!want?.type) return null;
  const all = widgetsOf(report).filter((w) => w.type === want.type);
  const title = String(want.title || '').trim().toLowerCase();
  if (!title) return all[0] || null;
  return all.find((w) => String(w.title || '').trim().toLowerCase() === title) || all[0] || null;
};

const ReportWidgetSection = ({ section }) => {
  const data = section?.data || {};
  const report = data.report || null;

  /**
   * Built once per payload. `buildReport` walks every snapshot the section was
   * given and constructs every widget, which is more than this tile draws — but
   * it is the ONLY way to get a widget that is identical to the tab's, and it is
   * pure arithmetic over an object already in memory. Re-running it on an
   * unrelated re-render is the part worth avoiding, so it is memoised on the
   * payload rather than on the section.
   */
  const widget = useMemo(() => (report ? findWidget(buildReport(report), data.widget) : null),
    [report, data.widget]);

  const subtitle = [data.boardName, data.groupName].filter(Boolean).join(' · ');

  /**
   * Two different absences, and they are different sentences about a client.
   * The composer distinguishes them by shipping `report: null` for the first,
   * which is why both can be named here rather than collapsing into "no data".
   */
  const emptyMessage = report
    ? `No readings have been collected for ${report.project?.domain || data.groupName || 'this client'} yet.`
    : `No site is connected to ${data.groupName || 'this client'} yet.`;

  return (
    <SectionFrame
      section={section}
      // The widget's own title IS what the number is — "Referring domains", not
      // "Report widget". The generic label belongs in the section picker, where
      // somebody is choosing a kind of tile; here they are reading a figure.
      title={widget?.title || data.widget?.title || 'Report'}
      subtitle={subtitle || undefined}
      emptyMessage={emptyMessage}
    >
      {() => (widget ? (
        <div className="flex flex-col gap-2">
          <ReportWidget widget={widget} />
          {/*
            THE FRESHNESS SENTENCE, from the kind this widget came from. A report
            mixes a competitive index, a live link graph and a crawl, so the
            caption is per WIDGET everywhere it is printed — the rule
            `reportWidgets.js` states and `ClientReportScreen` follows per
            section. A tile drawing one widget prints exactly one of them.
          */}
          {FRESHNESS_CAPTIONS[widget.freshness] ? (
            <p className="font-body" style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>
              {FRESHNESS_CAPTIONS[widget.freshness]}
            </p>
          ) : null}
        </div>
      ) : (
        /*
          The report has readings, but none of this shape. Not an error and not
          the `empty` state either — the section is working and its client has
          data; what is missing is the one panel it was pointed at, because a
          report is built only from the kinds that have a reading. Naming the
          widget is what turns "this tile is broken" into "that reading has not
          landed this month".
        */
        <p
          className="font-body text-center"
          style={{ fontSize: 13, color: 'var(--color-text-muted)', padding: '18px 0' }}
        >
          {data.widget?.title
            ? `This report has no “${data.widget.title}” panel at the moment.`
            : 'This report has nothing of that shape at the moment.'}
        </p>
      ))}
    </SectionFrame>
  );
};

export default ReportWidgetSection;
