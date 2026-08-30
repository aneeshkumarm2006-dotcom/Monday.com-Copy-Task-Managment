const C = require('./constants');
const { parseDfsTime } = require('./normalise');

/**
 * The Google Business Profile card, reduced to what a Local screen draws.
 *
 * ---- The metric trap this file exists for ----------------------------------
 *
 * A STAR RATING IS AN AVERAGE, AND AN AVERAGE IS THE WRONG NUMBER FOR REVIEWS.
 *
 * A business at 4.6 across 800 reviews that takes twenty new one-stars in a
 * month moves to 4.53. Rounded for display it is still "4.5", and a month-over-
 * month delta of 0.07 is inside the noise of any normal review flow — so the one
 * event a local business genuinely needs to know about is invisible in the
 * headline it is most likely to be reported through.
 *
 * `rating_distribution` is the fix and it is free: it comes back on the same
 * call, as five counts. "Your one-stars doubled, from 9 to 19" is a sentence
 * somebody acts on; "your rating fell 0.1" is not. So the distribution is stored
 * as five separate numbers rather than as a derived average, and every headline
 * on the screen is built from the counts.
 *
 * The average is still carried, because Google shows it and a client will ask
 * why our number differs from the one on their own listing. It is never the
 * thing a change is computed from.
 *
 * ---- The two lists Google gives away ---------------------------------------
 *
 * `place_topics` is Google's own review-mined themes — the words their model
 * decided this business is about, with counts. It is the closest thing to a free
 * content brief anywhere in this API.
 *
 * `people_also_search` is Google naming the competitive set. Not our guess at
 * who the competitors are, not a Labs SERP-overlap computation: the businesses
 * Google itself puts next to this one. Both are capped at
 * `BUSINESS_LIST_LIMIT` for the reason `internal_list_limit` is capped — a
 * snapshot bound, not a product opinion.
 */

