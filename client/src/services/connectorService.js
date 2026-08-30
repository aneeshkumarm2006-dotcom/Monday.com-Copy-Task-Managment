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
 * endpoint returns one. Credentials go in — through the OAuth redirect for a
 * provider with a consent screen, or through `saveConnectorCredentials` for one
 * that issues a key — and never come back out.
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
 * Store a key-and-password credential for a provider that has no consent screen.
 *
 * The other half of `startConnectorAuthorization`, and which one applies is the
 * server's answer, not this file's: a catalog entry carries `credentialForm`
 * (and `requiresBrowserConsent: false`) when this is the path. The values are
 * sealed server-side on arrival and there is no endpoint that reads them back.
 *
 * @param {string} orgId
 * @param {string} provider
 * @param {{label: string, credentials: Object, reconnectAccount?: string}} payload
 * @returns {Promise<Object>} the created or updated account, with no secret on it
 */
export const saveConnectorCredentials = async (orgId, provider, payload) => {
  const { data } = await api.post(
    `/api/orgs/${orgId}/connectors/${provider}/credentials`,
    payload,
    { suppressErrorToast: true }
  );
  return data.account;
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
 * Turn a connector on or off for a board, and set how it behaves there.
 *
 * `kinds` and `enabledScreens` are NOT the same switch and the caller must not
 * treat them as one. `kinds` decides what is PAID TO COLLECT and is unioned
 * across every board mapping the same project, so narrowing it can take a
 * section away from a co-tenant board; `enabledScreens` decides what THIS board
 * RENDERS out of data already collected, is free, and cannot reach anywhere
 * else. See the `BoardConnector` model header for the whole argument.
 *
 * `intervalHours` is a cadence override, null for the provider's default, and it
 * is resolved as a MIN across boards — so it is the one field here that makes a
 * frugal board pay for an eager one's choice.
 *
 * @param {string} boardId
 * @param {string} provider
 * @param {{enabled: boolean, kinds?: string[], enabledScreens?: string[],
 *   intervalHours?: number|null,
 *   budget?: {monthlyUsd?: number|null, alertAtPct?: number}}} payload
 */
export const setBoardConnector = async (boardId, provider, payload) => {
  const { data } = await api.put(
    `/api/boards/${boardId}/connectors/${provider}`,
    payload,
    { suppressErrorToast: true }
  );
  return data.connector;
};

// ---- Board plane — the project mirror --------------------------------------

/**
 * The provider's projects as we last mirrored them, plus their group bindings.
 *
 * Reads OUR database, never the provider: rendering the Add-ons tab must not
 * spend a quota that is shared by the whole workspace, or one person with the
 * tab open would exhaust the week for everybody. Only `refreshConnectorProjects`
 * below reaches out.
 *
 * @param {string} boardId
 * @param {string} provider
 * @returns {Promise<{projects: Array, accounts: Array, canManage: boolean}>}
 */
export const getConnectorProjects = async (boardId, provider) => {
  const { data } = await api.get(
    `/api/boards/${boardId}/connectors/${provider}/projects`,
    { suppressErrorToast: true }
  );
  return data;
};

/**
 * Re-read the project list from the provider. Spends quota, so it is a button
 * and never an effect.
 *
 * Resolves even when some accounts failed — the pool is plural and each account
 * has its own quota and its own grant, so `report.accounts` carries a row per
 * account and the caller decides what to say about it.
 *
 * @param {string} boardId
 * @param {string} provider
 * @returns {Promise<{projects: Array, report: Object}>}
 */
export const refreshConnectorProjects = async (boardId, provider) => {
  const { data } = await api.post(
    `/api/boards/${boardId}/connectors/${provider}/projects/refresh`,
    {},
    { suppressErrorToast: true }
  );
  return data;
};

/**
 * Bind a project to one of this board's groups, or pass null to unbind it.
 *
 * @param {string} boardId
 * @param {string} provider
 * @param {string} projectId
 * @param {string|null} groupId
 * @returns {Promise<Object>} the updated project
 */
export const setConnectorProjectGroup = async (
  boardId,
  provider,
  projectId,
  groupId
) => {
  const { data } = await api.put(
    `/api/boards/${boardId}/connectors/${provider}/projects/${projectId}`,
    { group: groupId },
    { suppressErrorToast: true }
  );
  return data.project;
};

// ---- Board plane — the data ------------------------------------------------

/**
 * Everything the connector data tab renders, out of OUR database.
 *
 * Nothing here contacts the provider. That is the load-bearing property of this
 * whole feature: quota is finite and shared across the entire workspace, so a
 * tab that fetched on mount would let ten people with a browser open spend the
 * week on page loads — and would put a third-party outage between somebody and
 * data we already hold. Only `refreshConnectorData` and `runConnectorAction`
 * below reach out, and both are buttons.
 *
 * @param {string} boardId
 * @param {string} provider
 * @param {Object} [params]
 * @param {string} [params.project] - a ConnectorProject id; defaults server-side
 *   to the first project mapped on this board
 * @param {string} [params.variant] - a rank-tracking variant, `desktop|en|2840`
 * @param {string} [params.from] - `YYYY-MM-DD`
 * @param {string} [params.to] - `YYYY-MM-DD`
 * @param {string} [params.keyword] - adds that one keyword's stored history,
 *   which is the series the provider's own API cannot produce at all
 * @returns {Promise<Object>}
 */
export const getConnectorData = async (boardId, provider, params = {}) => {
  const query = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
  ).toString();
  const { data } = await api.get(
    `/api/boards/${boardId}/connectors/${provider}/data${query ? `?${query}` : ''}`,
    { suppressErrorToast: true }
  );
  return data;
};

