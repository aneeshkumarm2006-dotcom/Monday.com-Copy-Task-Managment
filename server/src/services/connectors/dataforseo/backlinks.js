const C = require('./constants');
const T = require('./tasks');
const P = require('./pricing');
const { pending } = require('./collect');
const { runLiveJob, itemsOf, singleOf } = require('./liveJob');
const N = require('./backlinksNormalise');

/**
 * DataForSEO Backlinks — the link index, bought live.
 *
 * ---- What this file is, in one line ----------------------------------------
 *
 * Four kinds' worth of request shapes and three metric traps, running on
 * `liveJob.runLiveJob` — the same claim, reservation, call, settle and close
 * that phase 6's Labs pack runs on, extracted into its own file the day a second
 * family needed it.
 *
 * There is NO Backlinks limiter here, and that is deliberate. DataForSEO's
 * 30-simultaneous ceiling is ONE ceiling shared by Labs, Backlinks and OnPage,
 * and `client.send` already routes every `backlinks/…` call through
 * `pool.withDbBackedSlot` — the prefix has been in `DB_BACKED_PREFIXES` since
 * phase 6, before this file existed. A limiter here would be a second twenty-five
 * beside phase 6's, which is fifty in flight against a ceiling of thirty and a
 * storm of `40209`s spread across a shared credential. This family inherits the
 * bound by making a call at all.
 *
 * ---- The three traps, and where each one is actually prevented -------------
 *
 * 1. `rank` IS 0-1000 AND IS NOT DA OR DR — prevented in
 *    `backlinksNormalise.js` (two field names that cannot be confused) and in
 *    the client's `backlinkRows.js` (which never routes it through
 *    `formatRank`). What this file contributes is `rank_scale` sent EXPLICITLY
 *    on every request that takes it, so the scale is a decision recorded in the
 *    request rather than a default somebody could change under a stored series.
 *
 * 2. `*_nofollow` IS NOT THE COMPLEMENT OF DOFOLLOW — prevented HERE, and only
 *    here, because it is a request-shape problem rather than a parsing one. The
 *    `backlinks_summary` kind plans TWO `summary` calls, the second carrying
 *    `backlinks_filters: ['dofollow', '=', true]`, and the normaliser is built
 *    so that it has no way to synthesise the answer if this file forgets to ask
 *    for it. See `planBacklinksRequests`.
 *
 * 3. `backlinks_status_type` RECOMPUTES THE AGGREGATES — prevented by there
 *    being exactly one value, in `constants.js`, sent on every request that
 *    accepts it and stored on every snapshot. This file's contribution is that
 *    it is applied UNIFORMLY: a collection whose summary was taken under `live`
 *    and whose timeseries was taken under `all` would put two incompatible
 *    numbers on one screen, and the test for this asserts across every kind at
 *    once rather than per request.
 *
 * ---- And the one thing Backlinks does NOT share with Labs ------------------
 *
 * THE WORD LIVE. Labs is a database whose age DataForSEO's own documentation
 * describes as both "weekly" and "30-90 days", so every Labs panel is captioned
 * "competitive index" and stamped with `date_update`. The backlink index is
 * rebuilt continuously — ~8.7 billion pages crawled a day, ~2 second turnaround,
 * and DataForSEO's own list of live-only families includes it. So this screen is
 * allowed to say live, with one caveat it also says out loud: the PER-DOMAIN
 * recrawl interval is undocumented, so "live index" is a claim about the index
 * and not a promise about any single row in it.
 */

// ---------------------------------------------------------------------------
// What a Backlinks kind asks for
// ---------------------------------------------------------------------------

/**
 * The base every Backlinks request carries.
 *
 * ---- Why `backlinks_status_type` is here and not on each request ------------
 *
 * Because the failure it prevents is a MIXTURE, not an omission. One request
 * built without it still returns a perfectly good answer — under `live`, the
 * default — and the bug only exists once a second request is built with a
 * different value and the two numbers land on one screen. A shared base is the
 * only shape in which "they all agree" is true by construction rather than by
 * four call sites happening to say the same thing.
 *
 * @param {string} target - the domain
 * @returns {Object}
 */
const baseFor = (target) => ({
  target,
  /** ONE corpus for every number in one collection. See the file header. */
  backlinks_status_type: C.BACKLINKS_STATUS_TYPE,
});

