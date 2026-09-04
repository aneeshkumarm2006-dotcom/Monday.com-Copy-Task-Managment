import { useEffect, useRef } from 'react';
import { getPortalToken, portalStreamUrl } from '../services/portalService';

/**
 * Live chat delivery for the EXTERNAL client portal, mirroring
 * `useNotificationStream` in shape but on the portal's own auth plane: it
 * carries the portal JWT in a `?token=` query param (EventSource cannot set
 * headers) and touches none of the app stores, so nothing here can disturb a
 * team member's session in another tab.
 *
 * IT IS NOT THE ONLY DELIVERY PATH, AND MUST NOT BECOME ONE. The server's
 * subscriber registry is in-memory and single-process: behind more than one
 * node — or across a restart, a proxy that buffers, a phone that suspended the
 * tab — frames are simply lost, with no replay. The portal's existing polling
 * (LIST_POLL / THREAD_POLL and the per-surface polls in PortalChat/PortalMail)
 * therefore stays exactly as it is. This hook only makes the common case feel
 * instant; correctness still comes from the poll.
 *
 * @param {boolean}  enabled       connect only when the portal actually has chat
 * @param {Function} onChatMessage ({ channelId, message }) for every chat frame
 */
export default function usePortalStream(enabled, onChatMessage) {
  // Held in a ref so a caller passing an inline arrow doesn't tear down and
  // rebuild the connection on every render.
  const handlerRef = useRef(onChatMessage);
  useEffect(() => {
    handlerRef.current = onChatMessage;
  }, [onChatMessage]);

  // Read during render (a synchronous localStorage read) so that a sign-in or
  // an expiry in this tab re-runs the effect below and re-keys the connection.
  const token = getPortalToken();

  useEffect(() => {
    if (!enabled || !token) return undefined;
    const url = portalStreamUrl();
    if (!url) return undefined;

    let es;
    try {
      es = new EventSource(url);
    } catch {
      // No EventSource (or a blocked URL) — polling already covers us.
      return undefined;
    }

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data?.type === 'chat.message' && data.channelId && data.message) {
          handlerRef.current?.({ channelId: data.channelId, message: data.message });
        }
      } catch {
        // Heartbeats (`: ping`) never reach onmessage, but malformed frames
        // must not take the connection down with them.
      }
    };

    es.onerror = () => {
      // EventSource reconnects by itself; the polling backstop covers the gap.
      // Deliberately no error surface — a client should never see a red banner
      // because a background socket blipped.
    };

    return () => {
      es.close();
    };
  }, [enabled, token]);
}
