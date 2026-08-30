const mongoose = require('mongoose');
const { CONNECTOR_PROVIDERS } = require('../utils/connectorProviders');

/**
 * One connected external account — an Ubersuggest login the org has authorised
 * us to call on its behalf.
 *
 * ORG-SCOPED, NOT BOARD-SCOPED, and deliberately PLURAL. The agency's projects
 * are split across more than one Ubersuggest account (Enterprise caps a single
 * account at 15 domains), so "the connection" was never going to be one row.
 * Every tracker board in the org draws on the same pool, because re-doing an
 * interactive browser consent per board to reach the same 15 projects would be
 * pure friction.
 *
 * ---- Why the tokens live here and not in the Vault -------------------------
 *
 * The board Vault is zero-knowledge by construction: the encryption key is
 * derived in the browser and the server holds only an auth proof. A weekly sync
 * at 04:00 has no browser and nobody to type a passphrase, so a credential the
 * server cannot decrypt is a credential the scheduler cannot use. These are
 * sealed with `utils/connectorCrypto.js` instead — server-readable by design,
 * a deliberately weaker promise, and one that must stay visually distinct from
 * the Vault in the UI so nobody assumes otherwise. See that file's header.
 *
 * ---- Why there is no client_credentials path -------------------------------
 *
 * Ubersuggest's authorization server advertises only `authorization_code` and
 * `refresh_token`. There is no machine-to-machine grant, so every account is
 * onboarded through exactly one interactive consent and then sustained by its
 * refresh token. `status` is what makes that survivable: when a refresh finally
 * fails the account goes to `needs_reauth` and the UI asks for one more consent,
 * rather than every sync erroring forever with nobody looking.
 */

/**
 * What the last sync did. Deliberately records a PARTIAL run rather than
 * collapsing it to a boolean: a week where 3 of 200 subjects failed is a
 * successful sync with 3 gaps, and retrying the 200 would burn quota to fix 3.
 */
const syncReportSchema = new mongoose.Schema(
  {
    at: { type: Date, default: null },
    ok: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    skipped: { type: Number, default: 0 }, // already had a snapshot for the period
    /**
     * Asked for, not yet available — a provider that posts a request and
     * collects the answer later, or one that has hit a spend ceiling.
     *
     * Kept apart from all three above so a pass that did nothing but poll does
     * not read as a dead connector: `ok` would claim a reading landed, `failed`
     * would show an operator a fault that is not one, and `skipped` already
     * means the opposite ("we did not need to ask").
     */
    queued: { type: Number, default: 0 },
    // The first failure's message, for the UI. Full per-item errors live on the
    // snapshot rows, which is where you go to find out which keyword broke.
    error: { type: String, default: '' },
    // Set when the run stopped early because the provider reported its quota
    // exhausted. Distinct from `error` because it is not a fault — it is a
    // signal to stop for the day rather than retry into the wall.
    quotaExhausted: { type: Boolean, default: false },
  },
  { _id: false }
);

const connectorAccountSchema = new mongoose.Schema(
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

    // What a human calls this account — "Main", "Agency 2". Required, because
    // with several accounts in the pool an unlabelled one is unidentifiable in
    // the project picker, and the provider's own email may not be memorable.
    label: {
      type: String,
      required: true,
      trim: true,
      maxlength: 60,
    },

    // Identity as the PROVIDER reports it, for display and for spotting that two
    // rows are the same underlying account. Both nullable: they are filled from
    // the provider's own `auth_status` after the first successful call, not from
    // the consent redirect.
    externalAccountId: { type: String, default: null },
    externalEmail: { type: String, default: null },
    // The plan tier the provider reports. Read-only to us, and worth storing
    // because every quota ceiling depends on it.
    tier: { type: String, default: null },

    /**
     * The OAuth token set, sealed by `connectorCrypto.sealJson` with
     * { orgId, provider } bound as AAD.
     *
     * `select: false` so it can never ride along on an incidental read that then
     * gets JSON-serialised to a client. The sync runner asks for it explicitly.
     * NOTHING may return this field, or anything derived from it, over the API.
     *
     * Stored as the whole token object rather than just the refresh token
     * because the provider does not document its access-token lifetime, its
     * refresh-token lifetime, or whether refresh tokens rotate. Keeping the
     * entire response means a rotated refresh token is persisted rather than
     * silently dropped.
     */
    sealedTokens: { type: String, required: true, select: false },

    // The scopes actually granted, as returned with the token — not the ones we
    // asked for. Ubersuggest adds `profile` to every request, so the two differ.
    scopes: { type: [String], default: [] },

    status: {
      type: String,
      enum: ['active', 'needs_reauth', 'revoked'],
      default: 'active',
      index: true,
    },

    lastSyncAt: { type: Date, default: null },
    lastSyncReport: { type: syncReportSchema, default: () => ({}) },

    /**
     * The provider's own account-level numbers as last observed — reports used
     * today, credits left, plan ceilings.
     *
     * Free-form because the provider does not document this shape, and guessing
     * a schema for an undocumented payload is how you end up silently dropping
     * the one field that mattered. Display only; never a gate.
     */
    lastSeenQuota: { type: mongoose.Schema.Types.Mixed, default: {} },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true }
);

// The pool is listed per org, filtered to what still works.
connectorAccountSchema.index({ organisation: 1, provider: 1, status: 1 });

/**
 * Two rows for the same provider must not share a label within an org, or the
 * project picker shows two identical entries and nobody can tell which holds
 * which projects.
 *
 * Partial rather than plain, so revoked rows do not squat on a name someone
 * wants to reuse when reconnecting.
 */
connectorAccountSchema.index(
  { organisation: 1, provider: 1, label: 1 },
  { unique: true, partialFilterExpression: { status: { $ne: 'revoked' } } }
);

module.exports = mongoose.model('ConnectorAccount', connectorAccountSchema);
