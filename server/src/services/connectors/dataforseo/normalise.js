const { DfsError } = require('./errors');
const C = require('./constants');

/**
 * Turning DataForSEO's payloads into our vocabulary.
 *
 * ---- The timestamp trap, which is the whole reason this file exists first ---
 *
 * DataForSEO stamps everything in UTC and says so, but it does not always SAY so
 * in the string. Both of these appear in their responses:
 *
 *     "2026-09-01 00:03:12 +00:00"
 *     "2026-09-01 00:03:12"
 *
 * Verified in Node 24: the first parses correctly. The second is not an ISO
 * datetime, so V8 falls back to its legacy parser and reads it as SERVER-LOCAL
 * time. On a machine in Asia/Kolkata that is 2026-08-31T18:33:12Z — THE PREVIOUS
 * DAY.
 *
 * And a snapshot is identified by its day. `periodKeyFrom(collectedAt, now)`
 * takes `collectedAt.toISOString().slice(0, 10)`, so a reading collected just
 * after midnight would be filed under yesterday, would collide with yesterday's
 * real reading on the unique index, and would be silently dropped as "the row we
 * already had was better". Nothing anywhere would report a fault.
 *
 * The second failure mode is worse because it is silent in the other direction:
 * `periodKeyFrom` falls back to TODAY on an `Invalid Date`, so a shape we cannot
 * parse at all produces a plausible, authoritative-looking, wrong period with no
 * error to find. That is why `parseDfsTime` THROWS. A fetcher that throws is
 * recorded against the one (project, kind) that failed and the run continues;
 * a fetcher that guesses is a data-integrity bug that surfaces months later as
 * "the chart has a hole in August".
 *
 * Production on Render runs UTC, which would mask both. Local development and
 * CI do not, which is why this is parsed rather than trusted.
 */

/**
 * YYYY-MM-DD[T or space]HH:MM:SS[.fraction][ offset]
 *
 * Written out rather than delegated to `new Date()`, because the delegation is
 * exactly the bug. The offset group is OPTIONAL and its absence means UTC —
 * DataForSEO's own statement about its API, and the only reading that keeps a
 * bare timestamp on the day the provider meant.
 */
const DFS_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,9}))?\s*(Z|z|[+-]\d{2}:?\d{2})?$/;

/**
 * Parse one DataForSEO datetime into a Date.
 *
 * @param {string|Date} value
 * @param {string} [field] - named in the failure, so an operator reads which
 *   field of which payload was unreadable rather than "Invalid Date"
 * @returns {Date}
 * @throws {DfsError} for anything it cannot parse, INCLUDING a missing value.
 *   A caller whose field is genuinely optional checks before calling.
 */
const parseDfsTime = (value, field = 'time') => {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new DfsError(`DataForSEO sent an unreadable ${field}.`);
    }
    return new Date(value.getTime());
  }

  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    throw new DfsError(`DataForSEO sent no ${field}, and a reading needs one.`);
  }

  const m = DFS_TIME.exec(text);
  if (!m) {
    throw new DfsError(
      `DataForSEO sent a ${field} we cannot read: "${text.slice(0, 60)}".`
    );
  }

  const [, y, mo, d, h, mi, s, frac, offset] = m;
  const ms = frac ? Number(String(frac).slice(0, 3).padEnd(3, '0')) : 0;

  let epoch = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
    ms
  );

  if (offset && offset !== 'Z' && offset !== 'z') {
    const sign = offset[0] === '-' ? -1 : 1;
    const [oh, om] = offset.slice(1).replace(':', '').match(/\d{2}/g).map(Number);
    // Subtract the offset to reach UTC: 09:00 at +05:30 is 03:30Z.
    epoch -= sign * (oh * 60 + om) * 60_000;
  }

  const out = new Date(epoch);
  if (Number.isNaN(out.getTime())) {
    throw new DfsError(`DataForSEO sent an out-of-range ${field}: "${text.slice(0, 60)}".`);
  }

  // Date.UTC happily rolls 2026-13-45 into the following year. A rolled date is
  // not the day the provider meant, and a snapshot keyed on the wrong day is the
  // exact failure this function exists to prevent. Checked on the UTC fields
  // only when no offset was given — with one, the calendar day legitimately
  // shifts.
  const rolled =
    out.getUTCFullYear() !== Number(y) ||
    out.getUTCMonth() !== Number(mo) - 1 ||
    out.getUTCDate() !== Number(d);
  if (!offset && rolled) {
    throw new DfsError(`DataForSEO sent an impossible ${field}: "${text.slice(0, 60)}".`);
  }
  if (offset && (Number(mo) > 12 || Number(d) > 31)) {
    throw new DfsError(`DataForSEO sent an impossible ${field}: "${text.slice(0, 60)}".`);
  }

  return out;
};

