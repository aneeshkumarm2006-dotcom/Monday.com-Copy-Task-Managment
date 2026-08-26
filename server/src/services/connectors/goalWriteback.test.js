const test = require('node:test');
const assert = require('node:assert/strict');

const {
  planGoalWrites,
  selectSnapshots,
  applyWrite,
  stampLink,
  resolveMappings,
  shiftDayKey,
} = require('../connectorGoalWriteback');
const {
  isEmptyCellValue,
  sameCellValue,
  readGoalTarget,
  targetAppliesTo,
} = require('./fieldMapping');
const { getGoalType } = require('../../utils/goalTypes');
const ubersuggest = require('./ubersuggest');

/**
 * The writeback's decisions, asserted without a database.
 *
 * Everything interesting in this feature is a DECISION rather than a query: may
 * this run overwrite that cell, which week's reading fills a starting point, and
 * what happens to a value that came back null. All three are pure, all three are
 * the part that has to be right, and all three are exercised here against the
 * REAL Ubersuggest field catalog rather than a stub of it — a catalog change
 * that broke the join would otherwise pass.
 *
 * The ownership rule is the reason this file is long. A team stops trusting an
 * integration the first time it silently overwrites something somebody typed,
 * so "refused to overwrite a hand edit" is a correctness property here, not a
 * nicety.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const COL_VOLUME = '6b466b99ea3ab35ff1378e01';
const COL_KD = '6b466b99ea3ab35ff1378e02';
const COL_INTENT = '6b466b99ea3ab35ff1378e03';
const COL_ARCHIVED = '6b466b99ea3ab35ff1378e04';

const makeBoard = () => ({
  _id: '6b466b99ea3ab35ff1378d20',
  goalColumns: [
    { _id: COL_VOLUME, name: 'Volume', key: 'volume', type: 'number', order: 0 },
    { _id: COL_KD, name: 'KD', key: 'keyword_difficultly', type: 'number', order: 1 },
    { _id: COL_INTENT, name: 'Intent', key: 'intent', type: 'text', order: 2 },
    {
      _id: COL_ARCHIVED,
      name: 'Old CPC',
      key: 'cpc',
      type: 'number',
      order: 3,
      archived: true,
    },
  ],
});

/** Mapping rows as they sit in the database, before resolution. */
const MAPPING_ROWS = [
  {
    provider: 'ubersuggest',
    sourceField: 'rank',
    target: { kind: 'goalBuiltin', builtin: 'actual', columnId: null },
    autoFill: true,
  },
  {
    provider: 'ubersuggest',
    sourceField: 'rank_previous',
    target: { kind: 'goalBuiltin', builtin: 'config.baseline', columnId: null },
    autoFill: true,
  },
  {
    provider: 'ubersuggest',
    sourceField: 'volume',
    target: { kind: 'goalColumn', builtin: null, columnId: COL_VOLUME },
    autoFill: true,
  },
  {
    provider: 'ubersuggest',
    sourceField: 'seo_difficulty',
    target: { kind: 'goalColumn', builtin: null, columnId: COL_KD },
    autoFill: true,
  },
  {
    provider: 'ubersuggest',
    sourceField: 'search_intent',
    target: { kind: 'goalColumn', builtin: null, columnId: COL_INTENT },
    autoFill: true,
  },
  {
    provider: 'ubersuggest',
    sourceField: 'cpc',
    target: { kind: 'goalColumn', builtin: null, columnId: COL_ARCHIVED },
    autoFill: true,
  },
];

const KEYWORD = 'best crm for agencies';

const positionsData = ({ position = 4, previousPosition = 9 } = {}) => ({
  done: true,
  updatedAt: '2026-08-14T00:00:00.000Z',
  keywords: [
    {
      keyword: KEYWORD,
      status: 'ok',
      position,
      previousPosition,
      ranked: position !== null,
      url: 'https://example.com/crm',
      change: previousPosition === null || position === null ? null : previousPosition - position,
      movement: 'up',
    },
  ],
  averagePositions: [{ date: '2026-08-14', value: 22 }],
  totals: { tracked: 1, ranking: 1, notRanking: 0, pending: 0, improved: 1, declined: 0, unchanged: 0 },
  binned: {},
});

