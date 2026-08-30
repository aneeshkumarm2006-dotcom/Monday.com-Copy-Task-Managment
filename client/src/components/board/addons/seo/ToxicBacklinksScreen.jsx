import { useMemo, useState } from 'react';
import { Download, ShieldAlert } from 'lucide-react';

import Button from '../../../ui/Button';
import EmptyState from '../../../ui/EmptyState';
import Pagination from '../../../ui/Pagination';
import SortableTh from '../../../ui/SortableTh';
import { ScrollTable, Stat, StatRow, Td, Th } from '../connector/SectionShell';
import { formatDay, formatNumber } from '../../../../utils/connectorFormat';
import { paginate } from '../../../../utils/rankRows';
import { saveBlob } from '../../../../utils/fileUrl';
import { downloadLabsExport } from '../../../../utils/labsExport';
import { formatDomainRank, RANK_CAPTION } from '../../../../utils/backlinkRows';
import {
  TOXIC_BUCKETS,
  buildDisavow,
  disavowFilename,
  filterToxicRows,
  isKindCollected,
  networkRowsFrom,
  networkSummaryFrom,
  signalLabel,
  sortNetworkRows,
  sortToxicRows,
  toxicRowsFrom,
  toxicSummaryFrom,
} from '../../../../utils/toxicRows';
import { CountChip, LabsFilterBar, LiveStamp, NotCollected, Panel, PanelHead } from './LabsBits';

/**
 * Toxic backlinks — what looks wrong, why, and the file it produces.
 *
 * ---- The screen is written around one fact about the output ----------------
 *
 * A DISAVOW FILE LEAVES THIS APPLICATION. Somebody uploads it to Google Search
 * Console and nothing here ever hears about it again, and a disavow is one of
 * the very few things in SEO that can make a site measurably worse. So the
 * language is "suggested" everywhere, the reasons travel with every row and into
 * the file's own comment lines, and the download button says how many domains
 * are in it before it is pressed.
 *
 * The rule itself is not here. `toxicity.scoreDomain` runs on the server at
 * normalisation time and stamps its verdict onto every stored row — the same
 * argument `onpageChecks.issueCountFor` makes for the inverted counters: a rule
 * whose output is a deliverable exists once.
 *
 * ---- Two panels, two questions, and they do not join -----------------------
 *
 * The DOMAIN table answers "which referrers look wrong". The SUBNET table
 * answers "how many of them sit on one block", which is the private blog network
 * signature per-domain spam scoring structurally cannot see — forty individually
 * clean sites carry forty clean spam scores.
 *
 * They are not joined and cannot be: `referring_networks` rows carry no domain
 * list, so there is no key between a /24 and a hostname anywhere in the API. And
 * the subnet panel never feeds the file, because Google's disavow format has
 * `domain:` lines and URLs and no line type for a network at all.
 */

const PAGE_SIZES = [25, 50, 100];

const COLUMNS = [
  { key: 'domain', label: 'Referring domain', sortKey: 'domain', align: 'left' },
  { key: 'signals', label: 'Reasons', align: 'left' },
  { key: 'spamScore', label: 'Spam score', sortKey: 'spamScore', align: 'right', width: 110 },
  { key: 'backlinks', label: 'Links to us', sortKey: 'backlinks', align: 'right', width: 110 },
  { key: 'linksRank', label: 'Link strength', sortKey: 'linksRank', align: 'right', width: 120 },
  { key: 'firstSeen', label: 'First seen', align: 'right', width: 110 },
];

const NETWORK_COLUMNS = [
  { key: 'network', label: 'IP block', sortKey: 'network', align: 'left' },
  {
    key: 'referringDomains',
    label: 'Referrers on it',
    sortKey: 'referringDomains',
    align: 'right',
    width: 130,
  },
  { key: 'backlinks', label: 'Links', sortKey: 'backlinks', align: 'right', width: 100 },
  { key: 'linksRank', label: 'Link strength', sortKey: 'linksRank', align: 'right', width: 120 },
];

const verdictTone = (row) => {
  if (row.lost) return 'var(--color-text-muted)';
  if (row.disavow) return 'var(--color-status-stuck)';
  return 'var(--color-status-working)';
};

const verdictLabel = (row) => {
  if (row.lost) return 'already gone';
  if (row.disavow) return 'suggested';
  return 'watch';
};

