/**
 * The People scoreboard: a tracker board's existing per-GROUP scores, rolled up
 * per PERSON for one month.
 *
 * Every group on a tracker board is already scored twice — once by
 * [goalTypes.js](./goalTypes.js) for its monthly goals, once by
 * [trackerEvaluate.js](./trackerEvaluate.js) for its delivery commitments. Once a
 * group has an owner (see groupOwner.js), those two scores answer a third
 * question nobody could ask before: how did each PERSON do this month.
 *
 * THERE IS NO SCORING IN THIS FILE, and there must never be. The goal maths is
 * `scoreBoard()` called verbatim over a person's group summaries — the same
 * function the Goals tab uses for the board roll-up, so a person's number and
 * the board's number can never be computed two different ways. Delivery is a
 * sum of counts that trackerEvaluate already produced. This file only decides
 * WHICH groups belong to WHOM, and adds them up.
 *
 * Pure, like its two inputs: arrays and Maps in, plain objects out. No mongoose,
 * no clock, no notion of "this month" beyond the keys it is handed.
 *
 * WHAT THE TWO HEADLINE NUMBERS MEAN
 *   "most goals achieved"     -> goals.counts.achieved
 *   "most overdue in delivery"-> delivery.missed, i.e. commitments whose grace
 *                                window closed with no qualifying evidence.
 *                                trackerEvaluate has no state called 'overdue';
 *                                `missed` IS overdue, and `pending` ("not due
 *                                yet") is excluded from `required` so waiting
 *                                never dilutes anybody's rate.
 */

const { scoreBoard } = require('./goalTypes');

/** A group with 3+ misses in the window, matching the Delivery tab's own rule. */
const AT_RISK_MISSES = 3;

const emptyDelivery = () => ({
  met: 0,
  partial: 0,
  missed: 0,
  pending: 0,
  excused: 0,
  required: 0,
  keptPct: null,
  byTracker: [],
});

/**
 * A group nobody attached anything in. Zeroes rather than nulls: unlike
 * delivery, absent evidence is a real answer, not a withheld one.
 */
const emptyEvidence = () => ({
  done: 0,
  attributed: 0,
  orphaned: 0,
  dismissed: 0,
});

const pct = (num, den) => (den > 0 ? Math.round((num / den) * 100) : null);

/**
 * Fold per-tracker cell grids into per-group counts, keeping only the periods a
 * predicate accepts.
 *
 * The month filter lives in `keepPeriod` rather than in here, so this function
 * knows nothing about months and the caller owns the attribution rule. (The
 * scoreboard's rule: a period belongs to the month containing its `startDayKey`
 * — the month its own key is named after. Without a rule, a weekly period
 * straddling a month boundary is counted in BOTH months and a year's totals
 * exceed reality.)
 *
 * Cell index aligns with period index by construction — trackerEvaluate builds
 * one cell per period, in order — which is why this can filter by position.
 *
 * @param {Array<{tracker, periods, rows}>} results - from evaluatePlans
 * @param {(period: Object, tracker: Object) => boolean} [keepPeriod]
 * @returns {Map<string, Object>} groupId -> delivery counts
 */
const foldDeliveryByGroup = (results = [], { keepPeriod = () => true } = {}) => {
  const byGroup = new Map();

  for (const result of results) {
    if (!result || !result.tracker?.enabled) continue;
    const { tracker, periods = [], rows = [] } = result;

    const keep = periods.map((p) => !!keepPeriod(p, tracker));
    if (!keep.some(Boolean)) continue;

    for (const row of rows) {
      const key = String(row.groupId);
      let acc = byGroup.get(key);
      if (!acc) {
        acc = emptyDelivery();
        byGroup.set(key, acc);
      }

      let trackerMissed = 0;
      let trackerRequired = 0;

      for (let i = 0; i < row.cells.length; i++) {
        if (!keep[i]) continue;
        const state = row.cells[i]?.s;
        // 'off' and 'na' are deliberately dropped: a period the tracker was not
        // running for is not a commitment anyone failed to keep.
        if (state === 'met' || state === 'partial' || state === 'missed') {
          acc[state] += 1;
          acc.required += 1;
          trackerRequired += 1;
          if (state === 'missed') trackerMissed += 1;
        } else if (state === 'pending' || state === 'excused') {
          acc[state] += 1;
        }
      }

      if (trackerRequired > 0) {
        acc.byTracker.push({
          trackerId: String(tracker._id),
          trackerName: tracker.name,
          missed: trackerMissed,
          required: trackerRequired,
        });
      }
    }
  }

  for (const acc of byGroup.values()) acc.keptPct = pct(acc.met, acc.required);
  return byGroup;
};

