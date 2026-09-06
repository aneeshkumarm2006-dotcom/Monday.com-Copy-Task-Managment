import { useEffect, useRef, useState } from 'react';
import {
  getPortalToken,
  portalStreamUrl,
  PORTAL_TOKEN_EVENT,
} from '../services/portalService';

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

// Reconnect backoff after a connection the browser has abandoned for good.
const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 60000;

export default function usePortalStream(enabled, onChatMessage) {
  // Held in a ref so a caller passing an inline arrow doesn't tear down and
  // rebuild the connection on every render.
  const handlerRef = useRef(onChatMessage);
  useEffect(() => {
    handlerRef.current = onChatMessage;
  }, [onChatMessage]);

  // The token is kept in STATE, not read during render: a localStorage read is
  // not reactive, so the old version only ever re-keyed the connection when the
  // caller happened to re-render for some other reason. A sign-in or an expiry
  // in this tab now announces itself (PORTAL_TOKEN_EVENT, dispatched by
  // set/clearPortalToken), and another tab's change arrives as `storage`.
  const [token, setToken] = useState(getPortalToken);
  useEffect(() => {
    const sync = () => setToken(getPortalToken());
    window.addEventListener('storage', sync);
    window.addEventListener(PORTAL_TOKEN_EVENT, sync);
    // Cover a token that changed between first render and this subscription.
    sync();
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener(PORTAL_TOKEN_EVENT, sync);
    };
  }, []);

  // Bumped to force a fresh EventSource after the browser has closed one for
  // good. Separate from `token` so a reconnect doesn't need the token to change.
  const [generation, setGeneration] = useState(0);
  const failuresRef = useRef(0);

  useEffect(() => {
    if (!enabled || !token) return undefined;
    const url = portalStreamUrl();
    if (!url) return undefined;

    let es;
    let retry;
    try {
      es = new EventSource(url);
    } catch {
      // No EventSource (or a blocked URL) — polling already covers us.
      return undefined;
    }

    es.onopen = () => {
      failuresRef.current = 0;
    };

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
      // A dropped socket is EventSource's own problem — it retries, and the
      // polling backstop covers the gap. CLOSED is the case it will NEVER
      // retry: the spec fails the connection permanently on any non-200, which
      // is exactly what the stream endpoint answers with once the portal JWT
      // has expired or its `ptk` was rotated. Left alone, live delivery would
      // die silently for the rest of the session. So reconnect ourselves, on a
      // capped backoff — if the token really is dead every attempt costs one
      // failed request, no more often than the polls already running.
      if (es.readyState !== EventSource.CLOSED) return;
      es.close();
      const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** failuresRef.current);
      failuresRef.current += 1;
      clearTimeout(retry);
      retry = setTimeout(() => setGeneration((g) => g + 1), delay);
    };

    return () => {
      clearTimeout(retry);
      es.close();
    };
  }, [enabled, token, generation]);
}
