import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown, FileSpreadsheet, FileText, MoreHorizontal, Plus, Wallet,
} from 'lucide-react';

import Button from '../../ui/Button';
import EmptyState from '../../ui/EmptyState';
import Modal from '../../ui/Modal';
import { SkeletonBlock } from '../../ui/Skeleton';
import useTaskStore from '../../../store/taskStore';
import useToastStore from '../../../store/toastStore';
import * as adsBudgetService from '../../../services/adsBudgetService';
import { downloadAdsBudgetExport } from '../../../utils/adsBudgetExport';
import ClientRosterScreen from './ClientRosterScreen';
import ClientBudgetScreen from './ClientBudgetScreen';
import BudgetRowModal from './BudgetRowModal';
import { MenuItem, OverflowMenu } from './BudgetBits';

/**
 * Ads Budget — what was planned, what has been spent, and whether that is the
 * right speed. One tracker board, one month, every client.
 *
 * ---- Two altitudes, one tab ------------------------------------------------
 *
 * A tracker board carries one client per group. The roster answers "which
 * clients need looking at"; the arrow opens the one that does. The screen you
 * are on is COMPONENT STATE, not the URL — a reading position should not put a
 * history entry in the back button, which is the same call `SeoDashboardTab`
 * makes for its screen nav and `ConnectorDataTab` for its project picker. The
 * MONTH is the opposite case and lives in the URL, because it is a statement
 * about what you are looking at rather than where you happen to be scrolled.
 *
 * ---- Tab doctrine ----------------------------------------------------------
 *
 * Stated verbatim in `goals/GoalsTab.jsx`, `delivery/DeliveryTab.jsx`,
 * `scoreboard/ScoreboardTab.jsx`, `connector/ConnectorDataTab.jsx` and
 * `seo/SeoDashboardTab.jsx`, and followed here: no new Zustand slice; component
 * state plus a service; a `{quiet: true}` refetch on the existing SSE
 * `board.changed` signal with a 1500 ms debounce and a `[boardRefreshSignal]`-only
 * dependency array; and a 403/404 rendered as an `EmptyState` carrying the
 * server's own sentence, never a toast — "you cannot see this" is information,
 * not an error. Failed WRITES get a toast.
 *
 * The request-ticket race guard and the clear-on-`boardId`-change below are
 * `ConnectorDataTab`'s, copied deliberately: the debounce makes the race real,
 * because a quiet refetch fired for the previous client can land after the user
 * has drilled into another one and overwrite their figures with the old ones.
 *
 * ---- Nothing here computes a status ----------------------------------------
 *
 * Every `state`, `usedPct`, `remaining` and `projected` on this page arrived
 * from the server, computed once by `utils/adsBudgetPacing.js`. The client
 * looks a colour up and renders. Two implementations of "is this client
 * overspending" is two answers to the question the tab exists to ask.
 */

const SkeletonScreen = () => (
  <div className="mt-5 flex flex-col gap-4">
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <SkeletonBlock key={i} height={120} borderRadius="var(--radius-lg)" />
      ))}
    </div>
    <SkeletonBlock height={280} borderRadius="var(--radius-lg)" />
  </div>
);

