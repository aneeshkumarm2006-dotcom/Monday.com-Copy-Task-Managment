import { useMemo, useState } from 'react';
import { Split } from 'lucide-react';

import EmptyState from '../../../ui/EmptyState';
import Pagination from '../../../ui/Pagination';
import SortableTh from '../../../ui/SortableTh';
import { ScrollTable, Stat, StatRow, Td, Th } from '../connector/SectionShell';
import { formatNumber, formatRank } from '../../../../utils/connectorFormat';
import { paginate } from '../../../../utils/rankRows';
import { downloadLabsExport } from '../../../../utils/labsExport';
import {
  CANNIBAL_BUCKETS,
  cannibalRowsFrom,
  cannibalSummaryFrom,
  filterCannibalRows,
  isKindCollected,
  offendingPages,
  pathOf,
  sortCannibalRows,
} from '../../../../utils/cannibalRows';
import { CountChip, LabsFilterBar, NotCollected, Panel, PanelHead } from './LabsBits';

/**
 * Cannibalization — where two of this site's own pages compete for one query.
 *
 * ---- Free, and free twice ---------------------------------------------------
 *
 * The DATA is free: a second URL of ours on one SERP is a fact sitting inside
 * the weekly census that has already been bought.
 *
 * The MEANING is free only at depth, which is why this screen draws the weekly
 * `positions` census and never the daily `movement` check. A second page at
 * position 47 does not exist in a ten-deep reading, so the same panel on the
 * daily kind would report a clean site every day and a cannibalised one once a
 * week — and the disagreement would look like a bug rather than a depth.
 *
 * The depth is therefore on the caption, in the export, and in the empty state:
 * "nothing found" reads very differently at 10 than at 100.
 *
 * ---- Health has a denominator, and it is not the keyword list --------------
 *
 * It is taken over the keywords this site appears for AT ALL. A site ranking for
 * twelve of two hundred tracked keywords, cleanly, scores 6% against the whole
 * list — a ranking problem rendered as a duplication problem, under a heading
 * that says cannibalization. The server computes it the right way and this
 * screen reads it.
 *
 * ---- And two pages together is not automatically a problem -----------------
 *
 * Two of our URLs at 3 and 4 is usually one page and its sitelink, or a rich
 * result. Two at 3 and 61 is one page held back by a page Google prefers to
 * ignore. That is why the table leads with the SPREAD rather than with the
 * count, and why the screen calls these "competing pages" rather than "errors".
 */

const PAGE_SIZES = [25, 50, 100];

const COLUMNS = [
  { key: 'keyword', label: 'Keyword', sortKey: 'keyword', align: 'left' },
  { key: 'count', label: 'Our pages', sortKey: 'count', align: 'right', width: 100 },
  { key: 'best', label: 'Best', sortKey: 'best', align: 'right', width: 90 },
  { key: 'worst', label: 'Worst', sortKey: 'worst', align: 'right', width: 90 },
  { key: 'spread', label: 'Apart', sortKey: 'spread', align: 'right', width: 90 },
  { key: 'urls', label: 'Pages', align: 'left' },
];