/** The worst (group, tracker) pair for a person — what to actually go fix. */
const worstOf = (groupRows) => {
  let worst = null;
  for (const row of groupRows) {
    for (const t of row.delivery?.byTracker || []) {
      if (t.missed > 0 && (!worst || t.missed > worst.missed)) {
        worst = {
          groupId: row._id,
          groupName: row.name,
          trackerName: t.trackerName,
          missed: t.missed,
        };
      }
    }
  }
  return worst;
};

/**
 * The server's default row order.
 *
 * Score descending, because `pct` is already THE score in this product — it is
 * what the goal ring draws and what `scoreBoard` produces — and because it is
 * size-normalised. Ranking on a raw "goals achieved" count would rank workload
 * allocation rather than performance: 6-of-12 would beat 4-of-4. It is also
 * weight-aware for free, since scoreGroup already honours a goal's weight.
 *
 * A row with no score sorts LAST under every direction, so "worst first" never
 * puts a blank row on top.
 */
const compareDefault = (a, b) => {
  const ap = a.goals?.pct;
  const bp = b.goals?.pct;
  const aHas = typeof ap === 'number';
  const bHas = typeof bp === 'number';
  if (aHas !== bHas) return aHas ? -1 : 1;
  if (aHas && ap !== bp) return bp - ap;

  const aWon = (a.goals?.counts?.achieved || 0) + (a.goals?.counts?.exceeded || 0);
  const bWon = (b.goals?.counts?.achieved || 0) + (b.goals?.counts?.exceeded || 0);
  if (aWon !== bWon) return bWon - aWon;

  const am = a.delivery?.missed ?? 0;
  const bm = b.delivery?.missed ?? 0;
  if (am !== bm) return am - bm;

  return String(a.user?.name || '').localeCompare(String(b.user?.name || ''));
};

/**
 * Bucket groups by owner and roll each bucket up.
 *
 * @param {Object}   args
 * @param {Object[]} args.groups   [{_id, name}] in board order
 * @param {Map<string, {userId: string|null, inherited: boolean}>} args.ownerByGroupId
 * @param {Map<string, Object|null>} args.usersById  userId -> lean User
 * @param {Map<string, Object>} args.goalSummaryByGroupId  scoreGroup() output per group
 * @param {Map<string, Object>|null} args.deliveryByGroupId  null = WITHHELD, not zero
 * @returns {{people: Object[], unassigned: Object|null, totals: Object}}
 */
