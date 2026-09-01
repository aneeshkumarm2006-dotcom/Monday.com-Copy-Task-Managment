import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plug } from 'lucide-react';

import Button from '../../../ui/Button';
import Modal from '../../../ui/Modal';
import Spinner from '../../../ui/Spinner';
import EmptyState from '../../../ui/EmptyState';
import { resolveRangePreset } from '../../../../utils/dateRange';
import useTaskStore from '../../../../store/taskStore';
import useToastStore from '../../../../store/toastStore';
import {
  getConnectorData,
  getConnectorUsage,
  refreshConnectorData,
} from '../../../../services/connectorService';
import { marketLabel } from '../../../../utils/connectorFormat';

import {
  ProviderNav,
  ProviderNavBar,
  ProviderProjectBar,
  ScreenHeading,
} from '../connector/ProviderChrome';
import OverviewScreen from './OverviewScreen';
import RankTrackingScreen from './RankTrackingScreen';
import KeywordResearchScreen from './KeywordResearchScreen';
import CompetitorsScreen from './CompetitorsScreen';
import TopPagesScreen from './TopPagesScreen';
import BacklinksScreen from './BacklinksScreen';
import SiteAuditScreen from './SiteAuditScreen';
import AiVisibilityScreen from './AiVisibilityScreen';
import CannibalizationScreen from './CannibalizationScreen';
import ToxicBacklinksScreen from './ToxicBacklinksScreen';
import AlertsScreen from './AlertsScreen';
import ClientReportScreen from './ClientReportScreen';
import LocalScreen from './LocalScreen';
import UsageScreen from './UsageScreen';

/**
 * The SEO dashboard — one provider's screens, out of our own database.
 *
 * ---- Why this is a second tab and not more sections in the first one --------
 *
 * `ConnectorDataTab` renders one SCREEN per snapshot kind, deriving its rail
 * from the kind catalog. That is exactly right for a provider with five kinds
 * and one number each. This provider is a rank tracker with a competitive
 * census behind it, and phases 6-8 add keyword research, competitors, backlinks
 * and a site audit — four more screens, each with its own table, its own sort
 * and its own export, plus alerts and a spend ledger that no kind describes. So
 * its screen list is DECLARED on the server rather than derived, and the two
 * tabs share the shell (`connector/ProviderChrome`) rather than the data path.
 *
 * Neither tab names a provider. The SCREENS come from the server as part of the
 * payload (`data.provider.screens`, narrowed by `data.selectedScreens`), the
 * same way the other tab takes its sections from the kind catalog — so a screen
 * added in phase 7 appears in this nav the day the descriptor declares it, and
 * one this client has no component for is NAMED rather than silently dropped.
 *
 * Which of the two tabs a provider gets is decided by whether it declares
 * screens at all. That is also what fixed `enabledConnectors[0]` on the board
 * page: a board with both connectors switched on used to show whichever came
 * back first and drop the other one entirely.
 *
 * ---- The shell lives in `connector/ProviderChrome` --------------------------
 *
 * The nav, the project bar and the per-screen heading were lifted out when the
 * flat row of fourteen buttons became a grouped rail, and moved again — into
 * `connector/`, under a name that carries no provider — when the OTHER connector
 * tab adopted the same layout. This file is the data and the state; that one is
 * the layout, and it is now shared. The grouping is
 * the descriptor's too — `screen.group` against `provider.screenGroups` — for
 * the same reason the screen list is, so a screen declared in a later phase
 * lands under the right heading with nothing in the client to edit.
 *
 * ---- Why nothing here fetches from the provider ----------------------------
 *
 * THIS ONE BILLS AT POST. Every reading below came out of `ConnectorSnapshot`
 * and every number on the Usage screen came out of `ConnectorBudget` and our own
 * task ledger. A tab that fetched on mount would not merely spend a shared
 * quota — it would BUY SERPs on a page load, per viewer, per render. Refresh is
 * a button, it is held by `connector.manage`, and on this provider it does not
 * even force a re-buy unless a person confirms it in a dialog.
 *
 * ---- Tab doctrine ----------------------------------------------------------
 *
 * Stated verbatim in `goals/GoalsTab.jsx`, `delivery/DeliveryTab.jsx`,
 * `scoreboard/ScoreboardTab.jsx` and `connector/ConnectorDataTab.jsx`, and
 * followed here: no new Zustand slice; component state plus a service; a
 * `{quiet: true}` refetch on the existing SSE `board.changed` signal with a
 * 1500 ms debounce and a `[boardRefreshSignal]`-only dependency array; and a
 * 403/404 rendered as an `EmptyState` carrying the server's own sentence, never
 * a toast — "you cannot see this" is information, not an error.
 *
 * The request-ticket race guard and the clear-on-`boardId`-change below are
 * `ConnectorDataTab`'s, copied deliberately: the debounce makes the race real,
 * because a quiet refetch fired for the previous project can land after the user
 * has switched and overwrite the new project's data with the old one's.
 */

