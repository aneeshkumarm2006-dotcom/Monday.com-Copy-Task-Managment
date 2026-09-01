import { Suspense, lazy, useMemo, useState } from 'react';
import { Download, Filter, Search, X } from 'lucide-react';

import Button from '../../../ui/Button';
import EmptyState from '../../../ui/EmptyState';
import Pagination from '../../../ui/Pagination';
import SortableTh from '../../../ui/SortableTh';
import { SkeletonText } from '../../../ui/Skeleton';
import {
  FilterPopover,
  MiniChip,
  OptionList,
  OptionRow,
} from '../../../ui/FilterControls';
import { ScrollTable, Td, Th } from '../connector/SectionShell';
import {
  formatNumber,
  formatRank,
  marketLabel,
  movementOf,
  staleness,
  toneColor,
} from '../../../../utils/connectorFormat';
import {
  RANK_BUCKETS,
  filterRankRows,
  paginate,
  rankRowsFrom,
  sortRankRows,
  summariseRankRows,
} from '../../../../utils/rankRows';
import { downloadRankExport } from '../../../../utils/rankExport';

const RankChart = lazy(() => import('../connector/RankChart'));

/**
 * Rank tracking — every keyword, sortable, filterable and exportable.
 *
 * ---- Why this table is paged and not "Load more" ---------------------------
 *
 * Because it is not a feed. The app's other long lists are read newest-first and
 * nobody navigates to page four of an activity log, which is what makes "Load
 * more" right there. This table is sorted, compared against last week, and asked
 * "where is this keyword, and how many are there" — a question that needs a
 * total and an addressable position. See `ui/Pagination.jsx`.
 *
 * ---- Why the sort is a component and the arithmetic is a util --------------
 *
 * `SortableTh` because there were already three hand-written copies of a
 * three-state header and phases 6-8 need four more; `utils/rankRows.js` because
 * "a null rank must not sort as a zero" is a property worth asserting without a
 * DOM. Both are new here and both are for the screens that follow rather than
 * for this one.
 *
 * ---- The rule the whole screen turns on ------------------------------------
 *
 * THREE OUTCOMES, NOT TWO: a rank, a definite "not ranking", and no reading at
 * all. `formatRank` renders all three and is imported rather than reimplemented.
 * A table that showed a blank for the last two would make a collection gap
 * indistinguishable from a client falling out of the results — the first is our
 * problem and the second is theirs.
 */

const PAGE_SIZES = [25, 50, 100, 200];

/**
 * The columns, as data.
 *
 * `sortKey` is what `utils/rankRows.js` sorts on; a column without one is not
 * sortable and renders a plain header. The order here is the order on screen and
 * the order in the export, which is what makes a printed report and this table
 * the same report.
 */
const COLUMNS = [
  { key: 'keyword', label: 'Keyword', sortKey: 'keyword', align: 'left' },
  { key: 'rank', label: 'Rank', sortKey: 'rank', align: 'right', width: 90 },
  { key: 'change', label: 'Change', sortKey: 'change', align: 'right', width: 110 },
  {
    key: 'previousRank',
    label: 'Previous',
    sortKey: 'previousRank',
    align: 'right',
    width: 90,
  },
  {
    key: 'rankAbsolute',
    label: 'Absolute',
    sortKey: 'rankAbsolute',
    align: 'right',
    width: 90,
  },
  { key: 'features', label: 'SERP features', sortKey: 'features', align: 'left' },
];

