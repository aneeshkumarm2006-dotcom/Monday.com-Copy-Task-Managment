import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plug, RefreshCw } from 'lucide-react';

import Button from '../../../ui/Button';
import Dropdown from '../../../ui/Dropdown';
import Spinner from '../../../ui/Spinner';
import EmptyState from '../../../ui/EmptyState';
import useTaskStore from '../../../../store/taskStore';
import useToastStore from '../../../../store/toastStore';
import {
  getConnectorData,
  refreshConnectorData,
  runConnectorAction,
} from '../../../../services/connectorService';
import { staleness } from '../../../../utils/connectorFormat';

import PositionsSection from './PositionsSection';
import KeywordsSection from './KeywordsSection';
import SiteAuditSection from './SiteAuditSection';
import DomainSection from './DomainSection';
import BacklinksSection from './BacklinksSection';

// Recharts is ~95KB and only two things in the app use it. A board sitting on
// any other tab must not download it — same treatment as goals/GoalTrendChart.
const KeywordTrendChart = lazy(() => import('./KeywordTrendChart'));

/**
 * The connector data tab — one project's readings, out of our own database.
 *
 * ---- Why this is `connector/` and not `ubersuggest/` -----------------------
 *
 * Nothing below names a provider. The sections are chosen by KIND KEY, and the
 * kind catalog arrives from the server as part of the payload — so a second
 * connector that declares `positions` gets the positions section for free, and
 * one that declares a kind we have no component for is listed by name rather
 * than silently dropped. The provider's label comes from the server too.
 *
 * The design plan sketched this directory as `addons/ubersuggest/`. This is the
 * same shape with the provider taken out of the filenames, which is what the
 * plan's own rule — trade vocabulary lives in configuration, never in code —
 * asks for on this side of the wire as much as on the server's.
 *
 * ---- Why nothing here fetches from the provider ----------------------------
 *
 * Quota at Ubersuggest is finite and shared across the entire workspace, and it
 * is spent on FETCH, never on view. Everything this tab renders comes out of
 * `ConnectorSnapshot`. If it fetched on mount, ten people with a browser open
 * would exhaust the week on page loads and a third-party outage would blank a
 * tab full of data we already hold. Refresh is a button, held by
 * `connector.manage`, and the weekly runner is the only other thing that spends.
 *
 * ---- Tab doctrine ----------------------------------------------------------
 *
 * No new Zustand slice — the same rule stated in `goals/GoalsTab.jsx`,
 * `delivery/DeliveryTab.jsx` and `scoreboard/ScoreboardTab.jsx`. Component state
 * plus a service, refetching on the existing SSE `board.changed` signal with the
 * same 1500 ms debounce and `{ quiet: true }`. A 403/404 renders as an
 * EmptyState carrying the server's own sentence, never a toast — "you cannot see
 * this" is information, not an error.
 */

/** Kind key → the component that renders it. */
const SECTIONS = {
  positions: PositionsSection,
  keyword_metrics: KeywordsSection,
  site_audit: SiteAuditSection,
  domain_overview: DomainSection,
  backlinks: BacklinksSection,
};

