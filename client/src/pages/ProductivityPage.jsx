import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Users,
  CheckCircle2,
  AlertTriangle,
  TrendingUp,
  ChevronRight,
  RefreshCw,
  User as UserIcon,
} from 'lucide-react';
import PageWrapper from '../components/layout/PageWrapper';
import StatCard from '../components/ui/StatCard';
import Dropdown from '../components/ui/Dropdown';
import Chip from '../components/ui/Chip';
import { SkeletonStatCard, SkeletonBlock, SkeletonCircle } from '../components/ui/Skeleton';
import useAuthStore from '../store/authStore';
import useOrgStore from '../store/orgStore';
import { getProductivity } from '../services/productivityService';
import { formatShortDate, isOverdue } from '../utils/dateUtils';

const RANGE_OPTIONS = [
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: 'all', label: 'All time' },
];

const SORT_OPTIONS = [
  { value: 'active', label: 'Most active' },
  { value: 'completion', label: 'Highest completion' },
  { value: 'overdue', label: 'Most overdue' },
  { value: 'name', label: 'Name (A–Z)' },
];

const Avatar = ({ user, size = 40 }) => {
  const [imgError, setImgError] = useState(false);
  const handleError = useCallback(() => setImgError(true), []);

  if (user?.profilePic && !imgError) {
    return (
      <img
        src={user.profilePic}
        alt={user.name || 'Avatar'}
        className="object-cover"
        style={{ width: size, height: size, borderRadius: 9999 }}
        onError={handleError}
      />
    );
  }
  return (
    <div
      className="flex items-center justify-center"
      style={{
        width: size,
        height: size,
        borderRadius: 9999,
        background: 'var(--color-bg-subtle)',
        border: '1px solid var(--color-border)',
      }}
      aria-hidden="true"
    >
      <UserIcon
        size={Math.round(size * 0.55)}
        color="var(--color-text-muted)"
        strokeWidth={2}
      />
    </div>
  );
};

const RoleBadge = ({ role }) => {
  if (role === 'owner') {
    return (
      <span
        className="inline-flex items-center font-body font-semibold"
        style={{
          height: 20,
          padding: '0 8px',
          fontSize: 10,
          borderRadius: 'var(--radius-full)',
          letterSpacing: 0.3,
          background: 'var(--color-accent-light)',
          color: 'var(--color-accent-text)',
        }}
      >
        OWNER
      </span>
    );
  }
  if (role === 'admin') {
    return (
      <span
        className="inline-flex items-center font-body font-semibold"
        style={{
          height: 20,
          padding: '0 8px',
          fontSize: 10,
          borderRadius: 'var(--radius-full)',
          letterSpacing: 0.3,
          background: 'var(--color-accent-light)',
          color: 'var(--color-accent-text)',
        }}
      >
        ADMIN
      </span>
    );
  }
  return null;
};

/**
 * Horizontal stacked progress bar showing the breakdown of a member's tasks
 * across statuses. Total width = 100%.
 */
const StatusBreakdownBar = ({ done, inProgress, notStarted, stuck }) => {
  const total = done + inProgress + notStarted + stuck;
  if (total === 0) {
    return (
      <div
        style={{
          height: 8,
          width: '100%',
          background: 'var(--color-bg-subtle)',
          borderRadius: 'var(--radius-full)',
        }}
        aria-label="No tasks"
      />
    );
  }
  const segs = [
    { key: 'done', value: done, color: 'var(--color-status-done)' },
    { key: 'working', value: inProgress, color: 'var(--color-status-working)' },
    { key: 'notstarted', value: notStarted, color: 'var(--color-status-notstarted)' },
    { key: 'stuck', value: stuck, color: 'var(--color-status-stuck)' },
  ];
  return (
    <div
      className="flex w-full overflow-hidden"
      style={{
        height: 8,
        background: 'var(--color-bg-subtle)',
        borderRadius: 'var(--radius-full)',
      }}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-label="Task status breakdown"
    >
      {segs.map((s) =>
        s.value > 0 ? (
          <div
            key={s.key}
            style={{
              width: `${(s.value / total) * 100}%`,
              background: s.color,
              transition: 'width 400ms ease-out',
            }}
            title={`${s.key}: ${s.value}`}
          />
        ) : null
      )}
    </div>
  );
};

