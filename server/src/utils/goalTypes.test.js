const { test } = require('node:test');
const assert = require('node:assert');

const {
  GOAL_TYPE_KEYS,
  getGoalType,
  scoreGoal,
  scoreGroup,
  scoreBoard,
  missingFinalValues,
  monthIsUnclosed,
  formatValue,
  describeGoalTypes,
} = require('./goalTypes');

const goal = (over = {}) => ({ type: 'numeric', weight: 1, config: {}, ...over });

// ---------------------------------------------------------------------------
// numeric — the formula everything else leans on
// ---------------------------------------------------------------------------

test('the user’s own example: rank 5 → 3, landed on 4, is half the gap', () => {
  const r = scoreGoal(goal({ config: { baseline: 5, target: 3 }, actual: 4 }));
  assert.strictEqual(r.pct, 50);
  assert.strictEqual(r.state, 'partial');
});

test('a DESCENDING target needs no special case', () => {
  // Both numerator and denominator go negative and cancel. This is the entire
  // reason the formula is (actual−baseline)/(target−baseline).
  const hit = scoreGoal(goal({ config: { baseline: 5, target: 3 }, actual: 3 }));
  assert.strictEqual(hit.pct, 100);
  assert.strictEqual(hit.state, 'achieved');

  const beat = scoreGoal(goal({ config: { baseline: 5, target: 3 }, actual: 2 }));
  assert.strictEqual(beat.state, 'exceeded');
  assert.strictEqual(beat.pct, 100, 'capped');
  assert.strictEqual(beat.rawPct, 150, 'but the real figure is kept');

  const worse = scoreGoal(goal({ config: { baseline: 5, target: 3 }, actual: 7 }));
  assert.strictEqual(worse.pct, 0);
  assert.strictEqual(worse.state, 'missed');
  assert.strictEqual(worse.regressed, true);
});

test('an ASCENDING target uses the identical path', () => {
  const r = scoreGoal(goal({ config: { baseline: 1200, target: 1800 }, actual: 1500 }));
  assert.strictEqual(r.pct, 50);

  const over = scoreGoal(goal({ config: { baseline: 1200, target: 1800 }, actual: 1910 }));
  assert.strictEqual(over.state, 'exceeded');
  assert.strictEqual(over.pct, 100);
});

test('baseline === target is met-or-not, and says why', () => {
  const met = scoreGoal(goal({ config: { baseline: 3, target: 3 }, actual: 3 }));
  assert.strictEqual(met.pct, 100);
  assert.strictEqual(met.reason, 'zeroGap');

  const not = scoreGoal(goal({ config: { baseline: 3, target: 3 }, actual: 4 }));
  assert.strictEqual(not.pct, 0);
  assert.strictEqual(not.reason, 'zeroGap');
  // The bug this guards: dividing by (target − baseline) === 0.
  assert.ok(Number.isFinite(met.pct) && Number.isFinite(not.pct));
});

test('a missing baseline is assumed zero but flagged, never silent', () => {
  const r = scoreGoal(goal({ config: { target: 6000 }, actual: 5640 }));
  assert.strictEqual(r.pct, 94);
  assert.strictEqual(r.assumedBaseline, true);
});

test('a missing actual is untracked, not zero', () => {
  for (const actual of [null, undefined]) {
    const r = scoreGoal(goal({ config: { baseline: 1, target: 10 }, actual }));
    assert.strictEqual(r.state, 'untracked');
    assert.strictEqual(r.pct, null, 'null, so it can be excluded rather than averaged as 0');
  }
});

// ---------------------------------------------------------------------------
// The other types
// ---------------------------------------------------------------------------

test('boolean is all or nothing, and distinguishes "no" from "not answered"', () => {
  assert.strictEqual(scoreGoal(goal({ type: 'boolean', actual: 1 })).pct, 100);
  assert.strictEqual(scoreGoal(goal({ type: 'boolean', actual: true })).pct, 100);

  const answeredNo = scoreGoal(goal({ type: 'boolean', actual: 0 }));
  assert.strictEqual(answeredNo.pct, 0);
  assert.strictEqual(answeredNo.state, 'missed');

  const unanswered = scoreGoal(goal({ type: 'boolean', actual: null }));
  assert.strictEqual(unanswered.state, 'untracked');
  // These two must never collapse together: one blocks closing the month.
  assert.notStrictEqual(answeredNo.state, unanswered.state);
});

