const {
  CONNECTOR_PROVIDERS,
  isConnectorProvider,
} = require('../../utils/connectorProviders');

/**
 * The connector registry — provider name to descriptor.
 *
 * Modelled on `utils/columnTypes.js`: one lookup function, an unknown key
 * returns null rather than throwing, and callers turn that null into their own
 * 400. The point of the shape is that adding a provider touches this file and
 * `utils/connectorProviders.js` and nothing else — no controller branch, no `if
 * (provider === 'ubersuggest')` anywhere.
 *
 * Ubersuggest is the first tenant, not the purpose. The Ads-org boards
 * (Meta/Google/Pinterest) run the same tracker+goals machinery over ad metrics
 * instead of keywords, and they are the reason this is a registry rather than a
 * single hardcoded integration.
 */
const REGISTRY = {
  ubersuggest: require('./ubersuggest'),
};

/**
 * @param {string} name
 * @returns {Object|null} the descriptor, or null for an unknown provider
 */
const getConnector = (name) => {
  if (!isConnectorProvider(name)) return null;
  return REGISTRY[name] || null;
};

/**
 * Every provider, in a shape safe to serialise to a client.
 *
 * Note what is absent: the `oauth` functions and anything else executable. This
 * is the catalog the Add-ons tab renders, so it carries only description.
 *
 * @returns {Array<Object>}
 */
const listConnectors = () =>
  CONNECTOR_PROVIDERS.map((name) => {
    const c = REGISTRY[name];
    return {
      name,
      label: c.label,
      blurb: c.blurb,
      requiresBrowserConsent: !!c.requiresBrowserConsent,
      syncIntervalHours: c.syncIntervalHours,
    };
  });

/**
 * Startup self-check: every declared provider has a descriptor, and every
 * descriptor answers to the name it is registered under.
 *
 * Cheap, and it catches the one mistake this pattern invites — adding a name to
 * `connectorProviders.js` and forgetting the directory, which would otherwise
 * surface as a null descriptor the first time someone clicked Connect.
 *
 * @returns {{ ok: boolean, errors: string[] }}
 */
const checkRegistry = () => {
  const errors = [];
  for (const name of CONNECTOR_PROVIDERS) {
    const c = REGISTRY[name];
    if (!c) {
      errors.push(`connector "${name}" is declared but has no descriptor`);
      continue;
    }
    if (c.name !== name) {
      errors.push(`connector "${name}" reports its name as "${c.name}"`);
    }
    if (!c.oauth || typeof c.oauth.buildAuthorizeUrl !== 'function') {
      errors.push(`connector "${name}" has no usable oauth.buildAuthorizeUrl`);
    }
  }
  return { ok: errors.length === 0, errors };
};

module.exports = { getConnector, listConnectors, checkRegistry };
