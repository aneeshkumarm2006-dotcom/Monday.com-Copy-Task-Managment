/**
 * Monthly goals: what kinds exist, and how a month is scored.
 *
 * PURE — plain objects in, plain objects out. No mongoose, no queries, no dates
 * resolved from `now`. Same discipline as
 * [trackerEvaluate.js](./trackerEvaluate.js), and for the same reason: scoring
 * rules that can be unit-tested without a database are scoring rules that get
 * tested.
 *
 * THE SCORE, ONCE, HERE. The server puts a computed `score` on every goal it
 * returns and the client only renders it. Two implementations of a scoring rule
 * is the same class of bug as two implementations of a permission rule — they
 * agree until the day they quietly do not, and then a client is looking at a
 * number the server disagrees with.
 *
 * THE FORMULA is "percentage of the gap closed":
 *
 *     pct = (actual − baseline) / (target − baseline)
 *
 * Direction is NOT inferred with a branch. When the target is lower than the
 * baseline — a search position going 5 → 3, a cost per lead coming down — both
 * the numerator and the denominator go negative and the same expression already
 * reads correctly. That is the whole reason this formula was chosen over
 * `actual / target`.
 *
 * ADDING A TYPE is one entry in `GOAL_TYPES`. Because each entry declares its
 * own `configFields` and `actualField`, the client's add-a-goal form is
 * generated from this table rather than switch-cased against it — so a new type
 * arrives in the UI with correct inputs and plain-language labels for free.
 *
 * THE CHOOSING COPY LIVES HERE TOO — `useWhen`, `notWhen`, `answerShape`,
 * `setupShape`, `partialCredit`, `examples` and `namePlaceholder`. The picker in
 * `GoalFormModal` renders them and holds no per-type copy of its own, so the
 * words a person reads while deciding sit next to the rule that scores them.
 * Two things this copy must keep doing:
 *
 *  - `notWhen` always NAMES the type you probably wanted instead. Six labels
 *    with no cross-references is a list; six labels that point at each other is
 *    a decision tree, and picking the wrong kind is the actual failure mode.
 *  - `examples` stay off any one trade. A goals board is used for SEO, for ads,
 *    for client reminders and for internal ops, so each type carries three
 *    examples from three different kinds of work. Somebody doing paid social
 *    should never have to translate an SEO example to recognise their own goal.
 */

const { compareDayKeys, daysBetween, isDayKey } = require('./tzDay');

/**
 * Outcome bands. `untracked` is an unanswered question rather than a graded
 * failure — it keeps its own state and its own colour everywhere it is shown.
 * It nevertheless contributes ZERO to a group's score; see `scoreGroup`.
 */
const STATES = ['untracked', 'missed', 'partial', 'achieved', 'exceeded'];

const UNITS = ['none', 'percent', 'currency', 'custom'];

const clamp01 = (n) => Math.min(1, Math.max(0, n));

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Round to one decimal — enough to distinguish 66.7% from 66.6%, no more. */
const round1 = (n) => Math.round(n * 10) / 10;

/**
 * Turn a 0..1 ratio into the reported shape. `raw` may exceed 1 (over-delivery)
 * or go below 0 (it moved the wrong way); `pct` is always clamped, because a
 * month score built out of uncapped numbers lets one runaway goal paper over
 * three failures.
 */
const fromRatio = (raw, extra = {}) => {
  const pct = round1(clamp01(raw) * 100);
  let state;
  if (raw > 1) state = 'exceeded';
  else if (pct >= 100) state = 'achieved';
  else if (pct > 0) state = 'partial';
  else state = 'missed';
  return {
    pct,
    rawPct: round1(raw * 100),
    state,
    exceeded: raw > 1,
    regressed: raw < 0,
    reason: null,
    ...extra,
  };
};

const UNTRACKED = { pct: null, rawPct: null, state: 'untracked', exceeded: false, regressed: false, reason: null };

/**
 * The shared numeric core, used by `numeric` and by `threshold` when it has been
 * given a baseline to grade against.
 */
