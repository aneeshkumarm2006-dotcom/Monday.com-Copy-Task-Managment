import { useState } from 'react';
import { Play, ShieldCheck } from 'lucide-react';
import SectionShell, { Stat, StatRow } from './SectionShell';
import Button from '../../../ui/Button';
import { formatNumber } from '../../../../utils/connectorFormat';

/** The three buckets the provider reports, with the tone each deserves. */
const CATEGORIES = [
  { key: 'errors', label: 'Errors', color: '#DC2626' },
  { key: 'warnings', label: 'Warnings', color: 'var(--color-card-orange)' },
  { key: 'recommendations', label: 'Recommendations', color: 'var(--color-card-blue)' },
];

/**
 * Site audit — the last completed crawl, plus the button that starts a new one.
 *
 * ---- Why starting a crawl is a button and not part of the weekly run -------
 *
 * A crawl is minutes of somebody else's compute and is capped by plan. An
 * unattended job that started one for every domain in the workspace every week
 * is how an integration gets switched off from the far side, so the scheduled
 * read only ever fetches the LAST COMPLETED crawl. That has one visible
 * consequence, handled here: a domain nobody has ever audited has nothing to
 * read, and the section says so with the button rather than looking broken.
 *
 * ---- Why there is no history here ------------------------------------------
 *
 * There is no audit history at Ubersuggest — the only historical artefact the
 * API exposes is a single delta against the immediately previous crawl. Our own
 * snapshots accumulate, so a future phase can chart the health score; the
 * provider will never be able to backfill it.
 *
 * Issue ids are not enumerated anywhere in the documentation and are discovered
 * at runtime from the response, which is why the list below is rendered from
 * whatever arrived rather than from a fixed set of known issues.
 */
const SiteAuditSection = ({
  kind,
  snapshot,
  canManage,
  onRunAudit,
  project,
  showTitle = true,
}) => {
  const [running, setRunning] = useState(false);

  const data = snapshot?.data;
  const totals = data?.totals || {};
  const crawling = snapshot && data && data.done === false;
  const failed = data?.extendedStatus && data.extendedStatus !== 'no_errors';

  const run = async () => {
    setRunning(true);
    try {
      await onRunAudit();
    } finally {
      setRunning(false);
    }
  };

  const auditButton = canManage && project?.domain ? (
    <Button
      variant="secondary"
      icon={Play}
      onClick={run}
      disabled={running || crawling}
    >
      {running ? 'Starting…' : crawling ? 'Crawling…' : 'Run audit'}
    </Button>
  ) : null;

  return (
    <SectionShell
      kind={kind}
      snapshot={snapshot}
      icon={ShieldCheck}
      showTitle={showTitle}
      actions={auditButton}
      emptyTitle="No audit for this domain yet"
      emptyDescription={
        canManage
          ? 'Run one to crawl the site. It takes a few minutes, and the result appears here on the next refresh.'
          : 'Somebody with edit access on this board can start a crawl.'
      }
    >
      {failed ? (
        <p
          className="font-body px-4 pt-3"
          style={{ fontSize: 12.5, color: '#DC2626' }}
        >
          The crawl itself did not complete cleanly ({data.extendedStatus}). The
          counts below are whatever it reached — that is different from a site
          with no problems.
        </p>
      ) : null}

      <StatRow>
        <Stat
          label="Health score"
          value={data?.healthScore === null || data?.healthScore === undefined
            ? '—'
            : `${formatNumber(data.healthScore)}`}
          sub="out of 100"
        />
        {CATEGORIES.map((c) => (
          <Stat key={c.key} label={c.label} value={formatNumber(totals[c.key])} />
        ))}
        <Stat
          label="Pages crawled"
          value={formatNumber(data?.crawled)}
          sub={
            data?.crawlMaxPages
              ? `of ${formatNumber(data.crawlMaxPages)}`
              : undefined
          }
        />
      </StatRow>

      <div
        className="grid gap-0"
        style={{ borderTop: '1px solid var(--color-border)' }}
      >
        {CATEGORIES.map((category) => {
          const issues = data?.categories?.[category.key] || [];
          if (!issues.length) return null;
          return (
            <div key={category.key} className="px-4 py-3">
              <p
                className="font-body font-medium mb-2"
                style={{ fontSize: 12, color: category.color }}
              >
                {category.label}
              </p>
              <ul className="flex flex-col gap-1">
                {issues.map((issue) => (
                  <li
                    key={issue.id || issue.name}
                    className="flex items-center justify-between gap-3 font-body"
                    style={{ fontSize: 13, color: 'var(--color-text-primary)' }}
                  >
                    <span className="truncate">{issue.name}</span>
                    <span
                      className="shrink-0"
                      style={{ color: 'var(--color-text-muted)' }}
                    >
                      {formatNumber(issue.count)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </SectionShell>
  );
};

export default SiteAuditSection;
