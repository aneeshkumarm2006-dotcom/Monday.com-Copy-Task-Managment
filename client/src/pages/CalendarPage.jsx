import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Calendar, momentLocalizer } from 'react-big-calendar';
import moment from 'moment';
import 'react-big-calendar/lib/css/react-big-calendar.css';
import { ChevronLeft, ChevronRight, List as ListIcon, LayoutGrid } from 'lucide-react';
import PageWrapper from '../components/layout/PageWrapper';
import { SkeletonCalendarGrid } from '../components/ui/Skeleton';
import CommentPanel from '../components/board/CommentPanel';
import CalendarFilterBar, { UNASSIGNED_ID } from '../components/calendar/CalendarFilterBar';
import CalendarThemeStyles from '../components/calendar/CalendarThemeStyles';
import useOrgStore from '../store/orgStore';
import useBoardStore from '../store/boardStore';
import { getCalendarTasks } from '../services/taskService';
import { getPriorityColor } from '../utils/priorityColors';
import { isStatusDone } from '../utils/statusUtils';
import { DONE_GREEN, taskToEvent, eventPropGetter } from '../utils/calendarEvents';

/**
 * CalendarPage — month/week calendar view of all tasks with a due date.
 *
 * See Macan_Design.md Section 7.6.
 *
 * Admins see all org board tasks. Regular users see only assigned tasks on
 * public boards. Personal tasks are always included for the current user.
 * Event pills are color-coded by priority. Clicking an event opens the same
 * CommentPanel used on the board view (Section 6.9).
 *
 * On mobile (<768px) the default view is a simplified list. On desktop the
 * default is the month grid with a month/week toggle.
 */

const localizer = momentLocalizer(moment);

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Header toolbar — month/week toggle + month navigation + grid/list (mobile).
 */
const CalendarToolbar = ({
  view,
  onViewChange,
  date,
  onNavigate,
  mobileMode,
  onMobileModeChange,
  isMobile,
}) => {
  const label = view === 'week'
    ? moment(date).startOf('week').format('MMM D') +
      ' – ' +
      moment(date).endOf('week').format('MMM D, YYYY')
    : `${MONTH_NAMES[date.getMonth()]} ${date.getFullYear()}`;

  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
      <h1
        className="font-display font-bold"
        style={{
          fontSize: 28,
          color: 'var(--color-text-primary)',
          lineHeight: 1.2,
        }}
      >
        Calendar
      </h1>

      <div className="flex flex-wrap items-center gap-3">
        {/* Mobile grid/list toggle */}
        {isMobile && (
          <PillToggle
            options={[
              { value: 'list', label: 'List', icon: ListIcon },
              { value: 'grid', label: 'Grid', icon: LayoutGrid },
            ]}
            value={mobileMode}
            onChange={onMobileModeChange}
          />
        )}

        {/* Month/Week view toggle — hidden in mobile list mode */}
        {(!isMobile || mobileMode === 'grid') && (
          <PillToggle
            options={[
              { value: 'month', label: 'Month' },
              { value: 'week', label: 'Week' },
            ]}
            value={view}
            onChange={onViewChange}
          />
        )}

        {/* Month navigation — always visible */}
        <div
          className="flex items-center gap-1 bg-surface"
          style={{
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-full)',
            padding: '2px 6px',
          }}
        >
          <NavArrow
            direction="prev"
            onClick={() => onNavigate('PREV')}
          />
          <span
            className="font-body font-medium"
            style={{
              fontSize: 13,
              color: 'var(--color-text-primary)',
              minWidth: 140,
              textAlign: 'center',
              padding: '0 8px',
            }}
          >
            {label}
          </span>
          <NavArrow
            direction="next"
            onClick={() => onNavigate('NEXT')}
          />
        </div>
      </div>
    </div>
  );
};