/**
 * What this board has spent at the provider this month, and what is in flight.
 *
 * READS OUR OWN DATABASE, exactly like `getConnectorData`. On a provider that
 * bills per call the obvious source is its own free balance endpoint, and it is
 * the wrong number twice over: it is one shared account's balance across every
 * organisation on it, and a read that reaches a third party is one open browser
 * tab away from being rate-limited. Everything here comes from `ConnectorBudget`
 * and the provider's own task ledger.
 *
 * `orgBudget` is null for anyone without `connector.manage` — the workspace's
 * ceiling is not a fact about one board. `boardBudget` is null when this board
 * has no allocation, which is the normal state.
 *
 * @param {string} boardId
 * @param {string} provider
 * @param {{months?: number}} [params]
 * @returns {Promise<Object>}
 */
export const getConnectorUsage = async (boardId, provider, params = {}) => {
  const query = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
  ).toString();
  const { data } = await api.get(
    `/api/boards/${boardId}/connectors/${provider}/usage${query ? `?${query}` : ''}`,
    { suppressErrorToast: true }
  );
  return data;
};

/**
 * Create a locally-authored project — a "site" — for a provider that has nothing
 * to mirror.
 *
 * A SEPARATE call from the project mirror above, and the split is a safety
 * property rather than a naming preference. Everything under `/projects` is
 * about rows a PROVIDER owns; this one invents the row, for a stateless billing
 * API that has no concept of a project. A descriptor with no `projectAuthoring`
 * on its catalog entry gets a 400 here, which is what stops somebody creating an
 * Ubersuggest project Ubersuggest has never heard of.
 *
 * SPENDS NOTHING — but it is what a collection is later bought FROM, and its
 * keyword list times its target list is the size of the bill. The server
 * validates every cap and refuses search operators, because a cost multiplier
 * only a browser checks is a cost multiplier.
 *
 * @param {string} boardId
 * @param {string} provider
 * @param {{account?: string, name?: string, domain: string,
 *   trackedKeywords: string[], targets: Array<Object>, competitors?: string[]}} payload
 * @returns {Promise<Object>} the created project
 */
export const createConnectorSite = async (boardId, provider, payload) => {
  const { data } = await api.post(
    `/api/boards/${boardId}/connectors/${provider}/sites`,
    payload,
    { suppressErrorToast: true }
  );
  return data.project;
};