const buildScoreboard = ({
  groups = [],
  ownerByGroupId = new Map(),
  usersById = new Map(),
  goalSummaryByGroupId = new Map(),
  deliveryByGroupId = null,
  // Done tasks vs. done tasks attached to a goal, per group. Unlike delivery
  // this is never withheld — there is no second capability to gate it on, and
  // no "unknown vs zero" ambiguity: zero attributed genuinely means zero.
  evidenceByGroupId = null,
} = {}) => {
  const hasDelivery = deliveryByGroupId instanceof Map;
  const hasEvidence = evidenceByGroupId instanceof Map;
  const buckets = new Map(); // ownerId | '' -> group rows

  for (const group of groups) {
    const gid = String(group._id);
    const owner = ownerByGroupId.get(gid) || null;
    const key = owner?.userId ? String(owner.userId) : '';

    const goalSummary = goalSummaryByGroupId.get(gid) || null;
    const delivery = hasDelivery ? (deliveryByGroupId.get(gid) || emptyDelivery()) : null;

    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push({
      _id: gid,
      name: group.name,
      goalPct: goalSummary?.pct ?? null,
      goalState: goalSummary?.state || 'empty',
      goalSummary,
      delivery,
      evidence: hasEvidence
        ? (evidenceByGroupId.get(gid) || emptyEvidence())
        : null,
      ownerInherited: !!owner?.inherited,
    });
  }

  const rowFor = (userId, groupRows) => {
    const summaries = groupRows.map((r) => r.goalSummary).filter(Boolean);
    const goals = scoreBoard(summaries);

    // Plain summation across the groups this person OWNED that month. It
    // answers "did the work in your groups get connected to your goals?" —
    // a coverage question, the same genre as the delivery miss count beside
    // it. It is deliberately NOT "work this person did": a task's doer is
    // its assignee, who often is not the group owner, and bucketing by
    // assignee would put people in `people[]` who own no group and break
    // what that array means.
    let evidence = null;
    if (hasEvidence) {
      evidence = emptyEvidence();
      for (const r of groupRows) {
        if (!r.evidence) continue;
        evidence.done += r.evidence.done;
        evidence.attributed += r.evidence.attributed;
        evidence.orphaned += r.evidence.orphaned;
        evidence.dismissed += r.evidence.dismissed;
      }
    }

    let delivery = null;
    let atRiskGroups = 0;
    if (hasDelivery) {
      delivery = emptyDelivery();
      for (const r of groupRows) {
        for (const k of ['met', 'partial', 'missed', 'pending', 'excused', 'required']) {
          delivery[k] += r.delivery?.[k] || 0;
        }
        if ((r.delivery?.missed || 0) >= AT_RISK_MISSES) atRiskGroups += 1;
      }
      delivery.keptPct = pct(delivery.met, delivery.required);
      delivery.atRiskGroups = atRiskGroups;
      delivery.worst = worstOf(groupRows);
      delete delivery.byTracker;
    }

    const user = userId ? usersById.get(userId) || null : null;

    return {
      // A user who has left the workspace keeps their rows: their groups were
      // genuinely theirs this month, and dropping them would move the work into
      // Unassigned and quietly change a past month's report.
      user: userId
        ? (user || { _id: userId, name: 'Former member', email: null, profilePic: null })
        : null,
      inOrg: userId ? !!user : true,
      groupCount: groupRows.length,
      groups: groupRows.map((r) => ({
        _id: r._id,
        name: r.name,
        goalPct: r.goalPct,
        goalState: r.goalState,
        missed: r.delivery?.missed ?? null,
        required: r.delivery?.required ?? null,
        attributed: r.evidence?.attributed ?? null,
        doneTasks: r.evidence?.done ?? null,
      })),
      goals: {
        pct: goals.pct,
        state: goals.state,
        groupsScored: goals.groupsScored,
        groupsTotal: goals.groupsTotal,
        totalGoals: goals.totalGoals,
        // How many goals have a result typed in. Rendered NEXT TO pct, always:
        // a mean over 2 of 8 goals reads as final unless you say otherwise.
        reported: goals.totalGoals - (goals.counts.untracked || 0),
        counts: goals.counts,
      },
      delivery,
      evidence,
      flags: {
        // Newly took over at least one of these groups THIS month, rather than
        // carrying it forward. Not "ownership changed mid-month" — it cannot:
        // ownership is pinned per month, so whoever owns month M owns all of it.
        // What this says is that some of these numbers belong to a group this
        // person only just inherited, which is worth a footnote before anyone
        // reads the row as a verdict on them.
        tookOverThisMonth: groupRows.some((r) => r.ownerInherited === false),
        noGoals: goals.totalGoals === 0,
        noDelivery: hasDelivery ? (delivery?.required || 0) === 0 : false,
      },
    };
  };

  const people = [];
  for (const [key, groupRows] of buckets) {
    if (key === '') continue;
    people.push(rowFor(key, groupRows));
  }
  people.sort(compareDefault);

  // Dense competition ranking: 1, 2, 2, 4. Unscored rows carry no rank at all
  // rather than a rank that would read as a placing.
  let lastPct = Symbol('none');
  let lastRank = 0;
  people.forEach((p, i) => {
    if (typeof p.goals.pct !== 'number') {
      p.rank = null;
      return;
    }
    if (p.goals.pct !== lastPct) {
      lastRank = i + 1;
      lastPct = p.goals.pct;
    }
    p.rank = lastRank;
  });

  // Emitted only when ownerless groups exist — but always when they do. "Nobody
  // owns these three clients" is the most actionable line on the page.
  const unassignedRows = buckets.get('') || [];
  const unassigned = unassignedRows.length ? { ...rowFor(null, unassignedRows), rank: null } : null;

  const allRows = [...buckets.values()].flat();
  const totalDelivery = hasDelivery ? emptyDelivery() : null;
  if (hasDelivery) {
    for (const r of allRows) {
      for (const k of ['met', 'partial', 'missed', 'pending', 'excused', 'required']) {
        totalDelivery[k] += r.delivery?.[k] || 0;
      }
    }
    totalDelivery.keptPct = pct(totalDelivery.met, totalDelivery.required);
    delete totalDelivery.byTracker;
  }

  // Over EVERY group, not a mean of the people's means. Those coincide only when
  // everyone owns the same number of groups, and this number has to equal the
  // Goals tab's board score for the same month.
  const boardGoals = scoreBoard(allRows.map((r) => r.goalSummary).filter(Boolean));

  return {
    people,
    unassigned,
    totals: {
      peopleCount: people.length,
      groupsTotal: groups.length,
      groupsWithoutOwner: unassignedRows.length,
      goalPct: boardGoals.pct,
      goalState: boardGoals.state,
      totalGoals: boardGoals.totalGoals,
      counts: boardGoals.counts,
      delivery: totalDelivery,
    },
  };
};

module.exports = { foldDeliveryByGroup, buildScoreboard, compareDefault, AT_RISK_MISSES };
