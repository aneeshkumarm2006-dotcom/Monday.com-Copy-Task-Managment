/**
 * DataForSEO — hosts, endpoints, status codes and the caps that bound a Site.
 *
 * Everything here was taken from DataForSEO's own documentation and from
 * `_ai_context/dataforseo_RESEARCH.md`, which records where that documentation
 * contradicts itself. Where the two disagree the research note wins, because it
 * was verified.
 *
 * ---- Why the origin defaults to the SANDBOX --------------------------------
 *
 * `sandbox.dataforseo.com` is free for any registered user, takes the same
 * credentials, and answers with structurally identical payloads carrying dummy
 * data. Phases 1 and 2 are built entirely against it, so the DEFAULT has to be
 * the harmless one: a provider whose default host bills real money is one wrong
 * environment variable away from an invoice, and the whole point of the phase
 * split is that nothing before phase 3 can spend a cent.
 *
 * The override is deliberately not "whatever the environment says". An unknown
 * host would silently disable every cost assumption in this directory, so the
 * value is checked against the two origins that exist and falls back — loudly —
 * to the sandbox otherwise.
 */

const SANDBOX_ORIGIN = 'https://sandbox.dataforseo.com';
const LIVE_ORIGIN = 'https://api.dataforseo.com';

const KNOWN_ORIGINS = new Set([SANDBOX_ORIGIN, LIVE_ORIGIN]);

/**
 * The origin every call in this directory is made against.
 *
 * Resolved once, at require time, so a mid-run change of environment cannot
 * move half a pass onto a different host — and so the warning below is printed
 * once rather than per call.
 *
 * @returns {string}
 */
const resolveOrigin = () => {
  const asked = String(process.env.DATAFORSEO_API_ORIGIN || '').trim().replace(/\/$/, '');
  if (!asked) return SANDBOX_ORIGIN;
  if (KNOWN_ORIGINS.has(asked)) return asked;
  console.warn(
    `[connectors/dataforseo] DATAFORSEO_API_ORIGIN="${asked}" is not a DataForSEO host; ` +
      'falling back to the sandbox.'
  );
  return SANDBOX_ORIGIN;
};

const API_ORIGIN = resolveOrigin();
const API_BASE = `${API_ORIGIN}/v3`;

/** True while nothing here can be billed. Phase 3 is the first phase that cares. */
const IS_SANDBOX = API_ORIGIN === SANDBOX_ORIGIN;

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

/**
 * The account endpoint: free, 6 requests per minute, and the only one this
 * phase calls. It returns the live, account-specific price book plus
 * `money.balance` — which is what turns a phase-3 budget reservation into an
 * exact estimate rather than a guess against a published price list that
 * changed on 2026-07-01.
 */
const ENDPOINT_USER_DATA = 'appendix/user_data';

/**
 * The Standard (queued) Google organic SERP family.
 *
 * Three endpoints and exactly one of them costs anything:
 *
 *   `task_post`   — BILLED HERE, at post, up to 100 tasks per call.
 *   `task_get`    — FREE, results kept 30 days. The hourly tick's whole job.
 *   `tasks_ready` — FREE, kept 3 days, and a DESTRUCTIVE READ. Phase 4.
 *
 * `advanced` rather than `regular` on the get: `regular` populates only
 * organic/paid/featured_snippet, and the SERP-feature census and the
 * `ai_overview.references[]` that phase 10's AI Visibility screen is built on
 * ride inside the advanced payload at no extra cost.
 */
const ENDPOINT_SERP_TASK_POST = 'serp/google/organic/task_post';
const ENDPOINT_SERP_TASK_GET = 'serp/google/organic/task_get/advanced';
const ENDPOINT_SERP_TASKS_READY = 'serp/google/organic/tasks_ready';

/**
 * The other half of the repair pair, and the reason the poller stays
 * load-bearing.
 *
 * `tasks_ready` only ever announces SUCCESS. A task that failed inside
 * DataForSEO is never listed there, so a collector that waits for an
 * announcement waits for one that will never come. `{api}/errors` is free, is
 * the same shape for every API family, and is the only channel that names those
 * ids — which is why it is swept beside `tasks_ready` rather than instead of it.
 */
const ENDPOINT_SERP_ERRORS = 'serp/errors';

/**
 * `appendix/webhook_resend` — DELIBERATELY NEVER CALLED. Declared so the
 * decision is in the code rather than only in the plan.
 *
 * It is the documented repair for a pingback that was dropped, and DataForSEO
 * neither signs nor retries pingbacks, so any webhook design needs it. We have
 * no webhook design: `task_get` is free, so the economic case for one is zero,
 * and an unsigned unauthenticated payload has to be re-verified with a
 * `task_get` anyway — which saves no calls and buys a public abuse surface. The
 * path is RESERVED (`routes/connectors.js`, `./pingback.js`) and inert.
 *
 * The poller's equivalent repair is `READY_GRACE_HOURS` below: results live
 * thirty days, so a missed announcement costs latency and never a re-purchase.
 */
const ENDPOINT_WEBHOOK_RESEND = 'appendix/webhook_resend';

// ---------------------------------------------------------------------------
// DataForSEO Labs — the competitive index
// ---------------------------------------------------------------------------

/**
 * The freshness oracle, and the reason every Labs panel carries a date.
 *
 * FREE. It answers `google.date_update` — the day the Labs database this
 * account reads was last rebuilt.
 *
 * ---- Why a free extra call is worth making on every Labs pass --------------
 *
 * DataForSEO's own documentation contradicts itself about how old Labs data
 * is. The Labs overview page says the databases update WEEKLY and offers this
 * endpoint as the oracle; their general database article says the SERP and
 * keyword databases underneath refresh every 30-60 days for top-tier locations
 * and 60-90 for mid-tier. Those cannot both be true, and the difference decides
 * whether a competitor table is this week's picture or last quarter's.
 *
 * There is no way to settle it from outside, so we do not try. We stamp what
 * THEY say — `date_update` — onto every Labs snapshot and label the panel
 * "competitive index, updated weekly", and the word LIVE is reserved for the
 * SERP API and Backlinks, which really are. A panel that inherited the rank
 * tracker's "collected 2 hours ago" caption would be making a claim about
 * somebody else's database that we have no basis for.
 */
const ENDPOINT_LABS_STATUS = 'dataforseo_labs/status';

/**
 * The four Labs endpoints phase 6 buys from. ALL BILLABLE, ALL LIVE.
 *
 * Labs has no task queue anywhere — there is no `task_post`, no `tasks_ready`
 * and no `task_get`. One HTTP call goes out and the answer comes back in it,
 * charged on the way. That is the opposite shape from the SERP family and it is
 * why `kinds.transport` exists: the SERP kinds claim a row, post, and collect on
 * a later free poll, while these claim a row, call, settle and close inside one
 * function.
 *
 * The consequence for `./collect.js`: none of these may ever appear on its
 * ALLOWLIST. The ten-minute collector's transport refuses every endpoint that is
 * not free, and "free" here means `dataforseo_labs/status` and nothing else in
 * this block.
 */
const ENDPOINT_LABS_KEYWORD_OVERVIEW = 'dataforseo_labs/google/keyword_overview/live';
const ENDPOINT_LABS_COMPETITORS_DOMAIN =
  'dataforseo_labs/google/competitors_domain/live';
const ENDPOINT_LABS_DOMAIN_INTERSECTION =
  'dataforseo_labs/google/domain_intersection/live';
const ENDPOINT_LABS_RELEVANT_PAGES = 'dataforseo_labs/google/relevant_pages/live';

/**
 * The Bing mirrors, DECLARED AND NOT CALLED — the same treatment
 * `ENDPOINT_WEBHOOK_RESEND` gets, and for a related reason.
 *
 * Eleven Labs endpoints exist under `dataforseo_labs/bing/…`, US-only, and
 * DataForSEO's pricing page renders as a nav shell for them: their price is
 * genuinely unknown. A search snippet claims $0.01/task + $0.0001/item, which is
 * ~17% under the Google tier, and a snippet is not a price list.
 *
 * That uncertainty costs this phase NOTHING, because no estimate in this
 * directory is ever the number that gets recorded: `labsCall` settles the ledger
 * from the envelope's own `cost` field, which is what DataForSEO actually
 * charged. So a Bing kind added later is priced correctly on its first call
 * whatever the published number turns out to be — the estimate is only what the
 * cap is reserved against, and it is deliberately the HIGHER Google figure so an
 * unknown price can never under-reserve.
 *
 * Outstanding item #4 in the plan is therefore answered by one call a human
 * makes with a live credential, not by a constant anybody has to maintain:
 * post ten keywords to `bing/bulk_keyword_difficulty` and read `cost`.
 */
