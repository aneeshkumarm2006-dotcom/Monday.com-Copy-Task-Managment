const oauth = require('./oauth');
const constants = require('./constants');

/**
 * The Ubersuggest provider descriptor.
 *
 * This object is the ONLY thing the rest of the app sees. Nothing outside this
 * directory may import `./oauth`, `./constants`, or name Ubersuggest at all —
 * the registry in `../index.js` hands callers a descriptor and they work through
 * it. That is what makes the second connector a new directory rather than a
 * rewrite of the controller, the runner and the UI.
 *
 * Phase 1 populates the auth half only. `kinds`, `fields`, `listProjects` and
 * `fetch` arrive with the MCP client in phase 2-3; they are declared here as
 * null so the shape of the contract is visible from the start and a half-built
 * provider fails loudly rather than silently doing nothing.
 */
const descriptor = {
  name: 'ubersuggest',
  label: 'Ubersuggest',

  /**
   * One-line description for the Add-ons catalog. Deliberately mentions what it
   * cannot do: rank data at Ubersuggest only moves once a week on every plan
   * (daily updates were withdrawn in December 2025), so a user expecting
   * same-day movement should learn that here rather than from a support ticket.
   */
  blurb:
    'Pull rank tracking, keyword metrics, site audits, backlinks and traffic ' +
    'from your Ubersuggest projects. Rankings at Ubersuggest update weekly.',

  /** Everything we ask consent for. See constants.js for why it is all of it. */
  scopes: constants.SCOPES,

  /**
   * Ubersuggest issues no client_credentials grant, so an account cannot be
   * onboarded head­lessly. The UI reads this to explain that a browser step is
   * unavoidable rather than presenting an API-key box that could never work.
   */
  requiresBrowserConsent: true,

  /**
   * How often the runner should poll, in hours. 168 = weekly, matched to the
   * provider's own collection cadence. Polling faster returns byte-identical
   * data and spends quota to do it.
   */
  syncIntervalHours: 168,

  oauth: {
    buildAuthorizeUrl: oauth.buildAuthorizeUrl,
    exchangeCode: oauth.exchangeCode,
    refreshTokens: oauth.refreshTokens,
    isAccessTokenFresh: oauth.isAccessTokenFresh,
    createPkcePair: oauth.createPkcePair,
    createState: oauth.createState,
  },

  // ---- Arriving in later phases -------------------------------------------
  // Declared, not omitted, so the contract is legible and a caller that reaches
  // for one before it exists gets a clear TypeError instead of `undefined`.
  kinds: null, // phase 3 — the snapshot kinds this provider can fetch
  fields: null, // phase 4 — the mappable field catalog (fields.js)
  listProjects: null, // phase 2 — needs the MCP client
  fetch: null, // phase 3
};

module.exports = descriptor;
