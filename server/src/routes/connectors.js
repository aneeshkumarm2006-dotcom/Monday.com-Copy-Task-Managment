const express = require('express');
const authMiddleware = require('../middleware/auth');
const rateLimit = require('../middleware/rateLimit');
const {
  getCatalog,
  listOrgConnectors,
  startAuthorization,
  saveCredentials,
  handleCallback,
  disconnectAccount,
  setConnectorAccountBudget,
  getBoardConnectors,
  setBoardConnector,
  getBoardConnectorProjects,
  refreshBoardConnectorProjects,
  setConnectorProjectGroup,
  createConnectorSite,
  updateConnectorSite,
} = require('../controllers/connectorController');
const {
  getConnectorData,
  getConnectorUsage,
  refreshConnectorData,
  runConnectorAction,
} = require('../controllers/connectorDataController');
const {
  getConnectorFields,
  setConnectorFieldMapping,
  deleteConnectorFieldMapping,
} = require('../controllers/connectorFieldController');
const {
  getGoalLinks,
  getGoalLinkMatches,
  setGoalLink,
  bulkSetGoalLinks,
  clearGoalLink,
  acceptGoalSuggestions,
  runBoardWriteback,
} = require('../controllers/connectorLinkController');
const { pingback } = require('../services/connectors/dataforseo/pingback');

/**
 * Mounted BARE at /api (see app.js), like routes/goals.js and routes/trackers.js,
 * because these paths live under three different prefixes: `/orgs/:orgId/...`
 * for the account pool, `/boards/:boardId/...` for per-board enablement, and
 * bare `/connectors/...` for the catalog and for a single account.
 *
 * MOUNT ORDER MATTERS. This router must come BEFORE the other bare `/api`
 * routers in app.js, because each of those applies its own
 * `router.use(authMiddleware)` to every `/api/*` path it sees. The OAuth
 * callback below is a browser redirect from a third party with no session and no
 * Authorization header — if routes/groups.js were reached first it would be
 * 401'd before it ever arrived here. Same reasoning as /api/portal and
 * /api/inbound.
 *
 * Capabilities, per handler:
 *   (none)                — the OAuth callback; authorised by a single-use,
 *                           server-minted `state`, not by a session
 *   org member            — listing the account pool (the board project picker
 *                           names these accounts, so hiding them breaks it)
 *   org.manage_settings   — connecting and disconnecting an ACCOUNT, because
 *                           that is workspace-wide credential handling
 *   connector.view        — reading what a board has switched on
 *   connector.manage      — switching it on, and (later) mapping and refreshing
 */
const router = express.Router();

/**
 * The OAuth callback. PUBLIC, and registered before the auth middleware for the
 * reason set out above.
 *
 * It is safe to leave unauthenticated because the `state` it requires was minted
 * by an org admin, stored server-side, and is deleted by the first request that
 * presents it — so it cannot be guessed, reused, or replayed.
 */
router.get('/connectors/callback', handleCallback);

/**
 * The DataForSEO pingback path. RESERVED, PUBLIC, AND INERT — it answers 501.
 *
 * "Webhooks: no" is a decision, and this is that decision shipped as code rather
 * than left in a plan where the next person has to re-derive it. `task_get` is
 * free, so a webhook saves nothing; DataForSEO neither signs nor retries its
 * callbacks, so a trustworthy receiver would have to call `task_get` anyway and
 * the poller stays load-bearing regardless. See
 * `services/connectors/dataforseo/pingback.js` for the full argument.
 *
 * Two things are being reserved, and both are expensive to change later:
 *
 *   THE MOUNT POSITION — above `router.use(authMiddleware)`, beside the OAuth
 *     callback, because a third party has no session and no Authorization
 *     header. Any of the bare `/api` routers would 401 it first.
 *   THE PATH SHAPE — a token in the PATH, never an HMAC over the BODY. That is
 *     what keeps `app.js`'s body parsing untouched: a signature scheme needs the
 *     raw bytes and `stashRawBody` would have to grow a third special case. It
 *     is also the honest scheme, since the provider offers no signature to
 *     verify.
 *
 * Adding a real receiver later is therefore additive — this line stays where it
 * is and the handler changes.
 */
router.post('/connectors/dataforseo/pingback/:token', pingback);

// Everything below needs a Bearer token.
router.use(authMiddleware);

// --- The catalog ------------------------------------------------------------
// Static, and must precede `/connectors/:accountId` so "callback" and the
// catalog root are never parsed as an account id.
router.get('/connectors', getCatalog);

