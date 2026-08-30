const sites = require('./sites');
const { createDfsClient, describeAccount, verifyCredentials } = require('./client');
const { KINDS, resolveKinds } = require('./kinds');
const { SCREENS, resolveScreens } = require('./screens');
const { describeUsage } = require('./usage');
const { FIELDS, readField } = require('./fields');
const { comparability } = require('./comparability');
const { RULES: ALERT_RULES, evaluateAll: evaluateAlerts } = require('./alerts');
const { fetchKind, queuedCount } = require('./fetchers');
const { collectAllReady } = require('./collect');
const { reconcileReservations } = require('./budget');
const C = require('./constants');

/**
 * The DataForSEO provider descriptor.
 *
 * ---- Where this is, and what it still cannot do ----------------------------
 *
 * Phase 0 registered a stub: a name, a blurb and a credential form, with no
 * transport and no way to collect anything. Phase 1 fills in everything that
 * cannot spend money —
 *
 *   - the TRANSPORT: HTTP Basic against `sandbox.dataforseo.com/v3`, with the
 *     three-layer status check and the error-code switch (`./client.js`,
 *     `./errors.js`);
 *   - `describeAccount`, from the free `/v3/appendix/user_data`, which is also
 *     what verifies a credential at the moment somebody types it and what
 *     finally gives `ConnectorAccount.lastSeenQuota` a writer;
 *   - SITES: a locally-authored `ConnectorProject` carrying a domain, its
 *     (location, language, device) targets, its tracked keywords and its
 *     competitors (`./sites.js`).
 *
 * Phase 2 then added the three things that were deliberately withheld —
 * `kinds`, `resolveKinds` and `fetch` — TOGETHER, in one step, because any two
 * of them without the third is either invisible to the runner or unsafe.
 *
 * ---- Why they could not ship before the brake ------------------------------
 *
 * DataForSEO bills AT POST, `isFresh` is false for anything that is not `ok`,
 * and the cron re-enters every hour — so a fetcher that posts a task every time
 * it is called is charged 168 TIMES PER WEEKLY DATAPOINT. The thing that
 * prevents that is the partial unique index on an open `DfsTask` row: an open
 * job is found by `(project, kind, variant)` with NO DATE IN THE KEY, and every
 * tick after the first is a free `task_get`. Shipping `fetch` before that index
 * existed would have been shipping the bill before the brake.
 *
 * The provider is still SANDBOX-ONLY. `constants.API_ORIGIN` defaults to
 * `sandbox.dataforseo.com`, where every call is free and structurally identical,
 * and the budget document that gates real spend is phase 3.
 */