const metricsData = ({ volume = 1400, difficulty = 42, intent = 'commercial' } = {}) => ({
  keywords: [
    {
      keyword: KEYWORD,
      volume,
      cpc: 12.5,
      difficulty,
      paidDifficulty: 31,
      competition: 0.8,
      intent,
    },
  ],
  trackedTotal: 1,
  truncated: false,
});

const snapshotsFor = ({ positions, metrics, baselinePositions } = {}) => {
  const map = new Map();
  map.set('positions', {
    latest: positions === null ? null : {
      periodKey: '2026-08-14',
      collectedAt: new Date('2026-08-14T00:00:00.000Z'),
      data: positions || positionsData(),
    },
    monthStart: baselinePositions === null ? null : {
      periodKey: '2026-07-31',
      collectedAt: new Date('2026-07-31T00:00:00.000Z'),
      data: baselinePositions || positionsData({ position: 12, previousPosition: 18 }),
    },
  });
  map.set('keyword_metrics', {
    latest: metrics === null ? null : {
      periodKey: '2026-08-14',
      collectedAt: null,
      data: metrics || metricsData(),
    },
    monthStart: null,
  });
  return map;
};

const makeGoal = (overrides = {}) => ({
  _id: '6b466b99ea3ab35ff1378a01',
  type: 'numeric',
  monthKey: '2026-08',
  actual: null,
  actualDayKey: null,
  config: {},
  columnValues: {},
  ...overrides,
});

const makeLink = (overrides = {}) => ({
  keyword: KEYWORD,
  autoFill: true,
  claimedAt: null,
  applied: {},
  suggested: {},
  ...overrides,
});

const plan = ({
  goal = makeGoal(),
  link = makeLink(),
  mappings = resolveMappings(makeBoard(), MAPPING_ROWS),
  snapshots = snapshotsFor(),
  canWrite = () => true,
} = {}) =>
  planGoalWrites({
    goal,
    link,
    mappings,
    fieldFor: (key) => ubersuggest.fields.find((f) => f.key === key) || null,
    readField: ubersuggest.readField,
    snapshots,
    canWrite,
    now: new Date('2026-08-20T09:00:00.000Z'),
  });

const byField = (rows) => Object.fromEntries(rows.map((r) => [r.sourceField, r]));

// ---------------------------------------------------------------------------
// The pure helpers in fieldMapping.js
// ---------------------------------------------------------------------------

test('a zero is a value, not an empty cell', () => {
  assert.equal(isEmptyCellValue(0), false);
  assert.equal(isEmptyCellValue(false), false);
  assert.equal(isEmptyCellValue(null), true);
  assert.equal(isEmptyCellValue(undefined), true);
  assert.equal(isEmptyCellValue(''), true);
  assert.equal(isEmptyCellValue([]), true);
});

test('sameCellValue survives the widening a number-into-text mapping allows', () => {
  // The mapping table permits `number → text`, so the value the connector wrote
  // can come back as a string. If this said they differed, the connector would
  // decide a human had edited the cell one run after writing it itself.
  assert.equal(sameCellValue(4, '4'), true);
  assert.equal(sameCellValue(4, 5), false);
  assert.equal(sameCellValue('commercial', 'commercial'), true);
  assert.equal(sameCellValue(null, ''), true);
  assert.equal(sameCellValue(0, null), false);
  assert.equal(
    sameCellValue(new Date('2026-08-14T00:00:00.000Z'), '2026-08-14T00:00:00.000Z'),
    true
  );
});

test('readGoalTarget handles columnValues as a Map and as a plain object', () => {
  const target = { kind: 'goalColumn', columnId: COL_VOLUME };
  assert.equal(readGoalTarget({ columnValues: { [COL_VOLUME]: 1400 } }, target), 1400);
  assert.equal(
    readGoalTarget({ columnValues: new Map([[COL_VOLUME, 1400]]) }, target),
    1400
  );
  assert.equal(readGoalTarget({ config: { baseline: 9 } }, { kind: 'goalBuiltin', builtin: 'config.baseline' }), 9);
  assert.equal(readGoalTarget({ actual: 4 }, { kind: 'goalBuiltin', builtin: 'actual' }), 4);
});

