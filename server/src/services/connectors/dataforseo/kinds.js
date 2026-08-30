const C = require('./constants');

/**
 * The snapshot kinds DataForSEO can produce, as DATA.
 *
 * Three different things have to agree about what a kind is — the runner (which
 * iterates them), `BoardConnector.kinds` (which narrows them per board), and the
 * tab (which renders a section per kind) — so the catalog is a plain array that
 * serialises straight to the client, and the fetcher is a lookup against it
 * rather than a switch. Same shape as `ubersuggest/kinds.js`; nothing outside
 * this directory imports either.
 *
 * ---- Why rank tracking is TWO kinds and not one ----------------------------
 *
 * `depth` is a x1 multiplier per ten results, so a `depth: 100` SERP costs ten
 * times a `depth: 10` one. That single number decides what the product can say:
 *
 *   at depth 100 you get the competitor-as-column matrix, the full SERP-feature
 *   census, and cannibalization detection for free — but daily is $900/mo at 25
 *   clients x 200 keywords;
 *   at depth 10 you get rank and the top-ten set for $90/mo daily — but the
 *   competitive picture is gone.
 *
 * The settled answer is HYBRID, and a hybrid is not expressible as one kind with
 * one cadence. `positions` is the weekly census; `movement` is the daily check.
 * They are separate rows in `ConnectorSnapshot`, separate `DfsTask` jobs, and
 * separate lines on `BoardConnector.kinds`, so a frugal board can switch the
 * daily one off and keep the weekly one.
 *
 * ---- Why the deep one is named `positions` ---------------------------------
 *
 * Because `kind === 'positions'` is hardcoded in five places written for the
 * first provider (`connectorDataController` x4, `connectorGoalWriteback`,
 * `connectorLinkController`), and the rank kind of a second provider having the
 * same name makes all of them correct for free. It is also just the right
 * English. The ticket that is owed: `connectorGoalWriteback` resolves variants
 * by that name, so a THIRD provider spelling its markets differently would mix
 * markets silently.
 *
 * ---- The trap on `requires` ------------------------------------------------
 *
 * `planProjectWork` gates a kind on `project[kind.requires]` being truthy, and
 * AN EMPTY ARRAY IS TRUTHY. `requires: 'trackedKeywords'` therefore skips a
 * project whose field is absent and does NOT skip one whose list is empty. The
 * fetcher checks the length itself and answers `pending` with a note — see
 * `fetchers.js`. Recorded here so nobody adds a kind and assumes the gate covers
 * it.
 *
 * ---- Why every kind also carries a FLOOR under its cadence -----------------
 *
 * `intervalHours` is what the planner uses, and a board may now override it:
 * `BoardConnector.intervalHours` is resolved as a MIN across every board mapping
 * the project (`scheduleForProvider`). So one board typing `1` into a cadence
 * box makes `planProjectWork` plan a `depth: 100` census EVERY HOUR — on a
 * provider that bills at post, for every keyword, in every market. Nothing
 * upstream of the fetcher can refuse that: the planner does not know what a call
 * costs, and the budget cap stops it only after the money has started moving.
 *
 * `minRebuyHours` is the provider's own answer, checked inside the fetcher
 * against the `existing` snapshot the planner now hands down. It is deliberately
 * BELOW the cadence rather than equal to it, because `fetchedAt` on a snapshot
 * is when the poll that COLLECTED it ran — minutes to hours after the post — so
 * a floor equal to the cadence would refuse the normal weekly buy and walk the
 * collection an hour later every week until it wrapped.
 */

/**
 * @typedef {Object} SnapshotKind
 * @property {string} key            - stored on the snapshot row; never renamed casually
 * @property {string} label          - the section heading in the tab
 * @property {string} blurb          - one line, shown under the heading
 * @property {'project'|'domain'} subject
 * @property {'task'|'live'} transport - queued-and-collected, or bought in one call
 * @property {'serp'|'labs'|'backlinks'|'onpage'|'business'} family - which of DataForSEO's APIs, and
 *   therefore which module builds and reads the request. `transport` says HOW it
 *   is bought; this says WHO buys it.
 * @property {string} [postEndpoint] - `task` only: the path that COSTS MONEY
 * @property {string} [getEndpoint]  - `task` only: the free collection path
 * @property {string} [endpoint]     - `live` only: the one path, billed on the way
 * @property {number} [depth]        - SERP results bought per keyword. x1 per ten.
 * @property {'target'|'market'|'domain'} [variantScope] - what a variant means
 * @property {boolean} [clickstream] - opts INTO the x2 `include_clickstream_data`
 * @property {number} intervalHours  - this kind's own cadence, overriding the descriptor's
 * @property {number} [expiryHours]  - how long an open job may live before it is
 *   abandoned. Defaults to `C.TASK_EXPIRY_HOURS`; a CRAWL needs longer.
 * @property {number} minRebuyHours  - the PROVIDER'S floor under that cadence
 * @property {string|null} requires  - a project field that must be present
 * @property {string[]} dependsOn    - kinds whose result this one reads
 * @property {boolean} manualOnly    - excluded from the unattended run
 */

