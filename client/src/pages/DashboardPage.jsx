import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Folder, CheckCircle, Clock, TrendingUp } from 'lucide-react';
import PageWrapper from '../components/layout/PageWrapper';
import StatCard from '../components/ui/StatCard';
import {
  SkeletonStatCard,
  SkeletonRecentBoards,
  SkeletonQuickActions,
  SkeletonGreetingBanner,
} from '../components/ui/Skeleton';
import GreetingBanner from '../components/dashboard/GreetingBanner';
import RecentBoards from '../components/dashboard/RecentBoards';
import QuickActions from '../components/dashboard/QuickActions';
import useAuthStore from '../store/authStore';
import useOrgStore from '../store/orgStore';
import useBoardStore from '../store/boardStore';
import usePermissions from '../hooks/usePermissions';
import { getDashboardStats } from '../services/boardService';

const INITIAL_STATS = {
  totalBoards: 0,
  completedTasks: 0,
  pendingTasks: 0,
  myPendingTasks: 0,
  myOverdueTasks: 0,
  completionRate: 0,
};

const DashboardPage = () => {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const currentOrg = useOrgStore((s) => s.currentOrg);
  const boards = useBoardStore((s) => s.boards);
  const fetchBoards = useBoardStore((s) => s.fetchBoards);
  const boardsLoading = useBoardStore((s) => s.loading);

  const [stats, setStats] = useState(INITIAL_STATS);
  const [statsLoading, setStatsLoading] = useState(true);
  const orgId = currentOrg?._id || null;
  const { can } = usePermissions();
  // Analytics is capability-gated, so a card that opens it must only offer to
  // when the caller can actually get in — a drill-down that bounces you back
  // to where you started is worse than one that doesn't click.
  const canSeeAnalytics = can('analytics.view');

  // Fetch boards + stats whenever the current org changes
  useEffect(() => {
    if (!orgId) return undefined;

    let cancelled = false;

    fetchBoards(orgId).catch((err) => {
      console.error('Failed to fetch boards:', err);
    });

    setStatsLoading(true);
    getDashboardStats(orgId)
      .then((data) => {
        if (!cancelled) setStats({ ...INITIAL_STATS, ...data });
      })
      .catch((err) => {
        console.error('Failed to fetch dashboard stats:', err);
        if (!cancelled) setStats(INITIAL_STATS);
      })
      .finally(() => {
        if (!cancelled) setStatsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [orgId, fetchBoards]);

  /**
   * The four cards. Each one carries a line of context under the number and a
   * destination that SHOWS that number — a card opening a page where the
   * figure doesn't appear is worse than a card that doesn't click.
   *
   *   Boards          → the board list, which is the count
   *   Completed / Rate→ Analytics, where both are broken down (gated)
   *   Pending         → My Work, filtered to the caller's own open tasks
   */
  const statCards = useMemo(
    () => [
      {
        icon: Folder,
        label: 'Total Boards',
        value: stats.totalBoards,
        color: 'blue',
        subLabel:
          stats.totalBoards === 1 ? 'in this workspace' : 'you can open',
        onClick: () => navigate('/boards'),
      },
      {
        icon: CheckCircle,
        label: 'Completed Tasks',
        value: stats.completedTasks,
        color: 'green',
        subLabel: 'across every board you can see',
        onClick: canSeeAnalytics ? () => navigate('/analytics') : undefined,
      },
      {
        icon: Clock,
        label: 'Pending Tasks',
        value: stats.pendingTasks,
        color: 'orange',
        subHighlight: `${stats.myPendingTasks} yours`,
        subLabel:
          stats.myOverdueTasks > 0
            ? `${stats.myOverdueTasks} overdue`
            : 'none overdue',
        onClick: () => navigate('/my-tasks'),
      },
      {
        icon: TrendingUp,
        label: 'Completion Rate',
        value: stats.completionRate,
        suffix: '%',
        color: 'purple',
        subLabel: 'of all tasks, all time',
        onClick: canSeeAnalytics ? () => navigate('/analytics') : undefined,
      },
    ],
    [stats, navigate, canSeeAnalytics]
  );

  return (
    <PageWrapper>
      {/* Greeting banner */}
      {boardsLoading && boards.length === 0 ? (
        <SkeletonGreetingBanner />
      ) : (
        <GreetingBanner
          name={user?.name}
          pendingCount={stats.myPendingTasks}
          overdueCount={stats.myOverdueTasks}
        />
      )}

      {/* Stat cards — 4 cols desktop, 2×2 on phones (a 1-col stack of four
          pushed the boards list a full screen down). */}
      <div className="grid gap-3 sm:gap-4 mt-6 grid-cols-2 lg:grid-cols-4">
        {statsLoading && stats === INITIAL_STATS
          ? [0, 1, 2, 3].map((i) => <SkeletonStatCard key={i} index={i} />)
          : statCards.map((card) => (
              <StatCard
                key={card.label}
                icon={card.icon}
                label={card.label}
                value={card.value}
                color={card.color}
                suffix={card.suffix}
                subHighlight={card.subHighlight}
                subLabel={card.subLabel}
                onClick={card.onClick}
              />
            ))}
      </div>

      {/* Content row — 2 cols desktop (1fr + 320px), single col below lg */}
      <div className="mt-6 grid gap-6 grid-cols-1 lg:grid-cols-[1fr_320px]">
        <div className="min-w-0 h-full">
          {boardsLoading && boards.length === 0 ? (
            <SkeletonRecentBoards rows={4} />
          ) : (
            <RecentBoards boards={boards} orgId={orgId} />
          )}
        </div>
        <div className="flex flex-col gap-4 min-w-0 h-full">
          {boardsLoading && boards.length === 0 ? (
            <SkeletonQuickActions />
          ) : (
            <QuickActions />
          )}
        </div>
      </div>

    </PageWrapper>
  );
};

export default DashboardPage;
