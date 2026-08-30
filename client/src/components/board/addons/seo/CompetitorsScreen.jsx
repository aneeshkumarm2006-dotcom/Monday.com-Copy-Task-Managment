import { useMemo, useState } from 'react';
import { ExternalLink, Swords } from 'lucide-react';

import EmptyState from '../../../ui/EmptyState';
import Pagination from '../../../ui/Pagination';
import SortableTh from '../../../ui/SortableTh';
import { SegmentedControl } from '../../../ui/FormControls';
import { ScrollTable, Stat, StatRow, Td, Th } from '../connector/SectionShell';
import { formatMoney, formatNumber } from '../../../../utils/connectorFormat';
import { paginate } from '../../../../utils/rankRows';
import {
  GAP_BUCKETS,
  competitorRowsFrom,
  filterCompetitorRows,
  filterGapRows,
  gapComparisonsFrom,
  gapRowsFrom,
  isKindCollected,
  labsFreshness,
  sortCompetitorRows,
  sortGapRows,
} from '../../../../utils/labsRows';
import { downloadLabsExport } from '../../../../utils/labsExport';
import {
  CountChip,
  DifficultyPill,
  IndexStamp,
  LabsFilterBar,
  NotCollected,
} from './LabsBits';

/**
 * Competitors & gap — the two panels that generate work.
 *
 * ---- Why they are one screen ------------------------------------------------
 *
 * They are two purchases and two snapshot kinds, and they are one question: who
 * else is on these SERPs, and what are they winning that we are not. A
 * competitor table with no gap beneath it is a list of names; a gap table with
 * no competitor table above it is a list of keywords whose relevance nobody can
 * judge. So the discovery panel sits on top, choosing a competitor scrolls to
 * its gap, and the nav gains one entry instead of two.
 *
 * ---- The distinction the top table exists to make --------------------------
 *
 * `competitors_domain` returns TWO PARALLEL METRIC TREES with the same shape,
 * and merging them is the single easiest way to make this panel useless:
 *
 *   SHARED  (`metrics`)             — only the keywords they hold in common with
 *                                     us. "Does this domain compete with me?"
 *   ALL THEIRS (`full_domain_metrics`) — everything they rank for anywhere.
 *                                     "Is this a big site?"
 *
 * Wikipedia shares keywords with everybody and competes with nobody. Shown as
 * one "keywords" column it is the top competitor of every client we have; shown
 * as two, the overlap column says 0% and the reader can see why.
 *
 * ---- And the one the bottom table exists to make ---------------------------
 *
 * A GAP IS A STATEMENT ABOUT A PAIR OF DOMAINS. The snapshot stores one
 * comparison per competitor and this screen renders one at a time, because
 * flattening three competitors into one table gives a keyword three rows with
 * three different "their rank" values and no column saying whose.
 *
 * The "our rank" column is empty by construction — `domain_intersection` is
 * requested with `intersections: false`, which IS the gap report. It is shown
 * anyway so the table cannot be mistaken for a side-by-side comparison that is
 * missing our half.
 */

const PAGE_SIZES = [25, 50, 100];

const COMPETITOR_COLUMNS = [
  { key: 'domain', label: 'Domain', sortKey: 'domain', align: 'left' },
  {
    key: 'intersections',
    label: 'Shared keywords',
    sortKey: 'intersections',
    align: 'right',
    width: 130,
  },
  {
    key: 'overlap',
    label: 'Overlap',
    sortKey: 'overlap',
    align: 'right',
    width: 90,
  },
  {
    key: 'avgPosition',
    label: 'Their avg position',
    sortKey: 'avgPosition',
    align: 'right',
    width: 140,
  },
  {
    key: 'sharedEtv',
    label: 'Shared traffic value',
    sortKey: 'sharedEtv',
    align: 'right',
    width: 150,
  },
  {
    key: 'fullKeywords',
    label: 'All their keywords',
    sortKey: 'fullKeywords',
    align: 'right',
    width: 145,
  },
  {
    key: 'fullEtv',
    label: 'All their traffic value',
    sortKey: 'fullEtv',
    align: 'right',
    width: 160,
  },
];

const GAP_COLUMNS = [
  { key: 'keyword', label: 'Keyword', sortKey: 'keyword', align: 'left' },
  { key: 'searchVolume', label: 'Volume', sortKey: 'searchVolume', align: 'right', width: 92 },
  {
    key: 'keywordDifficulty',
    label: 'Difficulty',
    sortKey: 'keywordDifficulty',
    align: 'right',
    width: 90,
  },
  {
    key: 'competitorRank',
    label: 'Their rank',
    sortKey: 'competitorRank',
    align: 'right',
    width: 96,
  },
  { key: 'ourRank', label: 'Our rank', align: 'right', width: 90 },
  { key: 'competitorUrl', label: 'Their page', align: 'left' },
];