test('checklist is done-over-total, and 0 of 0 does not divide by zero', () => {
  const r = scoreGoal(goal({ type: 'checklist', config: { total: 8 }, actual: 6 }));
  assert.strictEqual(r.pct, 75);

  const empty = scoreGoal(goal({ type: 'checklist', config: { total: 0 }, actual: 0 }));
  assert.strictEqual(empty.pct, 100);
  assert.strictEqual(empty.reason, 'emptyChecklist');

  const over = scoreGoal(goal({ type: 'checklist', config: { total: 8 }, actual: 10 }));
  assert.strictEqual(over.state, 'exceeded');
});

test('threshold is binary without a baseline and graded with one', () => {
  const binPass = scoreGoal(goal({
    type: 'threshold', config: { direction: 'atMost', limit: 2.5 }, actual: 2.1,
  }));
  assert.strictEqual(binPass.pct, 100);
  assert.strictEqual(binPass.mode, 'binary');

  const binFail = scoreGoal(goal({
    type: 'threshold', config: { direction: 'atMost', limit: 2.5 }, actual: 3.4,
  }));
  assert.strictEqual(binFail.pct, 0);

  // 55 → 40 ceiling, landed 45: two thirds of the way there, not a flat fail.
  const graded = scoreGoal(goal({
    type: 'threshold', config: { direction: 'atMost', limit: 40, baseline: 55 }, actual: 45,
  }));
  assert.strictEqual(graded.pct, 66.7);
  assert.strictEqual(graded.mode, 'graded');

  const atLeast = scoreGoal(goal({
    type: 'threshold', config: { direction: 'atLeast', limit: 99.9 }, actual: 99.95,
  }));
  assert.strictEqual(atLeast.pct, 100);
});

test('deadline scores on time, late, and never', () => {
  const cfg = { dueDayKey: '2026-08-15' };
  assert.strictEqual(scoreGoal(goal({ type: 'deadline', config: cfg, actualDayKey: '2026-08-15' })).pct, 100);
  assert.strictEqual(scoreGoal(goal({ type: 'deadline', config: cfg, actualDayKey: '2026-08-10' })).pct, 100);

  const late = scoreGoal(goal({ type: 'deadline', config: cfg, actualDayKey: '2026-08-18' }));
  assert.strictEqual(late.lateDays, 3);
  assert.strictEqual(late.pct, 70, 'three days at the default ten points a day');

  const veryLate = scoreGoal(goal({ type: 'deadline', config: cfg, actualDayKey: '2026-09-20' }));
  assert.strictEqual(veryLate.pct, 0, 'clamped, never negative');

  assert.strictEqual(
    scoreGoal(goal({ type: 'deadline', config: cfg, actualDayKey: null })).state,
    'untracked'
  );
});

test('rating passes its scale through', () => {
  assert.strictEqual(scoreGoal(goal({ type: 'rating', actual: 100 })).state, 'achieved');
  assert.strictEqual(scoreGoal(goal({ type: 'rating', actual: 50 })).state, 'partial');
  assert.strictEqual(scoreGoal(goal({ type: 'rating', actual: 0 })).state, 'missed');
});

test('an unknown type is untracked rather than an exception', () => {
  const r = scoreGoal({ type: 'telepathy', config: {}, actual: 5 });
  assert.strictEqual(r.state, 'untracked');
  assert.strictEqual(r.reason, 'unknownType');
  // But looking one up deliberately still throws, so bad data cannot be saved.
  assert.throws(() => getGoalType('telepathy'), /Unknown goal type/);
});

// ---------------------------------------------------------------------------
// Rolling up
// ---------------------------------------------------------------------------

