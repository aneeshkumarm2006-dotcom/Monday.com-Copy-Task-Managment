import { Suspense, lazy, useMemo, useState } from 'react';
import { Link2 } from 'lucide-react';

import EmptyState from '../../../ui/EmptyState';
import Pagination from '../../../ui/Pagination';
import SortableTh from '../../../ui/SortableTh';
import { SegmentedControl } from '../../../ui/FormControls';
import { SkeletonText } from '../../../ui/Skeleton';
import { ScrollTable, Stat, StatRow, Td } from '../connector/SectionShell';
import { formatDay, formatNumber } from '../../../../utils/connectorFormat';
import { paginate } from '../../../../utils/rankRows';
import {
  ANCHOR_BUCKETS,
  RANK_CAPTION,
  REFERRING_DOMAIN_BUCKETS,
  anchorMix,
  anchorRowsFrom,
  authorityRowsFrom,
  backlinkFreshness,
  breakdownSlices,
  comparability,
  deltaOf,
  dofollowShare,
  filterAnchorRows,
  filterReferringDomainRows,
  formatDomainRank,
  growthPointsFrom,
  growthSummary,
  isKindCollected,
  profileFrom,
  referringDomainRowsFrom,
  sortAnchorRows,
  sortReferringDomainRows,
} from '../../../../utils/backlinkRows';
import { downloadLabsExport } from '../../../../utils/labsExport';
import {
  CountChip,
  LabsFilterBar,
  LiveStamp,
  NotCollected,
  Panel,
  PanelHead,
} from './LabsBits';

// ~95 KB, shared with the rank charts as a second lazy chunk of the same library.
const BacklinkChart = lazy(() => import('./BacklinkChart'));

/**
 * Backlinks — the second thing every client asks about, and three ways to get
 * it wrong.
 *
 * Every widget below draws a number that would look completely reasonable if it
 * were wrong, which is why the reasoning lives beside each one rather than in a
 * ticket:
 *
 * ---- 1. THE RANK TILE IS NOT DA AND IT IS NOT DR ---------------------------
 *
 * It is DataForSEO's own metric — original PageRank with damping 0.5,
 * logarithmically compressed, over their crawl — on a 0-1000 scale, and they
 * say in as many words that the values should not be expected to match Ahrefs'
 * Domain Rating. Labelling it DR hands a client a number they can look up
 * somewhere else and find to be wrong, and they would be right. So the tile says
 * "Domain rank" with the scale beside it and the caption underneath, and the
 * scale is read from the snapshot rather than assumed, because the conversion to
 * 0-100 is `sin(rank / 636.62) * 100` and is not recoverable from the number.
 *
 * It is also NOT rendered through `connectorFormat.formatRank`. That function
 * owns the SERP three-way rule and turns a null into "Not in top 100" — a
 * sentence about search results, on a panel about links, that is never true.
 *
 * And the referring-domains table's rank column is a THIRD thing again: it is
 * the rank of the links each domain sends US, not that domain's standing, so it
 * is headed "Link strength". A directory sending four hundred sitewide links
 * outranks a newspaper sending one editorial link, which is correct for "how
 * much do these links carry" and nonsense for "how good is this site".
 *
 * ---- 2. THE DOFOLLOW TILE COMES FROM A SECOND CALL -------------------------
 *
 * `referring_domains_nofollow` counts domains sending AT LEAST ONE nofollow
 * link, so it overlaps the referring set rather than partitioning it and
 * `referring_domains − referring_domains_nofollow` is not the dofollow count. It
 * understates, silently, by however many referrers link more than once. The tile
 * shows the answer to a second `summary` call carrying a dofollow filter, and an
 * em dash when that call failed — never a subtraction.
 *
 * ---- 3. TWO READINGS UNDER DIFFERENT LINK SETS ARE NOT COMPARABLE ----------
 *
 * `backlinks_status_type` (`all | live | lost`) RECOMPUTES every aggregate over
 * a different corpus rather than filtering rows — DataForSEO's own example shows
 * one domain at rank 509 under `lost` and 562 under `live`. So the movement
 * caption asks `comparability` before it prints a delta, and prints the reason
 * instead of a number when the answer is no.
 *
 * ---- And the anchor cloud's weight ------------------------------------------
 *
 * Sized by ROOT DOMAINS, never by backlinks. One sitewide footer link repeated
 * across forty thousand pages arrives as forty thousand backlinks carrying one
 * anchor that exactly one person chose, and it would be the entire anchor
 * profile of every site that has one.
 */