/** The two-day-key window a timeseries call asks for. */
const timeseriesWindow = (now) => {
  const to = new Date(now.getTime());
  const from = new Date(
    Date.UTC(to.getUTCFullYear(), to.getUTCMonth() - C.BACKLINKS_TIMESERIES_MONTHS, 1)
  );
  const asked = from.toISOString().slice(0, 10);
  /**
   * CLAMPED, not trusted. `timeseries_summary` has nothing before 2019-01-30,
   * and a `date_from` earlier than that is not an error — it is a request that
   * quietly returns fewer buckets than asked for, which then reads as a site
   * with no history rather than as an index with no history.
   */
  return {
    from: asked < C.BACKLINKS_INDEX_EPOCH ? C.BACKLINKS_INDEX_EPOCH : asked,
    to: to.toISOString().slice(0, 10),
  };
};

/**
 * The targets whose OWN authority is worth one flat request price.
 *
 * Our domain first, then every competitor the Site carries. `bulk_ranks` bills
 * $0.024 per request and $0.000036 per row, so eleven targets and one target
 * cost the same $0.024 to within a thousandth of a cent — which is why this
 * takes the whole competitor list rather than the three a gap report can afford.
 *
 * @param {Object} project
 * @returns {string[]}
 */
const rankTargets = (project) => {
  const domain = String(project?.domain || '').trim().toLowerCase();
  const out = [];
  const seen = new Set();
  for (const raw of [domain, ...(Array.isArray(project?.competitors) ? project.competitors : [])]) {
    const host = String(raw || '').trim().toLowerCase();
    if (!host || seen.has(host)) continue;
    seen.add(host);
    out.push(host);
    if (out.length >= C.MAX_COMPETITORS + 1) break;
  }
  return out;
};

/**
 * Every request one Backlinks collection sends, as data.
 *
 * ---- The one that is easy to ship wrong ------------------------------------
 *
 * `backlinks_summary` plans TWO `summary` calls against the same target, and the
 * second one is not a nicety. `referring_domains_nofollow` counts domains
 * sending AT LEAST ONE nofollow link, so it overlaps `referring_domains` rather
 * than partitioning it, and the subtraction everybody reaches for
 * (`referring_domains - referring_domains_nofollow`) understates the dofollow
 * count by however many of our referrers link more than once. Nothing in the
 * payload reveals the error and nothing on the screen would look wrong.
 *
 * The filtered call costs the same flat $0.024 as the first and answers the
 * question directly. It is labelled `dofollow` here and read by that label in
 * `aggregateFor`, so removing it does not silently fall back to arithmetic — it
 * makes the number null, which renders as an em dash.
 *
 * @param {Object} args
 * @param {Object} args.kind
 * @param {Object} args.project
 * @param {Date} args.now
 * @returns {{requests: Array<Object>, note: string, window: Object|null}}
 */