test('targetAppliesTo asks the goal TYPE, not a list of type names', () => {
  const numeric = getGoalType('numeric');
  const checklist = getGoalType('checklist');
  const deadline = getGoalType('deadline');

  assert.equal(targetAppliesTo({ kind: 'goalBuiltin', builtin: 'config.target' }, numeric), true);
  // A checklist promises a `total`, not a `target`. Writing one would add a key
  // its scorer never reads.
  assert.equal(targetAppliesTo({ kind: 'goalBuiltin', builtin: 'config.target' }, checklist), false);
  // A deadline records a day key; a number in `actual` would be invisible.
  assert.equal(targetAppliesTo({ kind: 'goalBuiltin', builtin: 'actual' }, deadline), false);
  assert.equal(targetAppliesTo({ kind: 'goalBuiltin', builtin: 'actualDayKey' }, deadline), true);
  // A column is the board's shared schema — every goal carries it.
  assert.equal(targetAppliesTo({ kind: 'goalColumn', columnId: COL_VOLUME }, deadline), true);
});

// ---------------------------------------------------------------------------
// resolveMappings
// ---------------------------------------------------------------------------

test('resolveMappings drops a mapping onto an archived column', () => {
  const rows = resolveMappings(makeBoard(), MAPPING_ROWS);
  assert.equal(rows.some((r) => r.sourceField === 'cpc'), false);
  assert.equal(rows.length, MAPPING_ROWS.length - 1);
});

test('resolveMappings takes the capability and the period from the TARGET', () => {
  const rows = byField(resolveMappings(makeBoard(), MAPPING_ROWS));
  assert.equal(rows.rank.targetCapability, 'goal.track');
  assert.equal(rows.rank.targetPeriod, 'latest');
  // The promise half of a goal, and the one target that looks backwards.
  assert.equal(rows.rank_previous.targetCapability, 'goal.manage');
  assert.equal(rows.rank_previous.targetPeriod, 'monthStart');
  assert.equal(rows.volume.targetCapability, 'goal.track');
});

test('resolveMappings drops a mapping naming a column that is not on the board', () => {
  const rows = resolveMappings(makeBoard(), [
    {
      provider: 'ubersuggest',
      sourceField: 'volume',
      target: { kind: 'goalColumn', columnId: '6b466b99ea3ab35ff1378eff', builtin: null },
      autoFill: true,
    },
  ]);
  assert.deepEqual(rows, []);
});

// ---------------------------------------------------------------------------
// selectSnapshots
// ---------------------------------------------------------------------------

const row = (kind, periodKey, extra = {}) => ({
  kind,
  variant: 'default',
  periodKey,
  data: {},
  ...extra,
});

test('latest is the newest reading INSIDE the month, never a later one', () => {
  const picked = selectSnapshots(
    [
      row('positions', '2026-09-04'),
      row('positions', '2026-08-28'),
      row('positions', '2026-08-07'),
    ],
    { monthStart: '2026-08-01', monthEnd: '2026-08-31' }
  );
  assert.equal(picked.get('positions').latest.periodKey, '2026-08-28');
});

test('monthStart is the last reading BEFORE the month began', () => {
  const picked = selectSnapshots(
    [
      row('positions', '2026-08-28'),
      row('positions', '2026-08-07'),
      row('positions', '2026-07-31'),
      row('positions', '2026-07-24'),
    ],
    { monthStart: '2026-08-01', monthEnd: '2026-08-31' }
  );
  assert.equal(picked.get('positions').monthStart.periodKey, '2026-07-31');
});

test('monthStart falls back to the earliest reading inside the month', () => {
  // A link made mid-month has nothing from before it. The earliest in-month
  // reading is still a FIXED point, which is what stops the goal scoring itself
  // against itself.
  const picked = selectSnapshots(
    [row('positions', '2026-08-28'), row('positions', '2026-08-07')],
    { monthStart: '2026-08-01', monthEnd: '2026-08-31' }
  );
  assert.equal(picked.get('positions').monthStart.periodKey, '2026-08-07');
  assert.notEqual(
    picked.get('positions').monthStart.periodKey,
    picked.get('positions').latest.periodKey
  );
});