const CannibalizationScreen = ({ data, label }) => {
  const snapshot = data?.snapshots?.positions || null;
  const collected = isKindCollected(data, 'positions');

  const [sort, setSort] = useState({ key: 'spread', dir: 'desc' });
  const [query, setQuery] = useState('');
  const [buckets, setBuckets] = useState([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const summary = useMemo(() => cannibalSummaryFrom(snapshot), [snapshot]);
  const allRows = useMemo(() => cannibalRowsFrom(snapshot), [snapshot]);
  const filtered = useMemo(
    () => filterCannibalRows(allRows, { query, buckets }),
    [allRows, query, buckets]
  );
  const sorted = useMemo(() => sortCannibalRows(filtered, sort), [filtered, sort]);
  const view = useMemo(() => paginate(sorted, { page, pageSize }), [sorted, page, pageSize]);
  const pages = useMemo(() => offendingPages(allRows), [allRows]);

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
      'cannibalization',
      format
    );

  if (!snapshot || !summary) {
    return (
      <div className="flex flex-col gap-4">
        {!collected && <NotCollected label={label} what="Rank tracking" />}
        <EmptyState
          icon={Split}
          title="No ranking data yet"
          description={
            collected
              ? 'This fills in with the next weekly rank collection — it is read out of the same results and costs nothing extra.'
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
        Read out of the weekly census
        {summary.depth ? ` of the first ${summary.depth} results` : ''} — this panel
        costs nothing to collect. A page beyond that depth cannot appear here, so a
        deeper reading finds more.
      </p>

      <Panel>
        <StatRow>
          <Stat
            label="Cannibalization health"
            value={summary.healthPct === null ? '—' : `${summary.healthPct}%`}
            sub="100 means one page per query"
          />
          <Stat
            label="Contested keywords"
            value={formatNumber(summary.competing)}
            /**
             * The DENOMINATOR, printed. Without it the count above is a number
             * nobody can size — eight out of twelve and eight out of eight
             * hundred are different sites.
             */
            sub={`of ${formatNumber(summary.ranking)} this site ranks for`}
          />
          <Stat
            label="Surplus pages"
            value={formatNumber(summary.extraUrls)}
            sub="beyond the best one on each query"
          />
          <Stat
            label="Keywords tracked"
            value={formatNumber(summary.tracked)}
            sub="the whole list, contested or not"
          />
        </StatRow>
      </Panel>

      {pages.length > 0 && (
        <Panel>
          <PanelHead
            title="Pages that keep turning up"
            sub="the list a consolidation plan is written from"
            right={<CountChip>{pages.length} pages</CountChip>}
          />
          <ScrollTable maxHeight={200}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <Th align="left">Page</Th>
                  <Th align="right" width={140}>Contested keywords</Th>
                  <Th align="right" width={110}>Best position</Th>
                </tr>
              </thead>
              <tbody>
                {pages.slice(0, 20).map((row) => (
                  <tr key={row.url}>
                    <Td>
                      <span title={row.url}>{pathOf(row.url)}</span>
                    </Td>
                    <Td align="right">{formatNumber(row.keywords)}</Td>
                    <Td align="right">{formatRank(row.bestRank, true)}</Td>
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
        placeholder="Find a keyword or page"
        buckets={CANNIBAL_BUCKETS}
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
        {allRows.length === 0 ? (
          <div className="px-4 py-6">
            <p className="font-body" style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
              No keyword in this reading has more than one page of this site on it.
              That is the healthy answer
              {summary.depth ? ` for the first ${summary.depth} results` : ''}.
            </p>
          </div>
        ) : (
          <>
            <ScrollTable maxHeight={560}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    {COLUMNS.map((col) =>
                      col.sortKey ? (
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
                      ) : (
                        <Th key={col.key} align={col.align} width={col.width}>
                          {col.label}
                        </Th>
                      )
                    )}
                  </tr>
                </thead>
                <tbody>
                  {view.rows.map((row) => (
                    <tr key={row.keyword}>
                      <Td>{row.keyword}</Td>
                      <Td align="right">{formatNumber(row.count)}</Td>
                      <Td align="right">{formatRank(row.best, true)}</Td>
                      <Td align="right">{formatRank(row.worst, true)}</Td>
                      <Td align="right">{formatNumber(row.spread)}</Td>
                      <Td>
                        <div className="flex flex-col gap-0.5">
                          {row.urls.map((entry) => (
                            <span
                              key={entry.url || `${row.keyword}-${entry.rank}`}
                              className="font-body truncate"
                              style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}
                              title={entry.url || ''}
                            >
                              {formatRank(entry.rank, true)} · {pathOf(entry.url)}
                            </span>
                          ))}
                        </div>
                      </Td>
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
          </>
        )}
      </Panel>
    </div>
  );
};

export default CannibalizationScreen;