const planBacklinksRequests = ({ kind, project, now = new Date() }) => {
  const domain = String(project?.domain || '').trim().toLowerCase();
  if (!domain) {
    return {
      requests: [],
      note: 'This site has no domain, so there is no backlink profile to read.',
      window: null,
    };
  }

  const base = baseFor(domain);

  if (kind.key === 'backlinks_summary') {
    const targets = rankTargets(project);
    return {
      note: '',
      window: null,
      requests: [
        {
          label: 'profile',
          endpoint: C.ENDPOINT_BACKLINKS_SUMMARY,
          rows: 1,
          /** ONE object, not a list — see `liveJob.singleOf`. */
          rowsOf: singleOf,
          payload: {
            ...base,
            /**
             * FREE DONUTS. This is what populates `referring_links_tld`,
             * `_types`, `_attributes`, `_platform_types`, `_semantic_locations`
             * and `_countries`, inside a call already being made. Without it
             * they come back empty and the same information costs six more
             * calls.
             */
            internal_list_limit: C.BACKLINKS_INTERNAL_LIST_LIMIT,
            /** Explicit, so the stored series cannot change scale silently. */
            rank_scale: C.BACKLINKS_RANK_SCALE,
            /**
             * A client's links point at every host they have ever used. Counting
             * only the bare domain reports a fraction of the profile and moves
             * the moment somebody adds a subdomain.
             */
            include_subdomains: true,
          },
        },
        {
          /**
           * THE SECOND CALL. Not a subtraction. See the block above — this is
           * the whole of trap 2.
           */
          label: 'dofollow',
          endpoint: C.ENDPOINT_BACKLINKS_SUMMARY,
          rows: 1,
          rowsOf: singleOf,
          payload: {
            ...base,
            internal_list_limit: C.BACKLINKS_INTERNAL_LIST_LIMIT,
            rank_scale: C.BACKLINKS_RANK_SCALE,
            include_subdomains: true,
            backlinks_filters: [...C.BACKLINKS_DOFOLLOW_FILTER],
          },
        },
        {
          /**
           * THE ONLY DOMAIN AUTHORITY IN THE PRODUCT. `referring_domains.rank`
           * is a different measurement and is never used for this.
           */
          label: 'authority',
          endpoint: C.ENDPOINT_BACKLINKS_BULK_RANKS,
          rows: targets.length,
          payload: { targets, rank_scale: C.BACKLINKS_RANK_SCALE },
        },
      ],
    };
  }

  if (kind.key === 'backlinks_timeseries') {
    const window = timeseriesWindow(now);
    return {
      note: '',
      window,
      requests: [
        {
          label: 'levels',
          endpoint: C.ENDPOINT_BACKLINKS_TIMESERIES,
          rows: C.BACKLINKS_TIMESERIES_MONTHS,
          payload: {
            ...base,
            date_from: window.from,
            date_to: window.to,
            group_range: C.BACKLINKS_TIMESERIES_GROUP,
            rank_scale: C.BACKLINKS_RANK_SCALE,
            include_subdomains: true,
          },
        },
        {
          /**
           * The FLOWS beside the levels. New and lost are computed relative to
           * `date_from`, which is why the window travels onto the snapshot — the
           * same month's "new backlinks" is a different number under a different
           * start date and there is no way to tell from the series.
           */
          label: 'new_lost',
          endpoint: C.ENDPOINT_BACKLINKS_TIMESERIES_NEW_LOST,
          rows: C.BACKLINKS_TIMESERIES_MONTHS,
          payload: {
            target: domain,
            date_from: window.from,
            date_to: window.to,
            group_range: C.BACKLINKS_TIMESERIES_GROUP,
            include_subdomains: true,
          },
        },
      ],
    };
  }

  if (kind.key === 'referring_domains') {
    return {
      note: '',
      window: null,
      requests: [
        {
          label: domain,
          endpoint: C.ENDPOINT_BACKLINKS_REFERRING_DOMAINS,
          rows: C.BACKLINKS_REFERRING_DOMAINS_LIMIT,
          payload: {
            ...base,
            limit: C.BACKLINKS_REFERRING_DOMAINS_LIMIT,
            /**
             * Ordered by the rank of the links each domain SENDS US, which is
             * the right ordering for "which of these links matter" and is NOT
             * the domains' own authority. The column is named and labelled
             * accordingly; see `backlinksNormalise.normaliseReferringDomain`.
             */
            order_by: ['rank,desc'],
            internal_list_limit: C.BACKLINKS_INTERNAL_LIST_LIMIT,
            include_subdomains: true,
          },
        },
      ],
    };
  }

  if (kind.key === 'referring_networks') {
    return {
      note: '',
      window: null,
      requests: [
        {
          label: domain,
          endpoint: C.ENDPOINT_BACKLINKS_REFERRING_NETWORKS,
          rows: C.BACKLINKS_REFERRING_NETWORKS_LIMIT,
          payload: {
            ...base,
            /**
             * SUBNET, and it is the entire reason this request exists.
             *
             * At `ip` the endpoint groups by a single address, which is what a
             * shared host looks like and is mostly noise. At `subnet` it groups
             * by the /24 — which is what somebody buying a block and spreading
             * forty sites across it looks like, and is the one signal that
             * per-link spam scoring structurally cannot see, because forty
             * individually clean sites carry forty clean spam scores.
             */
            network_address_type: C.BACKLINKS_NETWORK_ADDRESS_TYPE,
            limit: C.BACKLINKS_REFERRING_NETWORKS_LIMIT,
            /**
             * Ordered by how many referring domains sit on the block, because
             * that IS the finding. Ordered by `rank` instead — the obvious
             * copy-paste from the referring-domains request above — the first
             * page would be the strongest links rather than the most
             * concentrated ones, and the report would answer a question nobody
             * asked.
             */
            order_by: ['referring_domains,desc'],
            include_subdomains: true,
          },
        },
      ],
    };
  }

  if (kind.key === 'anchors') {
    return {
      note: '',
      window: null,
      requests: [
        {
          label: domain,
          endpoint: C.ENDPOINT_BACKLINKS_ANCHORS,
          rows: C.BACKLINKS_ANCHORS_LIMIT,
          payload: {
            ...base,
            limit: C.BACKLINKS_ANCHORS_LIMIT,
            /**
             * BY ROOT DOMAINS, never by backlinks. One sitewide footer link
             * repeated across forty thousand pages would otherwise be the whole
             * anchor profile — forty thousand backlinks carrying one anchor that
             * exactly one person chose.
             */
            order_by: ['referring_main_domains,desc'],
            include_subdomains: true,
          },
        },
      ],
    };
  }

  return {
    requests: [],
    note: `No Backlinks request is defined for "${kind.key}".`,
    window: null,
  };
};

