const crypto = require('node:crypto');

const DfsTask = require('../../../models/DfsTask');
const DfsCacheProbe = require('../../../models/DfsCacheProbe');
const DfsSerpCache = require('../../../models/DfsSerpCache');
const C = require('./constants');
const P = require('./pricing');
const { normaliseSerpResult, aggregatePositions } = require('./normalise');
const { fitToCeiling, trimItems, storeSerpBodies } = require('./serpResults');

/**
 * PHASE 11 - the cross-tenant SERP cache, and the measurement that gates it.
 *
 * ---- Why both halves shipped, and why one of them is off -------------------
 *
 * The plan's rule was "build this only if the measured hit rate justifies four
 * structural complications". The gate is a measurement and the measurement could
 * not exist: outstanding item #1 is still open, nothing in phases 1-10 has ever
 * run against a live account, and a `console.log` on a dyno nobody reads is not
 * evidence anybody can act on. "Wait for the number" therefore means shipping
 * nothing forever, and "build it and switch it on" ships exactly the thing the
 * plan warned about.
 *
 * So: the measurement became FIRST-CLASS (`DfsCacheProbe`, per kind, durable,
 * drawn on Usage & Spend beside the threshold it is compared against), and the
 * cache is BUILT AND OFF. `DATAFORSEO_SERP_CACHE_ORGS` is empty by default and
 * empty means nobody - same shape and same spirit as
 * `DATAFORSEO_LIVE_PROJECTS`, where empty means nothing may post.
 *
 * ---- The four complications, and where each one is answered ----------------
 *
 * 1. `orgCascade` DELETES BY `organisation` AND A SHARED BODY CANNOT CARRY ONE.
 *    Answered by refcounting, in `DfsSerpCache.orgs` - a set of ids rather than
 *    a counter, because `$pull` is idempotent and `$inc: -1` is not. The
 *    compliance sentence is written out on the model, and it is a real decision
 *    rather than an omission: a shared row outlives a teardown only while another
 *    PARTICIPATING workspace is still asking the same question, and at most 48
 *    hours regardless.
 *
 * 2. THE FRESHNESS WINDOW EATS THE HIT RATE. Same-`periodKey` only, and NOT
 *    widened - the whole product claim of a rank tracker is that the number is
 *    from the day it says. `depth` is in the key too, which costs more hit rate
 *    (a depth-100 body could answer a depth-10 request) and is refused for the
 *    reason `comparability.js` already gives.
 *
 * 3. THE RACE. Two ways out, and this one is named: NO PRE-POST CLAIM. The cache
 *    is written at COLLECTION and read at POST, so a workspace that asks while
 *    another workspace's identical task is still in flight simply MISSES and buys
 *    its own - which costs exactly what today costs. A claim would convert those
 *    misses into hits and is the larger half of the achievable rate; it would
 *    also make org B's rank tracker wait on org A's task, for up to the twelve
 *    hours `TASK_EXPIRY_HOURS` allows, and leave it with a hole if org A's job
 *    goes `dead`. The decisive argument is not performance, it is that the
 *    support answer would be "your board is stuck because of another customer",
 *    and we are not allowed to say even that much - saying it IS complication 4.
 *    `DfsCacheProbe.openHits` counts what the claim would have bought, so the
 *    refusal can be revisited as arithmetic.
 *
 * 4. THE TIMING SIDE-CHANNEL. A shared cache makes "is anyone else tracking this
 *    keyword" observable by how fast an answer arrives. Three things close it,
 *    and the first is the one that matters:
 *
 *      A HUMAN CAN NEVER PROBE IT. `force` - the only way a person orders a
 *        collection on this provider, because the descriptor declares
 *        `forceRefetchIsFree: false` - BYPASSES THE CACHE ENTIRELY and buys. So
 *        the only actor that can observe a hit is a cron tick, and a cron tick
 *        has nobody to tell. Type a rival's keyword, press Refresh, and you have
 *        bought a SERP and learnt nothing.
 *      NOTHING IS LABELLED PER KEYWORD. No response, export, screen or field
 *        carries "this row came from the cache". The ledger reports an ORG-LEVEL
 *        count of units served, mixed across every keyword and market and rolled
 *        up by month, which cannot isolate one keyword.
 *      NO CROSS-TENANT IDENTITY IS EVER WRITTEN INTO A READABLE ROW. The probe
 *        stores a COUNT of other tenants and never a list, and `DfsSerpCache.orgs`
 *        is reachable only by the cascade.
 *
 *    What remains, stated rather than hidden: a participating workspace's monthly
 *    bill is lower than it would have been. That is an aggregate over hundreds of
 *    keywords and two kinds, and it is the price of the feature existing at all.
 *
 * ---- And the fifth thing, which is Phase 10's ------------------------------
 *
 * SERP ONLY. A shared backlink profile or Google Business Profile is not a public
 * search result, so the argument that makes this defensible does not extend to
 * them. `isCacheableKind` gates on `family === 'serp'` and on the two kinds whose
 * bodies land in `DfsSerpResult`, and a test asserts the other nine are refused.
 */

