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
  /**
   * Registered, connectable, and deliberately unable to collect anything yet —
   * see that directory's header. It is here because the credential seam needs a
   * descriptor that actually reaches the registry: a second authentication mode
   * validated only against a fixture would be a seam nothing runs through.
   */
  dataforseo: require('./dataforseo'),
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
      /**
       * Whether this provider spends money per call, so the settings form knows
       * to offer a monthly cap. A plan-quota provider gets no dollar field,
       * because a dollar ceiling on an allowance would mean nothing.
       */
      metered: !!c.metered,
      /**
       * The credential form to render for a provider that has no consent screen,
       * or null for one that does.
       *
       * Plain data, hand-copied field by field for the same reason
       * `availableKinds` is: a spread would carry whatever a future descriptor
       * happens to hang off `apiKey` into a response, and this response is
       * public to every member of the org. What crosses is a label, a key, a
       * caption and a mask flag — the shape of an empty form, never a value.
       *
       * Nothing here is a secret, and nothing here is executable. The values
       * themselves travel one way only: in through `saveCredentials`, sealed on
       * arrival, and out again never.
       */
      credentialForm: c.apiKey
        ? {
            label: c.apiKey.label,
            help: c.apiKey.help || '',
            fields: c.apiKey.fields.map((f) => ({
              key: f.key,
              label: f.label,
              secret: !!f.secret,
              placeholder: f.placeholder || '',
              help: f.help || '',
            })),
          }
        : null,
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
      /**
       * The DASHBOARD SCREENS this provider declares, or `[]` for one that
       * renders through the generic one-section-per-kind tab.
       *
       * Plain data, hand-copied field by field like `availableKinds` above it
       * and for the same reason. Its presence is what the board page branches on
       * to decide which of the two connector tabs a provider gets — which is
       * also what stopped a board with two connectors enabled from showing only
       * the first one.
       *
       * `kinds` on a screen is a DISPLAY dependency and never a purchase: it
       * says which snapshots the screen draws, so a board whose `kinds` exclude
       * them can be told so honestly instead of being shown an empty page. What
       * is actually collected is `BoardConnector.kinds`, unioned across boards.
       */
      availableScreens: Array.isArray(c.screens)
        ? c.screens.map((s) => ({
            key: s.key,
            label: s.label,
            blurb: s.blurb || '',
            kinds: Array.isArray(s.kinds) ? [...s.kinds] : [],
            alwaysOn: !!s.alwaysOn,
          }))
        : [],

      /**
       * Whether this provider's projects are AUTHORED HERE rather than mirrored
       * from anywhere, and the caps the form must respect.
       *
       * Carried on the catalog so the Add-ons tab can offer "Add a site" without
       * naming a provider, and so the form renders the server's own limits
       * rather than hardcoding numbers that live in the provider's constants.
       * `readForm` is a function and is dropped here by construction — the
       * client must not hold half of a validation the server owns, because two
       * implementations of a rule agree until they quietly do not.
       */
      projectAuthoring: c.projectAuthoring
        ? {
            label: c.projectAuthoring.label || 'Site',
            help: c.projectAuthoring.help || '',
            maxKeywords: c.projectAuthoring.maxKeywords ?? null,
            maxTargets: c.projectAuthoring.maxTargets ?? null,
            maxCompetitors: c.projectAuthoring.maxCompetitors ?? null,
            devices: Array.isArray(c.projectAuthoring.devices)
              ? [...c.projectAuthoring.devices]
              : [],
          }
        : null,

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
 * The API-key half of `validateDescriptor`.
 *
 * A credential form is DATA — a label and a list of fields — because the server
 * seals whatever it is given (`connectorCrypto.sealJson` takes arbitrary JSON)
 * and the client renders whatever it is told. Nothing here is executable and
 * nothing here is provider-shaped, which is what lets one endpoint and one form
 * serve every key-authenticated provider that follows.
 *
 * The four rules, and why each one is a rule rather than a convention:
 *
 *   - a LABEL, because the dialog has to say what the person is pasting.
 *   - at least one FIELD, because a form with none is a button that stores `{}`
 *     and reports success.
 *   - a unique, non-empty `key` per field, because the keys become the property
 *     names of the sealed object. Two fields sharing one silently drops a
 *     credential and the account then fails to authenticate for no visible
 *     reason.
 *   - at least one field marked `secret`, because that is the field the UI masks
 *     and the only one `connectorCrypto.preview` can summarise. A form with no
 *     secret on it is a settings panel, not a credential.
 *
 * And one rule about the failure path: a key-authenticated provider must still
 * declare `refreshTokens`. A 401 on a stored key means the key is WRONG rather
 * than stale, so there is nothing to refresh — but `session.refresh()` is called
 * reactively by transports that take one, and the descriptor is what turns that
 * into `needs_reauth` and a Reconnect button instead of a TypeError inside a
 * cron job nobody is watching.
 *
 * @param {string} name
 * @param {Object} c - the descriptor
 * @returns {string[]}
 */