const NavArrow = ({ direction, onClick }) => {
  const Icon = direction === 'prev' ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={direction === 'prev' ? 'Previous' : 'Next'}
      className="flex items-center justify-center rounded-full transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
      style={{ width: 28, height: 28 }}
    >
      <Icon size={16} color="var(--color-text-secondary)" aria-hidden="true" />
    </button>
  );
};

/**
 * Small pill-style segmented toggle.
 */
const PillToggle = ({ options, value, onChange }) => (
  <div
    className="flex items-center bg-surface"
    style={{
      border: '1px solid var(--color-border)',
      borderRadius: 'var(--radius-full)',
      padding: 2,
    }}
  >
    {options.map((opt) => {
      const active = opt.value === value;
      const Icon = opt.icon;
      return (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          aria-pressed={active}
          className="font-body font-medium transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
          style={{
            fontSize: 12,
            height: 28,
            padding: Icon ? '0 10px' : '0 14px',
            borderRadius: 'var(--radius-full)',
            background: active ? 'var(--color-accent)' : 'transparent',
            color: active ? '#FFFFFF' : 'var(--color-text-secondary)',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            cursor: 'pointer',
          }}
        >
          {Icon && <Icon size={13} aria-hidden="true" />}
          {opt.label}
        </button>
      );
    })}
  </div>
);

/**
 * Simplified list view — used as the default on mobile. Groups tasks by due
 * date and displays them as rows with a priority dot.
 */
