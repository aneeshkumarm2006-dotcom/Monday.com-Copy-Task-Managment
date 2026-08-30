const C = require('./constants');
const T = require('./tasks');
const P = require('./pricing');
const { pending } = require('./collect');
const { runLiveJob, itemsOf } = require('./liveJob');
const N = require('./businessNormalise');

/**
 * Business Data — the fourth family, and the only one that is not about a site.
 *
 * ---- What is genuinely new here, and what is deliberately not --------------
 *
 * NEW: the subject. Every other kind in this provider is about a domain, a
 * market or a crawl. This one is about a PLACE — a Google Business Profile,
 * identified by a name in a location, with reviews and photos and opening hours
 * and no URL that has to be involved at all.
 *
 * NOT NEW: everything else. It is `transport: 'live'` and it runs on
 * `liveJob.runLiveJob` unchanged — the claim under the partial unique index, the
 * reservation after the claim, the settle from the envelope's own `cost`. Phase
 * 6 predicted a second live family would need "no new machinery", phase 7 proved
 * it for Backlinks, and this is the third time it has held. What phase 7 had to
 * change was the FILE (a function with "Labs" in its name importing into
 * `backlinks.js`), and that has already been paid for.
 *
 * ---- Why live and not `task_post`, when the queued one is a third the price --
 *
 * `business_data/google/my_business_info/task_post` is $0.0015 against
 * $0.0054 live. On a weekly kind that is a saving of about sixteen cents a year
 * per Site, and what it costs is a fifth collector: a family entry in
 * `TASK_RUNNERS`, a `collectorFor` entry, a plan seam in `postJob`, two more
 * ALLOWLIST entries and a poller that understands a payload shape nothing else
 * in the codebase reads. That is the wrong trade, and naming the number is what
 * makes it a decision rather than an oversight.
 *
 * ---- The `requires` gate, and why this one actually works ------------------
 *
 * `kinds.js` records at length that `planProjectWork` gates on
 * `project[kind.requires]` being truthy and that AN EMPTY ARRAY IS TRUTHY, so
 * `requires: 'trackedKeywords'` never protected anything. `businessName` is a
 * STRING, and an empty string is falsy — so this is the one kind in the catalog
 * where the gate does what a reader assumes it does, and a Site that has not
 * named a business never buys a Maps lookup for a domain that may not have a
 * storefront at all.
 *
 * That gate is doing real work. Extras are switched on per BOARD through
 * `enabledScreens`, which is free and local — but `BoardConnector.kinds` is
 * unioned across boards and an empty selection means everything, so a kind with
 * no gate is bought for every Site the day it lands. For a domain-shaped kind
 * that is defensible. For a Maps lookup against a business that does not exist
 * it is money spent on a guaranteed empty answer.
 */

/**
 * What we ask Google for.
 *
 * The Site's `businessName` verbatim — a name, a `cid:...` or a `place_id:...`,
 * all three of which `my_business_info` accepts. NOT the domain: a domain query
 * against Maps returns whatever Google's fuzzy match decides, and the failure
 * mode is a card for a DIFFERENT BUSINESS that then gets stored, charted and
 * put in front of a client. An empty answer is recoverable; a confident wrong
 * one is not.
 *
 * @param {Object} project
 * @returns {{query: string, note: string}}
 */
const businessQueryFor = (project) => {
  const query = String(project?.businessName || '').trim();
  if (!query) {
    return {
      query: '',
      note:
        'This site has no business name, so there is no Google Business Profile ' +
        'to read. Add one to the site under Add-ons to switch this on.',
    };
  }
  return { query: query.slice(0, 200), note: '' };
};

/**
 * Every request one Business Data collection sends, as data.
 *
 * ONE call. There is no second half here the way `backlinks_summary` has a
 * dofollow call — `my_business_info` returns the rating, the distribution, the
 * topics and the competitive set in one response, which is what makes this the
 * cheapest screen in the phase that buys anything at all.
 *
 * @param {Object} args
 * @returns {{requests: Array<Object>, note: string, query: string}}
 */
const planBusinessRequests = ({ kind, project, variant }) => {
  const { query, note } = businessQueryFor(project);
  if (!query) return { requests: [], note, query: '' };

  return {
    query,
    note: '',
    requests: [
      {
        label: query,
        endpoint: kind.endpoint,
        /**
         * ONE row. Business Data live bills per REQUEST with no per-item
         * component, so this number only ever multiplies zero — it is carried
         * because `liveEstimateFor`'s shape takes it and a missing `rows` would
         * read as an omission rather than as "there is no row price".
         */
        rows: 1,
        payload: {
          keyword: query,
          location_code: variant.locationCode,
          language_code: variant.languageCode,
        },
      },
    ],
  };
};

