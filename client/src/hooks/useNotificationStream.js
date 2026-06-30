import { useEffect } from 'react';
import useNotificationStore from '../store/notificationStore';
import useToastStore from '../store/toastStore';

/**
 * Real-time notification delivery over Server-Sent Events. Opens an EventSource
 * to the notifications stream (authenticated via a ?token= query param since
 * EventSource can't set headers), pushes each received notification into the
 * store, and surfaces a transient toast. Re-keys on token/org so it reconnects
 * to the right scope; native EventSource auto-reconnect plus the polling
 * fallback (useNotificationPoll) cover transient drops.
 */
export default function useNotificationStream(token, orgId, enabled) {
  const pushNotification = useNotificationStore((s) => s.pushNotification);

  useEffect(() => {
    if (!enabled || !token) return undefined;

    const base = import.meta.env.VITE_API_BASE_URL || '';
    const params = new URLSearchParams({ token });
    if (orgId) params.set('org', orgId);
    const url = `${base}/api/notifications/stream?${params.toString()}`;

    let es;
    try {
      es = new EventSource(url);
    } catch {
      return undefined;
    }

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data?.type === 'notification' && data.notification) {
          pushNotification(data.notification);
          if (data.notification.message) {
            useToastStore
              .getState()
              .info(data.notification.message, { duration: 5000 });
          }
        }
      } catch {
        // ignore heartbeats / malformed frames
      }
    };

    es.onerror = () => {
      // EventSource auto-reconnects; the polling fallback covers any gap.
    };

    return () => {
      es.close();
    };
  }, [token, orgId, enabled, pushNotification]);
}