const gapClosed = (baseline, target, actual) => {
  if (!isNum(target) || !isNum(actual)) return { ...UNTRACKED };

  // A missing baseline means "from zero". Flagged rather than silently assumed:
  // "grow from 0 to 6,000, we got 5,640" reads as 94% when the truth might be
  // that it started at 4,200 and the real answer is 80%.
  const assumedBaseline = !isNum(baseline);
  const base = assumedBaseline ? 0 : baseline;

  // Zero gap: the target IS the starting point, so there is no progress to
  // measure and the only honest answer is met-or-not. Dividing would be
  // Infinity or NaN, and returning 100 unconditionally would flatter every
  // misconfigured goal on the board.
  if (target === base) {
    return {
      ...fromRatio(actual === target ? 1 : 0),
      reason: 'zeroGap',
      assumedBaseline,
    };
  }

  return fromRatio((actual - base) / (target - base), { assumedBaseline });
};

const numberField = (key, label, help) => ({ key, label, help, type: 'number' });

const GOAL_TYPES = {
  numeric: {
    key: 'numeric',
    label: 'Move a number',
    hint: 'Something you can measure today, and you want it higher or lower by the end of the month.',
    useWhen: 'The thing you care about is a number that moves.',
    notWhen: 'Just counting how many things you produced? Use “Tick off a list”.',
    setupShape: 'Where it is now, and where you want it to get to',
    answerShape: 'the number you ended on',
    partialCredit: 'Yes — get halfway and it scores 50%.',
    examples: [
      'Website visits: 4,200 → 6,000',
      'Cost per lead: $38 → $30',
      'Newsletter subscribers: 900 → 1,200',
    ],
    namePlaceholder: 'Grow website visits',
    targetConfigKey: 'target',
    // Works in both directions with no extra setting: a target below the
    // baseline simply flips both signs of the ratio.
    supportsUnit: true,
    configFields: [
      numberField('baseline', 'Where are you starting from?', 'The number at the start of the month. Leave blank to measure from zero.'),
      numberField('target', 'Where do you want to get to?', 'The number that means this went well. It can be lower than the start.'),
    ],
    actualField: numberField('actual', 'Where did you land?', 'Fill this in at the end of the month.'),
    validateConfig: (c) => (isNum(c?.target) ? null : 'Set the number you are aiming for.'),
    score: (c, actual) => gapClosed(c?.baseline, c?.target, actual),
  },

  boolean: {
    key: 'boolean',
    label: 'Did we do it?',
    hint: 'One thing that either happened or it did not. There is no half.',
    useWhen: 'There is a single thing to deliver, and half of it is worth nothing.',
    notWhen: 'Has to land by a particular day? Use “Hit a date”.',
    setupShape: 'Nothing to set up — just name it',
    answerShape: 'Yes or No',
    partialCredit: 'No — it is all or nothing.',
    examples: [
      'Publish the case study',
      'Set up conversion tracking',
      'Send the client their new logins',
    ],
    namePlaceholder: 'Publish the case study',
    targetConfigKey: null,
    supportsUnit: false,
    configFields: [],
    actualField: { key: 'actual', label: 'Did it happen?', help: '', type: 'boolean' },
    validateConfig: () => null,
    score: (c, actual) => {
      if (actual === null || actual === undefined || actual === '') return { ...UNTRACKED };
      // Stored as 1/0 so every type shares one numeric `actual` field, but a
      // real boolean from an older client is accepted too.
      const done = actual === true || actual === 1;
      return fromRatio(done ? 1 : 0);
    },
  },

  checklist: {
    key: 'checklist',
    label: 'Tick off a list',
    hint: 'You promised a number of things this month. At the end you count how many you actually did.',
    useWhen: 'The same kind of thing, done several times.',
    notWhen: 'Only one thing to deliver? Use “Did we do it?”.',
    setupShape: 'How many you promised',
    answerShape: 'how many you got done',
    partialCredit: 'Yes — 6 out of 8 scores 75%.',
    examples: [
      'Publish 8 blog posts',
      'Ship 12 ad creatives',
      'Send 4 client check-in emails',
    ],
    namePlaceholder: 'Publish 8 blog posts',
    targetConfigKey: 'total',
    supportsUnit: false,
    configFields: [
      numberField('total', 'How many are you promising?', 'The number you committed to for this month.'),
    ],
    actualField: numberField('actual', 'How many did you do?', ''),
    validateConfig: (c) =>
      isNum(c?.total) && c.total >= 0 ? null : 'Say how many you are aiming for.',
    score: (c, actual) => {
      if (!isNum(actual)) return { ...UNTRACKED };
      // A list of nothing is vacuously complete. Better than dividing by zero,
      // and the config validator already discourages it.
      if (c?.total === 0) return { ...fromRatio(1), reason: 'emptyChecklist' };
      return gapClosed(0, c?.total, actual);
    },
  },

  threshold: {
    key: 'threshold',
    label: 'Keep it above or below',
    hint: 'A line you must not cross. You are holding a number steady, not pushing it somewhere new.',
    useWhen: 'The win is not slipping, rather than improving.',
    notWhen: 'Want credit for improving month on month? Use “Move a number”.',
    setupShape: 'The line, and which side to stay on',
    answerShape: 'the number you ended on',
    partialCredit: 'Only if you say where you started — otherwise it is pass or fail.',
    examples: [
      'Keep ad spend under $5,000',
      'Keep page load under 2.5 seconds',
      'Answer every client within 24 hours',
    ],
    namePlaceholder: 'Keep ad spend under budget',
    targetConfigKey: 'limit',
    supportsUnit: true,
    configFields: [
      {
        key: 'direction',
        label: 'Which side of the line?',
        help: '',
        type: 'choice',
        choices: [
          { value: 'atMost', label: 'Stay below' },
          { value: 'atLeast', label: 'Stay above' },
        ],
      },
      numberField('limit', 'What is the line?', 'The value you must not cross.'),
      numberField('baseline', 'Where were you before? (optional)', 'Fill this in and getting closer to the line still earns part of the score.'),
    ],
    actualField: numberField('actual', 'Where did you land?', ''),
    validateConfig: (c) => {
      if (!isNum(c?.limit)) return 'Set the line you need to stay the right side of.';
      if (c.direction && !['atMost', 'atLeast'].includes(c.direction)) {
        return 'Choose whether to stay above or below the line.';
      }
      return null;
    },
    score: (c, actual) => {
      if (!isNum(actual)) return { ...UNTRACKED };
      const atMost = (c?.direction || 'atMost') === 'atMost';
      const passed = atMost ? actual <= c.limit : actual >= c.limit;

      // With a baseline this becomes a graded goal — moving from 55% to 45%
      // against a 40% ceiling is real progress and reads as 66.7%, not a flat
      // fail. Without one there is nothing to measure progress FROM, so it is
      // honestly binary. `mode` tells the UI which sentence to show.
      if (!isNum(c?.baseline)) {
        return { ...fromRatio(passed ? 1 : 0), mode: 'binary' };
      }
      const graded = gapClosed(c.baseline, c.limit, actual);
      return { ...graded, mode: 'graded', exceeded: passed && graded.rawPct > 100 };
    },
  },

  /**
   * "Land inside 1-3."
   *
   * ---- Why this is not `threshold` with a second number ---------------------
   *
   * `threshold` is ONE-SIDED and its scoring says so: `passed` is
   * `actual <= limit`, and everything on the good side of the line is equally
   * good. That is right for "keep ad spend under $5,000" and wrong for a window
   * you have to end up INSIDE, where overshooting is a miss in its own right.
   * A team asked to keep utilisation between 70% and 85% is not doing well at
   * 20%.
   *
   * It is also the shape a rank goal actually has. "Get into the top 3" is not
   * "rank at 3" (`numeric`, which would score 4 as 0% and 1 as 150%) and it is
   * not "stay under 3" either, because a rank cannot go below 1 and pretending
   * it can invites a target of 0.
   *
   * ---- Landing inside cannot be BEATEN, and that is deliberate --------------
   *
   * Every other graded type can exceed: 6,200 against a target of 6,000 is
   * 103%. A band has no such thing. Position 1 inside a band of 1-3 is the goal
   * met, not the goal beaten, so `score` returns a flat ratio of 1 and never
   * more. Awarding extra credit for landing at the far end would quietly make
   * "top 3" mean "aim for 1", which is a different promise from the one that
   * was made.
   *
   * ---- The trap, and why the same-side rule exists -------------------------
   *
   * The obvious graded branch is `gapClosed(baseline, nearEstEdge, actual)`,
   * and on its own it is spectacularly wrong in two cases that are not rare:
   *
   *   baseline INSIDE the band, actual outside. Band 1-3, started at 2, ended
   *   at 7: `gapClosed(2, 3, 7)` is `(7-2)/(3-2)` = 5, which reports 500% and
   *   the state `exceeded` for a goal that FELL OUT of its own range.
   *
   *   baseline outside on the OTHER side. Band 1-3, started at 0, ended at 7:
   *   `gapClosed(0, 1, 7)` is 7. Same failure through a different door.
   *
   * So partial credit is only ever given when the starting point was outside
   * the band ON THE SAME SIDE the result is on — the only arrangement in which
   * "how much of the distance did you close" is a question with an answer.
   * Anything else is a miss, and a miss scores zero rather than a number.
   */
  band: {
    key: 'band',
    label: 'Land inside a range',
    hint: 'A window you have to end up inside. Too high and too low are both misses.',
    useWhen: 'Being inside a range is the win, and overshooting is not better.',
    notWhen: 'Only one side matters? Use “Keep it above or below”.',
    setupShape: 'The two ends of the range',
    answerShape: 'the number you ended on',
    partialCredit: 'Only if you say where you started, and only from outside the range.',
    examples: [
      'Land in the top 3 for the main keyword',
      'Keep ad frequency between 1.5 and 3',
      'Keep the team between 80% and 95% booked',
    ],
    namePlaceholder: 'Land in the top 3',
    targetConfigKey: 'high',
    supportsUnit: true,
    configFields: [
      numberField('low', 'What is the lowest it can be?', 'The bottom end of the range. For a search position this is 1.'),
      numberField('high', 'What is the highest it can be?', 'The top end. Anywhere between the two counts as done.'),
      numberField('baseline', 'Where were you before? (optional)', 'Fill this in and getting closer to the range still earns part of the score.'),
    ],
    actualField: numberField('actual', 'Where did you land?', ''),
    validateConfig: (c) => {
      if (!isNum(c?.low) || !isNum(c?.high)) return 'Set both ends of the range.';
      if (c.low > c.high) return 'The lowest end has to be below the highest.';
      return null;
    },
    score: (c, actual) => {
      if (!isNum(actual)) return { ...UNTRACKED };
      // A row whose range never got filled in cannot be scored, and saying so
      // beats scoring it against a number that is not there. `validateConfig`
      // stops this being savable; a legacy or hand-edited row can still be it.
      if (!isNum(c?.low) || !isNum(c?.high)) return { ...UNTRACKED, reason: 'noRange' };

      // Sorted rather than trusted. The validator refuses a reversed range, so
      // this only ever fires for a row edited outside the app - and reading
      // 3-1 as an empty band would score a perfectly good result as a miss.
      const low = Math.min(c.low, c.high);
      const high = Math.max(c.low, c.high);
      const graded = isNum(c?.baseline);

      if (actual >= low && actual <= high) {
        return { ...fromRatio(1), mode: graded ? 'graded' : 'binary' };
      }

      const above = actual > high;
      const edge = above ? high : low;
      // See the header: partial credit needs a starting point OUTSIDE the band
      // on the same side as the result. Anything else divides by a gap that
      // does not exist and reports a fall out of the range as 500%.
      const sameSide = graded && (above ? c.baseline > high : c.baseline < low);
      if (!sameSide) {
        return {
          ...fromRatio(0),
          mode: graded ? 'graded' : 'binary',
          reason: graded ? 'startedInsideOrBeyond' : null,
        };
      }

      // Bounded above by construction: `actual` is strictly outside the band
      // and `edge` is its boundary, so the ratio cannot reach 1 and a band can
      // never be exceeded. It can still go NEGATIVE, which is a real answer -
      // the number moved further away - and `regressed` carries it.
      return { ...gapClosed(c.baseline, edge, actual), mode: 'graded', exceeded: false };
    },
  },

  deadline: {
    key: 'deadline',
    label: 'Hit a date',
    hint: 'Something that had to be finished by a particular day. Being late costs points.',
    useWhen: 'When it lands matters as much as whether it lands.',
    notWhen: 'Date does not really matter? Use “Did we do it?”.',
    setupShape: 'The day it is due by',
    answerShape: 'the day it was actually done',
    partialCredit: 'Yes — points come off for each day late.',
    examples: [
      'Monthly report to the client by the 5th',
      'Campaign live before the sale starts',
      'Site migration live by the 25th',
    ],
    namePlaceholder: 'Send the monthly report',
    targetConfigKey: 'dueDayKey',
    supportsUnit: false,
    configFields: [
      { key: 'dueDayKey', label: 'What day is it due by?', help: '', type: 'date' },
      numberField('penaltyPerDay', 'Points lost per day late', 'Leave blank for 10, so ten days late scores zero.'),
    ],
    // A day key, not a number — which is exactly why `Goal.actualDayKey` exists
    // as its own field rather than being crammed into `actual`.
    // "Leave blank until it ships", NOT "leave blank if it never shipped": a
    // blank day key is `untracked`, and `missingFinalValues` keeps the month
    // open until it is filled in. Blank is an unanswered question here, exactly
    // as it is for every other type — it is not a way to record a miss.
    actualField: { key: 'actualDayKey', label: 'When was it done?', help: 'Leave blank until it ships.', type: 'date' },
    validateConfig: (c) =>
      isDayKey(c?.dueDayKey) ? null : 'Pick the date this was due.',
    score: (c, actualDayKey) => {
      if (!isDayKey(actualDayKey)) return { ...UNTRACKED };
      if (compareDayKeys(actualDayKey, c.dueDayKey) <= 0) return fromRatio(1);
      const late = daysBetween(c.dueDayKey, actualDayKey);
      const penalty = isNum(c?.penaltyPerDay) ? c.penaltyPerDay : 10;
      return { ...fromRatio((100 - late * penalty) / 100), lateDays: late };
    },
  },

  rating: {
    key: 'rating',
    label: 'Judge it manually',
    hint: 'Work that matters but that nothing counts. A person decides at the end of the month.',
    useWhen: 'You would know it went well, but no report will tell you.',
    notWhen: 'Can you put a number on it? One of the other kinds will score it for you.',
    setupShape: 'Nothing to set up — just name it',
    answerShape: 'Missed, Partly there, or On track',
    partialCredit: 'Yes — “Partly there” is worth half.',
    examples: [
      'Client happy with this month',
      'Creative quality held up',
      'Team stuck to the process',
    ],
    namePlaceholder: 'Client happy with this month',
    targetConfigKey: null,
    supportsUnit: false,
    configFields: [],
    actualField: {
      key: 'actual',
      label: 'How did it go?',
      help: '',
      type: 'choice',
      choices: [
        { value: 0, label: 'Missed' },
        { value: 50, label: 'Partly there' },
        { value: 100, label: 'On track' },
      ],
    },
    validateConfig: () => null,
    score: (c, actual) => (isNum(actual) ? fromRatio(actual / 100) : { ...UNTRACKED }),
  },
};