/** A finite number, or null. Never `0` for "we did not see one". */
const num = (value) => {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/**
 * `/v3/appendix/user_data`, normalised into the two things we want from it.
 *
 * ---- What goes where, and why they are different fields --------------------
 *
 * IDENTITY (`login`) becomes `ConnectorAccount.externalEmail` through the
 * existing `session.recordIdentity`, which is the field built for exactly that
 * and which the account list already renders.
 *
 * MONEY AND PRICES become `ConnectorAccount.lastSeenQuota`, which has been
 * `Mixed`, defaulted `{}`, documented "display only; never a gate" and written
 * by NOTHING since the day it was added. This is its writer.
 *
 * Keep its documented status. `money.balance` is what an alarm watches, and the
 * price book is what makes a phase-3 reservation an exact estimate rather than a
 * guess against a published list that moved 20% on 2026-07-01 — but the GATE is
 * the budget document, computed from our own ledger. A number we misread out of
 * an undocumented shape must never be able to stop a sync, and a provider
 * balance last read six days ago must never be able to authorise one.
 *
 * ---- Why `price` is carried whole ------------------------------------------
 *
 * It is the account-specific price book, and it is the only place the real cost
 * of a call can be read before the call is made. Storing a hand-picked subset
 * would mean re-syncing every account the first time phase 3 wants a price we
 * did not anticipate — the same argument `ConnectorProject.raw` already makes.
 *
 * @param {any} payload - one entry from `tasks[0].result`
 * @param {Object} [opts]
 * @param {Date} [opts.now]
 * @returns {{identity: Object, quota: Object}}
 */
const normaliseUserData = (payload, { now = new Date() } = {}) => {
  const row = payload && typeof payload === 'object' ? payload : {};
  const money = row.money && typeof row.money === 'object' ? row.money : {};

  const login =
    typeof row.login === 'string' && row.login.trim() ? row.login.trim() : null;

  return {
    identity: {
      externalEmail: login,
      externalAccountId: null,
      /**
       * DataForSEO has no plans, no seats and no feature gating — it is pure
       * pay-as-you-go. Writing that into `tier` beats leaving it null, because
       * null reads as "we could not find out" and this is "there is nothing to
       * find out".
       */
      tier: 'pay-as-you-go',
    },
    quota: {
      observedAt: now,
      balanceUsd: num(money.balance),
      totalUsd: num(money.total),
      /** Their per-minute and per-day spend ceilings, not ours. */
      moneyLimits: money.limits && typeof money.limits === 'object' ? money.limits : null,
      rates: row.rates && typeof row.rates === 'object' ? row.rates : null,
      price: row.price && typeof row.price === 'object' ? row.price : null,
      timezone: typeof row.timezone === 'string' ? row.timezone : null,
    },
  };
};

// ---------------------------------------------------------------------------
// SERP results
// ---------------------------------------------------------------------------

/**
 * Does this SERP item belong to the domain we are tracking?
 *
 * Subdomains count, the domain's own name inside somebody else's host does not:
 * `blog.acme.com` is acme, `notacme.com` and `acme.com.evil.net` are not. Done
 * with an explicit suffix-plus-dot test rather than `includes`, because
 * `includes` is exactly how a rank tracker starts reporting a competitor's
 * position as its client's.
 *
 * `www.` is NOT collapsed. `sites.normaliseDomain` deliberately keeps it,
 * because for a rank tracker `www.acme.com` and `acme.com` are different targets
 * — so if a Site was authored as one, the other is a different domain and this
 * says so.
 *
 * @param {any} itemDomain
 * @param {string} domain
 * @returns {boolean}
 */
const isTrackedDomain = (itemDomain, domain) => {
  const host = String(itemDomain || '').trim().toLowerCase();
  const want = String(domain || '').trim().toLowerCase();
  if (!host || !want) return false;
  return host === want || host.endsWith(`.${want}`);
};

// ---------------------------------------------------------------------------
// Phase 10 — AI Visibility. Free, because it rides inside the rank payload.
// ---------------------------------------------------------------------------

/**
 * Two-level public suffixes common enough to matter here.
 *
 * Deliberately a SHORT list rather than the Public Suffix List. This is used for
 * one thing — guessing a brand word out of a domain so "was our brand named in
 * the AI Overview text" can be asked at all — and a wrong guess costs a
 * `mentioned` flag, never a rank, a charge or a stored measurement. Shipping a
 * 10,000-entry dependency for that would be the more expensive mistake.
 */
const TWO_LEVEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ac.uk', 'gov.uk',
  'com.au', 'net.au', 'org.au', 'co.nz', 'co.za', 'co.in', 'co.jp',
  'com.br', 'com.mx', 'com.sg', 'com.tr', 'com.cn',
]);