const RankTrackingScreen = ({ data, label, keyword, onSelectKeyword, onRebuy }) => {
  const snapshot = data?.snapshots?.positions || null;
  const previous = data?.previousSnapshots?.positions || null;

  const [sort, setSort] = useState({ key: 'rank', dir: 'asc' });
  const [query, setQuery] = useState('');
  const [buckets, setBuckets] = useState([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const allRows = useMemo(() => rankRowsFrom(snapshot, previous), [snapshot, previous]);

  const filtered = useMemo(
    () => filterRankRows(allRows, { query, buckets }),
    [allRows, query, buckets]
  );
  const sorted = useMemo(() => sortRankRows(filtered, sort), [filtered, sort]);
  const view = useMemo(() => paginate(sorted, { page, pageSize }), [sorted, page, pageSize]);
  const summary = useMemo(() => summariseRankRows(filtered), [filtered]);

  /**
   * Every control that changes WHICH rows exist also sends you back to page one.
   *
   * Done in the setters rather than in an effect watching them. An effect would
   * render the new filter against the old page first and then correct itself,
   * which on a narrowing filter means one frame of an empty table — and it is
   * the cascading-render pattern the lint rule exists to catch. `paginate`
   * clamps as a backstop; this is what makes the pager's own state agree with it
   * so the next click is not relative to a page that no longer exists.
   */
  const changeQuery = (value) => {
    setQuery(value);
    setPage(1);
  };
  const changeSort = (next) => {
    setSort(next);
    setPage(1);
  };
  const changePageSize = (next) => {
    setPageSize(next);
    setPage(1);
  };
  const toggleBucket = (key) => {
    setBuckets((prev) =>
      prev.includes(key) ? prev.filter((b) => b !== key) : [...prev, key]
    );
    setPage(1);
  };
  const clearBuckets = () => {
    setBuckets([]);
    setPage(1);
  };

  const exportPayload = () => ({
    siteName: data.project?.name || data.project?.domain || 'Site',
    domain: data.project?.domain || '',
    variant: data.variant,
    periodKey: snapshot?.periodKey || '',
    collectedAt: snapshot?.collectedAt || snapshot?.fetchedAt || null,
    /**
     * The SORTED, FILTERED rows and not the whole set — deliberately. The export
     * button sits under a filter bar, so the file has to be what the screen
     * shows, or somebody who filtered to "declined" and pressed Export gets two
     * hundred rows and no warning. `filtered` is flagged so the file says so.
     */
    rows: sorted,
    filtered: filtered.length !== allRows.length,
  });

  if (!snapshot) {
    return (
      <EmptyState
        icon={Search}
        title="No rankings collected yet"
        description={
          data.queued > 0
            ? `${data.queued} collection${data.queued === 1 ? ' has' : 's have'} been ordered and ${data.queued === 1 ? 'is' : 'are'} still running. Results land here on their own.`
            : 'This fills in the next time the schedule runs. Nothing is bought when you open this tab.'
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* ---- Filter bar ------------------------------------------------------ */}
      <div className="flex flex-wrap items-center gap-2">
        <div style={{ position: 'relative', minWidth: 220, flex: '1 1 220px', maxWidth: 340 }}>
          <Search
            size={14}
            aria-hidden="true"
            style={{
              position: 'absolute',
              left: 10,
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'var(--color-text-muted)',
              pointerEvents: 'none',
            }}
          />
          <input
            type="search"
            value={query}
            onChange={(e) => changeQuery(e.target.value)}
            placeholder="Find a keyword"
            aria-label="Find a keyword"
            className="font-body w-full"
            style={{
              height: 34,
              padding: '0 10px 0 30px',
              fontSize: 13,
              borderRadius: 'var(--radius-md)',
              border: '1.5px solid var(--color-border-strong)',
              background: 'var(--color-bg-surface)',
              color: 'var(--color-text-primary)',
            }}
          />
        </div>

        <FilterPopover label="Filter" icon={Filter} activeCount={buckets.length}>
          <div style={{ minWidth: 190 }}>
            <OptionList emptyLabel="No filters">
              {RANK_BUCKETS.map((bucket) => (
                <OptionRow
                  key={bucket.key}
                  checked={buckets.includes(bucket.key)}
                  onToggle={() => toggleBucket(bucket.key)}
                >
                  <span className="font-body" style={{ fontSize: 13 }}>
                    {bucket.label}
                  </span>
                </OptionRow>
              ))}
            </OptionList>
          </div>
        </FilterPopover>

        {buckets.length > 0 && (
          <button
            type="button"
            onClick={clearBuckets}
            className="inline-flex items-center gap-1 font-body"
            style={{
              fontSize: 12.5,
              color: 'var(--color-text-muted)',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            <X size={12} aria-hidden="true" /> Clear
          </button>
        )}

        <div className="flex-1" />

        <Button
          variant="secondary"
          icon={Download}
          onClick={() => downloadRankExport(exportPayload(), 'csv')}
        >
          CSV
        </Button>
        <Button
          variant="secondary"
          icon={Download}
          onClick={() => downloadRankExport(exportPayload(), 'pdf')}
        >
          PDF
        </Button>
      </div>

      {/* ---- What the filter is showing -------------------------------------- */}
      <div className="flex flex-wrap items-center gap-2">
        <MiniChip bg="var(--color-bg-subtle)" text="var(--color-text-secondary)">
          {formatNumber(summary.ranking)} ranking
        </MiniChip>
        <MiniChip bg="var(--color-bg-subtle)" text="var(--color-text-secondary)">
          {formatNumber(summary.notRanking)} not ranking
        </MiniChip>
        {summary.unmeasured > 0 && (
          // Kept apart from "not ranking" on purpose: one is the provider's
          // answer and the other is our gap.
          <MiniChip bg="var(--color-bg-subtle)" text="var(--color-text-muted)">
            {formatNumber(summary.unmeasured)} with no reading
          </MiniChip>
        )}
        <MiniChip bg="var(--color-bg-subtle)" text={toneColor('positive')}>
          {formatNumber(summary.improved)} improved
        </MiniChip>
        <MiniChip bg="var(--color-bg-subtle)" text={toneColor('negative')}>
          {formatNumber(summary.declined)} declined
        </MiniChip>
        <div className="flex-1" />
        <p className="font-body" style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>
          {marketLabel(data.variant)} · collected{' '}
          {staleness(snapshot.collectedAt || snapshot.fetchedAt)}
          {snapshot.data?.depth ? ` · top ${snapshot.data.depth}` : ''}
        </p>
      </div>

      {/* ---- The table ------------------------------------------------------- */}
      <section
        style={{
          background: 'var(--color-bg-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-lg)',
          overflow: 'hidden',
        }}
      >
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
                      onSort={changeSort}
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
              {view.rows.length === 0 ? (
                <tr>
                  <td colSpan={COLUMNS.length}>
                    <p
                      className="font-body text-center px-4 py-8"
                      style={{ fontSize: 13, color: 'var(--color-text-muted)' }}
                    >
                      No keyword matches that filter.
                    </p>
                  </td>
                </tr>
              ) : (
                view.rows.map((row) => {
                  const move = movementOf(row);
                  const selected =
                    keyword && keyword.toLowerCase() === row.keyword.toLowerCase();
                  return (
                    <tr
                      key={row.keyword}
                      style={{
                        background: selected ? 'var(--color-accent-light)' : 'transparent',
                      }}
                    >
                      <Td>
                        <button
                          type="button"
                          onClick={() => onSelectKeyword?.(selected ? '' : row.keyword)}
                          className="font-body text-left truncate"
                          style={{
                            maxWidth: 320,
                            fontSize: 13,
                            background: 'none',
                            border: 'none',
                            padding: 0,
                            color: selected
                              ? 'var(--color-accent)'
                              : 'var(--color-text-primary)',
                            fontWeight: selected ? 600 : 400,
                            cursor: 'pointer',
                          }}
                          title={
                            row.url ? `${row.keyword} — ${row.url}` : row.keyword
                          }
                        >
                          {row.keyword}
                        </button>
                      </Td>
                      <Td align="right">
                        {/* Three-way. `—` and "Not ranking" mean different
                            things and the table must keep them apart. */}
                        {formatRank(row.rank, row.ranked)}
                      </Td>
                      <Td align="right">
                        <span style={{ color: toneColor(move.tone) }}>
                          {typeof row.change === 'number' && row.change !== 0
                            ? `${move.arrow} ${Math.abs(row.change)}`
                            : move.label}
                        </span>
                      </Td>
                      <Td align="right" muted>
                        {typeof row.previousRank === 'number'
                          ? `#${row.previousRank}`
                          : '—'}
                      </Td>
                      <Td
                        align="right"
                        muted
                        title={
                          typeof row.rankAbsolute === 'number' &&
                          typeof row.rank === 'number'
                            ? `${row.rankAbsolute - row.rank} block(s) above this result`
                            : undefined
                        }
                      >
                        {typeof row.rankAbsolute === 'number'
                          ? `#${row.rankAbsolute}`
                          : '—'}
                      </Td>
                      <Td muted title={row.features.join(', ')}>
                        {row.features.length ? (
                          <span className="truncate" style={{ display: 'inline-block', maxWidth: 240 }}>
                            {row.features
                              .filter((f) => f !== 'organic')
                              .slice(0, 3)
                              .join(', ') || 'organic only'}
                            {row.features.length > 4 ? ` +${row.features.length - 4}` : ''}
                          </span>
                        ) : (
                          '—'
                        )}
                      </Td>
                    </tr>
                  );
                })
              )}
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
          onPageSize={changePageSize}
        />
      </section>

      {/* ---- One keyword's stored history ------------------------------------ */}
      {data.keywordHistory && (
        <section
          style={{
            background: 'var(--color-bg-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-lg)',
            overflow: 'hidden',
          }}
        >
          <header
            className="flex items-baseline justify-between gap-3 px-4 py-3"
            style={{ borderBottom: '1px solid var(--color-border)' }}
          >
            <h3
              className="font-body font-medium truncate"
              style={{ fontSize: 13, color: 'var(--color-text-primary)' }}
            >
              “{data.keywordHistory.keyword}”
            </h3>
            <button
              type="button"
              onClick={() => onSelectKeyword?.('')}
              className="font-body shrink-0"
              style={{
                fontSize: 12,
                color: 'var(--color-text-muted)',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
              }}
            >
              Close
            </button>
          </header>
          <div className="px-4 py-4">
            <Suspense fallback={<SkeletonText width="100%" height={200} />}>
              <RankChart mode="keyword" history={data.keywordHistory} />
            </Suspense>
          </div>
        </section>
      )}

      {/* ---- The re-buy escape hatch ----------------------------------------- */}
      {onRebuy && (
        <p className="font-body" style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>
          Rankings are bought on a schedule and collected for free afterwards.{' '}
          <button
            type="button"
            onClick={onRebuy}
            className="underline"
            style={{
              fontSize: 11.5,
              color: 'var(--color-accent)',
              background: 'none',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
            }}
          >
            Buy this collection again
          </button>{' '}
          only if you need a reading before the next one — {label} charges when a
          collection is ordered, not when it arrives.
        </p>
      )}
    </div>
  );
};

export default RankTrackingScreen;