/**
 * Screen key → the component that renders it.
 *
 * The key comes from `dataforseo/screens.js`, which is where a screen EXISTS. A
 * key declared there with no entry here renders as a named placeholder rather
 * than disappearing — see the bottom of this file — which is what lets a
 * descriptor entry ship a release ahead of its component.
 */
const SCREENS = {
  overview: OverviewScreen,
  rank_tracking: RankTrackingScreen,
  keyword_research: KeywordResearchScreen,
  competitors: CompetitorsScreen,
  top_pages: TopPagesScreen,
  backlinks: BacklinksScreen,
  site_audit: SiteAuditScreen,
  // Phase 10's Extras. Four of the six read snapshots other screens already pay
  // for; `toxic_backlinks` adds one Backlinks call a week and `local` one
  // gated Maps lookup. Whether a board renders any of them is
  // `BoardConnector.enabledScreens`, which is local and free to narrow —
  // unlike `kinds`, which is unioned across every board mapping the same site.
  ai_visibility: AiVisibilityScreen,
  cannibalization: CannibalizationScreen,
  toxic_backlinks: ToxicBacklinksScreen,
  alerts: AlertsScreen,
  client_report: ClientReportScreen,
  local: LocalScreen,
  usage: UsageScreen,
};

const SeoDashboardTab = ({ boardId, provider, providerLabel }) => {
  const toastError = useToastStore((s) => s.error);
  const toastSuccess = useToastStore((s) => s.success);
  const toastInfo = useToastStore((s) => s.info);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [confirmBuy, setConfirmBuy] = useState(false);

  /**
   * The money screen's payload, fetched only when that screen is opened.
   *
   * Two requests rather than one, deliberately. The ledger walks a task table
   * and answers a question nobody asks while reading a rank table, and folding
   * it into the main read would put that work on every board load for the
   * benefit of a screen most visits never open.
   */
  const [usage, setUsage] = useState(null);
  const [usageLoading, setUsageLoading] = useState(false);

  const [screen, setScreen] = useState('overview');
  const [projectId, setProjectId] = useState('');
  const [variant, setVariant] = useState('');
  const [keyword, setKeyword] = useState('');

  /**
   * How far back the stored series is drawn.
   *
   * Held here rather than in the URL, like the site and the market and for the
   * same reason: a reading position is not the thing worth pasting to a
   * colleague, and putting it in the URL would mean a history entry per click.
   *
   * Sent to the server, which is what makes it a WINDOW rather than a filter —
   * the trend query is bounded server-side against `periodKey`, so a three-year
   * board does not send three years of points to draw twelve months.
   */
  const [range, setRange] = useState(() => ({
    preset: '90d',
    ...resolveRangePreset('90d', { from: '', to: '' }),
  }));

  const boardRefreshSignal = useTaskStore((s) => s.boardRefreshSignal);
  const boardRefreshTarget = useTaskStore((s) => s.boardRefreshTarget);

  // Guards the race the debounce below makes real. See the header.
  const requestRef = useRef(0);
  const usageRequestRef = useRef(0);

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
        // sent none — adopt its answer so the pickers agree with the tables.
        if (!projectId && next.project) setProjectId(String(next.project._id));
        if (!variant && next.variant) setVariant(next.variant);
        setError(null);
      } catch (err) {
        if (ticket !== requestRef.current) return;
        setError(
          err?.response?.data?.error ||
            'Could not load this board’s SEO data.'
        );
      } finally {
        if (ticket === requestRef.current) setLoading(false);
      }
    },
    [boardId, provider, projectId, variant, keyword, range.from, range.to]
  );

  const loadUsage = useCallback(
    async ({ quiet = false } = {}) => {
      if (!boardId || !provider) return;
      if (!quiet) setUsageLoading(true);
      const ticket = ++usageRequestRef.current;
      try {
        const next = await getConnectorUsage(boardId, provider);
        if (ticket !== usageRequestRef.current) return;
        setUsage(next);
      } catch {
        // The spend panel failing must not take the rest of the tab with it;
        // the screen renders its own empty state from a null payload.
        if (ticket === usageRequestRef.current) setUsage(null);
      } finally {
        if (ticket === usageRequestRef.current) setUsageLoading(false);
      }
    },
    [boardId, provider]
  );

  useEffect(() => {
    load();
  }, [load]);

  // Fetched on first open and refreshed on later ones, so a person who has just
  // pressed Refresh sees the new job appear in the queue.
  useEffect(() => {
    if (screen === 'usage') loadUsage({ quiet: !!usage });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, loadUsage]);

  // Drop the previous board's readings the instant the board changes, so a
  // stale project id cannot survive into a board that has never heard of it.
  useEffect(() => {
    setData(null);
    setUsage(null);
    setProjectId('');
    setVariant('');
    setKeyword('');
  }, [boardId]);

  /**
   * Live refresh off the existing SSE path, debounced.
   *
   * It matters more here than on the sibling tabs: snapshots land OUT OF BAND on
   * this provider. A ten-minute collection cron writes results for work bought
   * hours ago with nobody watching, and `announceBoards` fans `board.changed`
   * out to everyone holding `connector.view` precisely so a tab left open fills
   * itself in rather than showing "queued" until somebody reloads.
   *
   * `[boardRefreshSignal]` ONLY — the doctrine's dep array. Adding `load` would
   * re-arm the timer on every keystroke in the rank filter.
   */
  useEffect(() => {
    if (boardRefreshTarget !== boardId) return undefined;
    const t = setTimeout(() => {
      load({ quiet: true });
      if (screen === 'usage') loadUsage({ quiet: true });
    }, 1500);
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
        ]
          .filter(Boolean)
          .join(' '),
      })),
    [data]
  );

  const variantOptions = useMemo(
    () =>
      (data?.variants || []).map((v) => ({ value: v, label: marketLabel(v) })),
    [data]
  );

  /**
   * The screens this board renders: the provider's catalog, narrowed by what the
   * board asked for. Both come from the server — the client must not re-derive
   * "empty means everything" or "the money screen is always on".
   */
  const screens = useMemo(() => {
    const catalog = data?.provider?.screens || [];
    // An EMPTY answer means everything, not nothing — the same rule the server
    // applies to an empty `kinds` selection, and the reason it is spelled again
    // here is a server that predates `selectedScreens` and sends none. Reading
    // that as "render nothing" would blank the tab with no error to explain it.
    const allowed = new Set(
      data?.selectedScreens?.length ? data.selectedScreens : catalog.map((s) => s.key)
    );
    return catalog.filter((s) => allowed.has(s.key));
  }, [data]);

  /**
   * The rail's headings, in nav order — from the descriptor, like the screens
   * themselves. Empty for a provider that declares no grouping, which
   * `ProviderNav` renders as one flat list. See `ProviderChrome`.
   */
  const screenGroups = data?.provider?.screenGroups || [];

  // A stored screen that is no longer rendered — switched off for this board, or
  // removed from the provider — falls back to the first one rather than showing
  // a blank panel.
  const activeScreen = screens.some((s) => s.key === screen)
    ? screen
    : screens[0]?.key || 'overview';

  // A board that renders exactly one screen gets no nav at all: a rail with a
  // single item is a label pretending to be a choice.
  const multiScreen = screens.length > 1;

  const label = data?.provider?.label || providerLabel || 'SEO';

  const runRefresh = async ({ force = false } = {}) => {
    setConfirmBuy(false);
    setRefreshing(true);
    try {
      const { report } = await refreshConnectorData(boardId, provider, {
        project: projectId || undefined,
        ...(force ? { force: true } : {}),
      });
      const failed = (report?.accounts || []).filter(
        (a) => a.failed > 0 || a.quotaExhausted || a.needsReauth || a.error
      );

      if (report?.needsReauth) {
        toastError('At least one account needs reconnecting under Settings → Connectors.');
      } else if (report?.quotaExhausted) {
        toastInfo(
          `${label} has stopped this account — either its balance or its own daily limit. Nothing new can be bought until that clears.`
        );
      } else if (failed.length) {
        toastError(failed[0].error || 'Some data could not be collected.');
      } else if (report?.written) {
        toastSuccess(
          `${report.written} new reading${report.written === 1 ? '' : 's'} collected.`
        );
      } else if (report?.queued) {
        /**
         * The answer this provider gives most of the time, and it needs its own
         * sentence. "Nothing was collected" would be wrong twice: work IS in
         * flight, and it was bought — silently reporting that as nothing is how
         * somebody presses the button again and buys it twice.
         */
        toastInfo(
          `${report.queued} collection${report.queued === 1 ? '' : 's'} ordered. ` +
            'Results arrive within minutes and land here on their own.'
        );
      } else {
        toastSuccess('Everything was already up to date.');
      }

      await load({ quiet: true });
      if (activeScreen === 'usage') await loadUsage({ quiet: true });
    } catch (err) {
      toastError(
        err?.response?.data?.error || 'Could not refresh that connector data.'
      );
    } finally {
      setRefreshing(false);
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
    return <EmptyState icon={Plug} title={providerLabel || 'SEO'} description={error} />;
  }

  if (!data?.project) {
    return (
      <div className="mt-5">
        <EmptyState
          icon={Plug}
          title={`No ${label} sites yet`}
          description={
            data?.canManage
              ? 'Add a site under Add-ons — a domain, the markets you track it in, and the keywords you track there — then map it to a group. Nothing is bought when you open this tab.'
              : 'Nobody has set up a site for this board yet.'
          }
        />
      </div>
    );
  }

  const Screen = SCREENS[activeScreen];
  const screenMeta = screens.find((s) => s.key === activeScreen) || null;

  return (
    <div className="mt-5">
      {/* ---------------------------------------------------------------------
          The shell: one card holding the project bar, the rail and the screen.
          The nav is grouped and the pickers appear only where there is a choice
          — see `connector/ProviderChrome` for what that replaced and why.
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
            // A keyword and a market belong to the site whose table they came
            // from. Carrying either across would ask for a variant this site
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
          refreshing={refreshing}
          onRefresh={() => runRefresh()}
        />

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
              groups={screenGroups}
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
              <ScreenHeading screen={screenMeta} />

              {!Screen ? (
                // A screen the server declares that this client has no component
                // for. Named rather than dropped, so a provider gaining a screen
                // is visible here instead of silently missing.
                <EmptyState
                  icon={Plug}
                  title={screenMeta?.label || 'Not available yet'}
                  description={`${label} offers this screen, but this version of the app does not render it yet.`}
                />
              ) : activeScreen === 'usage' ? (
                <UsageScreen
                  usage={usage}
                  loading={usageLoading}
                  data={data}
                  label={label}
                  boardId={boardId}
                />
              ) : (
                <Screen
                  data={data}
                  label={label}
                  keyword={keyword}
                  onSelectKeyword={setKeyword}
                  onOpenScreen={setScreen}
                  /**
                   * The re-buy path, and it is deliberately not the Refresh
                   * button. `forceRefetchIsFree: false` on this descriptor means
                   * a plain Refresh respects the cadence and collects only what
                   * is already paid for; a genuine "buy it again" is a second,
                   * confirmed act, because on this provider it is a purchase and
                   * it also resets the attempt chain on a job that has already
                   * been given up on.
                   */
                  onRebuy={data.canManage ? () => setConfirmBuy(true) : null}
                  refreshing={refreshing}
                />
              )}
            </div>
          </div>
        </div>
      </div>

      <Modal
        isOpen={confirmBuy}
        onClose={() => setConfirmBuy(false)}
        title="Buy this collection again?"
        maxWidth={460}
      >
        <p
          className="font-body"
          style={{ fontSize: 13.5, color: 'var(--color-text-secondary)' }}
        >
          {label} charges at the moment a collection is ordered, not when the
          result arrives — so ordering the same keywords again costs the same as
          the first time, whether or not anything has changed.
        </p>
        <p
          className="font-body mt-3"
          style={{ fontSize: 13.5, color: 'var(--color-text-secondary)' }}
        >
          The ordinary Refresh button already collects everything that has been
          paid for and is waiting, for free. Use this only when a collection was
          given up on, or when you need a reading before the next scheduled one.
        </p>
        <div className="flex justify-end gap-2 mt-5">
          <Button variant="secondary" onClick={() => setConfirmBuy(false)}>
            Cancel
          </Button>
          <Button onClick={() => runRefresh({ force: true })} disabled={refreshing}>
            {refreshing ? 'Ordering…' : 'Buy it again'}
          </Button>
        </div>
      </Modal>
    </div>
  );
};

export default SeoDashboardTab;
