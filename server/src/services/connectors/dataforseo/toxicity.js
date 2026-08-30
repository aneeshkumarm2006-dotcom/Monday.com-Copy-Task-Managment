const C = require('./constants');

/**
 * Which backlinks are worth disavowing, and the reasons.
 *
 * ---- Why this is a SCORE with named signals and not a filter ---------------
 *
 * A disavow file is one of the very few artefacts in SEO that can make a site
 * measurably worse. Google's own guidance is that most sites should never
 * submit one, and the failure mode of a bad one is silent and slow: a
 * legitimate referrer is thrown away, the link equity goes with it, and nothing
 * anywhere reports that it happened.
 *
 * So the rule is deliberately not `spamScore > 60 -> disavow`. Every one of the
 * signals below is regularly innocent on its own:
 *
 *   - a high SPAM SCORE can be a real site sitting on bad neighbours'
 *     infrastructure, or a forum whose other users are spammers;
 *   - a SITEWIDE placement is what every partner badge, every footer credit and
 *     every plugin attribution looks like;
 *   - a DEAD referrer is usually a site that simply stopped being maintained.
 *
 * `TOXIC_DISAVOW_MIN_SIGNALS` is therefore two, the reasons travel with the row
 * to the screen and into the exported file's comment lines, and the screen shows
 * the number rather than a verdict. The product's claim is "here is what looks
 * wrong and why", not "here is what to delete".
 *
 * ---- One copy of the rule, on the server -----------------------------------
 *
 * Same argument `onpageChecks.issueCountFor` makes for the inverted counters:
 * the direction of a rule that ends up in a client deliverable must exist once.
 * `aggregateReferringDomains` stamps `toxicity` onto every stored row, so
 * `client/src/utils/toxicRows.js` reads a field and never re-derives a
 * threshold. A second implementation would drift, and the artefact it drifts
 * into is a file somebody uploads to Google Search Console.
 *
 * ---- What this file deliberately cannot see --------------------------------
 *
 * THE SUBNET. `backlinks/referring_networks` groups the same corpus by IP block
 * and its rows carry no domain list, so there is no join key between a network
 * and a hostname anywhere in the API. The network signal is therefore a SECOND,
 * PARALLEL report rather than a fourth signal folded into this score — and the
 * disavow file is built from domains only, because Google's format accepts
 * `domain:` lines and URLs and has no concept of a network at all.
 */

const num = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * The signals, as data.
 *
 * `test` is pure and takes one normalised referring-domain row.
 * `weight` is what the row's 0-100 sort key is built from; it is NOT how many
 * signals a disavow needs, which is a count and lives in `C`.
 */
const SIGNALS = [
  {
    key: 'spam',
    label: 'High spam score',
    weight: 45,
    blurb:
      'DataForSEO scores this domain in its top spam band. That is a judgement ' +
      'about the domain, not about the link, and it is wrong often enough to ' +
      'need a second signal beside it.',
    test: (row) => (num(row.spamScore) ?? -1) >= C.TOXIC_SPAM_SCORE_MIN,
  },
  {
    key: 'sitewide',
    label: 'Sitewide placement',
    weight: 30,
    blurb:
      `More than ${C.TOXIC_SITEWIDE_LINKS} links from one domain is a template ` +
      'or a footer rather than an editorial mention — one decision repeated, ' +
      'not many people choosing to link.',
    test: (row) => (num(row.backlinks) ?? 0) >= C.TOXIC_SITEWIDE_LINKS,
  },
  {
    key: 'dead',
    label: 'Linking pages are broken',
    weight: 25,
    /**
     * HALF, and the halving is the point. `broken_pages` counts pages ON THE
     * REFERRING DOMAIN that no longer resolve; one of them is ordinary rot on
     * any site of size. A referrer where most of the pages carrying our link are
     * gone is a site that has been abandoned or de-indexed.
     */
    blurb:
      'Most of the pages on this domain that carry our link no longer resolve, ' +
      'which is what an abandoned or de-indexed site looks like from outside.',
    test: (row) => {
      const broken = num(row.brokenPages) ?? 0;
      const pages = num(row.referringPages) ?? 0;
      return broken > 0 && pages > 0 && broken / pages >= 0.5;
    },
  },
];

const SIGNAL_KEYS = SIGNALS.map((s) => s.key);
const SIGNAL_BY_KEY = new Map(SIGNALS.map((s) => [s.key, s]));

/**
 * Score one referring domain.
 *
 * ---- `lost` is an EXCLUSION and not a signal --------------------------------
 *
 * A domain carrying a `lostDate` has already stopped linking to us. Disavowing
 * it achieves nothing — there is no link left to discount — and it pads the file
 * with rows nobody can verify. It is still SCORED and still shown, because "the
 * worst thing pointing at you already left" is worth knowing; it simply never
 * becomes a recommendation.
 *
 * @param {Object} row - one row from `normaliseReferringDomain`
 * @returns {{score: number, signals: string[], disavow: boolean,
 *   watch: boolean, lost: boolean}}
 */
