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
     * The WHOLE sealed credential, for a transport that needs more than a bearer
     * token — an HTTP Basic pair, a key plus a customer id, a signing secret.
     *
     * Additive rather than a replacement, and deliberately so: `getAccessToken`
     * has exactly two callers, both of which want precisely one string, and
     * widening them to "here is the credential bag, find what you need" would
     * put credential-shape knowledge back into the transports this file exists
     * to keep it out of.
     *
     * The rule from this file's header is unchanged and applies to both: what
     * comes back goes to a transport and nowhere else. It must never enter a
     * controller, a response body, a log line or an error message, and the
     * session object itself is still never serialised. See connectorLeak.test.js.
     *
     * Returns a shallow COPY, so a transport that mutates what it is handed
     * cannot corrupt the token set this session will re-seal on the next
     * refresh — a bug that would look like a provider revoking a credential.
     */
    getCredentials: () => ({ ...tokens }),

    /**
     * Refresh, persist, and keep going.
     *
     * Called REACTIVELY, from a transport that just took a 401 — the provider
     * documents no access-token lifetime, so there is nothing to schedule
     * against. The re-seal is the important half: Ubersuggest does not document
     * whether refresh tokens rotate, so a rotated one that is not written back
     * strands the account at the NEXT refresh, days later, with nothing in the
     * logs to connect the two.
     *
     * A provider that authenticates with a stored key has no authorization
     * server and therefore no `oauth` object at all — it declares `refreshTokens`
     * directly and that function's job is to THROW `{needsReauth: true}`, because
     * a 401 on a stored key means the key is wrong rather than stale. The catch
     * below is then the whole mechanism: no second branch, no per-provider
     * special case, and the same Reconnect button in front of the same admin.
     */
    refresh: async () => {
      const refreshTokens = connector.oauth?.refreshTokens || connector.refreshTokens;
      if (typeof refreshTokens !== 'function') {
        // A descriptor with no way to recover a credential. Driven to the same
        // place a dead grant goes rather than thrown as a TypeError out of a
        // cron job — the account genuinely does need a human, and that is what
        // `needs_reauth` says.
        const err = new Error(
          `"${account.label}" cannot renew its credential on its own. It needs to be reconnected.`
        );
        err.needsReauth = true;
        await setStatus('needs_reauth');
        throw err;
      }
      try {
        const next = await refreshTokens(tokens);
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

    /**
     * Record the provider's own account-level numbers — credits left, plan
     * ceilings, a live balance, a price book.
     *
     * A sibling of `recordIdentity` rather than part of it, because the two have
     * different lifetimes and different meanings: identity is stable and worth
     * writing once, and this is a reading that is stale the moment it is taken.
     * Keeping them apart is also what lets a transport record a balance on a
     * pass where identity did not change.
     *
     * `ConnectorAccount.lastSeenQuota` is `Mixed` and documented DISPLAY ONLY,
     * NEVER A GATE, and this writer does not change that. A number misread out
     * of an undocumented shape must not be able to stop a sync, and a balance
     * last read six days ago must not be able to authorise one — which is why
     * this returns nothing a caller can branch on and why a failure here is the
     * caller's to shrug at.
     *
     * It lives here rather than in a provider directory for the same reason
     * every other write in this file does: credential and account persistence
     * has exactly one copy.
     *
     * @param {Object} quota - whatever the provider reports, already normalised
     */
    recordQuota: async (quota) => {
      if (!quota || typeof quota !== 'object' || Array.isArray(quota)) return;
      // Kept on the in-memory document too, so `getQuota` below answers with
      // what THIS pass observed rather than with what the last one left behind.
      account.lastSeenQuota = quota;
      await ConnectorAccount.updateOne(
        { _id: account._id },
        { $set: { lastSeenQuota: quota } }
      );
    },

    /**
     * The last quota reading, for a transport that needs to ESTIMATE.
     *
     * ---- Why this is a reader and not a query -------------------------------
     *
     * `syncAccount` loads the `ConnectorAccount` document and hands it to
     * `openSession`, so the reading is already in memory by the time a fetcher
     * runs. A provider that bills per call needs the account's own price book to
     * size a budget reservation, and the two alternatives both cost something for
     * nothing: re-reading the row is a database round trip per post, and asking
     * the provider again burns one of six permitted `user_data` calls a minute
     * for a value the same pass already fetched and stored.
     *
     * A SHALLOW COPY, for the same reason `getCredentials` returns one — a
     * transport that mutates what it is handed must not be able to corrupt what
     * the next caller reads.
     *
     * The documented status of `lastSeenQuota` is unchanged and is the point:
     * ESTIMATION AND DISPLAY, NEVER A GATE. A price book six days old sizes a
     * reservation perfectly well; the thing that says no is `ConnectorBudget`,
     * computed from our own ledger. Nothing that reads this may refuse work on
     * the strength of it.
     */
    getQuota: () => ({ ...(account.lastSeenQuota || {}) }),

    /**
     * The workspace's own monthly spending ceiling for this account, in USD, or
     * `null` for none.
     *
     * UNLIKE `getQuota`, this one IS a gate — it is the number
     * `ConnectorBudget` enforces. It rides on the session rather than being read
     * from the database by the budget module because the account row is already
     * in memory here: a lookup per job would be one query per kind per project
     * per pass for a value that cannot change mid-pass, and it would make the
     * budget module depend on a real `ConnectorAccount` document for what is
     * otherwise pure arithmetic.
     *
     * `null` and `undefined` collapse to null, so an account row written before
     * the field existed reads as unbounded rather than as zero.
     */
    getMonthlyCapUsd: () =>
      Number.isFinite(account.monthlyCapUsd) && account.monthlyCapUsd > 0
        ? account.monthlyCapUsd
        : null,
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
