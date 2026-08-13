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
 * baseline — a keyword rank going 5 → 3, a bounce rate coming down — both the
 * numerator and the denominator go negative and the same expression already
 * reads correctly. That is the whole reason this formula was chosen over
 * `actual / target`.
 *
 * ADDING A TYPE is one entry in `GOAL_TYPES`. Because each entry declares its
 * own `configFields` and `actualField`, the client's add-a-goal form is
 * generated from this table rather than switch-cased against it — so a new type
 * arrives in the UI with correct inputs and plain-language labels for free.
 */

const { compareDayKeys, daysBetween, isDayKey } = require('./tzDay');

/** Outcome bands. `untracked` is not a failure — it is an unanswered question. */
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
    hint: 'Take a measurement from where it is now to where you want it.',
    example: 'Get organic traffic from 4,200 to 6,000',
    // Works in both directions with no extra setting: a target below the
    // baseline simply flips both signs of the ratio.
    supportsUnit: true,
    configFields: [
      numberField('baseline', 'Where are you starting from?', 'Last month’s number. Leave blank if you are starting from zero.'),
      numberField('target', 'Where do you want to get to?', 'The number that means this went well.'),
    ],
    actualField: numberField('actual', 'Where did you land?', 'Fill this in at the end of the month.'),
    validateConfig: (c) => (isNum(c?.target) ? null : 'Set the number you are aiming for.'),
    score: (c, actual) => gapClosed(c?.baseline, c?.target, actual),
  },

  boolean: {
    key: 'boolean',
    label: 'Did we do it?',
    hint: 'A goal that is either done or not. No partial credit.',
    example: 'Publish the case study',
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
    hint: 'Counting things you said you would deliver.',
    example: 'Publish 8 blog posts',
    supportsUnit: false,
    configFields: [
      numberField('total', 'How many?', 'The number you committed to.'),
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
    hint: 'A line you must not cross, rather than a number to reach.',
    example: 'Keep page load under 2.5 seconds',
    supportsUnit: true,
    configFields: [
      {
        key: 'direction',
        label: 'Which way?',
        help: '',
        type: 'choice',
        choices: [
          { value: 'atMost', label: 'Stay below' },
          { value: 'atLeast', label: 'Stay above' },
        ],
      },
      numberField('limit', 'The line', 'The value you must stay the right side of.'),
      numberField('baseline', 'Where were you before? (optional)', 'Give this and you get partial credit for getting closer.'),
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

  deadline: {
    key: 'deadline',
    label: 'Hit a date',
    hint: 'Something that had to be finished by a particular day.',
    example: 'Site migration live by the 25th',
    supportsUnit: false,
    configFields: [
      { key: 'dueDayKey', label: 'By when?', help: '', type: 'date' },
      numberField('penaltyPerDay', 'Points lost per day late', 'Defaults to 10, so ten days late scores zero.'),
    ],
    // A day key, not a number — which is exactly why `Goal.actualDayKey` exists
    // as its own field rather than being crammed into `actual`.
    actualField: { key: 'actualDayKey', label: 'When was it done?', help: 'Leave blank if it never shipped.', type: 'date' },
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
    hint: 'For work that matters but has no number. Someone decides.',
    example: 'Client satisfaction this month',
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
 * UNTRACKED GOALS ARE EXCLUDED, not counted as zero. A month where two of five
 * numbers have been filled in is a month that is 40% reported, not a month that
 * is failing — scoring the blanks as zero would show a catastrophe on the 3rd
 * and slowly climb as people typed. `scoredCount` / `totalCount` ride along so
 * the UI can say "3 of 5 goals reported" rather than implying the score is final.
 *
 * A group with no goals scores `null`, never 0. An empty group is not a failing
 * group, and averaging it in as zero would drag the board score down for every
 * client who simply has not set goals up yet.
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
    if (result.state === 'untracked') {
      summary.pendingCount += 1;
      continue;
    }
    const weight = isNum(goal.weight) && goal.weight >= 0 ? goal.weight : 1;
    summary.scoredCount += 1;
    weightSum += weight;
    weighted += result.pct * weight;
  }

  if (summary.scoredCount === 0) {
    return { ...summary, state: 'pending' };
  }

  // Every scored goal deliberately weighted zero ("track it, don't count it")
  // would divide by zero. Fall back to an unweighted mean and say so.
  if (weightSum === 0) {
    const plain =
      goals
        .filter((g) => (g.computed || scoreGoal(g)).state !== 'untracked')
        .reduce((a, g) => a + (g.computed || scoreGoal(g)).pct, 0) / summary.scoredCount;
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
 * Groups that scored nothing are excluded from the denominator for the same
 * reason untracked goals are.
 */
const scoreBoard = (summaries = []) => {
  const scored = summaries.filter((s) => s && typeof s.pct === 'number');
  const counts = { missed: 0, partial: 0, achieved: 0, exceeded: 0, untracked: 0 };
  let totalGoals = 0;
  for (const s of summaries) {
    totalGoals += s?.totalCount || 0;
    for (const k of Object.keys(counts)) counts[k] += s?.counts?.[k] || 0;
  }
  if (scored.length === 0) {
    return { pct: null, state: 'empty', groupsScored: 0, groupsTotal: summaries.length, counts, totalGoals };
  }
  const mean = scored.reduce((a, s) => a + s.pct, 0) / scored.length;
  return {
    pct: round1(mean),
    state: 'scored',
    groupsScored: scored.length,
    groupsTotal: summaries.length,
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
 */
const describeGoalTypes = () =>
  GOAL_TYPE_KEYS.map((key) => {
    const t = GOAL_TYPES[key];
    return {
      key: t.key,
      label: t.label,
      hint: t.hint,
      example: t.example,
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
