import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Target, Settings2, Link2 } from 'lucide-react';
import EmptyState from '../../ui/EmptyState';
import Spinner from '../../ui/Spinner';
import Modal from '../../ui/Modal';
import Button from '../../ui/Button';
import GoalsSummaryStrip from './GoalsSummaryStrip';
import GoalGroupSection from './GoalGroupSection';
import GoalFormModal from './GoalFormModal';
import GoalColumnsModal from './GoalColumnsModal';
import GoalLinkModal from './GoalLinkModal';
import GoalBulkLinkModal from './GoalBulkLinkModal';
import UnclosedMonthBanner from './UnclosedMonthBanner';
import * as goalService from '../../../services/goalService';
import {
  getGoalLinks,
  setGoalLink,
  clearGoalLink,
  acceptGoalSuggestions,
} from '../../../services/connectorService';
import { loadGoalPrefs, saveGoalPrefs } from '../../../utils/goalDisplay';
import { applyGoalOrder } from '../../../utils/goalOrder';
import useTaskStore from '../../../store/taskStore';
import useToastStore from '../../../store/toastStore';

// Recharts is ~95KB and this is the only thing in the app that uses it, so the
// chart is split out — a standard board, or a tracker board sitting on the Board
// tab, never downloads it.
const GoalTrendChart = lazy(() => import('./GoalTrendChart'));

/**
 * Monthly Goals — one goals table per group, scored against the selected month.
 *
 * Architecture, following the sibling `delivery/DeliveryTab.jsx`: NO new Zustand
 * slice. Nothing outside this tab needs goal rows, so they live in component
 * state and refetch on the existing SSE `board.changed` signal. The month comes
 * from the URL via the board page.
 *
 * The one thing that does cross the boundary is the "unclosed" flag on the month
 * dropdown, which lives in the header. That is what `onGoalsChanged` is for —
 * one callback, rather than lifting every goal into a store to serve one boolean.
 *
 * A 403/404 renders as an EmptyState carrying the server's own sentence rather
 * than a toast, because "you cannot see this" is information, not an error.
 */
