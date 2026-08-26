const oauth = require('./oauth');
const constants = require('./constants');
const projects = require('./projects');
const fetchers = require('./fetchers');
const { KINDS, resolveKinds } = require('./kinds');
const { FIELDS, readField } = require('./fields');
const { createMcpClient } = require('./mcpClient');

/**
 * The Ubersuggest provider descriptor.
 *
 * This object is the ONLY thing the rest of the app sees. Nothing outside this
 * directory may import `./oauth`, `./constants`, or name Ubersuggest at all —
 * the registry in `../index.js` hands callers a descriptor and they work through
 * it. That is what makes the second connector a new directory rather than a
 * rewrite of the controller, the runner and the UI.
 *
 * Phase 1 populated the auth half. Phase 2 added the project mirror —
 * `listProjects` and `describeAccount`, both of which take a SESSION rather than
 * raw tokens, so credential handling stays in services/connectors/session.js and
 * out of every provider directory. Phase 3 added the data half: `kinds`, `fetch`,
 * `variantsFor` and `actions`. Phase 4 fills the last one, `fields` — the
 * catalog of values a person may bind to a goal column.
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

  /**
   * Every project on a connected account, normalised.
   *
   * One Ubersuggest project is one DOMAIN — which is why the mapping downstream
   * is project-to-group rather than project-to-board: a tracker board holds many
   * clients, and each client is its own domain and therefore its own project.
   *
   * @param {Object} session - services/connectors/session.js
   * @returns {Promise<{ projects: Array<Object>, raw: any }>}
   */
  listProjects: projects.listProjects,

  /**
   * Who the provider says this account is. Free — it runs no report and spends
   * no quota — so the mirror calls it on every refresh to keep the email and
   * plan tier on ConnectorAccount current.
   */
  describeAccount: projects.describeAccount,

  /**
   * The snapshot kinds this provider can produce — see kinds.js.
   *
   * Plain data, safe to serialise: the tab renders one section per entry and
   * `BoardConnector.kinds` narrows against these keys. Nothing executable.
   */
  kinds: KINDS,

  /**
   * Turn a board's `BoardConnector.kinds` selection into the kind descriptors to
   * actually run, in dependency order.
   *
   * On the descriptor rather than in the runner because the RULES are the
   * provider's: an empty selection meaning "everything", a kind that needs
   * another kind's result, a kind an unattended run must never start. A generic
   * runner that tried to encode those would be encoding this provider's.
   */
  resolveKinds,

  /**
   * Fetch one kind, for one project, for one variant. The generic
   * `services/connectors/snapshotService.js` calls this and knows nothing about
   * which tools it spends.
   */
  fetch: fetchers.fetchKind,

  /**
   * How a kind fans out for a given project.
   *
   * Only rank tracking does: `project_position_info` is the sole device-aware
   * tool in the manifest and filters by a (locId, language) pair the project
   * must actually track. Everything else has exactly one variant. The runner
   * asks rather than assuming, so a provider whose every kind fans out needs no
   * change on the generic side.
   */
  variantsFor: fetchers.variantsFor,

  /**
   * One MCP client per account, so the handshake happens once per run rather
   * than once per tool call. Optional on the descriptor — a provider whose
   * transport is stateless per call simply omits it.
   */
  createClient: (session) => createMcpClient(session),

  /**
   * The things a PERSON presses, as opposed to the things a schedule does.
   *
   * A map rather than a hardcoded endpoint, so the controller can stay generic:
   * it looks the action up here, checks `requires` against the project, runs it,
   * and stores the result as a snapshot of the declared `kind`. Today there is
   * one — starting a site-audit crawl, which is deliberately not something the
   * unattended weekly run ever does.
   */
  actions: fetchers.ACTIONS,

  /**
   * Every value this provider can produce that a person may bind to somewhere
   * on a goal — see fields.js.
   *
   * Plain data plus one pure `read` per entry, and it is the seam that keeps the
   * feature configurable: the binding between "search volume" and a column lives
   * in a `ConnectorFieldMapping` row, not in a writeback that names both sides.
   * The three SEO boards in this workspace already use disjoint column ids and
   * disagree about the spelling of the difficulty key, so a hardcoded binding
   * would fill one board and silently skip two.
   *
   * `services/connectors/fieldMapping.js` is the generic half — what a goal can
   * hold, and which source type may be written into which column type.
   */
  fields: FIELDS,

  /**
   * Pull one field's value out of a snapshot body. Pure.
   *
   * On the descriptor so the phase-5 writeback can stay generic: it reads a
   * mapping row, opens the snapshot of the field's `kind`, and asks the provider
   * to extract it. Nothing outside this directory knows what a rank looks like.
   */
  readField,
};

module.exports = descriptor;