const ToxicBacklinksScreen = ({ data, label }) => {
  const snapshot = data?.snapshots?.referring_domains || null;
  const networkSnapshot = data?.snapshots?.referring_networks || null;
  const collected = isKindCollected(data, 'referring_domains');
  const networksCollected = isKindCollected(data, 'referring_networks');

  const [sort, setSort] = useState({ key: 'score', dir: 'desc' });
  const [networkSort, setNetworkSort] = useState({ key: 'referringDomains', dir: 'desc' });
  const [query, setQuery] = useState('');
  const [buckets, setBuckets] = useState([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const summary = useMemo(() => toxicSummaryFrom(snapshot), [snapshot]);
  const allRows = useMemo(() => toxicRowsFrom(snapshot), [snapshot]);
  const filtered = useMemo(
    () => filterToxicRows(allRows, { query, buckets }),
    [allRows, query, buckets]
  );
  const sorted = useMemo(() => sortToxicRows(filtered, sort), [filtered, sort]);
  const view = useMemo(() => paginate(sorted, { page, pageSize }), [sorted, page, pageSize]);

  const networks = useMemo(() => networkRowsFrom(networkSnapshot), [networkSnapshot]);
  const networkTotals = useMemo(() => networkSummaryFrom(networkSnapshot), [networkSnapshot]);
  const networkView = useMemo(
    () => sortNetworkRows(networks, networkSort),
    [networks, networkSort]
  );

  const suggested = useMemo(() => allRows.filter((r) => r.disavow && !r.lost), [allRows]);

  const downloadDisavow = () => {
    const file = buildDisavow(allRows, {
      domain: data.project?.domain || '',
      provider: label,
      collectedAt: formatDay(snapshot?.collectedAt),
      statusType: snapshot?.data?.statusType || '',
      shown: summary?.shown ?? allRows.length,
      thresholds: summary?.thresholds || {},
    });
    saveBlob(
      new Blob([file], { type: 'text/plain;charset=utf-8;' }),
      disavowFilename({
        domain: data.project?.domain || '',
        periodKey: snapshot?.periodKey || '',
      })
    );
  };

  const runExport = (format) =>
    downloadLabsExport(
      {
        siteName: data.project?.name || data.project?.domain || 'Site',
        domain: data.project?.domain || '',
        variant: snapshot?.variant || data.variant,
        periodKey: snapshot?.periodKey || '',
        collectedAt: snapshot?.collectedAt || null,
        statusType: snapshot?.data?.statusType || '',
        rows: sorted,
        filtered: filtered.length !== allRows.length,
      },
      'toxicDomains',
      format
    );

  if (!snapshot) {
    return (
      <div className="flex flex-col gap-4">
        {!collected && <NotCollected label={label} what="Referring domains" />}
        <EmptyState
          icon={ShieldAlert}
          title="No referring domains collected yet"
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
      <LiveStamp
        freshness={{
          collectedAt: snapshot.collectedAt,
          statusType: snapshot.data?.statusType,
          index: snapshot.data?.index,
        }}
        label={label}
      />
      {!collected && <NotCollected label={label} what="Referring domains" />}

      <Panel>
        <StatRow>
          <Stat
            label="Suggested for disavow"
            value={formatNumber(summary?.disavow)}
            sub={`of ${formatNumber(summary?.shown)} domains examined`}
          />
          <Stat
            label="Links behind them"
            value={formatNumber(summary?.disavowBacklinks, { compact: true })}
            /**
             * The link count beside the domain count, because one sitewide
             * referrer is one line in the file and forty thousand links — and
             * the domain count alone hides which situation this is.
             */
            sub="one sitewide referrer can be most of this"
          />
          <Stat
            label="Worth watching"
            value={formatNumber(summary?.watch)}
            sub="one reason only — usually innocent"
          />
          <Stat
            label="Already gone"
            value={formatNumber(summary?.lost)}
            sub="nothing left to disavow"
          />
        </StatRow>
      </Panel>

      <div
        className="flex flex-wrap items-center gap-3 px-4 py-3"
        style={{
          background: 'var(--color-bg-subtle)',
          borderRadius: 'var(--radius-md)',
        }}
      >
        <p
          className="font-body flex-1"
          style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', minWidth: 260 }}
        >
          A domain is suggested only when at least{' '}
          {summary?.thresholds?.minSignals ?? 2} independent reasons apply to it and
          it is still linking. Review every line before uploading — disavowing a good
          link removes its value permanently, and this is a suggestion rather than a
          verdict.
        </p>
        <Button
          variant="secondary"
          icon={Download}
          onClick={downloadDisavow}
          disabled={!suggested.length}
        >
          {suggested.length
            ? `disavow.txt (${suggested.length} domain${suggested.length === 1 ? '' : 's'})`
            : 'Nothing to disavow'}
        </Button>
      </div>

      <LabsFilterBar
        query={query}
        onQuery={(v) => {
          setQuery(v);
          setPage(1);
        }}
        placeholder="Find a domain"
        buckets={TOXIC_BUCKETS}
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
              Nothing in the {formatNumber(summary?.shown)} referring domains examined
              carries a signal worth showing. That is the healthy answer.
            </p>
          </div>
        ) : (
          <>
            <ScrollTable maxHeight={520}>
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
                    <tr key={row.domain}>
                      <Td>
                        <div className="flex flex-col">
                          <span>{row.domain}</span>
                          <span
                            className="font-body"
                            style={{ fontSize: 11, color: verdictTone(row) }}
                          >
                            {verdictLabel(row)}
                          </span>
                        </div>
                      </Td>
                      <Td>
                        <span
                          className="font-body"
                          style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}
                        >
                          {row.signals.map(signalLabel).join('; ') || '—'}
                        </span>
                      </Td>
                      <Td align="right">{formatNumber(row.spamScore)}</Td>
                      <Td align="right">{formatNumber(row.backlinks, { compact: true })}</Td>
                      {/*
                        LINK STRENGTH, never "authority". This is the rank of the
                        links this domain sends US — a directory sending four
                        hundred sitewide links outranks a newspaper sending one.
                      */}
                      <Td align="right" title={RANK_CAPTION}>
                        {formatDomainRank(row.linksRank)}
                      </Td>
                      <Td align="right">{formatDay(row.firstSeen)}</Td>
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
              noun="domains"
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

      {/* ---- The subnet half. A separate question, and never in the file. --- */}
      {!networksCollected ? (
        <NotCollected label={label} what="Referring networks" />
      ) : !networkSnapshot ? (
        <Panel>
          <PanelHead
            title="IP blocks"
            sub="fills in on the next weekly run"
          />
          <p
            className="font-body px-4 py-4"
            style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}
          >
            Nothing collected yet for the subnet view.
          </p>
        </Panel>
      ) : (
        <Panel>
          <PanelHead
            title="Referrers sharing an IP block"
            sub={`grouped by ${networkTotals?.addressType || 'subnet'} — the signature per-domain spam scoring cannot see`}
            right={
              <CountChip>
                {formatNumber(networkTotals?.concentrated)} concentrated of{' '}
                {formatNumber(networkTotals?.shown)}
              </CountChip>
            }
          />
          <p
            className="font-body px-4 pt-3"
            style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
          >
            {networkTotals?.thresholds?.minDomains ?? 3} or more referrers on one
            block is what a private blog network looks like from outside. It is also
            what a reseller host looks like, so this is a count rather than an
            accusation — and nothing here goes into the disavow file, because
            Google&rsquo;s format has no line type for a network.
          </p>
          <ScrollTable maxHeight={320}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {NETWORK_COLUMNS.map((col) => (
                    <SortableTh
                      key={col.key}
                      column={col.sortKey}
                      sort={networkSort}
                      onSort={setNetworkSort}
                      align={col.align}
                      width={col.width}
                    >
                      {col.label}
                    </SortableTh>
                  ))}
                </tr>
              </thead>
              <tbody>
                {networkView.slice(0, 50).map((row) => (
                  <tr key={row.network}>
                    <Td>
                      <span
                        style={{
                          color: row.concentrated
                            ? 'var(--color-status-stuck)'
                            : 'var(--color-text-primary)',
                        }}
                      >
                        {row.network}
                      </span>
                    </Td>
                    <Td align="right">{formatNumber(row.referringDomains)}</Td>
                    <Td align="right">{formatNumber(row.backlinks, { compact: true })}</Td>
                    <Td align="right" title={RANK_CAPTION}>
                      {formatDomainRank(row.linksRank)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollTable>
        </Panel>
      )}
    </div>
  );
};

export default ToxicBacklinksScreen;