test('a month with no reading in it has no latest, and says so rather than borrowing July', () => {
  const picked = selectSnapshots([row('positions', '2026-07-24')], {
    monthStart: '2026-08-01',
    monthEnd: '2026-08-31',
  });
  assert.equal(picked.get('positions').latest, null);
  assert.equal(picked.get('positions').monthStart.periodKey, '2026-07-24');
});

test('only one rank-tracking market is read, and an explicit choice wins', () => {
  const rows = [
    row('positions', '2026-08-28', { variant: 'desktop|en|2840' }),
    row('positions', '2026-08-27', { variant: 'desktop|en|2826' }),
    row('positions', '2026-08-21', { variant: 'desktop|en|2840' }),
  ];
  const uk = selectSnapshots(rows, {
    monthStart: '2026-08-01',
    monthEnd: '2026-08-31',
    variant: 'desktop|en|2826',
  });
  assert.equal(uk.get('positions').latest.variant, 'desktop|en|2826');

  // No choice: the newest series, and NOT a mixture of the two.
  const any = selectSnapshots(rows, { monthStart: '2026-08-01', monthEnd: '2026-08-31' });
  assert.equal(any.get('positions').latest.variant, 'desktop|en|2840');
  assert.equal(any.get('positions').monthStart.variant, 'desktop|en|2840');
});

test('a variant the project has never produced falls back rather than emptying the row', () => {
  const picked = selectSnapshots(
    [row('positions', '2026-08-28', { variant: 'desktop|en|2840' })],
    { monthStart: '2026-08-01', monthEnd: '2026-08-31', variant: 'mobile|fr|2250' }
  );
  assert.equal(picked.get('positions').latest.variant, 'desktop|en|2840');
});

// ---------------------------------------------------------------------------
// planGoalWrites — the ownership rule
// ---------------------------------------------------------------------------

test('the first run claims every cell it can reach', () => {
  const result = plan();
  const writes = byField(result.writes);

  assert.equal(writes.rank.value, 4);
  assert.equal(writes.volume.value, 1400);
  assert.equal(writes.seo_difficulty.value, 42);
  assert.equal(writes.search_intent.value, 'commercial');
  // The starting point comes from the reading BEFORE the month, not from today.
  assert.equal(writes.rank_previous.value, 18);
  assert.equal(result.suggestions.length, 0);
});

test('a claim overwrites a hand-typed value — that is the day-one problem', () => {
  const goal = makeGoal({ columnValues: { [COL_VOLUME]: 0 } });
  const writes = byField(plan({ goal }).writes);
  // The 100 zero volumes on the live boards are repaired by exactly this line.
  assert.equal(writes.volume.value, 1400);
});

test('after the claim, a cell the connector still owns is rewritten', () => {
  const link = makeLink({
    claimedAt: new Date('2026-08-13T00:00:00.000Z'),
    applied: { volume: { value: 1200, targetId: `column:${COL_VOLUME}` } },
  });
  const goal = makeGoal({ columnValues: { [COL_VOLUME]: 1200 } });
  const result = plan({ goal, link });
  assert.equal(byField(result.writes).volume.value, 1400);
  assert.equal(result.suggestions.some((s) => s.sourceField === 'volume'), false);
});

test('after the claim, a cell a human has moved is SUGGESTED and never written', () => {
  const link = makeLink({
    claimedAt: new Date('2026-08-13T00:00:00.000Z'),
    applied: { volume: { value: 1200, targetId: `column:${COL_VOLUME}` } },
  });
  // 2,000 is not what the connector left there, so somebody typed it.
  const goal = makeGoal({ columnValues: { [COL_VOLUME]: 2000 } });
  const result = plan({ goal, link });

  assert.equal(result.writes.some((w) => w.sourceField === 'volume'), false);
  const suggestion = byField(result.suggestions).volume;
  assert.equal(suggestion.value, 1400);
  assert.equal(suggestion.current, 2000);
  assert.equal(suggestion.reason, 'humanEdited');
});

test('after the claim, an EMPTY cell is filled without argument', () => {
  const link = makeLink({
    claimedAt: new Date('2026-08-13T00:00:00.000Z'),
    applied: {},
  });
  const result = plan({ goal: makeGoal(), link });
  assert.equal(byField(result.writes).volume.value, 1400);
});

