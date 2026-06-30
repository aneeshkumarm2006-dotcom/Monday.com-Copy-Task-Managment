import useNotificationStore from '../../store/notificationStore';
import NotificationItem from './NotificationItem';
import { FILTER_TABS, groupNotificationsByDate } from './notificationMeta';

/**
 * The filter tab row (underline style, with an unread count badge on "Unread").
 */
const FilterTabs = ({ active, unreadCount, onChange }) => (
  <div
    role="tablist"
    aria-label="Filter notifications"
    className="flex items-center gap-1 px-2 overflow-x-auto"
    style={{ borderBottom: '1px solid var(--color-border)' }}
  >
    {FILTER_TABS.map((tab) => {
      const isActive = active === tab.key;
      const showCount = tab.key === 'unread' && unreadCount > 0;
      return (
        <button
          key={tab.key}
          role="tab"
          aria-selected={isActive}
          type="button"
          onClick={() => onChange(tab.key)}
          className="relative shrink-0 px-2.5 py-2 font-body text-[13px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[color:var(--color-accent)]"
          style={{
            color: isActive
              ? 'var(--color-text-primary)'
              : 'var(--color-text-muted)',
            fontWeight: isActive ? 600 : 500,
          }}
        >
          <span className="inline-flex items-center gap-1.5">
            {tab.label}
            {showCount && (
              <span
                className="inline-flex items-center justify-center font-body"
                style={{
                  minWidth: 16,
                  height: 16,
                  padding: '0 4px',
                  borderRadius: 9999,
                  fontSize: 10,
                  fontWeight: 700,
                  color: 'white',
                  background: 'var(--color-accent)',
                }}
              >
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            )}
          </span>
          {isActive && (
            <span
              aria-hidden="true"
              className="absolute left-2 right-2"
              style={{
                bottom: -1,
                height: 2,
                borderRadius: 2,
                background: 'var(--color-accent)',
              }}
            />
          )}
        </button>
      );
    })}
  </div>
);

const EMPTY_COPY = {
  all: "You're all caught up.",
  unread: 'No unread notifications.',
  mentioned: 'No mentions yet.',
  assigned: 'No assignment notifications.',
  bookmarked: 'No saved notifications yet.',
};

/**
 * The notification feed: filter tabs + a date-grouped, paginated list. Shared by
 * the bell dropdown (`variant="panel"`) and the full-page center
 * (`variant="page"`). Reads everything from the notification store; the parent
 * supplies the org id and an `onActivate` handler (which navigates and, for the
 * bell, closes the dropdown).
 */
const NotificationFeed = ({ orgId, onActivate, variant = 'panel' }) => {
  const notifications = useNotificationStore((s) => s.notifications);
  const unreadCount = useNotificationStore((s) => s.unreadCount);
  const filter = useNotificationStore((s) => s.filter);
  const loading = useNotificationStore((s) => s.loading);
  const loadingMore = useNotificationStore((s) => s.loadingMore);
  const nextCursor = useNotificationStore((s) => s.nextCursor);
  const setFilter = useNotificationStore((s) => s.setFilter);
  const fetchMore = useNotificationStore((s) => s.fetchMore);

  const groups = groupNotificationsByDate(notifications);
  const isPanel = variant === 'panel';

  return (
    <div className="flex flex-col min-h-0 flex-1">
      <FilterTabs
        active={filter}
        unreadCount={unreadCount}
        onChange={(key) => setFilter(orgId, key)}
      />

      <div
        className="overflow-y-auto flex-1"
        style={isPanel ? { maxHeight: 380 } : undefined}
      >
        {loading && notifications.length === 0 ? (
          <div className="px-4 py-8 text-center font-body text-[13px] text-[color:var(--color-text-muted)]">
            Loading…
          </div>
        ) : notifications.length === 0 ? (
          <div className="px-4 py-10 text-center font-body text-[13px] text-[color:var(--color-text-muted)]">
            {EMPTY_COPY[filter] || EMPTY_COPY.all}
          </div>
        ) : (
          <>
            {groups.map((group) => (
              <div key={group.key}>
                <div
                  className="px-4 py-1.5 font-body text-[11px] uppercase tracking-wide text-[color:var(--color-text-muted)] sticky top-0 z-[1]"
                  style={{
                    background: 'var(--color-bg-subtle)',
                    letterSpacing: '0.04em',
                    fontWeight: 600,
                  }}
                >
                  {group.label}
                </div>
                {group.items.map((n) => (
                  <NotificationItem
                    key={n._id}
                    notif={n}
                    onActivate={onActivate}
                  />
                ))}
              </div>
            ))}

            {nextCursor && (
              <div className="px-4 py-3 flex justify-center">
                <button
                  type="button"
                  onClick={() => fetchMore(orgId)}
                  disabled={loadingMore}
                  className="font-body text-[13px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)] rounded"
                  style={{
                    color: 'var(--color-accent)',
                    fontWeight: 500,
                    cursor: loadingMore ? 'default' : 'pointer',
                  }}
                >
                  {loadingMore ? 'Loading…' : 'Load more'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default NotificationFeed;