// --- The org account pool ---------------------------------------------------
//
// TWO ways to connect an account, one per authentication mode, and both on
// `org.manage_settings` because both are workspace-wide credential handling.
//
// `/authorize` begins a browser consent and answers with a URL. `/credentials`
// takes a key and a password in the request itself and answers with the account
// it created. They are separate paths rather than one polymorphic handler
// because they have genuinely different security stories: the consent flow needs
// a server-minted single-use `state` precisely because it comes back through a
// public, unauthenticated callback, and this one has no round trip to protect —
// it arrives once, from a session already authenticated as an admin.
//
// Neither has a GET. A credential goes in and never comes back out.
router.get('/orgs/:orgId/connectors', listOrgConnectors);
router.post('/orgs/:orgId/connectors/:provider/authorize', startAuthorization);
router.post('/orgs/:orgId/connectors/:provider/credentials', saveCredentials);

// --- A single account -------------------------------------------------------
//
// The budget PATCH is `org.manage_settings`, the same rung as connecting the
// account, because a workspace-wide spending ceiling is credential-adjacent
// policy rather than a board preference. It is SEPARATE from the credentials
// POST above on purpose: a credential goes in and never comes back out, so
// folding the cap into that form would make "raise my monthly cap" require
// finding the API password again.
router.patch('/connectors/:accountId/budget', setConnectorAccountBudget);
router.delete('/connectors/:accountId', disconnectAccount);

// --- Per-board enablement ---------------------------------------------------
router.get('/boards/:boardId/connectors', getBoardConnectors);
router.put('/boards/:boardId/connectors/:provider', setBoardConnector);

// --- The project mirror -----------------------------------------------------
// `/projects/refresh` is declared BEFORE `/projects/:projectId` so "refresh" is
// never parsed as a project id. Same reasoning as `/connectors` above the
// `:accountId` route.
//
// Only the refresh reaches the provider; the other two read our own rows, which
// is why the read sits on `connector.view` and the other two on
// `connector.manage`. Spending a quota shared by the whole workspace, and
// deciding which client's numbers land on which group, are both board-shaping
// acts rather than personal ones.
router.get('/boards/:boardId/connectors/:provider/projects', getBoardConnectorProjects);
router.post(
  '/boards/:boardId/connectors/:provider/projects/refresh',
  refreshBoardConnectorProjects
);
router.put(
  '/boards/:boardId/connectors/:provider/projects/:projectId',
  setConnectorProjectGroup
);

// --- Locally-authored projects ("sites") ------------------------------------
//
// A SEPARATE path from `/projects` above, and the split is the safety property
// rather than a naming preference. Everything under `/projects` is about rows a
// PROVIDER owns: list them, re-read them, decide which group they feed. These
// two CREATE the row, for a provider that has nothing to mirror — DataForSEO is
// a stateless billing API with no concept of a project, so the domain, the
// markets and the keyword list are ours and `externalId` is our own id.
//
// Sharing one path would mean one handler that either edits a mirror or invents
// a project depending on a descriptor flag, which is exactly the kind of
// polymorphism that ends with somebody creating an Ubersuggest project
// Ubersuggest has never heard of. A descriptor with no `projectAuthoring` gets a
// 400 here and keeps its projects mirror-only.
//
// `connector.manage`, the same rung as mapping a project to a group and for a
// stronger version of the same reason: this document is what a collection is
// bought from, and its keyword list times its target list is the size of the
// bill. Search operators are refused server-side in the same read, because a
// cost multiplier only a browser checks is a cost multiplier.
router.post('/boards/:boardId/connectors/:provider/sites', createConnectorSite);
router.put(
  '/boards/:boardId/connectors/:provider/sites/:projectId',
  updateConnectorSite
);

// --- The data plane ---------------------------------------------------------
//
// `/data` READS OUR OWN DATABASE and never contacts the provider, which is what
// lets it sit on `connector.view` and be safe to call on every render. Quota is
// finite and shared across the whole workspace: a tab that fetched on mount
// would let ten people with a browser open spend the week on page loads.
//
// The other two spend quota and are therefore `connector.manage` — one is a
// person pressing Refresh, the other is a person starting a site-audit crawl,
// which is minutes of somebody else's compute and is deliberately something the
// weekly runner never does on its own.
//
// `/refresh` here is the DATA refresh and is a different thing from
// `/projects/refresh` above, which re-reads the project LIST. Two verbs, two
// costs, two paths.
router.get('/boards/:boardId/connectors/:provider/data', getConnectorData);

// The money screen. READS TWO OF OUR OWN COLLECTIONS — `ConnectorBudget` and,
// through the descriptor's `describeUsage` hook, whatever ledger the provider
// keeps — and contacts nobody. The obvious source for "what have we spent" is
// the provider's own free balance endpoint, and it is the wrong number twice
// over: it is one shared account's balance across every organisation on it, and
// a read endpoint that reaches a third party is one open tab away from being
// rate-limited. `connector.view`, with the ORG cap withheld from anyone without
// `connector.manage` — see the handler.
router.get('/boards/:boardId/connectors/:provider/usage', getConnectorUsage);