const ENDPOINT_LABS_BING_BULK_KEYWORD_DIFFICULTY =
  'dataforseo_labs/bing/bulk_keyword_difficulty/live';

// ---------------------------------------------------------------------------
// Backlinks — the link index. LIVE, and this one really is
// ---------------------------------------------------------------------------

/**
 * The free one, and the reason a Backlinks panel can carry a footnote without
 * carrying a caveat.
 *
 * `backlinks/index` answers the size of the live link index plus twelve months
 * of its history. It is the direct analogue of `dataforseo_labs/status` — a
 * caption endpoint, free, read once per account per pass through `runOnce` — and
 * it is on `collect.js`'s ALLOWLIST for exactly that reason.
 *
 * ---- But the sentence it supports is a DIFFERENT sentence ------------------
 *
 * Labs is a database whose age DataForSEO's own docs cannot agree on, so every
 * Labs panel says "competitive index, updated weekly" and stamps `date_update`.
 * The BACKLINK index is updated continuously — ~8.7 billion pages crawled every
 * 24 hours, ~2 second turnaround — and DataForSEO's own list of live-only
 * families includes it. So the Backlinks screen is allowed the word LIVE, which
 * three Labs screens are deliberately denied, and this endpoint supplies scale
 * rather than an age.
 *
 * What it must never be read as: a recrawl guarantee for one domain. The
 * per-domain recrawl interval is NOT documented anywhere, so the latency between
 * a link disappearing in reality and `is_lost` flipping is unknown — bounded
 * above only by the one-year purge. "Live index" is a claim about the index, not
 * about any single row in it, and the screen says so.
 */
const ENDPOINT_BACKLINKS_INDEX = 'backlinks/index';

/**
 * The six Backlinks endpoints phase 7 buys from. ALL BILLABLE, ALL LIVE.
 *
 * The Backlinks API has no task queue at all — the same shape as Labs and the
 * opposite of the SERP family — so these kinds declare `transport: 'live'` and
 * travel `liveJob.runLiveJob`: claim the row, reserve, call, settle from the
 * envelope's own `cost`, close. `collect.js` skips them by construction.
 *
 * `summary` is listed once and CALLED TWICE per collection, and that is the
 * single most important line in this block. See `BACKLINKS_DOFOLLOW_FILTER`.
 */
const ENDPOINT_BACKLINKS_SUMMARY = 'backlinks/summary/live';
const ENDPOINT_BACKLINKS_TIMESERIES = 'backlinks/timeseries_summary/live';
const ENDPOINT_BACKLINKS_TIMESERIES_NEW_LOST =
  'backlinks/timeseries_new_lost_summary/live';
const ENDPOINT_BACKLINKS_REFERRING_DOMAINS = 'backlinks/referring_domains/live';
const ENDPOINT_BACKLINKS_ANCHORS = 'backlinks/anchors/live';

/**
 * THE ONLY HONEST SOURCE OF DOMAIN AUTHORITY IN THIS API.
 *
 * `backlinks/summary` and `backlinks/bulk_ranks` both return a field called
 * `rank`, and `backlinks/referring_domains` returns a field called `rank` too —
 * and the third one is NOT the same measurement. On a referring-domain row it is
 * the rank of the LINKS THAT DOMAIN SENDS TO OUR TARGET, not that domain's own
 * standing on the web. Sorting a table by it is reasonable; labelling the column
 * "authority" and putting nytimes.com below a link farm is not.
 *
 * So the authority of any domain other than our own is bought here, in one call
 * that takes up to a thousand targets and costs one flat request price, and the
 * normaliser gives the two numbers names that cannot be confused —
 * `authorityRank` from this endpoint, `linksRank` from the referring-domain row.
 */
const ENDPOINT_BACKLINKS_BULK_RANKS = 'backlinks/bulk_ranks/live';

/**
 * The second `summary` call, and the reason it is not an arithmetic operation.
 *
 * ---- The trap, stated as the wrong line of code ----------------------------
 *
 *   // WRONG. Do not ship this.
 *   dofollowReferringDomains = referring_domains - referring_domains_nofollow;
 *
 * `referring_domains_nofollow` does NOT mean "referring domains whose links are
 * all nofollow". It means "referring domains sending AT LEAST ONE nofollow
 * link". A domain that links to us twice — once followed, once not — is counted
 * in BOTH `referring_domains` and `referring_domains_nofollow`, so the two are
 * overlapping sets and their difference is not the complement of anything.
 *
 * The error is silent, always in the same direction, and largest for exactly the
 * profiles people care about: a site with many multi-link referrers will have
 * its dofollow count UNDERSTATED, on a client report, with no way to tell from
 * the screen. There is no field anywhere in the payload that would reveal it.
 *
 * The correct answer costs one more request at the same flat price: ask
 * `summary` again with a filter that considers only followed links, and read
 * `referring_domains` off THAT answer. Two calls, two independently computed
 * aggregates, no subtraction anywhere.
 */
const BACKLINKS_DOFOLLOW_FILTER = ['dofollow', '=', true];

/**
 * `backlinks_status_type` — `all | live | lost`, and it RECOMPUTES rather than
 * filters.
 *
 * ---- Why this is a constant and not a parameter ----------------------------
 *
 * The natural reading is that it narrows the rows a call considers, the way a
 * `WHERE` clause does, leaving the aggregates comparable across settings. It
 * does not. It recomputes every aggregate over a different corpus, INCLUDING
 * `rank` — DataForSEO's own documentation example shows one domain at rank 509
 * under `lost` and 562 under `live`. Two numbers taken under different status
 * types are two different measurements of two different graphs, and putting them
 * on one trend line draws a movement that never happened.
 *
 * So the value is fixed here, sent on every request that accepts it, and STORED
 * ON EVERY SNAPSHOT — `backlinksNormalise` stamps it and the client refuses to
 * compute a delta between two readings that disagree about it. Changing this
 * constant is therefore a break in the series rather than a silent
 * re-baselining, which is the whole point of storing it.
 *
 * `live` is the default and the right default: it is the profile as it stands
 * today, which is what "how many links do we have" means to everybody who asks.
 */
const BACKLINKS_STATUS_TYPE = 'live';

/** The three values DataForSEO accepts, for a validator that names them. */
const BACKLINKS_STATUS_TYPES = ['all', 'live', 'lost'];

/**
 * `rank_scale` — `one_thousand` (the default) or `one_hundred`.
 *
 * Sent EXPLICITLY even though it is the default, and stored on the snapshot
 * beside every rank it describes. A rank of 562 and a rank of 56 are the same
 * fact on two scales, and a stored series that silently changed scale mid-way
 * would draw a collapse. The conversion DataForSEO documents is
 * `sin(rank / 636.62) * 100`, which is not linear — so a reader cannot recover
 * the scale from the number.
 *
 * ---- And the label rule that travels with it -------------------------------
 *
 * IT IS NEVER CALLED DA OR DR. It is original PageRank with a damping factor of
 * 0.5, logarithmically compressed, computed over DataForSEO's own crawl.
 * DataForSEO positions it as an alternative to Ahrefs' Domain Rating and says in
 * as many words that the values should not be expected to match. Borrowing
 * either competitor's name for it makes a number a client can look up somewhere
 * else and find to be wrong.
 */
const BACKLINKS_RANK_SCALE = 'one_thousand';

/** The top of each scale, so a gauge never invents a ceiling. */
const BACKLINKS_RANK_MAX = { one_thousand: 1000, one_hundred: 100 };

/**
 * How many rows each Backlinks kind asks for.
 *
 * Backlinks bills $0.024 per REQUEST plus $0.000036 per ROW, capped at a
 * thousand rows — so a full thousand-row call is $0.06 and the request price is
 * two thirds of it. The rows are nearly free and the calls are not, which is the
 * opposite of Labs and changes what a limit is for: here it bounds the SNAPSHOT,
 * not the bill. A hundred referring domains is what a table shows and what fits
 * in a `ConnectorSnapshot` beside everything else.
 */
const BACKLINKS_REFERRING_DOMAINS_LIMIT = 100;
const BACKLINKS_ANCHORS_LIMIT = 100;

/**
 * How many buckets of history one timeseries call asks for, in months.
 *
 * Twenty-four, and the floor under it is real: `timeseries_summary` has data
 * from 2019-01-30 and no earlier, so `date_from` is clamped rather than trusted.
 * Items come back stamped with the LAST day of their bucket, which is why the
 * normaliser never re-derives a month from an item's date.
 */
const BACKLINKS_TIMESERIES_MONTHS = 24;

/** The first day `timeseries_summary` has anything for. Their number, not ours. */
const BACKLINKS_INDEX_EPOCH = '2019-01-30';

