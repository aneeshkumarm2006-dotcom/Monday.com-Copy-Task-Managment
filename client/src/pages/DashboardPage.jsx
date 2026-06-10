import { useEffect, useMemo, useState } from 'react';
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
import { getDashboardStats } from '../services/boardService';

const INITIAL_STATS = {
  totalBoards: 0,
  completedTasks: 0,
  pendingTasks: 0,
  completionRate: 0,
};

const DashboardPage = () => {
  const user = useAuthStore((s) => s.user);
  const currentOrg = useOrgStore((s) => s.currentOrg);
  const boards = useBoardStore((s) => s.boards);
  const fetchBoards = useBoardStore((s) => s.fetchBoards);
  const boardsLoading = useBoardStore((s) => s.loading);

  const [stats, setStats] = useState(INITIAL_STATS);
  const [statsLoading, setStatsLoading] = useState(true);
  const orgId = currentOrg?._id || null;

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

  const statCards = useMemo(
    () => [
      {
        icon: Folder,
        label: 'Total Boards',
        value: stats.totalBoards,
        color: 'blue',
      },
      {
        icon: CheckCircle,
        label: 'Completed Tasks',
        value: stats.completedTasks,
        color: 'green',
      },
      {
        icon: Clock,
        label: 'Pending Tasks',
        value: stats.pendingTasks,
        color: 'orange',
      },
      {
        icon: TrendingUp,
        label: 'Completion Rate',
        value: stats.completionRate,
        suffix: '%',
        color: 'purple',
      },
    ],
    [stats]
  );

  return (
    <PageWrapper>
      {/* Greeting banner */}
      {boardsLoading && boards.length === 0 ? (
        <SkeletonGreetingBanner />
      ) : (
        <GreetingBanner
          name={user?.name}
          pendingCount={stats.pendingTasks}
        />
      )}

      {/* Stat cards — 4 cols desktop, 2 cols tablet, 1 col mobile */}
      <div className="grid gap-4 mt-6 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
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
              />
            ))}
      </div>

      {/* Content row — 2 cols desktop (1fr + 320px), single col below lg */}
      <div className="mt-6 grid gap-6 grid-cols-1 lg:grid-cols-[1fr_320px]">
        <div className="min-w-0 h-full">
          {boardsLoading && boards.length === 0 ? (
            <SkeletonRecentBoards rows={4} />
          ) : (
            <RecentBoards boards={boards} />
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