const PAGE_SIZES = [25, 50, 100];

const DOMAIN_COLUMNS = [
  { key: 'domain', label: 'Referring domain', sortKey: 'domain', align: 'left' },
  {
    key: 'linksRank',
    label: 'Link strength',
    sortKey: 'linksRank',
    align: 'right',
    width: 120,
    title:
      'The rank of the links this domain sends here — not the domain’s own standing. A site linking fifty times scores higher than a stronger site linking once.',
  },
  { key: 'backlinks', label: 'Links', sortKey: 'backlinks', align: 'right', width: 90 },
  {
    key: 'brokenBacklinks',
    label: 'Broken',
    sortKey: 'brokenBacklinks',
    align: 'right',
    width: 90,
  },
  { key: 'spamScore', label: 'Spam score', sortKey: 'spamScore', align: 'right', width: 110 },
  { key: 'firstSeen', label: 'First seen', sortKey: 'firstSeen', align: 'left', width: 120 },
];

const ANCHOR_COLUMNS = [
  { key: 'anchor', label: 'Anchor', sortKey: 'anchor', align: 'left' },
  { key: 'klass', label: 'Type', sortKey: 'klass', align: 'left', width: 110 },
  {
    key: 'referringMainDomains',
    label: 'Root domains',
    sortKey: 'referringMainDomains',
    align: 'right',
    width: 120,
    title:
      'How many different root domains chose this anchor. The cloud is weighted by this and not by link count, so one sitewide footer cannot dominate the profile.',
  },
  { key: 'backlinks', label: 'Links', sortKey: 'backlinks', align: 'right', width: 90 },
  { key: 'spamScore', label: 'Spam score', sortKey: 'spamScore', align: 'right', width: 110 },
];

const percent = (value) =>
  typeof value === 'number' ? `${Math.round(value * 100)}%` : '—';

/** A signed count, so a caption reads "+1,240" rather than "1240". */
const signed = (value) =>
  typeof value !== 'number' ? '—' : `${value > 0 ? '+' : ''}${formatNumber(value)}`;