const descriptor = {
  name: 'dataforseo',
  label: 'DataForSEO',

  /**
   * The catalog line. It still says what is missing on purpose: somebody
   * deciding whether to paste a credential deserves to know that this stores a
   * site and collects nothing yet.
   */
  blurb:
    'Rank tracking, keyword research, backlinks and site audits from ' +
    'DataForSEO. Rankings are bought once per cadence and collected on later ' +
    'polls, which are free.',

  /**
   * No consent screen exists, so the UI must render a credential form instead.
   * `ConnectorsTab` branches on exactly this flag, and `validateDescriptor`
   * refuses a key-authenticated descriptor that claims otherwise — the pairing
   * is what stops a provider being shipped with a form nobody can complete.
   */
  requiresBrowserConsent: false,

  /**
   * The credential form, as DATA.
   *
   * The server seals whatever these keys collect (`connectorCrypto.sealJson`
   * takes arbitrary JSON, with `orgId|provider` bound as AAD) and the client
   * renders the form from this description. Neither side knows what a DataForSEO
   * login is, which is what makes the next key-authenticated provider a
   * descriptor rather than a second endpoint and a second dialog.
   *
   * `login` is not marked secret: it is the account email, it is not a
   * credential on its own, and showing it is how somebody tells two stored
   * accounts apart. The password is, and is the one `connectorCrypto.preview`
   * would summarise.
   */
  apiKey: {
    label: 'DataForSEO API credentials',
    help:
      'From the DataForSEO dashboard under API Access. The API password is not ' +
      'your dashboard password — it is shown for 24 hours after you register, ' +
      'and has to be requested by email after that.',
    fields: [
      {
        key: 'login',
        label: 'API login',
        secret: false,
        placeholder: 'you@example.com',
        help: 'The email address the DataForSEO account is registered under.',
      },
      {
        key: 'password',
        label: 'API password',
        secret: true,
        placeholder: '',
        help: 'Stored encrypted. It is never shown again once saved.',
      },
    ],
  },

  /**
   * Check a credential BEFORE it is stored.
   *
   * There is no consent screen to fail, so without this a mistyped API password
   * is sealed, saved, and reported as success — and the first sign of trouble is
   * a cron job marking the account `needs_reauth` days later with a Reconnect
   * button and no explanation. `/v3/appendix/user_data` is free, capped at 6
   * calls a minute, and answers exactly this question, so the person who typed
   * the password is the person who finds out.
   *
   * Optional on the descriptor: `saveCredentials` runs it only where a provider
   * declares one, so a keyed provider with nothing free to call is unaffected.
   *
   * @throws with `.needsReauth` when the credential is refused, and
   *   `.retryable` when we simply could not find out — the caller must treat
   *   those differently, or a DataForSEO outage becomes "you cannot connect".
   */
  verifyCredentials,

  /**
   * How often the runner should poll, in hours. Weekly by default; a board may
   * ask for faster and a kind may override it, both resolved in
   * `snapshotService.planProjectWork`.
   */
  syncIntervalHours: 168,

  /**
   * PRESSING REFRESH HERE SPENDS REAL MONEY.
   *
   * `connectorDataController` passed `force: true` unconditionally, justified in
   * its own comment by "a second pull of the same project on the same day costs
   * nothing". That is true of Ubersuggest, which bills per report subject per
   * day, and FALSE of this provider, which bills at POST per task. Left alone, a
   * board with 200 keywords in two markets would buy $0.24 of SERPs every time
   * somebody leant on the button, and `force` here also resets the attempt chain
   * on a job that has already been given up on — so the note telling a person to
   * press Refresh was pointing at an unbounded spend.
   *
   * The plan assigns this to phase 5, with the dashboard. It lands here instead,
   * because phase 3 is where the first live key goes in and a gate that arrives
   * after the money can move is not a gate.
   *
   * The consequence is deliberate and is the honest one: a manual refresh on
   * this provider now respects the cadence, and a person who genuinely wants to
   * re-buy sends `{force: true}` explicitly. Phase 5 puts a confirm dialog in
   * front of that; the server seam is here now so the dialog has something to
   * call.
   */
  forceRefetchIsFree: false,

  /**
   * Give back the money a crashed pass left reserved.
   *
   * Declared on the descriptor so an operator or a future cron can call it
   * directly, and ALSO run automatically once per account per pass off the
   * client's `runOnce` — see `fetchers.fetchKind`. A reservation held by a dead
   * process shrinks the month's budget until it rolls over, and the only symptom
   * is collections quietly stopping early, so it must not depend on somebody
   * remembering to schedule it.
   */
  reconcile: reconcileReservations,

  /**
   * Collect results already paid for — and NOTHING else.
   *
   * The hook `connectorCollectRunner` drives on a ten-minute cron, declared
   * beside `reconcile` for the same reason: a provider that buys work
   * asynchronously has maintenance the generic engine cannot know about, and a
   * descriptor hook is how that stays out of the runner. A provider that answers
   * in the same HTTP call declares nothing and is never called.
   *
   * ---- Why a second, faster runner rather than a faster one -----------------
   *
   * `connectorSyncRunner` is the runner that BUYS. It resolves cadences and
   * keyword lists and purchases when a reading is stale, which is exactly why it
   * must stay hourly — six chances an hour to decide something is stale is six
   * chances an hour to spend money against a provider that bills at POST.
   *
   * This one starts from rows that are already `state: 'open'`, asks a free
   * endpoint what has finished, and writes the snapshot. It runs behind a client
   * whose TRANSPORT REFUSES every endpoint that is not free, so "it cannot
   * spend" is a property of the wiring rather than a promise in a comment —
   * see `./collect.js`. That is what takes median latency from ~30 minutes to
   * ~5 without putting the purchase decision on a faster clock.
   */
  collectReady: collectAllReady,

  /**
   * There is nothing to refresh, and that is the point.
   *
   * A 401 against HTTP Basic means the stored password is WRONG, not expired —
   * there is no refresh grant, no rotation and no token lifetime. Throwing
   * `needsReauth` here drives the account to `needs_reauth` through the catch
   * that was already in `session.refresh()`, which puts the Reconnect button in
   * front of an admin and stops the weekly runner retrying a dead credential
   * forever. No new branch anywhere; the existing mechanism, reached from a
   * different starting point.
   *
   * @throws {Error} always, with `.needsReauth`
   */
  refreshTokens: async () => {
    const err = new Error(
      'DataForSEO rejected the stored credentials. They need to be entered again.'
    );
    err.needsReauth = true;
    throw err;
  },

  /**
   * One client per account, so the free account read happens once per pass
   * rather than once per call.
   *
   * `warmAccountData` starts `/v3/appendix/user_data` immediately and memoises
   * it on the client. That is the mechanism behind "`lastSeenQuota` is written
   * once per account per pass": `syncAccount` builds exactly one client per
   * account, every later caller shares the same promise, and `user_data`'s
   * 6-per-minute ceiling is never a factor on a thirty-project account.
   *
   * The balance and price book it records stay what they are documented to be —
   * DISPLAY AND ESTIMATION, NEVER A GATE. The gate is the budget document, and
   * it is computed from our own ledger.
   */
  createClient: (session) => createDfsClient(session, { warmAccountData: true }),

  /**
   * Who the provider says this account is.
   *
   * Free, so `projectMirror` calls it on every refresh and fills in the
   * `externalEmail` and `tier` that `ConnectorAccount` carries as null until
   * something asks. DataForSEO has no plans, so the tier is the honest constant
   * `pay-as-you-go` rather than a null that reads as "we could not find out".
   */
  describeAccount,

  /**
   * Every Site on this account — READ BACK FROM OUR OWN ROWS.
   *
   * DataForSEO has no projects and never will: it is a stateless billing API
   * that takes a keyword, a location, a language and a device on every call and
   * remembers nothing. So the `ConnectorProject` row is the original rather than
   * a copy, `externalId` is our own id, and this listing is our own rows.
   *
   * That is what makes `projectMirror` degenerate into a reconciliation that can
   * never mark anything `missing` — `diffProjects` computes the gone set as the
   * stored rows absent from the listing, and a listing built from the stored
   * rows cannot omit one. Unreachable by construction, rather than by a branch
   * in the generic file.
   */
  listProjects: sites.listProjects,

  /**
   * How a kind fans out for one Site: one variant per
   * (location, language, device) target.
   *
   * On the descriptor already, ahead of the kinds that will use it, because the
   * VARIANT KEY is a phase-1 decision that phase 2 depends on and that is
   * expensive to change later. It derives from immutable inputs only —
   * `location_code|language_code|device`, never a label and never an array index
   * — because from phase 2 an open task is identified by
   * `(project, kind, variant)`, and a key that shifts is a cache miss, and a
   * cache miss is a charge.
   */
  variantsFor: sites.variantsFor,

  /**
   * Which stored variant answers for the market a person picked.
   *
   * ---- Why this became a descriptor hook in phase 6 --------------------------
   *
   * `connectorDataController` used to compare variant keys literally, and only
   * for `positions`, which was right while every variant on this provider meant
   * the same thing: `(location, language, DEVICE)`.
   *
   * Labs broke that symmetry rather than extended it. `keyword_overview`,
   * `competitors_domain`, `domain_intersection` and `relevant_pages` take a
   * location and a language and NO DEVICE — so a Labs variant key is
   * `2840|en|any` while the rank kind's is `2840|en|desktop`, and the two can
   * never be equal. Compared literally, every Labs snapshot is filtered out and
   * three screens are permanently blank. Not compared at all, a board tracking
   * two countries shows one country's competitors under the other's heading,
   * with nothing on the page to say so.
   *
   * So the comparison is the MARKET — location and language, the two dimensions
   * every kind here shares — for market-scoped kinds, and stays exact for the
   * device-scoped ones.
   *
   * The `default` case is not a shortcut: the market picker is built from stored
   * `positions` rows, so a board that collects only Labs has no market selection
   * to compare against, and refusing everything would blank the tab it is meant
   * to fill.
   *
   * ---- And why phase 7 needed a THIRD answer rather than a third market ------
   *
   * The Backlinks API takes no location, no language and NO DEVICE. A backlink
   * profile is a property of a domain — there is no US-desktop version of it and
   * no US version either — so its variant collapses all the way to `0|any|any`
   * and there is exactly one of them per Site.
   *
   * Compared on the market it would never match a rank selection (`2840|en|…`
   * against `0|any|…`) and the Backlinks screen would be permanently blank; the
   * `default` escape does not cover it, because a board that also tracks rank
   * has a real market selected. So a domain-scoped kind answers TRUE
   * unconditionally, which is not a loosening: there is only one stored variant
   * it could ever be answering about, and `sites.variantsFor` is what guarantees
   * that.
   *
   * @param {string} kindKey
   * @param {string} rowVariant       - the stored snapshot's variant
   * @param {string} selectedVariant  - what the tab is showing
   * @returns {boolean}
   */
  sameVariant: (kindKey, rowVariant, selectedVariant) => {
    const kind = KINDS.find((k) => k.key === kindKey);
    if (!kind) return true;
    if (kind.variantScope === 'domain') return true;
    if (kind.variantScope !== 'market') return rowVariant === selectedVariant;
    if (!selectedVariant || selectedVariant === 'default') return true;
    const market = (v) => String(v || '').split('|').slice(0, 2).join('|');
    return market(rowVariant) === market(selectedVariant);
  },

  /**
   * This provider's projects are AUTHORED HERE, not mirrored from anywhere.
   *
   * The flag a generic controller branches on, so that `POST /…/sites` can exist
   * without naming a provider: a descriptor with no `projectAuthoring` refuses
   * the route, and Ubersuggest's projects stay something only Ubersuggest can
   * create. The caps travel with it so the form can render its own limits rather
   * than hardcoding numbers that live in `./constants.js`.
   */
  projectAuthoring: {
    label: 'Site',
    help:
      'A site is a domain, the markets you track it in, and the keywords you ' +
      'track there. Every market buys every keyword again on each collection.',
    maxKeywords: C.MAX_TRACKED_KEYWORDS,
    maxTargets: C.MAX_TARGETS,
    maxCompetitors: C.MAX_COMPETITORS,
    devices: C.DEVICES,
    /** `(body) => {ok, values} | {ok: false, error, code}`. Pure. */
    readForm: sites.readSiteForm,
  },

  /**
   * What this provider can produce, as DATA.
   *
   * The runner iterates it, `BoardConnector.kinds` narrows it, and the tab
   * renders a section per entry — so it is a plain array that serialises
   * straight to the client rather than a switch inside the fetcher. Two entries
   * because rank tracking is deliberately HYBRID: `positions` is the weekly
   * `depth: 100` census that buys the competitive picture, `movement` the daily
   * `depth: 10` check that buys the chart. `depth` is a x10 cost lever, so those
   * are two different purchases on two different clocks and cannot be one kind.
   */
  kinds: KINDS,

  /**
   * What a board actually asked for, in dependency order.
   *
   * `connectorSyncRunner.syncProvider` REFUSES to sync a descriptor missing this
   * or `fetch`, which is what kept this provider invisible to the hourly tick
   * for two phases.
   */
  resolveKinds,

  /**
   * Post once per cadence, poll for free until the answer arrives.
   *
   * The whole of the async design, and the reason `DfsTask` exists: a snapshot
   * is identified by `periodKey`, and `periodKey` cannot be known until the task
   * completes. An in-flight marker stored as a snapshot is stored under a key
   * that is guaranteed to be provisional. So an unfinished job returns
   * `{status: 'pending'}` — phase 0's sentinel, which writes nothing, counts as
   * `queued` rather than as ok/failed/skipped, and feeds nothing to a dependant.
   */
  fetch: fetchKind,

  /**
   * How many jobs are in flight for one Site, for the tab's "queued" badge.
   *
   * The one thing a separate task collection loses is the snapshot row's ability
   * to say "queued". This buys it back for one indexed `countDocuments` and
   * keeps the read endpoint's rule intact — IT NEVER CONTACTS A PROVIDER.
   * Optional on the descriptor: a provider without a queue does not declare it
   * and the controller reports zero.
   */
  queuedCount,

  /**
   * The DASHBOARD this provider gets instead of the generic one-section-per-kind
   * tab, declared as DATA for the same reason `kinds` is.
   *
   * ---- Why a second tab rather than more sections in the first one -----------
   *
   * `ConnectorDataTab` renders one section per kind and is exactly right for a
   * provider with five kinds and one number each. This one is a rank tracker
   * with a competitive census behind it, and phases 6-8 add keyword research,
   * competitors, backlinks and a site audit — four more screens, each with its
   * own table, its own sort and its own export. Stacking those as sections would
   * make one page nobody can find anything on and would download every screen's
   * chart to look at any of them.
   *
   * The presence of this key is ALSO what the board page branches on, and it is
   * what fixed `enabledConnectors[0]`: a board with both providers switched on
   * used to show whichever came back first and silently drop the other. Now the
   * one WITHOUT screens gets the generic Data tab and the one WITH them gets the
   * SEO tab, so both are reachable and neither has to know about the other.
   *
   * `BoardConnector.enabledScreens` narrows this per board and cannot reach
   * another board — unlike `kinds`, which is unioned across every board mapping
   * the project. See the model header; keeping those two apart is the point.
   */
  screens: SCREENS,

  /** What a board actually renders. Empty selection means everything. */
  resolveScreens,

  /**
   * What a person may bind to a goal, as DATA.
   *
   * Phase 9's half of the feature, and the whole of what a second provider has
   * to write: `fieldMapping.js` decides what a goal can HOLD, this catalog says
   * what this provider can PRODUCE, and neither one names the other. A hundred
   * and ten entries against the first provider's twenty-six, because there are
   * eleven kinds here rather than five - and because the audit's issue list is
   * ADDRESSED rather than flattened, so a check DataForSEO add later becomes
   * bindable the moment somebody classifies it. See `./fields.js`.
   */
  fields: FIELDS,

  /**
   * Pull one of those values out of a stored snapshot. Pure, and the only door
   * into the catalog - the writeback names a key and hands over the data, and
   * never reaches into the entries themselves.
   */
  readField,

  /**
   * MAY THESE TWO READINGS BE SUBTRACTED FROM EACH OTHER.
   *
   * A goal is a pair of numbers: the starting point and the result. The generic
   * writeback fills the first from the reading before the month and the second
   * from the newest one inside it - and for three of the kinds here, two
   * readings taken under different settings are two measurements of two
   * different things.
   *
   * `onpage_score` is a share of the pages crawled; `backlinks_status_type`
   * recomputes every aggregate rather than filtering rows; a rank bought to
   * depth 10 and one bought to depth 100 disagree about every keyword outside
   * the top ten. The SCREENS already refuse those comparisons - that is what
   * `auditRows.comparability` and `backlinkRows.comparability` are - but a goal
   * cell has no caption to read, so the refusal has to happen before the value
   * is written rather than beside it.
   *
   * Optional on the descriptor, and absent means "always comparable", which is
   * the behaviour every provider had before this existed.
   */
  comparability,

  /**
   * The money ledger behind the Usage & Spend screen.
   *
   * A descriptor hook rather than a `DfsTask` import inside the controller, for
   * the same reason `queuedCount` is one: the generic data controller must not
   * learn that this provider buys work asynchronously. A provider without a
   * ledger declares nothing and the controller answers with the budget document
   * alone.
   *
   * It reads `DfsTask` and NOTHING ELSE — no `user_data`, no balance call, no
   * provider contact of any kind. See `./usage.js` for why the live balance is
   * the wrong number even though it is free.
   */
  describeUsage,

  /**
   * WHAT IS WORTH INTERRUPTING SOMEBODY ABOUT — phase 10.
   *
   * A descriptor hook rather than logic inside the runner, for the reason
   * `comparability` and `describeUsage` are hooks: the generic pass knows who
   * may be told and whether they have muted the category, and it must not learn
   * what a rank is, what depth means, or which pairs of readings may be
   * subtracted at all.
   *
   * TWO CONSUMERS, ONE IMPLEMENTATION. `services/seoAlertRunner.js` delivers the
   * result as a notification; `connectorDataController` calls the same function
   * over the snapshots it already has in memory so the Alerts screen can show
   * what the latest reading fires and why. That is deliberately unlike
   * `comparability`, which had to be copied onto the client because a screen
   * needed it without a round trip — here the round trip already exists, so the
   * thresholds live in exactly one file.
   *
   * `RULES` rides along as data so the screen can print the thresholds rather
   * than restating them.
   */
  alerts: { RULES: ALERT_RULES, evaluate: evaluateAlerts },
};

module.exports = descriptor;