/** `day | week | month | year`. Monthly, for a 24-month growth chart. */
const BACKLINKS_TIMESERIES_GROUP = 'month';

/**
 * How many entries the free breakdown maps carry.
 *
 * `internal_list_limit` is what turns `summary`'s `referring_links_tld`,
 * `_types`, `_attributes`, `_platform_types`, `_semantic_locations` and
 * `_countries` from empty objects into the top-N donuts on the screen — at NO
 * extra cost, inside a call already being made. Twenty is DataForSEO's own
 * maximum and is more than a donut can label.
 */
const BACKLINKS_INTERNAL_LIST_LIMIT = 20;

/**
 * The published Backlinks price, per REQUEST and per RETURNED ROW, in USD.
 *
 * An ESTIMATE ONLY — `liveJob` settles every charge from the envelope's own
 * `cost`, exactly as it does for Labs. These are the fallbacks used when the
 * account's own price book cannot be read, and they are deliberately the
 * published figures rather than anything optimistic: an estimate that is too low
 * under-reserves, and under-reserving is how a cap stops meaning what it says.
 */
const BACKLINKS_TASK_USD = 0.024;
const BACKLINKS_ITEM_USD = 0.000036;

/**
 * The Labs Standard price, per REQUEST and per RETURNED ROW, in USD.
 *
 * An ESTIMATE ONLY, and the distinction matters more here than it did for SERP.
 * `pricing.resolveUnitPrice` reads the account's own book first and falls back
 * to these; whichever number it lands on, `labsCall` settles against the
 * envelope's `cost`. Labs bills per returned item, so an estimate computed
 * before the call can only ever guess how many rows come back — which is why
 * every Labs request this phase sends carries an explicit `limit`.
 */
const LABS_TASK_USD = 0.012;
const LABS_ITEM_USD = 0.00012;

// ---------------------------------------------------------------------------
// Phase 8 - OnPage. A THIRD family, a THIRD shape, and a crawl is not a query.
// ---------------------------------------------------------------------------

/**
 * The only billable OnPage endpoint this phase touches - and it is billed per
 * PAGE ACTUALLY CRAWLED, at post, with the unused budget refunded.
 *
 * ---- Why this is a `task` kind and Labs/Backlinks are not -------------------
 *
 * OnPage is the SERP family's shape, not Labs': `task_post` charges and every
 * result endpoint is free with thirty-day retention. So it travels
 * `tasks.js` / `ready.js` / `collect.js` and NOT `liveJob.js` - the whole point
 * of that machinery is the gap between paying and collecting, and a crawl has
 * the largest such gap in the product. A 1,000-page crawl is minutes at best and
 * hours on a slow host, and every one of those polls costs nothing.
 *
 * The trap on the other side, which `on_page/pages` and `on_page/summary` being
 * FREE creates: there is no reason at all to split a site audit into several
 * paid kinds the way Backlinks is split. Backlinks charges per CALL, so dropping
 * a call saves two thirds of a request price. Here the CRAWL is the entire bill
 * and every read of its output is free, so a second kind would buy a second
 * crawl of the same site in order to draw a second panel. One kind, several
 * free reads.
 */
const ENDPOINT_ONPAGE_TASK_POST = 'on_page/task_post';

/**
 * The free result endpoints. Both are on `collect.js`'s ALLOWLIST; `task_post`
 * above deliberately is NOT.
 *
 * `summary` is also the PROGRESS oracle - `crawl_progress` reads `in_progress`
 * until the crawl finishes - which is why this kind needs no equivalent of
 * `tasks_ready`. `on_page/tasks_ready` exists and is free, and reading it would
 * buy nothing: a crawl is ONE task per site, `summary` answers the same question
 * plus the whole result, and the phase-4 grace window would only delay the first
 * poll of a job we are already polling for free.
 */
const ENDPOINT_ONPAGE_SUMMARY = 'on_page/summary';
const ENDPOINT_ONPAGE_PAGES = 'on_page/pages';

/**
 * THE FLAG THAT COSTS 34x, NAMED SO A GUARD CAN FIND IT.
 *
 * `enable_browser_rendering: true` takes the crawl from $0.00015 a page to
 * $0.0051 a page and subsumes `enable_javascript` and `load_resources` on the
 * way. A thousand-page site goes from fifteen cents to five dollars and ten
 * cents - the whole default monthly cap, in one call, for one site.
 *
 * It is also the flag that makes the Core Web Vitals non-zero, which is exactly
 * what makes it tempting: LCP, FID and CLS all read 0 without it, and the
 * obvious "fix" for an empty panel is to switch it on. So the panel says why the
 * numbers are zero instead, and `onpage.guardBrowserRendering` THROWS on a
 * payload carrying this key rather than stripping it - the same treatment
 * `labs.guardClickstream` gives the 2x flag, for the same reason: a silent strip
 * turns a pasted doc example into a feature that mysteriously does not work.
 */
const BROWSER_RENDERING_KEY = 'enable_browser_rendering';

/** The other three multipliers, named so an estimate can follow a config change. */
const ONPAGE_JAVASCRIPT_KEY = 'enable_javascript';
const ONPAGE_LOAD_RESOURCES_KEY = 'load_resources';
const ONPAGE_KEYWORD_DENSITY_KEY = 'calculate_keyword_density';

/**
 * What each crawl option multiplies the PER-PAGE price by.
 *
 * Read by `pricing.onpageEstimateFor` off the config rather than hardcoded at 1,
 * so the day somebody turns one on the reservation moves with it. An estimate
 * that stayed at the base rate while the bill tripled is a cap that does not
 * hold.
 *
 * `enable_browser_rendering` SUBSUMES the other two rendering flags, so these
 * are not multiplied together - the largest one wins. Their own pricing page is
 * explicit about that, and getting it wrong the other way would over-reserve by
 * a factor of a hundred and refuse collections the cap should allow.
 */
const ONPAGE_MULTIPLIERS = {
  [BROWSER_RENDERING_KEY]: 34,
  [ONPAGE_JAVASCRIPT_KEY]: 10,
  [ONPAGE_LOAD_RESOURCES_KEY]: 3,
  [ONPAGE_KEYWORD_DENSITY_KEY]: 2,
};

/**
 * THE PINNED CRAWL SIZE, and it is pinned for a reason that is not thrift.
 *
 * `onpage_score` is SAMPLE-SIZE DEPENDENT by DataForSEO's own admission: the
 * domain-level score normalises each issue by `N / Ntotal`, so the same site
 * crawled at 100 pages and at 1,000 pages produces two different scores with
 * nothing in either payload to say so. A trend line drawn across a change in
 * this number is a chart of our own configuration.
 *
 * So it is a constant here, it is hashed into `configHash` on every snapshot,
 * and `auditRows.comparability` REFUSES a delta between two readings that
 * disagree about it. Changing this number is a deliberate break in the series,
 * exactly like `BACKLINKS_STATUS_TYPE`.
 */
const ONPAGE_MAX_CRAWL_PAGES = 1000;

/**
 * The crawl this provider buys. THE WHOLE OF IT, in one object, on purpose.
 *
 * Every key here lands in `configHash`, so the object IS the definition of "two
 * readings that may be compared". Adding a key breaks the series once, visibly,
 * with a sentence on the screen - which is the correct behaviour and is why the
 * config is a frozen constant rather than something assembled at call time from
 * scattered defaults.
 *
 * The four options that are `false` are written out rather than omitted, and
 * that is the point of them: an absent key reads as "nobody thought about it"
 * and a `false` reads as "this was decided". Each one is a multiplier - 34x,
 * 10x, 3x and 2x - and the two that are `true` are free.
 *
 *   respect_sitemap  the ONLY way `is_orphan_page` means anything. Free.
 *   check_spell      without it `has_misspelling` is NULL rather than zero, and
 *                    a counter that is null for a configuration reason renders
 *                    as "no misspellings found". Free.
 */
const ONPAGE_CRAWL_CONFIG = Object.freeze({
  max_crawl_pages: ONPAGE_MAX_CRAWL_PAGES,
  respect_sitemap: true,
  check_spell: true,
  [ONPAGE_LOAD_RESOURCES_KEY]: false,
  [ONPAGE_JAVASCRIPT_KEY]: false,
  [BROWSER_RENDERING_KEY]: false,
  [ONPAGE_KEYWORD_DENSITY_KEY]: false,
});

