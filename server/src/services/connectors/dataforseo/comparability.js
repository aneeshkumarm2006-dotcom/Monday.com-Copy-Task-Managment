/**
 * May two readings of the same kind be put beside each other as a change?
 *
 * ---- Why this exists on the SERVER, on a provider descriptor ---------------
 *
 * Phases 7 and 8 each shipped a version of this on the client
 * (`client/src/utils/backlinkRows.js` and `client/src/utils/auditRows.js`)
 * because each shipped a screen that draws deltas, and both return a REASON
 * rather than a boolean so the panel can print it.
 *
 * A goal is the same subtraction with no panel around it. `config.baseline` is
 * filled from the reading before the month and `actual` from the newest one
 * inside it, and `goalTypes.js` then divides one by the other — so a goal
 * charting "health score over time" across a crawl-size change is a chart of our
 * own settings, on the one surface where there is no caption to read and nobody
 * looking for one. That is the trap phase 8 exists to stop, arriving through the
 * back door.
 *
 * So the rule has to be asked BEFORE the value is written, which means it has to
 * be answerable without a browser. `connectorGoalWriteback` asks the descriptor
 * (`connector.comparability(kind, current, previous)`); a provider that declares
 * none is treated as always comparable, which is what every provider was before
 * this existed.
 *
 * ---- The honest cost, stated rather than hidden ---------------------------
 *
 * The rule now exists twice — here and in those two client files — and this
 * codebase says elsewhere that two implementations of a rule agree until they
 * quietly do not. There is no shared module between the two packages and no
 * build step that could make one, so the mitigation is that the SHAPE is
 * identical (`{ok, reason}`), the thresholds are named constants rather than
 * literals, and this header names its counterparts. If the two ever disagree,
 * THIS one is the stricter half by construction: a refusal here costs a blank
 * starting point, and a refusal there costs a missing delta on a screen that
 * says why.
 *
 * ---- Three grounds for the audit, and only the first is the config ---------
 *
 * A CHANGED CONFIG HASH — `max_crawl_pages` is pinned, but pinning it is a
 * decision somebody can revisit, and the score is normalised by `N / Ntotal`.
 *
 * A CRAWL THAT STOPPED EARLY — it saw the first N pages of a larger site and the
 * crawler chose which N. Stored as `partial` for that reason.
 *
 * A CRAWL SIZE THAT DRIFTED — refused even when the config did not, because
 * `max_crawl_pages` is a CEILING and a site that grew from 90 pages to 600 moved
 * the denominator with nobody touching a setting.
 */

const OK = { ok: true, reason: '' };

const numberOr = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * How far the crawl size may drift before two readings stop being comparable.
 *
 * Twenty percent, and it is the same judgement as
 * `auditRows.COMPARABLE_CRAWL_DRIFT` on the client. A constant on both sides
 * rather than a literal on either, so a reader can check that they still agree.
 */
const COMPARABLE_CRAWL_DRIFT = 0.2;

/**
 * `site_audit` — the sample-size trap.
 *
 * @param {Object} current
 * @param {Object} previous
 * @returns {{ok: boolean, reason: string}}
 */
const auditComparability = (current, previous) => {
  if (current.configHash && previous.configHash && current.configHash !== previous.configHash) {
    const then = previous.config?.max_crawl_pages;
    const now = current.config?.max_crawl_pages;
    return {
      ok: false,
      reason:
        'The two crawls this month were run with different settings' +
        (then && now && then !== now ? ` — up to ${then} pages, then up to ${now}` : '') +
        '. The health score is a share of the pages crawled, so the difference ' +
        'between them would be a change of settings rather than a change in the site.',
    };
  }

  const stopped = [previous, current].find(
    (d) => d.crawl?.stopReason && d.crawl.stopReason !== 'finished'
  );
  if (stopped) {
    return {
      ok: false,
      reason:
        `One of this month's crawls stopped early (${stopped.crawl.stopReason}), so it ` +
        'covers the pages the crawler reached rather than the site.',
    };
  }

  const a = numberOr(previous.crawl?.pagesCrawled);
  const b = numberOr(current.crawl?.pagesCrawled);
  if (a && b && Math.abs(b - a) / a > COMPARABLE_CRAWL_DRIFT) {
    return {
      ok: false,
      reason:
        `The two crawls covered very different numbers of pages (${a} then ${b}). ` +
        'Issue counts are absolute, so most of the difference would be the ' +
        'difference in how much was looked at.',
    };
  }

  return OK;
};

/**
 * The Backlinks kinds — the corpus trap and the scale trap.
 *
 * `backlinks_status_type` RECOMPUTES the aggregates rather than filtering rows,
 * including `rank`: DataForSEO's own example shows one domain at 509 under
 * `lost` and 562 under `live`. And the 0-1000 and 0-100 rank scales convert
 * through `sin(rank / 636.62) * 100`, which is not linear, so a series that
 * changed scale under itself would draw a collapse.
 */