/**
 * The brand word inside a domain — `acme` from `www.acme.co.uk`.
 *
 * ---- Why this exists, and what it must not be used for ---------------------
 *
 * CITED and MENTIONED are two different metrics and this function only serves
 * the second one. Cited is exact and needs no guessing: our domain either
 * appears in `ai_overview.references[]` or it does not, and `isTrackedDomain`
 * answers it the same way it answers a rank. Mentioned is a question about
 * PROSE — did Google's summary name us without linking us — and there is no
 * field for it, so it is a search for a brand word in the text.
 *
 * The two are never merged. A page can be cited without being named and named
 * without being cited, and "AI visibility" as one number would hide which.
 *
 * Returns null for anything too short to search for. A two-letter brand matches
 * inside a hundred ordinary words, and a false `mentioned` on a client report is
 * worse than an honest gap.
 *
 * @param {string} domain
 * @returns {string|null}
 */
const brandTokenFor = (domain) => {
  const host = String(domain || '').trim().toLowerCase().replace(/^www\./, '');
  if (!host) return null;
  const labels = host.split('.').filter(Boolean);
  if (labels.length < 2) return labels[0]?.length >= 3 ? labels[0] : null;

  const tail2 = labels.slice(-2).join('.');
  const idx = TWO_LEVEL_SUFFIXES.has(tail2) ? labels.length - 3 : labels.length - 2;
  const token = labels[idx] || '';
  return token.length >= 3 ? token : null;
};

/** Escape a literal for use inside a RegExp. */
const escapeRe = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Every AI Overview reference in one payload, in the order Google listed them.
 *
 * References arrive in TWO places and both are read: `ai_overview.references[]`
 * at the top of the block, and `ai_overview.items[].references[]` hanging off
 * individual paragraphs. Reading only the first silently under-counts every
 * overview built out of per-paragraph citations, which is the shape Google has
 * been moving towards — and the failure is invisible, because an overview with
 * no top-level references parses cleanly as "cited nobody".
 *
 * @param {Object} block - the `ai_overview` item
 * @returns {Array<{domain: string, url: string, rank: number|null}>}
 */
