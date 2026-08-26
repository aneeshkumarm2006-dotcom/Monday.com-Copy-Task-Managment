const mongoose = require('mongoose');
const { CONNECTOR_PROVIDERS } = require('../utils/connectorProviders');

/**
 * One in-flight OAuth consent, from "connect an account" to the callback.
 *
 * ---- Why this is a collection and not a Map in memory -----------------------
 *
 * The obvious implementation is a module-scoped Map keyed by `state`. It works
 * on one process and fails the moment there are two: the browser is redirected
 * to whichever instance the load balancer picks, and if that is not the one that
 * generated the verifier, the exchange fails with an error nobody can reproduce
 * locally. A restart mid-consent has the same effect.
 *
 * ---- What it holds and why each part is required ---------------------------
 *
 *   state        — CSRF defence. The MCP SDK explicitly does NOT validate this;
 *                  the callback compares it to the row itself. Unique, so a
 *                  replayed callback cannot match a second time.
 *   codeVerifier — the PKCE secret. Ubersuggest's authorization server is a
 *                  PUBLIC client (`token_endpoint_auth_methods_supported:
 *                  ["none"]`), so there is no client secret and PKCE is the only
 *                  thing binding the redirect to the process that started it.
 *   label        — carried through the round trip because the account row cannot
 *                  be created until the exchange succeeds, and asking the user
 *                  to name the account twice would be absurd.
 *
 * Rows are single-use: the callback deletes on success. `expiresAt` sweeps the
 * abandoned ones, which is most of them — people close the tab.
 */
const connectorAuthAttemptSchema = new mongoose.Schema(
  {
    organisation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organisation',
      required: true,
      index: true,
    },
    provider: {
      type: String,
      enum: CONNECTOR_PROVIDERS,
      required: true,
    },

    // The opaque value round-tripped through the provider. Unique so a replayed
    // callback finds nothing the second time.
    state: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    // PKCE. Not `select: false` — it is useless without the matching `state`,
    // which is already public in a URL bar, and the row is deleted on use.
    codeVerifier: { type: String, required: true },

    // What the account will be called once the exchange succeeds.
    label: { type: String, required: true, trim: true, maxlength: 60 },

    // Echoed back at the token endpoint, which requires the redirect_uri to
    // match the one used at /authorize exactly. Stored rather than recomputed so
    // a config change mid-consent cannot break the exchange.
    redirectUri: { type: String, required: true },

    // Where to send the browser once we are done. Validated on the way in — an
    // unchecked value here is an open redirect.
    returnTo: { type: String, default: null },

    // Set when reconnecting an existing account (status `needs_reauth`) rather
    // than adding a new one, so the callback updates that row instead of
    // creating a duplicate.
    reconnectAccount: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ConnectorAccount',
      default: null,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    // 15 minutes is generous for "click through a consent screen" and short
    // enough that an intercepted state is useless by the time anyone finds it.
    expiresAt: {
      type: Date,
      required: true,
      default: () => new Date(Date.now() + 15 * 60 * 1000),
    },
  },
  { timestamps: true }
);

// Mongo's TTL monitor drops expired rows itself, so nothing needs sweeping them.
connectorAuthAttemptSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('ConnectorAuthAttempt', connectorAuthAttemptSchema);
