import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import PageWrapper from '../components/layout/PageWrapper';
import NotificationFeed from '../components/notifications/NotificationFeed';
import { resolveNotifLink } from '../components/notifications/notificationMeta';
import useNotificationStore from '../store/notificationStore';
import useOrgStore from '../store/orgStore';

/**
 * Full-page notification center — the bell's "See all" destination. Reuses the
 * same NotificationFeed (tabs, date grouping, load-more, per-item actions) as
 * the bell dropdown, in a wider, page-level layout.
 */
const NotificationsPage = () => {
  const navigate = useNavigate();
  const currentOrgId = useOrgStore((s) => s.currentOrg?._id);
  const fetchNotifications = useNotificationStore((s) => s.fetchNotifications);
  const markRead = useNotificationStore((s) => s.markRead);
  const markAllRead = useNotificationStore((s) => s.markAllRead);
  const clearRead = useNotificationStore((s) => s.clearRead);
  const unreadCount = useNotificationStore((s) => s.unreadCount);
  // Whether anything currently loaded is already read — gates "Clear read".
  const hasRead = useNotificationStore((s) =>
    s.notifications.some((n) => n.isRead)
  );

  // Refresh the list (preserving the active filter) when the page mounts or the
  // active org changes.
  useEffect(() => {
    fetchNotifications(currentOrgId || undefined);
  }, [currentOrgId, fetchNotifications]);

  const handleActivate = (notif) => {
    if (!notif.isRead) markRead(notif._id);
    const link = resolveNotifLink(notif);
    if (link) navigate(link);
  };

  return (
    <PageWrapper>
      <div className="mx-auto" style={{ maxWidth: 720 }}>
        <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1
              className="font-display font-bold text-[color:var(--color-text-primary)] text-[22px] md:text-[28px]"
              style={{ letterSpacing: '-0.01em' }}
            >
              Notifications
            </h1>
            <p className="mt-1 font-body text-sm text-[color:var(--color-text-secondary)]">
              Everything happening across your workspace
            </p>
          </div>
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => markAllRead(currentOrgId || undefined)}
              disabled={unreadCount === 0}
              className="font-body text-[13px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)] rounded"
              style={{
                color:
                  unreadCount === 0
                    ? 'var(--color-text-muted)'
                    : 'var(--color-accent)',
                fontWeight: 500,
                cursor: unreadCount === 0 ? 'default' : 'pointer',
              }}
            >
              Mark all read
            </button>
            <button
              type="button"
              onClick={() => clearRead(currentOrgId || undefined)}
              disabled={!hasRead}
              title="Delete every notification you've already read"
              className="font-body text-[13px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)] rounded"
              style={{
                color: hasRead
                  ? 'var(--color-text-secondary)'
                  : 'var(--color-text-muted)',
                fontWeight: 500,
                cursor: hasRead ? 'pointer' : 'default',
              }}
            >
              Clear read
            </button>
            <button
              type="button"
              onClick={() => navigate('/settings')}
              className="font-body text-[13px] text-[color:var(--color-accent)] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)] rounded"
              style={{ fontWeight: 500 }}
            >
              Settings
            </button>
          </div>
        </header>

        <div
          className="bg-surface flex flex-col overflow-hidden"
          style={{
            borderRadius: 'var(--radius-lg)',
            boxShadow: 'var(--shadow-card)',
            minHeight: 420,
          }}
        >
          <NotificationFeed
            orgId={currentOrgId || undefined}
            onActivate={handleActivate}
            variant="page"
          />
        </div>
      </div>
    </PageWrapper>
  );
};

export default NotificationsPage;