/**
 * How many page rows the audit stores, and how many it asks for.
 *
 * Asked for in the SAME number it stores, which is different from every other
 * limit in this directory - Labs and Backlinks ask for more than they draw
 * because the rows are the bill and a bigger ask is a better sample. Here the
 * read is FREE and the ordering is done server-side (`onpage_score,asc`, worst
 * first), so asking for a thousand rows to keep a hundred would be a megabyte
 * over the wire for nothing.
 *
 * The consequence to state rather than hide: the Core Web Vitals aggregate is
 * computed over THESE pages, which are the worst-scoring ones and not a random
 * sample. The screen says so. (It is moot while browser rendering is off, since
 * all three numbers are then zero - but it would stop being moot the moment
 * somebody turned it on, and a caveat added later is a caveat nobody adds.)
 */
const ONPAGE_PAGES_LIMIT = 100;

/**
 * The published base crawl price, per PAGE, in USD.
 *
 * An ESTIMATE ONLY, exactly like the Labs and Backlinks figures: the reservation
 * is taken against `max_crawl_pages` and the settle comes off the envelope's own
 * `cost`, which is what makes the refund of the unused crawl budget land in our
 * ledger without anybody computing it. A site with forty pages reserves for a
 * thousand and settles for forty.
 */
const ONPAGE_PAGE_USD = 0.00015;

/**
 * How long a crawl may stay open before it is abandoned. THREE TIMES the SERP
 * figure, and the difference is the point.
 *
 * `TASK_EXPIRY_HOURS` is twelve, which is right for a SERP task that answers in
 * about five minutes. A crawl is a robot walking a thousand pages of somebody
 * else's website at their rate limit; hours is normal and a slow host can take
 * most of a day. Expiring at twelve would abandon a crawl that was still running
 * and BUY A SECOND ONE - the exact double charge the whole expiry mechanism
 * exists to bound, arrived at through the safety valve.
 *
 * Thirty-six hours is comfortably past any healthy crawl and comfortably inside
 * the thirty days DataForSEO keeps the result, so the pathological case (a crawl
 * that really is stuck) still costs at most `MAX_TASK_ATTEMPTS` crawls.
 */
const ONPAGE_EXPIRY_HOURS = 36;

/**
 * DataForSEO's ceiling on SIMULTANEOUS requests to the database-backed
 * families — and the single most important thing to know about it is that it is
 * ONE ceiling shared by three APIs.
 *
 * Labs, Backlinks and OnPage (plus Content Analysis, Domain Analytics, AI
 * Optimization and Trends) all count against the same thirty. A Labs-local
 * limiter of thirty and a Backlinks-local limiter of thirty is sixty in flight
 * and a wall of `40209`s, so the pool that enforces this is deliberately NOT in
 * this phase's files — see `./pool.js`, which phases 7 and 8 join by naming
 * their endpoint prefix and nothing else.
 */
const DB_BACKED_SIMULTANEOUS_CEILING = 30;

/**
 * How many we allow ourselves. Twenty-five, under their thirty.
 *
 * The margin is not superstition. The ceiling is per ACCOUNT and ours is shared
 * across every organisation on this deployment, the pool is per PROCESS and
 * Render can run two of them, and a manual refresh runs outside the cron
 * entirely. So the pool is throughput control and politeness; the correctness
 * backstop is that `40209` classifies as `rate_limit` → retryable, and the
 * transport backs off and tries again. A limiter that were the only defence
 * would be a defence with a hole in it the day a second instance boots.
 */
const DB_BACKED_POOL_LIMIT = 25;

/**
 * `include_clickstream_data: true` SILENTLY DOUBLES the request cost on ~15
 * Labs endpoints, and defaults to false everywhere.
 *
 * The name is a constant rather than a literal because the guard in `./labs.js`
 * has to be able to find it in a payload it did not build — the failure mode
 * this is written against is somebody copying a request example out of the docs
 * into a config, where it reads as an innocuous "include more data" flag and
 * arrives as a 2x on the bill with no error, no warning and no difference in the
 * response shape anybody would notice.
 */
const CLICKSTREAM_KEY = 'include_clickstream_data';

/** What `include_clickstream_data: true` multiplies the whole request by. */
const CLICKSTREAM_MULTIPLIER = 2;

/**
 * How many keywords one `keyword_overview` call may carry. DataForSEO's own
 * ceiling is 700, and unlike `task_post`'s hundred this one is not a batching
 * convenience — it is the whole request, and a 201st keyword is a 40501.
 */
const MAX_LABS_KEYWORDS_PER_CALL = 700;

/**
 * How many rows each Labs kind asks for.
 *
 * `limit` IS THE COST CONTROL on this API — every endpoint bills per returned
 * row, and the maximum is 1,000 everywhere. A competitor table nobody scrolls
 * past row forty does not need a thousand rows at $0.00012 each on every
 * collection, in every market, for every client.
 */
const LABS_COMPETITOR_LIMIT = 100;
const LABS_GAP_LIMIT = 300;
const LABS_TOP_PAGES_LIMIT = 100;

/**
 * How many competitors one gap report compares against.
 *
 * `domain_intersection` takes exactly TWO targets, so a Site listing ten
 * competitors would be ten billable calls per market per collection. Three is
 * the number a person can read side by side, and the Site's own competitor list
 * decides which three.
 */
const MAX_GAP_COMPETITORS = 3;

/**
 * How many task objects one `task_post` may carry. DataForSEO's own ceiling.
 *
 * A 200-keyword Site is therefore two posts, both belonging to ONE `DfsTask`
 * job — the job is the unit the anti-repost gate protects, not the HTTP call.
 */
const MAX_TASKS_PER_POST = 100;

/**
 * Queue priority. `1` is the normal queue (~5 minutes); `2` is DOUBLE PRICE for
 * ~1 minute, which buys nothing at all on an hourly polling loop.
 */
const TASK_PRIORITY_STANDARD = 1;

// ---------------------------------------------------------------------------
// Status codes — the switch, as DATA
// ---------------------------------------------------------------------------

/**
 * The two success codes.
 *
 * `20100` is the one that catches people out. It means "Task Created" and
 * arrives with `result: null` — an HTTP 200, inside a `20000` envelope, that has
 * produced no data and has already been charged for. Treating it as a failure
 * reposts and double-charges; treating it as a success stores an empty snapshot.
 * It is neither, which is why it has its own classification.
 */
const STATUS_OK = 20000;
const STATUS_TASK_CREATED = 20100;

/** Wrong login or API password. Not stale — there is no refresh grant. */
const STATUS_AUTH = 40100;

/** Their money, their ceiling. Nothing on this account can work until it moves. */
const STATUS_NO_FUNDS = 40200;
const STATUS_DAILY_COST_LIMIT = 40203;
const STATUS_MONEY_LIMIT = 40210;

/** Ours to slow down for, not to stop for. */
const STATUS_RATE_LIMIT = 40202;
const STATUS_TOO_MANY_SIMULTANEOUS = 40209;

/** This account may not call this endpoint. One call, not the account. */
const STATUS_FORBIDDEN_ENDPOINT = 40204;

/** The task existed and its result has aged out. Results live 30 days. */
const STATUS_RESULTS_EXPIRED = 40403;

/**
 * The task exists and is not finished. NOT A FAILURE.
 *
 * `40601` ("Task Handed") and `40602` ("Task In Queue") are what a `task_get`
 * answers with while the crawl is still running, and they are the codes the
 * whole free polling loop turns on. Reading either as an error would mark the
 * job failed and — because a failed job is not `open` — let the next hourly tick
 * post the batch again. That is the double charge, arriving through the one door
 * the partial unique index cannot cover.
 *
 * Their own classification for the same reason `20100` has one: neither an
 * answer nor a fault, so neither branch is correct.
 */
const STATUS_TASK_HANDED = 40601;
const STATUS_TASK_IN_QUEUE = 40602;

/**
 * Sandbox only: no prepared response exists for that request shape.
 *
 * Its own classification because it means the PLUMBING worked — the credential
 * authenticated, the envelope parsed, the task was accepted — and only the
 * canned data is missing. Reading it as a hard failure would make every sandbox
 * run look like a broken integration.
 */
const STATUS_NO_SANDBOX_DATA = 40404;

/** A field we sent is wrong. Retrying sends the same field. */
const STATUS_INVALID_FIELD = 40501;

/** Theirs, and transient. */
const STATUS_INTERNAL = 50000;
const STATUS_TIMEOUT = 50401;
const STATUS_TARGET_SLOW = 50402;

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** How long one HTTP call may take. Their Live endpoints answer in 2-6s. */
const HTTP_TIMEOUT_MS = 30_000;

/** Backoff between retries of a RETRYABLE failure. Two retries, then give up. */
const RETRY_DELAYS_MS = [600, 2_000];

/**
 * How many `task_get` calls may be in flight at once while polling one job.
 *
 * `task_get` is free and outside the 30-simultaneous ceiling that binds the
 * DB-backed families, so this is politeness rather than a limit — but 200
 * unbounded parallel sockets against one host is how an integration gets
 * rate-limited into a 429 storm on a call that costs nothing.
 */