/**
 * Replace a site's authored fields.
 *
 * A FULL REPLACEMENT, not a patch: an edit that drops four keywords has to be
 * able to say so, and a partial update of a list is ambiguous in a way that
 * costs money in one direction and loses history in the other. The group
 * binding, the account and every snapshot already taken are untouched — changing
 * a keyword list is an ordinary thing to do to a live site and must not read as
 * a different site.
 *
 * @param {string} boardId
 * @param {string} provider
 * @param {string} projectId
 * @param {Object} payload - the same shape as the create
 * @returns {Promise<Object>} the updated project
 */
export const updateConnectorSite = async (boardId, provider, projectId, payload) => {
  const { data } = await api.put(
    `/api/boards/${boardId}/connectors/${provider}/sites/${projectId}`,
    payload,
    { suppressErrorToast: true }
  );
  return data.project;
};

/**
 * Collect now instead of waiting for the weekly pass. SPENDS QUOTA.
 *
 * Resolves even when some accounts failed — the pool is plural and each account
 * has its own quota and its own grant, so `report.accounts` carries a row per
 * account and the caller decides what to say about it.
 *
 * ---- `force` is now a separate, explicit act ------------------------------
 *
 * A plain Refresh no longer forces a re-fetch on every provider. One bills per
 * report subject per day, where a second pull costs nothing; the other bills AT
 * POST, where the same button press is a purchase — 200 keywords in two markets
 * is $0.24 every time somebody leans on it. The descriptor answers which is
 * which (`forceRefetchIsFree`), and the caller sends `{force: true}` only when a
 * person has confirmed they mean "buy it again".
 *
 * @param {string} boardId
 * @param {string} provider
 * @param {{project?: string, kinds?: string[], force?: boolean}} [payload] -
 *   omit `project` to refresh every project mapped on this board
 * @returns {Promise<{report: Object}>}
 */
export const refreshConnectorData = async (boardId, provider, payload = {}) => {
  const { data } = await api.post(
    `/api/boards/${boardId}/connectors/${provider}/refresh`,
    payload,
    { suppressErrorToast: true }
  );
  return data;
};

/**
 * Run one of the provider's user-triggered actions — today, starting a
 * site-audit crawl.
 *
 * Kept apart from the scheduled read because a crawl is minutes of somebody
 * else's compute and is capped by plan; it is deliberately something the weekly
 * runner never starts on its own. The result usually says "started" rather than
 * carrying a finished audit — a crawl takes a few minutes and lands on a later
 * refresh.
 *
 * @param {string} boardId
 * @param {string} provider
 * @param {string} projectId
 * @param {string} action - a key from the connector's `availableActions`
 * @returns {Promise<{action: string, status: string, note: string}>}
 */
export const runConnectorAction = async (boardId, provider, projectId, action) => {
  const { data } = await api.post(
    `/api/boards/${boardId}/connectors/${provider}/projects/${projectId}/actions/${action}`,
    {},
    { suppressErrorToast: true }
  );
  return data;
};

// ---- Board plane — field mapping -------------------------------------------

/**
 * The mapping panel's whole payload: the provider's field catalog, this board's
 * targets, the refusals, and the mappings that already exist.
 *
 * Reads our own database and the descriptor's static catalog — nothing here
 * contacts the provider, which is why it sits on `connector.view` alongside the
 * data read and is safe on every render.
 *
 * The REFUSALS are the part worth understanding. `fields[i].refusals` is keyed
 * by target id and carries the SENTENCE explaining why that field cannot go
 * there; a target with no entry is allowed. The client must never re-derive that
 * rule — it comes out of the same `checkCompatibility` the save path uses, so
 * the option the panel greys out and the save the server would reject are one
 * decision made once. Two implementations of a rule agree until they quietly do
 * not.
 *
 * @param {string} boardId
 * @param {string} provider
 * @returns {Promise<{fields: Array, targets: Array, builtins: Array, mappings: Array, canManage: boolean}>}
 */
export const getConnectorFields = async (boardId, provider) => {
  const { data } = await api.get(
    `/api/boards/${boardId}/connectors/${provider}/fields`,
    { suppressErrorToast: true }
  );
  return data;
};