const aiReferencesIn = (block) => {
  const out = [];
  const seen = new Set();

  const take = (list) => {
    if (!Array.isArray(list)) return;
    for (const ref of list) {
      if (!ref || typeof ref !== 'object') continue;
      const url = typeof ref.url === 'string' ? ref.url : '';
      /**
       * The domain is taken from the reference's own `domain` field when it has
       * one and parsed out of the URL otherwise. Google's citation URLs carry
       * `#:~:text=` scroll-to-text fragments, so a naive string compare against
       * a URL would miss; the host is the only stable half.
       */
      let host = typeof ref.domain === 'string' ? ref.domain.trim().toLowerCase() : '';
      if (!host && url) {
        try {
          host = new URL(url).hostname.toLowerCase();
        } catch {
          host = '';
        }
      }
      if (!host) continue;
      const key = `${host}|${url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ domain: host, url, rank: num(ref.rank_group) });
    }
  };

  take(block?.references);
  if (Array.isArray(block?.items)) for (const el of block.items) take(el?.references);

  return out;
};

/**
 * All the prose inside one AI Overview block, concatenated.
 *
 * Titles as well as text, because Google puts the answer in a heading as often
 * as in a paragraph, and a brand named only in a heading is still a mention.
 */
const aiTextOf = (block) => {
  const parts = [];
  const push = (value) => {
    if (typeof value === 'string' && value.trim()) parts.push(value);
  };
  push(block?.title);
  push(block?.text);
  if (Array.isArray(block?.items)) {
    for (const el of block.items) {
      push(el?.title);
      push(el?.text);
      if (Array.isArray(el?.items)) for (const leaf of el.items) push(leaf?.text);
    }
  }
  return parts.join(' \n ');
};

/**
 * What one SERP says about our AI Overview standing.
 *
 * ---- CITED and MENTIONED are two metrics and are never one ------------------
 *
 * CITED means our domain is in the reference list Google attached to its own
 * summary. It is exact, it is a link, and it is the one that sends traffic.
 *
 * MENTIONED means our brand word appears in the summary's prose. It is a claim
 * about visibility with no click behind it, and it is inferred from text rather
 * than read from a field.
 *
 * They overlap and neither contains the other, so they are counted apart all the
 * way to the screen and to the goal-field catalog. A single blended "AI
 * visibility" percentage would be a number nobody can act on: cited is fixed by
 * link-earning, mentioned is fixed by entity coverage, and a figure that moves
 * for either reason tells you to do neither.
 *
 * `present: false` with everything else null is a SERP that had no AI Overview
 * at all, which is a real and common answer and is not the same as an overview
 * that ignored us. Both are distinguishable downstream, which is what
 * `presenceRate` is for.
 *
 * @param {Array<Object>} items - the advanced payload's `items`
 * @param {string} domain - the Site's own domain
 * @returns {Object}
 */
const readAiOverview = (items, domain) => {
  const list = Array.isArray(items) ? items : [];
  const block = list.find((i) => i && i.type === 'ai_overview') || null;

  if (!block) {
    return {
      present: false,
      cited: false,
      mentioned: false,
      citationRank: null,
      citationCount: null,
      references: [],
    };
  }

  const references = aiReferencesIn(block);
  const ours = references.findIndex((r) => isTrackedDomain(r.domain, domain));

  const token = brandTokenFor(domain);
  const text = aiTextOf(block);
  const mentioned = token
    ? new RegExp(`\\b${escapeRe(token)}\\b`, 'i').test(text)
    : false;

  return {
    present: true,
    cited: ours >= 0,
    mentioned,
    /**
     * WHERE in the citation list we appear, 1-based — Google's own
     * `rank_group` when it sent one, our position in the list otherwise.
     *
     * Deliberately NOT routed through `connectorFormat.formatRank` anywhere on
     * the client. That function owns the SERP three-way rule and renders a null
     * as "Not in top 100", which is a sentence about search results and is
     * never true of a citation list of eight.
     */
    citationRank: ours >= 0 ? references[ours].rank ?? ours + 1 : null,
    citationCount: references.length,
    /**
     * The reference DOMAINS, capped. This is what makes the citation-source
     * table computable across the keyword set without re-reading every stored
     * SERP body — see `C.AI_REFERENCES_PER_KEYWORD`.
     */
    references: references
      .slice(0, C.AI_REFERENCES_PER_KEYWORD)
      .map((r) => r.domain),
  };
};

// ---------------------------------------------------------------------------
// Phase 10 — Cannibalization. Also free, and also out of the same payload.
// ---------------------------------------------------------------------------

/**
 * Every one of OUR OWN urls on this SERP, best position first.
 *
 * ---- Why this is a list and `rank` above is a single number ----------------
 *
 * `normaliseSerpResult.rank` is "where does this site rank", and the answer is
 * the FIRST of our URLs — which is what every rank tracker reports and what a
 * client means by the question. Cannibalization is the opposite question: how
 * many of our pages are competing for one query, and at what cost to the best
 * one.
 *
 * It is free at `depth: 100` and nearly meaningless at `depth: 10`, which is the
 * whole reason the plan filed it here: the weekly census already bought the
 * hundred results, and a second URL of ours at position 47 is invisible to a
 * ten-deep daily check. `aggregatePositions` stamps `depth` on the reading and
 * `comparability` refuses to subtract two readings bought at different depths,
 * so the screen cannot quietly compare a census with a movement check.
 *
 * @param {Array<Object>} organic
 * @param {string} domain
 * @returns {Array<{url: string|null, rank: number|null, rankAbsolute: number|null}>}
 */
const ownUrlsIn = (organic, domain) => {
  const rows = [];
  const seen = new Set();
  for (const item of Array.isArray(organic) ? organic : []) {
    if (!isTrackedDomain(item?.domain, domain)) continue;
    const url = typeof item.url === 'string' ? item.url : null;
    /**
     * De-duplicated on the URL, because one page can legitimately appear twice
     * in an advanced payload as a result and as its own sitelink parent. Two
     * rows for one page would report a site as cannibalising itself with one
     * URL, which is not a thing.
     */
    const key = url || `#${rows.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      url,
      rank: num(item.rank_group),
      rankAbsolute: num(item.rank_absolute),
    });
    if (rows.length >= C.CANNIBAL_URLS_PER_KEYWORD) break;
  }
  return rows;
};