const POLL_CONCURRENCY = 8;

// ---------------------------------------------------------------------------
// The life of an unanswered task
// ---------------------------------------------------------------------------

/**
 * How long an open job may go unanswered before it is abandoned.
 *
 * The window is bounded on both sides and neither bound is arbitrary. Below it,
 * DataForSEO's Standard queue is ~5 minutes and the runner polls hourly, so
 * twelve hours is twelve free chances to collect. Above it, `tasks_ready` is
 * retained for only THREE DAYS — an abandonment window wide enough to cross that
 * cliff means the repost happens after the evidence that the first task ever
 * finished has already been dropped.
 *
 * Twelve hours x three attempts is thirty-six hours worst case, comfortably
 * inside the cliff.
 */
const TASK_EXPIRY_HOURS = 12;

/**
 * How many times one job may be posted before it is given up on.
 *
 * Three, and the number matters less than the fact that there is one. A sweep
 * that reposts an expired task unconditionally re-buys a task DataForSEO will
 * never answer every twelve hours forever, which is worse than the 168 charges a
 * week this design exists to prevent. The fourth attempt is the one that never
 * happens: the job goes `dead` and the fetcher returns `pending` with a note
 * somebody can act on.
 */
const MAX_TASK_ATTEMPTS = 3;

/**
 * How long an item may go unannounced before it is polled BLIND anyway.
 *
 * ---- The cliff this exists for ---------------------------------------------
 *
 * `tasks_ready` is a DESTRUCTIVE READ retained for THREE DAYS; the results
 * themselves live for THIRTY. So the announcement is the perishable half and the
 * data is not, and a collector that polls only what it was told about turns a
 * lost announcement into a permanently uncollected result — which the expiry
 * sweep then RE-BUYS. The most expensive possible outcome of a free call being
 * missed.
 *
 * Two hours, against a Standard queue that answers in ~5 minutes and a
 * collection cron that runs every 10. Anything still unannounced after two hours
 * is either an announcement we lost (a crash between the read and the persist,
 * another process reading the list first, the 3-day cliff on a long-abandoned
 * id) or a task that failed without ever being listed. Both are collected for
 * free by asking directly.
 *
 * It is therefore the whole safety story of this phase: the ready set is an
 * OPTIMISATION over "poll everything", never a precondition for collecting. The
 * worst a broken `tasks_ready` can do is cost two hours of latency.
 */
const READY_GRACE_HOURS = 2;

/**
 * The collection-only cron.
 *
 * The hourly `'17 * * * *'` pass is what decides to BUY. This one only ever
 * collects work already paid for, which is why it can run six times as often:
 * DataForSEO's Standard queue answers in ~5 minutes and the hourly tick was
 * turning that into ~30 minutes of median latency for nothing.
 *
 * It cannot spend money BY CONSTRUCTION rather than by a flag — see
 * `collect.collectOnlyClient`, which refuses every endpoint that is not free at
 * the transport, and `collect.collectAllReady`, whose only inputs are rows that
 * are already `state: 'open'`.
 */
const COLLECT_CRON_EXPRESSION = '*/10 * * * *';

/**
 * How many ready ids one `tasks_ready` read may hand back.
 *
 * DataForSEO's own ceiling is 1000. A 200-keyword Site in two markets is 400
 * ids, so a busy shared account can genuinely fill this — and because the read
 * is destructive, an id left behind by a full page is simply announced on the
 * next read ten minutes later. Nothing is lost by the cap; the grace above
 * covers the pathological case where it never drains.
 */
const MAX_READY_IDS = 1000;

// ---------------------------------------------------------------------------
// Caps on a Site
// ---------------------------------------------------------------------------

/**
 * How many keywords one Site may track.
 *
 * 200 is the number the cost model in the plan is built on (25 clients x 200
 * keywords), and it is a COST ceiling rather than an API one: DataForSEO accepts
 * 100 tasks per `task_post` and would happily take a thousand keywords across
 * ten posts. The cap exists so a paste of a keyword-research export cannot
 * quietly multiply a month's spend by ten.
 */
const MAX_TRACKED_KEYWORDS = 200;

/** One keyword. DataForSEO's own ceiling is 700 characters. */
const MAX_KEYWORD_LENGTH = 200;

/**
 * How many (location, language, device) targets one Site may carry.
 *
 * Every target is a full re-collection of every keyword — eight targets is eight
 * times the bill, and there is no partial version of that. Four is the same
 * ceiling the first connector settled on for the same reason.
 */
const MAX_TARGETS = 4;

/** Competitors are a comparison set, not a crawl list. */
const MAX_COMPETITORS = 10;

/** A domain. 253 is the DNS ceiling. */
const MAX_DOMAIN_LENGTH = 253;

/**
 * The devices DataForSEO's SERP endpoints accept.
 *
 * Two, not three. Their `device` parameter documents `desktop` and `mobile`;
 * tablet is an `os`-level distinction that does not exist here, and offering it
 * in a picker would produce a target that every task_post rejects with a 40501.
 */
const DEVICES = ['desktop', 'mobile'];

/**
 * The two rank-tracking depths, and the single biggest cost lever in the
 * product.
 *
 * `depth` is a x1 multiplier per ten results, so 100 costs TEN TIMES what 10
 * costs. The settled answer is HYBRID rather than one or the other: the deep
 * census weekly buys the competitor-as-column matrix, the SERP-feature census
 * and cannibalization detection; the shallow daily check buys the movement
 * chart. Together they are ~$220/mo at 25 clients x 200 keywords, against $900
 * for daily-at-depth-100 and a movement chart with a week's resolution for
 * weekly-only.
 */
const DEPTH_CENSUS = 100;
const DEPTH_MOVEMENT = 10;

/**
 * The published price of one Standard SERP unit, in USD.
 *
 * A PLACEHOLDER WITH A KNOWN REPLACEMENT, and it is worth being explicit about
 * which. `/v3/appendix/user_data` returns the account's OWN price book — already
 * read once per pass and already stored on `ConnectorAccount.lastSeenQuota` —
 * and phase 3 estimates from that, so a reserve matches a settle. This constant
 * exists only so `DfsTask.estimateUsd` holds a number rather than a zero before
 * the budget document arrives to compare against it.
 *
 * DataForSEO moved these ~20% on 2026-07-01, which is the argument for reading
 * the live book rather than trusting any number written in a file.
 */
const SERP_UNIT_USD = 0.0006;

// ---------------------------------------------------------------------------
// Money — the ceiling, and the two switches that have to be thrown to go live
// ---------------------------------------------------------------------------

/**
 * The FALLBACK monthly ceiling for a workspace that has not set one, in USD, or
 * `null` for "no ceiling".
 *
 * ---- Why the default is null now rather than five --------------------------
 *
 * It was five dollars, chosen for the plan's "first live key runs here, on one
 * project, with a $5 cap". As a per-DEPLOYMENT default in a multi-tenant product
 * that number is a trap: every workspace would start capped at $5/month against
 * ITS OWN DataForSEO balance, stop collecting a few thousand keywords in, and
 * show a note about a cap its owner never set and cannot find. A silent ceiling
 * on somebody else's money is worse than no ceiling, because the failure reads
 * as a broken product rather than as a budget.
 *
 * So the ceiling is DATA now — `ConnectorAccount.monthlyCapUsd`, set by the
 * workspace owner in Settings beside the credential it bounds. Unset means
 * unlimited, and unlimited is the right default for the reason the removed
 * allowlist note gives: the tenant's own DataForSEO balance is the hard stop,
 * and they funded it themselves.
 *
 * `DATAFORSEO_MONTHLY_CAP_USD` survives for the SELF-HOSTED single-tenant case,
 * where the operator and the tenant are the same person and a deployment-wide
 * default is a reasonable thing to want. It is a fallback for a workspace that
 * has set nothing, never an override of one that has.
 *
 * The value is only ever read at `$setOnInsert` time, so changing it does not
 * move a month already in progress — a cap that silently rose because somebody
 * redeployed would be worse than no cap.
 *
 * @returns {number|null}
 */
const readCapUsd = () => {
  const asked = Number(process.env.DATAFORSEO_MONTHLY_CAP_USD);
  if (Number.isFinite(asked) && asked > 0) return asked;
  return null;
};

const DEFAULT_MONTHLY_CAP_USD = readCapUsd();