// ---------------------------------------------------------------------------
// The key
// ---------------------------------------------------------------------------

/**
 * The kinds a shared body may ever answer.
 *
 * `family === 'serp'` and nothing else. Phase 10 named the constraint: a shared
 * BACKLINK body is not a public search result, and neither is a GBP listing, so
 * the "SERP bodies are public" argument they are defensible under does not reach
 * them. Labs and OnPage fail for a second reason as well - Labs answers are a
 * database read whose freshness DataForSEO's own docs put at both "weekly" and
 * "30-90 days", and a crawl is of somebody's own website by definition.
 *
 * @param {Object} kind
 * @returns {boolean}
 */
const isCacheableKind = (kind) =>
  !!kind && kind.family === 'serp' && kind.transport === 'task';

/**
 * The cross-tenant identity of ONE keyword's SERP.
 *
 * ---- Why the array, and why keyword is last --------------------------------
 *
 * `JSON.stringify` over a fixed-order ARRAY rather than `canonicalJson` over an
 * object: an array needs no key sort to be canonical, JSON escaping makes the
 * encoding injective, and it keeps this module free of a require on `tasks.js`
 * (which is about to require this one). The only free-form field is the keyword
 * and it sits LAST, so no keyword containing a separator can alias into another
 * market's key.
 *
 * `domain` is deliberately absent - that is the whole point, two workspaces
 * tracking different sites want the same page - and so is `priority`, which is a
 * queue preference rather than a property of the answer.
 *
 * @param {Object} args
 * @returns {string}
 */
const cacheKeyFor = ({
  endpoint,
  depth,
  locationCode,
  languageCode,
  device,
  keyword,
}) =>
  crypto
    .createHash('sha256')
    .update(
      JSON.stringify([
        String(endpoint || ''),
        Number(depth) || 0,
        Number(locationCode) || 0,
        String(languageCode || 'any').toLowerCase(),
        String(device || 'desktop').toLowerCase(),
        String(keyword ?? ''),
      ])
    )
    .digest('hex');

/**
 * The market half of a key, read back off a `variantKeyFor` string.
 *
 * `sites.variantKeyFor` is `location|language|device` and it is the ONLY minter
 * of that string; parsing it here rather than re-deriving from the target is
 * what keeps a cache key and an anti-repost key talking about the same market.
 *
 * @param {string} variant
 * @returns {{locationCode: number, languageCode: string, device: string}}
 */
const marketFromVariant = (variant) => {
  const [loc, lang, device] = String(variant || '').split('|');
  return {
    locationCode: Number(loc) || 0,
    languageCode: String(lang || 'any').toLowerCase(),
    device: String(device || 'desktop').toLowerCase(),
  };
};

/** `YYYY-MM-DD` in UTC. The same day boundary `periodKeyFrom` uses. */
const dayKeyOf = (at) => new Date(at).toISOString().slice(0, 10);