/** One breakdown map as a labelled bar list. Free with the summary call. */
const BreakdownList = ({ title, rows }) => {
  const slices = breakdownSlices(rows, 6);
  if (!slices.length) return null;
  return (
    <div className="min-w-0">
      <p
        className="font-body"
        style={{
          fontSize: 11,
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          color: 'var(--color-text-muted)',
        }}
      >
        {title}
      </p>
      <div className="mt-1.5 flex flex-col gap-1">
        {slices.map((slice) => (
          <div key={slice.key} className="flex items-center gap-2">
            <span
              className="font-body truncate"
              style={{ fontSize: 12, minWidth: 74, color: 'var(--color-text-secondary)' }}
              title={slice.key}
            >
              {slice.key}
            </span>
            <span
              style={{
                flex: 1,
                height: 6,
                borderRadius: 'var(--radius-full)',
                background: 'var(--color-bg-subtle)',
                overflow: 'hidden',
              }}
            >
              <span
                style={{
                  display: 'block',
                  width: `${Math.max(2, slice.share * 100)}%`,
                  height: '100%',
                  background: 'var(--color-accent)',
                }}
              />
            </span>
            <span
              className="font-body"
              style={{ fontSize: 11.5, color: 'var(--color-text-muted)', minWidth: 34 }}
            >
              {percent(slice.share)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

const BacklinksScreen = ({ data, label }) => {
  const summarySnapshot = data?.snapshots?.backlinks_summary || null;
  const previousSummary = data?.previousSnapshots?.backlinks_summary || null;
  const timeseriesSnapshot = data?.snapshots?.backlinks_timeseries || null;
  const domainsSnapshot = data?.snapshots?.referring_domains || null;
  const anchorsSnapshot = data?.snapshots?.anchors || null;

  const domain = data?.project?.domain || '';
  const freshness = backlinkFreshness(summarySnapshot || domainsSnapshot || anchorsSnapshot);

  const profile = useMemo(() => profileFrom(summarySnapshot), [summarySnapshot]);
  const authority = useMemo(() => authorityRowsFrom(summarySnapshot), [summarySnapshot]);
  const growth = useMemo(() => growthSummary(timeseriesSnapshot), [timeseriesSnapshot]);
  const growthPoints = useMemo(
    () => growthPointsFrom(timeseriesSnapshot),
    [timeseriesSnapshot]
  );

  const [chart, setChart] = useState('growth');

  const [domainSort, setDomainSort] = useState({ key: 'linksRank', dir: 'desc' });
  const [domainQuery, setDomainQuery] = useState('');
  const [domainBuckets, setDomainBuckets] = useState([]);
  const [domainPage, setDomainPage] = useState(1);
  const [domainPageSize, setDomainPageSize] = useState(25);

  const [anchorSort, setAnchorSort] = useState({ key: 'referringMainDomains', dir: 'desc' });
  const [anchorQuery, setAnchorQuery] = useState('');
  const [anchorBuckets, setAnchorBuckets] = useState([]);
  const [anchorPage, setAnchorPage] = useState(1);
  const [anchorPageSize, setAnchorPageSize] = useState(25);

  const allDomains = useMemo(
    () => referringDomainRowsFrom(domainsSnapshot),
    [domainsSnapshot]
  );
  const filteredDomains = useMemo(
    () => filterReferringDomainRows(allDomains, { query: domainQuery, buckets: domainBuckets }),
    [allDomains, domainQuery, domainBuckets]
  );
  const sortedDomains = useMemo(
    () => sortReferringDomainRows(filteredDomains, domainSort),
    [filteredDomains, domainSort]
  );
  const domainView = useMemo(
    () => paginate(sortedDomains, { page: domainPage, pageSize: domainPageSize }),
    [sortedDomains, domainPage, domainPageSize]
  );

  const allAnchors = useMemo(
    () => anchorRowsFrom(anchorsSnapshot, domain),
    [anchorsSnapshot, domain]
  );
  const mix = useMemo(() => anchorMix(allAnchors), [allAnchors]);
  const filteredAnchors = useMemo(
    () => filterAnchorRows(allAnchors, { query: anchorQuery, buckets: anchorBuckets }),
    [allAnchors, anchorQuery, anchorBuckets]
  );
  const sortedAnchors = useMemo(
    () => sortAnchorRows(filteredAnchors, anchorSort),
    [filteredAnchors, anchorSort]
  );
  const anchorView = useMemo(
    () => paginate(sortedAnchors, { page: anchorPage, pageSize: anchorPageSize }),
    [sortedAnchors, anchorPage, anchorPageSize]
  );

  /**
   * The movement caption, and the one place trap 3 actually bites.
   *
   * `comparability` is asked BEFORE any subtraction, and its answer is a
   * sentence rather than a boolean so the panel can say why there is no number
   * instead of quietly omitting one.
   */
  const compare = comparability(summarySnapshot?.data, previousSummary?.data);
  const movement = {
    backlinks: deltaOf(
      summarySnapshot?.data,
      previousSummary?.data,
      (d) => d?.profile?.backlinks ?? null
    ),
    referringDomains: deltaOf(
      summarySnapshot?.data,
      previousSummary?.data,
      (d) => d?.profile?.referringDomains ?? null
    ),
    rank: deltaOf(summarySnapshot?.data, previousSummary?.data, (d) => d?.profile?.rank ?? null),
  };

  const exportPayload = (rows, filtered, snapshot) => ({
    siteName: data.project?.name || data.project?.domain || 'Site',
    domain: data.project?.domain || '',
    variant: snapshot?.variant || data.variant,
    periodKey: snapshot?.periodKey || '',
    collectedAt: snapshot?.collectedAt || snapshot?.fetchedAt || null,
    /** The link set, in every exported row. See `labsExport`'s context columns. */
    statusType: snapshot?.data?.statusType || null,
    rows,
    filtered,
  });

  if (!summarySnapshot && !domainsSnapshot && !anchorsSnapshot && !timeseriesSnapshot) {
    const collected = isKindCollected(data, 'backlinks_summary');
    return (
      <div className="flex flex-col gap-4">
        {!collected && <NotCollected label={label} what="The backlink profile" />}
        <EmptyState
          icon={Link2}
          title="No backlink data collected yet"
          description={
            collected
              ? 'This fills in on the next weekly run. Nothing is bought when you open this tab.'
              : 'Nothing is being collected for this screen.'
          }
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <LiveStamp freshness={freshness} label={label} />

      {/* ---- The profile ----------------------------------------------------- */}
      {!isKindCollected(data, 'backlinks_summary') && (
        <NotCollected label={label} what="The backlink profile" />
      )}

      {profile && (
        <Panel>
          <StatRow>
            <Stat
              label="Domain rank"
              value={formatDomainRank(profile.rank)}
              /**
               * The scale, on the tile, because 562 and 56 are the same fact and
               * the number cannot say which. And never the letters DA or DR.
               */
              sub={`0–${profile.rankCeiling} · ${label}'s own metric`}
            />
            <Stat
              label="Backlinks"
              value={formatNumber(profile.backlinks, { compact: true })}
              sub={compare.ok ? `${signed(movement.backlinks)} since last` : 'total links found'}
            />
            <Stat
              label="Referring domains"
              value={formatNumber(profile.referringDomains, { compact: true })}
              sub={
                compare.ok
                  ? `${signed(movement.referringDomains)} since last`
                  : 'sites linking here'
              }
            />
            <Stat
              label="Dofollow referring domains"
              value={formatNumber(profile.dofollowReferringDomains, { compact: true })}
              /**
               * SAID OUT LOUD, because the number a reader expects to be able to
               * derive is not derivable. `*_nofollow` means "at least one
               * nofollow link", so the two counts overlap and their difference
               * is not this.
               */
              sub={
                profile.dofollowMeasured
                  ? `${percent(dofollowShare(profile))} of referrers · measured, not subtracted`
                  : 'the filtered reading did not arrive'
              }
            />
            <Stat
              label="Spam score"
              value={
                typeof profile.spamScore === 'number' ? String(profile.spamScore) : '—'
              }
              sub={profile.spamBand ? profile.spamBand.label : '0–100, domain level'}
            />
            <Stat
              label="Broken"
              value={formatNumber(profile.brokenBacklinks)}
              sub={`links · ${formatNumber(profile.brokenPages)} pages`}
            />
          </StatRow>

          <div className="px-4 pb-4">
            <p
              className="font-body"
              style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}
            >
              {RANK_CAPTION}
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

      {/* ---- Authority beside the competitors it was bought with -------------- */}
      {authority.length > 1 && (
        <Panel>
          <PanelHead
            title="Domain rank, side by side"
            sub={`0–${profile?.rankCeiling || 1000}, ${label}'s own metric — not Domain Authority or Domain Rating`}
          />
          <StatRow>
            {authority.map((row) => (
              <Stat
                key={row.target}
                label={row.target}
                value={formatDomainRank(row.authorityRank)}
                sub={row.isSelf ? 'this site' : 'competitor'}
              />
            ))}
          </StatRow>
        </Panel>
      )}

      {/* ---- The free breakdowns --------------------------------------------- */}
      {profile?.breakdowns && (
        <Panel>
          <PanelHead
            title="Where the links come from"
            sub="from the profile call — no extra collection"
          />
          <div
            className="grid gap-5 px-4 py-4"
            style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}
          >
            <BreakdownList title="Top-level domain" rows={profile.breakdowns.tld} />
            <BreakdownList title="Country" rows={profile.breakdowns.countries} />
            <BreakdownList title="Link type" rows={profile.breakdowns.types} />
            <BreakdownList title="Where on the page" rows={profile.breakdowns.semanticLocations} />
          </div>
        </Panel>
      )}

      {/* ---- Growth ----------------------------------------------------------- */}
      {!isKindCollected(data, 'backlinks_timeseries') ? (
        <NotCollected label={label} what="Link growth" />
      ) : (
        <Panel>
          <PanelHead
            title="Link growth"
            sub={
              growth?.window
                ? `${formatDay(growth.window.from)} to ${formatDay(growth.window.to)}, by month`
                : 'by month'
            }
            right={
              <SegmentedControl
                options={[
                  { value: 'growth', label: 'Totals' },
                  { value: 'flows', label: 'New & lost' },
                ]}
                value={chart}
                onChange={setChart}
              />
            }
          />
          <div className="px-4 py-4">
            {growthPoints.length === 0 ? (
              <p
                className="font-body"
                style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}
              >
                Nothing collected for this window yet.
              </p>
            ) : (
              <Suspense fallback={<SkeletonText width="100%" height={200} />}>
                <BacklinkChart mode={chart} points={growthPoints} />
              </Suspense>
            )}
            {growth && (
              <p
                className="font-body mt-2"
                style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}
              >
                {`${signed(growth.change)} backlinks across ${growth.buckets} month${
                  growth.buckets === 1 ? '' : 's'
                }. `}
                {/*
                  The window, said out loud. "New" and "lost" are computed by the
                  provider RELATIVE TO the start date, so the same month's
                  numbers differ under a different window and nothing in the
                  series says so.
                */}
                New and lost are counted from{' '}
                {growth.window?.from ? formatDay(growth.window.from) : 'the start of the window'}
                , which is what those two bars are relative to.
              </p>
            )}
          </div>
        </Panel>
      )}

      {/* ---- Referring domains ------------------------------------------------ */}
      {!isKindCollected(data, 'referring_domains') ? (
        <NotCollected label={label} what="Referring domains" />
      ) : (
        <>
          <LabsFilterBar
            query={domainQuery}
            onQuery={(v) => {
              setDomainQuery(v);
              setDomainPage(1);
            }}
            placeholder="Find a referring domain"
            buckets={REFERRING_DOMAIN_BUCKETS}
            active={domainBuckets}
            onToggle={(key) => {
              setDomainBuckets((prev) =>
                prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
              );
              setDomainPage(1);
            }}
            onClear={() => {
              setDomainBuckets([]);
              setDomainPage(1);
            }}
            onExport={(format) =>
              downloadLabsExport(
                exportPayload(
                  sortedDomains,
                  filteredDomains.length !== allDomains.length,
                  domainsSnapshot
                ),
                'referringDomains',
                format
              )
            }
          >
            {profile?.referringDomains ? (
              <CountChip>
                {/*
                  The table holds the top hundred we bought; the tile above holds
                  the whole count. Two numbers called the same thing on one screen
                  is how a footer contradicts a headline, so the chip says which.
                */}
                {`showing ${formatNumber(allDomains.length)} of ${formatNumber(
                  profile.referringDomains
                )}`}
              </CountChip>
            ) : null}
          </LabsFilterBar>

          <Panel>
            <ScrollTable maxHeight={520}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    {DOMAIN_COLUMNS.map((col) => (
                      <SortableTh
                        key={col.key}
                        column={col.sortKey}
                        sort={domainSort}
                        onSort={(next) => {
                          setDomainSort(next);
                          setDomainPage(1);
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
                  {domainView.rows.length === 0 ? (
                    <tr>
                      <td colSpan={DOMAIN_COLUMNS.length}>
                        <p
                          className="font-body text-center px-4 py-8"
                          style={{ fontSize: 13, color: 'var(--color-text-muted)' }}
                        >
                          No referring domain matches that filter.
                        </p>
                      </td>
                    </tr>
                  ) : (
                    domainView.rows.map((row) => (
                      <tr key={row.domain}>
                        <Td title={row.domain}>{row.domain}</Td>
                        <Td align="right">{formatDomainRank(row.linksRank)}</Td>
                        <Td align="right">{formatNumber(row.backlinks)}</Td>
                        <Td align="right" muted={!row.brokenBacklinks}>
                          {formatNumber(row.brokenBacklinks)}
                        </Td>
                        <Td align="right">
                          <span
                            style={{
                              color:
                                row.spamBand?.tone === 'negative'
                                  ? '#DC2626'
                                  : row.spamBand?.tone === 'positive'
                                    ? 'var(--color-card-green)'
                                    : 'var(--color-text-secondary)',
                            }}
                            title={row.spamBand?.label || ''}
                          >
                            {typeof row.spamScore === 'number' ? row.spamScore : '—'}
                          </span>
                        </Td>
                        <Td muted>{row.firstSeen ? formatDay(row.firstSeen) : '—'}</Td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </ScrollTable>

            <Pagination
              page={domainView.page}
              pageCount={domainView.pageCount}
              from={domainView.from}
              to={domainView.to}
              total={domainView.total}
              onPage={setDomainPage}
              noun="domains"
              pageSizes={PAGE_SIZES}
              pageSize={domainPageSize}
              onPageSize={(next) => {
                setDomainPageSize(next);
                setDomainPage(1);
              }}
            />
          </Panel>
        </>
      )}

      {/* ---- Anchors ---------------------------------------------------------- */}
      {!isKindCollected(data, 'anchors') ? (
        <NotCollected label={label} what="Anchor text" />
      ) : (
        <>
          {mix.length > 0 && (
            <Panel>
              <PanelHead
                title="Anchor mix"
                sub="weighted by how many root domains chose each phrase, not by link count"
              />
              <StatRow>
                {mix.map((klass) => (
                  <Stat
                    key={klass.key}
                    label={klass.label}
                    value={percent(klass.share)}
                    sub={`${formatNumber(klass.domains)} domains · ${formatNumber(
                      klass.anchors
                    )} anchors`}
                  />
                ))}
              </StatRow>
            </Panel>
          )}

          <LabsFilterBar
            query={anchorQuery}
            onQuery={(v) => {
              setAnchorQuery(v);
              setAnchorPage(1);
            }}
            placeholder="Find an anchor"
            buckets={ANCHOR_BUCKETS}
            active={anchorBuckets}
            onToggle={(key) => {
              setAnchorBuckets((prev) =>
                prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
              );
              setAnchorPage(1);
            }}
            onClear={() => {
              setAnchorBuckets([]);
              setAnchorPage(1);
            }}
            onExport={(format) =>
              downloadLabsExport(
                exportPayload(
                  sortedAnchors,
                  filteredAnchors.length !== allAnchors.length,
                  anchorsSnapshot
                ),
                'anchors',
                format
              )
            }
          />

          <Panel>
            <ScrollTable maxHeight={480}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    {ANCHOR_COLUMNS.map((col) => (
                      <SortableTh
                        key={col.key}
                        column={col.sortKey}
                        sort={anchorSort}
                        onSort={(next) => {
                          setAnchorSort(next);
                          setAnchorPage(1);
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
                  {anchorView.rows.length === 0 ? (
                    <tr>
                      <td colSpan={ANCHOR_COLUMNS.length}>
                        <p
                          className="font-body text-center px-4 py-8"
                          style={{ fontSize: 13, color: 'var(--color-text-muted)' }}
                        >
                          No anchor matches that filter.
                        </p>
                      </td>
                    </tr>
                  ) : (
                    anchorView.rows.map((row, i) => (
                      <tr key={`${row.anchor}-${i}`}>
                        <Td title={row.anchor} muted={row.anchor === ''}>
                          {/*
                            An empty anchor is an image link with no alt text — a
                            real anchor and a real finding, so it is named rather
                            than shown as a blank cell that reads as a bug.
                          */}
                          {row.anchor === '' ? '(empty — image link)' : row.anchor}
                        </Td>
                        <Td muted>
                          {ANCHOR_BUCKETS.find((b) => b.key === `class:${row.klass}`)?.label ||
                            row.klass}
                        </Td>
                        <Td align="right">
                          {formatNumber(row.referringMainDomains)}
                          {row.share !== null ? (
                            <span
                              className="font-body"
                              style={{ fontSize: 11, color: 'var(--color-text-muted)' }}
                            >
                              {` · ${percent(row.share)}`}
                            </span>
                          ) : null}
                        </Td>
                        <Td align="right">{formatNumber(row.backlinks, { compact: true })}</Td>
                        <Td align="right">
                          {typeof row.spamScore === 'number' ? row.spamScore : '—'}
                        </Td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </ScrollTable>

            <Pagination
              page={anchorView.page}
              pageCount={anchorView.pageCount}
              from={anchorView.from}
              to={anchorView.to}
              total={anchorView.total}
              onPage={setAnchorPage}
              noun="anchors"
              pageSizes={PAGE_SIZES}
              pageSize={anchorPageSize}
              onPageSize={(next) => {
                setAnchorPageSize(next);
                setAnchorPage(1);
              }}
            />
          </Panel>
        </>
      )}

      <p className="font-body" style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>
        {label}&rsquo;s link index is rebuilt continuously, which is why this screen says
        live where the competitive-index screens do not. It does not publish how
        often it recrawls any single domain, so the gap between a link
        disappearing and this page saying so is not something either of us can
        measure.
      </p>
    </div>
  );
};

export default BacklinksScreen;