const num = (value) => {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

const str = (value) =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const time = (value) => {
  if (!value) return null;
  try {
    return parseDfsTime(value, 'business datetime');
  } catch {
    /**
     * NULL rather than a throw, unlike the SERP path.
     *
     * `parseDfsTime` throws for `collectedAt`, because a snapshot is identified
     * by its day and a guessed day is a silently wrong period. Nothing here is
     * ever a period key — these are descriptive fields on a card — so an
     * unreadable one costs a line of a panel rather than the integrity of a
     * series. Same reasoning `backlinksNormalise.time` records.
     */
    return null;
  }
};

/**
 * The five star buckets, as counts.
 *
 * DataForSEO return `rating_distribution` as an object keyed `"1".."5"`. Read
 * with explicit keys rather than `Object.values`, because object key order is
 * insertion order for string keys that are not integer-like — and these ARE
 * integer-like, so V8 happens to sort them, which is exactly the kind of
 * accidental correctness that breaks when somebody returns `"5 stars"` instead.
 *
 * Every bucket is a number or null, never a defaulted zero: "Google did not tell
 * us" and "nobody left a one-star review" are different facts, and the whole
 * point of this panel is the first-bucket count.
 *
 * @param {any} payload
 * @returns {{one, two, three, four, five, total: number|null}}
 */
const normaliseRatingDistribution = (payload) => {
  const row = payload && typeof payload === 'object' ? payload : {};
  const at = (key) => num(row[key] ?? row[String(key)]);

  const buckets = {
    one: at(1),
    two: at(2),
    three: at(3),
    four: at(4),
    five: at(5),
  };

  const known = Object.values(buckets).filter((v) => typeof v === 'number');

  return {
    ...buckets,
    /**
     * The sum of the buckets, which is NOT necessarily `rating.votes_count`.
     * Google's own totals and its distribution disagree on plenty of listings
     * (ratings with no review text are counted differently), so both are stored
     * and neither is derived from the other.
     */
    total: known.length ? known.reduce((s, v) => s + v, 0) : null,
  };
};

/** `place_topics` — Google's review-mined themes, as `{topic, count}`. */
const normalisePlaceTopics = (payload) => {
  const row = payload && typeof payload === 'object' ? payload : {};
  return Object.entries(row)
    .map(([topic, count]) => ({ topic: String(topic), count: num(count) }))
    .filter((t) => t.topic)
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
    .slice(0, C.BUSINESS_LIST_LIMIT);
};

/** `people_also_search` — Google naming the competitive set. */
const normalisePeopleAlsoSearch = (list) =>
  (Array.isArray(list) ? list : [])
    .map((row) => ({
      title: str(row?.title),
      /**
       * The CID, kept because it is the only stable identifier for a Google
       * listing — a title is a name somebody can change on a Tuesday.
       */
      cid: str(row?.cid),
      rating: num(row?.rating?.value),
      votes: num(row?.rating?.votes_count),
    }))
    .filter((row) => row.title)
    .slice(0, C.BUSINESS_LIST_LIMIT);

/**
 * One `my_business_info` item, normalised.
 *
 * @param {any} payload
 * @returns {Object}
 */
const normaliseBusinessInfo = (payload) => {
  const row = payload && typeof payload === 'object' ? payload : {};
  const rating = row.rating && typeof row.rating === 'object' ? row.rating : {};

  return {
    title: str(row.title),
    cid: str(row.cid),
    placeId: str(row.place_id),
    category: str(row.category),
    categories: (Array.isArray(row.additional_categories) ? row.additional_categories : [])
      .map((c) => str(c))
      .filter(Boolean)
      .slice(0, C.BUSINESS_LIST_LIMIT),
    address: str(row.address),
    phone: str(row.phone),
    url: str(row.url),
    domain: str(row.domain),
    /**
     * `is_claimed` is a BOOLEAN and it stays out of the goal-field catalog for
     * the reason phase 9 recorded: `fieldMapping.SOURCE_TYPES` is
     * `number | text | date | link` and widening it on behalf of one provider's
     * flags is a decision to make once, deliberately. It is rendered on the
     * screen, where a boolean is a badge and needs no type system.
     */
    claimed: typeof row.is_claimed === 'boolean' ? row.is_claimed : null,
    /** Google's own average. NEVER the number a change is computed from. */
    rating: num(rating.value),
    ratingVotes: num(rating.votes_count),
    ratingMax: num(rating.rating_max),
    /** THE number a change IS computed from. See the file header. */
    ratingDistribution: normaliseRatingDistribution(row.rating_distribution),
    totalPhotos: num(row.total_photos),
    placeTopics: normalisePlaceTopics(row.place_topics),
    peopleAlsoSearch: normalisePeopleAlsoSearch(row.people_also_search),
    /** Open / closed right now, as Google reports it. Descriptive only. */
    currentStatus: str(row.work_time?.current_status),
    firstSeen: time(row.first_seen),
    lastUpdated: time(row.last_updated_time),
  };
};

/**
 * The Local snapshot body.
 *
 * ---- Why the distribution deltas are NOT computed here ---------------------
 *
 * "Your one-stars doubled" needs two readings, and a normaliser has one. The
 * comparison belongs where every other comparison in this provider belongs —
 * behind `comparability`, against `previousSnapshots`, on the client — so that a
 * reading taken of a DIFFERENT listing (a business that moved, a CID that
 * changed) cannot be silently subtracted from this one. `cid` travels on the
 * body for exactly that check.
 *
 * @param {Object|null} profile
 * @param {Object} ctx
 * @returns {Object}
 */
const aggregateBusinessProfile = (profile, { query, collectedAt = null } = {}) => ({
  /** What we asked Google for. A profile is only as good as the query. */
  query: query || null,
  collectedAt: collectedAt || null,
  found: !!profile,
  profile: profile || null,
  totals: profile
    ? {
        rating: profile.rating,
        ratingVotes: profile.ratingVotes,
        oneStar: profile.ratingDistribution?.one ?? null,
        twoStar: profile.ratingDistribution?.two ?? null,
        threeStar: profile.ratingDistribution?.three ?? null,
        fourStar: profile.ratingDistribution?.four ?? null,
        fiveStar: profile.ratingDistribution?.five ?? null,
        distributionTotal: profile.ratingDistribution?.total ?? null,
        totalPhotos: profile.totalPhotos,
        topics: profile.placeTopics.length,
        alsoSearched: profile.peopleAlsoSearch.length,
      }
    : {
        rating: null,
        ratingVotes: null,
        oneStar: null,
        twoStar: null,
        threeStar: null,
        fourStar: null,
        fiveStar: null,
        distributionTotal: null,
        totalPhotos: null,
        topics: 0,
        alsoSearched: 0,
      },
});

module.exports = {
  normaliseRatingDistribution,
  normalisePlaceTopics,
  normalisePeopleAlsoSearch,
  normaliseBusinessInfo,
  aggregateBusinessProfile,
};
