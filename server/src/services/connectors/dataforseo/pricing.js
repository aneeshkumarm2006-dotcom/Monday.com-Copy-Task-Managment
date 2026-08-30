const C = require('./constants');

/**
 * What a job will cost, from the ACCOUNT'S OWN price book.
 *
 * ---- Why the published price list is not good enough ------------------------
 *
 * Phase 2 shipped `estimateUsd` as `SERP_UNIT_USD x keywords x depth/10` against
 * a number typed into `constants.js`, and said so: a placeholder with a known
 * replacement. Two things make the replacement necessary rather than tidy.
 *
 * DataForSEO moved their SERP prices ~20% on 2026-07-01. A cap enforced against
 * a stale constant is a cap enforced against the wrong number, and it fails in
 * the direction that costs money — an estimate 20% low reserves 20% too little
 * and lets 20% more work through the gate than the ceiling allows.
 *
 * And their price book is ACCOUNT-SPECIFIC. Volume pricing, promotional rates
 * and endpoint entitlements are all per account, so there is no published number
 * that is correct for us; there is only the one they hand back.
 *
 * `/v3/appendix/user_data` returns exactly that, is free, and is already read
 * once per account per pass and written to `ConnectorAccount.lastSeenQuota` by
 * `client.accountData()`. This file spends nothing: it reads what is already
 * there.
 *
 * ---- Estimation, never a gate ----------------------------------------------
 *
 * `lastSeenQuota` is documented "display only; never a gate", and that status is
 * KEPT. Nothing here can stop a sync. The gate is `ConnectorBudget`, which is
 * computed from our own ledger — a provider balance we last read six days ago
 * must never be able to authorise a purchase, and a number we misread out of an
 * undocumented shape must never be able to refuse one. What the price book buys
 * is that reserve ~= settle, which is what makes a cap mean what it says.
 *
 * ---- And why an unreadable book is a WARNING and not an error ---------------
 *
 * The shape of `price` is not fully documented and their own examples disagree
 * about its depth. A resolver that threw on a shape it did not recognise would
 * turn a cosmetic uncertainty into a total collection outage. So it falls back
 * to the published constant, loudly and once, and the settle corrects the ledger
 * from the provider's own per-task `cost` regardless.
 */

/** Money, to the cent-of-a-cent DataForSEO actually bills in. */
const round6 = (n) => Math.round((Number(n) || 0) * 1e6) / 1e6;