const scoreDomain = (row) => {
  const source = row && typeof row === 'object' ? row : {};
  const signals = SIGNALS.filter((s) => s.test(source)).map((s) => s.key);

  const spam = num(source.spamScore);
  const lost = !!source.lostDate;

  /**
   * A 0-100 SORT KEY, not a probability and not a spam score.
   *
   * Built from the signals that fired plus a fraction of the spam score itself,
   * so that two domains with the same two signals still order sensibly against
   * each other. Capped rather than normalised: this number is only ever compared
   * with another row's, never read as a percentage of anything.
   */
  const fromSignals = signals.reduce(
    (sum, key) => sum + (SIGNAL_BY_KEY.get(key)?.weight || 0),
    0
  );
  const fromSpam = spam !== null ? Math.round(spam * 0.25) : 0;
  const score = Math.min(100, fromSignals + fromSpam);

  return {
    score,
    signals,
    /** Two independent signals, and the link still exists. See the header. */
    disavow: signals.length >= C.TOXIC_DISAVOW_MIN_SIGNALS && !lost,
    /** Worth looking at, not worth acting on. */
    watch:
      !lost &&
      signals.length < C.TOXIC_DISAVOW_MIN_SIGNALS &&
      (signals.length > 0 || (spam !== null && spam >= C.TOXIC_SPAM_SCORE_WATCH)),
    lost,
  };
};

/**
 * The totals a toxic-links panel reads, over rows already scored.
 *
 * `shown` repeats `aggregateReferringDomains`' own vocabulary deliberately: this
 * is a census of the top hundred referring domains we asked for, NOT of the
 * whole profile, and a panel saying "6 toxic domains" beside a hero saying
 * "12,400 referring domains" has to be able to say which hundred it looked at.
 *
 * @param {Array<Object>} rows - normalised referring domains carrying `toxicity`
 * @returns {Object}
 */
const summariseToxicity = (rows) => {
  const list = Array.isArray(rows) ? rows : [];
  const scored = list.filter((r) => r.toxicity);

  const disavow = scored.filter((r) => r.toxicity.disavow);

  return {
    shown: list.length,
    disavow: disavow.length,
    watch: scored.filter((r) => r.toxicity.watch).length,
    lost: scored.filter((r) => r.toxicity.lost).length,
    /**
     * How many LINKS the suggested rows account for, beside how many domains.
     * One sitewide referrer is one line in a disavow file and forty thousand
     * links, and a summary carrying only the domain count hides which of those
     * two situations this is.
     */
    disavowBacklinks: disavow.reduce((sum, r) => sum + (num(r.backlinks) ?? 0), 0),
    bySignal: Object.fromEntries(
      SIGNAL_KEYS.map((key) => [
        key,
        scored.filter((r) => r.toxicity.signals.includes(key)).length,
      ])
    ),
    thresholds: {
      spamScore: C.TOXIC_SPAM_SCORE_MIN,
      watchScore: C.TOXIC_SPAM_SCORE_WATCH,
      sitewideLinks: C.TOXIC_SITEWIDE_LINKS,
      minSignals: C.TOXIC_DISAVOW_MIN_SIGNALS,
    },
  };
};

/**
 * The subnet census, over rows from `normaliseReferringNetwork`.
 *
 * ---- What "suspicious" means here, and what it does not --------------------
 *
 * `TOXIC_NETWORK_MIN_DOMAINS` referring domains sharing one /24 is the classic
 * private-blog-network signature, and it is the one thing per-link spam scoring
 * cannot see: forty individually clean-looking sites on one block are forty
 * clean spam scores.
 *
 * It is also what a reseller host looks like, and there is nothing in the
 * payload that distinguishes the two. So the word on the screen is CONCENTRATED
 * rather than toxic, the count is shown beside every flagged block, and nothing
 * here feeds the disavow file — Google's format has no line type for a network,
 * and inventing one by expanding a block into its domains is not possible
 * anyway, because these rows carry no domain list.
 *
 * @param {Array<Object>} rows
 * @returns {Object}
 */
const summariseNetworks = (rows) => {
  const list = Array.isArray(rows) ? rows : [];
  const concentrated = list.filter(
    (n) => (num(n.referringDomains) ?? 0) >= C.TOXIC_NETWORK_MIN_DOMAINS
  );

  return {
    shown: list.length,
    concentrated: concentrated.length,
    domainsInConcentrated: concentrated.reduce(
      (sum, n) => sum + (num(n.referringDomains) ?? 0),
      0
    ),
    largest: concentrated.length
      ? Math.max(...concentrated.map((n) => num(n.referringDomains) ?? 0))
      : null,
    thresholds: { minDomains: C.TOXIC_NETWORK_MIN_DOMAINS },
  };
};

module.exports = {
  SIGNALS,
  SIGNAL_KEYS,
  scoreDomain,
  summariseToxicity,
  summariseNetworks,
};
