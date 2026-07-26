import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ListChecks,
  TrendingUp,
  AlertTriangle,
  Folder,
  PieChart,
  Flag,
} from 'lucide-react';
import PageWrapper from '../components/layout/PageWrapper';
import StatCard from '../components/ui/StatCard';
import {
  SkeletonStatCard,
  SkeletonBarChart,
  SkeletonBoardPerformance,
  SkeletonOverdueAssignees,
} from '../components/ui/Skeleton';
import Dropdown from '../components/ui/Dropdown';
import BarChart from '../components/analytics/BarChart';
import BoardPerformance from '../components/analytics/BoardPerformance';
import OverdueAssignees from '../components/analytics/OverdueAssignees';
import OverdueTasksModal from '../components/analytics/OverdueTasksModal';
import useOrgStore from '../store/orgStore';
import usePermissions from '../hooks/usePermissions';
import { getAnalytics } from '../services/analyticsService';

const STATUS_LABELS = {
  not_started: 'Not Started',
  working_on_it: 'Working on it',
  done: 'Done',
  stuck: 'Stuck',
};

const STATUS_COLORS = {
  not_started: 'var(--color-status-notstarted)',
  working_on_it: 'var(--color-status-working)',
  done: 'var(--color-status-done)',
  stuck: 'var(--color-status-stuck)',
};

const PRIORITY_LABELS = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

const PRIORITY_COLORS = {
  critical: 'var(--color-priority-critical)',
  high: 'var(--color-priority-high)',
  medium: 'var(--color-priority-medium)',
  low: 'var(--color-priority-low)',
};

const RANGE_OPTIONS = [
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: 'all', label: 'All time' },
];

const INITIAL_SUMMARY = {
  totalTasks: 0,
  completionRate: 0,
  overdueTasks: 0,
  activeBoards: 0,
};

const INITIAL_OVERDUE = {
  count: 0,
  avgDaysOverdue: 0,
  byPriority: [],
  topAssignees: [],
  byAssignee: [],
};

