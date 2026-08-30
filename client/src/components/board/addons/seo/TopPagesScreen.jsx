import { useMemo, useState } from 'react';
import { ExternalLink, FileText } from 'lucide-react';

import EmptyState from '../../../ui/EmptyState';
import Pagination from '../../../ui/Pagination';
import SortableTh from '../../../ui/SortableTh';
import { ScrollTable, Stat, StatRow, Td, Th } from '../connector/SectionShell';
import { formatMoney, formatNumber } from '../../../../utils/connectorFormat';
import { paginate } from '../../../../utils/rankRows';
import {
  filterPageRows,
  isKindCollected,
  labsFreshness,
  pageRowsFrom,
  sortPageRows,
} from '../../../../utils/labsRows';
import { downloadLabsExport } from '../../../../utils/labsExport';
import { BucketBar, IndexStamp, LabsFilterBar, NotCollected } from './LabsBits';

/**
 * Top pages — which URLs on this site actually carry its rankings.
 *
 * ---- The question it answers that the rank table cannot -------------------
 *
 * Rank tracking is keyword-first: two hundred keywords, one row each, and the
 * page that ranks is a column. This is the same data seen page-first, and it is
 * the view that answers "what should we work on" — because effort is spent on
 * PAGES. One URL holding sixty keywords and most of the site's estimated traffic
 * value is the page whose refresh is worth a week; forty URLs holding one
 * keyword each are a content-consolidation problem.
 *
 * It comes from `relevant_pages`, which is the per-URL version of the domain
 * overview: an address, the twelve-bucket position ladder, and an estimated
 * traffic value.
 *
 * ---- Why "estimated traffic value" is never called "traffic" ---------------
 *
 * `etv` is DataForSEO's MODEL: positions multiplied by their volume estimates
 * multiplied by a click-through curve. It is not measured traffic, nobody's
 * analytics will agree with it, and a column headed "traffic" on a client report
 * invites exactly that comparison. It is useful for RANKING pages against each
 * other and misleading as an absolute, so the label says estimate everywhere it
 * appears — on screen, in the CSV header and in the PDF.
 *
 * ---- And why the ladder is a bar rather than twelve columns ---------------
 *
 * Twelve numeric columns is a table nobody reads. The distinction that matters
 * is top-three, top-ten, and everything else — beyond that "it is on the page
 * somewhere" is one fact, not nine. The bar carries the whole ladder in its
 * tooltip for the person who wants it.
 */

const PAGE_SIZES = [25, 50, 100];

const COLUMNS = [
  { key: 'url', label: 'Page', sortKey: 'url', align: 'left' },
  { key: 'keywords', label: 'Keywords', sortKey: 'keywords', align: 'right', width: 100 },
  { key: 'top10', label: 'In top 10', sortKey: 'top10', align: 'right', width: 100 },
  { key: 'buckets', label: 'Position profile', align: 'left', width: 150 },
  {
    key: 'etv',
    label: 'Est. traffic value',
    sortKey: 'etv',
    align: 'right',
    width: 140,
  },
];