/**
 * One `task_get/advanced` result, reduced to the row a rank table draws.
 *
 * ---- What is deliberately thrown away here ---------------------------------
 *
 * THE ITEMS. One organic item is ~1-2 KB and `depth: 100` is ~100-200 KB per
 * keyword, so two hundred keywords is 20-40 MB — over Mongo's 16 MB document
 * ceiling by 2x. The failure mode is the expensive part: the driver rejects the
 * write AFTER DataForSEO has been paid and AFTER `task_get` has consumed the
 * result. Money spent, data lost.
 *
 * So the snapshot carries the AGGREGATE ONLY (~80 bytes a keyword, 16 KB for two
 * hundred) and the bodies go to `DfsSerpResult` in phase 3. The irreplaceable
 * half — the rank — is what lives on the snapshot forever.
 *
 * ---- Why `rank` and `rankAbsolute` are both kept ---------------------------
 *
 * `rank_group` is the organic position a person would count; `rank_absolute`
 * counts every block on the page. The GAP between them is a free measure of
 * SERP-feature pressure, and it is the only way to explain a traffic drop where
 * the organic position did not move.
 *
 * @param {any} payload - `tasks[0].result[0]` from `task_get/advanced`
 * @param {Object} opts
 * @param {string} opts.domain - the Site's own domain
 * @param {string} [opts.keyword] - what we asked for, when the payload omits it
 * @returns {Object}
 */
const normaliseSerpResult = (payload, { domain, keyword = '' } = {}) => {
  const row = payload && typeof payload === 'object' ? payload : {};
  const items = Array.isArray(row.items) ? row.items : [];

  const organic = items.filter((i) => i && i.type === 'organic');
  const hit = organic.find((i) => isTrackedDomain(i.domain, domain)) || null;

  return {
    keyword: typeof row.keyword === 'string' && row.keyword ? row.keyword : keyword,
    /**
     * null is A REAL ANSWER — "not inside the depth we bought" — and never a
     * missing reading. `connectorFormat.formatRank` is three-way for exactly
     * this, and a chart must draw it as a gap rather than as zero.
     */
    rank: hit ? num(hit.rank_group) : null,
    rankAbsolute: hit ? num(hit.rank_absolute) : null,
    url: hit && typeof hit.url === 'string' ? hit.url : null,
    ranked: !!hit,
    /** The SERP-feature census. Diffing it across weeks is free volatility. */
    itemTypes: Array.isArray(row.item_types)
      ? row.item_types.filter((t) => typeof t === 'string')
      : [],
    resultsCount: num(row.se_results_count),
    /** How many organic results we actually saw. Honest about a short SERP. */
    organicCount: organic.length,
    /**
     * ---- The two phase-10 readings, both taken from `items` before it is
     * thrown away ------------------------------------------------------------
     *
     * They are here rather than in a second pass over `DfsSerpResult` for the
     * reason the itemTypes census is here: this function is the ONLY place that
     * ever sees the full hundred-result payload. `pollJob` trims to render depth
     * immediately afterwards and the untrimmed array is dropped on the floor, so
     * a later reader would be computing a census of twenty results and calling
     * it a census of a hundred.
     */
    aiOverview: readAiOverview(items, domain),
    ownUrls: ownUrlsIn(organic, domain),
  };
};