const backlinksComparability = (current, previous) => {
  if (current.statusType && previous.statusType && current.statusType !== previous.statusType) {
    return {
      ok: false,
      reason:
        `The two readings were taken over different link sets — "${previous.statusType}" ` +
        `then "${current.statusType}". Changing that recomputes every number rather ` +
        'than filtering rows.',
    };
  }
  if (current.rankScale && previous.rankScale && current.rankScale !== previous.rankScale) {
    return {
      ok: false,
      reason:
        'The two readings are on different rank scales, so their difference would be ' +
        'a change of units rather than a change in the profile.',
    };
  }
  return OK;
};

/**
 * The rank kinds — the DEPTH trap, which is this file's own addition.
 *
 * Neither client file has this one, because neither screen can meet it: the two
 * rank kinds have fixed depths and a screen only ever compares a kind with
 * itself. A goal can meet it, because `DEPTH_CENSUS` is a constant somebody can
 * change, and a keyword at 40 reads 40 at depth 100 and null at depth 10. A
 * starting point bought at one depth against a result bought at another reports
 * every keyword between the two as having "entered the rankings".
 */
const rankComparability = (current, previous) => {
  const now = numberOr(current.depth);
  const then = numberOr(previous.depth);
  if (now !== null && then !== null && now !== then) {
    return {
      ok: false,
      reason:
        `The two readings were bought to different depths (${then} results, then ${now}). ` +
        'A keyword outside the shallower one reads as unranked rather than as unchanged.',
    };
  }
  return OK;
};

/**
 * `business_profile` — the IDENTITY trap, which is this file's fourth shape.
 *
 * The other three guard against readings taken under different SETTINGS. This
 * one guards against readings taken of a different THING.
 *
 * `my_business_info` is a fuzzy text query. A business that rebrands, a listing
 * that gets merged, a `businessName` somebody edits from "Acme Plumbing" to
 * "Acme Plumbing & Heating" — any of those can move the query onto a different
 * Google listing with a completely different review history, and nothing in the
 * payload announces it. Subtracted, the new listing's 12 one-star reviews minus
 * the old listing's 40 reads as "your one-stars fell by 28", which is the single
 * most flattering wrong number this provider could produce.
 *
 * `cid` is Google's own stable identifier for a listing and is the check. A
 * reading with no `cid` at all is not refused — some listings genuinely come
 * back without one — because a refusal on missing data would blank every delta
 * on those Sites permanently. Two readings that BOTH carry one and disagree is
 * a different claim, and that is the one that is refused.
 */
const businessComparability = (current, previous) => {
  const now = current.profile?.cid;
  const then = previous.profile?.cid;
  if (now && then && now !== then) {
    return {
      ok: false,
      reason:
        'These two readings are of different Google listings, so the change between ' +
        'them is a change of business rather than a change in the reviews.',
    };
  }
  /**
   * A reading that FOUND NOTHING is not a reading of zero reviews. Subtracting
   * it would report every one of the business's reviews as having been deleted.
   */
  if (current.found === false || previous.found === false) {
    return {
      ok: false,
      reason:
        'One of these readings found no Google listing at all, which is not the same ' +
        'as a listing with no reviews.',
    };
  }
  return OK;
};

const BY_KIND = {
  positions: rankComparability,
  movement: rankComparability,
  backlinks_summary: backlinksComparability,
  backlinks_timeseries: backlinksComparability,
  referring_domains: backlinksComparability,
  anchors: backlinksComparability,
  /**
   * Phase 10. A network's link count is recomputed by
   * `backlinks_status_type` exactly as a domain's is, so it takes the same
   * guard — which is the whole reason that guard is a shared function rather
   * than four copies of a comparison.
   */
  referring_networks: backlinksComparability,
  site_audit: auditComparability,
  business_profile: businessComparability,
};

/**
 * The descriptor hook.
 *
 * A kind with nothing to guard answers OK — the four Labs kinds carry no setting
 * that recomputes what they mean — and so does a missing reading, because "there
 * is nothing to compare" is the caller's business rather than a refusal.
 *
 * @param {string} kindKey
 * @param {Object|null} current  - the newer snapshot's `data`
 * @param {Object|null} previous - the older one's
 * @returns {{ok: boolean, reason: string}}
 */
const comparability = (kindKey, current, previous) => {
  if (!current || !previous) return OK;
  const rule = BY_KIND[kindKey];
  if (!rule) return OK;
  return rule(current, previous);
};

module.exports = {
  comparability,
  COMPARABLE_CRAWL_DRIFT,
  // Exported for the tests, which assert each ground separately.
  auditComparability,
  backlinksComparability,
  rankComparability,
  businessComparability,
};