const GOAL_TYPE_KEYS = Object.keys(GOAL_TYPES);

const isGoalType = (key) => Object.prototype.hasOwnProperty.call(GOAL_TYPES, key);

/** Throws on an unknown type, so a malformed row can never reach the database. */
const getGoalType = (key) => {
  if (!isGoalType(key)) throw new Error(`Unknown goal type: ${key}`);
  return GOAL_TYPES[key];
};

/**
 * The value a type actually reads as its result. `deadline` reads a day key;
 * everything else reads the numeric `actual`.
 */
const actualValueOf = (goal) => {
  const type = getGoalType(goal.type);
  return type.actualField.key === 'actualDayKey' ? goal.actualDayKey : goal.actual;
};

/** Score one goal. Never throws for a missing result — that is `untracked`. */
const scoreGoal = (goal) => {
  if (!goal || !isGoalType(goal.type)) return { ...UNTRACKED, reason: 'unknownType' };
  return getGoalType(goal.type).score(goal.config || {}, actualValueOf(goal));
};

const emptySummary = () => ({
  pct: null,
  state: 'empty',
  weightSum: 0,
  scoredCount: 0,
  totalCount: 0,
  pendingCount: 0,
  counts: { missed: 0, partial: 0, achieved: 0, exceeded: 0, untracked: 0 },
});