const MemberRow = ({ member, expanded, onToggle, onOpenTask }) => {
  const { user, role, total, done, inProgress, notStarted, stuck,
    overdue, dueSoon, completionRate, currentTasks } = member;

  return (
    <div style={{ borderBottom: '1px solid var(--color-border)' }}>
      {/* Summary row */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="w-full text-left transition-colors hover:bg-[color:var(--color-bg-subtle)] focus:outline-none focus-visible:bg-[color:var(--color-bg-subtle)]"
        style={{ padding: '14px 16px' }}
      >
        <div className="grid grid-cols-[auto_1fr_auto] md:grid-cols-[auto_1.6fr_2fr_120px_110px_24px] items-center gap-3 md:gap-4">
          {/* Chevron */}
          <span
            aria-hidden="true"
            className="flex items-center justify-center"
            style={{
              width: 18,
              height: 18,
              color: 'var(--color-text-muted)',
              transition: 'transform 150ms ease',
              transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
            }}
          >
            <ChevronRight size={16} />
          </span>

          {/* Identity */}
          <div className="flex items-center gap-3 min-w-0">
            <Avatar user={user} size={36} />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="font-body font-semibold text-[14px] text-[color:var(--color-text-primary)] truncate">
                  {user.name || 'Unnamed'}
                </p>
                <RoleBadge role={role} />
              </div>
              <p className="font-body text-[12px] text-[color:var(--color-text-muted)] truncate">
                {user.email}
              </p>
            </div>
          </div>

          {/* Status breakdown bar + counts */}
          <div className="hidden md:flex flex-col gap-1.5 min-w-0">
            <StatusBreakdownBar
              done={done}
              inProgress={inProgress}
              notStarted={notStarted}
              stuck={stuck}
            />
            <div className="flex items-center gap-3 font-body text-[11px] text-[color:var(--color-text-muted)] flex-wrap">
              <span className="inline-flex items-center gap-1">
                <span style={{ width: 8, height: 8, background: 'var(--color-status-done)', borderRadius: 9999 }} />
                {done} done
              </span>
              <span className="inline-flex items-center gap-1">
                <span style={{ width: 8, height: 8, background: 'var(--color-status-working)', borderRadius: 9999 }} />
                {inProgress} active
              </span>
              <span className="inline-flex items-center gap-1">
                <span style={{ width: 8, height: 8, background: 'var(--color-status-notstarted)', borderRadius: 9999 }} />
                {notStarted} todo
              </span>
              {stuck > 0 && (
                <span className="inline-flex items-center gap-1">
                  <span style={{ width: 8, height: 8, background: 'var(--color-status-stuck)', borderRadius: 9999 }} />
                  {stuck} stuck
                </span>
              )}
            </div>
          </div>

          {/* Overdue / due soon */}
          <div className="hidden md:flex flex-col items-start">
            <span
              className="font-body font-semibold text-[13px]"
              style={{
                color: overdue > 0 ? 'var(--color-status-stuck)' : 'var(--color-text-primary)',
              }}
            >
              {overdue} overdue
            </span>
            <span className="font-body text-[11px] text-[color:var(--color-text-muted)]">
              {dueSoon} due soon
            </span>
          </div>

          {/* Completion rate */}
          <div className="hidden md:flex flex-col items-end">
            <span className="font-display font-bold text-[16px] text-[color:var(--color-text-primary)] leading-none">
              {completionRate}%
            </span>
            <span className="font-body text-[11px] text-[color:var(--color-text-muted)] mt-0.5">
              {done} / {total}
            </span>
          </div>

          {/* Mobile compact stats */}
          <div className="flex md:hidden flex-col items-end shrink-0">
            <span className="font-display font-bold text-[14px] text-[color:var(--color-text-primary)]">
              {completionRate}%
            </span>
            <span className="font-body text-[11px] text-[color:var(--color-text-muted)]">
              {done}/{total}
              {overdue > 0 && (
                <span className="ml-1" style={{ color: 'var(--color-status-stuck)' }}>
                  · {overdue} overdue
                </span>
              )}
            </span>
          </div>

          {/* Spacer for grid alignment on desktop */}
          <span className="hidden md:block" />
        </div>
      </button>

      {/* Expanded current tasks */}
      {expanded && (
        <div
          style={{
            background: 'var(--color-bg-subtle)',
            padding: '12px 16px 16px 50px',
          }}
        >
          <p
            className="font-body font-semibold uppercase tracking-wide mb-2"
            style={{ fontSize: 11, color: 'var(--color-text-muted)' }}
          >
            Currently working on
          </p>
          {currentTasks.length === 0 ? (
            <p className="font-body text-[13px] text-[color:var(--color-text-muted)]">
              No active tasks.
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              {currentTasks.map((t) => {
                const od = t.dueDate && isOverdue(t.dueDate);
                return (
                  <button
                    key={t._id}
                    type="button"
                    onClick={() => onOpenTask(t)}
                    className="w-full flex items-center gap-3 text-left transition-colors hover:bg-white focus:outline-none rounded-md"
                    style={{ padding: '8px 10px' }}
                  >
                    <span
                      className="font-body text-[13px] text-[color:var(--color-text-primary)] truncate flex-1"
                    >
                      {t.name}
                    </span>
                    {t.boardName && (
                      <span className="font-body text-[11px] text-[color:var(--color-text-muted)] truncate hidden sm:inline">
                        {t.boardName}
                      </span>
                    )}
                    <Chip type="priority" value={t.priority} className="shrink-0" />
                    <Chip type="status" value={t.status} className="shrink-0" />
                    <span
                      className="font-body text-[11px] shrink-0"
                      style={{
                        color: od
                          ? 'var(--color-status-stuck)'
                          : 'var(--color-text-muted)',
                        fontWeight: od ? 600 : 400,
                        minWidth: 56,
                        textAlign: 'right',
                      }}
                    >
                      {t.dueDate ? formatShortDate(t.dueDate) : '—'}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const useIsCurrentOrgAdmin = () => {
  const user = useAuthStore((s) => s.user);
  const currentOrg = useOrgStore((s) => s.currentOrg);
  if (!user || !currentOrg) return false;
  const adminId =
    typeof currentOrg.admin === 'object' && currentOrg.admin !== null
      ? currentOrg.admin._id || currentOrg.admin
      : currentOrg.admin;
  const isMainAdmin = !!adminId && String(adminId) === String(user._id);
  const isExtraAdmin = Array.isArray(currentOrg.admins) &&
    currentOrg.admins.some((a) => {
      const id = typeof a === 'object' && a !== null ? a._id || a : a;
      return String(id) === String(user._id);
    });
  return isMainAdmin || isExtraAdmin;
};

const ProductivityPage = () => {
  const isAdmin = useIsCurrentOrgAdmin();
  const currentOrg = useOrgStore((s) => s.currentOrg);
  const navigate = useNavigate();

  const [range, setRange] = useState('30d');
  const [sortBy, setSortBy] = useState('active');
  const [search, setSearch] = useState('');
  const [expandedId, setExpandedId] = useState(null);

  const [data, setData] = useState({ summary: null, members: [] });
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  // Bumping this re-runs the fetch effect — used by the manual refresh button
  // and the on-focus refetch below.
  const [refreshTick, setRefreshTick] = useState(0);
  // After the first successful load we keep the existing data on screen during
  // refetches and show a subtle spinner instead of the full-page skeleton.
  const hasLoadedRef = useRef(false);

  const orgId = currentOrg?._id || null;

  useEffect(() => {
    if (!orgId || !isAdmin) return undefined;
    let cancelled = false;

    Promise.resolve().then(() => {
      if (cancelled) return;
      if (hasLoadedRef.current) setRefreshing(true);
      else setLoading(true);
      setError(null);
    });

    getProductivity({ orgId, range })
      .then((res) => {
        if (cancelled) return;
        setData({ summary: res.summary, members: res.members || [] });
        hasLoadedRef.current = true;
      })
      .catch((err) => {
        console.error('Failed to load productivity:', err);
        if (cancelled) return;
        setError('Could not load productivity data.');
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
        setRefreshing(false);
      });

    return () => {
      cancelled = true;
    };
  }, [orgId, isAdmin, range, refreshTick]);

  // Productivity reads live task data, but this page only fetched on mount.
  // If a task is deleted on a board while this page sits open in another tab,
  // its now-gone task would otherwise keep showing here as overdue. Refetch
  // whenever the tab/window regains focus so the view can't go stale.
  useEffect(() => {
    if (!orgId || !isAdmin) return undefined;
    const refetchIfVisible = () => {
      if (document.visibilityState === 'visible') {
        setRefreshTick((n) => n + 1);
      }
    };
    window.addEventListener('focus', refetchIfVisible);
    document.addEventListener('visibilitychange', refetchIfVisible);
    return () => {
      window.removeEventListener('focus', refetchIfVisible);
      document.removeEventListener('visibilitychange', refetchIfVisible);
    };
  }, [orgId, isAdmin]);

  const filteredSorted = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = data.members.filter((m) => {
      if (!q) return true;
      return (
        (m.user.name || '').toLowerCase().includes(q) ||
        (m.user.email || '').toLowerCase().includes(q)
      );
    });
    list = [...list];
    if (sortBy === 'completion') {
      list.sort((a, b) => {
        if (b.completionRate !== a.completionRate) {
          return b.completionRate - a.completionRate;
        }
        return b.total - a.total;
      });
    } else if (sortBy === 'overdue') {
      list.sort((a, b) => {
        if (b.overdue !== a.overdue) return b.overdue - a.overdue;
        return b.total - a.total;
      });
    } else if (sortBy === 'name') {
      list.sort((a, b) => (a.user.name || '').localeCompare(b.user.name || ''));
    } else {
      // active = total desc
      list.sort((a, b) => {
        if (b.total !== a.total) return b.total - a.total;
        return (a.user.name || '').localeCompare(b.user.name || '');
      });
    }
    return list;
  }, [data.members, search, sortBy]);

  const summary = data.summary || {
    memberCount: 0,
    totalAssignments: 0,
    totalDone: 0,
    totalOverdue: 0,
    avgCompletionRate: 0,
  };

  const statCards = [
    {
      icon: Users,
      label: 'Members',
      value: summary.memberCount,
      color: 'blue',
    },
    {
      icon: CheckCircle2,
      label: 'Tasks Completed',
      value: summary.totalDone,
      color: 'green',
    },
    {
      icon: AlertTriangle,
      label: 'Overdue Tasks',
      value: summary.totalOverdue,
      color: 'red',
    },
    {
      icon: TrendingUp,
      label: 'Avg Completion',
      value: summary.avgCompletionRate,
      suffix: '%',
      color: 'purple',
    },
  ];

  const handleOpenTask = (task) => {
    if (task.boardId) {
      navigate(`/boards/${task.boardId}?highlightTask=${task._id}`);
    }
  };

  return (
    <PageWrapper>
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1
            className="font-display font-bold text-[22px] md:text-[28px]"
            style={{
              color: 'var(--color-text-primary)',
              lineHeight: 1.2,
            }}
          >
            Team Productivity
          </h1>
          <p
            className="font-body mt-1"
            style={{ fontSize: 14, color: 'var(--color-text-secondary)' }}
          >
            See what every member is working on and how the team is performing.
          </p>
        </div>

        <div className="flex items-center gap-3 flex-wrap w-full sm:w-auto">
          <div className="w-full sm:w-[180px]">
            <Dropdown
              options={SORT_OPTIONS}
              value={sortBy}
              onChange={setSortBy}
              placeholder="Sort by"
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
          <button
            type="button"
            onClick={() => setRefreshTick((n) => n + 1)}
            disabled={loading || refreshing}
            title="Refresh"
            aria-label="Refresh productivity data"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border transition-colors disabled:opacity-60"
            style={{
              borderColor: 'var(--color-border)',
              background: 'var(--color-bg-subtle)',
              color: 'var(--color-text-secondary)',
            }}
          >
            <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
          </button>
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
        {loading && !data.summary
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

      {/* Member list */}
      <section
        className="bg-surface mt-6"
        style={{
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-card)',
          overflow: 'hidden',
        }}
      >
        {/* Toolbar */}
        <div
          className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
          style={{ borderBottom: '1px solid var(--color-border)' }}
        >
          <div className="flex items-center gap-2">
            <h2
              className="font-display font-semibold"
              style={{ fontSize: 15, color: 'var(--color-text-primary)' }}
            >
              Members
            </h2>
            <span
              className="font-body text-[12px]"
              style={{ color: 'var(--color-text-muted)' }}
            >
              {filteredSorted.length} of {data.members.length}
            </span>
          </div>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search members…"
            className="w-full sm:w-auto font-body text-[13px] text-[color:var(--color-text-primary)] bg-[color:var(--color-bg-input)] focus:outline-none focus:border-[color:var(--color-accent)]"
            style={{
              height: 32,
              padding: '0 12px',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-full)',
              minWidth: 200,
            }}
          />
        </div>

        {/* Header (desktop) */}
        <div
          className="hidden md:grid grid-cols-[auto_1.6fr_2fr_120px_110px_24px] items-center gap-4 px-4"
          style={{
            height: 36,
            background: 'var(--color-bg-subtle)',
            borderBottom: '1px solid var(--color-border)',
          }}
        >
          <span style={{ width: 18 }} />
          <span className="font-body font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]" style={{ fontSize: 11 }}>
            Member
          </span>
          <span className="font-body font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]" style={{ fontSize: 11 }}>
            Task Breakdown
          </span>
          <span className="font-body font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]" style={{ fontSize: 11 }}>
            Due Status
          </span>
          <span className="font-body font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)] text-right" style={{ fontSize: 11 }}>
            Completion
          </span>
          <span />
        </div>

        {/* Rows */}
        {loading && data.members.length === 0 ? (
          <div className="flex flex-col">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="flex items-center gap-3 px-4 py-4"
                style={{ borderBottom: '1px solid var(--color-border)' }}
              >
                <SkeletonCircle size={36} />
                <div className="flex-1 flex flex-col gap-2">
                  <SkeletonBlock width={140} height={12} />
                  <SkeletonBlock width="100%" height={8} borderRadius="var(--radius-full)" />
                </div>
                <SkeletonBlock width={50} height={20} />
              </div>
            ))}
          </div>
        ) : filteredSorted.length === 0 ? (
          <div className="px-4 py-12 text-center font-body text-[13px] text-[color:var(--color-text-muted)]">
            {data.members.length === 0
              ? 'No members yet.'
              : 'No members match your search.'}
          </div>
        ) : (
          <div>
            {filteredSorted.map((m) => (
              <MemberRow
                key={m.user._id}
                member={m}
                expanded={expandedId === m.user._id}
                onToggle={() =>
                  setExpandedId((id) => (id === m.user._id ? null : m.user._id))
                }
                onOpenTask={handleOpenTask}
              />
            ))}
          </div>
        )}
      </section>
    </PageWrapper>
  );
};

export default ProductivityPage;