const TopPagesScreen = ({ data, label }) => {
  const snapshot = data?.snapshots?.top_pages || null;
  const collected = isKindCollected(data, 'top_pages');
  const freshness = labsFreshness(snapshot);

  const [sort, setSort] = useState({ key: 'etv', dir: 'desc' });
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const allRows = useMemo(() => pageRowsFrom(snapshot), [snapshot]);
  const filtered = useMemo(() => filterPageRows(allRows, { query }), [allRows, query]);
  const sorted = useMemo(() => sortPageRows(filtered, sort), [filtered, sort]);
  const view = useMemo(() => paginate(sorted, { page, pageSize }), [sorted, page, pageSize]);

  const totals = useMemo(() => {
    const withEtv = filtered.filter((r) => typeof r.etv === 'number');
    const withKeywords = filtered.filter((r) => typeof r.keywords === 'number');
    return {
      pages: filtered.length,
      // Null rather than 0 when nothing carried the field: "these pages have no
      // value" and "we could not read the value" are opposite facts.
      etv: withEtv.length ? withEtv.reduce((s, r) => s + r.etv, 0) : null,
      keywords: withKeywords.length
        ? withKeywords.reduce((s, r) => s + r.keywords, 0)
        : null,
      /**
       * How much of the estimated value sits on the single best page. The
       * concentration number is the one that turns this table into a decision:
       * 70% on one URL is a different site from 8% each across a dozen.
       */
      concentration:
        withEtv.length && withEtv.reduce((s, r) => s + r.etv, 0) > 0
          ? Math.round(
              (Math.max(...withEtv.map((r) => r.etv)) /
                withEtv.reduce((s, r) => s + r.etv, 0)) *
                100
            )
          : null,
    };
  }, [filtered]);

  const runExport = (format) =>
    downloadLabsExport(
      {
        siteName: data.project?.name || data.project?.domain || 'Site',
        domain: data.project?.domain || '',
        variant: snapshot?.variant || data.variant,
        periodKey: snapshot?.periodKey || '',
        collectedAt: freshness.collectedAt,
        indexUpdatedAt: freshness.indexUpdatedAt,
        rows: sorted,
        filtered: filtered.length !== allRows.length,
      },
      'pages',
      format
    );

  if (!snapshot) {
    return (
      <div className="flex flex-col gap-4">
        {!collected && <NotCollected label={label} what="Top pages" />}
        <EmptyState
          icon={FileText}
          title="No page data collected yet"
          description={
            collected
              ? 'This fills in on the next weekly run. Nothing is bought when you open this tab.'
              : 'Nothing is being collected for this panel.'
          }
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <IndexStamp freshness={freshness} label={label} />
      {!collected && <NotCollected label={label} what="Top pages" />}

      <section
        style={{
          background: 'var(--color-bg-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-lg)',
          overflow: 'hidden',
        }}
      >
        <StatRow>
          <Stat label="Pages" value={formatNumber(totals.pages)} sub="with rankings" />
          <Stat
            label="Keywords across them"
            value={formatNumber(totals.keywords, { compact: true })}
            sub="counted per page, so a keyword can appear twice"
          />
          <Stat
            label="Estimated traffic value"
            value={formatMoney(totals.etv)}
            // Said plainly, because somebody will compare it to analytics.
            sub={`${label}'s model, not measured traffic`}
          />
          <Stat
            label="On the best page"
            value={totals.concentration === null ? '—' : `${totals.concentration}%`}
            sub="share of the estimated value"
          />
        </StatRow>
      </section>

      <LabsFilterBar
        query={query}
        onQuery={(v) => {
          setQuery(v);
          setPage(1);
        }}
        placeholder="Find a page"
        onExport={runExport}
      />

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
              {view.rows.length === 0 ? (
                <tr>
                  <td colSpan={COLUMNS.length}>
                    <p
                      className="font-body text-center px-4 py-8"
                      style={{ fontSize: 13, color: 'var(--color-text-muted)' }}
                    >
                      No page matches that search.
                    </p>
                  </td>
                </tr>
              ) : (
                view.rows.map((row) => (
                  <tr key={row.url}>
                    <Td title={row.url}>
                      <a
                        href={row.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 truncate"
                        style={{
                          maxWidth: 380,
                          color: 'var(--color-text-primary)',
                          textDecoration: 'none',
                        }}
                      >
                        <span className="truncate">{row.path}</span>
                        <ExternalLink size={11} className="shrink-0" aria-hidden="true" />
                      </a>
                    </Td>
                    <Td align="right">{formatNumber(row.keywords)}</Td>
                    <Td align="right">{formatNumber(row.top10)}</Td>
                    <Td>
                      <BucketBar buckets={row.buckets} />
                    </Td>
                    <Td align="right">{formatMoney(row.etv)}</Td>
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
          noun="pages"
          pageSizes={PAGE_SIZES}
          pageSize={pageSize}
          onPageSize={(next) => {
            setPageSize(next);
            setPage(1);
          }}
        />
      </section>

      <p className="font-body" style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>
        Estimated traffic value is {label}&rsquo;s model — positions multiplied
        by their own volume estimates and a click-through curve — not measured
        traffic. It is useful for ranking these pages against each other and
        should not be expected to match analytics.
      </p>
    </div>
  );
};

export default TopPagesScreen;