// ---------------------------------------------------------------------------
// The free footnote
// ---------------------------------------------------------------------------

/**
 * How big the live link index is. FREE, once per account per pass.
 *
 * Memoised on the client through `runOnce` — the same seam `tasks_ready`,
 * `dataforseo_labs/status` and the reservation reconciler use, and for the same
 * reason: `syncAccount` builds exactly one client per account.
 *
 * A failure here is a NULL and never an error. It is a footnote on a panel that
 * reads the same without it, and failing a collection about to be paid for
 * because a free caption endpoint was unavailable would be the most expensive
 * possible reading of "be careful about provenance".
 *
 * @param {Object} client
 * @returns {Promise<Object|null>}
 */
const backlinksIndex = async (client) => {
  if (typeof client?.runOnce !== 'function') return null;

  return client.runOnce('backlinks-index', async () => {
    const answer = await client.call(C.ENDPOINT_BACKLINKS_INDEX, null, { method: 'GET' });
    const task = answer.tasks.find((t) => t.ok) || answer.tasks[0] || null;
    const row = Array.isArray(task?.result) ? task.result[0] : task?.result;
    return N.normaliseIndex(row);
  });
};

// ---------------------------------------------------------------------------
// The snapshot body
// ---------------------------------------------------------------------------

/** The result carrying a given request label, or null. */
const byLabel = (results, label) =>
  results.find((r) => r.request.label === label && !r.error) || null;

/**
 * Turn the raw Backlinks answers into the snapshot body for this kind.
 *
 * @param {Object} kind
 * @param {Array<Object>} results - from `runLiveJob`
 * @param {Object} ctx
 * @returns {Object}
 */
const aggregateFor = (kind, results, { project, collectedAt, index = null, window = null }) => {
  const domain = project.domain || null;

  if (kind.key === 'backlinks_summary') {
    const profileResult = byLabel(results, 'profile');
    const dofollowResult = byLabel(results, 'dofollow');
    const authorityResult = byLabel(results, 'authority');

    return N.aggregateSummary({
      domain,
      collectedAt,
      index,
      profile: profileResult?.rows?.[0] ? N.normaliseSummary(profileResult.rows[0]) : null,
      /**
       * NULL WHEN THE SECOND CALL FAILED, and there is deliberately no fallback
       * branch. An em dash is an honest "we did not get it"; a subtraction would
       * be a number that is wrong by an unknowable amount and looks exactly like
       * a right one.
       */
      dofollow: dofollowResult?.rows?.[0]
        ? N.normaliseSummary(dofollowResult.rows[0])
        : null,
      authority: (authorityResult?.rows || []).map(N.normaliseBulkRank),
    });
  }

  if (kind.key === 'backlinks_timeseries') {
    return N.aggregateTimeseries({
      domain,
      collectedAt,
      from: window?.from || null,
      to: window?.to || null,
      levels: (byLabel(results, 'levels')?.rows || []).map(N.normaliseTimeseriesPoint),
      flows: (byLabel(results, 'new_lost')?.rows || []).map(N.normaliseTimeseriesPoint),
    });
  }

  if (kind.key === 'referring_domains') {
    return N.aggregateReferringDomains(
      results.flatMap((r) => r.rows.map(N.normaliseReferringDomain)),
      { domain, collectedAt }
    );
  }

  if (kind.key === 'referring_networks') {
    return N.aggregateReferringNetworks(
      results.flatMap((r) => r.rows.map(N.normaliseReferringNetwork)),
      { domain, collectedAt }
    );
  }

  if (kind.key === 'anchors') {
    return N.aggregateAnchors(
      results.flatMap((r) => r.rows.map(N.normaliseAnchor)),
      { domain, collectedAt }
    );
  }

  return { domain, collectedAt };
};