const TaskListView = ({ events, onSelect }) => {
  const grouped = useMemo(() => {
    const byDate = new Map();
    for (const ev of events) {
      const key = moment(ev.start).format('YYYY-MM-DD');
      if (!byDate.has(key)) byDate.set(key, []);
      byDate.get(key).push(ev);
    }
    return [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [events]);

  if (events.length === 0) {
    return (
      <div
        className="bg-surface text-center"
        style={{
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-card)',
          padding: '40px 20px',
        }}
      >
        <p
          className="font-body"
          style={{ fontSize: 14, color: 'var(--color-text-muted)' }}
        >
          No tasks scheduled for this month.
        </p>
      </div>
    );
  }

  return (
    <div
      className="bg-surface overflow-hidden"
      style={{
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-card)',
      }}
    >
      {grouped.map(([dateKey, items], groupIdx) => (
        <div key={dateKey}>
          <div
            className="font-body font-semibold"
            style={{
              fontSize: 11,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              color: 'var(--color-text-secondary)',
              padding: '10px 16px',
              background: 'var(--color-bg-subtle)',
              borderTop:
                groupIdx === 0 ? 'none' : '1px solid var(--color-border)',
              borderBottom: '1px solid var(--color-border)',
            }}
          >
            {moment(dateKey).format('ddd, MMM D')}
          </div>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {items.map((ev, i) => {
              const task = ev.resource;
              const done = isStatusDone(task.board, task.status);
              const solid = done
                ? DONE_GREEN
                : getPriorityColor(task.priority || 'low').solid;
              const isSub = Boolean(task.parent);
              // Subtasks show their parent's name as the secondary line;
              // top-level tasks show the board name.
              const subtitle = isSub
                ? `↳ ${task.parent?.name || 'Subtask'}`
                : task.board?.name || '';
              return (
                <li
                  key={task._id}
                  style={{
                    borderBottom:
                      i === items.length - 1
                        ? 'none'
                        : '1px solid var(--color-border)',
                  }}
                >
                  <button
                    type="button"
                    onClick={() => onSelect(ev)}
                    className="w-full flex items-center gap-3 text-left transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)] focus:outline-none focus:bg-[color:var(--color-bg-subtle)]"
                    style={{ padding: '12px 16px', paddingLeft: isSub ? 36 : 16 }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: '50%',
                        // Subtasks get a hollow ring, main tasks a filled dot.
                        background: isSub ? 'transparent' : solid,
                        border: isSub ? `2px solid ${solid}` : 'none',
                        flexShrink: 0,
                      }}
                    />
                    <span className="min-w-0 flex-1">
                      <span
                        className="font-body block truncate"
                        style={{
                          fontSize: 14,
                          fontWeight: 500,
                          color: 'var(--color-text-primary)',
                        }}
                      >
                        {task.name}
                      </span>
                      {subtitle && (
                        <span
                          className="font-body block truncate"
                          style={{
                            fontSize: 12,
                            color: 'var(--color-text-muted)',
                            marginTop: 2,
                          }}
                        >
                          {subtitle}
                        </span>
                      )}
                    </span>
                    <span
                      className="font-body"
                      style={{
                        fontSize: 11,
                        color: 'var(--color-text-muted)',
                        textTransform: 'capitalize',
                        flexShrink: 0,
                      }}
                    >
                      {(task.priority || 'low').replace(/_/g, ' ')}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
};

const CalendarPage = () => {
  const currentOrg = useOrgStore((s) => s.currentOrg);
  const orgId = currentOrg?._id || null;
  const orgMembers = useOrgStore((s) => s.members);
  const fetchMembers = useOrgStore((s) => s.fetchMembers);
  const boards = useBoardStore((s) => s.boards);
  const fetchBoards = useBoardStore((s) => s.fetchBoards);

  const [view, setView] = useState('month');
  const [date, setDate] = useState(() => new Date());
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedTask, setSelectedTask] = useState(null);

  // --- URL-backed filter state -------------------------------------------
  // `?boards=id1,id2&assignees=id3,unassigned` survives month navigation and
  // page reloads. Empty arrays mean "no filter — show everything".
  const [searchParams, setSearchParams] = useSearchParams();

  const boardFilter = useMemo(() => {
    const raw = searchParams.get('boards');
    return raw ? raw.split(',').filter(Boolean) : [];
  }, [searchParams]);

  const assigneeFilter = useMemo(() => {
    const raw = searchParams.get('assignees');
    return raw ? raw.split(',').filter(Boolean) : [];
  }, [searchParams]);

  const updateFilterParam = useCallback(
    (key, ids) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (ids && ids.length > 0) next.set(key, ids.join(','));
          else next.delete(key);
          return next;
        },
        { replace: true }
      );
    },
    [setSearchParams]
  );

  const handleBoardFilterChange = useCallback(
    (ids) => updateFilterParam('boards', ids),
    [updateFilterParam]
  );
  const handleAssigneeFilterChange = useCallback(
    (ids) => updateFilterParam('assignees', ids),
    [updateFilterParam]
  );

  // Hydrate the boardStore and orgStore.members so the filter bar has options
  // when the calendar is opened directly (not via a board page).
  useEffect(() => {
    if (!orgId) return;
    if (boards.length === 0) {
      fetchBoards(orgId).catch((err) => {
        console.error('Failed to fetch boards for calendar filter:', err);
      });
    }
    if (orgMembers.length === 0) {
      fetchMembers(orgId).catch((err) => {
        console.error('Failed to fetch members for calendar filter:', err);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  // Track viewport width to switch between calendar grid and list view
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth < 768 : false
  );
  const [mobileMode, setMobileMode] = useState('list');

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const handler = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  // Fetch tasks for the currently-shown month
  useEffect(() => {
    let cancelled = false;
    const month = date.getMonth() + 1;
    const year = date.getFullYear();

    // Kick off the request. setState calls only happen inside the async
    // callbacks, guarded by `cancelled`, so no cascading renders from the
    // effect body itself.
    getCalendarTasks(month, year, orgId)
      .then((tasks) => {
        if (cancelled) return;
        const withDates = (tasks || []).filter((t) => t.dueDate);
        setEvents(withDates.map(taskToEvent));
        setError('');
      })
      .catch((err) => {
        console.error('Failed to fetch calendar tasks:', err);
        if (cancelled) return;
        setError(
          err?.response?.data?.error ||
            'Failed to load calendar. Please try again.'
        );
        setEvents([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    // Mark as loading via a microtask so the setState doesn't happen
    // synchronously inside the effect body.
    Promise.resolve().then(() => {
      if (!cancelled) setLoading(true);
    });

    return () => {
      cancelled = true;
    };
  }, [date, orgId]);

  const handleNavigate = useCallback(
    (action) => {
      setDate((prev) => {
        const next = new Date(prev);
        const delta = action === 'PREV' ? -1 : 1;
        if (view === 'week') {
          next.setDate(prev.getDate() + delta * 7);
        } else {
          next.setMonth(prev.getMonth() + delta);
          next.setDate(1);
        }
        return next;
      });
    },
    [view]
  );

  const handleSelectEvent = useCallback((event) => {
    setSelectedTask(event.resource);
  }, []);

  // Apply board + assignee filters with AND logic. The `unassigned` synthetic
  // id matches tasks with no assignees; real ids match by member _id.
  const visibleEvents = useMemo(() => {
    if (boardFilter.length === 0 && assigneeFilter.length === 0) return events;
    const boardSet = new Set(boardFilter);
    const assigneeSet = new Set(assigneeFilter);
    const matchUnassigned = assigneeSet.has(UNASSIGNED_ID);
    return events.filter((e) => {
      const task = e.resource || {};
      const boardId = task.board?._id || task.board || null;
      if (boardSet.size > 0 && !boardSet.has(boardId)) return false;
      if (assigneeSet.size > 0) {
        const assigned = task.assignedTo || [];
        const hasAny = assigned.length > 0;
        const matchesUser = assigned.some((a) =>
          assigneeSet.has(a?._id || a)
        );
        const matchesUnassignedRow = matchUnassigned && !hasAny;
        if (!matchesUser && !matchesUnassignedRow) return false;
      }
      return true;
    });
  }, [events, boardFilter, assigneeFilter]);

  const showList = isMobile && mobileMode === 'list';

  return (
    <>
      <PageWrapper>
        <CalendarToolbar
          view={view}
          onViewChange={setView}
          date={date}
          onNavigate={handleNavigate}
          mobileMode={mobileMode}
          onMobileModeChange={setMobileMode}
          isMobile={isMobile}
        />

        <div className="mt-4 flex justify-end">
          <CalendarFilterBar
            boards={boards}
            members={orgMembers}
            boardFilter={boardFilter}
            onBoardFilterChange={handleBoardFilterChange}
            assigneeFilter={assigneeFilter}
            onAssigneeFilterChange={handleAssigneeFilterChange}
          />
        </div>

        {error && (
          <div
            role="alert"
            className="mt-4 font-body"
            style={{
              background: 'var(--color-status-stuck-bg)',
              color: 'var(--color-status-stuck)',
              padding: '10px 14px',
              borderRadius: 'var(--radius-md)',
              fontSize: 13,
            }}
          >
            {error}
          </div>
        )}

        <div className="mt-5">
          {showList ? (
            <TaskListView events={visibleEvents} onSelect={handleSelectEvent} />
          ) : (
            <div
              className="bg-surface macan-calendar-wrap"
              style={{
                borderRadius: 'var(--radius-lg)',
                boxShadow: 'var(--shadow-card)',
                padding: 12,
                position: 'relative',
              }}
            >
              {loading && events.length === 0 ? (
                <SkeletonCalendarGrid />
              ) : (
                <Calendar
                  localizer={localizer}
                  events={visibleEvents}
                  date={date}
                  view={view}
                  onNavigate={setDate}
                  onView={setView}
                  onSelectEvent={handleSelectEvent}
                  eventPropGetter={eventPropGetter}
                  views={['month', 'week']}
                  popup
                  toolbar={false}
                  style={{ height: view === 'week' ? 640 : 720 }}
                />
              )}
            </div>
          )}
        </div>
      </PageWrapper>

      <CommentPanel
        task={selectedTask}
        isOpen={!!selectedTask}
        onClose={() => setSelectedTask(null)}
      />

      <CalendarThemeStyles />
    </>
  );
};

export default CalendarPage;
