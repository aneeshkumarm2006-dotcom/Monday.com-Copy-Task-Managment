import { useMemo, useState } from 'react';
import { Gauge } from 'lucide-react';

import EmptyState from '../../../ui/EmptyState';
import Pagination from '../../../ui/Pagination';
import SortableTh from '../../../ui/SortableTh';
import { ScrollTable, Stat, StatRow, Td } from '../connector/SectionShell';
import { formatDay, formatNumber } from '../../../../utils/connectorFormat';
import { paginate } from '../../../../utils/rankRows';
import {
  ISSUE_BUCKETS,
  PAGE_BUCKETS,
  VITALS_CAPTION,
  auditFreshness,
  auditFrom,
  comparability,
  deltaOf,
  filterIssueRows,
  filterPageRows,
  isKindCollected,
  issueCaption,
  issueRowsFrom,
  pageRowsFrom,
  severityLabel,
  sortIssueRows,
  sortPageRows,
  vitalsFrom,
} from '../../../../utils/auditRows';
import { downloadLabsExport } from '../../../../utils/labsExport';
import { CountChip, CrawlStamp, LabsFilterBar, NotCollected } from './LabsBits';

/**
 * Site audit — the technical deliverable, and the two numbers on it that would
 * be wrong in a way nobody could see.
 *
 * ---- 1. TEN OF THE CHECK COUNTERS COUNT SUCCESSES --------------------------
 *
 * `canonical`, `is_https`, `has_html_doctype`, `has_meta_title`,
 * `meta_charset_consistency` and the five `seo_friendly_url_*` counters are
 * counts of pages that PASS. The issue count is `pagesCrawled − counter`, and
 * read the obvious way a site where every page is on HTTPS reports "120 pages
 * with an HTTPS problem" at the top of a list sorted by severity.
 *
 * The inversion is not done anywhere in this component, or anywhere on the
 * client at all — it happens once, on the server, in `onpageChecks.issueCountFor`.
 * What this screen adds is the caption that makes it CHECKABLE: for a positive
 * counter the row prints "96 of 120 pages pass this check" underneath the 24, so
 * a reader can see the subtraction rather than having to trust it.
 *
 * ---- 2. `onpage_score` IS SAMPLE-SIZE DEPENDENT ----------------------------
 *
 * DataForSEO say so: the domain score normalises each issue by `N / Ntotal`. So
 * a score of 82 over 120 pages and a score of 74 over 900 are not two points on
 * a line, and the issue counts are worse because they are absolute — a crawl ten
 * times larger finds roughly ten times as many of everything.
 *
 * `comparability` is asked BEFORE any subtraction and its answer is a sentence,
 * so the panel says why there is no movement figure instead of quietly omitting
 * one. `deltaOf` returns null when it says no, which is what makes the refusal
 * impossible to route around.
 *
 * ---- 3. THE VITALS ARE LAB DATA, THERE IS NO INP, AND FID IS RETIRED -------
 *
 * There is no CrUX and no field data anywhere in this API. INP replaced FID as a
 * Core Web Vital in March 2024 and does not exist here in any form. And all
 * three read 0 without browser rendering, which costs 34x and is never enabled —
 * so the panel says the numbers are not measurements rather than showing a
 * perfect CLS of zero awarded for not looking.
 */

const PAGE_SIZES = [25, 50, 100];

const ISSUE_COLUMNS = [
  { key: 'label', label: 'Issue', sortKey: 'label', align: 'left' },
  {
    key: 'severity',
    label: 'Severity',
    sortKey: 'severity',
    align: 'left',
    width: 110,
  },
  {
    key: 'pages',
    label: 'Pages affected',
    sortKey: 'pages',
    align: 'right',
    width: 130,
    title:
      'How many crawled pages have this problem. For the checks that count passes rather than failures, this is the crawl size minus the counter — the row says which those are.',
  },
  { key: 'share', label: 'Share of site', sortKey: 'share', align: 'right', width: 120 },
  {
    key: 'impact',
    label: 'Score impact',
    sortKey: 'impact',
    align: 'right',
    width: 120,
    title:
      'Weight × the share of pages affected — the ordering that matches what actually moves the score, so a handful of broken canonicals outranks three hundred cosmetic notices. It is an ordering, not a score.',
  },
];