test('a cell that already says exactly this is a no-op, not a write', () => {
  const link = makeLink({
    claimedAt: new Date('2026-08-13T00:00:00.000Z'),
    applied: { volume: { value: 1400, targetId: `column:${COL_VOLUME}` } },
  });
  const goal = makeGoal({ columnValues: { [COL_VOLUME]: 1400 } });
  const write = byField(plan({ goal, link }).writes).volume;
  // Still a write — the run still OWNS the cell and refreshes its provenance —
  // but flagged so the report does not claim work it did not do.
  assert.equal(write.noop, true);
});

// ---------------------------------------------------------------------------
// planGoalWrites — permission, autoFill, and the two nulls
// ---------------------------------------------------------------------------

test('an unattended run fills the result and only OFFERS the promise', () => {
  const result = plan({ canWrite: (cap) => cap === 'goal.track' });

  assert.equal(byField(result.writes).rank.value, 4);
  assert.equal(result.writes.some((w) => w.sourceField === 'rank_previous'), false);

  const offered = byField(result.suggestions).rank_previous;
  assert.equal(offered.value, 18);
  assert.equal(offered.reason, 'needsPermission');
  assert.equal(offered.capability, 'goal.manage');
});

test('autoFill off on the MAPPING shows the value and writes nothing', () => {
  const rows = MAPPING_ROWS.map((r) =>
    r.sourceField === 'volume' ? { ...r, autoFill: false } : r
  );
  const result = plan({ mappings: resolveMappings(makeBoard(), rows) });

  assert.equal(result.writes.some((w) => w.sourceField === 'volume'), false);
  assert.equal(byField(result.suggestions).volume.reason, 'autoFillOff');
  // Every other field still fills — one switch is one field.
  assert.equal(byField(result.writes).rank.value, 4);
});

test('autoFill off on the LINK stops the whole row', () => {
  const result = plan({ link: makeLink({ autoFill: false }) });
  assert.equal(result.writes.length, 0);
  assert.ok(result.suggestions.length > 0);
  assert.ok(result.suggestions.every((s) => s.reason === 'autoFillOff'));
});

test('a keyword outside the top 100 is a NOTE, never a blank written over a real number', () => {
  const goal = makeGoal({ actual: 7 });
  const result = plan({
    goal,
    snapshots: snapshotsFor({
      positions: positionsData({ position: null, previousPosition: 9 }),
    }),
  });

  assert.equal(result.writes.some((w) => w.sourceField === 'rank'), false);
  assert.equal(result.suggestions.some((s) => s.sourceField === 'rank'), false);
  assert.ok(result.notes.some((n) => n.includes('Not in the top 100')));
});

test('a goal linked to the project alone fills only the project-scoped fields', () => {
  const rows = [
    ...MAPPING_ROWS,
    {
      provider: 'ubersuggest',
      sourceField: 'keywords_tracked',
      target: { kind: 'goalBuiltin', builtin: 'config.target', columnId: null },
      autoFill: true,
    },
  ];
  const result = plan({
    link: makeLink({ keyword: null }),
    mappings: resolveMappings(makeBoard(), rows),
  });

  const writes = byField(result.writes);
  // Guessing which keyword a goal meant, from its NAME, is the one failure mode
  // worth engineering against: a fuzzy match that is wrong produces an entirely
  // plausible number in the wrong row.
  assert.equal(writes.rank, undefined);
  assert.equal(writes.volume, undefined);
  assert.equal(writes.keywords_tracked.value, 1);
});

test('a mapping the goal TYPE has no field for is skipped in silence', () => {
  // A `checklist` promises a `total`; `config.baseline` is not one of its
  // fields, so `rank_previous` has nowhere to land on this row.
  const result = plan({ goal: makeGoal({ type: 'checklist', config: { total: 8 } }) });
  assert.equal(result.writes.some((w) => w.sourceField === 'rank_previous'), false);
  assert.equal(result.suggestions.some((s) => s.sourceField === 'rank_previous'), false);
  // …and the rest of the row still fills.
  assert.equal(byField(result.writes).volume.value, 1400);
});

