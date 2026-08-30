import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';

import EmptyState from '../../../ui/EmptyState';
import Pagination from '../../../ui/Pagination';
import SortableTh from '../../../ui/SortableTh';
import { ScrollTable, Stat, StatRow, Td, Th } from '../connector/SectionShell';
import {
  formatMoney,
  formatNumber,
  toneColor,
} from '../../../../utils/connectorFormat';
import { paginate } from '../../../../utils/rankRows';
import {
  KEYWORD_BUCKETS,
  filterKeywordRows,
  isKindCollected,
  keywordRowsFrom,
  labsFreshness,
  sortKeywordRows,
  summariseKeywordRows,
} from '../../../../utils/labsRows';
import { downloadLabsExport } from '../../../../utils/labsExport';
import {
  CountChip,
  DifficultyPill,
  IndexStamp,
  LabsFilterBar,
  NotCollected,
  Sparkline,
} from './LabsBits';

/**
 * Keyword research — what every tracked keyword is worth, and how hard it is.
 *
 * ---- What this screen is, and what it deliberately is not ------------------
 *
 * It is the ENRICHMENT of the keyword list this Site already tracks: volume,
 * difficulty, intent, cost per click and twelve months of seasonality, bought
 * once a month from `keyword_overview` at $0.012 + $0.00012 a keyword.
 *
 * IT IS NOT A DISCOVERY TOOL, and that is a scope decision rather than an
 * omission. "Find me new keywords" means a seed box, a billable call per press
 * and a write path into the Site's tracked list — a purchase a person triggers
 * by typing, on a provider that charges at the moment a request is made. That
 * needs its own budget seam and its own confirmation, and it is not something to
 * bolt onto a read-only tab. Everything here comes out of `ConnectorSnapshot`
 * and NOTHING ON THIS PAGE SPENDS ANYTHING.
 *
 * ---- Why the numbers are labelled the way they are -------------------------
 *
 * "Difficulty" and "ad competition" are two different numbers that both look
 * like "how hard is this", and confusing them is the most common way a keyword
 * report misleads somebody. `keyword_difficulty` is 0-100 on a log scale and
 * means "chance of reaching the top ten"; `competition` is 0-1 and is Google
 * Ads' measure of how many advertisers are bidding. A page that called either
 * one "competition" would be wrong half the time.
 *
 * ---- Nulls -----------------------------------------------------------------
 *
 * Labs answers are full of legitimate nulls — the index has no SERP for this
 * keyword, nobody bids on it, it is too new to have twelve months. `formatNumber`
 * and `formatMoney` render every one of them as an em dash, never as a zero. A
 * table of forty rows reading "0 volume, 0 difficulty, $0.00" looks like a
 * finding and is a parsing bug.
 */

const PAGE_SIZES = [25, 50, 100, 200];

/**
 * The columns, as data. `sortKey` is what `utils/labsRows.js` sorts on; the
 * order here is the order on screen, and `utils/labsExport.js` carries the same
 * order into both file formats.
 */
const COLUMNS = [
  { key: 'keyword', label: 'Keyword', sortKey: 'keyword', align: 'left' },
  { key: 'searchVolume', label: 'Volume', sortKey: 'searchVolume', align: 'right', width: 92 },
  { key: 'seasonality', label: '12 months', align: 'left', width: 84 },
  {
    key: 'keywordDifficulty',
    label: 'Difficulty',
    sortKey: 'keywordDifficulty',
    align: 'right',
    width: 90,
  },
  { key: 'intent', label: 'Intent', sortKey: 'intent', align: 'left', width: 140 },
  { key: 'cpc', label: 'CPC', sortKey: 'cpc', align: 'right', width: 84 },
  {
    key: 'competition',
    label: 'Ad competition',
    sortKey: 'competition',
    align: 'right',
    width: 110,
  },
  { key: 'features', label: 'SERP features', sortKey: 'features', align: 'left' },
];

