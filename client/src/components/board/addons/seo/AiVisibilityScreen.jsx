import { useMemo, useState } from 'react';
import { Sparkles } from 'lucide-react';

import EmptyState from '../../../ui/EmptyState';
import Pagination from '../../../ui/Pagination';
import SortableTh from '../../../ui/SortableTh';
import { ScrollTable, Stat, StatRow, Td, Th } from '../connector/SectionShell';
import { formatNumber, formatRank } from '../../../../utils/connectorFormat';
import { paginate } from '../../../../utils/rankRows';
import { downloadLabsExport } from '../../../../utils/labsExport';
import {
  AI_BUCKETS,
  aiRowsFrom,
  aiStateLabel,
  aiSummaryFrom,
  citationSourcesFrom,
  comparability,
  filterAiRows,
  formatCitationRank,
  fractionLabel,
  isKindCollected,
  percentLabel,
  sortAiRows,
} from '../../../../utils/aiRows';
import { CountChip, LabsFilterBar, NotCollected, Panel, PanelHead } from './LabsBits';

/**
 * AI visibility — what Google's own answer says about this site.
 *
 * ---- Free, and the screen says so ------------------------------------------
 *
 * `ai_overview` rides inside the SERP payload the rank tracker already buys, so
 * nothing on this page costs anything to collect. The caption says that out
 * loud, because the obvious question about an AI panel in 2026 is what it costs
 * — and because the honest answer has a caveat: DataForSEO offer a paid flag
 * (`load_async_ai_overview`) that makes capture more reliable, it is off, and
 * the screen would rather admit that than imply completeness it cannot promise.
 *
 * ---- CITED AND MENTIONED ARE TWO TILES, TWO COLUMNS, AND NEVER ONE NUMBER ---
 *
 * CITED: our domain is in the reference list Google attached to its summary.
 * Exact, and the half that carries a link.
 *
 * MENTIONED: our brand word appears in the prose. Visibility with no click, and
 * inferred from text rather than read from a field.
 *
 * They overlap and neither contains the other, and they are fixed by different
 * work — links against entity coverage. A blended "AI visibility" percentage
 * would move for either reason and tell a reader to do neither, which is why
 * there is no such number anywhere in this feature: not on this screen, not in
 * the goal-field catalog, not in the export.
 *
 * ---- And every rate is shown with its fraction -----------------------------
 *
 * "0%" cannot distinguish "we are cited in none of the forty overviews on this
 * keyword set" from "there are no overviews at all". Those are opposite
 * findings.
 */

const PAGE_SIZES = [25, 50, 100];

const COLUMNS = [
  { key: 'keyword', label: 'Keyword', sortKey: 'keyword', align: 'left' },
  { key: 'state', label: 'AI Overview', sortKey: 'state', align: 'left', width: 150 },
  { key: 'citationRank', label: 'Cited at', sortKey: 'citationRank', align: 'right', width: 90 },
  {
    key: 'citationCount',
    label: 'Sources cited',
    sortKey: 'citationCount',
    align: 'right',
    width: 110,
  },
  { key: 'rank', label: 'Organic rank', sortKey: 'rank', align: 'right', width: 110 },
];

const STATE_TONE = {
  both: 'var(--color-status-done)',
  cited: 'var(--color-accent)',
  mentioned: 'var(--color-status-working)',
  neither: 'var(--color-status-stuck)',
  none: 'var(--color-text-muted)',
};

