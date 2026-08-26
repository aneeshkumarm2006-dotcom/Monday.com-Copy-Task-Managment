const ConnectorAccount = require('../../models/ConnectorAccount');
const connectorCrypto = require('../../utils/connectorCrypto');
const { getConnector } = require('./index');

/**
 * The bridge between a stored ConnectorAccount row and a provider client.
 *
 * ---- Why this is generic and lives here ------------------------------------
 *
 * Unsealing a credential, refreshing it, persisting a ROTATED refresh token and
 * marking a dead grant `needs_reauth` are the same four steps for every
 * provider. The transport is not — Ubersuggest speaks MCP over HTTP, the Ads
 * boards will speak REST — so the transport stays inside the provider directory
 * and this hands the descriptor a session instead.
 *
 * The alternative, passing raw tokens into the descriptor and letting it write
 * them back, would put credential persistence in every provider directory. That
 * is the one thing worth having exactly one copy of.
 *
 * ---- The rule this file exists to enforce ----------------------------------
 *
 * `sealedTokens` is `select: false`, and THIS IS THE ONLY PLACE THAT ASKS FOR
 * IT. A session hands out an access token to a transport and nothing else: the
 * token never enters a controller, never enters a response body, and the
 * session object itself must never be serialised. See connectorLeak.test.js.
 */

/**
 * Open an authenticated session for one account.
 *
 * @param {string|Object} accountOrId - an id, or a lean row (its tokens are
 *   re-read here regardless; a row loaded elsewhere will not carry them)
 * @returns {Promise<Object>} the session
 * @throws {Error} `.needsReauth` when the stored grant cannot be used
 */
const openSession = async (accountOrId) => {
  const accountId = accountOrId?._id || accountOrId;

  const account = await ConnectorAccount.findById(accountId).select(
    '+sealedTokens'
  );
  if (!account) {
    const err = new Error('That connected account no longer exists.');
    err.status = 404;
    throw err;
  }
  if (account.status === 'revoked') {
    const err = new Error(`"${account.label}" has been disconnected.`);
    err.status = 409;
    throw err;
  }

  const connector = getConnector(account.provider);
  if (!connector) {
    throw new Error(`Unknown connector "${account.provider}"`);
  }

  const ctx = {
    orgId: String(account.organisation),
    provider: account.provider,
  };

  let tokens;
  try {
    tokens = connectorCrypto.openJson(account.sealedTokens, ctx);
  } catch (err) {
    // Either the key changed under us or the row was tampered with. Both are
    // unrecoverable without a fresh consent, and both must look the same to a
    // caller — the distinction is only useful to an attacker.
    console.error(
      `[connectors] could not open tokens for account ${account._id}: ${err.message}`
    );
    const wrapped = new Error(
      `"${account.label}" could not be unlocked on this server. It needs to be reconnected.`
    );
    wrapped.needsReauth = true;
    throw wrapped;
  }

  /** Persist a status change without touching anything else on the row. */
  const setStatus = async (status) => {
    if (account.status === status) return;
    account.status = status;
    await ConnectorAccount.updateOne({ _id: account._id }, { $set: { status } });
  };

  const session = {
    accountId: account._id,
    organisation: account.organisation,
    provider: account.provider,
    label: account.label,

    /** The bearer token, for a transport. Never leaves this process. */
    getAccessToken: () => tokens.accessToken,

    /**
     * Refresh, persist, and keep going.
     *
     * Called REACTIVELY, from a transport that just took a 401 — the provider
     * documents no access-token lifetime, so there is nothing to schedule
     * against. The re-seal is the important half: Ubersuggest does not document
     * whether refresh tokens rotate, so a rotated one that is not written back
     * strands the account at the NEXT refresh, days later, with nothing in the
     * logs to connect the two.
     */
    refresh: async () => {
      try {
        const next = await connector.oauth.refreshTokens(tokens);
        tokens = next;
        await ConnectorAccount.updateOne(
          { _id: account._id },
          {
            $set: {
              sealedTokens: connectorCrypto.sealJson(next, ctx),
              scopes: next.scopes || account.scopes || [],
              status: 'active',
            },
          }
        );
        return next;
      } catch (err) {
        if (err.needsReauth) {
          // The refresh grant itself is dead — revoked at the provider, expired,
          // or rotated out from under us. Recording it is what stops the weekly
          // runner retrying a dead account forever, and what puts the Reconnect
          // button in front of an admin.
          await setStatus('needs_reauth');
        }
        throw err;
      }
    },

    /** Mark the account as needing a fresh consent. */
    markNeedsReauth: () => setStatus('needs_reauth'),

    /**
     * Record what the provider says about itself. Display only, and never a
     * gate — a quota number we misread must not be able to stop a sync.
     */
    recordIdentity: async ({ externalEmail, externalAccountId, tier } = {}) => {
      const $set = {};
      if (externalEmail) $set.externalEmail = externalEmail;
      if (externalAccountId) $set.externalAccountId = externalAccountId;
      if (tier) $set.tier = tier;
      if (!Object.keys($set).length) return;
      await ConnectorAccount.updateOne({ _id: account._id }, { $set });
    },
  };

  return session;
};

/**
 * Open a session, run something with it, and translate a dead grant into the
 * status change every caller would otherwise have to remember.
 *
 * @param {string|Object} accountOrId
 * @param {(session: Object, connector: Object) => Promise<any>} fn
 */
const withSession = async (accountOrId, fn) => {
  const session = await openSession(accountOrId);
  const connector = getConnector(session.provider);
  try {
    return await fn(session, connector);
  } catch (err) {
    if (err.needsReauth) await session.markNeedsReauth();
    throw err;
  }
};

module.exports = { openSession, withSession };