/** What one Business Data request reserves against the monthly cap. */
const businessEstimateFor = ({ request, quota }) =>
  P.liveEstimateFor({
    quota,
    endpoint: request.endpoint,
    rows: request.rows,
    multiplier: 1,
    publishedTaskUsd: C.BUSINESS_TASK_USD,
    /**
     * ZERO rather than absent. `liveEstimateFor` resolves the item price with
     * `??`, so `undefined` here would make the whole estimate `NaN` — and a
     * `NaN` estimate compares false against every cap, which is a budget check
     * that silently passes.
     */
    publishedItemUsd: C.BUSINESS_ITEM_USD,
  }).estimateUsd;

/**
 * Turn the raw answer into the snapshot body.
 *
 * `found: false` IS A RESULT. A business name that matches nothing returns an
 * empty item list and a perfectly successful call, and that has to be stored as
 * a reading rather than reported as a failure — otherwise the fetcher answers
 * `pending`, `writeSnapshot` stores nothing, and the next hourly tick re-buys
 * the same empty answer forever because there is no `existing` snapshot for
 * `rebuyGuard` to refuse against. A stored miss costs one snapshot and stops the
 * loop; naming the query on it is what tells somebody why.
 */
const aggregateFor = (kind, results, { query, collectedAt }) => {
  const first = results.find((r) => !r.error && r.rows?.length) || null;
  const profile = first ? N.normaliseBusinessInfo(first.rows[0]) : null;
  return N.aggregateBusinessProfile(profile, { query, collectedAt });
};

/**
 * Collect the Business Profile kind for one Site.
 *
 * The same `{data, raw, status, note, collectedAt}` contract every other fetcher
 * in this provider returns. `snapshotService` must not learn there is a fourth
 * family.
 *
 * @param {Object} kind
 * @param {Object} ctx
 * @returns {Promise<Object>}
 */
const runBusinessKind = async (kind, ctx) => {
  const { project, client, session, now = new Date() } = ctx;
  const variant = ctx.variant?.key || '';

  const { requests, note, query } = planBusinessRequests({
    kind,
    project,
    variant: ctx.variant || {},
  });
  if (!requests.length) return pending(note);

  /**
   * THE BUDGET STOP, before anything that can spend and before a database round
   * trip — the same per-run flag, on the same account-scoped client, for the
   * same reason `labs.js` and `backlinks.js` check it here: a thrown
   * `quotaExhausted` would `break` `syncAccount`'s project loop and strand every
   * remaining project's FREE collection of results already paid for.
   */
  if (typeof client?.postingSuppressed === 'function' && client.postingSuppressed()) {
    return pending(client.postingSuppressedNote() || 'Monthly budget reached.');
  }

  /** An open row is a LOCK held for the seconds one call takes, not a job. */
  const open = await T.findOpenJob({ project, kind, variant });
  if (open) {
    const expired = open.expiresAt && new Date(open.expiresAt).getTime() <= now.getTime();
    if (!expired) return pending('This collection is already running.');
    const { attempt, dead } = await T.expireJob(open, { now });
    if (dead) {
      return pending(
        `This business profile collection has failed ${attempt} times and will not be ` +
          'bought again automatically. Press Refresh and confirm to try once more.'
      );
    }
  }

  const outcome = await runLiveJob({
    session,
    client,
    project,
    kind,
    variant,
    requests,
    now,
    estimateFor: businessEstimateFor,
    rowsOf: itemsOf,
    /** One unit per call. A business profile is a card, not a keyword list. */
    unitsOf: (r) => [r.label],
  });

  if (outcome.capped && typeof client?.suppressPosting === 'function') {
    client.suppressPosting(outcome.note);
  }
  if (!outcome.ok) return pending(outcome.note);

  const data = aggregateFor(kind, outcome.results, {
    query,
    collectedAt: outcome.collectedAt,
  });

  const notes = [
    note,
    outcome.note,
    data.found
      ? ''
      : `Google returned no business profile for "${query}". Check the name, or use ` +
        'a "cid:" or "place_id:" value from the listing itself.',
  ].filter(Boolean);

  return {
    data,
    raw: null,
    status: outcome.failures?.length ? 'partial' : 'ok',
    note: notes.join(' '),
    collectedAt: outcome.collectedAt,
  };
};

module.exports = {
  businessQueryFor,
  planBusinessRequests,
  businessEstimateFor,
  aggregateFor,
  runBusinessKind,
};