const ConnectorDataTab = ({ boardId, provider, providerLabel }) => {
  const toastError = useToastStore((s) => s.error);
  const toastSuccess = useToastStore((s) => s.success);
  const toastInfo = useToastStore((s) => s.info);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  // The three things the user steers, held in component state rather than the
  // URL. Unlike the board's month — which is worth pasting to a colleague — a
  // project and a keyword are a reading position, and putting them in the URL
  // would mean a history entry per click on a chart icon.
  const [projectId, setProjectId] = useState('');
  const [variant, setVariant] = useState('');
  const [keyword, setKeyword] = useState('');

  const boardRefreshSignal = useTaskStore((s) => s.boardRefreshSignal);
  const boardRefreshTarget = useTaskStore((s) => s.boardRefreshTarget);

  // Guards a race the debounce below makes real: a quiet refetch fired for the
  // previous project can land after the user has switched, and would overwrite
  // the new project's data with the old one's.
  const requestRef = useRef(0);

  const load = useCallback(
    async ({ quiet = false } = {}) => {
      if (!boardId || !provider) return;
      if (!quiet) setLoading(true);
      const ticket = ++requestRef.current;
      try {
        const next = await getConnectorData(boardId, provider, {
          project: projectId,
          variant,
          keyword,
        });
        if (ticket !== requestRef.current) return;
        setData(next);
        // The server decides which project and variant are in effect when we
        // sent none — adopt its answer so the pickers agree with the table.
        if (!projectId && next.project) setProjectId(String(next.project._id));
        if (!variant && next.variant) setVariant(next.variant);
        setError(null);
      } catch (err) {
        if (ticket !== requestRef.current) return;
        setError(
          err?.response?.data?.error ||
            'Could not load this board’s connector data.'
        );
      } finally {
        if (ticket === requestRef.current) setLoading(false);
      }
    },
    [boardId, provider, projectId, variant, keyword]
  );

  useEffect(() => {
    load();
  }, [load]);

  // Drop the previous board's readings the instant the board changes, so a
  // stale project id cannot survive into a board that has never heard of it.
  useEffect(() => {
    setData(null);
    setProjectId('');
    setVariant('');
    setKeyword('');
  }, [boardId]);

  // Live refresh off the existing SSE path, debounced — the same shape and the
  // same reason as DeliveryTab: a runner finishing five projects must not fire
  // five refetches. The runner fans `board.changed` out to everyone holding
  // `connector.view`, because nobody triggered it.
  useEffect(() => {
    if (boardRefreshTarget !== boardId) return undefined;
    const t = setTimeout(() => load({ quiet: true }), 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardRefreshSignal]);

  const projectOptions = useMemo(
    () =>
      (data?.projects || []).map((p) => ({
        value: String(p._id),
        label: [
          p.name || p.domain || p.externalId,
          p.mappedHere ? null : '(not mapped here)',
          p.missing ? '· gone from the provider' : null,
        ]
          .filter(Boolean)
          .join(' '),
      })),
    [data]
  );

  const variantOptions = useMemo(
    () =>
      (data?.variants || []).map((v) => {
        const [device, lang, loc] = v.split('|');
        return {
          value: v,
          label:
            v === 'default'
              ? 'Default'
              : [device, lang !== 'any' ? lang.toUpperCase() : null, loc !== 'any' ? `loc ${loc}` : null]
                  .filter(Boolean)
                  .join(' · '),
        };
      }),
    [data]
  );

  const refresh = async () => {
    setRefreshing(true);
    try {
      const { report } = await refreshConnectorData(boardId, provider, {
        project: projectId || undefined,
      });
      const failed = (report?.accounts || []).filter(
        (a) => a.failed > 0 || a.quotaExhausted || a.needsReauth || a.error
      );
      if (report?.quotaExhausted) {
        toastInfo(
          'Ubersuggest is out of quota on at least one account. Report limits reset daily and credits monthly.'
        );
      } else if (report?.needsReauth) {
        toastError(
          'At least one account needs reconnecting under Settings → Connectors.'
        );
      } else if (failed.length) {
        toastError(failed[0].error || 'Some data could not be collected.');
      } else {
        toastSuccess(
          report?.written
            ? `${report.written} new reading${report.written === 1 ? '' : 's'} collected.`
            : 'Everything was already up to date.'
        );
      }
      await load({ quiet: true });
    } catch (err) {
      toastError(
        err?.response?.data?.error || 'Could not refresh that connector data.'
      );
    } finally {
      setRefreshing(false);
    }
  };

  const runAudit = async () => {
    try {
      const res = await runConnectorAction(boardId, provider, projectId, 'audit');
      // A crawl takes minutes, so the honest message is "started" — claiming an
      // audit we do not have yet would be a lie the next refresh exposes.
      toastSuccess(res.note || 'Audit started. It takes a few minutes.');
      await load({ quiet: true });
    } catch (err) {
      toastError(err?.response?.data?.error || 'Could not start that audit.');
    }
  };

  if (loading && !data) {
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );
  }

  if (error) {
    return <EmptyState icon={Plug} title={providerLabel || 'Connector'} description={error} />;
  }

  const label = data?.provider?.label || providerLabel || 'Connector';

  if (!data?.project) {
    return (
      <div className="mt-5">
        <EmptyState
          icon={Plug}
          title={`No ${label} data yet`}
          description={
            data?.canManage
              ? 'Map a project to a group under Add-ons, then refresh. Nothing is fetched when you open this tab — the quota is shared across the whole workspace.'
              : 'Nobody has mapped a project to a group on this board yet.'
          }
        />
      </div>
    );
  }

  // Only the kinds this provider declares, in the order it declares them — so a
  // provider that gains a section gains it here without a change to this file.
  const kinds = data.provider?.kinds || [];

  return (
    <div className="mt-5 flex flex-col gap-4">
      {/* ---- Controls -------------------------------------------------------- */}
      <div className="flex flex-wrap items-end gap-3">
        <div style={{ minWidth: 240 }}>
          <Dropdown
            label="Project"
            size="sm"
            options={projectOptions}
            value={projectId}
            onChange={(value) => {
              setProjectId(value);
              // A keyword belongs to the project whose table it came from.
              setKeyword('');
              setVariant('');
            }}
          />
        </div>

        {variantOptions.length > 1 && (
          <div style={{ minWidth: 190 }}>
            <Dropdown
              // Only shown when there is a choice. A US rank and a UK rank for
              // the same keyword are two facts, and mixing them would flip the
              // table between markets week to week.
              label="Market"
              size="sm"
              options={variantOptions}
              value={variant}
              onChange={setVariant}
            />
          </div>
        )}

        <div className="flex-1" />

        <div className="flex items-center gap-3">
          <p
            className="font-body text-right"
            style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}
          >
            {data.project.lastFetchedAt
              ? `Last collected ${staleness(data.project.lastFetchedAt)}`
              : 'Never collected'}
            <br />
            {/* Stated plainly, because it is the thing that makes the numbers
                trustworthy AND the thing that explains why they are not live. */}
            Rankings update weekly at {label}.
          </p>
          {data.canManage && (
            <Button
              variant="secondary"
              icon={RefreshCw}
              onClick={refresh}
              disabled={refreshing || data.project.missing}
            >
              {refreshing ? 'Collecting…' : 'Refresh'}
            </Button>
          )}
        </div>
      </div>

      {data.project.missing && (
        <p
          className="font-body px-3 py-2.5"
          style={{
            fontSize: 12.5,
            borderRadius: 'var(--radius-md)',
            background: 'var(--color-warning-light, #FEF3C7)',
            color: 'var(--color-warning-text, #92400E)',
          }}
        >
          This project no longer exists at {label}, so nothing new can be
          collected for it. Everything below is kept — per-keyword rank history
          is not retrievable from their API, so these readings are the only copy
          there will ever be.
        </p>
      )}

      {!data.enabled && (
        <p
          className="font-body"
          style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}
        >
          {label} is switched off for this board, so nothing is being collected.
          Past readings are kept — switch it back on under{' '}
          <Link to={`?view=addons`} className="underline" style={{ color: 'var(--color-accent)' }}>
            Add-ons
          </Link>
          .
        </p>
      )}

      {/* ---- Sections -------------------------------------------------------- */}
      {kinds.map((kind) => {
        const Section = SECTIONS[kind.key];
        const snapshot = data.snapshots?.[kind.key] || null;

        // A kind the server declares but this client has no component for. Named
        // rather than dropped, so a provider adding a section is visible here
        // instead of silently missing.
        if (!Section) {
          return (
            <p
              key={kind.key}
              className="font-body"
              style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}
            >
              {kind.label} is collected but not yet displayed here.
            </p>
          );
        }

        if (kind.key === 'positions') {
          return (
            <PositionsSection
              key={kind.key}
              kind={kind}
              snapshot={snapshot}
              keywordHistory={data.keywordHistory}
              onSelectKeyword={setKeyword}
              historyChart={
                data.keywordHistory ? (
                  <Suspense
                    fallback={
                      <div className="flex justify-center py-8">
                        <Spinner />
                      </div>
                    }
                  >
                    <KeywordTrendChart history={data.keywordHistory} />
                  </Suspense>
                ) : null
              }
            />
          );
        }

        if (kind.key === 'site_audit') {
          return (
            <SiteAuditSection
              key={kind.key}
              kind={kind}
              snapshot={snapshot}
              canManage={data.canManage}
              project={data.project}
              onRunAudit={runAudit}
            />
          );
        }

        return <Section key={kind.key} kind={kind} snapshot={snapshot} />;
      })}
    </div>
  );
};

export default ConnectorDataTab;