/**
 * ---- Why some kinds are `task` and some are `live` -------------------------
 *
 * Because DataForSEO's own APIs are two different shapes and pretending
 * otherwise costs money in one direction and latency in the other.
 *
 * The SERP family is a QUEUE. `task_post` charges, the result arrives minutes
 * later, and `task_get` collects it for free — which is what turns an hourly
 * cron from 168 charges a week into one charge and 167 free polls. All of
 * `tasks.js`, `ready.js` and `collect.js` exist for that gap.
 *
 * DATAFORSEO LABS HAS NO QUEUE ANYWHERE. There is no `task_post` and no
 * `task_get`: one HTTP call goes out, the answer comes back inside it, and the
 * charge lands on the way. The `DfsTask` row is still written — it is the claim
 * that stops two processes making the same billable call, and it is where the
 * reservation is recorded — but it opens and closes inside one function, and
 * `collect.js` skips it because there is nothing to come back for.
 *
 * `transport` is what the collector, the fetcher and the usage ledger all branch
 * on, so a phase-7 Backlinks kind (also live-only) declares `'live'` and needs
 * no new machinery at all.
 *
 * ---- And why every Labs kind is `variantScope: 'market'` -------------------
 *
 * A SERP variant is `(location, language, DEVICE)`, because a desktop ranking
 * and a mobile ranking for one keyword are two different measurements.
 *
 * LABS HAS NO DEVICE PARAMETER. `keyword_overview`, `competitors_domain`,
 * `domain_intersection` and `relevant_pages` take a location and a language and
 * nothing else. So a Site tracking desktop AND mobile in the United States would
 * otherwise fan out to two identical Labs calls, buy the same rows twice, and
 * store them as two snapshots that can never disagree — a doubled bill for a
 * distinction the endpoint does not make. `sites.variantsFor` collapses the
 * device for these kinds; see the note there.
 *
 * ---- And why every Backlinks kind is `variantScope: 'domain'` --------------
 *
 * Phase 7 needed a THIRD value, and the reason is the same argument one step
 * further: the Backlinks API takes no location, no language and no device at
 * all. A backlink profile is a property of a domain, full stop — there is no
 * such thing as its US-desktop profile.
 *
 * `market` would have been the near miss and it would have cost real money. A
 * Site tracking two countries collapses to two market variants, so a
 * market-scoped Backlinks kind buys the SAME profile twice a week, every week,
 * for a distinction the endpoint does not make — and stores it as two snapshots
 * that can never disagree, which is the tell that nobody would notice because
 * agreement looks like correctness. A Site with four targets buys it four times.
 *
 * So `domain` collapses to exactly ONE variant per Site regardless of targets,
 * and `sameVariant` answers true for it unconditionally, because there is only
 * one thing it could be answering about.
 */

