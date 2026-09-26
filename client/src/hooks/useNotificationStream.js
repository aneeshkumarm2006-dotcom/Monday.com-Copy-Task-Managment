import { useEffect } from 'react';
import useNotificationStore from '../store/notificationStore';
import useToastStore from '../store/toastStore';
import useTaskStore from '../store/taskStore';
import useBoardStore from '../store/boardStore';
import useChatStore from '../store/chatStore';

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
        } else if (data?.type === 'board.changed' && data.boardId) {
          // An automation moved/created tasks out-of-band, or the board's money
          // was relabelled (its own currency, or a workspace currency change it
          // follows) — let the board view refetch if it's the one currently
          // open. Marked stale as well, so a board that is NOT open refetches
          // its cached document when it is opened rather than showing the old
          // unit (the open board's refetch clears the mark again).
          useBoardStore.getState().markBoardsStale(data.boardId);
          useTaskStore.getState().signalBoardRefresh(data.boardId);
        } else if (data?.type === 'chat.message' && data.channelId && data.message) {
          // A channel message from someone else. The chat store decides
          // whether it lands in an open conversation or bumps a badge.
          useChatStore.getState().receiveMessage(data.channelId, data.message);
        } else if (data?.type === 'chat.reaction' && data.messageId) {
          // A thin frame — just the message's new reactions. Applied wherever
          // that message is on screen; a no-op if it is not.
          useChatStore.getState().applyReactions(data.messageId, data.reactions || []);
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
