const {
  CONNECTOR_PROVIDERS,
  isConnectorProvider,
} = require('../../utils/connectorProviders');
const { SOURCE_TYPES } = require('./fieldMapping');

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
      /**
       * The snapshot kinds this provider can collect, or `[]` for one that has
       * not reached phase 3. Plain data — the catalog entries carry a key, a
       * label and a blurb and nothing executable, which is what makes them safe
       * to send and what lets the tab render its sections from the server's
       * answer rather than from a hardcoded list that would drift.
       */
      availableKinds: Array.isArray(c.kinds)
        ? c.kinds.map((k) => ({
            key: k.key,
            label: k.label,
            blurb: k.blurb,
            subject: k.subject,
            requires: k.requires || null,
          }))
        : [],
      /** The user-triggered actions, e.g. starting a site-audit crawl. */
      availableActions: Object.values(c.actions || {}).map((a) => ({
        key: a.key,
        label: a.label,
        kind: a.kind,
        requires: a.requires || null,
      })),
      /**
       * The values this provider can produce that a person may bind to a goal
       * column, or `[]` for one that has not reached phase 4.
       *
       * The MINIMAL shape on purpose. Each catalog entry also carries a blurb,
       * a `nullMeans` sentence, and a pure `read` function, and the mapping
       * panel needs all of that — but it asks
       * `GET /boards/:id/connectors/:provider/fields`, which can also resolve
       * the per-target refusals against a board this catalog knows nothing
       * about. This is the descriptive answer to "what can this connector do",
       * carried on every board load, so it stays small.
       *
       * `read` is a function and is dropped here by construction rather than by
       * JSON silently eating it — see `publicField` in ./fieldMapping.js.
       */
      availableFields: Array.isArray(c.fields)
        ? c.fields.map((f) => ({
            key: f.key,
            label: f.label,
            type: f.type,
            kind: f.kind,
            scope: f.scope,
          }))
        : [],
    };
  });

/**
 * Validate ONE descriptor, against the rules the registry cares about.
 *
 * Split out of `checkRegistry` for the sake of the thing it is now also used
 * for: `registrySeam.test.js` runs these same rules over a descriptor that is
 * deliberately NOT registered, which is how "a second provider needs no change
 * on this side" is asserted rather than asserted-in-a-comment. A validator only
 * the shipped providers can reach would pass by construction and prove nothing.
 *
 * @param {string} name - the key it is (or would be) registered under
 * @param {Object|null} descriptor
 * @returns {string[]} the problems, empty when there are none
 */
const validateDescriptor = (name, descriptor) => {
  const errors = [];
  const c = descriptor;

  if (!c) {
    errors.push(`connector "${name}" is declared but has no descriptor`);
    return errors;
  }
  if (c.name !== name) {
    errors.push(`connector "${name}" reports its name as "${c.name}"`);
  }
  if (!c.oauth || typeof c.oauth.buildAuthorizeUrl !== 'function') {
    errors.push(`connector "${name}" has no usable oauth.buildAuthorizeUrl`);
  }
  // A field catalog is optional — a provider may reach phase 3 and stop — but
  // one that declares it must declare it usably. A field whose `kind` is not
  // in the same descriptor's `kinds` would be mappable, savable, and then
  // permanently unfillable, which is the one failure mode the whole
  // configuration-time check exists to prevent.
  if (Array.isArray(c.fields)) {
    const kindKeys = new Set((c.kinds || []).map((k) => k.key));
    const seen = new Set();
    for (const f of c.fields) {
      if (seen.has(f.key)) {
        errors.push(`connector "${name}" declares field "${f.key}" twice`);
      }
      seen.add(f.key);
      if (typeof f.read !== 'function') {
        errors.push(`connector "${name}" field "${f.key}" has no read()`);
      }
      if (!kindKeys.has(f.kind)) {
        errors.push(
          `connector "${name}" field "${f.key}" names kind "${f.kind}", which it does not collect`
        );
      }
      if (!SOURCE_TYPES.includes(f.type)) {
        errors.push(
          `connector "${name}" field "${f.key}" has type "${f.type}", which no goal target can accept`
        );
      }
    }
  }

  return errors;
};

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
    errors.push(...validateDescriptor(name, REGISTRY[name]));
  }
  return { ok: errors.length === 0, errors };
};

module.exports = { getConnector, listConnectors, validateDescriptor, checkRegistry };