const Panel = ({ children }) => (
  <section
    style={{
      background: 'var(--color-bg-surface)',
      border: '1px solid var(--color-border)',
      borderRadius: 'var(--radius-lg)',
      overflow: 'hidden',
    }}
  >
    {children}
  </section>
);

const PanelHeader = ({ title, sub }) => (
  <header className="px-4 py-3" style={{ borderBottom: '1px solid var(--color-border)' }}>
    <h3
      className="font-body font-medium"
      style={{
        fontSize: 11,
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        color: 'var(--color-text-secondary)',
      }}
    >
      {title}
    </h3>
    {sub ? (
      <p className="font-body mt-1" style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
        {sub}
      </p>
    ) : null}
  </header>
);

const CompetitorsScreen = ({ data, label }) => {
  const competitorSnapshot = data?.snapshots?.competitors || null;
  const gapSnapshot = data?.snapshots?.keyword_gap || null;

  const competitorsCollected = isKindCollected(data, 'competitors');
  const gapCollected = isKindCollected(data, 'keyword_gap');

  // Whichever panel has a reading carries the stamp; they are bought on the same
  // weekly cadence out of the same index, so either date describes both.
  const freshness = labsFreshness(competitorSnapshot || gapSnapshot);

  const [compSort, setCompSort] = useState({ key: 'intersections', dir: 'desc' });
  const [compQuery, setCompQuery] = useState('');
  const [compPage, setCompPage] = useState(1);

  const [gapSort, setGapSort] = useState({ key: 'searchVolume', dir: 'desc' });
  const [gapQuery, setGapQuery] = useState('');
  const [gapBuckets, setGapBuckets] = useState([]);
  const [gapPage, setGapPage] = useState(1);
  const [gapPageSize, setGapPageSize] = useState(25);
  const [chosen, setChosen] = useState('');

  const competitorRows = useMemo(
    () => competitorRowsFrom(competitorSnapshot),
    [competitorSnapshot]
  );
  const competitorView = useMemo(() => {
    const filtered = filterCompetitorRows(competitorRows, { query: compQuery });
    return paginate(sortCompetitorRows(filtered, compSort), {
      page: compPage,
      pageSize: 25,
    });
  }, [competitorRows, compQuery, compSort, compPage]);

  const comparisons = useMemo(() => gapComparisonsFrom(gapSnapshot), [gapSnapshot]);

  /**
   * The comparison on screen. A stored choice that no longer exists — a
   * competitor removed from the Site since the last collection — falls back to
   * the first rather than rendering a blank panel.
   */
  const comparison =
    comparisons.find((c) => c.competitor === chosen) || comparisons[0] || null;

  const gapAll = useMemo(() => gapRowsFrom(comparison), [comparison]);
  const gapFiltered = useMemo(
    () => filterGapRows(gapAll, { query: gapQuery, buckets: gapBuckets }),
    [gapAll, gapQuery, gapBuckets]
  );
  const gapSorted = useMemo(() => sortGapRows(gapFiltered, gapSort), [gapFiltered, gapSort]);
  const gapView = useMemo(
    () => paginate(gapSorted, { page: gapPage, pageSize: gapPageSize }),
    [gapSorted, gapPage, gapPageSize]
  );

  const exportMeta = () => ({
    siteName: data.project?.name || data.project?.domain || 'Site',
    domain: data.project?.domain || '',
    variant: competitorSnapshot?.variant || gapSnapshot?.variant || data.variant,
    collectedAt: freshness.collectedAt,
    indexUpdatedAt: freshness.indexUpdatedAt,
  });

  const exportCompetitors = (format) =>
    downloadLabsExport(
      {
        ...exportMeta(),
        periodKey: competitorSnapshot?.periodKey || '',
        rows: sortCompetitorRows(
          filterCompetitorRows(competitorRows, { query: compQuery }),
          compSort
        ),
        filtered: !!compQuery,
      },
      'competitors',
      format
    );

  const exportGap = (format) =>
    downloadLabsExport(
      {
        ...exportMeta(),
        periodKey: gapSnapshot?.periodKey || '',
        // Named in the subtitle, because a gap file with no competitor on it is
        // a list of keywords nobody can attribute.
        subject: comparison?.competitor || '',
        rows: gapSorted,
        filtered: gapFiltered.length !== gapAll.length,
      },
      'gap',
      format
    );

  if (!competitorSnapshot && !gapSnapshot) {
    return (
      <div className="flex flex-col gap-4">
        {!competitorsCollected && <NotCollected label={label} what="Competitors" />}
        {!gapCollected && <NotCollected label={label} what="Keyword gap" />}
        <EmptyState
          icon={Swords}
          title="No competitive data collected yet"
          description={
            competitorsCollected || gapCollected
              ? `This fills in the next time the schedule runs. A keyword gap also needs at least one competitor on the site — add them under Add-ons. Nothing is bought when you open this tab.`
              : 'Nothing is being collected for this screen.'
          }
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <IndexStamp freshness={freshness} label={label} />

      {/* ---- Discovery ------------------------------------------------------- */}
      {!competitorsCollected && <NotCollected label={label} what="Competitors" />}

      {competitorSnapshot && (
        <>
          <LabsFilterBar
            query={compQuery}
            onQuery={(v) => {
              setCompQuery(v);
              setCompPage(1);
            }}
            placeholder="Find a domain"
            onExport={exportCompetitors}
          />

          <Panel>
            <PanelHeader
              title="Who else owns these SERPs"
              sub={
                <>
                  <strong>Shared</strong> is only the keywords they hold in common
                  with {data.project?.domain || 'this site'} — that is whether they
                  compete with you. <strong>All theirs</strong> is everything they
                  rank for anywhere — that is only whether they are a big site.
                </>
              }
            />
            <ScrollTable maxHeight={420}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    {COMPETITOR_COLUMNS.map((col) => (
                      <SortableTh
                        key={col.key}
                        column={col.sortKey}
                        sort={compSort}
                        onSort={(next) => {
                          setCompSort(next);
                          setCompPage(1);
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
                  {competitorView.rows.length === 0 ? (
                    <tr>
                      <td colSpan={COMPETITOR_COLUMNS.length}>
                        <p
                          className="font-body text-center px-4 py-8"
                          style={{ fontSize: 13, color: 'var(--color-text-muted)' }}
                        >
                          No domain matches that search.
                        </p>
                      </td>
                    </tr>
                  ) : (
                    competitorView.rows.map((row) => {
                      const hasGap = comparisons.some((c) => c.competitor === row.domain);
                      return (
                        <tr key={row.domain}>
                          <Td title={row.domain}>
                            {hasGap ? (
                              <button
                                type="button"
                                onClick={() => {
                                  setChosen(row.domain);
                                  setGapPage(1);
                                }}
                                className="font-body text-left truncate"
                                style={{
                                  maxWidth: 280,
                                  fontSize: 13,
                                  background: 'none',
                                  border: 'none',
                                  padding: 0,
                                  color:
                                    comparison?.competitor === row.domain
                                      ? 'var(--color-accent)'
                                      : 'var(--color-text-primary)',
                                  fontWeight:
                                    comparison?.competitor === row.domain ? 600 : 400,
                                  cursor: 'pointer',
                                }}
                                title={`Show the keyword gap against ${row.domain}`}
                              >
                                {row.domain}
                              </button>
                            ) : (
                              <span
                                className="truncate"
                                style={{ display: 'inline-block', maxWidth: 280 }}
                              >
                                {row.domain}
                              </span>
                            )}
                          </Td>
                          <Td align="right">{formatNumber(row.intersections)}</Td>
                          <Td
                            align="right"
                            muted
                            title="How much of everything they rank for overlaps with this site"
                          >
                            {typeof row.overlap === 'number'
                              ? `${Math.round(row.overlap * 100)}%`
                              : '—'}
                          </Td>
                          <Td align="right" muted>
                            {typeof row.avgPosition === 'number'
                              ? `#${Math.round(row.avgPosition * 10) / 10}`
                              : '—'}
                          </Td>
                          <Td align="right">{formatMoney(row.sharedEtv)}</Td>
                          <Td align="right" muted>
                            {formatNumber(row.fullKeywords, { compact: true })}
                          </Td>
                          <Td align="right" muted>
                            {formatMoney(row.fullEtv)}
                          </Td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </ScrollTable>
            <Pagination
              page={competitorView.page}
              pageCount={competitorView.pageCount}
              from={competitorView.from}
              to={competitorView.to}
              total={competitorView.total}
              onPage={setCompPage}
              noun="domains"
            />
          </Panel>
        </>
      )}

      {/* ---- The gap --------------------------------------------------------- */}
      {!gapCollected && <NotCollected label={label} what="Keyword gap" />}

      {gapSnapshot && comparison && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            {comparisons.length > 1 && (
              <SegmentedControl
                options={comparisons.map((c) => ({
                  value: c.competitor,
                  label: c.competitor,
                }))}
                value={comparison.competitor}
                onChange={(next) => {
                  setChosen(next);
                  setGapPage(1);
                }}
              />
            )}
            <CountChip>{formatNumber(comparison.missing)} keywords missing</CountChip>
            <CountChip>
              {formatNumber(comparison.volumeAtStake, { compact: true })} monthly
              searches at stake
            </CountChip>
            {typeof comparison.inTheirTop10 === 'number' && (
              <CountChip>{formatNumber(comparison.inTheirTop10)} in their top 10</CountChip>
            )}
          </div>

          <Panel>
            <PanelHeader
              title={`Keywords ${comparison.competitor} ranks for and ${
                data.project?.domain || 'this site'
              } does not`}
              sub="Ordered by search volume. Our rank is empty by construction — this report is the keywords we are absent from."
            />
            <div className="px-4 pt-3">
              <LabsFilterBar
                query={gapQuery}
                onQuery={(v) => {
                  setGapQuery(v);
                  setGapPage(1);
                }}
                placeholder="Find a keyword"
                buckets={GAP_BUCKETS}
                active={gapBuckets}
                onToggle={(key) => {
                  setGapBuckets((prev) =>
                    prev.includes(key) ? prev.filter((b) => b !== key) : [...prev, key]
                  );
                  setGapPage(1);
                }}
                onClear={() => {
                  setGapBuckets([]);
                  setGapPage(1);
                }}
                onExport={exportGap}
              />
            </div>
            <div style={{ height: 12 }} />
            <ScrollTable maxHeight={520}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    {GAP_COLUMNS.map((col) =>
                      col.sortKey ? (
                        <SortableTh
                          key={col.key}
                          column={col.sortKey}
                          sort={gapSort}
                          onSort={(next) => {
                            setGapSort(next);
                            setGapPage(1);
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
                  {gapView.rows.length === 0 ? (
                    <tr>
                      <td colSpan={GAP_COLUMNS.length}>
                        <p
                          className="font-body text-center px-4 py-8"
                          style={{ fontSize: 13, color: 'var(--color-text-muted)' }}
                        >
                          No keyword matches that filter.
                        </p>
                      </td>
                    </tr>
                  ) : (
                    gapView.rows.map((row) => (
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
                        <Td align="right">
                          <DifficultyPill value={row.keywordDifficulty} band={row.band} />
                        </Td>
                        <Td align="right">
                          {typeof row.competitorRank === 'number'
                            ? `#${row.competitorRank}`
                            : '—'}
                        </Td>
                        <Td align="right" muted title="This report is the keywords we do not rank for">
                          {typeof row.ourRank === 'number' ? `#${row.ourRank}` : '—'}
                        </Td>
                        <Td muted title={row.competitorUrl || ''}>
                          {row.competitorUrl ? (
                            <a
                              href={row.competitorUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 truncate"
                              style={{
                                maxWidth: 280,
                                color: 'var(--color-accent)',
                                textDecoration: 'none',
                              }}
                            >
                              <span className="truncate">{row.competitorUrl}</span>
                              <ExternalLink size={11} className="shrink-0" aria-hidden="true" />
                            </a>
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
              page={gapView.page}
              pageCount={gapView.pageCount}
              from={gapView.from}
              to={gapView.to}
              total={gapView.total}
              onPage={setGapPage}
              noun="keywords"
              pageSizes={PAGE_SIZES}
              pageSize={gapPageSize}
              onPageSize={(next) => {
                setGapPageSize(next);
                setGapPage(1);
              }}
            />
          </Panel>
        </>
      )}

      {gapCollected && !gapSnapshot && (
        <Panel>
          <PanelHeader title="Keyword gap" />
          <div className="px-4 py-6">
            <EmptyState
              icon={Swords}
              title="No gap collected yet"
              description="A keyword gap compares this site against a competitor, so it needs at least one competitor listed on the site. Add them under Add-ons and it is collected on the next weekly run."
            />
          </div>
        </Panel>
      )}

      {competitorSnapshot && (
        <StatRow>
          <Stat
            label="Domains found"
            value={formatNumber(competitorRows.length)}
            sub="sharing SERPs with this site"
          />
          <Stat
            label="Closest overlap"
            value={competitorRows[0]?.domain || '—'}
            sub={
              typeof competitorRows[0]?.intersections === 'number'
                ? `${formatNumber(competitorRows[0].intersections)} shared keywords`
                : 'no shared count reported'
            }
          />
          <Stat
            label="Gaps collected"
            value={formatNumber(comparisons.length)}
            sub="one per tracked competitor"
          />
        </StatRow>
      )}
    </div>
  );
};

export default CompetitorsScreen;