/**
 * ---- REMOVED: the per-project live allowlist -------------------------------
 *
 * There was a `DATAFORSEO_LIVE_PROJECTS` env var here — a set of project ids
 * cleared to post against the live host, where an EMPTY SET MEANT NOTHING MAY
 * POST. It was the "on one project" half of the plan's "first live key runs
 * here, on one project, with a $5 cap", and for that first controlled run it was
 * right.
 *
 * IT IS INCOMPATIBLE WITH A MULTI-TENANT PRODUCT, and not marginally so. Every
 * workspace connects ITS OWN DataForSEO key and spends ITS OWN balance, so
 * clearing a site to collect would mean an operator editing a deployment
 * variable and redeploying every time any customer added a domain. A tenant
 * cannot be asked to file a ticket to use the feature they just configured, and
 * an operator cannot be the bottleneck on every signup.
 *
 * WHAT AUTHORISES SPEND NOW: connecting the credential. A workspace that has
 * pasted its own API login is a workspace that has agreed to spend its own
 * money, and its DataForSEO balance is the hard ceiling that no code here can
 * exceed. That is the honest consent boundary for a SaaS, and it needs no
 * second switch.
 *
 * WHAT BOUNDS A RUNAWAY: `ConnectorAccount.monthlyCapUsd`, which is DATA the
 * workspace owner sets in Settings rather than a deployment variable — see
 * `DEFAULT_MONTHLY_CAP_USD` directly above and `./budget.js` `scopesFor`. The
 * distinction that matters: a cap protects against OUR bug spending THEIR money,
 * which is a real risk worth a ceiling; it is not a permission system, and it
 * must never be the thing that stops a correctly-configured tenant from working.
 */

/**
 * How long a task may hold a budget reservation before the reconciler takes it
 * back.
 *
 * Ten minutes. The reserve-post-settle sequence is three HTTP calls and takes
 * seconds, so anything still holding after ten minutes is a process that died —
 * and a reservation held by a dead process shrinks the month's budget until it
 * rolls over. Long enough that a slow post is never swept mid-flight; short
 * enough that a crash does not cost a day of collection.
 */
const RESERVATION_STALE_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Storing what was bought
// ---------------------------------------------------------------------------

/**
 * How many organic results are KEPT, as opposed to bought.
 *
 * Twenty, because that is what a rank table draws. Buying a hundred is
 * defensible — `rank_absolute` is only accurate to the depth you paid for, and
 * the competitor census, the SERP-feature census and cannibalization detection
 * all fall out of the deep crawl at no extra cost. Storing a hundred when the UI
 * shows twenty is not: it is five times the storage for a view nobody opens.
 *
 * `DfsSerpResult.storedCount` and `.truncated` are what stop that being a lie —
 * see the model header.
 */
const SERP_RENDER_DEPTH = 20;

/**
 * The size a single stored SERP body may not exceed, in bytes.
 *
 * Four megabytes against Mongo's sixteen, and the gap is the point: our
 * measurement covers the serialised `items` array, while the ceiling applies to
 * the whole BSON document plus its index entries. A quarter of the limit is a
 * margin no plausible SERP can cross by accident, and one that leaves the
 * failure mode "we noticed and stored a flag" rather than "the driver rejected
 * the write after the money was spent".
 */
const MAX_SERP_DOC_BYTES = 4 * 1024 * 1024;

/**
 * How long the bulky evidence is kept, in days.
 *
 * Ninety. The irreplaceable half — the rank — lives on `ConnectorSnapshot`
 * forever and is what a trend line is drawn from. This is the page as it looked,
 * which is worth keeping for an audit, a dispute or a client conversation, and
 * is not worth keeping for a year at 200 keywords x 25 clients x weekly.
 *
 * A pinned row sets `expiresAt` to null instead, and the TTL index skips it.
 */
const SERP_RETENTION_DAYS = 90;

// ---------------------------------------------------------------------------
// Phase 10 - Extras. Two new purchases, four screens that buy nothing at all.
//
// The shape of this phase is deliberately lopsided. Four of its six features
// (AI Visibility, Cannibalization, Client Reports, Alerts) add NO endpoint and
// NO kind: they are readings of data phases 2-8 already bought, which is what
// "the marginal API cost is ~zero" means and why they are cheap to switch on.
// Two of them buy something new, and both are named here with their price.
// ---------------------------------------------------------------------------

/**
 * Referring networks - the PBN signature per-link spam score misses.
 *
 * Phase 7 deferred this by name. It is the same referring-domain corpus grouped
 * by IP SUBNET rather than by hostname, and the reason it is a separate purchase
 * rather than a second reading of `referring_domains` is that the grouping
 * happens at DataForSEO's end: a subnet is not derivable from a hostname without
 * resolving every one of them ourselves.
 *
 * `network_address_type` is the whole of the decision. At `ip` it groups by a
 * single address, which is what a shared host looks like and is mostly noise; at
 * `subnet` it groups by the /24, which is what a private blog network looks like
 * when somebody bought a block and spread forty sites across it.
 */
const ENDPOINT_BACKLINKS_REFERRING_NETWORKS = 'backlinks/referring_networks/live';

/** `ip` or `subnet`. See above - `subnet` is the one that finds a PBN. */
const BACKLINKS_NETWORK_ADDRESS_TYPE = 'subnet';

/** Same reasoning as `BACKLINKS_REFERRING_DOMAINS_LIMIT`: it bounds the row, not the bill. */
const BACKLINKS_REFERRING_NETWORKS_LIMIT = 100;

/**
 * How many referring domains one subnet must carry before it is CALLED OUT.
 *
 * Three, and the number is a judgement rather than a measurement, so it is a
 * named constant that a test pins rather than a literal in a filter.
 *
 * Two domains on one /24 is a shared host - a reseller box, two customers of the
 * same VPS provider - and calling that a network would flag most of the honest
 * web. Three is where "somebody bought a block" starts being the likelier
 * explanation, and the screen still shows the COUNT rather than a verdict,
 * because the innocent explanation never stops existing.
 */
const TOXIC_NETWORK_MIN_DOMAINS = 3;

/**
 * The spam score at which a referring domain is called toxic on its own.
 *
 * DataForSEO's DOMAIN-level bands are 0-30 / 31-60 / 61-100 and this is the top
 * of the third one. It is the same threshold `backlinkRows.SPAM_BANDS` already
 * draws on the Backlinks screen, restated as a constant here because the toxic
 * report turns it from a colour into a RECOMMENDATION - and a recommendation
 * that puts a domain in a disavow file has to be traceable to a number somebody
 * can argue with.
 */
const TOXIC_SPAM_SCORE_MIN = 61;

/** The score at which a domain is worth SHOWING but not disavowing. */
const TOXIC_SPAM_SCORE_WATCH = 31;

/**
 * How many separate toxic signals a domain needs before the report suggests
 * disavowing it.
 *
 * TWO, and it is the whole reason `toxicity.js` scores rather than filters. A
 * disavow file is one of the few things in SEO that can make a site worse, and a
 * single signal is regularly innocent: a high spam score can be a legitimate site
 * on bad neighbours' infrastructure, a broken link is usually our own 404, and a
 * nofollow-only referrer is every forum on the internet. Two independent signals
 * landing on the same domain is a different claim.
 */
const TOXIC_DISAVOW_MIN_SIGNALS = 2;

/**
 * How many links from ONE domain make the placement templated rather than
 * editorial.
 *
 * Two hundred. It is the same arithmetic phase 7 used to decide the anchor cloud
 * is weighted by root domains: a link repeated across every page of a site is
 * one editorial decision wearing forty thousand hats. As a toxicity signal on
 * its own it is weak - plenty of legitimate partners and directories link
 * sitewide - which is exactly why it counts as ONE signal and never as a verdict.
 */
const TOXIC_SITEWIDE_LINKS = 200;

// ---------------------------------------------------------------------------
// Business Data - the FOURTH family, and the only one that is not about a site
// ---------------------------------------------------------------------------

/**
 * `my_business_info` - the whole Google Business Profile card in one live call.
 *
 * LIVE rather than queued, which is why this family needs no new transport at
 * all: it runs on `liveJob.runLiveJob` exactly as Labs and Backlinks do, and the
 * only new thing about it is the request vocabulary. A `task_post` variant
 * exists at a third of the price; it is not used, because the queued path buys
 * `tasks.js`/`ready.js`/`collect.js` machinery for a single weekly call on a kind
 * most Sites will never enable, and $0.0036 a week is not a reason to add a fifth
 * collector.
 *
 * The three fields that make this screen worth having are all on this one
 * response: `rating_distribution` (so the sentence is "your one-stars doubled"
 * rather than "the rating fell 0.1"), `place_topics` (Google's own review-mined
 * themes) and `people_also_search` (Google naming the competitive set).
 */
const ENDPOINT_BUSINESS_MY_BUSINESS_INFO = 'business_data/google/my_business_info/live';

