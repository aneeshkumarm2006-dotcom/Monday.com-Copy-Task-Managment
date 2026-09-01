import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plug } from 'lucide-react';

import Spinner from '../../../ui/Spinner';
import EmptyState from '../../../ui/EmptyState';
import useTaskStore from '../../../../store/taskStore';
import useToastStore from '../../../../store/toastStore';
import {
  getConnectorData,
  refreshConnectorData,
  runConnectorAction,
} from '../../../../services/connectorService';
import { marketLabel } from '../../../../utils/connectorFormat';
import { resolveRangePreset } from '../../../../utils/dateRange';
import { OVERVIEW_KEY, screensFromKinds } from '../../../../utils/connectorScreens';

import {
  ProviderNav,
  ProviderNavBar,
  ProviderProjectBar,
  ScreenHeading,
} from './ProviderChrome';
import OverviewScreen from './OverviewScreen';
import PositionsSection from './PositionsSection';
import KeywordsSection from './KeywordsSection';
import SiteAuditSection from './SiteAuditSection';
import DomainSection from './DomainSection';
import BacklinksSection from './BacklinksSection';

// Recharts is ~95KB and only a handful of things in the app use it. A board
// sitting on any other tab must not download it — same treatment as
// goals/GoalTrendChart.
const KeywordTrendChart = lazy(() => import('./KeywordTrendChart'));

/**
 * The connector data tab — one project's readings, out of our own database.
 *
 * ---- Why this is `connector/` and not `ubersuggest/` -----------------------
 *
 * Nothing below names a provider. The screens are chosen by KIND KEY, and the
 * kind catalog arrives from the server as part of the payload — so a second
 * connector that declares `positions` gets the rank screen for free, and one
 * that declares a kind we have no component for is listed by name rather than
 * silently dropped. The provider's label comes from the server too.
 *
 * The design plan sketched this directory as `addons/ubersuggest/`. This is the
 * same shape with the provider taken out of the filenames, which is what the
 * plan's own rule — trade vocabulary lives in configuration, never in code —
 * asks for on this side of the wire as much as on the server's.
 *
 * ---- Why it looks like the other connector tab now -------------------------
 *
 * It used to be one long scroll: five section cards stacked in kind order, with
 * a project dropdown floating above them. That layout had three problems, and
 * they were the same three the SEO tab had before its own rework — no answer on
 * screen to WHICH SITE AM I LOOKING AT, no summary, so "is this client better
 * than last week" meant scrolling and doing arithmetic, and every visitor paying
 * to render every section to read one of them.
 *
 * So it is now the layout every tool of this kind converged on, and — the point
 * — the SAME layout, out of the SAME components: `ProviderChrome` draws the
 * project bar, the grouped rail and the per-screen heading for both tabs. A user
 * reading two clients' data in one afternoon should not have to learn where the
 * Refresh button is twice.
 *
 * What it is NOT is the other tab's data path. This provider declares no
 * `screens`, so the rail is DERIVED from its kind catalog by
 * `utils/connectorScreens.js` — an empty selection means everything, a kind with
 * a stored reading survives being switched off, and the headings come off
 * `kind.subject`. Those rules are pure and under test; see that file. Giving
 * this provider a hand-written screen list on the server instead would be a
 * second catalog to keep in step with its kinds, and — because
 * `BoardDetailPage` splits the two tabs on whether a provider declares screens —
 * would route it into the other tab's dataforseo-shaped components.
 *
 * ---- Why nothing here fetches from the provider ----------------------------
 *
 * Quota at this provider is finite and shared across the entire workspace, and
 * it is spent on FETCH, never on view. Everything this tab renders comes out of
 * `ConnectorSnapshot`. If it fetched on mount, ten people with a browser open
 * would exhaust the week on page loads and a third-party outage would blank a
 * tab full of data we already hold. Refresh is a button, held by
 * `connector.manage`, and the weekly runner is the only other thing that spends.
 *
 * ---- Tab doctrine ----------------------------------------------------------
 *
 * No new Zustand slice — the same rule stated in `goals/GoalsTab.jsx`,
 * `delivery/DeliveryTab.jsx`, `scoreboard/ScoreboardTab.jsx` and
 * `seo/SeoDashboardTab.jsx`. Component state plus a service, refetching on the
 * existing SSE `board.changed` signal with the same 1500 ms debounce and
 * `{ quiet: true }`. A 403/404 renders as an EmptyState carrying the server's
 * own sentence, never a toast — "you cannot see this" is information, not an
 * error.
 */