const AdsBudgetTab = ({
  boardId,
  boardName,
  groups = [],
  monthKey,
  monthLabel,
  canTrack = false,
  canManage = false,
}) => {
  const toastError = useToastStore((s) => s.error);
  const toastSuccess = useToastStore((s) => s.success);

  const boardRefreshSignal = useTaskStore((s) => s.boardRefreshSignal);
  const boardRefreshTarget = useTaskStore((s) => s.boardRefreshTarget);

  /** null on the roster; a group id once drilled in. */
  const [openClientId, setOpenClientId] = useState(null);

  const [roster, setRoster] = useState(null);
  const [client, setClient] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  /**
   * The ledger's own state, including its own error.
   *
   * A failed activity read must never blank the budget tables — the rule
   * `GoalsTab` states for its connector reads. So it has its own request, its
   * own catch, and its error is rendered inside the Budget Activity panel.
   */
  const [activity, setActivity] = useState(null);
  const [activityError, setActivityError] = useState(null);

  const [modal, setModal] = useState(null); // { initial?, parent?, fromRoster? }
  const [saving, setSaving] = useState(false);
  const [formErrors, setFormErrors] = useState([]);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const requestRef = useRef(0);

  const fetchRoster = useCallback(
    async ({ quiet = false } = {}) => {
      if (!boardId || !monthKey) return;
      if (!quiet) setLoading(true);
      const ticket = ++requestRef.current;
      try {
        const next = await adsBudgetService.getRoster(boardId, monthKey);
        if (ticket !== requestRef.current) return;
        setRoster(next);
        setError(null);
      } catch (err) {
        if (ticket !== requestRef.current) return;
        setError(
          err?.response?.data?.error || 'Could not load the ads budgets for this board.'
        );
      } finally {
        if (ticket === requestRef.current) setLoading(false);
      }
    },
    [boardId, monthKey]
  );

  const fetchClient = useCallback(
    async (groupId, { quiet = false } = {}) => {
      if (!boardId || !monthKey || !groupId) return;
      if (!quiet) setLoading(true);
      const ticket = ++requestRef.current;
      try {
        const next = await adsBudgetService.getClientBudget(boardId, groupId, monthKey);
        if (ticket !== requestRef.current) return;
        setClient(next);
        setError(null);
      } catch (err) {
        if (ticket !== requestRef.current) return;
        setError(err?.response?.data?.error || 'Could not load this client’s ads budget.');
      } finally {
        if (ticket === requestRef.current) setLoading(false);
      }

      // Its own request, and it swallows its own failure.
      try {
        const log = await adsBudgetService.getClientActivity(boardId, groupId, { monthKey });
        setActivity(log.items || []);
        setActivityError(null);
      } catch (err) {
        setActivity(null);
        setActivityError(
          err?.response?.data?.error || 'Could not load the budget activity for this month.'
        );
      }
    },
    [boardId, monthKey]
  );

  /** Reload whichever screen is open. Used after every write. */
  const refresh = useCallback(
    (opts) => (openClientId ? fetchClient(openClientId, opts) : fetchRoster(opts)),
    [openClientId, fetchClient, fetchRoster]
  );

  useEffect(() => {
    if (openClientId) fetchClient(openClientId);
    else fetchRoster();
  }, [openClientId, fetchClient, fetchRoster]);

  // A different board is a different everything. Without this the previous
  // board's figures stay on screen behind the new board's spinner.
  useEffect(() => {
    setOpenClientId(null);
    setRoster(null);
    setClient(null);
    setActivity(null);
    setActivityError(null);
    setError(null);
  }, [boardId]);

  // The month changed under us — drop the old month's rows rather than showing
  // August's budgets under a September heading while the request is in flight.
  useEffect(() => {
    setClient(null);
    setRoster(null);
    setActivity(null);
  }, [monthKey]);

  // Live refresh off the existing SSE board.changed path, debounced.
  useEffect(() => {
    if (boardRefreshTarget !== boardId) return undefined;
    const timer = setTimeout(() => refresh({ quiet: true }), 1500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardRefreshSignal]);

  /** Platform names already in use on this board, for the modal's suggestions. */
  const platformSuggestions = useMemo(() => {
    const names = new Set();
    for (const p of client?.platforms || []) if (p.platform) names.add(p.platform);
    return [...names].sort();
  }, [client]);

  // ---- Writes --------------------------------------------------------------

  const submitRow = async (payload) => {
    setSaving(true);
    setFormErrors([]);
    try {
      if (modal.initial) {
        await adsBudgetService.updateBudgetRow(modal.initial._id, payload);
      } else {
        await adsBudgetService.createBudgetRow(boardId, {
          ...payload,
          monthKey,
          group: payload.group || openClientId,
        });
      }
      setModal(null);
      await refresh({ quiet: true });
    } catch (err) {
      const body = err?.response?.data;
      setFormErrors(body?.errors || [{ field: '_', message: body?.error || 'Could not save that.' }]);
    } finally {
      setSaving(false);
    }
  };

  /**
   * The inline spend edit.
   *
   * Optimistic on the row so the bar and the chip move under the cursor, then
   * corrected by the server's own answer — which recomputes the pacing state
   * this client cannot. A failure re-reads rather than guessing what was kept.
   */
  const commitSpend = async (row, spent) => {
    setClient((prev) => {
      if (!prev) return prev;
      const patch = (r) => (r._id === row._id ? { ...r, spent } : r);
      return {
        ...prev,
        platforms: prev.platforms.map((p) => ({
          ...patch(p),
          campaigns: p.campaigns.map(patch),
        })),
      };
    });
    try {
      await adsBudgetService.updateBudgetRow(row._id, { spent });
      await refresh({ quiet: true });
    } catch (err) {
      toastError(err?.response?.data?.error || 'That spend did not save.');
      await refresh({ quiet: true });
    }
  };

  const confirmDelete = async () => {
    try {
      const res = await adsBudgetService.deleteBudgetRow(pendingDelete._id);
      setPendingDelete(null);
      await refresh({ quiet: true });
      if (res?.removedCampaigns > 0) {
        toastSuccess(
          `Removed, along with ${res.removedCampaigns} campaign${res.removedCampaigns === 1 ? '' : 's'}.`
        );
      }
    } catch (err) {
      toastError(err?.response?.data?.error || 'Could not delete that budget.');
    }
  };

  /**
   * Export whichever table is on screen.
   *
   * The report is chosen from the SCREEN rather than offered as a menu: on the
   * roster the only table is the clients list, and on a client the tables are
   * the budgets. The ledger is the exception and carries its own pair of
   * buttons, because it is a different shape of sheet answering a different
   * question.
   */
  const runExport = (format, report) => {
    const which = report || (openClientId ? 'budgets' : 'clients');
    const payload = openClientId
      ? { ...client, activity, boardName }
      : { ...roster, boardName };
    downloadAdsBudgetExport(payload, which, format);
  };

  // ---- Render --------------------------------------------------------------

  const data = openClientId ? client : roster;

  /**
   * The board page's answer is the starting point, so the controls do not
   * flicker on mount — but the SERVER's answer wins as soon as it arrives. It
   * resolves the same two-layer AND against the live board rather than against
   * whatever the page loaded, and hiding a control was never the enforcement
   * anyway: every write here is gated again server-side, and the PATCH route
   * re-decides track-versus-manage from the body. Copied from `AddonsTab`.
   */
  const mayTrack = data?.canTrack ?? canTrack;
  const mayManage = data?.canManage ?? canManage;

  if (loading && !data) return <SkeletonScreen />;

  if (error) {
    return (
      <div className="mt-5">
        <EmptyState icon={Wallet} title="Ads budgets are not available" description={error} />
      </div>
    );
  }

  if (!data) return <SkeletonScreen />;

  return (
    <div className="mt-5 flex flex-col gap-6">
      {/* ---- Page header ---------------------------------------------------
          Two rows, not one. The title and its two controls sit together; the
          PERIOD gets its own line underneath, because it qualifies everything
          below it rather than being another action. */}
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start gap-3">
          <div className="flex-1 min-w-0">
            <h2
              className="font-display font-bold"
              style={{ fontSize: 22, color: 'var(--color-text-primary)' }}
            >
              Ads Budget Tracker
            </h2>
            <p className="font-body mt-1" style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
              Track planned budget, actual spend, remaining budget, and performance across every
              advertising platform.
            </p>
          </div>

          {/*
            `min-w-0`, and NOT `shrink-0`.

            A `shrink-0` flex child keeps its max-content width even when it
            wraps internally, so on a phone this row pushed the whole page
            wider than the viewport and the board header scrolled sideways with
            it. `flex-wrap` alone does not fix that — the wrap happens inside a
            box that is still refusing to narrow.
          */}
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            {mayManage ? (
              <Button
                size="sm"
                icon={Plus}
                onClick={() =>
                  setModal({ fromRoster: !openClientId, initial: null, parent: null })
                }
              >
                Add Budget
              </Button>
            ) : null}

            {/* The exports live behind the ⋯ rather than as two more buttons.
                They are real but they are not why anybody opens this page, and
                two download buttons beside the primary action made the one
                control that matters compete with them. */}
            <div style={{ position: 'relative' }}>
              <button
                type="button"
                onClick={() => setMenuOpen((o) => !o)}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-label="More actions"
                className="inline-flex items-center justify-center transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid var(--color-border-strong)',
                  background: 'var(--color-bg-surface)',
                  color: 'var(--color-text-secondary)',
                  cursor: 'pointer',
                }}
              >
                <MoreHorizontal size={16} aria-hidden="true" />
              </button>
              <OverflowMenu open={menuOpen} onClose={() => setMenuOpen(false)}>
                <MenuItem
                  icon={FileSpreadsheet}
                  onClick={() => { setMenuOpen(false); runExport('csv'); }}
                >
                  Export as CSV
                </MenuItem>
                <MenuItem
                  icon={FileText}
                  onClick={() => { setMenuOpen(false); runExport('pdf'); }}
                >
                  Export as PDF
                </MenuItem>
              </OverflowMenu>
            </div>
          </div>
        </div>

        {/* ---- The period ---------------------------------------------------
            The month is a LABEL, not a picker: it is changed in the board
            header, where every other tracker tab changes it, and two month
            controls on one page would be two sources of truth.

            The cadence beside it says "Monthly" and is not a dropdown either.
            The design offers Monthly / Quarterly / Yearly / Custom; only
            Monthly is built, and a menu whose other three options do nothing is
            worse than no menu. Quarterly and Yearly are a sum across a span of
            month keys — the seam is `monthKeysBetween` in
            server/src/utils/monthKey.js. */}
        <div className="flex flex-wrap items-center gap-3">
          <span
            className="font-body font-medium"
            style={{ fontSize: 14, color: 'var(--color-text-primary)' }}
          >
            {data.monthLabel || monthLabel}
          </span>
          <span
            className="inline-flex items-center gap-1.5 font-body"
            title="Budgets are tracked one calendar month at a time"
            style={{
              height: 30,
              padding: '0 10px',
              fontSize: 12.5,
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--color-border)',
              background: 'var(--color-bg-surface)',
              color: 'var(--color-text-secondary)',
            }}
          >
            Monthly
            <ChevronDown size={13} aria-hidden="true" style={{ opacity: 0.5 }} />
          </span>
        </div>
      </div>

      {openClientId ? (
        <ClientBudgetScreen
          data={client}
          activity={activity}
          activityError={activityError}
          onBack={() => setOpenClientId(null)}
          onAddPlatform={() => setModal({ initial: null, parent: null })}
          onAddCampaign={(platform) => setModal({ initial: null, parent: platform })}
          onEdit={(row) => setModal({ initial: row, parent: null })}
          onDelete={setPendingDelete}
          onCommitSpend={commitSpend}
          onExportActivity={(format) => runExport(format, 'activity')}
          canTrack={mayTrack}
          canManage={mayManage}
        />
      ) : (
        <ClientRosterScreen data={roster} onOpenClient={(c) => setOpenClientId(c._id)} />
      )}

      {modal ? (
        <BudgetRowModal
          /**
           * The subject, as a key. Opening the dialog on a different row
           * remounts it, which is what lets its state be seeded once from
           * props instead of synced in from an effect — see its header.
           */
          key={modal.initial?._id || `new:${modal.parent?._id || 'platform'}`}
          open
          onClose={() => {
            setModal(null);
            setFormErrors([]);
          }}
          onSubmit={submitRow}
          initial={modal.initial}
          parent={modal.parent}
          groups={modal.fromRoster ? groups : null}
          groupId={openClientId}
          groupName={client?.group?.name || ''}
          monthLabel={data.monthLabel || monthLabel}
          platformSuggestions={platformSuggestions}
          saving={saving}
          serverErrors={formErrors}
        />
      ) : null}

      <Modal
        isOpen={!!pendingDelete}
        onClose={() => setPendingDelete(null)}
        title="Delete this budget?"
        maxWidth={420}
      >
        <p className="font-body" style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
          {pendingDelete?.parent
            ? `“${pendingDelete?.name || 'This campaign'}” will be removed from ${data.monthLabel || monthLabel}.`
            : `“${pendingDelete?.platform}” will be removed from ${data.monthLabel || monthLabel}, along with every campaign inside it.`}
          {' '}
          Its history stays in Budget Activity.
        </p>
        <div className="flex justify-end gap-2 mt-4">
          <Button variant="secondary" onClick={() => setPendingDelete(null)}>
            Cancel
          </Button>
          <Button variant="danger" onClick={confirmDelete}>
            Delete
          </Button>
        </div>
      </Modal>
    </div>
  );
};

export default AdsBudgetTab;
