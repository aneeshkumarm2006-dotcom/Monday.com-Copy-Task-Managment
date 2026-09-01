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
    res.status(400).json({ error: 'Invalid workspace id' });
    return null;
  }

  const ctx = await loadOrgContext(orgId, req.user.userId);
  if (ctx.error) {
    res.status(ctx.status).json({ error: ctx.error });
    return null;
  }

  if (!ctx.can('org.manage_settings')) {
    res.status(403).json({
      error: 'Only a workspace admin can connect or remove a connector account.',
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
      return res.status(400).json({ error: 'Invalid workspace id' });
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
    if (!connector.oauth) {
      // The mirror of the refusal in `saveCredentials`. A provider that
      // authenticates with a stored key has no authorization server to send a
      // browser to, and there is no URL this could honestly return.
      return res.status(400).json({
        error: `${connector.label} is connected with a key, not by signing in.`,
        code: 'REQUIRES_CREDENTIALS',
      });
    }

    // Fail here, loudly, rather than at the callback with a half-finished
    // consent and a code we cannot store. Shared with `saveCredentials` — see
    // `checkAccountPreflight`.
    const pre = await checkAccountPreflight({ orgId, provider, body: req.body });
    if (!pre.ok) return res.status(pre.status).json(pre.body);
    const { label, reconnectId } = pre;

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
 * The three preflight checks `startAuthorization` and `saveCredentials` share.
 *
 * Pulled out rather than copied, because all three are about the ACCOUNT ROW
 * rather than about how it authenticates, and a second copy is how one of them
 * quietly stops being enforced on one of the two paths. Order matters: the
 * crypto check first, so a workspace with no key configured is told that instead
 * of being walked through a form whose result cannot be stored.
 *
 * @returns {Promise<{ok: true, label: string, reconnectId: string|null}
 *   |{ok: false, status: number, body: Object}>}
 */
const checkAccountPreflight = async ({ orgId, provider, body }) => {
  const configured = connectorCrypto.checkConfigured();
  if (!configured.ok) {
    console.error('connector credential storage unavailable:', configured.error);
    return {
      ok: false,
      status: 500,
      body: {
        error:
          'Connector credential storage is not configured on the server. ' +
          'An administrator needs to set CONNECTOR_MASTER_KEY_V1.',
        code: 'CONNECTOR_CRYPTO_UNCONFIGURED',
      },
    };
  }

  const label = String(body?.label || '').trim();
  if (!label) {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'Give this account a name so you can tell it apart from the others.',
      },
    };
  }
  if (label.length > 60) {
    return {
      ok: false,
      status: 400,
      body: { error: 'That name is too long (60 characters max).' },
    };
  }

  const reconnectId = body?.reconnectAccount || null;
  if (reconnectId && !isValidId(reconnectId)) {
    return { ok: false, status: 400, body: { error: 'Invalid account id' } };
  }

  // A NEW account must not collide with a live one. A reconnect is exempt: it is
  // re-authorising the row that already holds the name.
  if (!reconnectId) {
    const clash = await ConnectorAccount.findOne({
      organisation: orgId,
      provider,
      label,
      status: { $ne: 'revoked' },
    }).lean();
    if (clash) {
      return {
        ok: false,
        status: 409,
        body: {
          error: `You already have a ${connectorProviderLabel(provider)} account called "${label}".`,
        },
      };
    }
  }

  return { ok: true, label, reconnectId };
};

/**
 * Read the submitted credential against the descriptor's own form.
 *
 * Built FIELD BY FIELD from what the descriptor declares, never from what the
 * request sent. That direction is the whole point: the request cannot introduce
 * a property, so nothing unexpected reaches `sealJson`, and a client that posts
 * an extra key gets it dropped rather than stored forever inside an envelope
 * nobody will think to look in.
 *
 * @param {Object} spec - `descriptor.apiKey`
 * @param {Object} body
 * @returns {{ok: true, credentials: Object}|{ok: false, error: string}}
 */
const readCredentialForm = (spec, body) => {
  const submitted = body?.credentials;
  if (!submitted || typeof submitted !== 'object' || Array.isArray(submitted)) {
    return { ok: false, error: 'Fill in the connection details.' };
  }

  const credentials = {};
  for (const field of spec.fields) {
    const raw = submitted[field.key];
    if (typeof raw !== 'string' || !raw.trim()) {
      return { ok: false, error: `${field.label} is required.` };
    }
    // A ceiling, so a mistyped paste of an entire file cannot become a sealed
    // envelope the size of a document. Generous enough for any real key.
    if (raw.length > 500) {
      return { ok: false, error: `${field.label} is too long.` };
    }
    credentials[field.key] = raw.trim();
  }

  return { ok: true, credentials };
};

/**
 * POST /api/orgs/:orgId/connectors/:provider/credentials
 * Body: { label, credentials: {…}, reconnectAccount? }
 *
 * The other way an account is connected: a provider that issues a key and a
 * password, with no authorization server to send a browser to.
 *
 * ---- Why this is a second handler rather than a branch -----------------------
 *
 * `startAuthorization` mints a `ConnectorAuthAttempt` carrying a `codeVerifier`
 * and a `redirectUri`, both `required` on that model and both meaningless here —
 * there is no round trip to protect, because the credential arrives in this one
 * request from a session that is already authenticated as an org admin. Loosening
 * that model to accommodate a flow with no callback would weaken the record that
 * makes the OAuth callback safe to leave unauthenticated.
 *
 * ---- What it shares, and what it must never do -------------------------------
 *
 * Same gate (`org.manage_settings` — this is workspace-wide credential handling),
 * same crypto preflight, same label rules, same duplicate-label 409, same
 * reconnect-in-place semantics, and the same envelope: `connectorCrypto.sealJson`
 * with `orgId|provider` as AAD. Nothing about `connectorCrypto` changes to
 * accommodate this — it seals arbitrary JSON already, and resisting a
 * "credential" variant is what keeps one envelope format and one keyring.
 *
 * And the rule the whole file is under: what arrives here is sealed and is never
 * read back out. There is no GET, the response is a `publicAccount`, and
 * `sealedTokens` stays `select: false`.
 */
const saveCredentials = async (req, res) => {
  try {
    const { orgId, provider } = req.params;

    const ctx = await gateOrgAdmin(req, res, orgId);
    if (!ctx) return undefined;

    const connector = getConnector(provider);
    if (!connector) {
      return res.status(400).json({ error: `Unknown connector "${provider}"` });
    }
    if (!connector.apiKey) {
      // The mirror of the refusal on the other path. A provider with a consent
      // screen has no key to paste, and accepting one would store a credential
      // that can never authenticate anything.
      return res.status(400).json({
        error: `${connector.label} is connected by signing in, not with a key.`,
        code: 'REQUIRES_BROWSER_CONSENT',
      });
    }

    const pre = await checkAccountPreflight({ orgId, provider, body: req.body });
    if (!pre.ok) return res.status(pre.status).json(pre.body);

    const form = readCredentialForm(connector.apiKey, req.body);
    if (!form.ok) return res.status(400).json({ error: form.error });

    /**
     * Check the credential BEFORE storing it, where the provider offers a free
     * way to.
     *
     * ---- Why this belongs on this path and not the other -------------------
     *
     * The consent flow cannot store a credential that does not work: the
     * provider itself authenticates the person, and a wrong password never
     * reaches the callback. A key POST has no such step. Without a check here, a
     * mistyped API password is sealed, saved, and reported as success — and the
     * first sign of trouble is a weekly cron marking the account `needs_reauth`
     * days later, with a Reconnect button and nothing to say what was wrong.
     *
     * ---- The distinction that makes this safe to add ------------------------
     *
     * "The provider says no" and "we could not ask" are different answers and
     * only the first is a reason to refuse. Treating an outage as a bad password
     * would mean a third party being down stops an admin from configuring
     * anything — so a REFUSAL blocks and a TRANSPORT FAILURE is logged and
     * allowed through. The credential still has to work before anything is
     * collected; the run report is where that surfaces.
     *
     * ---- And what is deliberately not kept ---------------------------------
     *
     * Nothing from the answer is persisted or returned. For this provider the
     * login IS the account email, so echoing back what the check learned would
     * break the rule the whole endpoint is under: a credential goes in and never
     * comes back out. Identity is recorded later, by the project refresh, into
     * the field built for it.
     */
    if (typeof connector.verifyCredentials === 'function') {
      try {
        await connector.verifyCredentials(form.credentials);
      } catch (err) {
        if (err?.needsReauth || err?.forbidden) {
          return res.status(400).json({
            error:
              `${connector.label} did not accept those details. ` +
              'Check the login and the API password and try again.',
            code: 'CREDENTIALS_REJECTED',
          });
        }
        // Could not find out. Storing beats refusing: the credential may be
        // perfect and the provider merely unreachable.
        console.warn(
          `[connectors] could not verify ${provider} credentials for org ${orgId}: ${err.message}`
        );
      }
    }

    const sealedTokens = connectorCrypto.sealJson(form.credentials, {
      orgId: String(orgId),
      provider,
    });

    let account;
    try {
      if (pre.reconnectId) {
        // In place, so every project mapping, field mapping and snapshot attached
        // to this account id survives — the same reasoning as the OAuth
        // reconnect, and losing them would mean losing the history this feature
        // exists to build.
        account = await ConnectorAccount.findOneAndUpdate(
          { _id: pre.reconnectId, organisation: orgId, provider },
          {
            $set: {
              label: pre.label,
              sealedTokens,
              status: 'active',
              updatedBy: req.user.userId,
            },
          },
          { new: true }
        ).lean();
        if (!account) return res.status(404).json({ error: 'Account not found' });
      } else {
        account = (
          await ConnectorAccount.create({
            organisation: orgId,
            provider,
            label: pre.label,
            sealedTokens,
            scopes: [],
            status: 'active',
            createdBy: req.user.userId,
          })
        ).toObject();
      }
    } catch (err) {
      // The partial unique index on (organisation, provider, label) is still the
      // authority — two admins saving the same name at the same moment both pass
      // the check above.
      if (err?.code === 11000) {
        return res.status(409).json({
          error: `You already have a ${connectorProviderLabel(provider)} account called "${pre.label}".`,
        });
      }
      throw err;
    }

    return res.status(pre.reconnectId ? 200 : 201).json({
      account: publicAccount(account),
    });
  } catch (err) {
    console.error('saveCredentials error:', err);
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
          /**
           * What this board RENDERS, beside what it PAYS TO COLLECT.
           *
           * Two fields on purpose, and the model header is where the reasoning
           * lives: `kinds` is unioned across every board mapping the same
           * project, so narrowing it reaches across to a co-tenant, while
           * `enabledScreens` is free and cannot leave this board.
           */
          enabledScreens: row?.enabledScreens || [],
          /** Null means the descriptor's cadence. Resolved as a MIN across boards. */
          intervalHours: row?.intervalHours ?? null,
          budget: {
            monthlyUsd: row?.budget?.monthlyUsd ?? null,
            alertAtPct: row?.budget?.alertAtPct ?? 80,
          },
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
 * The board's cadence override, or a refusal.
 *
 * Absent means "no opinion" and is the normal state. A number is accepted only
 * if it is finite and at least one hour: `scheduleForProvider` resolves this as
 * a MIN across every board mapping the same project, so a stored 0 would make
 * the resolved cadence 0 for every co-tenant and turn the hourly tick into an
 * hourly purchase on a provider that bills at post. `askedInterval` in
 * `snapshotService` already refuses to trust such a value at read time; this
 * refuses to store one, so the two agree and the number in the box is the number
 * that runs.
 *
 * The provider's own `minRebuyHours` floor sits under all of it, which is what
 * makes an aggressive-but-valid cadence expensive-at-worst rather than unbounded.
 *
 * @param {any} value
 * @returns {{ok: true, value: number|null}|{ok: false, error: string}}
 */
const readIntervalHours = (value) => {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null || value === '') return { ok: true, value: null };
  const asked = Number(value);
  if (!Number.isFinite(asked) || asked < 1) {
    return {
      ok: false,
      error: 'How often to collect must be at least 1 hour, or blank for the default.',
    };
  }
  // A year. Above this a cadence is indistinguishable from "off", and off is
  // what the enable switch is for.
  if (asked > 8760) {
    return { ok: false, error: 'How often to collect must be under a year.' };
  }
  return { ok: true, value: asked };
};

/**
 * PUT /api/boards/:boardId/connectors/:provider
 * Body: { enabled: boolean, kinds?: string[], enabledScreens?: string[],
 *         intervalHours?: number|null, budget?: {monthlyUsd, alertAtPct} }
 */
const setBoardConnector = async (req, res) => {
  try {
    const { provider } = req.params;

    const ctx = await gateBoard(req, res, 'connector.manage');
    if (!ctx) return undefined;

    const connector = isConnectorProvider(provider) ? getConnector(provider) : null;
    if (!connector) {
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

    /**
     * Which screens this board renders, filtered against the descriptor's own
     * catalog.
     *
     * REFUSED RATHER THAN STORED, when a key names no screen this provider
     * declares. An unknown string sitting in the array is indistinguishable from
     * a screen a later phase adds — so the day phase 7 ships `backlinks`, a
     * board carrying a stale `backlinks` string would silently switch it on for
     * a client who never asked. Filtering here is one line and closes that.
     *
     * `alwaysOn` screens are not stored either way: `resolveScreens` adds them
     * back regardless, so writing them would only make the stored array look
     * like a decision somebody made.
     */
    if (Array.isArray(req.body?.enabledScreens)) {
      const known = new Set(
        (Array.isArray(connector.screens) ? connector.screens : []).map((s) => s.key)
      );
      update.enabledScreens = req.body.enabledScreens.filter(
        (s) => typeof s === 'string' && known.has(s)
      );
    }

    const interval = readIntervalHours(req.body?.intervalHours);
    if (!interval.ok) return res.status(400).json({ error: interval.error });
    if (interval.value !== undefined) update.intervalHours = interval.value;

    /**
     * The board's ALLOCATION of the org's money — never a ceiling of its own.
     * See the model header: the account is org-scoped, so the number that
     * actually stops work is the org's `ConnectorBudget`.
     *
     * Null clears it, which is the normal state and the one that creates no
     * second budget document and therefore no two-document reservation.
     */
    if (req.body?.budget && typeof req.body.budget === 'object') {
      const monthly = req.body.budget.monthlyUsd;
      if (monthly === null || monthly === '') {
        update['budget.monthlyUsd'] = null;
      } else if (monthly !== undefined) {
        const asked = Number(monthly);
        if (!Number.isFinite(asked) || asked < 0) {
          return res
            .status(400)
            .json({ error: 'A monthly allocation must be a positive amount, or blank.' });
        }
        update['budget.monthlyUsd'] = asked > 0 ? asked : null;
      }

      const pct = req.body.budget.alertAtPct;
      if (pct !== undefined && pct !== null && pct !== '') {
        const asked = Number(pct);
        if (!Number.isFinite(asked) || asked <= 0 || asked > 100) {
          return res
            .status(400)
            .json({ error: 'Warn at must be a percentage between 1 and 100.' });
        }
        update['budget.alertAtPct'] = Math.round(asked);
      }
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
        enabledScreens: row.enabledScreens || [],
        intervalHours: row.intervalHours ?? null,
        budget: {
          monthlyUsd: row.budget?.monthlyUsd ?? null,
          alertAtPct: row.budget?.alertAtPct ?? 80,
        },
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
    /**
     * The authored half, for a provider whose projects are created here rather
     * than mirrored from anywhere. Empty for a mirrored row, which is the honest
     * answer rather than an absent key the client would have to branch on.
     *
     * These are not secrets — a keyword list is what the person on this board
     * typed — so they ride on the ordinary read the way `locations` always has.
     */
    trackedKeywords: project.trackedKeywords || [],
    targets: project.targets || [],
    competitors: project.competitors || [],
    /**
     * The Google Business Profile query, when one has been authored. Empty is
     * the ordinary answer and is what keeps the Local kind from being bought;
     * see `ConnectorProject.businessName`.
     */
    businessName: project.businessName || '',
    locallyAuthored: !!project.locallyAuthored,
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

// ---------------------------------------------------------------------------
// Board plane — projects that are AUTHORED rather than mirrored
// ---------------------------------------------------------------------------

/**
 * Some providers have no projects to mirror.
 *
 * The first one does: a project is a domain, a keyword list and a set of tracked
 * locales that all live at the provider, and the row here is a cache of somebody
 * else's record. A stateless billing API has none of that — it takes a keyword,
 * a location, a language and a device on every call and remembers nothing — so
 * the row has to be the ORIGINAL, authored here, with `externalId` set to our
 * own id.
 *
 * Which providers work that way is the DESCRIPTOR's answer, not this file's. A
 * descriptor declaring `projectAuthoring` gets these two endpoints and the form
 * rules that travel with it; one that does not gets a 400 and keeps its projects
 * mirror-only, so nobody can invent an Ubersuggest project that Ubersuggest has
 * never heard of. That is the same rule `saveCredentials` and `startAuthorization`
 * apply to each other, for the same reason.
 *
 * @returns {Promise<{ctx: Object, connector: Object}|null>} null having answered
 */
const gateAuthoring = async (req, res) => {
  const { provider } = req.params;

  const ctx = await gateBoard(req, res, 'connector.manage');
  if (!ctx) return null;

  const connector = isConnectorProvider(provider) ? getConnector(provider) : null;
  if (!connector) {
    res.status(400).json({ error: `Unknown connector "${provider}"` });
    return null;
  }
  if (!connector.projectAuthoring || typeof connector.projectAuthoring.readForm !== 'function') {
    res.status(400).json({
      error: `${connector.label} brings its own projects. Refresh them instead of adding one.`,
      code: 'NOT_AUTHORED',
    });
    return null;
  }

  return { ctx, connector };
};

/**
 * Which connected account a new project belongs to.
 *
 * `ConnectorProject.account` is required and part of its unique key, so this
 * cannot be deferred. An explicit id is checked against the org; an omitted one
 * is allowed only when the pool holds exactly one usable account, because
 * picking for somebody out of several would attach a client's site to whichever
 * account sorted first.
 *
 * @returns {Promise<{ok: true, account: Object}|{ok: false, status: number, body: Object}>}
 */
const resolveAuthoringAccount = async ({ organisation, provider, accountId }) => {
  if (accountId) {
    if (!isValidId(accountId)) {
      return { ok: false, status: 400, body: { error: 'Invalid account id' } };
    }
    const account = await ConnectorAccount.findOne({
      _id: accountId,
      organisation,
      provider,
      status: { $ne: 'revoked' },
    }).lean();
    if (!account) {
      return { ok: false, status: 404, body: { error: 'Connected account not found' } };
    }
    return { ok: true, account };
  }

  const accounts = await ConnectorAccount.find({
    organisation,
    provider,
    status: { $ne: 'revoked' },
  })
    .sort({ label: 1 })
    .lean();

  if (!accounts.length) {
    return {
      ok: false,
      status: 409,
      body: {
        error: `Connect a ${connectorProviderLabel(provider)} account first.`,
        code: 'NO_ACCOUNT',
      },
    };
  }
  if (accounts.length > 1) {
    return {
      ok: false,
      status: 400,
      body: { error: 'Say which connected account this site belongs to.' },
    };
  }
  return { ok: true, account: accounts[0] };
};

/**
 * Two sites for one domain on one workspace is a mistake every time.
 *
 * Checked in the app rather than with an index, deliberately: a unique index
 * would also forbid it across two different providers, and a domain tracked in
 * both Ubersuggest and DataForSEO is a perfectly ordinary thing to want.
 */
const findDomainClash = async ({ organisation, provider, domain, excludeId = null }) => {
  const filter = { organisation, provider, domain };
  if (excludeId) filter._id = { $ne: excludeId };
  return ConnectorProject.findOne(filter).select('name domain').lean();
};

/**
 * POST /api/boards/:boardId/connectors/:provider/sites
 * Body: { account?, name?, domain, trackedKeywords[], targets[], competitors[] }
 *
 * Create a locally-authored project.
 *
 * `connector.manage`, the same rung as mapping a project to a group and for a
 * stronger version of the same reason: this document is what a collection is
 * bought FROM. Its keyword list times its target list is the size of the bill.
 */
const createConnectorSite = async (req, res) => {
  try {
    const gated = await gateAuthoring(req, res);
    if (!gated) return undefined;
    const { ctx, connector } = gated;
    const { provider } = req.params;

    const form = connector.projectAuthoring.readForm(req.body);
    if (!form.ok) {
      return res.status(400).json({ error: form.error, code: form.code || undefined });
    }

    const resolved = await resolveAuthoringAccount({
      organisation: ctx.board.organisation,
      provider,
      accountId: req.body?.account,
    });
    if (!resolved.ok) return res.status(resolved.status).json(resolved.body);

    const clash = await findDomainClash({
      organisation: ctx.board.organisation,
      provider,
      domain: form.values.domain,
    });
    if (clash) {
      return res.status(409).json({
        error: `${form.values.domain} is already set up here. Edit that site instead.`,
        code: 'DOMAIN_TAKEN',
      });
    }

    /**
     * The id is minted FIRST so `externalId` can be it.
     *
     * `externalId` is required and unique per account because for a mirrored
     * provider it is the provider's own handle. There is no such handle here,
     * and inventing a random string would leave two identifiers for one row that
     * could drift apart. Ours, spelled once, is the honest answer — and it keeps
     * the unique index on `(account, externalId)` doing real work.
     */
    const _id = new mongoose.Types.ObjectId();

    let project;
    try {
      project = await ConnectorProject.create({
        _id,
        externalId: String(_id),
        account: resolved.account._id,
        organisation: ctx.board.organisation,
        provider,
        locallyAuthored: true,
        // Nothing mirrored this, so there is no provider payload to keep.
        raw: null,
        missing: false,
        lastSeenAt: new Date(),
        ...form.values,
      });
    } catch (err) {
      if (err?.code === 11000) {
        return res.status(409).json({
          error: 'That site was just added. Reload and try again.',
          code: 'DOMAIN_TAKEN',
        });
      }
      throw err;
    }

    return res.status(201).json({ project: publicProject(project) });
  } catch (err) {
    console.error('createConnectorSite error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * PUT /api/boards/:boardId/connectors/:provider/sites/:projectId
 * Body: the same shape as the create.
 *
 * A FULL REPLACEMENT of the authored fields, not a patch. An edit that drops
 * four keywords has to be able to say so, and a partial update of a list is
 * ambiguous in a way that costs money in one direction and loses history in the
 * other.
 *
 * What it deliberately does NOT touch: the group binding, the account, and every
 * snapshot already taken. Changing the keyword list is an ordinary thing to do
 * to a live site, and it must not read as a different site.
 */
const updateConnectorSite = async (req, res) => {
  try {
    const gated = await gateAuthoring(req, res);
    if (!gated) return undefined;
    const { ctx, connector } = gated;
    const { provider, projectId } = req.params;

    if (!isValidId(projectId)) {
      return res.status(400).json({ error: 'Invalid project id' });
    }

    const form = connector.projectAuthoring.readForm(req.body);
    if (!form.ok) {
      return res.status(400).json({ error: form.error, code: form.code || undefined });
    }

    const project = await ConnectorProject.findOne({
      _id: projectId,
      organisation: ctx.board.organisation,
      provider,
    });
    if (!project) return res.status(404).json({ error: 'Project not found' });

    // A mirrored row is somebody else's record. Editing one here would put our
    // edit and the next refresh in a fight the refresh always wins.
    if (!project.locallyAuthored) {
      return res.status(409).json({
        error: 'That project came from the provider, so it is edited there.',
        code: 'NOT_AUTHORED',
      });
    }

    if (project.domain !== form.values.domain) {
      const clash = await findDomainClash({
        organisation: ctx.board.organisation,
        provider,
        domain: form.values.domain,
        excludeId: project._id,
      });
      if (clash) {
        return res.status(409).json({
          error: `${form.values.domain} is already set up here.`,
          code: 'DOMAIN_TAKEN',
        });
      }
    }

    Object.assign(project, form.values);
    await project.save();

    return res.json({ project: publicProject(project) });
  } catch (err) {
    console.error('updateConnectorSite error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

module.exports = {
  getCatalog,
  listOrgConnectors,
  startAuthorization,
  saveCredentials,
  handleCallback,
  disconnectAccount,
  getBoardConnectors,
  setBoardConnector,
  getBoardConnectorProjects,
  refreshBoardConnectorProjects,
  setConnectorProjectGroup,
  createConnectorSite,
  updateConnectorSite,
  // Exported for the phases that follow — one gate, not a copy per controller.
  gateBoard,
  gateOrgAdmin,
  publicAccount,
  publicProject,
  // Pure, and exported because they are what the credential-seam tests assert
  // on: the shared preflight and the descriptor-driven read of a posted form.
  checkAccountPreflight,
  readCredentialForm,
  readIntervalHours,
};