const GoalsTab = ({
  boardId,
  monthKey,
  monthLabel,
  canTrack = false,
  canManage = false,
  canManageColumns = false,
  // `connector.manage` on this board. Only decides whether the link control is
  // offered — pointing a goal at a keyword is connector wiring and writes
  // nothing to a goal, so it is deliberately NOT one of the goal capabilities
  // above. Every write below is gated again server-side.
  canLinkConnector = false,
  onGoalsChanged,
}) => {
  const [data, setData] = useState(null);
  const [types, setTypes] = useState([]);
  const [trend, setTrend] = useState(null);
  const [trendMonths, setTrendMonths] = useState(() => loadGoalPrefs(boardId).trendMonths);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [prefs, setPrefs] = useState(() => loadGoalPrefs(boardId));

  const [formFor, setFormFor] = useState(null); // { group, goal? }
  const [formErrors, setFormErrors] = useState([]);
  const [saving, setSaving] = useState(false);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);

  /**
   * The connector half. Deliberately its OWN piece of state and its own request
   * rather than folded into `getGoals`: the goals payload is what every tracker
   * board needs, and most of them have no connector at all. A board with none
   * gets `{ links: [] }` and renders identically, and a connector endpoint that
   * failed must never be able to blank the goals table.
   */
  const [linkData, setLinkData] = useState(null);
  const [linkFor, setLinkFor] = useState(null);   // the goal whose modal is open
  const [linkSaving, setLinkSaving] = useState(false);
  const [linkError, setLinkError] = useState(null);
  const [acceptingGoalId, setAcceptingGoalId] = useState(null);
  const [bulkLinkOpen, setBulkLinkOpen] = useState(false);

  const boardRefreshSignal = useTaskStore((s) => s.boardRefreshSignal);
  const boardRefreshTarget = useTaskStore((s) => s.boardRefreshTarget);
  const toastError = useToastStore((s) => s.error);
  const firstFlaggedRef = useRef(null);

  const fetchGoals = useCallback(
    async ({ quiet = false } = {}) => {
      if (!boardId || !monthKey) return;
      if (!quiet) setLoading(true);
      try {
        const goals = await goalService.getGoals(boardId, monthKey);
        setData(goals);
        setError(null);
      } catch (err) {
        setError(err?.response?.data?.error || 'Could not load the goals for this month.');
      } finally {
        setLoading(false);
      }
    },
    [boardId, monthKey]
  );

  useEffect(() => { fetchGoals(); }, [fetchGoals]);

  /**
   * The links for this month, and what a link can be made against.
   *
   * Swallows its own failure on purpose. A 403 here means the person cannot see
   * connectors, which is information rather than an error, and a provider plane
   * that is having a bad day must not take the goals table down with it — the
   * chips simply do not appear.
   */
  const fetchLinks = useCallback(async () => {
    if (!boardId || !monthKey) return;
    try {
      setLinkData(await getGoalLinks(boardId, monthKey));
    } catch {
      setLinkData(null);
    }
  }, [boardId, monthKey]);

  useEffect(() => { fetchLinks(); }, [fetchLinks]);

  // Drop the old board's rows the instant the board changes. Two reasons, and
  // the second is the subtle one: the collapse-on-open effect below keys off
  // `data`, so leaving the previous board's groups in state lets THEM satisfy
  // the guard — and the board you actually navigated to opens fully expanded.
  useEffect(() => { setData(null); }, [boardId]);

  useEffect(() => {
    goalService.getGoalTypes().then((d) => setTypes(d.types || [])).catch(() => setTypes([]));
  }, []);

  useEffect(() => {
    if (!boardId || !monthKey || !prefs.showTrend) return;
    goalService
      .getGoalTrend(boardId, { months: trendMonths, through: monthKey })
      .then(setTrend)
      .catch(() => setTrend(null));
  }, [boardId, monthKey, trendMonths, prefs.showTrend]);

  // Live refresh off the existing SSE path, debounced — the same shape and the
  // same reason as DeliveryTab: five quick edits must not fire five refetches.
  useEffect(() => {
    if (boardRefreshTarget !== boardId) return undefined;
    const t = setTimeout(() => {
      fetchGoals({ quiet: true });
      // The runner writes goals AND links in the same pass, so a refresh that
      // reloaded only the rows would show new numbers with stale provenance —
      // and an offer that had just been superseded would sit there until the
      // next reload.
      fetchLinks();
    }, 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardRefreshSignal]);

  const typesByKey = useMemo(
    () => Object.fromEntries(types.map((t) => [t.key, t])),
    [types]
  );

  /**
   * Collapse state, keyed by group id — in memory, deliberately NOT persisted.
   *
   * The Board tab opens every board on the "categories only" view and this is
   * the same behaviour, built the same way: a guard remembering which board the
   * initial collapse was applied to, so a quiet SSE refetch cannot slam shut a
   * group the user just opened. Switching MONTH keeps your expansion, because
   * following one group across months is the whole point of the month picker.
   */
  const [collapsed, setCollapsed] = useState(() => new Set());
  const collapseAppliedFor = useRef(null);

  useEffect(() => {
    const loaded = data?.groups;
    if (!loaded?.length || collapseAppliedFor.current === boardId) return;
    collapseAppliedFor.current = boardId;
    setCollapsed(new Set(loaded.map((g) => g._id)));
  }, [data, boardId]);

  const toggleCollapse = (groupId) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  const setTrendWindow = (m) => {
    setTrendMonths(m);
    const updated = { ...prefs, trendMonths: m };
    setPrefs(updated);
    saveGoalPrefs(boardId, updated);
  };

  /** A per-cell save. Optimistic on the row, authoritative on the response. */
  const patchGoal = async (goal, patch) => {
    try {
      const res = await goalService.updateGoal(goal._id, patch);
      setData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          groups: prev.groups.map((g) =>
            String(g._id) !== String(goal.group)
              ? g
              : {
                ...g,
                goals: g.goals.map((x) =>
                  x._id === goal._id ? { ...x, ...res.goal, history: x.history } : x
                ),
                summary: res.groupSummary || g.summary,
              }
          ),
        };
      });
      // The board roll-up and the dropdown's unclosed badge both moved.
      fetchGoals({ quiet: true });
      onGoalsChanged?.();
    } catch (err) {
      const msg = err?.response?.data?.error || 'That change did not save.';
      toastError(msg);
      // Re-read rather than guessing what the server kept.
      fetchGoals({ quiet: true });
    }
  };

  /**
   * A goal moved up or down its group's table — saved for everyone.
   *
   * Optimistic and then silent on success: the server writes exactly the order
   * it was handed, so there is nothing to re-read, and a refetch here would
   * repaint twenty-eight rows to put them back where they already are.
   *
   * Nor does it call `onGoalsChanged` — position is the one edit on this tab
   * that moves no score and closes no month, so the header's unclosed badge has
   * nothing to hear about.
   */
  const reorderGoalsInGroup = async (group, orderedIds) => {
    setData((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        groups: prev.groups.map((g) => (
          String(g._id) !== String(group._id)
            ? g
            : { ...g, goals: applyGoalOrder(g.goals, orderedIds) }
        )),
      };
    });

    try {
      await goalService.reorderGoals(boardId, orderedIds);
    } catch (err) {
      toastError(err?.response?.data?.error || 'Could not move that goal.');
      // Re-read rather than guessing what the server kept — the same rule as
      // patchGoal, and the refetch is what puts the row visibly back.
      fetchGoals({ quiet: true });
    }
  };

  // ---- Connector links ------------------------------------------------------

  /**
   * `connector.manage` on this board, from the SERVER's own resolution against
   * the live board and falling back to what the page loaded. Hoisted because
   * two things read it now — every row's link icon, and the footer's bulk
   * button — and they must not be able to disagree.
   */
  const canLink = linkData ? !!linkData.canManage : canLinkConnector;

  /**
   * The bulk-link button, offered only where there is something to link TO. A
   * tracker board with no connector project mapped never sees it, which is most
   * of them.
   */
  const canBulkLink = canLink && (linkData?.sources || []).length > 0;

  /** goalId → its link, so a row is a lookup rather than a scan per render. */
  const linksByGoal = useMemo(
    () => new Map((linkData?.links || []).map((l) => [String(l.goal), l])),
    [linkData]
  );

  const saveLink = async (payload) => {
    setLinkSaving(true);
    setLinkError(null);
    try {
      await setGoalLink(linkFor._id, payload);
      setLinkFor(null);
      await fetchLinks();
    } catch (err) {
      setLinkError(err?.response?.data?.error || 'Could not link that goal.');
    } finally {
      setLinkSaving(false);
    }
  };

  const unlink = async () => {
    setLinkSaving(true);
    setLinkError(null);
    try {
      await clearGoalLink(linkFor._id);
      setLinkFor(null);
      await fetchLinks();
    } catch (err) {
      setLinkError(err?.response?.data?.error || 'Could not unlink that goal.');
    } finally {
      setLinkSaving(false);
    }
  };

  /**
   * Take the connector's numbers for a row it is no longer allowed to write to.
   *
   * Reports BOTH halves, because the server gates each field on what its target
   * implies: somebody who can report the month but not redefine it gets the rank
   * and not the starting point, in one call. Saying "3 accepted" while silently
   * dropping the fourth is how a permission model becomes folklore.
   */
  const acceptSuggestions = async (goal) => {
    setAcceptingGoalId(goal._id);
    try {
      const res = await acceptGoalSuggestions(goal._id);
      await Promise.all([fetchGoals({ quiet: true }), fetchLinks()]);
      onGoalsChanged?.();
      if (res.refused?.length) {
        toastError(res.refused[0].reason);
      }
    } catch (err) {
      toastError(err?.response?.data?.error || 'Could not accept that value.');
    } finally {
      setAcceptingGoalId(null);
    }
  };

  const submitGoal = async (payload) => {
    setSaving(true);
    setFormErrors([]);
    try {
      if (formFor.goal) {
        await goalService.updateGoal(formFor.goal._id, payload);
      } else {
        await goalService.createGoal(boardId, {
          ...payload, group: formFor.group._id, monthKey,
        });
      }
      setFormFor(null);
      await fetchGoals({ quiet: true });
      onGoalsChanged?.();
    } catch (err) {
      const body = err?.response?.data;
      setFormErrors(body?.errors || [{ field: '_', message: body?.error || 'Could not save.' }]);
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    try {
      await goalService.deleteGoal(pendingDelete._id);
      setPendingDelete(null);
      await fetchGoals({ quiet: true });
      onGoalsChanged?.();
    } catch {
      toastError('Could not delete that goal.');
    }
  };

  if (loading && !data) {
    return <div className="flex justify-center py-12"><Spinner /></div>;
  }

  if (error) {
    return <EmptyState icon={Target} title="Goals are not available" description={error} />;
  }

  if (!data) return null;

  const { groups = [], columns = [], summary, unclosed, missingCount } = data;

  return (
    <div className="flex flex-col gap-4">
      {unclosed && (
        <UnclosedMonthBanner
          monthLabel={monthLabel}
          missingCount={missingCount}
          onJumpToFirst={() =>
            firstFlaggedRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
          }
        />
      )}

      <GoalsSummaryStrip summary={summary} monthLabel={monthLabel} />

      {groups.length === 0 ? (
        <EmptyState
          icon={Target}
          title="No groups on this board yet"
          description="Add a group and it will get its own goals table here."
        />
      ) : (
        groups.map((group) => (
          <div
            key={group._id}
            ref={
              !firstFlaggedRef.current && group.goals.some((g) => g.missing?.length)
                ? firstFlaggedRef
                : undefined
            }
          >
            <GoalGroupSection
              group={group}
              columns={columns}
              typesByKey={typesByKey}
              collapsed={collapsed.has(group._id)}
              onToggleCollapse={() => toggleCollapse(group._id)}
              canTrack={canTrack}
              canManage={canManage}
              // The rows only paint their blanks red once the month is over and
              // genuinely owes numbers — the same flag the banner above runs on.
              monthClosable={!!unclosed}
              onPatch={patchGoal}
              onEdit={(goal) => { setFormErrors([]); setFormFor({ group, goal }); }}
              onDelete={setPendingDelete}
              onAdd={(g) => { setFormErrors([]); setFormFor({ group: g }); }}
              onReorder={canManage ? reorderGoalsInGroup : undefined}
              linksByGoal={linksByGoal}
              // Both answers come from the SERVER's own resolution against the
              // live board, falling back to what the page loaded. Hiding a
              // control was never the enforcement anyway — every write is gated
              // again server-side.
              canLink={canLink}
              canAccept={linkData ? !!linkData.canTrack : canTrack}
              acceptingGoalId={acceptingGoalId}
              onLink={(goal) => { setLinkError(null); setLinkFor(goal); }}
              onAcceptSuggestions={acceptSuggestions}
            />
          </div>
        ))
      )}

      {prefs.showTrend && trend && (
        <Suspense fallback={<div className="flex justify-center py-8"><Spinner /></div>}>
          <GoalTrendChart trend={trend} months={trendMonths} onChangeMonths={setTrendWindow} />
        </Suspense>
      )}

      {(canBulkLink || canManageColumns) && (
        <div className="flex justify-end gap-1">
          {canBulkLink && (
            <Button variant="ghost" icon={Link2} onClick={() => setBulkLinkOpen(true)}>
              Link goals to keywords
            </Button>
          )}
          {canManageColumns && (
            <Button variant="ghost" icon={Settings2} onClick={() => setColumnsOpen(true)}>
              Goal columns
            </Button>
          )}
        </div>
      )}

      {formFor && (
        <GoalFormModal
          open
          onClose={() => setFormFor(null)}
          onSubmit={submitGoal}
          boardId={boardId}
          types={types}
          columns={columns}
          groupName={formFor.group?.name}
          monthLabel={monthLabel}
          initial={formFor.goal}
          saving={saving}
          serverErrors={formErrors}
        />
      )}

      {linkFor && (
        <GoalLinkModal
          open
          goal={linkFor}
          groupName={groups.find((g) => String(g._id) === String(linkFor.group))?.name}
          monthLabel={monthLabel}
          link={linksByGoal.get(String(linkFor._id)) || null}
          sources={linkData?.sources || []}
          mappedFields={linkData?.mappedFields || []}
          saving={linkSaving}
          error={linkError}
          onClose={() => setLinkFor(null)}
          onSave={saveLink}
          onUnlink={unlink}
        />
      )}

      {bulkLinkOpen && (
        <GoalBulkLinkModal
          open
          boardId={boardId}
          monthKey={monthKey}
          monthLabel={monthLabel}
          groupNames={new Map(groups.map((g) => [String(g._id), g.name]))}
          onClose={() => setBulkLinkOpen(false)}
          // Links AND cells moved in the same act, so both halves are re-read.
          onLinked={() => {
            fetchGoals({ quiet: true });
            fetchLinks();
            onGoalsChanged?.();
          }}
        />
      )}

      {columnsOpen && (
        <GoalColumnsModal
          boardId={boardId}
          columns={columns}
          onClose={() => setColumnsOpen(false)}
          onChanged={() => fetchGoals({ quiet: true })}
        />
      )}

      <Modal
        isOpen={!!pendingDelete}
        onClose={() => setPendingDelete(null)}
        title="Delete this goal?"
        maxWidth={420}
      >
        <p className="font-body" style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
          “{pendingDelete?.name}” and its recorded result will be removed from{' '}
          {monthLabel}. Other months keep their own copy of this goal.
        </p>
        <div className="flex justify-end gap-2 mt-4">
          <Button variant="secondary" onClick={() => setPendingDelete(null)}>Cancel</Button>
          <Button variant="danger" onClick={confirmDelete}>Delete</Button>
        </div>
      </Modal>
    </div>
  );
};

export default GoalsTab;