/** A rate as a 0-1 fraction, or null when the denominator is zero. */
const rateOf = (part, whole) =>
  whole > 0 ? Math.round((part / whole) * 1000) / 1000 : null;

/**
 * The AI Overview census across one collection.
 *
 * ---- Three denominators, and mixing them is the trap -----------------------
 *
 * `presenceRate` is over EVERY tracked keyword — how much of this keyword set
 * now has an AI Overview at all. That is the market fact.
 *
 * `citedRate` and `mentionedRate` are over the keywords that HAVE one, because
 * we cannot be cited in an overview that does not exist. Divided by the whole
 * keyword set instead, both numbers fall whenever Google shows fewer overviews —
 * which reads on a chart as our AI visibility collapsing on a week we did
 * nothing, and reads on a client call as a problem to fix.
 *
 * Both denominators are carried on the object so a screen can print the fraction
 * rather than only the percentage, which is the only way a reader can tell "0 of
 * 0" from "0 of 40".
 *
 * @param {Array<Object>} keywords - rows from `normaliseSerpResult`
 * @param {string} domain
 * @returns {Object}
 */
const aggregateAiVisibility = (keywords, domain) => {
  const rows = Array.isArray(keywords) ? keywords : [];
  const withOverview = rows.filter((k) => k.aiOverview?.present);

  const cited = withOverview.filter((k) => k.aiOverview.cited);
  const mentioned = withOverview.filter((k) => k.aiOverview.mentioned);

  /**
   * WHO GOOGLE CITES FOR OUR QUERIES, counted across the set.
   *
   * One row per domain with the number of our keywords whose overview cited it.
   * Our own domain is included rather than filtered out — it is the row a reader
   * looks for first, and removing it would make the table impossible to read a
   * share off.
   */
  const counts = new Map();
  for (const k of withOverview) {
    for (const host of new Set(k.aiOverview.references || [])) {
      counts.set(host, (counts.get(host) || 0) + 1);
    }
  }
  const sources = [...counts.entries()]
    .map(([host, count]) => ({
      domain: host,
      keywords: count,
      share: rateOf(count, withOverview.length),
      ours: isTrackedDomain(host, domain),
    }))
    .sort((a, b) => b.keywords - a.keywords || a.domain.localeCompare(b.domain));

  const citationRanks = cited
    .map((k) => k.aiOverview.citationRank)
    .filter((r) => typeof r === 'number');

  return {
    tracked: rows.length,
    withOverview: withOverview.length,
    /** Over EVERY tracked keyword. See the header. */
    presenceRate: rateOf(withOverview.length, rows.length),
    /**
     * CITED — our domain is in the reference list. Exact, and the one that
     * carries a link.
     */
    cited: cited.length,
    citedRate: rateOf(cited.length, withOverview.length),
    /**
     * MENTIONED — our brand word appears in the prose. Inferred from text, and
     * carries no link. A SEPARATE metric, never added to the one above.
     */
    mentioned: mentioned.length,
    mentionedRate: rateOf(mentioned.length, withOverview.length),
    /**
     * The two combinations worth naming, and they are named rather than summed:
     * cited without a mention is a link with no brand recall, and a mention
     * without a citation is recall with no click. They are different problems.
     */
    citedNotMentioned: cited.filter((k) => !k.aiOverview.mentioned).length,
    mentionedNotCited: mentioned.filter((k) => !k.aiOverview.cited).length,
    averageCitationRank: citationRanks.length
      ? Math.round((citationRanks.reduce((s, r) => s + r, 0) / citationRanks.length) * 10) / 10
      : null,
    sources,
  };
};

/**
 * The cannibalization census across one collection.
 *
 * ---- The denominator, again, is the whole decision -------------------------
 *
 * Health is computed over the keywords where WE APPEAR AT ALL, not over every
 * tracked keyword. A site ranking for twelve of two hundred keywords, cleanly,
 * would otherwise score 6% health and read as catastrophic — the arithmetic of a
 * ranking problem rendered as a duplication problem.
 *
 * 100 means clean. `null` means we rank for nothing in this reading, which is a
 * real answer and is not zero: zero health would mean every ranking keyword is
 * cannibalised, and `connectorFormat` renders a null as an em dash for exactly
 * this reason.
 *
 * @param {Array<Object>} keywords
 * @returns {Object}
 */