/**
 * Roll a group's goals into one weighted score.
 *
 * UNTRACKED GOALS SCORE ZERO and stay in the denominator. The score answers
 * "how much of what this group set out to do is done", so five achieved goals
 * out of twenty-one is 24% — not 100% with sixteen questions quietly dropped.
 * The earlier rule averaged only the reported goals, which meant a group could
 * show a full ring on the strength of the few numbers somebody happened to fill
 * in, and the ring would FALL as the rest arrived.
 *
 * The trade this makes, deliberately: the ring starts a month near zero and
 * climbs as results land. `pendingCount` / `totalCount` ride along so the UI
 * keeps saying "16 still to report" beside it — that sentence is what stops a
 * mid-month reading being mistaken for a final one.
 *
 * A group with no goals still scores `null`, never 0. An empty group is not a
 * failing group, and averaging it in as zero would drag the board score down for
 * every client who simply has not set goals up yet.
 */
const scoreGroup = (goals = []) => {
  const summary = emptySummary();
  summary.totalCount = goals.length;
  if (goals.length === 0) return summary;

  let weighted = 0;
  let weightSum = 0;

  for (const goal of goals) {
    const result = goal.computed || scoreGoal(goal);
    summary.counts[result.state] = (summary.counts[result.state] || 0) + 1;
    const untracked = result.state === 'untracked';
    if (untracked) summary.pendingCount += 1;
    else summary.scoredCount += 1;

    // An unreported goal is weighted exactly like a reported one — that is what
    // keeps it in the denominator. A goal weighted 0 ("track it, don't count
    // it") still contributes nothing either way.
    const weight = isNum(goal.weight) && goal.weight >= 0 ? goal.weight : 1;
    weightSum += weight;
    weighted += (untracked ? 0 : result.pct) * weight;
  }

  // Every goal deliberately weighted zero would divide by zero. Fall back to an
  // unweighted mean and say so.
  if (weightSum === 0) {
    const plain =
      goals.reduce((a, g) => {
        const r = g.computed || scoreGoal(g);
        return a + (r.state === 'untracked' ? 0 : r.pct);
      }, 0) / goals.length;
    return {
      ...summary, pct: round1(plain), state: 'scored', weightSum: 0, weightFallback: true,
    };
  }

  return { ...summary, pct: round1(weighted / weightSum), state: 'scored', weightSum };
};