/** @type {SnapshotKind[]} */
const KINDS = [
  {
    key: 'positions',
    label: 'Rank tracking',
    blurb:
      'Where each tracked keyword ranks, who else is on the page, and which ' +
      'SERP features are there. Collected weekly to the first hundred results.',
    subject: 'project',
    transport: 'task',
    family: 'serp',
    variantScope: 'target',
    postEndpoint: C.ENDPOINT_SERP_TASK_POST,
    getEndpoint: C.ENDPOINT_SERP_TASK_GET,
    depth: C.DEPTH_CENSUS,
    intervalHours: 168,
    /**
     * Six days. A weekly census whose collection lands an hour after its post
     * must still be re-buyable on the seventh day, so the floor sits a day
     * under the cadence rather than on it.
     */
    minRebuyHours: 144,
    requires: 'trackedKeywords',
    dependsOn: [],
    manualOnly: false,
  },
  {
    key: 'movement',
    label: 'Daily movement',
    blurb:
      'A shallow daily check of the same keywords, for the movement chart. ' +
      'Top ten only — the competitive picture comes from the weekly census.',
    subject: 'project',
    transport: 'task',
    family: 'serp',
    variantScope: 'target',
    postEndpoint: C.ENDPOINT_SERP_TASK_POST,
    getEndpoint: C.ENDPOINT_SERP_TASK_GET,
    depth: C.DEPTH_MOVEMENT,
    intervalHours: 24,
    /** Twenty hours, for the same reason and against a daily clock. */
    minRebuyHours: 20,
    requires: 'trackedKeywords',
    /**
     * Deliberately NOT `dependsOn: ['positions']`.
     *
     * It reads the same keyword list off the same project row, so a dependency
     * would buy nothing and cost everything: `syncProject` skips a dependant
     * whose dependency produced nothing, and `positions` produces nothing on
     * every hour of the six days a week it is not due. The daily chart would go
     * blank for six days out of seven.
     */
    dependsOn: [],
    manualOnly: false,
  },

  // -------------------------------------------------------------------------
  // Phase 6 — the Labs pack. Live-only, market-scoped, competitive index.
  // -------------------------------------------------------------------------

  {
    key: 'keyword_metrics',
    label: 'Keyword research',
    blurb:
      'Volume, difficulty, CPC, intent and twelve months of seasonality for ' +
      'every tracked keyword — from the competitive index, not from a live SERP.',
    subject: 'project',
    transport: 'live',
    family: 'labs',
    variantScope: 'market',
    endpoint: C.ENDPOINT_LABS_KEYWORD_OVERVIEW,
    /**
     * OFF, and the flag exists so that "off" is a decision rather than an
     * absence. `include_clickstream_data: true` doubles the price of the whole
     * request on ~15 Labs endpoints and changes nothing visible about the
     * response. `labs.guardClickstream` refuses a payload carrying it unless the
     * kind says so here, and the estimate doubles when it does.
     */
    clickstream: false,
    /**
     * MONTHLY, and the number is the honest one rather than the cheap one.
     *
     * DataForSEO's own docs put the Labs index at somewhere between weekly and
     * ninety days old, and search volume is a twelve-month rolling average that
     * cannot move meaningfully inside a week. Collecting this weekly would buy
     * four copies a month of a number that changes once — at $0.036 per 200
     * keywords per market, which is small money spent on nothing.
     */
    intervalHours: 720,
    /** Twenty-five days, under a thirty-day cadence. Same reasoning as above. */
    minRebuyHours: 600,
    requires: 'trackedKeywords',
    dependsOn: [],
    manualOnly: false,
  },
  {
    key: 'competitors',
    label: 'Competitors',
    blurb:
      'The domains that own the same SERPs as this site, with what they rank ' +
      'for overall beside what they share with us.',
    subject: 'domain',
    transport: 'live',
    family: 'labs',
    variantScope: 'market',
    endpoint: C.ENDPOINT_LABS_COMPETITORS_DOMAIN,
    clickstream: false,
    intervalHours: 168,
    minRebuyHours: 144,
    /**
     * Deliberately NULL. This one needs only the Site's domain, which
     * `readSiteForm` already requires, so there is nothing for
     * `planProjectWork`'s gate to check — and a gate on a field that is always
     * present is a gate that teaches the next person it does something.
     */
    requires: null,
    dependsOn: [],
    manualOnly: false,
  },
  {
    key: 'keyword_gap',
    label: 'Keyword gap',
    blurb:
      'Keywords each tracked competitor ranks for and this site does not, ' +
      'ordered by the search volume at stake.',
    subject: 'project',
    transport: 'live',
    family: 'labs',
    variantScope: 'market',
    endpoint: C.ENDPOINT_LABS_DOMAIN_INTERSECTION,
    clickstream: false,
    intervalHours: 168,
    minRebuyHours: 144,
    /**
     * THE EMPTY-ARRAY TRAP APPLIES HERE, and this is the second kind to hit it.
     *
     * `planProjectWork` skips a kind when `project[kind.requires]` is falsy, and
     * an EMPTY ARRAY IS TRUTHY. So a Site whose `competitors` field is absent is
     * skipped and one whose list is empty sails straight through to a
     * `domain_intersection` call with no `target1`. `labs.gapCompetitors` checks
     * the length itself and answers `pending` with a note, exactly as
     * `fetchers.keywordsFor` does for `trackedKeywords`.
     */
    requires: 'competitors',
    dependsOn: [],
    manualOnly: false,
  },
  {
    key: 'top_pages',
    label: 'Top pages',
    blurb:
      "This site's own URLs ranked by estimated traffic value, with the " +
      'position profile of each one.',
    subject: 'domain',
    transport: 'live',
    family: 'labs',
    variantScope: 'market',
    endpoint: C.ENDPOINT_LABS_RELEVANT_PAGES,
    clickstream: false,
    intervalHours: 168,
    minRebuyHours: 144,
    requires: null,
    dependsOn: [],
    manualOnly: false,
  },

  // -------------------------------------------------------------------------
  // Phase 7 — Backlinks. Live-only, DOMAIN-scoped, and genuinely live.
  //
  // Four kinds rather than one, and the split is by WHAT IS DRAWN rather than
  // by how much is fetched — because on this API the number of CALLS is the
  // bill. Backlinks charges $0.024 a request and $0.000036 a row against a
  // thousand-row ceiling, so the whole of a maximum row charge is $0.036 beside
  // a $0.024 request: halving a limit saves fractions of a cent, and dropping a
  // call saves two thirds of one. Labs is the opposite shape, which is why its
  // kinds are split the other way.
  //
  // The consequence a board sees: switching off `anchors` or `referring_domains`
  // saves real money, and switching off half of the hero would not, so the hero
  // is one kind carrying three calls.
  // -------------------------------------------------------------------------

  {
    key: 'backlinks_summary',
    label: 'Backlink profile',
    blurb:
      'The whole link profile in one reading — rank, backlinks, referring ' +
      'domains, dofollow, spam score and what is broken. Read live.',
    subject: 'domain',
    transport: 'live',
    family: 'backlinks',
    variantScope: 'domain',
    /**
     * The endpoint the `DfsTask` row is FILED under, out of the three this kind
     * calls. `summary` is the one that would be re-bought if a claim were lost,
     * and it is the one whose name in a ledger tells an operator what the row
     * was for.
     */
    endpoint: C.ENDPOINT_BACKLINKS_SUMMARY,
    intervalHours: 168,
    minRebuyHours: 144,
    /**
     * Deliberately NULL. It needs the Site's domain, which `readSiteForm`
     * already requires — and a gate on a field that is always present is a gate
     * that teaches the next person it does something.
     */
    requires: null,
    dependsOn: [],
    manualOnly: false,
  },
  {
    key: 'backlinks_timeseries',
    label: 'Link growth',
    blurb:
      'Two years of the profile month by month, with the links that arrived ' +
      'and the links that were lost in each one.',
    subject: 'domain',
    transport: 'live',
    family: 'backlinks',
    variantScope: 'domain',
    endpoint: C.ENDPOINT_BACKLINKS_TIMESERIES,
    intervalHours: 168,
    minRebuyHours: 144,
    requires: null,
    dependsOn: [],
    manualOnly: false,
  },
  {
    key: 'referring_domains',
    label: 'Referring domains',
    blurb:
      'The domains linking to this site, ordered by the strength of the links ' +
      'they send it, with what is broken and how spammy each one looks.',
    subject: 'domain',
    transport: 'live',
    family: 'backlinks',
    variantScope: 'domain',
    endpoint: C.ENDPOINT_BACKLINKS_REFERRING_DOMAINS,
    intervalHours: 168,
    minRebuyHours: 144,
    requires: null,
    dependsOn: [],
    manualOnly: false,
  },
  {
    key: 'anchors',
    label: 'Anchor text',
    blurb:
      'The text people link with, weighted by how many different root domains ' +
      'chose each phrase rather than by how many links repeat it.',
    subject: 'domain',
    transport: 'live',
    family: 'backlinks',
    variantScope: 'domain',
    endpoint: C.ENDPOINT_BACKLINKS_ANCHORS,
    intervalHours: 168,
    minRebuyHours: 144,
    requires: null,
    dependsOn: [],
    manualOnly: false,
  },

  {
    /**
     * Phase 10, and phase 7 deferred it by name.
     *
     * The same referring-domain corpus grouped by IP SUBNET rather than by
     * hostname — the private-blog-network signature that per-link spam scoring
     * structurally cannot see, because forty individually clean-looking sites on
     * one /24 carry forty clean spam scores.
     *
     * A SEPARATE KIND rather than a second call on `referring_domains`, and the
     * reason is phase 7's own economics inverted onto a switch: Backlinks bills
     * per REQUEST, so this call is two thirds of its own price and a board that
     * never opens the toxic screen saves real money by switching it off. Folded
     * into the referring-domains kind it would be unswitchable.
     */
    key: 'referring_networks',
    label: 'Referring networks',
    blurb:
      'The IP subnets our backlinks come from, so a block carrying twenty of ' +
      'them is visible as one thing rather than as twenty clean domains.',
    subject: 'domain',
    transport: 'live',
    family: 'backlinks',
    variantScope: 'domain',
    endpoint: C.ENDPOINT_BACKLINKS_REFERRING_NETWORKS,
    intervalHours: 168,
    minRebuyHours: 144,
    requires: null,
    dependsOn: [],
    manualOnly: false,
  },

  // -------------------------------------------------------------------------
  // Phase 10 - Business Data. A FOURTH family, and the first kind here that is
  // not about a website at all.
  //
  // It is `transport: 'live'` and runs on `liveJob.runLiveJob` unchanged, so
  // the family adds one entry to `LIVE_RUNNERS` and nothing else. What is new is
  // the SUBJECT: a Google Business Profile is a place, identified by a name in a
  // market, and it has reviews and photos and opening hours and no URL that has
  // to be involved.
  // -------------------------------------------------------------------------

  {
    key: 'business_profile',
    label: 'Business profile',
    blurb:
      "The Google Business Profile behind this site — the star breakdown " +
      'rather than the average, the themes Google mined out of the reviews, and ' +
      'the businesses Google puts beside it.',
    subject: 'project',
    transport: 'live',
    family: 'business',
    /**
     * MARKET, and it is checked rather than copied.
     *
     * `my_business_info` takes a `location_code` and a `language_code` and no
     * device — the same shape as Labs, and for the same reason: there is no
     * desktop version of a shop's opening hours. `domain` would have been the
     * wrong reuse in the other direction, because a chain genuinely does have a
     * different listing in every city and collapsing to one variant would store
     * whichever one happened to be collected last.
     */
    variantScope: 'market',
    endpoint: C.ENDPOINT_BUSINESS_MY_BUSINESS_INFO,
    intervalHours: 168,
    minRebuyHours: 144,
    /**
     * THE ONE `requires` IN THIS CATALOG THAT ACTUALLY GATES SOMETHING.
     *
     * `planProjectWork` skips a kind when `project[kind.requires]` is falsy, and
     * this file records twice that AN EMPTY ARRAY IS TRUTHY — which is why
     * `requires: 'trackedKeywords'` has never protected anything and why the
     * fetchers check lengths themselves. `businessName` is a STRING and an empty
     * string is falsy, so this gate does what a reader assumes it does.
     *
     * And it needs to. `BoardConnector.kinds` is unioned across every board
     * mapping a project and an empty selection means EVERYTHING, so a billable
     * kind with no gate starts buying for every Site the day it ships. A Maps
     * lookup against a business nobody has named returns an empty card at full
     * price, weekly, forever.
     */
    requires: 'businessName',
    dependsOn: [],
    manualOnly: false,
  },

  // -------------------------------------------------------------------------
  // Phase 8 - Site audit. A QUEUED kind again, in a third family.
  //
  // ONE kind, and that is the whole design decision. Backlinks is four kinds
  // because on that API the CALLS are the bill, so switching one off saves
  // money. Here the CRAWL is the entire bill and every result endpoint is free
  // with thirty-day retention - so a second kind would buy a second crawl of the
  // same site in order to draw a second panel. Splitting this would cost money
  // and buy nothing.
  //
  // And it is `transport: 'task'`, unlike the eight kinds above it, because
  // OnPage really is the SERP family's shape: `task_post` charges, the answer
  // arrives minutes or hours later, and collecting it costs nothing. That is
  // what `tasks.js` / `ready.js` / `collect.js` exist for. `family: 'onpage'` is
  // what routes it away from the SERP builders, which would chunk a keyword list
  // it does not have and normalise a crawl summary as a SERP.
  // -------------------------------------------------------------------------

  {
    key: 'site_audit',
    label: 'Site audit',
    blurb:
      'A crawl of the site, with every technical issue counted against the ' +
      'pages it affects and DataForSEO\u2019s own health score.',
    subject: 'domain',
    transport: 'task',
    family: 'onpage',
    /**
     * DOMAIN, for the reason the Backlinks kinds are: a crawl takes no location,
     * no language and no device. There is no US-desktop version of a website's
     * HTML. Scoped to `market`, a Site tracking two countries would buy the same
     * crawl twice a month and store it as two snapshots that can never disagree.
     *
     * The thing to check before assuming it, which phase 7 asked to be checked:
     * the crawl payload carries no locale and no `browser_preset`. If either is
     * ever added, this is target-shaped again and this line has to move with it.
     */
    variantScope: 'domain',
    postEndpoint: C.ENDPOINT_ONPAGE_TASK_POST,
    getEndpoint: C.ENDPOINT_ONPAGE_SUMMARY,
    /**
     * MONTHLY. A technical audit is a piece of work somebody acts on, and the
     * acting takes weeks; a weekly crawl would buy four readings a month of a
     * site that changed once, and pin four different `onpage_score`s to a chart
     * whose movement is mostly crawl noise.
     */
    intervalHours: 720,
    /** Twenty-five days, under a thirty-day cadence. */
    minRebuyHours: 600,
    /**
     * THREE TIMES the SERP expiry, and the difference is the point. A SERP task
     * answers in about five minutes; a crawl is a robot walking a thousand pages
     * of somebody else's website at their rate limit. Expiring at twelve hours
     * would abandon a crawl that was still running and buy a second one.
     */
    expiryHours: C.ONPAGE_EXPIRY_HOURS,
    /**
     * NULL. It needs the Site's domain, which `readSiteForm` already requires -
     * and a gate on a field that is always present is a gate that teaches the
     * next person it does something.
     */
    requires: null,
    dependsOn: [],
    manualOnly: false,
  },
];