const PAGE_COLUMNS = [
  { key: 'path', label: 'Page', sortKey: 'path', align: 'left' },
  { key: 'statusCode', label: 'Status', sortKey: 'statusCode', align: 'right', width: 90 },
  {
    key: 'onpageScore',
    label: 'Page score',
    sortKey: 'onpageScore',
    align: 'right',
    width: 110,
  },
  {
    key: 'failingCount',
    label: 'Failing checks',
    sortKey: 'failingCount',
    align: 'right',
    width: 130,
  },
  { key: 'clickDepth', label: 'Clicks deep', sortKey: 'clickDepth', align: 'right', width: 120 },
  {
    key: 'inboundLinks',
    label: 'Internal links in',
    sortKey: 'inboundLinks',
    align: 'right',
    width: 140,
  },
];

const percent = (value) =>
  typeof value === 'number' ? `${Math.round(value * 100)}%` : '—';

/** A signed count, so a caption reads "+4" rather than "4". */
const signed = (value) =>
  typeof value !== 'number' ? '—' : `${value > 0 ? '+' : ''}${formatNumber(value)}`;

const toneOf = (tone) =>
  tone === 'positive'
    ? 'var(--color-card-green)'
    : tone === 'negative'
      ? '#DC2626'
      : 'var(--color-text-secondary)';

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

const PanelHead = ({ title, sub, right }) => (
  <header
    className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3"
    style={{ borderBottom: '1px solid var(--color-border)' }}
  >
    <h4
      className="font-display font-semibold"
      style={{ fontSize: 14, color: 'var(--color-text-primary)' }}
    >
      {title}
    </h4>
    {sub ? (
      <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
        {sub}
      </p>
    ) : null}
    <div className="flex-1" />
    {right}
  </header>
);

/** One site-wide fact from `domain_info`, as a labelled line. */
const Fact = ({ label, value, title }) => (
  <div className="flex items-baseline gap-2 min-w-0" title={title}>
    <span
      className="font-body shrink-0"
      style={{ fontSize: 11.5, color: 'var(--color-text-muted)', minWidth: 108 }}
    >
      {label}
    </span>
    <span
      className="font-body truncate"
      style={{ fontSize: 12.5, color: 'var(--color-text-primary)' }}
    >
      {value ?? '—'}
    </span>
  </div>
);

