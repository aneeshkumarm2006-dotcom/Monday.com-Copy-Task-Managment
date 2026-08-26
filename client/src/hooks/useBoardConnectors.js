import { useCallback, useEffect, useState } from 'react';
import { getBoardConnectors } from '../services/connectorService';

/**
 * Which connectors a board has switched on.
 *
 * ---- Why the board page needs this, and why it is a hook -------------------
 *
 * The connector data tab only exists on a board where a connector is enabled,
 * so the tab bar has to know before it can render. That answer lives on
 * `BoardConnector` rather than on `Board` — deliberately, so a feature most
 * boards never turn on does not add a seventh embedded array to an already
 * 400-line schema — which means one small request rather than a field that was
 * already loaded.
 *
 * It is cheap by construction. `GET /api/boards/:id/connectors` READS OUR OWN
 * DATABASE and never contacts a provider, which is exactly why `connector.view`
 * sits on the bottom rung of the board ladder and why this is safe to call on
 * every board load. If you are ever tempted to make it fetch the provider's
 * state instead: quota is shared by the whole workspace, and this runs on every
 * navigation.
 *
 * A failure is silent and resolves to "no connectors". The tab simply does not
 * appear, which is the same thing the user sees on a board that has none — and
 * it is a great deal better than a board page that will not open because an
 * optional feature's endpoint was unhappy.
 *
 * @param {string} boardId
 * @param {{enabled?: boolean}} [opts] - pass false on a board where connectors
 *   cannot exist (a standard board, or a reader without `connector.view`) so no
 *   request is made at all
 */
const useBoardConnectors = (boardId, { enabled = true } = {}) => {
  const [connectors, setConnectors] = useState([]);
  const [loading, setLoading] = useState(!!enabled);

  const load = useCallback(async () => {
    if (!boardId || !enabled) {
      setConnectors([]);
      setLoading(false);
      return;
    }
    try {
      const data = await getBoardConnectors(boardId);
      setConnectors(data.connectors || []);
    } catch {
      // See the header: an optional feature must not be able to break a board.
      setConnectors([]);
    } finally {
      setLoading(false);
    }
  }, [boardId, enabled]);

  useEffect(() => {
    load();
  }, [load]);

  return {
    connectors,
    /** Only the ones actually switched on — what the tab bar keys off. */
    enabledConnectors: connectors.filter((c) => c.enabled),
    loading,
    refresh: load,
  };
};

export default useBoardConnectors;