const AiVisibilityScreen = ({ data, label }) => {
  const snapshot = data?.snapshots?.positions || null;
  const previous = data?.previousSnapshots?.positions || null;
  const collected = isKindCollected(data, 'positions');

  const [sort, setSort] = useState({ key: 'citationRank', dir: 'asc' });
  const [query, setQuery] = useState('');
  const [buckets, setBuckets] = useState([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const summary = useMemo(() => aiSummaryFrom(snapshot), [snapshot]);
  const allRows = useMemo(() => aiRowsFrom(snapshot), [snapshot]);
  const filtered = useMemo(
    () => filterAiRows(allRows, { query, buckets }),
    [allRows, query, buckets]
  );
  const sorted = useMemo(() => sortAiRows(filtered, sort), [filtered, sort]);
  const view = useMemo(() => paginate(sorted, { page, pageSize }), [sorted, page, pageSize]);
  const sources = useMemo(() => citationSourcesFrom(snapshot), [snapshot]);

  /**
   * The one-step change, and only when the two readings are comparable.
   *
   * The rank tab's compacted `trend` deliberately drops `keywords[]`, so the
   * presence rate is not in that series and cannot be drawn from it — this is
   * the same guarded one-step delta phases 7 and 8 draw, for the same reason.
   */
  const guard = useMemo(
    () => comparability(snapshot?.data, previous?.data),
    [snapshot, previous]
  );

  const runExport = (format) =>
    downloadLabsExport(
      {
        siteName: data.project?.name || data.project?.domain || 'Site',
        domain: data.project?.domain || '',
        variant: snapshot?.variant || data.variant,
        periodKey: snapshot?.periodKey || '',
        collectedAt: snapshot?.collectedAt || null,
        depth: summary?.depth || null,
        rows: sorted,
        filtered: filtered.length !== allRows.length,
      },
      'aiVisibility',
      format
    );

  if (!snapshot || !summary) {
    return (
      <div className="flex flex-col gap-4">
        {!collected && <NotCollected label={label} what="Rank tracking" />}
        <EmptyState
          icon={Sparkles}
          title="No AI Overview data yet"
          description={
            collected
              ? 'This fills in with the next weekly rank collection — it rides inside the same payload and costs nothing extra.'
              : 'Nothing is being collected for this panel.'
          }
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {!collected && <NotCollected label={label} what="Rank tracking" />}

      <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
        Read out of the search results already bought for rank tracking — this panel
        costs nothing to collect. {label} offer a paid option that captures AI
        Overviews more reliably; it is switched off, so a keyword shown here
        without one may still have had one for somebody else.
      </p>

      <Panel>
        <StatRow>
          <Stat
            label="Keywords with an AI Overview"
            value={percentLabel(summary.presenceRate)}
            sub={fractionLabel(summary.withOverview, summary.tracked)}
          />
          <Stat
            /**
             * CITED. Exact, from Google's own reference list, and the half that
             * sends a click.
             */
            label="Cited"
            value={percentLabel(summary.citedRate)}
            sub={`${fractionLabel(summary.cited, summary.withOverview)} overviews`}
          />
          <Stat
            /**
             * MENTIONED. A DIFFERENT metric, deliberately beside rather than
             * added to the one on its left.
             */
            label="Brand named"
            value={percentLabel(summary.mentionedRate)}
            sub={`${fractionLabel(summary.mentioned, summary.withOverview)} overviews`}
          />
          <Stat
            label="Average citation position"
            value={
              summary.averageCitationRank === null
                ? '—'
                : `#${summary.averageCitationRank}`
            }
            sub="where in Google’s source list"
          />
        </StatRow>
      </Panel>

      {(summary.mentionedNotCited > 0 || summary.citedNotMentioned > 0) && (
        <Panel>
          <PanelHead
            title="The two gaps worth acting on"
            sub="named and cited are different problems with different fixes"
          />
          <div className="flex flex-wrap gap-6 px-4 py-3">
            <div>
              <p
                className="font-display font-semibold"
                style={{ fontSize: 20, color: 'var(--color-text-primary)' }}
              >
                {formatNumber(summary.mentionedNotCited)}
              </p>
              <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                named with no link — the answer knows the brand and sends the click
                somewhere else
              </p>
            </div>
            <div>
              <p
                className="font-display font-semibold"
                style={{ fontSize: 20, color: 'var(--color-text-primary)' }}
              >
                {formatNumber(summary.citedNotMentioned)}
              </p>
              <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                linked with no name — the page is a source, the brand is not part of
                the answer
              </p>
            </div>
          </div>
        </Panel>
      )}

      {!guard.ok && guard.reason && (
        <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
          No change is shown against the previous reading: {guard.reason}
        </p>
      )}

      {sources.length > 0 && (
        <Panel>
          <PanelHead
            title="Who Google cites for these keywords"
            sub="across the overviews it showed"
            right={<CountChip>{sources.length} domains</CountChip>}
          />
          <ScrollTable maxHeight={220}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <Th align="left">Domain</Th>
                  <Th align="right" width={120}>Keywords</Th>
                  <Th align="right" width={120}>Share</Th>
                </tr>
              </thead>
              <tbody>
                {sources.slice(0, 25).map((row) => (
                  <tr key={row.domain}>
                    <Td>
                      <span
                        className="font-body"
                        style={{
                          color: row.ours
                            ? 'var(--color-accent)'
                            : 'var(--color-text-primary)',
                          fontWeight: row.ours ? 600 : 400,
                        }}
                      >
                        {row.domain}
                        {row.ours ? ' (this site)' : ''}
                      </span>
                    </Td>
                    <Td align="right">{formatNumber(row.keywords)}</Td>
                    <Td align="right">{percentLabel(row.share)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollTable>
        </Panel>
      )}

      <LabsFilterBar
        query={query}
        onQuery={(v) => {
          setQuery(v);
          setPage(1);
        }}
        placeholder="Find a keyword"
        buckets={AI_BUCKETS}
        active={buckets}
        onToggle={(key) => {
          setBuckets((held) =>
            held.includes(key) ? held.filter((k) => k !== key) : [...held, key]
          );
          setPage(1);
        }}
        onClear={() => {
          setBuckets([]);
          setPage(1);
        }}
        onExport={runExport}
      />

      <Panel>
        <ScrollTable maxHeight={560}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {COLUMNS.map((col) => (
                  <SortableTh
                    key={col.key}
                    column={col.sortKey}
                    sort={sort}
                    onSort={(next) => {
                      setSort(next);
                      setPage(1);
                    }}
                    align={col.align}
                    width={col.width}
                  >
                    {col.label}
                  </SortableTh>
                ))}
              </tr>
            </thead>
            <tbody>
              {view.rows.map((row) => (
                <tr key={row.keyword}>
                  <Td>{row.keyword}</Td>
                  <Td>
                    <span
                      className="font-body"
                      style={{ fontSize: 12.5, color: STATE_TONE[row.state] }}
                    >
                      {aiStateLabel(row.state)}
                    </span>
                  </Td>
                  {/*
                    NOT `formatRank`. That function turns a null into "Not in top
                    100" — a sentence about search results, on a column about a
                    citation list of eight, that is never true.
                  */}
                  <Td align="right">{formatCitationRank(row.citationRank, row.present)}</Td>
                  <Td align="right">{formatNumber(row.citationCount)}</Td>
                  <Td align="right">{formatRank(row.rank, row.ranked)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollTable>

        <Pagination
          page={view.page}
          pageCount={view.pageCount}
          from={view.from}
          to={view.to}
          total={view.total}
          onPage={setPage}
          noun="keywords"
          pageSizes={PAGE_SIZES}
          pageSize={pageSize}
          onPageSize={(next) => {
            setPageSize(next);
            setPage(1);
          }}
        />
      </Panel>
    </div>
  );
};

export default AiVisibilityScreen;
