const { createMcpClient } = require('./mcpClient');

/**
 * `list_projects` and `auth_status`, normalised.
 *
 * ---- Why this file is written defensively ----------------------------------
 *
 * `llms.md` is unusually good documentation right up to the Projects section,
 * where every response table is replaced by one sentence:
 *
 *     "Returns the raw Ubersuggest API payload for this report
 *      (fields defined by the backend)."
 *
 * So the shape of a project is genuinely unknown until an authenticated call
 * returns one, and it can change without a version bump because it is not a
 * documented interface — it is a passthrough of an internal one.
 *
 * Two consequences, and both are deliberate:
 *
 *   1. Every field is read through a list of plausible spellings rather than one
 *      key. The tools that ARE documented use snake_case with `project_id`,
 *      `loc_id`, `lang` and `has_brand`, so those spellings come first, and
 *      camelCase is accepted behind them.
 *
 *   2. THE RAW PAYLOAD IS KEPT, per project, on the mirrored row. That is the
 *      point of doing this phase before phases 3-5: everything downstream is
 *      built on what this returns, so what it actually returned has to be on
 *      record rather than reconstructed from memory months later. A field we
 *      failed to anticipate is then a normaliser change, not a re-sync.
 *
 * Nothing here throws on a shape it does not recognise. A project we cannot name
 * is still a project the user can map, as long as it has an id.
 */

/** Tool names, spelled once. */
const TOOL_LIST_PROJECTS = 'list_projects';
const TOOL_AUTH_STATUS = 'auth_status';

/**
 * Pull the array of projects out of whatever envelope it arrived in.
 *
 * A bare array, `{ projects: [] }`, `{ data: [] }` and `{ results: [] }` are all
 * shapes this backend uses elsewhere in the same document, and picking one would
 * be a coin flip.
 *
 * @param {any} payload
 * @returns {Array<Object>}
 */
const unwrapProjectList = (payload) => {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];

  for (const key of ['projects', 'data', 'results', 'items', 'rows']) {
    const value = payload[key];
    if (Array.isArray(value)) return value;
    // One more level: `{ data: { projects: [] } }` is a shape this API uses.
    if (value && typeof value === 'object') {
      for (const inner of ['projects', 'data', 'results', 'items']) {
        if (Array.isArray(value[inner])) return value[inner];
      }
    }
  }
  return [];
};