/**
 * Collect now. THE ONE ROUTE ON THIS ROUTER THAT CAN SPEND REAL MONEY.
 *
 * Five an hour per person, and the limit is deliberately advisory rather than
 * load-bearing. It is in-memory and per-process, so on a multi-instance deploy
 * two instances each allow five — which is exactly why it is not the thing that
 * bounds the spend. The things that bound the spend are the org's
 * `ConnectorBudget` cap (atomic, one document, survives any number of
 * instances), the provider's `minRebuyHours` floor, and `forceRefetchIsFree:
 * false`, which stops a plain Refresh buying anything at all.
 *
 * What it is genuinely good for is the accident this button invites: somebody
 * leaning on it, or a component re-rendering into a loop. Free, one line, and it
 * turns a hundred clicks into five.
 */
router.post(
  '/boards/:boardId/connectors/:provider/refresh',
  rateLimit({ bucket: 'connector:refresh', windowMs: 3_600_000, max: 5 }),
  refreshConnectorData
);
// Declared AFTER `/projects/:projectId` above so the literal `refresh` segment
// there is never shadowed, and specific enough that `actions` cannot be read as
// a project id.
router.post(
  '/boards/:boardId/connectors/:provider/projects/:projectId/actions/:action',
  runConnectorAction
);

// --- Field mapping ----------------------------------------------------------
//
// Which provider value fills which goal cell. NONE of these contacts the
// provider — the catalog is static on the descriptor and the mappings are our
// own rows — which is why the read sits on `connector.view` alongside the data
// read, and is safe on every render.
//
// The two writes are `connector.manage` for the same reason mapping a project to
// a group is: this is board-shaping wiring, and from phase 5 it decides whose
// numbers land in whose cell. It is deliberately NOT `goal.manage` — nothing
// here writes to a goal. The capability a given target IMPLIES for the eventual
// sync travels on the target itself and is enforced when a value is written.
//
// `:field` is a key from the provider's own catalog, validated against the
// descriptor in the handler. A literal segment (`fields`) sits in front of it,
// so nothing here can be confused with the project routes above.
router.get('/boards/:boardId/connectors/:provider/fields', getConnectorFields);
router.put(
  '/boards/:boardId/connectors/:provider/fields/:field',
  setConnectorFieldMapping
);
router.delete(
  '/boards/:boardId/connectors/:provider/fields/:field',
  deleteConnectorFieldMapping
);

// --- Goal links and writeback -----------------------------------------------
//
// Which tracked keyword each goal is about, and the two human gestures the
// writeback needs. NONE of these contacts the provider either — including the
// writeback, which reads snapshots we already hold and is therefore a much
// cheaper button than the `/refresh` above it. Collecting spends quota;
// deciding where what was collected goes does not.
//
// The capability ladder is the one thing here that is not uniform, and it is
// deliberate:
//
//   connector.view    — reading the links and the keyword lists. The Goals tab
//                       asks on every render, so it sits on the bottom rung
//                       alongside the other two reads.
//   connector.manage  — linking, unlinking, and asking the writeback to run.
//                       Same rung as mapping a project to a group: board-shaping
//                       wiring, and none of it writes to a goal by itself.
//   goal.track        — the base gate on ACCEPT, which does write. Each field is
//                       then checked again against what ITS target implies, so
//                       `config.baseline` needs `goal.manage` and a result does
//                       not. That is the promise/result split
//                       `goalController.RESULT_ONLY_FIELDS` makes, enforced at
//                       the moment a value actually lands — which is exactly
//                       where the phase-4 mapping panel said it would be.
//
// The board-scoped read lives at `/boards/:boardId/goal-links` rather than under
// `/connectors/:provider/…` because the Goals tab is not looking at one
// connector: a board could have two, and the row needs to say which one filled
// it. `?provider=` narrows it.
router.get('/boards/:boardId/goal-links', getGoalLinks);
router.post('/boards/:boardId/connectors/:provider/writeback', runBoardWriteback);

// Linking a whole month in one act. TWO routes, deliberately, and the split is
// the safety property: `/matches` proposes a keyword per goal by exact name and
// can write nothing, and `/bulk` writes an explicit list of pairs and does no
// matching of its own. Neither can become the fuzzy match `GoalLinkModal`
// refuses to make on its own, because the person in between is not optional.
//
// `/goal-links/matches` sits under the board rather than under a provider for
// the same reason the read above it does: a board can have two connectors and
// the screen shows both. `?provider=` narrows it. The WRITE is provider-scoped
// because a link names one.
router.get('/boards/:boardId/goal-links/matches', getGoalLinkMatches);
router.post(
  '/boards/:boardId/connectors/:provider/goal-links/bulk',
  bulkSetGoalLinks
);

// A single goal's link. Declared with the literal `connector-link` segment in
// front, so nothing here can be confused with `PUT /goals/:id` on routes/goals.js
// — which this router does not define and must not shadow.
router.put('/goals/:id/connector-link', setGoalLink);
router.delete('/goals/:id/connector-link', clearGoalLink);
router.post('/goals/:id/connector-link/accept', acceptGoalSuggestions);

module.exports = router;
