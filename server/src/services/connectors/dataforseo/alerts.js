const C = require('./constants');
const { comparability } = require('./comparability');

/**
 * What is worth interrupting somebody about, and what is not.
 *
 * ---- The rule exists ONCE, here, and both consumers ask it -----------------
 *
 * Two things need the answer: `services/seoAlertRunner.js`, which delivers it as
 * a notification, and the Alerts SCREEN, which shows what the latest reading
 * would fire and what the thresholds are. Phases 7-9 accepted a second copy of
 * `comparability` on the client because there is no module both packages can
 * import — and paid for it with a header on each naming the other.
 *
 * This one does not need that compromise, because the screen has a server round
 * trip anyway: `connectorDataController` already holds `snapshots` and
 * `previousSnapshots` in memory when it answers, so it calls `evaluateAll` and
 * puts the result on the payload. No extra query, no second implementation, and
 * a threshold that changes changes in one place.
 *
 * ---- Every rule goes through `comparability` FIRST -------------------------
 *
 * Phase 9 said this in as many words: "an alert that fires because a crawl got
 * bigger is worse than no alert, because somebody acts on it." Every rule here
 * subtracts two readings, and for the rank kinds the guard is real — a keyword
 * at 40 reads 40 at depth 100 and null at depth 10, so a census compared with a
 * daily check would report a third of the keyword set as having fallen off the
 * internet. The refusal is carried as a REASON on the result rather than
 * swallowed, because "we did not check" and "we checked and nothing happened"
 * are different things to show on a screen.
 *
 * ---- And the reason `seo` is a notification CATEGORY -----------------------
 *
 * `notificationService.TYPE_CATEGORY` maps a type to a preference category, and
 * AN UNMAPPED TYPE IS ALWAYS DELIVERED. The `goals` category carries the comment
 * that says why that matters: "a recurring nag with no off switch is how a
 * workspace learns to ignore the bell entirely." Rank drops are the most
 * recurring nag this product could possibly generate — a rank tracker's whole
 * job is noticing movement — so the type, the mapping and the category all ship
 * together or none of them do.
 */

const numberOr = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * The keyword rows of a rank snapshot, indexed by keyword.
 *
 * Lowercased, because two people typed the same keyword. Same rule
 * `fields.rowFor` already applies for the same reason.
 */
const rowsByKeyword = (data) => {
  const map = new Map();
  for (const row of Array.isArray(data?.keywords) ? data.keywords : []) {
    const key = String(row?.keyword || '').trim().toLowerCase();
    if (key) map.set(key, row);
  }
  return map;
};

/**
 * Which keywords fell far enough, from high enough, to be worth a notification.
 *
 * ---- Two thresholds, and dropping either one ruins it ----------------------
 *
 * `ALERT_RANK_DROP_MIN` alone fires on the long tail, where movement is largest
 * and matters least — a keyword going 74 → 91 is a real seventeen-place drop and
 * is not news. `ALERT_RANK_DROP_FROM_MAX` alone fires on a keyword going 3 → 4.
 * Together they describe the thing somebody actually wants a phone call about: a
 * keyword that was winning and is not any more.
 *
 * ---- Leaving the bought depth is a drop, and its SIZE is unknowable ---------
 *
 * A keyword at 6 that comes back null did not go to 11. It went somewhere past
 * the depth we bought, which on the daily check is ten and on the census is a
 * hundred. So the drop is reported as "out of the top N" with `to: null` and is
 * ranked as if it landed just past the edge — a definite lower bound, never a
 * made-up number. `connectorFormat.formatRank`'s three-way rule is the same
 * distinction one layer up.
 */
const rankDrops = (current, previous, depth) => {
  const now = rowsByKeyword(current);
  const before = rowsByKeyword(previous);
  const edge = numberOr(depth);

  const drops = [];
  for (const [keyword, was] of before) {
    const from = numberOr(was.rank);
    if (from === null || from > C.ALERT_RANK_DROP_FROM_MAX) continue;

    const row = now.get(keyword);
    /**
     * A keyword ABSENT from the newer reading is not a drop. It was removed
     * from the tracked list, or the collection was short — reporting either as
     * a ranking loss is how an alert teaches people to distrust it.
     */
    if (!row) continue;

    const to = numberOr(row.rank);

    if (to === null) {
      drops.push({
        keyword: was.keyword,
        from,
        to: null,
        /** A LOWER BOUND. See the header. */
        drop: edge ? Math.max(edge + 1 - from, C.ALERT_RANK_DROP_MIN) : C.ALERT_RANK_DROP_MIN,
        leftDepth: true,
      });
      continue;
    }

    const drop = to - from;
    if (drop >= C.ALERT_RANK_DROP_MIN) {
      drops.push({ keyword: was.keyword, from, to, drop, leftDepth: false });
    }
  }

  return drops.sort((a, b) => b.drop - a.drop || a.from - b.from);
};

