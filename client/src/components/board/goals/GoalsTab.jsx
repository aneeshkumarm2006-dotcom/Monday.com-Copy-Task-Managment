import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Target, Settings2 } from 'lucide-react';
import EmptyState from '../../ui/EmptyState';
import Spinner from '../../ui/Spinner';
import Modal from '../../ui/Modal';
import Button from '../../ui/Button';
import GoalsSummaryStrip from './GoalsSummaryStrip';
import GoalGroupSection from './GoalGroupSection';
import GoalFormModal from './GoalFormModal';
import GoalColumnsModal from './GoalColumnsModal';
import UnclosedMonthBanner from './UnclosedMonthBanner';
import * as goalService from '../../../services/goalService';
import { loadGoalPrefs, saveGoalPrefs } from '../../../utils/goalDisplay';
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
    const t = setTimeout(() => fetchGoals({ quiet: true }), 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardRefreshSignal]);

  const typesByKey = useMemo(
    () => Object.fromEntries(types.map((t) => [t.key, t])),
    [types]
  );

  const collapsed = useMemo(() => new Set(prefs.collapsed || []), [prefs.collapsed]);

  const toggleCollapse = (groupId) => {
    const next = new Set(collapsed);
    if (next.has(groupId)) next.delete(groupId);
    else next.add(groupId);
    const updated = { ...prefs, collapsed: [...next] };
    setPrefs(updated);
    saveGoalPrefs(boardId, updated);
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
              onPatch={patchGoal}
              onEdit={(goal) => { setFormErrors([]); setFormFor({ group, goal }); }}
              onDelete={setPendingDelete}
              onAdd={(g) => { setFormErrors([]); setFormFor({ group: g }); }}
            />
          </div>
        ))
      )}

      {prefs.showTrend && trend && (
        <Suspense fallback={<div className="flex justify-center py-8"><Spinner /></div>}>
          <GoalTrendChart trend={trend} months={trendMonths} onChangeMonths={setTrendWindow} />
        </Suspense>
      )}

      {canManageColumns && (
        <div className="flex justify-end">
          <Button variant="ghost" icon={Settings2} onClick={() => setColumnsOpen(true)}>
            Goal columns
          </Button>
        </div>
      )}

      {formFor && (
        <GoalFormModal
          open
          onClose={() => setFormFor(null)}
          onSubmit={submitGoal}
          types={types}
          groupName={formFor.group?.name}
          monthLabel={monthLabel}
          initial={formFor.goal}
          saving={saving}
          serverErrors={formErrors}
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
