const mongoose = require('mongoose');

const ConnectorAccount = require('../models/ConnectorAccount');
const ConnectorAuthAttempt = require('../models/ConnectorAuthAttempt');
const BoardConnector = require('../models/BoardConnector');
const ConnectorProject = require('../models/ConnectorProject');
const TaskGroup = require('../models/TaskGroup');

const {
  loadBoardContext,
  requireCapability,
  loadOrgContext,
} = require('../utils/boardContext');
const { getConnector, listConnectors } = require('../services/connectors');
const { refreshOrgProjects } = require('../services/connectors/projectMirror');
const { isConnectorProvider, connectorProviderLabel } = require('../utils/connectorProviders');
const connectorCrypto = require('../utils/connectorCrypto');

/**
 * Connector accounts and per-board enablement.
 *
 * Two planes, two different authorities, and the split is the point:
 *
 *   ORG plane   — connecting and disconnecting an external ACCOUNT. This is
 *                 credential handling for the whole workspace, so it answers to
 *                 `org.manage_settings`. A board editor must not be able to
 *                 attach a new external identity to the organisation.
 *
 *   BOARD plane — turning a connector on for one board and, later, mapping its
 *                 projects. `connector.view` to see, `connector.manage` to
 *                 change. Gated exactly like Goals: board context, then
 *                 capability, then board type, with a 404 (not a 403) on a
 *                 non-tracker board, because on a standard board connectors do
 *                 not exist and there is nothing to be refused access to.
 *
 * NOTHING in this file may return `sealedTokens`, or anything derived from it,
 * to a client. The field is `select: false` on the model, and every read here
 * that does not need it leaves it that way.
 */

const NOT_TRACKER =
  'Connectors are only available on tracker boards.';

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

/**
 * The board-plane gate. Board context, then capability, then board type — the
 * same order and the same reasoning as `goalController.gate`: someone who cannot
 * reach the board never learns what is on it.
 *
 * @returns {Promise<Object|null>} the context, or null having already answered
 */
const gateBoard = async (req, res, capability) => {
  const boardId = req.params.boardId || req.params.id;
  if (!isValidId(boardId)) {
    res.status(400).json({ error: 'Invalid board id' });
    return null;
  }

  const ctx = await loadBoardContext(boardId, req.user.userId);
  if (ctx.error) {
    res.status(ctx.status).json({ error: ctx.error });
    return null;
  }

  const denied = requireCapability(ctx, capability);
  if (denied) {
    res.status(denied.status).json({ error: denied.error });
    return null;
  }

  if (ctx.board?.boardType !== 'tracker') {
    res.status(404).json({ error: NOT_TRACKER, code: 'NOT_TRACKER_BOARD' });
    return null;
  }

  return ctx;
};

/**
 * The org-plane gate for anything that touches credentials.
 * @returns {Promise<Object|null>}
 */
const gateOrgAdmin = async (req, res, orgId) => {
  if (!isValidId(orgId)) {
    res.status(400).json({ error: 'Invalid organisation id' });
    return null;
  }

  const ctx = await loadOrgContext(orgId, req.user.userId);
  if (ctx.error) {
    res.status(ctx.status).json({ error: ctx.error });
    return null;
  }

  if (!ctx.can('org.manage_settings')) {
    res.status(403).json({
      error: 'Only an organisation admin can connect or remove a connector account.',
    });
    return null;
  }

  return ctx;
};

/**
 * The public shape of an account. Deliberately hand-built rather than a spread,
 * so a field added to the model later cannot leak by default — `sealedTokens`
 * being the one that must never appear.
 */
const publicAccount = (account) => ({
  _id: account._id,
  provider: account.provider,
  label: account.label,
  externalEmail: account.externalEmail || null,
  tier: account.tier || null,
  scopes: account.scopes || [],
  status: account.status,
  lastSyncAt: account.lastSyncAt || null,
  lastSyncReport: account.lastSyncReport || null,
  lastSeenQuota: account.lastSeenQuota || {},
  createdAt: account.createdAt,
  updatedAt: account.updatedAt,
});

