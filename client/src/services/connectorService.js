import api from './api';

/**
 * Connector API client.
 *
 * Two planes, matching the server (see controllers/connectorController.js):
 * accounts live on the ORG and are managed by an admin in Settings; enabling a
 * connector and mapping its projects lives on the BOARD.
 *
 * Every call passes `suppressErrorToast: true` and lets the caller render the
 * server's own sentence in place. A 403 here is usually information — "only an
 * organisation admin can connect an account" — not an error to bark about.
 *
 * Note what this file cannot do: there is no "read the token" call, because no
 * endpoint returns one. Credentials go in through the OAuth redirect and never
 * come back out.
 */

// ---- Catalog ---------------------------------------------------------------

/** Every connector the server knows about. @returns {Promise<Array>} */
export const getConnectorCatalog = async () => {
  const { data } = await api.get('/api/connectors', { suppressErrorToast: true });
  return data.connectors;
};

// ---- Org plane — the account pool ------------------------------------------

/**
 * The org's connected accounts, plus whether the caller may change them.
 * @param {string} orgId
 * @returns {Promise<{accounts: Array, catalog: Array, canManage: boolean}>}
 */
export const getOrgConnectors = async (orgId) => {
  const { data } = await api.get(`/api/orgs/${orgId}/connectors`, {
    suppressErrorToast: true,
  });
  return data;
};

/**
 * Begin a consent. Returns a URL for the browser to navigate to — the server
 * deliberately does not redirect, because a 302 to a third party issued in
 * response to a fetch would be swallowed by CORS.
 *
 * @param {string} orgId
 * @param {string} provider
 * @param {{label: string, returnTo?: string, reconnectAccount?: string}} payload
 * @returns {Promise<string>} the authorize URL
 */
export const startConnectorAuthorization = async (orgId, provider, payload) => {
  const { data } = await api.post(
    `/api/orgs/${orgId}/connectors/${provider}/authorize`,
    payload,
    { suppressErrorToast: true }
  );
  return data.authorizeUrl;
};

/**
 * Disconnect an account. The server revokes and drops the tokens rather than
 * deleting the row, so mappings and stored history survive.
 * @param {string} accountId
 */
export const disconnectConnectorAccount = async (accountId) => {
  const { data } = await api.delete(`/api/connectors/${accountId}`, {
    suppressErrorToast: true,
  });
  return data;
};

// ---- Board plane — enablement ----------------------------------------------

/**
 * What this board has switched on, and which accounts it can draw from.
 * Reads our own database only; nothing here contacts a provider.
 * @param {string} boardId
 */
export const getBoardConnectors = async (boardId) => {
  const { data } = await api.get(`/api/boards/${boardId}/connectors`, {
    suppressErrorToast: true,
  });
  return data;
};

/**
 * Turn a connector on or off for a board.
 * @param {string} boardId
 * @param {string} provider
 * @param {{enabled: boolean, kinds?: string[]}} payload
 */
export const setBoardConnector = async (boardId, provider, payload) => {
  const { data } = await api.put(
    `/api/boards/${boardId}/connectors/${provider}`,
    payload,
    { suppressErrorToast: true }
  );
  return data.connector;
};