/**
 * Roll group summaries into a board score.
 *
 * Averages the groups' UNROUNDED means would be ideal, but group summaries
 * arrive already rounded to one decimal; the drift is under 0.05 points and
 * rounding once more here keeps the ring and the roll-up strip showing the same
 * number, which matters more than the fourth significant figure.
 *
 * Groups with NO GOALS are excluded from the denominator — the only kind that
 * scores `null` now that a group's unreported goals count as zero inside it.
 *
 * `groupsEmpty` counts those groups, and it is reported separately from
 * `groupsTotal - groupsScored` because those are two different sentences: a
 * group with three unreported goals is waiting on somebody, and a group with no
 * goals is not. Collapsing them tells a board with twenty-four goal-less groups
 * that twenty-four groups are late.
 */
const scoreBoard = (summaries = []) => {
  const scored = summaries.filter((s) => s && typeof s.pct === 'number');
  const counts = { missed: 0, partial: 0, achieved: 0, exceeded: 0, untracked: 0 };
  let totalGoals = 0;
  let groupsEmpty = 0;
  for (const s of summaries) {
    totalGoals += s?.totalCount || 0;
    if (!s?.totalCount) groupsEmpty += 1;
    for (const k of Object.keys(counts)) counts[k] += s?.counts?.[k] || 0;
  }
  if (scored.length === 0) {
    return {
      pct: null,
      state: 'empty',
      groupsScored: 0,
      groupsTotal: summaries.length,
      groupsEmpty,
      counts,
      totalGoals,
    };
  }
  const mean = scored.reduce((a, s) => a + s.pct, 0) / scored.length;
  return {
    pct: round1(mean),
    state: 'scored',
    groupsScored: scored.length,
    groupsTotal: summaries.length,
    groupsEmpty,
    counts,
    totalGoals,
  };
};