/**
 * Bind one provider field to one place on the goal, replacing whatever it was
 * bound to before.
 *
 * `targetId` is the flattened wire form — `column:<goalColumnId>` or
 * `builtin:<key>` — which is why the panel can use it straight as a `Dropdown`
 * value. A column is always named by its `_id` and never by its key: the boards
 * in this workspace use disjoint column ids and disagree about the spelling of
 * the difficulty key, so a slug would bind on one board and silently miss on
 * the others.
 *
 * Rejects with a readable sentence when the types do not fit. That refusal is
 * the point of the endpoint: an incompatible mapping breaks nothing at save
 * time and everything at 3am, where the only symptom is a cell that never fills.
 *
 * @param {string} boardId
 * @param {string} provider
 * @param {string} field - a key from the catalog
 * @param {{targetId: string, autoFill?: boolean}} payload
 * @returns {Promise<Object>} the saved mapping
 */
export const setConnectorFieldMapping = async (boardId, provider, field, payload) => {
  const { data } = await api.put(
    `/api/boards/${boardId}/connectors/${provider}/fields/${field}`,
    payload,
    { suppressErrorToast: true }
  );
  return data.mapping;
};

/**
 * Unbind a field. Nothing already written is touched — a value the connector
 * put in a cell is a real reading somebody may have reported to a client, and
 * removing the wiring is not a statement about it. Only the future stops.
 *
 * @param {string} boardId
 * @param {string} provider
 * @param {string} field
 */
export const clearConnectorFieldMapping = async (boardId, provider, field) => {
  const { data } = await api.delete(
    `/api/boards/${boardId}/connectors/${provider}/fields/${field}`,
    { suppressErrorToast: true }
  );
  return data;
};

// ---- Board plane — goal links and writeback ---------------------------------

/**
 * Every goal link for one month, plus what a link can be made against.
 *
 * Reads our own database and the descriptor's static catalog — nothing here
 * contacts the provider, which is why the Goals tab can ask on every render.
 * The KEYWORD LISTS in particular come out of the newest stored rank snapshot
 * rather than from a live call, so the picker opens instantly, spends no quota,
 * and still works during a provider outage. The cost is that a keyword added at
 * the provider since the last collection is not in the list — which is why the
 * link accepts a free-typed phrase too.
 *
 * @param {string} boardId
 * @param {string} monthKey - 'YYYY-MM'
 * @param {{provider?: string}} [opts]
 * @returns {Promise<{links: Array, sources: Array, mappedFields: Array,
 *   canManage: boolean, canTrack: boolean, canManageGoals: boolean}>}
 */
export const getGoalLinks = async (boardId, monthKey, { provider } = {}) => {
  const { data } = await api.get(`/api/boards/${boardId}/goal-links`, {
    params: { month: monthKey, ...(provider ? { provider } : {}) },
    suppressErrorToast: true,
  });
  return data;
};

/**
 * What each goal in a month would be linked to, if it were matched by name.
 *
 * PROPOSES ONLY — this endpoint cannot write. The rule is exact
 * (case-insensitive, spaces collapsed), never fuzzy: a goal whose name matches
 * two tracked keywords comes back as `ambiguous` rather than resolved, and one
 * that matches none comes back under `unmatched`. Nothing is linked until the
 * list is confirmed and posted to `bulkSetGoalLinks` below.
 *
 * Reads stored snapshots, so it spends no quota and opens instantly.
 *
 * @param {string} boardId
 * @param {string} monthKey - 'YYYY-MM'
 * @param {{provider?: string}} [opts]
 * @returns {Promise<{monthKey: string, groups: Array, mappedFields: Array}>}
 */
export const getGoalLinkMatches = async (boardId, monthKey, { provider } = {}) => {
  const { data } = await api.get(`/api/boards/${boardId}/goal-links/matches`, {
    params: { month: monthKey, ...(provider ? { provider } : {}) },
    suppressErrorToast: true,
  });
  return data;
};