// ---------------------------------------------------------------------------
// The fetch contract
// ---------------------------------------------------------------------------

/** What one Backlinks request reserves against the monthly cap. */
const backlinksEstimateFor = ({ request, quota }) =>
  P.backlinksEstimateFor({
    quota,
    endpoint: request.endpoint,
    rows: request.rows,
  }).estimateUsd;

/**
 * Collect one Backlinks kind for one Site.
 *
 * Returns the same `{data, raw, status, note, collectedAt}` contract
 * `snapshotService` already reads off the SERP and Labs fetchers — the generic
 * engine must not learn that this provider has three request families.
 *
 * `raw` is null for the reason it is null on both the other sides: the body
 * stored on `ConnectorSnapshot.data` is already the shape a screen draws, and a
 * hundred referring domains with their six breakdown maps each is not
 * irreplaceable evidence the way a stored SERP is.
 *
 * @param {Object} kind
 * @param {Object} ctx - `snapshotService`'s fetch context
 * @returns {Promise<Object>}
 */
const runBacklinksKind = async (kind, ctx) => {
  const { project, client, session, now = new Date() } = ctx;
  const variant = ctx.variant?.key || '';

  const { requests, note, window } = planBacklinksRequests({ kind, project, now });
  if (!requests.length) return pending(note);

  /**
   * THE BUDGET STOP, before anything that can spend and before a database round
   * trip. Set by an earlier project in this pass whose reservation the cap
   * refused; a per-run flag rather than a thrown `quotaExhausted`, because the
   * throw would `break` `syncAccount`'s project loop and strand every remaining
   * project's free SERP collection.
   */
  if (typeof client?.postingSuppressed === 'function' && client.postingSuppressed()) {
    return pending(client.postingSuppressedNote() || 'Monthly budget reached.');
  }

  /**
   * An open row means another process is mid-call on this exact collection.
   *
   * On the SERP side an open row is a job to POLL. Here, as on Labs, it is a
   * lock that should only ever be held for the seconds one HTTP call takes — so
   * a row still open past `expiresAt` is a crash, and it is retired rather than
   * waited on.
   */
  const open = await T.findOpenJob({ project, kind, variant });
  if (open) {
    const expired = open.expiresAt && new Date(open.expiresAt).getTime() <= now.getTime();
    if (!expired) return pending('This collection is already running.');
    const { attempt, dead } = await T.expireJob(open, { now });
    if (dead) {
      return pending(
        `This backlink collection has failed ${attempt} times and will not be bought ` +
          'again automatically. Press Refresh and confirm to try once more.'
      );
    }
  }

  /**
   * The free footnote, read before the purchase.
   *
   * Before rather than after, so a collection that fails still leaves the index
   * size memoised for the next kind in the same pass, and so the number on the
   * panel describes the index the data came out of.
   */
  const index = await backlinksIndex(client).catch(() => null);

  const outcome = await runLiveJob({
    session,
    client,
    project,
    kind,
    variant,
    requests,
    now,
    estimateFor: backlinksEstimateFor,
    /** Most Backlinks endpoints answer with `result[0].items`; `summary` does not. */
    rowsOf: itemsOf,
    /** One unit per call — a Backlinks request buys a report, not a keyword list. */
    unitsOf: (r) => [r.label],
  });

  if (outcome.capped && typeof client?.suppressPosting === 'function') {
    client.suppressPosting(outcome.note);
  }
  if (!outcome.ok) return pending(outcome.note);

  const data = aggregateFor(kind, outcome.results, {
    project,
    collectedAt: outcome.collectedAt,
    index: index || null,
    window,
  });

  const notes = [note, outcome.note].filter(Boolean);

  return {
    data,
    raw: null,
    status: outcome.failures?.length ? 'partial' : 'ok',
    note: notes.join(' '),
    collectedAt: outcome.collectedAt,
  };
};

module.exports = {
  baseFor,
  timeseriesWindow,
  rankTargets,
  planBacklinksRequests,
  backlinksIndex,
  backlinksEstimateFor,
  aggregateFor,
  runBacklinksKind,
};