/**
 * Which fields must be filled before a month can be considered closed?
 *
 * Two sources: the type's own result field, and any goal column an org admin has
 * marked required. A column that became required AFTER a row was written does
 * not retroactively break that row — `requiredSince` is what makes that
 * distinction storable rather than guessed.
 */
const missingFinalValues = (goal, goalColumns = []) => {
  const missing = [];
  if (!goal || !isGoalType(goal.type)) return missing;

  const type = getGoalType(goal.type);
  const value = actualValueOf(goal);
  if (value === null || value === undefined || value === '') {
    missing.push({ field: type.actualField.key, label: type.actualField.label });
  }

  const values = goal.columnValues instanceof Map
    ? Object.fromEntries(goal.columnValues)
    : (goal.columnValues || {});

  for (const col of goalColumns) {
    if (!col.required || col.archived) continue;
    if (col.requiredSince && goal.createdAt && new Date(goal.createdAt) < new Date(col.requiredSince)) {
      continue; // predates the rule
    }
    const v = values[String(col._id)];
    if (v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) {
      missing.push({ field: String(col._id), label: col.name });
    }
  }
  return missing;
};

/**
 * Is this month overdue for its final numbers?
 *
 * The current month and any future month are never "unclosed" — the month is
 * not over, so of course the numbers are not in. A month nobody used is not
 * unclosed either; a board that does not do goals should not be nagged.
 */