const validateApiKey = (name, c) => {
  const errors = [];
  const spec = c.apiKey;

  if (typeof spec.label !== 'string' || !spec.label.trim()) {
    errors.push(`connector "${name}" apiKey has no label`);
  }
  if (!Array.isArray(spec.fields) || !spec.fields.length) {
    errors.push(`connector "${name}" apiKey declares no fields`);
  } else {
    const seen = new Set();
    for (const f of spec.fields) {
      if (typeof f?.key !== 'string' || !f.key.trim()) {
        errors.push(`connector "${name}" apiKey has a field with no key`);
        continue;
      }
      if (seen.has(f.key)) {
        errors.push(`connector "${name}" apiKey declares field "${f.key}" twice`);
      }
      seen.add(f.key);
      if (typeof f.label !== 'string' || !f.label.trim()) {
        errors.push(`connector "${name}" apiKey field "${f.key}" has no label`);
      }
    }
    if (!spec.fields.some((f) => f?.secret)) {
      errors.push(`connector "${name}" apiKey marks no field secret`);
    }
  }

  if (c.requiresBrowserConsent) {
    // The flag the UI branches on. A key-authenticated provider that claims to
    // need a browser gets the consent dialog and no key box — a form nobody can
    // ever complete.
    errors.push(
      `connector "${name}" authenticates with a key but claims requiresBrowserConsent`
    );
  }
  if (typeof c.refreshTokens !== 'function') {
    errors.push(
      `connector "${name}" authenticates with a key but declares no refreshTokens()`
    );
  }

  return errors;
};

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

  /**
   * EXACTLY ONE authentication mode.
   *
   * The first provider authenticated with OAuth, so this used to require
   * `oauth.buildAuthorizeUrl` outright — which is a rule about a transport
   * masquerading as a rule about a registry. Plenty of perfectly ordinary APIs
   * issue a key and a password and have no authorization server at all, and a
   * provider like that could be built, registered and then never connected,
   * because the only code path that has ever created a `ConnectorAccount` is the
   * OAuth callback.
   *
   * So: one or the other, and never both. "Both" is not a harmless superset — it
   * would leave the UI with two ways to connect one account and no rule for
   * which one a reconnect should use, and it is the sort of thing that gets
   * added by copying a descriptor and deleting half of it.
   */
  const declaresOauth = c.oauth !== undefined && c.oauth !== null;
  const declaresApiKey = c.apiKey !== undefined && c.apiKey !== null;

  if (declaresOauth && declaresApiKey) {
    errors.push(
      `connector "${name}" declares both oauth and apiKey; exactly one is its authentication mode`
    );
  } else if (declaresApiKey) {
    errors.push(...validateApiKey(name, c));
  } else if (!c.oauth || typeof c.oauth.buildAuthorizeUrl !== 'function') {
    errors.push(`connector "${name}" has no usable oauth.buildAuthorizeUrl`);
  }
  /**
   * A screen catalog is optional — a provider rendering through the generic
   * one-section-per-kind tab declares none — but one that declares it must
   * declare it usably, and the two rules below are both about a failure that is
   * SILENT rather than loud.
   *
   * A duplicate key means `BoardConnector.enabledScreens` cannot distinguish two
   * screens, so switching one off switches both. A screen naming a kind the
   * provider does not collect is worse: it renders a permanently empty panel
   * with no explanation, which is indistinguishable from a broken collection —
   * exactly the failure `fields[i].kind` is already checked for below.
   *
   * `resolveScreens` is required alongside, for the same reason `resolveKinds`
   * is: the caller narrows a board's selection through the descriptor and must
   * not learn that two providers answer it differently.
   */
  if (Array.isArray(c.screens)) {
    const kindKeys = new Set((c.kinds || []).map((k) => k.key));
    const seen = new Set();
    for (const s of c.screens) {
      if (typeof s?.key !== 'string' || !s.key.trim()) {
        errors.push(`connector "${name}" declares a screen with no key`);
        continue;
      }
      if (seen.has(s.key)) {
        errors.push(`connector "${name}" declares screen "${s.key}" twice`);
      }
      seen.add(s.key);
      if (typeof s.label !== 'string' || !s.label.trim()) {
        errors.push(`connector "${name}" screen "${s.key}" has no label`);
      }
      for (const k of s.kinds || []) {
        if (!kindKeys.has(k)) {
          errors.push(
            `connector "${name}" screen "${s.key}" draws kind "${k}", which it does not collect`
          );
        }
      }
    }
    if (typeof c.resolveScreens !== 'function') {
      errors.push(`connector "${name}" declares screens but no resolveScreens()`);
    }
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