const AnalyticsPage = () => {
  const navigate = useNavigate();
  const { can } = usePermissions();
  const currentOrg = useOrgStore((s) => s.currentOrg);

  const canViewAnalytics = can('analytics.view');
  // The overdue breakdowns name individual people and how much work they are
  // late on, which is a different question from "may you see the dashboard".
  const canViewOthers = can('productivity.view_others');

  const [boardFilter, setBoardFilter] = useState('all');
  const [range, setRange] = useState('30d');
  const [overdueModalOpen, setOverdueModalOpen] = useState(false);

  const [summary, setSummary] = useState(INITIAL_SUMMARY);
  const [statusDistribution, setStatusDistribution] = useState([]);
  const [priorityDistribution, setPriorityDistribution] = useState([]);
  const [boardPerformance, setBoardPerformance] = useState([]);
  const [overdue, setOverdue] = useState(INITIAL_OVERDUE);
  const [orgBoards, setOrgBoards] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const orgId = currentOrg?._id || null;

  // Fetch analytics whenever filters change
  useEffect(() => {
    if (!orgId || !canViewAnalytics) return undefined;
    let cancelled = false;

    // Defer the loading/error resets to a microtask so the setState doesn't
    // happen synchronously inside the effect body.
    Promise.resolve().then(() => {
      if (cancelled) return;
      setLoading(true);
      setError(null);
    });

    getAnalytics({ orgId, board: boardFilter, range })
      .then((data) => {
        if (cancelled) return;
        setSummary({ ...INITIAL_SUMMARY, ...data.summary });
        setStatusDistribution(data.statusDistribution || []);
        setPriorityDistribution(data.priorityDistribution || []);
        setBoardPerformance(data.boardPerformance || []);
        setOverdue({ ...INITIAL_OVERDUE, ...(data.overdue || {}) });
        setOrgBoards(data.boards || []);
      })
      .catch((err) => {
        console.error('Failed to load analytics:', err);
        if (cancelled) return;
        setError('Could not load analytics.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [orgId, canViewAnalytics, boardFilter, range]);

  const boardOptions = useMemo(
    () => [
      { value: 'all', label: 'All Boards' },
      ...orgBoards.map((b) => ({ value: b._id, label: b.name })),
    ],
    [orgBoards]
  );

  // Jump from an overdue task in the popup to that task on its board.
  const handleSelectOverdueTask = useCallback(
    (task) => {
      if (!task?.boardId) return;
      setOverdueModalOpen(false);
      const parentId = task.parent?._id || task.parent;
      const parentParam = parentId ? `&highlightParent=${parentId}` : '';
      navigate(`/boards/${task.boardId}?highlightTask=${task._id}${parentParam}`);
    },
    [navigate]
  );

  const statusData = useMemo(
    () =>
      statusDistribution.map((row) => ({
        key: row.status,
        label: STATUS_LABELS[row.status] || row.status,
        count: row.count,
        color: STATUS_COLORS[row.status] || 'var(--color-accent)',
      })),
    [statusDistribution]
  );

  const priorityData = useMemo(
    () =>
      priorityDistribution.map((row) => ({
        key: row.priority,
        label: PRIORITY_LABELS[row.priority] || row.priority,
        count: row.count,
        color: PRIORITY_COLORS[row.priority] || 'var(--color-accent)',
      })),
    [priorityDistribution]
  );

  const overduePriorityData = useMemo(
    () =>
      (overdue.byPriority || []).map((row) => ({
        key: row.priority,
        label: PRIORITY_LABELS[row.priority] || row.priority,
        count: row.count,
        color: PRIORITY_COLORS[row.priority] || 'var(--color-accent)',
      })),
    [overdue.byPriority]
  );

  const statCards = [
    {
      icon: ListChecks,
      label: 'Total Tasks',
      value: summary.totalTasks,
      color: 'blue',
    },
    {
      icon: TrendingUp,
      label: 'Completion Rate',
      value: summary.completionRate,
      suffix: '%',
      color: 'green',
    },
    {
      icon: AlertTriangle,
      label: 'Overdue Tasks',
      value: summary.overdueTasks,
      color: 'red',
      subLabel:
        overdue.count > 0
          ? `Avg ${overdue.avgDaysOverdue} day${
              overdue.avgDaysOverdue === 1 ? '' : 's'
            } overdue`
          : 'No overdue tasks',
      onClick:
        overdue.count > 0 && canViewOthers
          ? () => setOverdueModalOpen(true)
          : undefined,
    },
    {
      icon: Folder,
      label: 'Active Boards',
      value: summary.activeBoards,
      color: 'purple',
    },
  ];

  return (
    <PageWrapper>
      {/* Page header with filters */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1
            className="font-display font-bold text-[22px] md:text-[28px]"
            style={{
              color: 'var(--color-text-primary)',
              lineHeight: 1.2,
            }}
          >
            Analytics Dashboard
          </h1>
          <p
            className="font-body mt-1"
            style={{
              fontSize: 14,
              color: 'var(--color-text-secondary)',
            }}
          >
            Insights across your workspace.
          </p>
        </div>

        <div className="flex items-center gap-3 flex-wrap w-full sm:w-auto">
          <div className="w-full sm:w-[180px]">
            <Dropdown
              options={boardOptions}
              value={boardFilter}
              onChange={setBoardFilter}
              placeholder="All Boards"
              size="sm"
            />
          </div>
          <div className="w-full sm:w-[160px]">
            <Dropdown
              options={RANGE_OPTIONS}
              value={range}
              onChange={setRange}
              placeholder="Last 30 days"
              size="sm"
            />
          </div>
        </div>
      </div>

      {error && (
        <div
          className="font-body mt-4"
          style={{
            padding: '10px 14px',
            borderRadius: 'var(--radius-md)',
            background: 'var(--color-status-stuck-bg)',
            color: 'var(--color-status-stuck)',
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}

      {/* Stat cards */}
      <div className="grid gap-4 mt-6 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        {loading && summary === INITIAL_SUMMARY
          ? [0, 1, 2, 3].map((i) => <SkeletonStatCard key={i} index={i} />)
          : statCards.map((card) => (
              <StatCard
                key={card.label}
                icon={card.icon}
                label={card.label}
                value={card.value}
                color={card.color}
                suffix={card.suffix}
                subLabel={card.subLabel}
                onClick={card.onClick}
              />
            ))}
      </div>

      {/* Chart row — 2 cols desktop, 1 col below lg */}
      <div className="mt-6 grid gap-5 grid-cols-1 lg:grid-cols-2">
        {loading && statusData.length === 0 ? (
          <>
            <SkeletonBarChart rows={4} />
            <SkeletonBarChart rows={4} />
          </>
        ) : (
          <>
            <BarChart
              title="Task Status Distribution"
              icon={PieChart}
              data={statusData}
            />
            <BarChart
              title="Priority Distribution"
              icon={Flag}
              data={priorityData}
            />
          </>
        )}
      </div>

      {/* Overdue insights — by priority, plus top assignees for those who may
          see other people's workload. Without them the priority chart takes the
          whole row rather than leaving half of it empty. */}
      <div
        className={
          canViewOthers
            ? 'mt-5 grid gap-5 grid-cols-1 lg:grid-cols-2'
            : 'mt-5 grid gap-5 grid-cols-1'
        }
      >
        {loading && overduePriorityData.length === 0 ? (
          <>
            <SkeletonBarChart rows={4} />
            {canViewOthers && <SkeletonOverdueAssignees rows={5} />}
          </>
        ) : (
          <>
            <BarChart
              title="Overdue by Priority"
              icon={AlertTriangle}
              data={overduePriorityData}
            />
            {canViewOthers && (
              <OverdueAssignees assignees={overdue.topAssignees} />
            )}
          </>
        )}
      </div>

      {/* Board performance */}
      <div className="mt-5">
        {loading && boardPerformance.length === 0 ? (
          <SkeletonBoardPerformance rows={3} />
        ) : (
          <BoardPerformance boards={boardPerformance} />
        )}
      </div>

      {/* Full-screen overdue breakdown (opens from the Overdue stat card) */}
      {canViewOthers && (
        <OverdueTasksModal
          isOpen={overdueModalOpen}
          onClose={() => setOverdueModalOpen(false)}
          assignees={overdue.byAssignee || []}
          totalCount={overdue.count}
          onSelectTask={handleSelectOverdueTask}
        />
      )}
    </PageWrapper>
  );
};

export default AnalyticsPage;