/** Midnight UTC of the day `now` falls in. */
const startOfUtcDay = (now) => {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

// ---------------------------------------------------------------------------
// The switch
// ---------------------------------------------------------------------------

/**
 * Is the shared cache on for ANYBODY on this deployment?
 *
 * Checked first at every call site, before any query, so that with the allowlist
 * empty - the default - not one database round trip, not one extra byte carried
 * out of `pollJob`, and not one behavioural difference exists against phase 10.
 * That property is asserted directly in `serpCache.test.js` rather than argued.
 *
 * @returns {boolean}
 */
const anyEnabled = () => C.SERP_CACHE_ORG_IDS.size > 0;

/**
 * Is this workspace a participant?
 *
 * Symmetric by construction: the same answer gates reading and writing, so a
 * workspace cannot consume a corpus it does not contribute to, and cannot be
 * read from without being on the list itself.
 *
 * @param {any} organisation
 * @returns {boolean}
 */
const isEnabledFor = (organisation) =>
  anyEnabled() && C.SERP_CACHE_ORG_IDS.has(String(organisation ?? ''));

// ---------------------------------------------------------------------------
// The measurement
// ---------------------------------------------------------------------------

const round6 = (n) => Math.round((Number(n) || 0) * 1e6) / 1e6;

/**
 * Write one buying decision into the durable measurement.
 *
 * Upserted and INCREMENTED on `(project, kind, variant, day)`, so a forced
 * refresh and an hourly tick on the same day add up rather than overwrite. Never
 * throws: a measurement that can break a purchase is not worth taking, which is
 * the rule phase 2 set for the log line this replaces.
 *
 * @returns {Promise<boolean>} whether the row was written
 */
const recordProbe = async ({
  project,
  kind,
  variant,
  now,
  units,
  readyHits = 0,
  openHits = 0,
  otherOrgs = 0,
  covered = false,
  servedUnits = 0,
  unitUsd = undefined,
}) => {
  try {
    const periodKey = dayKeyOf(now);
    const servableUnits = covered ? units : 0;
    const perUnit = P.estimateUsdFor({ count: 1, depth: kind.depth, unitUsd });

    await DfsCacheProbe.updateOne(
      { project: project._id, kind: kind.key, variant, periodKey },
      {
        $setOnInsert: {
          organisation: project.organisation,
          account: project.account || null,
          project: project._id,
          provider: 'dataforseo',
          kind: kind.key,
          variant,
          periodKey,
          depth: kind.depth ?? null,
          expiresAt: new Date(
            new Date(now).getTime() + C.CACHE_PROBE_RETENTION_DAYS * 86_400_000
          ),
        },
        $inc: {
          probes: 1,
          units,
          readyHits,
          openHits,
          batches: 1,
          coveredBatches: covered ? 1 : 0,
          servableUnits,
          wouldSaveUsd: round6(servableUnits * perUnit),
          servedUnits,
          savedUsd: round6(servedUnits * perUnit),
        },
        $max: { otherOrgs, observedAt: new Date(now) },
      },
      { upsert: true }
    );
    return true;
  } catch (err) {
    console.warn(`[connectors/dataforseo] cache probe write failed: ${err.message}`);
    return false;
  }
};

/**
 * How many of these keywords somebody else already has, and under which rule.
 *
 * ---- What phase 2 measured, and why it was the wrong number ----------------
 *
 * `probeCacheHits` counted rows in `state: {$in: ['open','ready','done']}`, which
 * silently measures the CLAIM rule - it counts a keyword another tenant has
 * merely POSTED as a hit, when serving that needs the pre-post claim this phase
 * refused. So the single number in the log overstated what a cache without a
 * claim could deliver, by exactly the amount that is hardest to notice.
 *
 * Split here into three, all recorded:
 *
 *   `readyHits`  - collected, in hand, free to copy. THE STRICT RULE.
 *   `openHits`   - posted and not yet collected. Needs a claim. Not served.
 *   `covered`    - was the WHOLE batch ready? The shipped cache is all-or-nothing
 *                  per (project, kind, market), because a snapshot is one
 *                  measurement on one day and half-served/half-bought is two
 *                  measurements sharing one `collectedAt`.
 *
 * Never throws and never delays a post.
 *
 * @returns {Promise<{units:number, readyHits:number, openHits:number,
 *   otherOrgs:number, covered:boolean, wouldSaveUsd:number}|null>}
 */
const probe = async ({
  project,
  kind,
  variant,
  keywords,
  now,
  unitUsd = undefined,
  log = console.log,
}) => {
  const units = Array.isArray(keywords) ? keywords.length : 0;
  if (!units) return null;

  try {
    /**
     * Same UTC day only, which is the only reuse window that would be honest.
     * Bounded rather than exhaustive; `{kind, variant, postedAt}` has no index of
     * its own and this query runs once per purchase decision, which is once per
     * site per kind per market per cadence.
     */
    const rows = await DfsTask.find({
      kind: kind.key,
      variant,
      postedAt: { $gte: startOfUtcDay(now) },
      project: { $ne: project._id },
      state: { $in: ['open', 'ready', 'done'] },
    })
      .select('keywords organisation state')
      .limit(500)
      .lean();

    const wanted = new Set(keywords);
    const ready = new Set();
    const open = new Set();
    const orgs = new Set();

    for (const row of rows) {
      let touched = false;
      for (const kw of row.keywords || []) {
        if (!wanted.has(kw)) continue;
        touched = true;
        // `done` is a result in hand. `open`/`ready` is money spent and an answer
        // that has not arrived - a hit only for a design with a claim in it.
        if (row.state === 'done') ready.add(kw);
        else open.add(kw);
      }
      if (touched) orgs.add(String(row.organisation));
    }

    // A keyword that is both collected somewhere and in flight somewhere else is
    // a READY hit; counting it twice would inflate the union past the batch size.
    for (const kw of ready) open.delete(kw);

    const covered = ready.size === units;
    const result = {
      units,
      readyHits: ready.size,
      openHits: open.size,
      otherOrgs: orgs.size,
      covered,
      wouldSaveUsd: round6(
        (covered ? units : 0) * P.estimateUsdFor({ count: 1, depth: kind.depth, unitUsd })
      ),
    };

    await recordProbe({ project, kind, variant, now, unitUsd, ...result, covered });

    if (ready.size || open.size) {
      log(
        `[connectors/dataforseo] cache-probe kind=${kind.key} variant=${variant} ` +
          `asked=${units} alreadyBoughtToday=${ready.size + open.size} ` +
          `collectedToday=${ready.size} inFlightToday=${open.size} ` +
          `wholeBatch=${covered ? 'yes' : 'no'} ` +
          `byOtherTenants=${orgs.size} ` +
          `wouldSaveUsd=${result.wouldSaveUsd}`
      );
    }

    return result;
  } catch (err) {
    console.warn(`[connectors/dataforseo] cache probe failed: ${err.message}`);
    return null;
  }
};

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Contribute one collected SERP to the shared corpus. WRITE-THROUGH, best effort.
 *
 * Called from inside `pollJob`'s per-answer callback rather than from the batch's
 * end, and that is a memory decision with the same arithmetic behind it as the
 * trim: 200 keywords x ~150 KB of untrimmed body is 30 MB held at once if the
 * full arrays are carried to a writer at the end, against one body at a time
 * here. It is also the honest ordering - we paid for THIS keyword's SERP, and
 * publishing it does not depend on whether keyword 200 ever answers.
 *
 * Never throws. A shared-cache write that could lose a paid collection would be
 * a saving mechanism costing more than everything it could ever save.
 *
 * @returns {Promise<boolean>} whether a row was written
 */
const publish = async ({ organisation, kind, variant, keyword, row, collectedAt, now }) => {
  if (!isEnabledFor(organisation) || !isCacheableKind(kind)) return false;
  if (!collectedAt || !keyword) return false;

  try {
    const market = marketFromVariant(variant);
    const periodKey = dayKeyOf(collectedAt);
    const key = cacheKeyFor({
      endpoint: kind.getEndpoint,
      depth: kind.depth,
      ...market,
      keyword,
    });

    const items = Array.isArray(row?.items) ? row.items : [];
    /**
     * Measured against the same 4 MB ceiling `DfsSerpResult` uses, and for the
     * same reason: the failure that matters is a driver rejecting the write AFTER
     * the money was spent. Untrimmed, because a serving workspace's domain may
     * rank at 45 - see the model header.
     */
    const fitted = fitToCeiling(
      { items, storedCount: items.length, returnedCount: items.length, truncated: false },
      { maxBytes: C.MAX_SERP_DOC_BYTES }
    );

    await DfsSerpCache.updateOne(
      { cacheKey: key, periodKey },
      {
        $set: {
          keyword,
          locationCode: market.locationCode,
          languageCode: market.languageCode,
          device: market.device,
          depth: kind.depth ?? null,
          endpoint: kind.getEndpoint,
          collectedAt: new Date(collectedAt),
          items: fitted.items,
          itemTypes: Array.isArray(row?.item_types)
            ? row.item_types.filter((t) => typeof t === 'string')
            : [],
          seResultsCount: Number(row?.se_results_count) || null,
          bytes: fitted.bytes,
          oversized: fitted.oversized,
          expiresAt: new Date(
            new Date(now || collectedAt).getTime() + C.SERP_CACHE_TTL_HOURS * 3_600_000
          ),
        },
        $setOnInsert: { cacheKey: key, periodKey },
        // The refcount. `$addToSet` so a workspace collecting the same keyword in
        // two markets, or twice in a day, appears exactly once.
        $addToSet: { orgs: organisation },
      },
      { upsert: true }
    );
    return true;
  } catch (err) {
    if (err?.code === 11000) return false;
    console.warn(
      `[connectors/dataforseo] could not share the SERP body for "${keyword}": ${err.message}`
    );
    return false;
  }
};

/**
 * The `publish` callback `pollJob` takes, or NULL when the cache is off.
 *
 * Null is the default and is what makes "off is byte-identical" structural: with
 * no callback, `pollJob` carries no untrimmed body out of its poll loop at all,
 * so there is nothing extra allocated and nothing extra written.
 *
 * @returns {Function|null}
 */
const publisherFor = ({ project, kind, variant, now }) => {
  if (!isEnabledFor(project?.organisation) || !isCacheableKind(kind)) return null;
  return ({ keyword, row, collectedAt }) =>
    publish({
      organisation: project.organisation,
      kind,
      variant,
      keyword,
      row,
      collectedAt,
      now,
    });
};

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Every shared body that could answer this batch TODAY.
 *
 * @returns {Promise<{rows: Map<string, Object>, complete: boolean}>}
 */
const lookup = async ({ kind, variant, keywords, now }) => {
  const market = marketFromVariant(variant);
  const periodKey = dayKeyOf(now);
  const byKey = new Map();

  for (const keyword of keywords) {
    byKey.set(
      cacheKeyFor({
        endpoint: kind.getEndpoint,
        depth: kind.depth,
        ...market,
        keyword,
      }),
      keyword
    );
  }

  const found = await DfsSerpCache.find({
    cacheKey: { $in: [...byKey.keys()] },
    periodKey,
  }).lean();

  const rows = new Map();
  for (const row of found) {
    const keyword = byKey.get(row.cacheKey);
    // An oversized row stored an EMPTY body deliberately. It records that a
    // reading existed; it cannot answer anybody's rank, so it is not a hit.
    if (!keyword || row.oversized || !Array.isArray(row.items) || !row.items.length) continue;
    rows.set(keyword, row);
  }

  return { rows, complete: rows.size === keywords.length };
};

/**
 * Answer a whole batch out of the shared corpus, if it is entirely there.
 *
 * ---- Why all-or-nothing --------------------------------------------------
 *
 * A snapshot is ONE measurement of one market on one day. Serving half of it now
 * and buying the other half - which arrives hours later through the queue - is
 * two measurements in one row, and `collectedAt` would have to be one of them.
 * It would also need `pollJob`'s "a job is finished only when EVERY item has an
 * answer" rule to be taught about items that were never posted, which is a second
 * way for a row to become collected.
 *
 * The cost is recorded rather than hidden: `DfsCacheProbe.readyHits` is what a
 * partial-serving cache could reach and `servableUnits` is what this one can, so
 * "should we also build partial serving" is a later, separate, arithmetic
 * question.
 *
 * ---- What is written, and why it is the ordinary path ----------------------
 *
 * The bodies go through `normaliseSerpResult` and `aggregatePositions` - THE SAME
 * functions the paid path uses, so there is exactly one implementation of "SERP
 * items to a rank", and the AI Overview and cannibalization aggregates phase 10
 * added come out of the served reading for free. `DfsSerpResult` rows are written
 * for the serving workspace through `storeSerpBodies` unchanged, so its own
 * evidence, its own TTL and its own pinning behave as if it had bought them.
 *
 * A zero-cost `DfsTask` row is written in `state: 'done'` as the ledger entry.
 * Without it the collection would have happened with nothing in the money ledger
 * to say so, and `usage.js` would under-report what this board collected. It is
 * `done` rather than `open` deliberately - `open` is the state the partial unique
 * index covers, and a row that never posted has no business holding the
 * anti-repost claim.
 *
 * @returns {Promise<Object|null>} the fetch contract's shape, or null on a miss
 */
const serve = async ({ project, kind, variant, keywords, session, now }) => {
  if (!isEnabledFor(project?.organisation) || !isCacheableKind(kind)) return null;

  let hit;
  try {
    hit = await lookup({ kind, variant, keywords, now });
  } catch (err) {
    console.warn(`[connectors/dataforseo] cache lookup failed: ${err.message}`);
    return null;
  }

  if (!hit.complete) {
    // A miss is not an error and costs nothing but the lookup. The purchase
    // branch continues exactly as it would have.
    return null;
  }

  const rows = [];
  const bodies = [];
  let latest = null;

  for (const keyword of keywords) {
    const row = hit.rows.get(keyword);
    const payload = {
      keyword,
      items: row.items,
      item_types: row.itemTypes,
      se_results_count: row.seResultsCount,
    };
    rows.push(normaliseSerpResult(payload, { domain: project.domain, keyword }));

    const trimmed = trimItems(row.items, C.SERP_RENDER_DEPTH);
    bodies.push({
      keyword,
      items: trimmed.items,
      itemTypes: Array.isArray(row.itemTypes) ? row.itemTypes : [],
      returnedCount: trimmed.returnedCount,
      truncated: trimmed.truncated,
      trimmed: true,
      collectedAt: row.collectedAt || null,
    });

    const at = row.collectedAt ? new Date(row.collectedAt) : null;
    if (at && (!latest || at > latest)) latest = at;
  }

  if (!latest) return null;

  const periodKey = dayKeyOf(latest);
  const data = aggregatePositions(rows, {
    domain: project.domain,
    depth: kind.depth,
    collectedAt: latest,
  });

  /**
   * The ledger entry. `costUsd: 0`, `source: 'cache'`, and `budgetState: 'none'`
   * because no reservation was ever taken - there was nothing to reserve against.
   */
  let job = null;
  try {
    job = await DfsTask.create({
      organisation: project.organisation,
      account: project.account || session?.accountId || null,
      project: project._id,
      provider: 'dataforseo',
      kind: kind.key,
      variant,
      endpoint: kind.postEndpoint,
      source: 'cache',
      request: null,
      keywords,
      state: 'done',
      attempt: 1,
      budgetState: 'none',
      estimateUsd: 0,
      costUsd: 0,
      postedAt: now,
      readyAt: latest,
      closedAt: now,
      periodKey,
      note: `Collected from a shared reading of the same ${keywords.length} search results. Nothing was bought.`,
      items: [],
    });
  } catch (err) {
    // The ledger row is the audit trail, not the reading. Losing it must not
    // lose a collection that is already correct and already free.
    console.warn(`[connectors/dataforseo] cache ledger write failed: ${err.message}`);
  }

  try {
    await storeSerpBodies({
      project,
      job,
      kind,
      variant,
      periodKey,
      bodies,
      now,
    });
  } catch (err) {
    console.warn(
      `[connectors/dataforseo] could not store served SERP bodies for ${project.domain}: ${err.message}`
    );
  }

  /**
   * Register this workspace against every row it read, so the refcount that
   * `orgCascade` pulls from names everybody who has actually seen the body -
   * not only whoever paid for it.
   */
  try {
    await DfsSerpCache.updateMany(
      { _id: { $in: [...hit.rows.values()].map((r) => r._id) } },
      { $addToSet: { orgs: project.organisation }, $inc: { reads: 1 } }
    );
  } catch (err) {
    console.warn(`[connectors/dataforseo] cache refcount update failed: ${err.message}`);
  }

  await recordProbe({
    project,
    kind,
    variant,
    now,
    units: keywords.length,
    readyHits: keywords.length,
    openHits: 0,
    otherOrgs: 0,
    covered: true,
    servedUnits: keywords.length,
  });

  return {
    data,
    /** AGGREGATE ONLY, exactly as the paid path. See `collect.collectJob`. */
    raw: null,
    status: 'ok',
    /**
     * The note says a collection happened without a purchase and NAMES NO
     * KEYWORD and NO OTHER TENANT. It is the same sentence whatever was shared.
     */
    note: '',
    collectedAt: latest,
  };
};

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

/**
 * Has the measurement cleared the bar, for this kind?
 *
 * Three outcomes rather than two, because "not enough evidence yet" and "no" are
 * different answers and only one of them is a decision.
 *
 * @param {{units:number, servableUnits:number}} row
 * @returns {{verdict: 'insufficient'|'below'|'clears', rate: number|null,
 *   shortfallUnits: number}}
 */
const verdictFor = ({ units = 0, servableUnits = 0 } = {}) => {
  if (units < C.CACHE_MIN_OBSERVED_UNITS) {
    return {
      verdict: 'insufficient',
      rate: units > 0 ? Math.round((servableUnits / units) * 1000) / 1000 : null,
      shortfallUnits: C.CACHE_MIN_OBSERVED_UNITS - units,
    };
  }
  const rate = Math.round((servableUnits / units) * 1000) / 1000;
  return {
    verdict: rate >= C.CACHE_HIT_RATE_THRESHOLD ? 'clears' : 'below',
    rate,
    shortfallUnits: 0,
  };
};

/**
 * The measurement, rolled up PER KIND over the window, for `describeUsage`.
 *
 * Per kind and never averaged, which is phase 10's instruction and the reason
 * the collection carries `kind` at all: `movement` is bought at `depth: 10` and
 * saves a tenth of what `positions` saves per hit, so one blended percentage
 * would be a number about neither.
 *
 * @param {Object} args
 * @param {Array<Object>} args.projects
 * @returns {Promise<Object>}
 */
const summarise = async ({
  projects = [],
  windowDays = C.CACHE_MEASUREMENT_WINDOW_DAYS,
  now = new Date(),
} = {}) => {
  const shell = {
    /** Off unless somebody put an org id in `DATAFORSEO_SERP_CACHE_ORGS`. */
    enabled: anyEnabled(),
    windowDays,
    thresholdPct: Math.round(C.CACHE_HIT_RATE_THRESHOLD * 100),
    minUnits: C.CACHE_MIN_OBSERVED_UNITS,
    from: null,
    kinds: [],
    totals: { units: 0, readyHits: 0, openHits: 0, servableUnits: 0, servedUnits: 0 },
  };

  const projectIds = projects.map((p) => p._id).filter(Boolean);
  if (!projectIds.length) return shell;

  const from = dayKeyOf(new Date(now.getTime() - windowDays * 86_400_000));
  shell.from = from;

  let rows = [];
  try {
    rows = await DfsCacheProbe.find({
      project: { $in: projectIds },
      periodKey: { $gte: from },
    })
      .select(
        'kind depth units readyHits openHits batches coveredBatches servableUnits wouldSaveUsd servedUnits savedUsd otherOrgs'
      )
      .lean();
  } catch (err) {
    console.warn(`[connectors/dataforseo] cache summary failed: ${err.message}`);
    return shell;
  }

  const byKind = new Map();
  for (const row of rows) {
    if (!byKind.has(row.kind)) {
      byKind.set(row.kind, {
        kind: row.kind,
        depth: row.depth ?? null,
        units: 0,
        readyHits: 0,
        openHits: 0,
        batches: 0,
        coveredBatches: 0,
        servableUnits: 0,
        wouldSaveUsd: 0,
        servedUnits: 0,
        savedUsd: 0,
        otherOrgs: 0,
      });
    }
    const k = byKind.get(row.kind);
    k.units += row.units || 0;
    k.readyHits += row.readyHits || 0;
    k.openHits += row.openHits || 0;
    k.batches += row.batches || 0;
    k.coveredBatches += row.coveredBatches || 0;
    k.servableUnits += row.servableUnits || 0;
    k.wouldSaveUsd = round6(k.wouldSaveUsd + (row.wouldSaveUsd || 0));
    k.servedUnits += row.servedUnits || 0;
    k.savedUsd = round6(k.savedUsd + (row.savedUsd || 0));
    k.otherOrgs = Math.max(k.otherOrgs, row.otherOrgs || 0);
  }

  for (const k of byKind.values()) {
    Object.assign(k, verdictFor(k));
    /**
     * The upper bound a cache WITH partial serving and WITH a pre-post claim
     * could have reached. Carried beside the shipped rate so the two decisions
     * phase 11 took - all-or-nothing, and no claim - stay visible as choices with
     * a price rather than disappearing into one number.
     */
    k.ceilingRate = k.units
      ? Math.round(((k.readyHits + k.openHits) / k.units) * 1000) / 1000
      : null;
    shell.totals.units += k.units;
    shell.totals.readyHits += k.readyHits;
    shell.totals.openHits += k.openHits;
    shell.totals.servableUnits += k.servableUnits;
    shell.totals.servedUnits += k.servedUnits;
  }

  shell.kinds = [...byKind.values()].sort((a, b) => b.units - a.units);
  return shell;
};

module.exports = {
  cacheKeyFor,
  marketFromVariant,
  dayKeyOf,
  startOfUtcDay,
  isCacheableKind,
  anyEnabled,
  isEnabledFor,
  recordProbe,
  probe,
  publish,
  publisherFor,
  lookup,
  serve,
  verdictFor,
  summarise,
};