/**
 * The published Business Data LIVE price, per REQUEST, in USD.
 *
 * An ESTIMATE ONLY, like every other price in this file - `liveJob` settles from
 * the envelope's own `cost`. There is no per-row component: one call returns one
 * business card, so `BUSINESS_ITEM_USD` is zero rather than absent, because a
 * missing item price would fall through `liveEstimateFor`'s `??` to `undefined`
 * and make the whole estimate `NaN`.
 */
const BUSINESS_TASK_USD = 0.0054;
const BUSINESS_ITEM_USD = 0;

/**
 * How many `people_also_search` and `place_topics` entries a snapshot keeps.
 *
 * Twenty each. Google returns a handful of both and there is no documented
 * ceiling, so the cap bounds a snapshot rather than expressing a product
 * decision - the same reasoning as `BACKLINKS_INTERNAL_LIST_LIMIT`.
 */
const BUSINESS_LIST_LIMIT = 20;

// ---------------------------------------------------------------------------
// AI Visibility and Cannibalization - both free, both read out of the SERP
// ---------------------------------------------------------------------------

/**
 * How many AI Overview reference domains one keyword's row carries.
 *
 * Twelve. The citation-source table answers "who does Google cite for our
 * keywords", which is an aggregate over the whole keyword set - so the row has to
 * carry the domains for the aggregate to be computable, and a cap is what keeps
 * 200 keywords a 50 KB snapshot rather than an unbounded one. Google's own AI
 * Overviews rarely cite more than about eight sources.
 *
 * IT IS NOT A RENDER LIMIT. The full reference list, in order, is in the stored
 * `DfsSerpResult` body for anybody who needs to audit one keyword.
 */
const AI_REFERENCES_PER_KEYWORD = 12;

/**
 * How many of OUR OWN ranking URLs one keyword's row carries.
 *
 * Five, and the number only matters for the cannibalization screen, which is a
 * report about a site having MORE THAN ONE url on one SERP. Two is the finding;
 * five is enough to show the shape of a bad one; a site with twelve URLs on one
 * query has a problem the sixth row would not have made clearer.
 */
const CANNIBAL_URLS_PER_KEYWORD = 5;

/**
 * `load_async_ai_overview` is deliberately NOT SENT, and this constant records
 * the decision rather than the flag.
 *
 * DataForSEO charge +1 base price for it, refunded when no AI Overview comes back
 * - so at a 40% hit rate it is about +$0.00024 a keyword, which on 200 keywords
 * weekly is real but small. What it buys is RELIABILITY of capture: without it,
 * an AI Overview that Google served asynchronously may be absent from the payload
 * even though a person would have seen one.
 *
 * It stays off because this phase's claim is that AI Visibility is free, and a
 * flag that silently doubles the SERP base price on the hit would make that claim
 * false without anything on the screen saying so. The screen says instead what it
 * can honestly say: this is the AI Overview that rode inside the rank payload we
 * had already bought. Turning it on is a purchase decision with its own estimate,
 * and it belongs beside `enable_browser_rendering` and `include_clickstream_data`
 * as a thing somebody opts into on purpose.
 */
const AI_OVERVIEW_ASYNC_LOAD = false;

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

/**
 * How far a keyword has to fall before anybody is told, in positions.
 *
 * Five, against a rank tracker whose daily kind is bought to depth 10 - so on
 * `movement` the largest possible drop that is not "left the top ten" is nine.
 * Below five is ordinary SERP noise on most queries, and an alert that fires on
 * noise is an alert people turn off, which is worse than no alert at all.
 */
const ALERT_RANK_DROP_MIN = 5;

/**
 * The position a keyword has to have been IN for a drop to be worth telling
 * anybody about.
 *
 * Twenty. A keyword falling from 74 to 91 is real and is not news; a keyword
 * falling from 3 to 12 is the phone call. Without this the alert fires mostly
 * about the long tail, where movement is largest and matters least.
 */
const ALERT_RANK_DROP_FROM_MAX = 20;

/**
 * How many keywords one notification NAMES before it starts counting.
 *
 * Three. The threshold is on the drop, not on the count - one keyword falling
 * out of the top three is news on its own - so what this bounds is the sentence:
 * a bell message is one line, and a list of forty keywords in it is unreadable.
 */
const ALERT_RANK_DROP_NAMED = 3;

/**
 * The share of referring domains that has to disappear between two readings
 * before it is called a loss rather than index churn.
 *
 * Five percent, AND an absolute floor beside it, because a percentage alone fires
 * constantly on a small profile (one lost link out of twelve is 8%) and never on
 * a large one (six hundred lost out of forty thousand is 1.5%). Both have to be
 * crossed.
 */
const ALERT_LOST_LINKS_SHARE = 0.05;
const ALERT_LOST_LINKS_MIN = 5;

/**
 * When the alert pass runs.
 *
 * Half past the hour, which is thirteen minutes after the buying pass
 * (`'17 * * * *'`) and out of phase with the ten-minute collector. It reads
 * snapshots and writes notifications; it contacts no provider and cannot spend,
 * which is why it is a plain cron rather than something hung off a client's
 * `runOnce`.
 */
const ALERT_CRON_EXPRESSION = '30 * * * *';

// ---------------------------------------------------------------------------
// Phase 11 - the cross-tenant SERP cache, and the measurement that gates it
//
// The plan's own line is "build this only if the measured hit rate justifies
// four structural complications", and the measurement could never happen,
// because nothing in phases 1-10 has ever run against a live account. So both
// halves ship: the measurement became durable and per-kind, and the cache ships
// BEHIND AN EMPTY ALLOWLIST. Turning it on is a deliberate per-workspace act.
//
// This allowlist stays an env var while `DATAFORSEO_LIVE_PROJECTS` was deleted,
// and the difference is who it protects. That one gated a tenant's use of their
// OWN key, so an operator holding it was a bottleneck on the product working at
// all. This one decides whether one workspace's paid SERP may be served to
// ANOTHER — a cross-tenant data-sharing decision that genuinely belongs to
// whoever runs the deployment, and that no tenant can make on its own behalf.
// ---------------------------------------------------------------------------

/**
 * Which organisations participate in the shared SERP cache. EMPTY MEANS NOBODY.
 *
 * ---- Why an allowlist rather than a boolean --------------------------------
 *
 * A cross-tenant cache is not a performance setting. It is a DATA-SHARING
 * ARRANGEMENT: one workspace's paid SERP body answers another workspace's
 * question, and the row that carries it names both of them. That is a decision
 * somebody makes per workspace, with a sentence in a contract behind it - not a
 * deployment-wide flag somebody flips to make a graph go down.
 *
 * So participation is symmetric and explicit. An org on this list both
 * CONTRIBUTES the bodies it buys and CONSUMES the bodies others contributed; an
 * org that is not on it neither reads nor writes, and cannot be read from. One
 * org on the list on its own is a cache that can never hit, which is the correct
 * behaviour for a cache nobody else has agreed to share.
 *
 * Empty is the default and means the whole feature is inert - no read, no write,
 * no collection touched. `serpCache.anyEnabled()` is what every call site checks
 * first, so with this unset the purchase path is byte-identical to phase 10.
 */