/** A positive finite number, or null. Zero is not a price; it is a missing one. */
const positive = (value) => {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * The names DataForSEO uses for the queue tier, best first.
 *
 * `standard` is priority 1 and `priority` is priority 2 at double the price —
 * we always post standard (see `C.TASK_PRIORITY_STANDARD`), so `standard` is
 * what we look for. The rest are the names that appear at the same level in
 * other families, listed so a book that nests one level differently still
 * resolves rather than falling through to the fallback.
 */
const TIER_KEYS = ['standard', 'priority', 'regular', 'advanced', 'html'];

/**
 * Pull a number out of whatever the price book put at the end of the path.
 *
 * Three shapes are handled and the third is the honest one. A leaf may be a
 * number; it may be an object keyed by queue tier; or it may be an object keyed
 * by something we have never seen — a device, an SE type, a region. In the third
 * case the MINIMUM positive number under it is taken, and minimum is the right
 * choice rather than a lazy one: every dimension we do not model multiplies the
 * price (priority is x2, browser rendering is x34, operators are x5 each), so
 * the smallest number in the subtree is the base rate and the base rate is what
 * a standard, operator-free, unrendered SERP costs.
 *
 * Bounded to three levels so a pathological book cannot walk a large object.
 *
 * @param {any} node
 * @param {number} [depthLeft]
 * @returns {number|null}
 */
const readLeaf = (node, depthLeft = 3) => {
  const direct = positive(node);
  if (direct !== null) return direct;
  if (!node || typeof node !== 'object' || Array.isArray(node) || depthLeft <= 0) {
    return null;
  }

  for (const key of TIER_KEYS) {
    const hit = positive(node[key]);
    if (hit !== null) return hit;
  }

  let best = null;
  for (const value of Object.values(node)) {
    const found = readLeaf(value, depthLeft - 1);
    if (found !== null && (best === null || found < best)) best = found;
  }
  return best;
};

/**
 * The unit price of one task on one endpoint, or null.
 *
 * The endpoint IS the path: `serp/google/organic/task_post` is
 * `price.serp.google.organic.task_post`. That is DataForSEO's own arrangement
 * and it is why the endpoint constants are stored as slash-joined strings rather
 * than as objects — the same string addresses the API and its price.
 *
 * @param {any} priceBook - `ConnectorAccount.lastSeenQuota.price`
 * @param {string} endpoint
 * @returns {number|null}
 */
const nodeAt = (priceBook, endpoint) => {
  if (!priceBook || typeof priceBook !== 'object') return null;

  let node = priceBook;
  for (const segment of String(endpoint || '').split('/')) {
    if (!segment) continue;
    if (!node || typeof node !== 'object') return null;
    node = node[segment];
  }
  return node ?? null;
};

const unitPriceFor = (priceBook, endpoint) => readLeaf(nodeAt(priceBook, endpoint));

/** So the fallback warning is one line per process, not one per post. */
let warnedAboutPriceBook = false;

/**
 * The unit price to estimate with, and where it came from.
 *
 * @param {Object} args
 * @param {any} [args.quota] - `ConnectorAccount.lastSeenQuota`, from the session
 * @param {string} args.endpoint
 * @returns {{unitUsd: number, source: 'account'|'published'}}
 */
const resolveUnitPrice = ({ quota, endpoint, warn = console.warn }) => {
  const fromAccount = unitPriceFor(quota?.price, endpoint);
  if (fromAccount !== null) return { unitUsd: fromAccount, source: 'account' };

  if (!warnedAboutPriceBook) {
    warnedAboutPriceBook = true;
    warn(
      `[connectors/dataforseo] no account price found for "${endpoint}"; estimating ` +
        `at the published $${C.SERP_UNIT_USD}/unit. The budget still settles on ` +
        "DataForSEO's own reported cost."
    );
  }
  return { unitUsd: C.SERP_UNIT_USD, source: 'published' };
};

/**
 * `depth` is a x1 multiplier PER TEN RESULTS.
 *
 * The single biggest cost lever in the product: `depth: 100` costs ten times
 * `depth: 10`, which is the whole reason rank tracking is two kinds on two
 * clocks rather than one. Rounded UP, because DataForSEO charges for the band
 * and not for the results it happened to find.
 */
const depthMultiplier = (depth) => Math.max(1, Math.ceil((Number(depth) || 10) / 10));

/**
 * What this job is expected to cost.
 *
 * @param {Object} args
 * @param {number} args.count - keywords in the batch
 * @param {number} args.depth
 * @param {number} [args.unitUsd] - from `resolveUnitPrice`
 * @returns {number}
 */
const estimateUsdFor = ({ count, depth, unitUsd = C.SERP_UNIT_USD }) =>
  round6(Number(count || 0) * depthMultiplier(depth) * (positive(unitUsd) ?? C.SERP_UNIT_USD));

// ---------------------------------------------------------------------------
// Labs — two prices per call, and neither of them is what gets recorded
// ---------------------------------------------------------------------------

/**
 * The names a price book might use for the per-REQUEST half of a Labs price.
 *
 * Read as an explicit list rather than through `readLeaf`, and the difference is
 * a real bug rather than a stylistic one. `readLeaf` takes the MINIMUM number in
 * a subtree, which is exactly right for SERP — every dimension we do not model
 * (priority x2, rendering x34, operators x5) multiplies upward, so the smallest
 * number is the base rate. Applied to a Labs leaf holding BOTH prices it returns
 * $0.00012, the per-item figure, and calls it the price of the request: a
 * hundred-fold under-estimate, silently, in the direction that under-reserves.
 */
const LABS_TASK_KEYS = ['task', 'request', 'base', 'call'];

/** And the per-ROW half. Labs bills per returned item on top of the request. */
const LABS_ITEM_KEYS = ['item', 'row', 'result', 'keyword'];

const firstPositive = (node, keys) => {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
  for (const key of keys) {
    const hit = positive(node[key]);
    if (hit !== null) return hit;
  }
  return null;
};

/**
 * What one Labs call is expected to cost, and where each half came from.
 *
 * ---- The rule this function is written under -------------------------------
 *
 * AN ESTIMATE IS NEVER WHAT GETS RECORDED. Every number here feeds one thing:
 * the reservation the monthly cap is checked against, taken before the call. The
 * ledger is settled afterwards from the envelope's own `cost` — DataForSEO's
 * account of what it actually charged — in `labs.js`.
 *
 * That is what makes an unknown price survivable rather than blocking, and it is
 * the direct answer to the plan's outstanding item #4. Labs BING pricing is
 * genuinely unpublished: their pricing page renders as a nav shell and the only
 * figure anywhere is a search snippet. A design that hardcoded a number would be
 * wrong by however much the snippet is wrong, permanently and invisibly. This
 * one reserves against the higher GOOGLE tier — so an unknown price can only
 * ever over-reserve, never under — and then records the truth from the response.
 *
 * ---- Why an absent price book is a fallback and not an error ---------------
 *
 * Same reason as `resolveUnitPrice`: the shape of `price` is not fully
 * documented, and a resolver that threw on a shape it did not recognise would
 * turn a cosmetic uncertainty into a total collection outage.
 *
 * @param {Object} args
 * @param {any} [args.quota] - `ConnectorAccount.lastSeenQuota`
 * @param {string} args.endpoint
 * @param {number} args.rows - how many items the request asks for (`limit`)
 * @param {number} [args.multiplier] - `include_clickstream_data` doubles it
 * @returns {{estimateUsd: number, taskUsd: number, itemUsd: number,
 *   source: 'account'|'published'}}
 */
const liveEstimateFor = ({
  quota,
  endpoint,
  rows = 0,
  multiplier = 1,
  publishedTaskUsd,
  publishedItemUsd,
}) => {
  const node = nodeAt(quota?.price, endpoint);
  const taskFromAccount = firstPositive(node, LABS_TASK_KEYS);
  const itemFromAccount = firstPositive(node, LABS_ITEM_KEYS);

  const taskUsd = taskFromAccount ?? publishedTaskUsd;
  const itemUsd = itemFromAccount ?? publishedItemUsd;
  const source = taskFromAccount !== null ? 'account' : 'published';

  const factor = Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1;
  const count = Math.max(0, Math.floor(Number(rows) || 0));

  return {
    estimateUsd: round6((taskUsd + itemUsd * count) * factor),
    taskUsd,
    itemUsd,
    source,
  };
};

const labsEstimateFor = ({ quota, endpoint, rows = 0, multiplier = 1 }) =>
  liveEstimateFor({
    quota,
    endpoint,
    rows,
    multiplier,
    publishedTaskUsd: C.LABS_TASK_USD,
    publishedItemUsd: C.LABS_ITEM_USD,
  });

/**
 * What one Backlinks call is expected to cost.
 *
 * The same two-part shape as Labs and the same rule above it — an estimate is
 * never what gets recorded, `liveJob` settles from the envelope's own `cost` —
 * with one difference worth naming, because it inverts what a `limit` is FOR.
 *
 * Labs bills $0.012 a request and $0.00012 a row, so a thousand rows is ten
 * times the request price and `limit` is the cost control. Backlinks bills
 * $0.024 a request and $0.000036 a row, capped at a thousand rows — so the
 * WHOLE of the row charge at maximum is $0.036 against a $0.024 request, and
 * halving a limit saves fractions of a cent. On this API the number of CALLS is
 * the bill, which is why the Backlinks kinds are split by what they draw rather
 * than by how much of it they fetch, and why the row limits are set by what a
 * snapshot should hold rather than by what it should cost.
 *
 * @param {Object} args
 * @param {any} [args.quota] - `ConnectorAccount.lastSeenQuota`
 * @param {string} args.endpoint
 * @param {number} args.rows
 * @returns {{estimateUsd: number, taskUsd: number, itemUsd: number,
 *   source: 'account'|'published'}}
 */
const backlinksEstimateFor = ({ quota, endpoint, rows = 0 }) =>
  liveEstimateFor({
    quota,
    endpoint,
    rows,
    multiplier: 1,
    publishedTaskUsd: C.BACKLINKS_TASK_USD,
    publishedItemUsd: C.BACKLINKS_ITEM_USD,
  });

// ---------------------------------------------------------------------------
// OnPage - a third shape again: per PAGE, at post, with a refund
// ---------------------------------------------------------------------------

/**
 * What the crawl configuration multiplies the base per-page price by.
 *
 * ---- Why the largest wins rather than the product --------------------------
 *
 * `enable_browser_rendering` SUBSUMES `enable_javascript` and `load_resources`:
 * DataForSEO price a browser-rendered crawl at $0.0051 a page whether or not the
 * other two are also set, because rendering a page in a browser necessarily
 * executes its JavaScript and loads its resources. Multiplied together the three
 * would give 34 x 10 x 3 = 1,020x, which is a hundredfold over-reservation - and
 * an estimate that is too HIGH is not harmless here: the monthly cap is checked
 * against it, so it would refuse collections the ceiling actually allows.
 *
 * @param {Object} config - the crawl configuration
 * @returns {number}
 */
const crawlMultiplier = (config) => {
  const source = config && typeof config === 'object' ? config : {};
  let factor = 1;
  for (const [key, multiplier] of Object.entries(C.ONPAGE_MULTIPLIERS)) {
    if (source[key] === true && multiplier > factor) factor = multiplier;
  }
  return factor;
};

/**
 * What one crawl is expected to cost.
 *
 * ---- Reserved against the CEILING, settled against the TRUTH ----------------
 *
 * DataForSEO bill per page ACTUALLY crawled, and refund the rest of the budget.
 * A forty-page site posted with `max_crawl_pages: 1000` is charged for forty.
 *
 * So the estimate is deliberately the pessimistic one - the whole budget - and
 * it is what the monthly cap is checked against, because at the moment of the
 * check nobody knows how large the site is. The ledger is then corrected from
 * the envelope's own `cost` at settle, exactly as it is for Labs and Backlinks,
 * which is what makes the refund land in our accounts without anybody computing
 * it. Reserving the expected forty cents rather than the possible fifteen would
 * be an estimate that under-reserves on precisely the site that runs away.
 *
 * @param {Object} args
 * @param {any} [args.quota] - `ConnectorAccount.lastSeenQuota`
 * @param {string} args.endpoint
 * @param {number} args.pages - `max_crawl_pages`, the ceiling and not a guess
 * @param {Object} [args.config] - the crawl configuration, for the multiplier
 * @returns {{estimateUsd: number, pageUsd: number, multiplier: number,
 *   source: 'account'|'published'}}
 */
const onpageEstimateFor = ({ quota, endpoint, pages = 0, config = null }) => {
  const fromAccount = unitPriceFor(quota?.price, endpoint);
  const pageUsd = fromAccount ?? C.ONPAGE_PAGE_USD;
  const multiplier = crawlMultiplier(config);
  const count = Math.max(0, Math.floor(Number(pages) || 0));

  return {
    estimateUsd: round6(count * pageUsd * multiplier),
    pageUsd,
    multiplier,
    source: fromAccount !== null ? 'account' : 'published',
  };
};

/**
 * The quota the session is carrying, if it carries one.
 *
 * ---- Why this reads the SESSION and not the account row --------------------
 *
 * `syncAccount` loads the `ConnectorAccount` document and hands it to
 * `openSession`, so the price book is ALREADY IN MEMORY by the time a fetcher
 * runs. Reading it off the session costs nothing; re-reading the row would add a
 * database round trip per post, and calling `user_data` again would burn one of
 * six requests a minute for a number `client.accountData()` wrote on the way in.
 *
 * The book is therefore as fresh as the last pass that touched this account,
 * which is the correct staleness for the job: DataForSEO moves prices about once
 * a year, an estimate is corrected at settle by their own per-task `cost`, and
 * the alternative costs a call per post forever to avoid an error measured in
 * fractions of a cent.
 *
 * @param {Object} session
 * @returns {any|null}
 */
const quotaFromSession = (session) => {
  if (typeof session?.getQuota !== 'function') return null;
  try {
    return session.getQuota();
  } catch {
    // A session that cannot answer must never be able to stop a collection.
    return null;
  }
};

module.exports = {
  round6,
  readLeaf,
  nodeAt,
  unitPriceFor,
  resolveUnitPrice,
  depthMultiplier,
  estimateUsdFor,
  liveEstimateFor,
  labsEstimateFor,
  backlinksEstimateFor,
  crawlMultiplier,
  onpageEstimateFor,
  quotaFromSession,
  LABS_TASK_KEYS,
  LABS_ITEM_KEYS,
};