/** First non-empty value among several candidate keys. */
const pick = (obj, keys) => {
  for (const key of keys) {
    const value = obj?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
};

/**
 * How many things are in a field that might be an array, a keyed map, or a
 * number that was already counted for us.
 *
 * `create_project` documents `keywords` as "Map of keyword phrase to array of
 * {lang, loc_id}", so the map branch is not hypothetical.
 */
const countOf = (value) => {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return Object.keys(value).length;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
};

/**
 * Normalise the locations a project tracks.
 *
 * Kept because a project tracks its keywords per (language, location) pair and
 * `project_position_info` REQUIRES a matching pair to filter by — so phase 3
 * cannot fetch a ranking without knowing which combinations exist. Storing them
 * now means that phase does not need a second round trip per project to find out.
 */
const normaliseLocations = (value) => {
  const list = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? Object.values(value)
      : [];

  const out = [];
  const seen = new Set();

  for (const entry of list) {
    if (!entry) continue;
    // A bare number or string is a location id on its own.
    if (typeof entry === 'number' || typeof entry === 'string') {
      const key = `${entry}|`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ locId: Number(entry) || null, lang: null, label: String(entry) });
      continue;
    }
    if (typeof entry !== 'object') continue;

    const locId = pick(entry, ['loc_id', 'locId', 'location_id', 'locationId', 'loc']);
    const lang = pick(entry, ['lang', 'language', 'lang_code', 'languageCode']);
    const label = pick(entry, ['label', 'name', 'location', 'title', 'loc_name']);

    const key = `${locId ?? ''}|${lang ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      locId: Number(locId) || null,
      lang: lang ? String(lang) : null,
      label: label ? String(label) : null,
    });
  }

  return out;
};

/**
 * One provider project, in our vocabulary.
 *
 * Returns null for anything with no usable id — a row we cannot address is one
 * we could never fetch for, and mirroring it would put an unmappable entry in
 * the picker.
 *
 * @param {Object} raw
 * @returns {Object|null}
 */
const normaliseProject = (raw) => {
  if (!raw || typeof raw !== 'object') return null;

  const externalId = pick(raw, ['id', 'project_id', 'projectId', '_id', 'uuid']);
  if (externalId === null) return null;

  const domain = pick(raw, ['domain', 'url', 'site', 'website', 'host', 'hostname']);
  const title = pick(raw, ['title', 'name', 'project_name', 'projectName', 'label']);

  return {
    externalId: String(externalId),
    // One Ubersuggest project IS one domain, so the domain is the identity a
    // human recognises. The title defaults to it at the provider too.
    domain: domain ? String(domain) : null,
    name: String(title || domain || externalId),
    keywordCount: countOf(
      pick(raw, ['keywords', 'keyword_count', 'keywordCount', 'total_keywords', 'keywords_count'])
    ),
    competitorCount: countOf(
      pick(raw, ['competitors', 'competitor_count', 'competitorCount', 'competitors_count'])
    ),
    locations: normaliseLocations(pick(raw, ['locations', 'location', 'locs'])),
    // AI Search Visibility is configured per project and the brand_* tools
    // refuse a project without it. Surfacing the flag now saves phase 3 a call
    // that can only fail.
    hasBrand: !!pick(raw, ['has_brand', 'hasBrand']),
    // Everything, verbatim. See this file's header — this is the record that
    // phases 3-5 are built on.
    raw,
  };
};

/**
 * Every project on the connected account.
 *
 * @param {Object} session - from services/connectors/session.js
 * @param {Object} [opts]
 * @param {Function} [opts.clientFactory] - injected by the tests
 * @returns {Promise<{ projects: Array<Object>, raw: any }>}
 */
const listProjects = async (session, { clientFactory = createMcpClient } = {}) => {
  const client = clientFactory(session);
  const { data } = await client.callTool(TOOL_LIST_PROJECTS, {});

  const projects = unwrapProjectList(data)
    .map(normaliseProject)
    .filter(Boolean);

  // De-duplicate by external id. The provider has no documented guarantee of
  // uniqueness here, and a duplicate would collide on our unique index and fail
  // the whole mirror rather than the one row.
  const byId = new Map();
  for (const project of projects) {
    if (!byId.has(project.externalId)) byId.set(project.externalId, project);
  }

  return { projects: [...byId.values()], raw: data };
};

/**
 * Who the provider thinks we are.
 *
 * `auth_status` is documented as returning PLAIN TEXT, not JSON:
 * "Logged in as <email> / Tier: <tier>". So this parses a sentence, which is
 * ugly but is the documented interface. It is also free — it runs no report and
 * spends no quota — which is why the mirror calls it every time and can fill in
 * the `externalEmail` and `tier` that ConnectorAccount has carried as null since
 * phase 1.
 *
 * Never throws on an unrecognised sentence. Not knowing the email is a cosmetic
 * gap; failing a sync over it is not.
 *
 * @param {Object} session
 * @param {Object} [opts]
 * @returns {Promise<{ externalEmail: string|null, tier: string|null, text: string }>}
 */
const describeAccount = async (session, { clientFactory = createMcpClient } = {}) => {
  const client = clientFactory(session);
  const { data, text } = await client.callTool(TOOL_AUTH_STATUS, {});

  // Tolerate a future version that starts returning JSON.
  if (data && typeof data === 'object') {
    return {
      externalEmail: pick(data, ['email', 'user_email', 'userEmail']),
      tier: pick(data, ['tier', 'plan', 'plan_name']),
      text: text || '',
    };
  }

  const sentence = String(data || text || '');
  const email = sentence.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  const tier = sentence.match(/tier\s*:\s*([^/\n\r]+)/i);

  return {
    externalEmail: email ? email[0] : null,
    tier: tier ? tier[1].trim() : null,
    text: sentence,
  };
};

module.exports = {
  listProjects,
  describeAccount,
  // Exported for the tests — the normalisers are the part most likely to meet a
  // shape nobody predicted, so they are tested directly rather than through HTTP.
  unwrapProjectList,
  normaliseProject,
  normaliseLocations,
  countOf,
  TOOL_LIST_PROJECTS,
  TOOL_AUTH_STATUS,
};