/** Kind key → the component that renders its screen. */
const SCREENS = {
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

  // The things the user steers, held in component state rather than the URL.
  // Unlike the board's month — which is worth pasting to a colleague — a project,
  // a keyword and a reading window are a reading POSITION, and putting them in
  // the URL would mean a history entry per click on a chart icon.
  const [screen, setScreen] = useState(OVERVIEW_KEY);
  const [projectId, setProjectId] = useState('');
  const [variant, setVariant] = useState('');
  const [keyword, setKeyword] = useState('');

  /**
   * How far back the stored series is drawn.
   *
   * Sent to the server, which is what makes it a WINDOW rather than a filter:
   * the trend query is bounded server-side against `periodKey`, so a three-year
   * board does not send three years of points to draw twelve months. The
   * endpoint has always accepted `from`/`to` — this tab simply never asked.
   */
  const [range, setRange] = useState(() => ({
    preset: '90d',
    ...resolveRangePreset('90d', { from: '', to: '' }),
  }));

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
          from: range.from,
          to: range.to,
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
    [boardId, provider, projectId, variant, keyword, range.from, range.to]
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
  //
  // `[boardRefreshSignal]` ONLY — the doctrine's dep array. Adding `load` would
  // re-arm the timer on every keystroke in the rank filter.
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
      // `marketLabel` rather than a second spelling of the same parse. It reads
      // both providers' variant keys and it is what the other tab prints, so
      // one market cannot be named two ways in one app.
      (data?.variants || []).map((v) => ({ value: v, label: marketLabel(v) })),
    [data]
  );

  /**
   * The rail: this provider's kinds, arranged. See `utils/connectorScreens.js`
   * for the three rules and why they are pure.
   */
  const { screens, groups } = useMemo(
    () =>
      screensFromKinds({
        kinds: data?.provider?.kinds,
        selectedKinds: data?.selectedKinds,
        snapshots: data?.snapshots,
      }),
    [data]
  );

  // A stored screen that is no longer rendered — a kind switched off for this
  // board, or removed from the provider — falls back to the first one rather
  // than showing a blank panel.
  const activeScreen = screens.some((s) => s.key === screen)
    ? screen
    : screens[0]?.key || OVERVIEW_KEY;

  // A board collecting exactly one kind gets no nav at all: a rail with a single
  // item is a label pretending to be a choice.
  const multiScreen = screens.length > 1;

  // Declared above the handlers rather than beside the render, because `refresh`
  // closes over it and a const declared later would be in its temporal dead zone.
  const label = data?.provider?.label || providerLabel || 'Connector';

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
          `${label} is out of quota on at least one account. Report limits reset daily and credits monthly.`
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
    // Doctrine: the server's own sentence, in place, never a toast.
    return <EmptyState icon={Plug} title={providerLabel || 'Connector'} description={error} />;
  }

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

  const screenMeta = screens.find((s) => s.key === activeScreen) || null;
  const Screen = SCREENS[activeScreen];
  const snapshot = data.snapshots?.[activeScreen] || null;

  /**
   * The screen body.
   *
   * A function rather than more nesting below, because three of the entries need
   * props the others do not and inlining them all inside the shell buried the
   * layout under the special cases.
   */
  const renderScreen = () => {
    if (activeScreen === OVERVIEW_KEY) {
      return (
        <OverviewScreen
          data={data}
          label={label}
          onSelectKeyword={(k) => {
            setKeyword(k);
            setScreen('positions');
          }}
          onOpenScreen={setScreen}
        />
      );
    }

    // A kind the server declares that this client has no component for. Named
    // rather than dropped, so a provider gaining a kind is visible here instead
    // of silently missing.
    if (!Screen) {
      return (
        <EmptyState
          icon={Plug}
          title={screenMeta?.label || 'Not available yet'}
          description={`${label} collects this, but this version of the app does not display it yet.`}
        />
      );
    }

    if (activeScreen === 'positions') {
      return (
        <PositionsSection
          kind={screenMeta}
          snapshot={snapshot}
          showTitle={false}
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

    if (activeScreen === 'site_audit') {
      return (
        <SiteAuditSection
          kind={screenMeta}
          snapshot={snapshot}
          showTitle={false}
          canManage={data.canManage}
          project={data.project}
          onRunAudit={runAudit}
        />
      );
    }

    return <Screen kind={screenMeta} snapshot={snapshot} showTitle={false} />;
  };

  return (
    <div className="mt-5">
      {/* ---------------------------------------------------------------------
          The shell: one card holding the project bar, the rail and the screen.
          Same components as the other connector tab — see `ProviderChrome`.
      --------------------------------------------------------------------- */}
      <div
        style={{
          background: 'var(--color-bg-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-lg)',
          overflow: 'hidden',
        }}
      >
        <ProviderProjectBar
          project={data.project}
          projectOptions={projectOptions}
          projectId={projectId}
          onProjectChange={(value) => {
            setProjectId(value);
            // A keyword and a market belong to the project whose table they came
            // from. Carrying either across would ask for a variant this project
            // has never produced.
            setKeyword('');
            setVariant('');
          }}
          variantOptions={variantOptions}
          variant={variant}
          // Only offered when there is a choice. A US rank and a UK rank for one
          // keyword are two facts, and mixing them would flip the table between
          // markets week to week.
          onVariantChange={(v) => {
            setVariant(v);
            setKeyword('');
          }}
          range={range}
          onRangeChange={setRange}
          queued={data.queued}
          canManage={data.canManage}
          // Never collectable again — see the banner below. Disabled rather
          // than hidden: a control that vanishes reads as a permission problem.
          refreshDisabled={data.project.missing}
          refreshing={refreshing}
          onRefresh={refresh}
        />

        {data.project.missing && (
          <p
            className="font-body px-4 py-2.5"
            style={{
              fontSize: 12.5,
              background: 'var(--color-warning-light, #FEF3C7)',
              color: 'var(--color-warning-text, #92400E)',
              borderBottom: '1px solid var(--color-border)',
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
            className="font-body px-4 py-2.5"
            style={{
              fontSize: 12.5,
              background: 'var(--color-bg-subtle)',
              color: 'var(--color-text-secondary)',
              borderBottom: '1px solid var(--color-border)',
            }}
          >
            {label} is switched off for this board, so nothing is being
            collected. Past readings are kept — switch it back on under{' '}
            <Link
              to="?view=addons"
              className="underline"
              style={{ color: 'var(--color-accent)' }}
            >
              Add-ons
            </Link>
            .
          </p>
        )}

        <div className="flex items-stretch">
          {multiScreen && (
            <ProviderNav
              screens={screens}
              groups={groups}
              active={activeScreen}
              onChange={setScreen}
            />
          )}

          <div className="flex-1 min-w-0">
            {/* The same nav, as a scrolling row, below `lg`. */}
            {multiScreen && (
              <ProviderNavBar
                screens={screens}
                active={activeScreen}
                onChange={setScreen}
              />
            )}

            {/* ---- The screen ------------------------------------------------
                On the page's own background rather than the card's, so the
                sections inside it read as cards instead of as one flat sheet.
            ---------------------------------------------------------------- */}
            <div
              className="px-4 py-4 lg:px-5 lg:py-5"
              style={{ background: 'var(--color-bg-base)', minHeight: 380 }}
            >
              {/* The blurb has been on every kind since the catalog was written
                  and was never rendered. It belongs here: nothing on this tab is
                  live, and the sentence saying how often a number moves is the
                  difference between trusting it correctly and trusting it
                  blindly. */}
              <ScreenHeading screen={screenMeta} />
              {renderScreen()}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ConnectorDataTab;