const SiteAuditScreen = ({ data, label }) => {
  const snapshot = data?.snapshots?.site_audit || null;
  const previous = data?.previousSnapshots?.site_audit || null;

  const freshness = auditFreshness(snapshot);
  const audit = useMemo(() => auditFrom(snapshot), [snapshot]);
  const vitals = useMemo(() => vitalsFrom(snapshot), [snapshot]);

  const allIssues = useMemo(() => issueRowsFrom(snapshot), [snapshot]);
  const allPages = useMemo(() => pageRowsFrom(snapshot), [snapshot]);

  const [issueSort, setIssueSort] = useState({ key: 'impact', dir: 'desc' });
  const [issueQuery, setIssueQuery] = useState('');
  const [issueBuckets, setIssueBuckets] = useState([]);
  const [issuePage, setIssuePage] = useState(1);
  const [issuePageSize, setIssuePageSize] = useState(25);

  const [pageSort, setPageSort] = useState({ key: 'onpageScore', dir: 'asc' });
  const [pageQuery, setPageQuery] = useState('');
  const [pageBuckets, setPageBuckets] = useState([]);
  const [pagePage, setPagePage] = useState(1);
  const [pagePageSize, setPagePageSize] = useState(25);

  const filteredIssues = useMemo(
    () => filterIssueRows(allIssues, { query: issueQuery, buckets: issueBuckets }),
    [allIssues, issueQuery, issueBuckets]
  );
  const sortedIssues = useMemo(
    () => sortIssueRows(filteredIssues, issueSort),
    [filteredIssues, issueSort]
  );
  const issueView = useMemo(
    () => paginate(sortedIssues, { page: issuePage, pageSize: issuePageSize }),
    [sortedIssues, issuePage, issuePageSize]
  );

  const filteredPages = useMemo(
    () => filterPageRows(allPages, { query: pageQuery, buckets: pageBuckets }),
    [allPages, pageQuery, pageBuckets]
  );
  const sortedPages = useMemo(
    () => sortPageRows(filteredPages, pageSort),
    [filteredPages, pageSort]
  );
  const pageView = useMemo(
    () => paginate(sortedPages, { page: pagePage, pageSize: pagePageSize }),
    [sortedPages, pagePage, pagePageSize]
  );

  /**
   * The movement caption, and the one place the sample-size trap actually bites.
   *
   * `comparability` is asked BEFORE any subtraction, and its answer is a
   * sentence rather than a boolean so the panel can say why there is no number
   * instead of quietly omitting one.
   */
  const compare = comparability(snapshot?.data, previous?.data);
  const movement = {
    score: deltaOf(snapshot?.data, previous?.data, (d) => d?.totals?.onpageScore ?? null),
    errors: deltaOf(snapshot?.data, previous?.data, (d) => d?.issueTotals?.error?.pages ?? null),
    warnings: deltaOf(
      snapshot?.data,
      previous?.data,
      (d) => d?.issueTotals?.warning?.pages ?? null
    ),
  };

  const exportPayload = (rows, filtered) => ({
    siteName: data.project?.name || data.project?.domain || 'Site',
    domain: data.project?.domain || '',
    variant: snapshot?.variant || data.variant,
    periodKey: snapshot?.periodKey || '',
    collectedAt: snapshot?.collectedAt || snapshot?.fetchedAt || null,
    /** THE CRAWL SIZE, in every exported row. See `labsExport`'s context columns. */
    pagesCrawled: freshness.pagesCrawled,
    maxCrawlPages: freshness.maxCrawlPages,
    rows,
    filtered,
  });

  if (!snapshot) {
    const collected = isKindCollected(data, 'site_audit');
    return (
      <div className="flex flex-col gap-4">
        {!collected && <NotCollected label={label} what="The site audit" />}
        <EmptyState
          icon={Gauge}
          title="No crawl collected yet"
          description={
            collected
              ? 'A crawl is ordered on the monthly run and lands here on its own — it can take a few hours on a large site. Nothing is bought when you open this tab.'
              : 'Nothing is being collected for this screen.'
          }
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <CrawlStamp freshness={freshness} label={label} />

      {!isKindCollected(data, 'site_audit') && (
        <NotCollected label={label} what="The site audit" />
      )}

      {/* ---- The health hero -------------------------------------------------- */}
      {audit && (
        <Panel>
          <StatRow>
            <Stat
              label="Health score"
              value={
                typeof audit.onpageScore === 'number' ? String(audit.onpageScore) : '—'
              }
              /**
               * The movement only when the two readings are comparable. A score
               * computed over 120 pages and one computed over 900 differ because
               * of the crawl, and the difference would read as the site changing.
               */
              sub={
                compare.ok
                  ? `${signed(movement.score)} since the last crawl`
                  : audit.scoreBand?.label || "DataForSEO's own score, 0–100"
              }
            />
            <Stat
              label="Pages crawled"
              value={formatNumber(audit.pagesCrawled)}
              sub={
                typeof audit.maxCrawlPages === 'number'
                  ? `of up to ${formatNumber(audit.maxCrawlPages)} asked for`
                  : 'in this crawl'
              }
            />
            <Stat
              label="Errors"
              value={formatNumber(audit.errors.pages)}
              sub={
                compare.ok
                  ? `${signed(movement.errors)} · ${audit.errors.findings} kinds`
                  : `${audit.errors.findings} kind${audit.errors.findings === 1 ? '' : 's'} of problem`
              }
            />
            <Stat
              label="Warnings"
              value={formatNumber(audit.warnings.pages)}
              sub={
                compare.ok
                  ? `${signed(movement.warnings)} · ${audit.warnings.findings} kinds`
                  : `${audit.warnings.findings} kind${audit.warnings.findings === 1 ? '' : 's'} of problem`
              }
            />
            <Stat
              label="Notices"
              value={formatNumber(audit.notices.pages)}
              sub={`${audit.notices.findings} kind${audit.notices.findings === 1 ? '' : 's'} · no effect on the score`}
            />
            <Stat
              label="Broken"
              value={formatNumber(audit.brokenLinks)}
              sub={`links · ${formatNumber(audit.brokenResources)} resources`}
            />
          </StatRow>

          <div className="px-4 pb-4">
            <p className="font-body" style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>
              {`${label}'s own health score, computed as a share of the pages crawled — so it moves with the crawl size as well as with the site.`}
            </p>
            {!compare.ok && compare.reason ? (
              <p
                className="font-body mt-1.5"
                style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}
              >
                {compare.reason}
              </p>
            ) : null}
          </div>
        </Panel>
      )}

      {/* ---- The host itself -------------------------------------------------- */}
      {audit?.domainInfo && (
        <Panel>
          <PanelHead
            title="The host"
            sub="one answer for the whole site, from the same crawl"
          />
          <div
            className="grid gap-x-6 gap-y-2 px-4 py-4"
            style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}
          >
            <Fact label="Platform" value={audit.domainInfo.cms} />
            <Fact label="Server" value={audit.domainInfo.server} />
            <Fact label="IP" value={audit.domainInfo.ip} />
            <Fact
              label="Certificate"
              value={
                audit.domainInfo.ssl?.valid === null
                  ? '—'
                  : audit.domainInfo.ssl?.valid
                    ? `valid to ${formatDay(audit.domainInfo.ssl.expiresAt)}`
                    : 'not valid'
              }
              title={audit.domainInfo.ssl?.issuer || ''}
            />
            <Fact
              label="Missing page"
              value={
                typeof audit.domainInfo.notFoundStatusCode === 'number'
                  ? `returns ${audit.domainInfo.notFoundStatusCode}`
                  : '—'
              }
              title="A missing page that answers 200 is a soft 404 and gets indexed."
            />
            <Fact
              label="Crawl ran"
              value={
                audit.endedAt
                  ? `${formatDay(audit.startedAt)} → ${formatDay(audit.endedAt)}`
                  : '—'
              }
            />
            {Object.entries(audit.domainInfo.checks || {}).map(([key, value]) => (
              <Fact
                key={key}
                label={key.replace(/_/g, ' ')}
                value={
                  <span style={{ color: toneOf(value ? 'positive' : 'negative') }}>
                    {value ? 'yes' : 'no'}
                  </span>
                }
              />
            ))}
          </div>
        </Panel>
      )}

      {/* ---- Core Web Vitals -------------------------------------------------- */}
      {vitals && (
        <Panel>
          <PanelHead
            title="Core Web Vitals"
            sub="lab data — not what Google ranks on"
            right={
              vitals.measuredPages > 0 ? (
                <CountChip>{`${vitals.measuredPages} of ${vitals.sampleSize} pages measured`}</CountChip>
              ) : null
            }
          />
          <StatRow>
            {vitals.metrics.map((metric) => (
              <Stat
                key={metric.key}
                label={`${metric.label}${metric.retired ? ' (retired)' : ''}`}
                value={
                  metric.measured
                    ? `${metric.p75}${metric.unit}`
                    : /* Not "0". A zero from a crawl that never rendered is not
                         a perfect score; it is the absence of a measurement. */
                      '—'
                }
                sub={
                  metric.measured ? (
                    <span style={{ color: toneOf(metric.band?.tone) }}>
                      {metric.band?.label}
                    </span>
                  ) : (
                    'not measured'
                  )
                }
              />
            ))}
            <Stat
              label="INP"
              value="—"
              /**
               * Shown as an ABSENT metric rather than omitted. INP is the Core
               * Web Vital that replaced FID; a panel with no row for it reads as
               * a panel that forgot, and the honest fact is that the provider
               * does not have it at all.
               */
              sub={`not available from ${label}`}
            />
          </StatRow>
          <div className="px-4 pb-4">
            <p className="font-body" style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>
              {VITALS_CAPTION}
            </p>
            {vitals.note ? (
              <p
                className="font-body mt-1.5"
                style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}
              >
                {vitals.note}
              </p>
            ) : null}
            {vitals.measuredPages > 0 && vitals.sampleBias ? (
              <p
                className="font-body mt-1.5"
                style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}
              >
                {`Measured over the ${vitals.sampleSize} lowest-scoring pages of this crawl, not a random sample.`}
              </p>
            ) : null}
          </div>
        </Panel>
      )}

      {/* ---- Issues ----------------------------------------------------------- */}
      <LabsFilterBar
        query={issueQuery}
        onQuery={(v) => {
          setIssueQuery(v);
          setIssuePage(1);
        }}
        placeholder="Find an issue"
        buckets={ISSUE_BUCKETS}
        active={issueBuckets}
        onToggle={(key) => {
          setIssueBuckets((prev) =>
            prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
          );
          setIssuePage(1);
        }}
        onClear={() => {
          setIssueBuckets([]);
          setIssuePage(1);
        }}
        onExport={(format) =>
          downloadLabsExport(
            exportPayload(sortedIssues, filteredIssues.length !== allIssues.length),
            'issues',
            format
          )
        }
      >
        <CountChip>{`${formatNumber(allIssues.length)} findings`}</CountChip>
      </LabsFilterBar>

      <Panel>
        <ScrollTable maxHeight={520}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {ISSUE_COLUMNS.map((col) => (
                  <SortableTh
                    key={col.key}
                    column={col.sortKey}
                    sort={issueSort}
                    onSort={(next) => {
                      setIssueSort(next);
                      setIssuePage(1);
                    }}
                    align={col.align}
                    width={col.width}
                    title={col.title}
                  >
                    {col.label}
                  </SortableTh>
                ))}
              </tr>
            </thead>
            <tbody>
              {issueView.rows.length === 0 ? (
                <tr>
                  <td colSpan={ISSUE_COLUMNS.length}>
                    <p
                      className="font-body text-center px-4 py-8"
                      style={{ fontSize: 13, color: 'var(--color-text-muted)' }}
                    >
                      No issue matches that filter.
                    </p>
                  </td>
                </tr>
              ) : (
                issueView.rows.map((row) => (
                  <tr key={row.key}>
                    <Td title={row.key}>
                      {row.label}
                      {/*
                        THE CAPTION THAT MAKES THE INVERSION CHECKABLE.
                        For a counter that counts passes, printing "96 of 120
                        pages pass" underneath the 24 lets a reader verify the
                        subtraction instead of having to trust it.
                      */}
                      {row.positive ? (
                        <span
                          className="font-body block"
                          style={{ fontSize: 11, color: 'var(--color-text-muted)' }}
                        >
                          {issueCaption(row)}
                        </span>
                      ) : null}
                      {!row.known ? (
                        <span
                          className="font-body block"
                          style={{ fontSize: 11, color: 'var(--color-text-muted)' }}
                          title="This app has no classification for this check yet, so it is shown unranked rather than hidden."
                        >
                          not classified yet
                        </span>
                      ) : null}
                    </Td>
                    <Td muted>{severityLabel(row.severity)}</Td>
                    <Td align="right">{formatNumber(row.pages)}</Td>
                    <Td align="right" muted>
                      {percent(row.share)}
                    </Td>
                    <Td align="right" muted={!row.impact}>
                      {typeof row.impact === 'number' ? row.impact.toFixed(2) : '—'}
                    </Td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </ScrollTable>

        <Pagination
          page={issueView.page}
          pageCount={issueView.pageCount}
          from={issueView.from}
          to={issueView.to}
          total={issueView.total}
          onPage={setIssuePage}
          noun="issues"
          pageSizes={PAGE_SIZES}
          pageSize={issuePageSize}
          onPageSize={(next) => {
            setIssuePageSize(next);
            setIssuePage(1);
          }}
        />
      </Panel>

      {/* ---- The worst pages -------------------------------------------------- */}
      {allPages.length > 0 && (
        <>
          <LabsFilterBar
            query={pageQuery}
            onQuery={(v) => {
              setPageQuery(v);
              setPagePage(1);
            }}
            placeholder="Find a page"
            buckets={PAGE_BUCKETS}
            active={pageBuckets}
            onToggle={(key) => {
              setPageBuckets((prev) =>
                prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
              );
              setPagePage(1);
            }}
            onClear={() => {
              setPageBuckets([]);
              setPagePage(1);
            }}
            onExport={(format) =>
              downloadLabsExport(
                exportPayload(sortedPages, filteredPages.length !== allPages.length),
                'auditPages',
                format
              )
            }
          >
            <CountChip>
              {/*
                Which pages these are, said out loud. They are the lowest-scoring
                ones the crawl found, not the first hundred it reached and not
                the whole site — and a table captioned "pages" with neither of
                those said reads as the whole site.
              */}
              {`the ${formatNumber(allPages.length)} lowest-scoring of ${formatNumber(
                audit?.pagesCrawled
              )} crawled`}
            </CountChip>
          </LabsFilterBar>

          <Panel>
            <ScrollTable maxHeight={520}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    {PAGE_COLUMNS.map((col) => (
                      <SortableTh
                        key={col.key}
                        column={col.sortKey}
                        sort={pageSort}
                        onSort={(next) => {
                          setPageSort(next);
                          setPagePage(1);
                        }}
                        align={col.align}
                        width={col.width}
                        title={col.title}
                      >
                        {col.label}
                      </SortableTh>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {pageView.rows.length === 0 ? (
                    <tr>
                      <td colSpan={PAGE_COLUMNS.length}>
                        <p
                          className="font-body text-center px-4 py-8"
                          style={{ fontSize: 13, color: 'var(--color-text-muted)' }}
                        >
                          No page matches that filter.
                        </p>
                      </td>
                    </tr>
                  ) : (
                    pageView.rows.map((row) => (
                      <tr key={row.url}>
                        <Td title={row.url}>{row.path}</Td>
                        <Td align="right" muted={row.statusCode === 200}>
                          {formatNumber(row.statusCode)}
                        </Td>
                        <Td align="right">
                          <span style={{ color: toneOf(row.scoreBand?.tone) }}>
                            {typeof row.onpageScore === 'number' ? row.onpageScore : '—'}
                          </span>
                        </Td>
                        <Td
                          align="right"
                          title={row.failingChecks.join(', ')}
                          muted={!row.failingCount}
                        >
                          {formatNumber(row.failingCount)}
                        </Td>
                        <Td align="right" muted>
                          {formatNumber(row.clickDepth)}
                        </Td>
                        <Td align="right" muted={row.inboundLinks === 0}>
                          {formatNumber(row.inboundLinks)}
                        </Td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </ScrollTable>

            <Pagination
              page={pageView.page}
              pageCount={pageView.pageCount}
              from={pageView.from}
              to={pageView.to}
              total={pageView.total}
              onPage={setPagePage}
              noun="pages"
              pageSizes={PAGE_SIZES}
              pageSize={pagePageSize}
              onPageSize={(next) => {
                setPagePageSize(next);
                setPagePage(1);
              }}
            />
          </Panel>
        </>
      )}
    </div>
  );
};

export default SiteAuditScreen;