test('a group score is the WEIGHTED mean of its scored goals', () => {
  const g = [
    goal({ config: { baseline: 0, target: 100 }, actual: 100, weight: 1 }), // 100
    goal({ config: { baseline: 0, target: 100 }, actual: 0, weight: 1 }), //   0
  ];
  assert.strictEqual(scoreGroup(g).pct, 50);

  // Weighting the achieved one triple pulls the mean to 75.
  g[0].weight = 3;
  assert.strictEqual(scoreGroup(g).pct, 75);
});

test('untracked goals are EXCLUDED from the mean, not scored zero', () => {
  const s = scoreGroup([
    goal({ config: { baseline: 0, target: 100 }, actual: 80 }),
    goal({ config: { baseline: 0, target: 100 }, actual: null }),
  ]);
  assert.strictEqual(s.pct, 80, 'not 40 — a blank is an unanswered question');
  assert.strictEqual(s.scoredCount, 1);
  assert.strictEqual(s.totalCount, 2);
  assert.strictEqual(s.pendingCount, 1);
});

test('a group with no goals scores null, never 0', () => {
  const s = scoreGroup([]);
  assert.strictEqual(s.pct, null);
  assert.strictEqual(s.state, 'empty');
});

test('a group where nothing has been reported yet is pending, not zero', () => {
  const s = scoreGroup([goal({ config: { target: 10 }, actual: null })]);
  assert.strictEqual(s.pct, null);
  assert.strictEqual(s.state, 'pending');
});

test('all-zero weights fall back to an unweighted mean instead of NaN', () => {
  const s = scoreGroup([
    goal({ config: { baseline: 0, target: 100 }, actual: 100, weight: 0 }),
    goal({ config: { baseline: 0, target: 100 }, actual: 0, weight: 0 }),
  ]);
  assert.strictEqual(s.pct, 50);
  assert.strictEqual(s.weightFallback, true);
  assert.ok(!Number.isNaN(s.pct));
});

test('a single weight-0 goal is tracked but does not move the score', () => {
  const s = scoreGroup([
    goal({ config: { baseline: 0, target: 100 }, actual: 90, weight: 1 }),
    goal({ config: { baseline: 0, target: 100 }, actual: 0, weight: 0 }),
  ]);
  assert.strictEqual(s.pct, 90);
  assert.strictEqual(s.scoredCount, 2, 'still counted and displayed');
});

test('the board score averages GROUPS, skipping ones that scored nothing', () => {
  const b = scoreBoard([
    scoreGroup([goal({ config: { baseline: 0, target: 100 }, actual: 100 })]),
    scoreGroup([goal({ config: { baseline: 0, target: 100 }, actual: 50 })]),
    scoreGroup([]), // an empty group must not drag the board to 50
  ]);
  assert.strictEqual(b.pct, 75);
  assert.strictEqual(b.groupsScored, 2);
  assert.strictEqual(b.groupsTotal, 3);
  assert.strictEqual(b.counts.achieved, 1);
  assert.strictEqual(b.counts.partial, 1);
});

test('a group with no goals is counted as empty, not as one still to report', () => {
  const b = scoreBoard([
    scoreGroup([goal({ config: { baseline: 0, target: 100 }, actual: 100 })]),
    scoreGroup([goal({ config: { target: 10 }, actual: null })]), // waiting on somebody
    scoreGroup([]), // never set any up
    scoreGroup([]),
  ]);
  assert.strictEqual(b.groupsEmpty, 2);
  assert.strictEqual(b.groupsScored, 1);
  // groupsTotal - groupsEmpty - groupsScored is the number genuinely awaited.
  assert.strictEqual(b.groupsTotal - b.groupsEmpty - b.groupsScored, 1);
});

test('an all-empty board reports its empty groups too', () => {
  const b = scoreBoard([scoreGroup([]), scoreGroup([])]);
  assert.strictEqual(b.state, 'empty');
  assert.strictEqual(b.groupsEmpty, 2);
});

// ---------------------------------------------------------------------------
// Closing a month
// ---------------------------------------------------------------------------

const col = (over = {}) => ({
  _id: 'c1', name: 'Report link', required: true, archived: false, requiredSince: null, ...over,
});