const monthIsUnclosed = (monthKey, currentMonthKey, goals = [], goalColumns = []) => {
  if (!monthKey || !currentMonthKey) return false;
  if (monthKey >= currentMonthKey) return false;
  if (goals.length === 0) return false;
  return goals.some((g) => missingFinalValues(g, goalColumns).length > 0);
};

/** Display string for a value, given the goal's unit. Server-authoritative. */
const formatValue = (value, goal) => {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (!isNum(value)) return String(value);
  const unit = goal?.unit || 'none';
  const n = value.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (unit === 'percent') return `${n}%`;
  // Money is USD — the symbol is fixed, not read from `unitLabel`.
  if (unit === 'currency') return `$${n}`;
  if (unit === 'custom' && goal.unitLabel) return `${n} ${goal.unitLabel}`;
  return n;
};

/**
 * The type table as the client needs it for form generation — no functions.
 * Served by `GET /api/goal-types` so the add-a-goal form is generated from the
 * same table the scorer uses, rather than a hand-kept copy that drifts.
 *
 * `example` is the singular kept for older clients, which rendered one line of
 * example text per card; it is simply the first of `examples`, so there is still
 * only one place to edit the wording.
 */
const describeGoalTypes = () =>
  GOAL_TYPE_KEYS.map((key) => {
    const t = GOAL_TYPES[key];
    return {
      key: t.key,
      label: t.label,
      hint: t.hint,
      useWhen: t.useWhen,
      notWhen: t.notWhen,
      setupShape: t.setupShape,
      answerShape: t.answerShape,
      partialCredit: t.partialCredit,
      examples: t.examples,
      example: t.examples[0],
      namePlaceholder: t.namePlaceholder,
      /**
       * WHICH config field the goals table's "Target" cell edits, declared
       * here rather than in a table on the client.
       *
       * `goalDisplay.targetFieldOf` used to carry its own `{numeric: 'target',
       * checklist: 'total', threshold: 'limit', deadline: 'dueDayKey'}` map,
       * which is a second declaration of something this file already knows -
       * and the failure it produces is silent: a type the map has never heard
       * of renders an uneditable dash where its target should be, on every row,
       * with nothing to say why. `band` was the type that found it.
       *
       * NULL is a real answer and the important one: `boolean` and `rating`
       * promise no number at all, so their Target cell must stay a dash you
       * cannot type into.
       */
      targetConfigKey: t.targetConfigKey ?? null,
      supportsUnit: t.supportsUnit,
      configFields: t.configFields,
      actualField: t.actualField,
    };
  });

module.exports = {
  GOAL_TYPES,
  GOAL_TYPE_KEYS,
  STATES,
  UNITS,
  isGoalType,
  getGoalType,
  actualValueOf,
  scoreGoal,
  scoreGroup,
  scoreBoard,
  missingFinalValues,
  monthIsUnclosed,
  formatValue,
  describeGoalTypes,
};