/**
 * Link many goals in one act, from an explicit list of pairs.
 *
 * The server does no matching here — it writes exactly the pairs it is handed,
 * which is what keeps "a name looked similar" and "a number appeared in a
 * client's report" separated by a person.
 *
 * Resolves with BOTH halves. One stale row never fails the batch: a goal that
 * has moved, or a group whose project was unmapped, comes back in `skipped`
 * with a sentence while the rest are linked.
 *
 * @param {string} boardId
 * @param {string} provider
 * @param {Array<{goal: string, keyword?: string|null, variant?: string|null,
 *   autoFill?: boolean}>} links
 * @returns {Promise<{linked: Array, skipped: Array}>}
 */
export const bulkSetGoalLinks = async (boardId, provider, links) => {
  const { data } = await api.post(
    `/api/boards/${boardId}/connectors/${provider}/goal-links/bulk`,
    { links },
    { suppressErrorToast: true }
  );
  return data;
};

/**
 * Point one goal at one tracked keyword, replacing whatever it was pointed at.
 *
 * The keyword is OPTIONAL and a link without one is a real link: it binds the
 * goal to its group's project and fills the PROJECT-scoped fields (organic
 * traffic, domain authority, health score) and nothing else. Keyword-scoped
 * fields — rank, volume, difficulty — need the phrase, because a rank is a fact
 * about one keyword and a project tracks hundreds.
 *
 * `connector.manage`, not `goal.manage`: this writes nothing to a goal. It is
 * the same act as saying which project feeds which group.
 *
 * @param {string} goalId
 * @param {{provider: string, keyword?: string|null, variant?: string|null,
 *   autoFill?: boolean}} payload
 * @returns {Promise<{link: Object, project: Object}>}
 */
export const setGoalLink = async (goalId, payload) => {
  const { data } = await api.put(
    `/api/goals/${goalId}/connector-link`,
    payload,
    { suppressErrorToast: true }
  );
  return data;
};

/**
 * Unlink. Nothing already written is touched — a value the connector put in a
 * cell is a real reading somebody may have reported to a client, and removing
 * the wiring is not a statement about it.
 *
 * The PROVENANCE goes with it, which is the one consequence worth knowing:
 * re-linking the same goal later starts a fresh link, whose first run claims the
 * cells again.
 *
 * @param {string} goalId
 */
export const clearGoalLink = async (goalId) => {
  const { data } = await api.delete(`/api/goals/${goalId}/connector-link`, {
    suppressErrorToast: true,
  });
  return data;
};

/**
 * "Ubersuggest says 1,400 — accept?" Says yes.
 *
 * Resolves with BOTH halves: `accepted` and `refused`. Each field is gated on
 * what its target implies — `goal.track` for a result, `goal.manage` for
 * anything that changes what was promised — so somebody who can report the month
 * but not redefine it gets the rank and not the starting point, in one call.
 * Refusing five acceptable values because a sixth needed a higher rung would be
 * a worse answer than doing the five.
 *
 * @param {string} goalId
 * @param {string[]} [fields] - omit for every outstanding suggestion
 * @returns {Promise<{accepted: Array, refused: Array, link: Object, goal: Object}>}
 */
export const acceptGoalSuggestions = async (goalId, fields) => {
  const { data } = await api.post(
    `/api/goals/${goalId}/connector-link/accept`,
    fields?.length ? { fields } : {},
    { suppressErrorToast: true }
  );
  return data;
};

/**
 * Fill the linked goals now, from data we already hold. SPENDS NO QUOTA.
 *
 * A different and much cheaper button from `refreshConnectorData` above it: that
 * one calls the provider, this one only decides where what was already collected
 * goes. It runs with the CALLER as the principal, which is why a person holding
 * `goal.manage` gets their starting points filled where the weekly pass — which
 * has nobody behind it — would only have offered them.
 *
 * @param {string} boardId
 * @param {string} provider
 * @param {{month?: string}} [payload]
 * @returns {Promise<{report: Object}>}
 */
export const runConnectorWriteback = async (boardId, provider, payload = {}) => {
  const { data } = await api.post(
    `/api/boards/${boardId}/connectors/${provider}/writeback`,
    payload,
    { suppressErrorToast: true }
  );
  return data.report;
};