const KIND_KEYS = KINDS.map((k) => k.key);

/** The kinds that are queued and collected later, rather than bought in one call. */
const isTaskKind = (kind) => (kind?.transport || 'task') === 'task';

/**
 * Which of DataForSEO's APIs a kind belongs to.
 *
 * Defaulted to `serp` for a row written before the field existed, which is the
 * only shape a legacy kind could have had.
 */
const familyOf = (kind) => kind?.family || 'serp';
const BY_KEY = new Map(KINDS.map((k) => [k.key, k]));

/** @param {string} key @returns {SnapshotKind|null} */
const getKind = (key) => BY_KEY.get(key) || null;

/** @param {string} key @returns {boolean} */
const isKind = (key) => BY_KEY.has(key);

/**
 * Resolve what a board actually wants, in dependency order.
 *
 * Identical contract to the first provider's, and deliberately so — the runner
 * calls `connector.resolveKinds(BoardConnector.kinds)` and must not learn that
 * two providers answer it differently.
 *
 *   AN EMPTY SELECTION MEANS EVERYTHING. `BoardConnector.kinds` defaults to `[]`
 *   and a board that just switched the connector on has expressed no opinion;
 *   reading that as "collect nothing" leaves the tab blank with no error to
 *   explain it.
 *
 *   DEPENDENCIES ARE PULLED IN. Nothing here declares one today, and the loop
 *   stays because the day something does, a board that narrowed to the dependant
 *   would otherwise get silence indistinguishable from a provider failure.
 *
 * @param {string[]} [selected]
 * @param {Object} [opts]
 * @param {boolean} [opts.includeManualOnly]
 * @returns {SnapshotKind[]}
 */
const resolveKinds = (selected, { includeManualOnly = false } = {}) => {
  const wanted = new Set(
    Array.isArray(selected) && selected.length ? selected.filter(isKind) : KIND_KEYS
  );

  // A selection of nothing but unknown keys is a misconfiguration, not a request
  // for silence.
  if (wanted.size === 0) KIND_KEYS.forEach((k) => wanted.add(k));

  for (const key of [...wanted]) {
    for (const dep of getKind(key).dependsOn) wanted.add(dep);
  }

  return KINDS.filter((k) => wanted.has(k.key) && (includeManualOnly || !k.manualOnly));
};

module.exports = {
  KINDS,
  KIND_KEYS,
  getKind,
  isKind,
  isTaskKind,
  familyOf,
  resolveKinds,
};