const aggregateCannibalization = (keywords) => {
  const rows = Array.isArray(keywords) ? keywords : [];
  const present = rows.filter((k) => (k.ownUrls?.length || 0) > 0);
  const competing = present.filter((k) => k.ownUrls.length > 1);

  const extraUrls = competing.reduce((sum, k) => sum + (k.ownUrls.length - 1), 0);

  return {
    /** Keywords where at least one of our URLs is on the page. */
    ranking: present.length,
    /** Keywords where more than one is. THE finding. */
    competing: competing.length,
    /** How many surplus URLs there are in total, across those keywords. */
    extraUrls,
    competingRate: rateOf(competing.length, present.length),
    /**
     * 100 = clean, and it is deliberately a percentage rather than a count: a
     * count of eight means nothing without knowing whether the site ranks for
     * twelve keywords or twelve hundred.
     */
    healthPct:
      present.length > 0
        ? Math.round((1 - competing.length / present.length) * 1000) / 10
        : null,
  };
};

/**
 * Every keyword's row, plus the totals a dashboard tile reads.
 *
 * `collectedAt` is the LATEST datetime DataForSEO stamped across the batch —
 * the moment the collection finished, not the moment it was asked for. That is
 * the value `writeSnapshot` turns into `periodKey`, which is the whole reason
 * this collection cannot be keyed at post time.
 *
 * @param {Array<Object>} rows - from `normaliseSerpResult`
 * @param {Object} opts
 * @param {string} opts.domain
 * @param {number} opts.depth
 * @param {Date|null} [opts.collectedAt]
 * @returns {Object}
 */
const aggregatePositions = (rows, { domain, depth, collectedAt = null } = {}) => {
  const keywords = Array.isArray(rows) ? rows : [];
  const ranked = keywords.filter((k) => typeof k.rank === 'number');

  const inTop = (n) => ranked.filter((k) => k.rank <= n).length;

  return {
    domain: domain || null,
    /** Bought depth, stored so a trend line can be broken when it changes. */
    depth: depth ?? null,
    collectedAt: collectedAt || null,
    keywords,
    totals: {
      tracked: keywords.length,
      ranked: ranked.length,
      top3: inTop(3),
      top10: inTop(10),
      top100: inTop(100),
      /**
       * Averaged over the RANKED keywords only, and null when none ranked.
       *
       * Averaging in the unranked ones as 0 or as 101 both produce a number that
       * moves for reasons nobody can explain — and a "0.0 average position" on a
       * client report is worse than an empty cell.
       */
      averageRank: ranked.length
        ? Math.round((ranked.reduce((sum, k) => sum + k.rank, 0) / ranked.length) * 10) / 10
        : null,
    },
    /**
     * ---- Phase 10's two free aggregates --------------------------------------
     *
     * Computed HERE and stored, rather than derived on the client from
     * `keywords[]`, for one reason each.
     *
     * `aiVisibility.sources` is a cross-keyword count — "who does Google cite
     * for the queries we care about" — which no per-keyword row can answer, and
     * which the goal-field catalog has to be able to read off `data` without a
     * browser.
     *
     * `cannibalization` is on the aggregate because a goal binds to it ("keep
     * cannibalization health above 90") and because the rate is the headline. The
     * per-keyword detail stays on the rows, where the screen reads it.
     */
    aiVisibility: aggregateAiVisibility(keywords, domain),
    cannibalization: aggregateCannibalization(keywords),
  };
};

module.exports = {
  parseDfsTime,
  normaliseUserData,
  normaliseSerpResult,
  aggregatePositions,
  isTrackedDomain,
  DFS_TIME,
  // Phase 10 — exported so the tests can assert each half of the AI reading
  // separately, which is the only way "cited and mentioned are different
  // metrics" is provable rather than asserted in a comment.
  brandTokenFor,
  aiReferencesIn,
  readAiOverview,
  ownUrlsIn,
  aggregateAiVisibility,
  aggregateCannibalization,
};