const readCacheOrgs = () =>
  new Set(
    String(process.env.DATAFORSEO_SERP_CACHE_ORGS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );

const SERP_CACHE_ORG_IDS = readCacheOrgs();

/**
 * How long a shared SERP body is kept, in hours.
 *
 * FORTY-EIGHT, and the number follows from the reuse rule rather than from a
 * storage budget. Safe reuse is SAME-`periodKey` ONLY - serving a six-day-old
 * SERP out of a rank tracker breaks the product's core claim - so a row is
 * already useless the moment its UTC day ends. Forty-eight hours is that day
 * plus a margin for a collection that lands after midnight, and nothing more.
 *
 * It is also a privacy property rather than only a cleanup: the shared corpus
 * cannot accumulate into a keyword archive spanning tenants, because it is never
 * more than about two days deep. That bounds the exposure a teardown has to
 * undo - but it is not a SUBSTITUTE for undoing it, which is why
 * `DfsSerpCache.orgs` is refcounted and `orgCascade` still pulls from it.
 */
const SERP_CACHE_TTL_HOURS = 48;

/**
 * How long the cache MEASUREMENT is kept, in days.
 *
 * Four hundred, which is a year plus a margin. The measurement is the thing the
 * decision is made from and it is ~200 bytes a row a day per (site, kind,
 * market); keeping it a year costs nothing and means the question can be asked
 * against a full seasonal cycle rather than against whatever the last month
 * happened to look like.
 */
const CACHE_PROBE_RETENTION_DAYS = 400;

/**
 * THE THRESHOLD. The hit rate at which building the cache is worth it.
 *
 * ---- Derived, not chosen ---------------------------------------------------
 *
 * A SERP unit at `depth: 100` costs `10 x $0.0006 = $0.006`; at `depth: 10` it
 * costs $0.0006. At the plan's recommended tier - 25 clients x 200 keywords, a
 * weekly census plus a daily movement check - that is ~$130/mo of `positions`
 * and ~$90/mo of `movement`, ~$220/mo of SERP in total. A hit rate H therefore
 * saves about `$220 x H` a month.
 *
 * The cache is not free either. It stores a FULL-DEPTH body per distinct
 * (keyword, market, day) - ~150 KB - for two days. At that tier the shared
 * corpus is on the order of 5,000 keyword-days resident, ~750 MB, which on
 * hosted Mongo is a real line of the bill. Below roughly 5-10% the cache
 * plausibly COSTS MORE THAN IT SAVES and the question is not close.
 *
 * Between 10% and 20% the saving is $22-44 a month. That is less than an hour of
 * engineering, against a permanent cross-tenant data path that has to be
 * re-reasoned every time the SERP collection path changes, and a compliance
 * position that has to be defended per workspace. Not a trade worth making.
 *
 * At 20% the saving is ~$44/mo, ~$528/yr, and it scales with tenant count in
 * BOTH factors at once - more tenants means more spend and a higher overlap
 * rate, so 20% observed is a floor rather than a ceiling.
 *
 * So: TWENTY PERCENT OF BILLABLE UNITS, PER KIND, over a 28-day window, and only
 * once `CACHE_MIN_OBSERVED_UNITS` have been observed - a rate read off nine
 * events is not a rate. Per kind because `movement` saves a tenth of what
 * `positions` saves per hit and Backlinks is one call per DOMAIN rather than one
 * per keyword per market, so an average across kinds describes none of them.
 */
const CACHE_HIT_RATE_THRESHOLD = 0.2;

/** The denominator below which the rate above is noise rather than evidence. */
const CACHE_MIN_OBSERVED_UNITS = 1000;

/** The window the rate is read over. Four weeks, so a weekly cadence has four goes. */
const CACHE_MEASUREMENT_WINDOW_DAYS = 28;

module.exports = {
  DEFAULT_MONTHLY_CAP_USD,
  SERP_CACHE_ORG_IDS,
  SERP_CACHE_TTL_HOURS,
  CACHE_PROBE_RETENTION_DAYS,
  CACHE_HIT_RATE_THRESHOLD,
  CACHE_MIN_OBSERVED_UNITS,
  CACHE_MEASUREMENT_WINDOW_DAYS,
  RESERVATION_STALE_MS,
  SERP_RENDER_DEPTH,
  MAX_SERP_DOC_BYTES,
  SERP_RETENTION_DAYS,
  SANDBOX_ORIGIN,
  LIVE_ORIGIN,
  API_ORIGIN,
  API_BASE,
  IS_SANDBOX,
  ENDPOINT_USER_DATA,
  ENDPOINT_SERP_TASK_POST,
  ENDPOINT_SERP_TASK_GET,
  ENDPOINT_SERP_TASKS_READY,
  ENDPOINT_SERP_ERRORS,
  ENDPOINT_WEBHOOK_RESEND,
  ENDPOINT_LABS_STATUS,
  ENDPOINT_LABS_KEYWORD_OVERVIEW,
  ENDPOINT_LABS_COMPETITORS_DOMAIN,
  ENDPOINT_LABS_DOMAIN_INTERSECTION,
  ENDPOINT_LABS_RELEVANT_PAGES,
  ENDPOINT_LABS_BING_BULK_KEYWORD_DIFFICULTY,
  LABS_TASK_USD,
  LABS_ITEM_USD,
  ENDPOINT_BACKLINKS_INDEX,
  ENDPOINT_BACKLINKS_SUMMARY,
  ENDPOINT_BACKLINKS_TIMESERIES,
  ENDPOINT_BACKLINKS_TIMESERIES_NEW_LOST,
  ENDPOINT_BACKLINKS_REFERRING_DOMAINS,
  ENDPOINT_BACKLINKS_ANCHORS,
  ENDPOINT_BACKLINKS_BULK_RANKS,
  BACKLINKS_DOFOLLOW_FILTER,
  BACKLINKS_STATUS_TYPE,
  BACKLINKS_STATUS_TYPES,
  BACKLINKS_RANK_SCALE,
  BACKLINKS_RANK_MAX,
  BACKLINKS_REFERRING_DOMAINS_LIMIT,
  BACKLINKS_ANCHORS_LIMIT,
  BACKLINKS_TIMESERIES_MONTHS,
  BACKLINKS_INDEX_EPOCH,
  BACKLINKS_TIMESERIES_GROUP,
  BACKLINKS_INTERNAL_LIST_LIMIT,
  BACKLINKS_TASK_USD,
  BACKLINKS_ITEM_USD,
  ENDPOINT_BACKLINKS_REFERRING_NETWORKS,
  BACKLINKS_NETWORK_ADDRESS_TYPE,
  BACKLINKS_REFERRING_NETWORKS_LIMIT,
  TOXIC_NETWORK_MIN_DOMAINS,
  TOXIC_SPAM_SCORE_MIN,
  TOXIC_SPAM_SCORE_WATCH,
  TOXIC_DISAVOW_MIN_SIGNALS,
  TOXIC_SITEWIDE_LINKS,
  ENDPOINT_BUSINESS_MY_BUSINESS_INFO,
  BUSINESS_TASK_USD,
  BUSINESS_ITEM_USD,
  BUSINESS_LIST_LIMIT,
  AI_REFERENCES_PER_KEYWORD,
  AI_OVERVIEW_ASYNC_LOAD,
  CANNIBAL_URLS_PER_KEYWORD,
  ALERT_RANK_DROP_MIN,
  ALERT_RANK_DROP_FROM_MAX,
  ALERT_RANK_DROP_NAMED,
  ALERT_LOST_LINKS_SHARE,
  ALERT_LOST_LINKS_MIN,
  ALERT_CRON_EXPRESSION,
  ENDPOINT_ONPAGE_TASK_POST,
  ENDPOINT_ONPAGE_SUMMARY,
  ENDPOINT_ONPAGE_PAGES,
  BROWSER_RENDERING_KEY,
  ONPAGE_JAVASCRIPT_KEY,
  ONPAGE_LOAD_RESOURCES_KEY,
  ONPAGE_KEYWORD_DENSITY_KEY,
  ONPAGE_MULTIPLIERS,
  ONPAGE_MAX_CRAWL_PAGES,
  ONPAGE_CRAWL_CONFIG,
  ONPAGE_PAGES_LIMIT,
  ONPAGE_PAGE_USD,
  ONPAGE_EXPIRY_HOURS,
  DB_BACKED_SIMULTANEOUS_CEILING,
  DB_BACKED_POOL_LIMIT,
  CLICKSTREAM_KEY,
  CLICKSTREAM_MULTIPLIER,
  MAX_LABS_KEYWORDS_PER_CALL,
  LABS_COMPETITOR_LIMIT,
  LABS_GAP_LIMIT,
  LABS_TOP_PAGES_LIMIT,
  MAX_GAP_COMPETITORS,
  READY_GRACE_HOURS,
  COLLECT_CRON_EXPRESSION,
  MAX_READY_IDS,
  MAX_TASKS_PER_POST,
  TASK_PRIORITY_STANDARD,
  POLL_CONCURRENCY,
  TASK_EXPIRY_HOURS,
  MAX_TASK_ATTEMPTS,
  DEPTH_CENSUS,
  DEPTH_MOVEMENT,
  SERP_UNIT_USD,
  STATUS_OK,
  STATUS_TASK_CREATED,
  STATUS_AUTH,
  STATUS_NO_FUNDS,
  STATUS_DAILY_COST_LIMIT,
  STATUS_MONEY_LIMIT,
  STATUS_RATE_LIMIT,
  STATUS_TOO_MANY_SIMULTANEOUS,
  STATUS_FORBIDDEN_ENDPOINT,
  STATUS_RESULTS_EXPIRED,
  STATUS_TASK_HANDED,
  STATUS_TASK_IN_QUEUE,
  STATUS_NO_SANDBOX_DATA,
  STATUS_INVALID_FIELD,
  STATUS_INTERNAL,
  STATUS_TIMEOUT,
  STATUS_TARGET_SLOW,
  HTTP_TIMEOUT_MS,
  RETRY_DELAYS_MS,
  MAX_TRACKED_KEYWORDS,
  MAX_KEYWORD_LENGTH,
  MAX_TARGETS,
  MAX_COMPETITORS,
  MAX_DOMAIN_LENGTH,
  DEVICES,
};