const KeywordResearchScreen = ({ data, label }) => {
  const snapshot = data?.snapshots?.keyword_metrics || null;
  const collected = isKindCollected(data, 'keyword_metrics');
  const freshness = labsFreshness(snapshot);

  const [sort, setSort] = useState({ key: 'searchVolume', dir: 'desc' });
  const [query, setQuery] = useState('');
  const [buckets, setBuckets] = useState([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const allRows = useMemo(() => keywordRowsFrom(snapshot), [snapshot]);
  const filtered = useMemo(
    () => filterKeywordRows(allRows, { query, buckets }),
    [allRows, query, buckets]
  );
  const sorted = useMemo(() => sortKeywordRows(filtered, sort), [filtered, sort]);
  const view = useMemo(() => paginate(sorted, { page, pageSize }), [sorted, page, pageSize]);
  const summary = useMemo(() => summariseKeywordRows(filtered), [filtered]);

  /**
   * Every control that changes WHICH rows exist also sends you back to page one,
   * and it is done in the setters rather than in an effect watching them. An
   * effect would render the new filter against the old page first and correct
   * itself a frame later, which on a narrowing filter is one frame of an empty
   * table.
   */
  const changeQuery = (value) => {
    setQuery(value);
    setPage(1);
  };
  const changeSort = (next) => {
    setSort(next);
    setPage(1);
  };
  const toggleBucket = (key) => {
    setBuckets((prev) => (prev.includes(key) ? prev.filter((b) => b !== key) : [...prev, key]));
    setPage(1);
  };

  const runExport = (format) =>
    downloadLabsExport(
      {
        siteName: data.project?.name || data.project?.domain || 'Site',
        domain: data.project?.domain || '',
        variant: snapshot?.variant || data.variant,
        periodKey: snapshot?.periodKey || '',
        collectedAt: freshness.collectedAt,
        indexUpdatedAt: freshness.indexUpdatedAt,
        // The SORTED, FILTERED rows: the export button sits under a filter bar,
        // so the file has to be what the screen shows.
        rows: sorted,
        filtered: filtered.length !== allRows.length,
      },
      'keywords',
      format
    );

  if (!snapshot) {
    return (
      <div className="flex flex-col gap-4">
        {!collected && <NotCollected label={label} what="Keyword research" />}
        <EmptyState
          icon={Search}
          title="No keyword metrics collected yet"
          description={
            collected
              ? `This fills in the next time the schedule runs — ${label} refreshes it monthly, because search volume is a twelve-month rolling average and cannot move meaningfully inside a week. Nothing is bought when you open this tab.`
              : 'Nothing is being collected for this panel.'
          }
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <IndexStamp freshness={freshness} label={label} />
      {!collected && <NotCollected label={label} what="Keyword research" />}

      {/* ---- The headline numbers, over the FILTERED set --------------------- */}
      <section
        style={{
          background: 'var(--color-bg-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-lg)',
          overflow: 'hidden',
        }}
      >
        <StatRow>
          <Stat
            label="Keywords"
            value={formatNumber(summary.keywords)}
            sub={
              summary.unmeasured
                ? `${summary.unmeasured} with no reading`
                : 'in this view'
            }
          />
          <Stat
            label="Monthly searches"
            value={formatNumber(summary.totalVolume, { compact: true })}
            sub="added across this view"
          />
          <Stat
            label="Average difficulty"
            // Averaged over the keywords that HAVE a difficulty. Counting a null
            // as zero would make the number improve when the data got worse.
            value={formatNumber(summary.averageDifficulty)}
            sub="0-100, chance of a top-ten place"
          />
          <Stat
            label="Average CPC"
            value={formatMoney(summary.averageCpc)}
            sub="what advertisers pay per click"
          />
          <Stat
            label="Main intent"
            value={summary.byIntent[0]?.label || '—'}
            sub={
              summary.byIntent.length
                ? `${summary.byIntent[0].count} of ${summary.keywords} keywords`
                : 'no intent reported'
            }
          />
        </StatRow>
      </section>

      <LabsFilterBar
        query={query}
        onQuery={changeQuery}
        placeholder="Find a keyword"
        buckets={KEYWORD_BUCKETS}
        active={buckets}
        onToggle={toggleBucket}
        onClear={() => {
          setBuckets([]);
          setPage(1);
        }}
        onExport={runExport}
      />

      <div className="flex flex-wrap items-center gap-2">
        {summary.byIntent.map((intent) => (
          <CountChip key={intent.key}>
            {formatNumber(intent.count)} {intent.label.toLowerCase()}
          </CountChip>
        ))}
        {summary.unmeasured > 0 && (
          // Kept apart from every other chip on purpose: it is a fact about OUR
          // data, not about the keywords.
          <CountChip tone="var(--color-text-muted)">
            {formatNumber(summary.unmeasured)} with no reading
          </CountChip>
        )}
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
                view.rows.map((row) => (
                  <tr key={row.keyword}>
                    <Td title={row.keyword}>
                      <span
                        className="truncate"
                        style={{ display: 'inline-block', maxWidth: 300 }}
                      >
                        {row.keyword}
                      </span>
                    </Td>
                    <Td align="right">{formatNumber(row.searchVolume)}</Td>
                    <Td>
                      <Sparkline points={row.monthlySearches} />
                    </Td>
                    <Td align="right">
                      <DifficultyPill value={row.keywordDifficulty} band={row.band} />
                    </Td>
                    <Td muted>
                      {row.intent ? (
                        <>
                          {row.intent}
                          {typeof row.intentProbability === 'number' && (
                            <span style={{ opacity: 0.7 }}>
                              {' '}
                              {Math.round(row.intentProbability * 100)}%
                            </span>
                          )}
                        </>
                      ) : (
                        '—'
                      )}
                    </Td>
                    <Td align="right">{formatMoney(row.cpc)}</Td>
                    <Td align="right" muted>
                      {typeof row.competition === 'number'
                        ? `${Math.round(row.competition * 100)}%`
                        : '—'}
                    </Td>
                    <Td muted title={row.features.join(', ')}>
                      {row.features.length ? (
                        <span
                          className="truncate"
                          style={{ display: 'inline-block', maxWidth: 220 }}
                        >
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
                ))
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
          onPageSize={(next) => {
            setPageSize(next);
            setPage(1);
          }}
        />
      </section>

      <p className="font-body" style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>
        Difficulty and ad competition are different measures and are shown apart
        on purpose: difficulty is {label}&rsquo;s 0&ndash;100 estimate of your
        chance of a top-ten place, while ad competition is how contested the
        keyword is in Google Ads.{' '}
        <span style={{ color: toneColor('neutral') }}>
          Volume is a twelve-month rolling average, which is why this panel is
          collected monthly rather than weekly.
        </span>
      </p>
    </div>
  );
};

export default KeywordResearchScreen;