test('a missing snapshot is one note per kind, not one per field', () => {
  const result = plan({ snapshots: snapshotsFor({ metrics: null }) });
  const metricNotes = result.notes.filter((n) => n.includes('keyword metrics'));
  assert.equal(metricNotes.length, 1);
  // Three keyword_metrics fields are mapped; none of them wrote.
  assert.equal(result.writes.some((w) => w.sourceField === 'volume'), false);
  assert.equal(result.writes.some((w) => w.sourceField === 'seo_difficulty'), false);
});

test('a mapping naming a field the catalog no longer has is skipped, not thrown', () => {
  const rows = resolveMappings(makeBoard(), [
    ...MAPPING_ROWS,
    {
      provider: 'ubersuggest',
      sourceField: 'a_field_that_was_removed',
      target: { kind: 'goalBuiltin', builtin: 'actualDayKey', columnId: null },
      autoFill: true,
    },
  ]);
  const result = plan({ mappings: rows });
  assert.equal(byField(result.writes).rank.value, 4);
});

// ---------------------------------------------------------------------------
// applyWrite / stampLink
// ---------------------------------------------------------------------------

test('applyWrite puts a value where the target names, on a Map or an object', () => {
  const doc = { config: {}, columnValues: new Map(), markModified: () => {} };
  applyWrite(doc, { target: { kind: 'goalBuiltin', builtin: 'actual' }, value: 4 });
  applyWrite(doc, { target: { kind: 'goalBuiltin', builtin: 'config.baseline' }, value: 18 });
  applyWrite(doc, { target: { kind: 'goalColumn', columnId: COL_VOLUME }, value: 1400 });

  assert.equal(doc.actual, 4);
  assert.equal(doc.config.baseline, 18);
  assert.equal(doc.columnValues.get(COL_VOLUME), 1400);
});

test('stampLink refreshes provenance, clears superseded suggestions, and claims once', () => {
  const link = {
    applied: new Map([['seo_difficulty', { value: 40 }]]),
    suggested: new Map([['volume', { value: 1200 }]]),
    claimedAt: null,
    markModified: () => {},
  };
  const now = new Date('2026-08-20T09:00:00.000Z');

  stampLink(
    link,
    {
      writes: [{ sourceField: 'volume', value: 1400, targetId: `column:${COL_VOLUME}` }],
      suggestions: [{ sourceField: 'rank', value: 4, targetId: 'builtin:actual' }],
      notes: ['Current rank: Not in the top 100.'],
    },
    now
  );

  assert.equal(link.applied.get('volume').value, 1400);
  // A field this run did not touch KEEPS its provenance — rebuilding `applied`
  // from the plan would make the next run read "we never wrote this" and
  // overwrite whatever a human had put there in between.
  assert.equal(link.applied.get('seo_difficulty').value, 40);
  // The suggestion it just superseded is gone; the new one is recorded.
  assert.equal(link.suggested.has('volume'), false);
  assert.equal(link.suggested.get('rank').value, 4);
  assert.equal(link.claimedAt.getTime(), now.getTime());
  assert.equal(link.lastNote, 'Current rank: Not in the top 100.');
});

test('stampLink does not re-stamp a claim, so re-linking cannot re-claim', () => {
  const first = new Date('2026-07-01T00:00:00.000Z');
  const link = {
    applied: new Map(),
    suggested: new Map(),
    claimedAt: first,
    markModified: () => {},
  };
  stampLink(
    link,
    { writes: [{ sourceField: 'rank', value: 4, targetId: 'builtin:actual' }], suggestions: [], notes: [] },
    new Date('2026-08-20T09:00:00.000Z')
  );
  assert.equal(link.claimedAt.getTime(), first.getTime());
});

test('a run that wrote nothing does not claim', () => {
  const link = { applied: new Map(), suggested: new Map(), claimedAt: null, markModified: () => {} };
  stampLink(link, { writes: [], suggestions: [], notes: [] }, new Date());
  assert.equal(link.claimedAt, null);
});

// ---------------------------------------------------------------------------
// shiftDayKey
// ---------------------------------------------------------------------------

test('shiftDayKey crosses months and years without a local timezone', () => {
  assert.equal(shiftDayKey('2026-08-01', -120), '2026-04-03');
  assert.equal(shiftDayKey('2026-01-01', -1), '2025-12-31');
  assert.equal(shiftDayKey('2024-03-01', -1), '2024-02-29');
});
