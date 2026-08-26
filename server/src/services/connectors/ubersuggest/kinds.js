/**
 * The snapshot kinds Ubersuggest can produce.
 *
 * ---- Why this is data and not a switch statement ---------------------------
 *
 * Three different things need to agree about what a "kind" is: the runner
 * (which iterates them), `BoardConnector.kinds` (which narrows them per board),
 * and the tab (which renders one section per kind). A switch in the fetcher
 * would leave the other two guessing, so the catalog is a plain array that
 * serialises straight to the client and the fetcher is a lookup against it.
 *
 * `../../index.js` exposes it on the descriptor as `kinds`. Nothing outside this
 * directory imports this file.
 *
 * ---- What `subject` is for --------------------------------------------------
 *
 * Ubersuggest's quota is documented per REPORT SUBJECT — "each distinct report
 * subject (e.g. a keyword or domain you analyze) counts one report per day …
 * repeated calls for the same subject on the same day do not consume extra
 * reports". So the five kinds below are NOT five times the quota of one: the
 * three domain-subject kinds all name the same domain and, on the same day,
 * cost one report between them. That is why the runner batches a project's kinds
 * into a single pass rather than spreading them across the week.
 *
 * It is also load-bearing for correctness. `site_audit` and the domain reports
 * take a DOMAIN and know nothing about projects — none of the four audit tools
 * accepts a project id — so a mirrored project with no domain on it cannot serve
 * them, and `requires: 'domain'` is what lets the runner skip that generically
 * instead of calling and taking a fatal error.
 *
 * ---- Why `positions` is the one with variants -------------------------------
 *
 * `project_position_info` is the only device-aware tool in the entire manifest,
 * and it filters by a (locId, language) pair the project must actually track.
 * Every other tool here takes one subject and nothing else. So positions is the
 * only kind that fans out into several snapshots per project per period, which
 * is why `ConnectorSnapshot` carries a `variant` at all.
 */

/**
 * @typedef {Object} SnapshotKind
 * @property {string} key          - stored on the snapshot row; never renamed casually
 * @property {string} label        - the section heading in the tab
 * @property {string} blurb        - one line, shown under the heading
 * @property {'project'|'domain'} subject - what the provider is asked about
 * @property {string[]} tools      - the MCP tools this kind spends, for the audit trail
 * @property {string|null} requires - a field the project must have for this to be fetchable
 * @property {string[]} dependsOn  - kinds whose result this one reads
 * @property {boolean} manualOnly  - excluded from the unattended weekly run
 */

/** @type {SnapshotKind[]} */
const KINDS = [
  {
    key: 'positions',
    label: 'Rank tracking',
    blurb:
      'Where each tracked keyword ranks, and how that moved. Ubersuggest ' +
      'collects rankings once a week on every plan.',
    subject: 'project',
    tools: ['project_position_info'],
    requires: null,
    dependsOn: [],
    manualOnly: false,
  },
  {
    key: 'keyword_metrics',
    label: 'Keywords',
    blurb: 'Search volume, difficulty, CPC and intent for the tracked keywords.',
    subject: 'project',
    tools: ['match_keywords'],
    requires: null,
    // The tracked keyword list is not separately retrievable without spending
    // another report on `get_project`, and `project_position_info` already
    // returned it. So this kind reads the phrases out of the positions snapshot
    // taken moments earlier in the same run, and is skipped when that failed.
    dependsOn: ['positions'],
    manualOnly: false,
  },
  {
    key: 'site_audit',
    label: 'Site audit',
    blurb: 'Health score, errors, warnings and recommendations from the last crawl.',
    subject: 'domain',
    tools: ['site_audit', 'site_audit_status'],
    requires: 'domain',
    dependsOn: [],
    // The weekly run reads the LAST COMPLETED crawl and never starts one. A
    // crawl is minutes of somebody else's compute and is capped by plan, so
    // starting one unattended every week for every domain is the kind of thing
    // that gets an API key withdrawn. "Run audit" is an explicit button; see
    // `runAudit` in fetchers.js.
    manualOnly: false,
  },
  {
    key: 'domain_overview',
    label: 'Traffic',
    blurb: 'Estimated organic traffic, domain authority and traffic value.',
    subject: 'domain',
    tools: ['domain_overview', 'traffic_value'],
    requires: 'domain',
    dependsOn: [],
    manualOnly: false,
  },
  {
    key: 'backlinks',
    label: 'Backlinks',
    blurb: 'Total backlinks, referring domains and the anchor text mix.',
    subject: 'domain',
    tools: ['backlinks_overview', 'anchor_texts'],
    requires: 'domain',
    dependsOn: [],
    manualOnly: false,
  },
];

const KIND_KEYS = KINDS.map((k) => k.key);
const BY_KEY = new Map(KINDS.map((k) => [k.key, k]));

/** @param {string} key @returns {SnapshotKind|null} */
const getKind = (key) => BY_KEY.get(key) || null;

/** @param {string} key @returns {boolean} */
const isKind = (key) => BY_KEY.has(key);

/**
 * Resolve what a board actually wants, in dependency order.
 *
 * Two things happen here and both matter:
 *
 *   1. AN EMPTY SELECTION MEANS EVERYTHING. `BoardConnector.kinds` defaults to
 *      `[]`, and a board that just switched the connector on has expressed no
 *      opinion — reading that as "fetch nothing" would leave the tab blank with
 *      no error to explain it.
 *
 *   2. DEPENDENCIES ARE PULLED IN, NOT ASSUMED PRESENT. A board that narrowed
 *      to `['keyword_metrics']` still needs `positions` fetched to know which
 *      keywords to ask about. Silently returning an empty result there would be
 *      indistinguishable from a provider failure.
 *
 * The output is ordered so a dependency always precedes its dependant, which is
 * what lets the runner walk the list once and pass results forward.
 *
 * @param {string[]} [selected] - `BoardConnector.kinds`
 * @param {Object} [opts]
 * @param {boolean} [opts.includeManualOnly] - true for an explicit button press
 * @returns {SnapshotKind[]}
 */
const resolveKinds = (selected, { includeManualOnly = false } = {}) => {
  const wanted = new Set(
    Array.isArray(selected) && selected.length
      ? selected.filter(isKind)
      : KIND_KEYS
  );

  // A selection of nothing but unknown keys is a misconfiguration, not a
  // request for silence — fall back to the full set rather than doing nothing.
  if (wanted.size === 0) KIND_KEYS.forEach((k) => wanted.add(k));

  for (const key of [...wanted]) {
    for (const dep of getKind(key).dependsOn) wanted.add(dep);
  }

  return KINDS.filter(
    (k) => wanted.has(k.key) && (includeManualOnly || !k.manualOnly)
  );
};

module.exports = { KINDS, KIND_KEYS, getKind, isKind, resolveKinds };
