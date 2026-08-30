import { isKindCollected } from './labsRows.js';

/**
 * The Local / GBP screen's rows.
 *
 * ---- The one number this screen refuses to lead with -----------------------
 *
 * THE STAR RATING. A business at 4.6 across 800 reviews that takes twenty new
 * one-stars moves to 4.53 — which displays as 4.5, and whose month-over-month
 * delta of 0.07 is inside the noise of any normal review flow. The single event
 * a local business most needs to be told about is invisible in the headline it
 * would most likely be reported through.
 *
 * `rating_distribution` is five counts and comes back on the same call, free. So
 * the hero of this screen is the ONE-STAR COUNT and its change, the average is a
 * secondary line, and every delta is computed from the buckets.
 *
 * The average is still shown, because Google shows it and a client will ask why
 * our number differs from the one on their own listing. It is never what a
 * change is read from.
 *
 * ---- And the guard, which is about IDENTITY rather than settings -----------
 *
 * The other three comparability guards in this codebase ask whether two readings
 * were taken under the same SETTINGS. This one asks whether they are of the same
 * THING. `my_business_info` is a fuzzy text query, so a rebrand, a merged
 * listing or an edited `businessName` can move it onto a different Google
 * listing with a different review history — and subtracted, the new listing's 12
 * one-stars minus the old listing's 40 reads as "your one-stars fell by 28".
 * That is the most flattering wrong number this provider could produce, which is
 * exactly the kind that survives review.
 *
 * `cid` is Google's own stable identifier and is the check, on both sides: this
 * file for the panel, `dataforseo/comparability.js` for the goal writeback.
 */

const numberOr = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

export { isKindCollected };

/** The five buckets, in the order a chart draws them. */
export const STAR_BUCKETS = [
  { key: 'five', stars: 5, label: '5 stars', tone: 'positive' },
  { key: 'four', stars: 4, label: '4 stars', tone: 'positive' },
  { key: 'three', stars: 3, label: '3 stars', tone: 'neutral' },
  { key: 'two', stars: 2, label: '2 stars', tone: 'negative' },
  { key: 'one', stars: 1, label: '1 star', tone: 'negative' },
];

/**
 * The profile card, or null.
 *
 * @param {Object|null} snapshot - the `business_profile` snapshot
 * @returns {Object|null}
 */
export const profileFrom = (snapshot) => {
  const data = snapshot?.data || null;
  if (!data) return null;

  const profile = data.profile || null;
  const dist = profile?.ratingDistribution || {};

  return {
    /** What we asked Google for. A profile is only as good as the query. */
    query: data.query || null,
    found: !!data.found,
    title: profile?.title || null,
    cid: profile?.cid || null,
    category: profile?.category || null,
    categories: Array.isArray(profile?.categories) ? profile.categories : [],
    address: profile?.address || null,
    phone: profile?.phone || null,
    url: profile?.url || null,
    claimed: typeof profile?.claimed === 'boolean' ? profile.claimed : null,
    currentStatus: profile?.currentStatus || null,
    /** Google's own average. Secondary, by design. */
    rating: numberOr(profile?.rating),
    ratingVotes: numberOr(profile?.ratingVotes),
    ratingMax: numberOr(profile?.ratingMax) ?? 5,
    totalPhotos: numberOr(profile?.totalPhotos),
    distribution: STAR_BUCKETS.map((bucket) => ({
      ...bucket,
      count: numberOr(dist[bucket.key]),
    })),
    /**
     * The sum of the buckets, which is NOT necessarily `ratingVotes`. Google's
     * own total and its distribution disagree on plenty of listings, so both are
     * shown and neither is derived from the other.
     */
    distributionTotal: numberOr(dist.total),
    placeTopics: Array.isArray(profile?.placeTopics) ? profile.placeTopics : [],
    peopleAlsoSearch: Array.isArray(profile?.peopleAlsoSearch)
      ? profile.peopleAlsoSearch
      : [],
    firstSeen: profile?.firstSeen || null,
    lastUpdated: profile?.lastUpdated || null,
  };
};

/**
 * May two GBP readings be compared?
 *
 * Same `{ok, reason}` shape as `backlinkRows.comparability` and
 * `auditRows.comparability`; its server counterpart is
 * `dataforseo/comparability.js`'s `businessComparability`, and the two are held
 * together by that shape and by this comment naming the other.
 *
 * @param {Object|null} current - a snapshot's `data`
 * @param {Object|null} previous
 * @returns {{ok: boolean, reason: string}}
 */
export const comparability = (current, previous) => {
  if (!current || !previous) return { ok: false, reason: '' };

  const now = current.profile?.cid;
  const then = previous.profile?.cid;
  if (now && then && now !== then) {
    return {
      ok: false,
      reason:
        'These two readings are of different Google listings, so the difference between ' +
        'them is a change of business rather than a change in the reviews.',
    };
  }

  if (current.found === false || previous.found === false) {
    return {
      ok: false,
      reason:
        'One of these readings found no Google listing at all, which is not the same as a ' +
        'listing with no reviews.',
    };
  }

  return { ok: true, reason: '' };
};

/**
 * A signed change between two readings, or null.
 *
 * Returns null whenever `comparability` says no, which is what makes the refusal
 * impossible to route around — a caller that forgets to ask gets no number
 * rather than a wrong one. Identical construction to
 * `backlinkRows.deltaOf` and `auditRows.deltaOf`.
 */
export const deltaOf = (current, previous, pick) => {
  if (!comparability(current, previous).ok) return null;
  const now = pick(current);
  const then = pick(previous);
  if (typeof now !== 'number' || typeof then !== 'number') return null;
  return now - then;
};

/**
 * The change in each star bucket between two readings.
 *
 * THE POINT OF THE WHOLE SCREEN. `one` going 9 → 19 is the row that produces a
 * sentence; the average going 4.60 → 4.56 is the row that produces a shrug.
 *
 * @param {Object|null} current - a snapshot's `data`
 * @param {Object|null} previous
 * @returns {Array<{key, label, stars, count, change}>}
 */
export const distributionChange = (current, previous) =>
  STAR_BUCKETS.map((bucket) => ({
    ...bucket,
    count: numberOr(current?.profile?.ratingDistribution?.[bucket.key]),
    change: deltaOf(
      current,
      previous,
      (d) => numberOr(d.profile?.ratingDistribution?.[bucket.key]) ?? null
    ),
  }));

/**
 * The sentence the distribution supports and the average does not.
 *
 * Returns null when there is nothing worth saying, rather than a limp "reviews
 * were stable" — a panel that always produces a sentence produces one nobody
 * reads.
 *
 * @param {Array<Object>} changes - from `distributionChange`
 * @returns {string|null}
 */
export const reviewHeadline = (changes) => {
  const negative = changes.filter(
    (c) => c.stars <= 2 && typeof c.change === 'number' && c.change > 0
  );
  const gained = negative.reduce((sum, c) => sum + c.change, 0);
  if (gained <= 0) return null;

  const worst = negative.find((c) => c.stars === 1) || negative[0];
  const before = typeof worst.count === 'number' ? worst.count - worst.change : null;

  if (before !== null && before > 0 && worst.change >= before) {
    return `${worst.label.toLowerCase()} reviews more than doubled, from ${before} to ${worst.count}.`;
  }
  return `${gained} new review${gained === 1 ? '' : 's'} at two stars or below since the last reading.`;
};

/** The share one bucket holds, for a bar. Null-safe; never divides by zero. */
export const bucketShare = (count, total) =>
  typeof count === 'number' && typeof total === 'number' && total > 0 ? count / total : null;