test('missingFinalValues catches a blank result and a blank required column', () => {
  const blank = missingFinalValues(goal({ config: { target: 10 }, actual: null }), []);
  assert.strictEqual(blank.length, 1);
  assert.strictEqual(blank[0].field, 'actual');

  const filled = goal({ config: { target: 10 }, actual: 9, columnValues: {} });
  assert.strictEqual(missingFinalValues(filled, [col()]).length, 1, 'required column empty');
  assert.strictEqual(
    missingFinalValues({ ...filled, columnValues: { c1: 'https://x' } }, [col()]).length,
    0
  );
});

test('a column made required LATER does not retroactively break old rows', () => {
  const old = goal({
    config: { target: 10 }, actual: 9, columnValues: {}, createdAt: '2026-07-01',
  });
  const madeRequiredLater = col({ requiredSince: '2026-08-01' });
  assert.deepStrictEqual(missingFinalValues(old, [madeRequiredLater]), []);

  const fresh = { ...old, createdAt: '2026-08-05' };
  assert.strictEqual(missingFinalValues(fresh, [madeRequiredLater]).length, 1);
});

test('an archived column is never required', () => {
  const g = goal({ config: { target: 10 }, actual: 9, columnValues: {} });
  assert.deepStrictEqual(missingFinalValues(g, [col({ archived: true })]), []);
});

test('missingFinalValues reads a Mongoose Map as happily as a plain object', () => {
  const g = goal({
    config: { target: 10 }, actual: 9, columnValues: new Map([['c1', 'https://x']]),
  });
  assert.deepStrictEqual(missingFinalValues(g, [col()]), []);
});

test('only a PAST month with gaps is unclosed', () => {
  const gaps = [goal({ config: { target: 10 }, actual: null })];
  const done = [goal({ config: { target: 10 }, actual: 10 })];

  assert.strictEqual(monthIsUnclosed('2026-07', '2026-08', gaps), true);
  assert.strictEqual(monthIsUnclosed('2026-07', '2026-08', done), false);
  assert.strictEqual(monthIsUnclosed('2026-08', '2026-08', gaps), false, 'this month is not late');
  assert.strictEqual(monthIsUnclosed('2026-09', '2026-08', gaps), false, 'nor is next month');
  assert.strictEqual(monthIsUnclosed('2026-07', '2026-08', []), false, 'a month nobody used');
});

// ---------------------------------------------------------------------------
// Formatting and the served descriptor
// ---------------------------------------------------------------------------

test('formatValue respects the unit', () => {
  assert.strictEqual(formatValue(2.1, { unit: 'percent' }), '2.1%');
  // Money is USD regardless of what `unitLabel` happens to hold.
  assert.strictEqual(formatValue(40000, { unit: 'currency', unitLabel: '$' }), '$40,000');
  assert.strictEqual(formatValue(40000, { unit: 'currency', unitLabel: '' }), '$40,000');
  assert.strictEqual(formatValue(12, { unit: 'custom', unitLabel: 'posts' }), '12 posts');
  assert.strictEqual(formatValue(1234.5, { unit: 'none' }), '1,234.5');
  assert.strictEqual(formatValue(null, {}), '—');
  assert.strictEqual(formatValue(true, {}), 'Yes');
});

test('every type is describable to the client, with no functions leaking', () => {
  const described = describeGoalTypes();
  assert.strictEqual(described.length, GOAL_TYPE_KEYS.length);
  for (const t of described) {
    assert.ok(t.label && t.hint && t.example, `${t.key} needs plain-language copy`);
    assert.ok(Array.isArray(t.configFields));
    assert.ok(t.actualField?.key);
    assert.strictEqual(JSON.stringify(t).includes('function'), false);
    // The form is generated from this, so every field needs a human label.
    for (const f of [...t.configFields, t.actualField]) {
      assert.ok(f.label, `${t.key}.${f.key} needs a label`);
    }
  }
});

test('every type validates its own config', () => {
  for (const key of GOAL_TYPE_KEYS) {
    const t = getGoalType(key);
    assert.strictEqual(typeof t.validateConfig, 'function');
    // An empty config either passes (no required setup) or explains itself.
    const err = t.validateConfig({});
    if (err !== null) assert.strictEqual(typeof err, 'string');
  }
});