/** "best crm (3 → 12)", or "best crm (3 → out of the top 100)". */
const describeDrop = (drop, depth) =>
  `${drop.keyword} (${drop.from} → ${
    drop.to === null ? `out of the top ${depth ?? '?'}` : drop.to
  })`;

/**
 * One sentence naming at most `ALERT_RANK_DROP_NAMED` keywords, then counting.
 *
 * A bell message is one line. Forty keywords in it is a paragraph nobody reads,
 * and truncating without a count is a message that hides its own size.
 */
const rankDropMessage = (drops, depth, label) => {
  const named = drops.slice(0, C.ALERT_RANK_DROP_NAMED).map((d) => describeDrop(d, depth));
  const rest = drops.length - named.length;
  const tail = rest > 0 ? ` and ${rest} more` : '';
  return `${label}: ${drops.length} keyword${drops.length === 1 ? '' : 's'} dropped — ${named.join(
    ', '
  )}${tail}.`;
};

/**
 * The rules, as DATA.
 *
 * `kind` is which snapshot the rule reads; `type` is the `Notification.type` it
 * is delivered under, and every one of those has to exist in three places at
 * once — the enum, `TYPE_CATEGORY`, and `NotificationPreference.categories`.
 * A type present in the enum and absent from the map is delivered to everybody
 * regardless of preference, which is the failure mode this catalog is written
 * next to.
 */
const RULES = [
  {
    key: 'rank_drop',
    label: 'Rank drop',
    type: 'seoRankDrop',
    kinds: ['positions', 'movement'],
    blurb:
      `A tracked keyword that was at position ${C.ALERT_RANK_DROP_FROM_MAX} or better falls ` +
      `${C.ALERT_RANK_DROP_MIN} places or more, or leaves the results we bought altogether.`,
    thresholds: {
      minDrop: C.ALERT_RANK_DROP_MIN,
      fromBetterThan: C.ALERT_RANK_DROP_FROM_MAX,
      named: C.ALERT_RANK_DROP_NAMED,
    },
  },
  {
    key: 'lost_backlinks',
    label: 'Lost backlinks',
    type: 'seoLostBacklinks',
    kinds: ['backlinks_summary'],
    blurb:
      `Referring domains fall by at least ${Math.round(C.ALERT_LOST_LINKS_SHARE * 100)}% AND by ` +
      `at least ${C.ALERT_LOST_LINKS_MIN} between two readings. Both, because a percentage ` +
      'alone fires constantly on a small profile and never on a large one.',
    thresholds: {
      minShare: C.ALERT_LOST_LINKS_SHARE,
      minDomains: C.ALERT_LOST_LINKS_MIN,
    },
  },
];

const RULE_BY_KEY = new Map(RULES.map((r) => [r.key, r]));

/**
 * Evaluate one rule against one pair of readings.
 *
 * @param {Object} rule
 * @param {Object} args
 * @param {string} args.kind
 * @param {Object|null} args.current  - a public snapshot `{data, periodKey, …}`
 * @param {Object|null} args.previous
 * @param {string} [args.label] - what to call this board/site in the message
 * @returns {Object|null} an alert, or null when nothing fired
 */
