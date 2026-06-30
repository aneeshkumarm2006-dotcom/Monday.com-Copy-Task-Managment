import { useEffect } from 'react';
import useNotificationStore from '../store/notificationStore';

const POLL_MS = 45000;

/**
 * Background freshness for the notification bell. Polls the lightweight
 * unread-count endpoint on an interval (only while the tab is visible) and
 * immediately on window focus / tab-visible, so the badge stays current even
 * when the SSE stream is unavailable. This is the always-on fallback that backs
 * up `useNotificationStream`.
 */
export default function useNotificationPoll(orgId, enabled) {
  const refreshUnreadCount = useNotificationStore((s) => s.refreshUnreadCount);

  useEffect(() => {
    if (!enabled) return undefined;

    const tick = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      refreshUnreadCount(orgId);
    };

    const timer = setInterval(tick, POLL_MS);
    const onFocus = () => tick();
    const onVisible = () => {
      if (!document.hidden) tick();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [orgId, enabled, refreshUnreadCount]);
}