/**
 * Where the provider sends the browser back to.
 *
 * Prefers an explicit `SERVER_PUBLIC_URL` because the token endpoint requires
 * the redirect_uri to match the authorize request byte for byte, and deriving it
 * from the request means trusting a `Host` header an attacker controls. The
 * derivation is a development fallback, not the intended path.
 */
const callbackUrlFor = (req) => {
  const base =
    process.env.SERVER_PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  return `${base.replace(/\/$/, '')}/api/connectors/callback`;
};

/**
 * Send the browser home after a consent, successful or not.
 *
 * `returnTo` is restricted to a site-relative path. An unchecked value here
 * would be an open redirect, and this endpoint is deliberately unauthenticated —
 * it is the one place in the app a stranger can hand us a URL.
 */
const finishRedirect = (res, returnTo, params) => {
  const clientUrl = (process.env.CLIENT_URL || '').replace(/\/$/, '');
  const safePath =
    typeof returnTo === 'string' && /^\/[^/\\]/.test(returnTo) ? returnTo : '/settings';
  const qs = new URLSearchParams(params).toString();
  return res.redirect(`${clientUrl}${safePath}${safePath.includes('?') ? '&' : '?'}${qs}`);
};

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/** GET /api/connectors — what providers exist at all. Auth only; no secrets. */
const getCatalog = async (req, res) => {
  try {
    return res.json({ connectors: listConnectors() });
  } catch (err) {
    console.error('getCatalog error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

// ---------------------------------------------------------------------------
// Org plane — accounts
// ---------------------------------------------------------------------------

/** GET /api/orgs/:orgId/connectors — the account pool. */
const listOrgConnectors = async (req, res) => {
  try {
    const { orgId } = req.params;
    if (!isValidId(orgId)) {
      return res.status(400).json({ error: 'Invalid organisation id' });
    }

    const ctx = await loadOrgContext(orgId, req.user.userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

    // Any member may SEE which accounts exist — the project picker on a board
    // names them, so hiding the list would make the picker unreadable. Only an
    // admin may change them, which the write handlers enforce.
    const accounts = await ConnectorAccount.find({
      organisation: orgId,
      status: { $ne: 'revoked' },
    })
      .sort({ provider: 1, label: 1 })
      .lean();

    return res.json({
      accounts: accounts.map(publicAccount),
      catalog: listConnectors(),
      canManage: !!ctx.can('org.manage_settings'),
    });
  } catch (err) {
    console.error('listOrgConnectors error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/orgs/:orgId/connectors/:provider/authorize
 *
 * Begins a consent. Returns a URL rather than redirecting, because the caller is
 * a fetch from the settings page and a 302 to a third party would be swallowed
 * by CORS. The browser navigates to it.
 */
const startAuthorization = async (req, res) => {
  try {
    const { orgId, provider } = req.params;

    const ctx = await gateOrgAdmin(req, res, orgId);
    if (!ctx) return undefined;

    const connector = getConnector(provider);
    if (!connector) {
      return res.status(400).json({ error: `Unknown connector "${provider}"` });
    }

    // Fail here, loudly, rather than at the callback with a half-finished
    // consent and a code we cannot store.
    const configured = connectorCrypto.checkConfigured();
    if (!configured.ok) {
      console.error('startAuthorization blocked:', configured.error);
      return res.status(500).json({
        error:
          'Connector credential storage is not configured on the server. ' +
          'An administrator needs to set CONNECTOR_MASTER_KEY_V1.',
        code: 'CONNECTOR_CRYPTO_UNCONFIGURED',
      });
    }

    const label = String(req.body?.label || '').trim();
    if (!label) {
      return res.status(400).json({
        error: 'Give this account a name so you can tell it apart from the others.',
      });
    }
    if (label.length > 60) {
      return res.status(400).json({ error: 'That name is too long (60 characters max).' });
    }

    const reconnectId = req.body?.reconnectAccount || null;
    if (reconnectId && !isValidId(reconnectId)) {
      return res.status(400).json({ error: 'Invalid account id' });
    }

    // A fresh consent for a NEW account must not collide with a live one. A
    // reconnect is exempt: it is re-authorising the row that already holds the
    // name.
    if (!reconnectId) {
      const clash = await ConnectorAccount.findOne({
        organisation: orgId,
        provider,
        label,
        status: { $ne: 'revoked' },
      }).lean();
      if (clash) {
        return res.status(409).json({
          error: `You already have a ${connectorProviderLabel(provider)} account called "${label}".`,
        });
      }
    }

    const { codeVerifier, codeChallenge } = connector.oauth.createPkcePair();
    const state = connector.oauth.createState();
    const redirectUri = callbackUrlFor(req);

    await ConnectorAuthAttempt.create({
      organisation: orgId,
      provider,
      state,
      codeVerifier,
      label,
      redirectUri,
      returnTo: typeof req.body?.returnTo === 'string' ? req.body.returnTo : null,
      reconnectAccount: reconnectId,
      createdBy: req.user.userId,
    });

    const authorizeUrl = await connector.oauth.buildAuthorizeUrl({
      redirectUri,
      state,
      codeChallenge,
    });

    return res.json({ authorizeUrl });
  } catch (err) {
    console.error('startAuthorization error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * GET /api/connectors/callback
 *
 * PUBLIC — the provider redirects a browser here, so there is no session and no
 * Authorization header. `state` is the entire authorisation: it was minted by an
 * org admin, stored server-side, and is single-use.
 *
 * Everything here redirects rather than returning JSON. A human is looking at
 * this, not a fetch.
 */
const handleCallback = async (req, res) => {
  const { code, state, error: providerError } = req.query || {};

  // The provider's own error text is attacker-controllable. Log it, never
  // render it, and hand the user a fixed sentence instead.
  if (providerError) {
    console.warn('Connector consent returned an error:', providerError);
    return finishRedirect(res, null, {
      connector: 'error',
      reason: 'declined',
    });
  }

  if (!code || !state) {
    return finishRedirect(res, null, { connector: 'error', reason: 'incomplete' });
  }

  let attempt;
  try {
    // findOneAndDelete: the row is consumed by the first callback that reaches
    // it, so a replayed URL finds nothing. This is also what makes a
    // double-clicked consent produce one account rather than two.
    attempt = await ConnectorAuthAttempt.findOneAndDelete({ state }).lean();
  } catch (err) {
    console.error('handleCallback lookup error:', err);
    return finishRedirect(res, null, { connector: 'error', reason: 'server' });
  }

  if (!attempt) {
    // Expired (15 min), already used, or forged. All three are the same answer.
    return finishRedirect(res, null, { connector: 'error', reason: 'expired' });
  }

  try {
    const connector = getConnector(attempt.provider);
    if (!connector) throw new Error(`Unknown connector "${attempt.provider}"`);

    const tokens = await connector.oauth.exchangeCode({
      code,
      codeVerifier: attempt.codeVerifier,
      redirectUri: attempt.redirectUri,
    });

    const sealedTokens = connectorCrypto.sealJson(tokens, {
      orgId: String(attempt.organisation),
      provider: attempt.provider,
    });

    if (attempt.reconnectAccount) {
      // Re-authorising an account that had gone to `needs_reauth`. Update in
      // place so every project mapping, field mapping and snapshot attached to
      // this account id survives — losing those would mean losing the history,
      // which is the whole reason the feature exists.
      await ConnectorAccount.updateOne(
        { _id: attempt.reconnectAccount, organisation: attempt.organisation },
        {
          $set: {
            sealedTokens,
            scopes: tokens.scopes || [],
            status: 'active',
            updatedBy: attempt.createdBy,
          },
        }
      );
    } else {
      await ConnectorAccount.create({
        organisation: attempt.organisation,
        provider: attempt.provider,
        label: attempt.label,
        sealedTokens,
        scopes: tokens.scopes || [],
        status: 'active',
        createdBy: attempt.createdBy,
      });
    }

    return finishRedirect(res, attempt.returnTo, {
      connector: 'connected',
      provider: attempt.provider,
    });
  } catch (err) {
    console.error('handleCallback exchange error:', err);
    return finishRedirect(res, attempt.returnTo, {
      connector: 'error',
      reason: 'exchange',
    });
  }
};

/**
 * DELETE /api/connectors/:accountId
 *
 * Marks the account revoked and drops the tokens. Deliberately NOT a hard
 * delete: snapshots, project bindings and field mappings reference this id, and
 * removing the row would orphan every one of them — taking the stored history
 * with it. A revoked row keeps the graph intact and stops all outbound calls,
 * which is what "disconnect" actually means here.
 */
const disconnectAccount = async (req, res) => {
  try {
    const { accountId } = req.params;
    if (!isValidId(accountId)) {
      return res.status(400).json({ error: 'Invalid account id' });
    }

    const account = await ConnectorAccount.findById(accountId).lean();
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const ctx = await gateOrgAdmin(req, res, String(account.organisation));
    if (!ctx) return undefined;

    await ConnectorAccount.updateOne(
      { _id: accountId },
      {
        $set: {
          status: 'revoked',
          updatedBy: req.user.userId,
        },
        // The credential goes now. A revoked row must not keep a usable token
        // sitting in the database against the day someone flips the status back.
        $unset: { sealedTokens: '' },
      }
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error('disconnectAccount error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

// ---------------------------------------------------------------------------
// Board plane — enablement
// ---------------------------------------------------------------------------

/**
 * GET /api/boards/:boardId/connectors
 *
 * What this board has switched on, plus the accounts it could draw from. Reads
 * only our own database — nothing here contacts a provider, which is why
 * `connector.view` sits on the bottom rung of the board ladder.
 */
const getBoardConnectors = async (req, res) => {
  try {
    const ctx = await gateBoard(req, res, 'connector.view');
    if (!ctx) return undefined;

    const [enabled, accounts] = await Promise.all([
      BoardConnector.find({ board: ctx.board._id }).lean(),
      ConnectorAccount.find({
        organisation: ctx.board.organisation,
        status: { $ne: 'revoked' },
      })
        .sort({ provider: 1, label: 1 })
        .lean(),
    ]);

    const byProvider = new Map(enabled.map((e) => [e.provider, e]));

    return res.json({
      connectors: listConnectors().map((c) => {
        const row = byProvider.get(c.name);
        const providerAccounts = accounts.filter((a) => a.provider === c.name);
        return {
          ...c,
          enabled: !!row?.enabled,
          kinds: row?.kinds || [],
          lastRefreshAt: row?.lastRefreshAt || null,
          // A connector with no account behind it can be switched on but will
          // never fetch. The UI needs to say so rather than showing an enabled
          // toggle over an empty tab.
          accountCount: providerAccounts.length,
          needsReauthCount: providerAccounts.filter((a) => a.status === 'needs_reauth')
            .length,
        };
      }),
      accounts: accounts.map(publicAccount),
      canManage: !!ctx.can('connector.manage'),
    });
  } catch (err) {
    console.error('getBoardConnectors error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * PUT /api/boards/:boardId/connectors/:provider
 * Body: { enabled: boolean, kinds?: string[] }
 */
const setBoardConnector = async (req, res) => {
  try {
    const { provider } = req.params;

    const ctx = await gateBoard(req, res, 'connector.manage');
    if (!ctx) return undefined;

    if (!isConnectorProvider(provider) || !getConnector(provider)) {
      return res.status(400).json({ error: `Unknown connector "${provider}"` });
    }

    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be true or false' });
    }

    const update = {
      organisation: ctx.board.organisation,
      enabled,
      enabledBy: req.user.userId,
    };
    if (Array.isArray(req.body?.kinds)) {
      update.kinds = req.body.kinds.filter((k) => typeof k === 'string');
    }

    // Upsert against the unique (board, provider) index, so a double-click
    // cannot create a second row and a board cannot half-enable a connector.
    const row = await BoardConnector.findOneAndUpdate(
      { board: ctx.board._id, provider },
      { $set: update },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).lean();

    return res.json({
      connector: {
        provider,
        enabled: row.enabled,
        kinds: row.kinds || [],
        lastRefreshAt: row.lastRefreshAt || null,
      },
    });
  } catch (err) {
    console.error('setBoardConnector error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

// ---------------------------------------------------------------------------
// Board plane — the project mirror
// ---------------------------------------------------------------------------

/**
 * The public shape of a mirrored project. Hand-built for the same reason
 * `publicAccount` is: a field added to the model later must not leak by default.
 *
 * `raw` is the one omission worth naming. It is the provider's payload verbatim,
 * kept so phases 3-5 can be built against what the API actually returned rather
 * than what we remember it returning — but it is bulky, undocumented, and of no
 * use to the tab. It is returned only when explicitly asked for, and only to
 * someone who could refresh it anyway.
 */
const publicProject = (project, { includeRaw = false } = {}) => {
  const out = {
    _id: project._id,
    account: project.account,
    provider: project.provider,
    externalId: project.externalId,
    name: project.name || '',
    domain: project.domain || null,
    keywordCount: project.keywordCount ?? null,
    competitorCount: project.competitorCount ?? null,
    locations: project.locations || [],
    hasBrand: !!project.hasBrand,
    group: project.group || null,
    board: project.board || null,
    boundAt: project.boundAt || null,
    missing: !!project.missing,
    lastSeenAt: project.lastSeenAt || null,
  };
  if (includeRaw) out.raw = project.raw ?? null;
  return out;
};

/**
 * GET /api/boards/:boardId/connectors/:provider/projects
 *
 * Every project the org's accounts hold for this provider, with its binding.
 *
 * READS OUR OWN DATABASE ONLY. Nothing here contacts the provider and nothing
 * here spends quota, which is what lets it sit on `connector.view` — the bottom
 * rung of the board ladder — and be safe to call on every render.
 *
 * The listing is org-wide rather than board-wide on purpose. A project bound to
 * a group on ANOTHER board still has to appear, or it would look available here
 * and then fail the unique index on save with nothing to explain why.
 */
const getBoardConnectorProjects = async (req, res) => {
  try {
    const { provider } = req.params;

    const ctx = await gateBoard(req, res, 'connector.view');
    if (!ctx) return undefined;

    if (!isConnectorProvider(provider) || !getConnector(provider)) {
      return res.status(400).json({ error: `Unknown connector "${provider}"` });
    }

    const canManage = !!ctx.can('connector.manage');
    // Only offered to someone who could re-fetch it anyway. See publicProject.
    const includeRaw = canManage && req.query?.includeRaw === '1';

    const [projects, accounts] = await Promise.all([
      ConnectorProject.find({ organisation: ctx.board.organisation, provider })
        .sort({ missing: 1, name: 1 })
        .lean(),
      ConnectorAccount.find({
        organisation: ctx.board.organisation,
        provider,
        status: { $ne: 'revoked' },
      })
        .sort({ label: 1 })
        .lean(),
    ]);

    return res.json({
      projects: projects.map((p) => publicProject(p, { includeRaw })),
      accounts: accounts.map(publicAccount),
      canManage,
    });
  } catch (err) {
    console.error('getBoardConnectorProjects error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/boards/:boardId/connectors/:provider/projects/refresh
 *
 * The one endpoint in phase 2 that reaches the provider. `connector.manage`,
 * because it spends a quota shared by the entire workspace.
 *
 * Answers 200 with a per-account report even when some accounts failed. A pool
 * where one account is out of quota and three are fine is a successful refresh
 * with one gap, and turning that into a 500 would hide the three.
 */
const refreshBoardConnectorProjects = async (req, res) => {
  try {
    const { provider } = req.params;

    const ctx = await gateBoard(req, res, 'connector.manage');
    if (!ctx) return undefined;

    if (!isConnectorProvider(provider) || !getConnector(provider)) {
      return res.status(400).json({ error: `Unknown connector "${provider}"` });
    }

    const report = await refreshOrgProjects({
      organisation: ctx.board.organisation,
      provider,
    });

    // Nothing to refresh is not a failure, but it is worth saying out loud —
    // otherwise the tab shows an empty list and a successful toast.
    if (!report.accounts.length) {
      return res.status(409).json({
        error: `No ${connectorProviderLabel(provider)} account is connected to this workspace yet.`,
        code: 'NO_ACCOUNT',
      });
    }

    await BoardConnector.updateOne(
      { board: ctx.board._id, provider },
      {
        $set: {
          organisation: ctx.board.organisation,
          lastRefreshAt: new Date(),
          lastRefreshBy: req.user.userId,
        },
        $setOnInsert: { enabled: true, enabledBy: req.user.userId },
      },
      { upsert: true }
    );

    const projects = await ConnectorProject.find({
      organisation: ctx.board.organisation,
      provider,
    })
      .sort({ missing: 1, name: 1 })
      .lean();

    return res.json({
      projects: projects.map((p) => publicProject(p)),
      report,
    });
  } catch (err) {
    console.error('refreshBoardConnectorProjects error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * PUT /api/boards/:boardId/connectors/:provider/projects/:projectId
 * Body: { group: string|null }
 *
 * Bind a project to one of this board's groups, or unbind it with null.
 *
 * The group must be on THIS board. Without that check, a board editor could
 * point a project at a group on a private board they cannot open — and from
 * phase 5 that binding is what decides whose numbers land on whose row.
 */
const setConnectorProjectGroup = async (req, res) => {
  try {
    const { provider, projectId } = req.params;

    const ctx = await gateBoard(req, res, 'connector.manage');
    if (!ctx) return undefined;

    if (!isConnectorProvider(provider) || !getConnector(provider)) {
      return res.status(400).json({ error: `Unknown connector "${provider}"` });
    }
    if (!isValidId(projectId)) {
      return res.status(400).json({ error: 'Invalid project id' });
    }

    const groupId = req.body?.group ?? null;
    if (groupId !== null && !isValidId(groupId)) {
      return res.status(400).json({ error: 'Invalid group id' });
    }

    const project = await ConnectorProject.findOne({
      _id: projectId,
      organisation: ctx.board.organisation,
      provider,
    });
    if (!project) return res.status(404).json({ error: 'Project not found' });

    if (groupId === null) {
      project.group = null;
      project.board = null;
      project.boundBy = null;
      project.boundAt = null;
      await project.save();
      return res.json({ project: publicProject(project) });
    }

    const group = await TaskGroup.findById(groupId).select('board name').lean();
    if (!group || String(group.board) !== String(ctx.board._id)) {
      return res.status(400).json({ error: 'That group is not on this board.' });
    }

    // A group holds one project per provider, and so does the unique index. Ask
    // first so the answer is a sentence naming the project that already has it,
    // rather than a duplicate-key error the UI has to guess at.
    const taken = await ConnectorProject.findOne({
      provider,
      group: groupId,
      _id: { $ne: project._id },
    })
      .select('name domain')
      .lean();
    if (taken) {
      return res.status(409).json({
        error: `"${group.name}" is already mapped to ${taken.name || taken.domain}. Unmap that first.`,
        code: 'GROUP_TAKEN',
      });
    }

    project.group = groupId;
    project.board = ctx.board._id;
    project.boundBy = req.user.userId;
    project.boundAt = new Date();

    try {
      await project.save();
    } catch (err) {
      // The index is still the authority — two admins mapping the same group at
      // the same moment both pass the check above.
      if (err.code === 11000) {
        return res.status(409).json({
          error: 'That group was just mapped to another project. Reload and try again.',
          code: 'GROUP_TAKEN',
        });
      }
      throw err;
    }

    return res.json({ project: publicProject(project) });
  } catch (err) {
    console.error('setConnectorProjectGroup error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

module.exports = {
  getCatalog,
  listOrgConnectors,
  startAuthorization,
  handleCallback,
  disconnectAccount,
  getBoardConnectors,
  setBoardConnector,
  getBoardConnectorProjects,
  refreshBoardConnectorProjects,
  setConnectorProjectGroup,
  // Exported for the phases that follow — one gate, not a copy per controller.
  gateBoard,
  gateOrgAdmin,
  publicAccount,
  publicProject,
};