const evaluateRule = (rule, { kind, current, previous, label = 'SEO' }) => {
  if (!current?.data) return null;

  const base = {
    rule: rule.key,
    label: rule.label,
    type: rule.type,
    kind,
    periodKey: current.periodKey || null,
    previousPeriodKey: previous?.periodKey || null,
    thresholds: rule.thresholds,
  };

  if (!previous?.data) {
    return {
      ...base,
      fired: false,
      /**
       * NOT a refusal and not a pass. There is exactly one reading, so there is
       * nothing to compare — which is a different sentence from "we compared and
       * nothing happened", and the screen prints the difference.
       */
      reason: 'Only one reading has been collected, so there is nothing to compare it with.',
      message: '',
      detail: null,
    };
  }

  /**
   * THE GUARD, ASKED BEFORE THE SUBTRACTION AND NEVER AFTER.
   *
   * This is the one line phase 9 asked for by name. Two rank readings bought to
   * different depths, or two backlink readings computed over different link
   * sets, are measurements of different things — and an alert derived from that
   * subtraction is a false alarm somebody acts on.
   */
  const ok = comparability(kind, current.data, previous.data);
  if (!ok.ok) {
    return { ...base, fired: false, reason: ok.reason, message: '', detail: null };
  }

  if (rule.key === 'rank_drop') {
    const depth = numberOr(current.data.depth);
    const drops = rankDrops(current.data, previous.data, depth);
    if (!drops.length) {
      return { ...base, fired: false, reason: '', message: '', detail: { drops: [] } };
    }
    return {
      ...base,
      fired: true,
      reason: '',
      message: rankDropMessage(drops, depth, label),
      detail: { drops, depth },
    };
  }

  if (rule.key === 'lost_backlinks') {
    const now = numberOr(current.data.profile?.referringDomains);
    const then = numberOr(previous.data.profile?.referringDomains);
    if (now === null || then === null || then <= 0) {
      return {
        ...base,
        fired: false,
        reason: 'One of these readings has no referring-domain count.',
        message: '',
        detail: null,
      };
    }

    const lost = then - now;
    const share = lost / then;
    /**
     * BOTH thresholds, and the `&&` is the rule. One lost link out of twelve is
     * 8% and is noise; six hundred lost out of forty thousand is 1.5% and is an
     * emergency. Either test on its own gets exactly one of those wrong.
     */
    if (lost < C.ALERT_LOST_LINKS_MIN || share < C.ALERT_LOST_LINKS_SHARE) {
      return {
        ...base,
        fired: false,
        reason: '',
        message: '',
        detail: { lost, share, from: then, to: now },
      };
    }

    return {
      ...base,
      fired: true,
      reason: '',
      message:
        `${label}: ${lost} referring domain${lost === 1 ? '' : 's'} lost since the last ` +
        `reading (${then} → ${now}, ${Math.round(share * 100)}%).`,
      detail: { lost, share, from: then, to: now },
    };
  }

  return null;
};

/**
 * Every rule this board can answer, against the readings already in hand.
 *
 * ---- One rule can read two kinds, and it must not answer twice --------------
 *
 * `rank_drop` names both rank kinds. A board collecting both would otherwise
 * produce two alerts about the same site on the same day — one from the weekly
 * census and one from the daily check — which is the same event told twice with
 * different numbers, because the two are bought to different depths.
 *
 * So a rule takes THE FIRST of its kinds that has a reading, in the order it
 * declares them: `positions` before `movement`. The census is the better
 * measurement (a hundred results rather than ten, so a drop from 6 to 40 is a
 * number rather than "gone"), and the daily check is the fallback for the frugal
 * board that switched the census off — which is exactly the board phase 9
 * flagged as having no way to reach these numbers.
 *
 * @param {Object} args
 * @param {Object} args.snapshots         - `{[kind]: publicSnapshot}`
 * @param {Object} args.previousSnapshots
 * @param {string} [args.label]
 * @returns {Array<Object>}
 */
const evaluateAll = ({ snapshots = {}, previousSnapshots = {}, label = 'SEO' } = {}) => {
  const out = [];
  for (const rule of RULES) {
    const kind = rule.kinds.find((k) => snapshots[k]);
    if (!kind) {
      out.push({
        rule: rule.key,
        label: rule.label,
        type: rule.type,
        kind: rule.kinds[0],
        fired: false,
        reason: 'Nothing this rule reads is being collected for this site.',
        message: '',
        detail: null,
        periodKey: null,
        previousPeriodKey: null,
        thresholds: rule.thresholds,
      });
      continue;
    }
    const result = evaluateRule(rule, {
      kind,
      current: snapshots[kind],
      previous: previousSnapshots[kind],
      label,
    });
    if (result) out.push(result);
  }
  return out;
};

module.exports = {
  RULES,
  RULE_BY_KEY,
  rankDrops,
  rankDropMessage,
  evaluateRule,
  evaluateAll,
};
