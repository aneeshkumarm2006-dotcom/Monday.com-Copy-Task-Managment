const test = require('node:test');
const assert = require('node:assert/strict');

const {
  GOAL_BUILTINS,
  COLUMN_TYPES,
  SOURCE_TYPES,
  ACCEPTS,
  targetId,
  parseTargetId,
  targetsForBoard,
  findTarget,
  checkCompatibility,
  refusalsFor,
  publicField,
} = require('./fieldMapping');

/**
 * The generic half of field mapping — what a goal can hold, and which source
 * type may be written into which column type.
 *
 * ---- Why the compatibility rule is worth this many tests -------------------
 *
 * It is the only thing standing between a misconfigured mapping and a silent
 * failure. A text field bound to a number column breaks nothing at save time; it
 * breaks inside a weekly run, on one field of one board, and the only symptom is
 * a cell that never fills — which reads as "the sync has not run yet" and goes
 * unreported for a month. Every case below is a case that must be refused with a
 * SENTENCE, at the moment somebody presses save.
 *
 * The second property under test is that there is exactly ONE implementation.
 * The panel greys an option out and the server rejects the save, and both come
 * out of `checkCompatibility` — `refusalsFor` is a loop over it, not a parallel
 * table. Two implementations of a rule agree until the day they quietly do not.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const COL = {
  number: '6a466b99ea3ab35ff1378e01',
  text: '6a466b99ea3ab35ff1378e02',
  date: '6a466b99ea3ab35ff1378e03',
  dropdown: '6a466b99ea3ab35ff1378e04',
  link: '6a466b99ea3ab35ff1378e05',
  person: '6a466b99ea3ab35ff1378e06',
  archived: '6a466b99ea3ab35ff1378e07',
};

const board = {
  _id: '6a466b99ea3ab35ff1378d20',
  goalColumns: [
    { _id: COL.number, name: 'Volume', key: 'volume', type: 'number', order: 1 },
    { _id: COL.text, name: 'Notes', key: 'notes', type: 'text', order: 0 },
    { _id: COL.date, name: 'As of', key: 'as_of', type: 'date', order: 2 },
    { _id: COL.dropdown, name: 'Intent', key: 'intent', type: 'dropdown', order: 3 },
    { _id: COL.link, name: 'Report', key: 'report', type: 'link', order: 4 },
    { _id: COL.person, name: 'Owner', key: 'owner', type: 'person', order: 5 },
    {
      _id: COL.archived,
      name: 'Old KD',
      key: 'keyword_difficultly',
      type: 'number',
      order: 6,
      archived: true,
    },
  ],
};

const field = (overrides = {}) => ({
  key: 'rank',
  label: 'Current rank',
  blurb: 'Where it ranks.',
  type: 'number',
  kind: 'positions',
  scope: 'keyword',
  read: () => null,
  ...overrides,
});

const target = (id) => findTarget(board, id);

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

test('a board’s targets are its goal columns plus the built-ins', () => {
  const ids = targetsForBoard(board).map((t) => t.id);
  assert.equal(ids.filter((i) => i.startsWith('column:')).length, 7);
  for (const b of GOAL_BUILTINS) assert.ok(ids.includes(`builtin:${b.key}`));
});

test('columns come back in the board’s own display order', () => {
  // The panel renders them straight down. Insertion order would put a column
  // somewhere different from where the goals table shows it.
  const columns = targetsForBoard(board).filter((t) => t.kind === 'goalColumn');
  assert.deepEqual(
    columns.map((t) => t.label),
    ['Notes', 'Volume', 'As of', 'Intent', 'Report', 'Owner', 'Old KD']
  );
});

test('a target is identified by columnId, never by the column’s key', () => {
  // The three SEO boards use disjoint column ObjectIds, and the difficulty
  // column is spelled `keyword_difficultly` on one and `keyword_difficulty` on
  // the other two. A mapping keyed by slug would bind on one board and silently
  // miss on the others — and the miss looks like "the connector has not run".
  const t = target(`column:${COL.archived}`);
  assert.equal(t.columnId, COL.archived);
  assert.equal('key' in t, false);
  assert.ok(!JSON.stringify(targetsForBoard(board)).includes('keyword_difficultly'));
});

test('an archived column is listed but not offerable', () => {
  // Kept visible so an EXISTING mapping onto one can be rendered honestly; not
  // offerable so a new binding cannot be made to a cell nobody can see.
  const t = target(`column:${COL.archived}`);
  assert.equal(t.archived, true);
  assert.equal(t.offerable, false);
  for (const other of targetsForBoard(board).filter((x) => x.id !== t.id)) {
    assert.equal(other.offerable, true);
  }
});

test('a board with no goal columns still offers the built-ins', () => {
  const ids = targetsForBoard({ goalColumns: [] }).map((t) => t.id);
  assert.deepEqual(ids, GOAL_BUILTINS.map((b) => `builtin:${b.key}`));
  assert.deepEqual(targetsForBoard({}).length, GOAL_BUILTINS.length);
});

test('config targets declare goal.manage and result targets declare goal.track', () => {
  // `goalController.RESULT_ONLY_FIELDS` splits a goal in half: the RESULT is
  // writable with goal.track, the PROMISE needs goal.manage. A mapping onto
  // config.target is therefore a materially bigger permission than one onto
  // actual, and the panel must be able to say so before somebody chooses.
  const byId = new Map(targetsForBoard(board).map((t) => [t.id, t]));
  assert.equal(byId.get('builtin:actual').capability, 'goal.track');
  assert.equal(byId.get('builtin:actualDayKey').capability, 'goal.track');
  assert.equal(byId.get('builtin:config.baseline').capability, 'goal.manage');
  assert.equal(byId.get('builtin:config.target').capability, 'goal.manage');
  // Every goal column is part of the result half.
  assert.equal(byId.get(`column:${COL.number}`).capability, 'goal.track');
});

test('deadline goals record a date, so actualDayKey is typed as one', () => {
  // `goalTypes.deadline.actualField.key` is `actualDayKey`, not `actual`.
  // Declaring both with their types is what lets the writeback pick the right
  // one from the goal's type instead of branching on the word "deadline".
  const byKey = new Map(GOAL_BUILTINS.map((b) => [b.key, b]));
  assert.equal(byKey.get('actual').type, 'number');
  assert.equal(byKey.get('actualDayKey').type, 'date');
});

// ---------------------------------------------------------------------------
// The wire form
// ---------------------------------------------------------------------------

test('targetId and parseTargetId round-trip', () => {
  const column = { kind: 'goalColumn', columnId: COL.number };
  assert.equal(targetId(column), `column:${COL.number}`);
  assert.deepEqual(parseTargetId(targetId(column)), column);

  const builtin = { kind: 'goalBuiltin', builtin: 'config.target' };
  assert.equal(targetId(builtin), 'builtin:config.target');
  assert.deepEqual(parseTargetId(targetId(builtin)), builtin);
});

test('a builtin key parses only if the catalog declares it', () => {
  // Otherwise a client could invent `builtin:organisation.admin` and the
  // writeback would be pointed at a path nobody vetted.
  assert.equal(parseTargetId('builtin:actual').builtin, 'actual');
  assert.equal(parseTargetId('builtin:nonsense'), null);
  assert.equal(parseTargetId('builtin:'), null);
});

test('parseTargetId refuses anything it does not recognise', () => {
  for (const bad of [null, undefined, 42, '', 'column:', 'nope', 'nope:x', {}, []]) {
    assert.equal(parseTargetId(bad), null, JSON.stringify(bad));
  }
});

test('targetId returns null for a half-built target rather than a broken string', () => {
  assert.equal(targetId(null), null);
  assert.equal(targetId({ kind: 'goalColumn' }), null);
  assert.equal(targetId({ kind: 'goalBuiltin' }), null);
  assert.equal(targetId({ kind: 'something' }), null);
});

test('a column id that is not on this board resolves to nothing', () => {
  // What stops a mapping naming a column on somebody else's board.
  assert.equal(findTarget(board, 'column:6a466b99ea3ab35ff1378eff'), null);
});

// ---------------------------------------------------------------------------
// Compatibility — what is allowed
// ---------------------------------------------------------------------------

test('a number goes into a number column', () => {
  assert.equal(checkCompatibility(field(), target(`column:${COL.number}`)).ok, true);
});

test('a number goes into a text column, stringified', () => {
  // Widening is safe. This is the one direction the design plan calls out
  // explicitly, and it is what lets a rank sit in a notes column.
  assert.equal(checkCompatibility(field(), target(`column:${COL.text}`)).ok, true);
});

test('a date and a link both widen into text', () => {
  assert.equal(
    checkCompatibility(field({ type: 'date' }), target(`column:${COL.text}`)).ok,
    true
  );
  assert.equal(
    checkCompatibility(field({ type: 'link' }), target(`column:${COL.text}`)).ok,
    true
  );
});

test('a number fills the result and both config numbers', () => {
  for (const key of ['actual', 'config.baseline', 'config.target']) {
    assert.equal(checkCompatibility(field(), target(`builtin:${key}`)).ok, true, key);
  }
});

test('a date fills the deadline result', () => {
  assert.equal(
    checkCompatibility(field({ type: 'date' }), target('builtin:actualDayKey')).ok,
    true
  );
});

// ---------------------------------------------------------------------------
// Compatibility — what is refused, and with what sentence
// ---------------------------------------------------------------------------

test('text into a number column is refused, naming both sides', () => {
  // The plan's own example, and the one the verification list asks for: refused
  // at save time with a readable message, not at sync time.
  const verdict = checkCompatibility(
    field({ key: 'search_intent', label: 'Search intent', type: 'text' }),
    target(`column:${COL.number}`)
  );
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /Search intent/);
  assert.match(verdict.reason, /Volume/);
});

test('nothing may be written into a dropdown, and the reason says why', () => {
  // A dropdown's values are this board's own vocabulary. A provider string that
  // failed to match one would land in a cell nothing can render and no filter
  // can find.
  for (const type of SOURCE_TYPES) {
    const verdict = checkCompatibility(field({ type }), target(`column:${COL.dropdown}`));
    assert.equal(verdict.ok, false, type);
    assert.match(verdict.reason, /options/i);
  }
});

test('nothing may be written into a person column', () => {
  for (const type of SOURCE_TYPES) {
    const verdict = checkCompatibility(field({ type }), target(`column:${COL.person}`));
    assert.equal(verdict.ok, false, type);
    assert.match(verdict.reason, /team/i);
  }
});

test('text may not be narrowed into a date, a link or a number', () => {
  for (const col of [COL.date, COL.link, COL.number]) {
    assert.equal(
      checkCompatibility(field({ type: 'text' }), target(`column:${col}`)).ok,
      false
    );
  }
});

test('a number is not a date, in either direction', () => {
  assert.equal(checkCompatibility(field(), target(`column:${COL.date}`)).ok, false);
  assert.equal(checkCompatibility(field(), target('builtin:actualDayKey')).ok, false);
  assert.equal(
    checkCompatibility(field({ type: 'date' }), target('builtin:actual')).ok,
    false
  );
});

test('a source type this file has never heard of is refused, not waved through', () => {
  // The permissive default is the dangerous one: an unknown type is exactly the
  // case where we cannot say what would happen at write time.
  const verdict = checkCompatibility(
    field({ type: 'geo' }),
    target(`column:${COL.text}`)
  );
  assert.equal(verdict.ok, false);
  assert.ok(verdict.reason);
});

test('a missing field or target is refused with a sentence, never a throw', () => {
  assert.equal(checkCompatibility(null, target(`column:${COL.text}`)).ok, false);
  assert.equal(checkCompatibility(field(), null).ok, false);
  assert.ok(checkCompatibility(null, null).reason);
});

test('every refusal carries a reason — an option greyed out with no explanation is the bug', () => {
  const targets = targetsForBoard(board);
  for (const type of SOURCE_TYPES) {
    for (const t of targets) {
      const verdict = checkCompatibility(field({ type }), t);
      if (!verdict.ok) assert.ok(verdict.reason && verdict.reason.length > 10);
      else assert.equal(verdict.reason, null);
    }
  }
});

test('the accepts table covers every column type a board can declare', () => {
  // A column type nothing accepts is fine (dropdown, person) but must be a
  // DECISION. This asserts the table was written against the real enum rather
  // than a remembered subset of it.
  const accepted = new Set(Object.values(ACCEPTS).flat());
  for (const t of accepted) assert.ok(COLUMN_TYPES.includes(t), t);
  assert.equal(accepted.has('dropdown'), false);
  assert.equal(accepted.has('person'), false);
});

// ---------------------------------------------------------------------------
// The projection the panel renders
// ---------------------------------------------------------------------------

test('refusalsFor lists only what is refused — absence means allowed', () => {
  // Halves the payload and, more usefully, leaves the client no rule of its own
  // to get wrong: it looks up a sentence and either finds one or does not.
  const targets = targetsForBoard(board);
  const refusals = refusalsFor(field(), targets);

  assert.equal(refusals[`column:${COL.number}`], undefined);
  assert.equal(refusals[`column:${COL.text}`], undefined);
  assert.equal(refusals['builtin:actual'], undefined);
  assert.ok(refusals[`column:${COL.dropdown}`]);
  assert.ok(refusals[`column:${COL.person}`]);
  assert.ok(refusals[`column:${COL.date}`]);
  assert.ok(refusals['builtin:actualDayKey']);
});

test('refusalsFor and checkCompatibility cannot disagree', () => {
  // The panel greys an option out and the server rejects the save. Both must be
  // the same decision, made once.
  const targets = targetsForBoard(board);
  for (const type of SOURCE_TYPES) {
    const f = field({ type });
    const refusals = refusalsFor(f, targets);
    for (const t of targets) {
      const verdict = checkCompatibility(f, t);
      assert.equal(!!refusals[t.id], !verdict.ok, `${type} → ${t.id}`);
      if (!verdict.ok) assert.equal(refusals[t.id], verdict.reason);
    }
  }
});

test('publicField drops the read function rather than letting JSON eat it', () => {
  // A spread would drop it silently through JSON and leave a field entry that
  // looks complete and cannot extract anything — a bug that surfaces in phase 5.
  const out = publicField(field());
  assert.equal('read' in out, false);
  assert.equal(typeof JSON.parse(JSON.stringify(out)).key, 'string');
});

test('publicField carries what the panel renders and nothing executable', () => {
  const out = publicField(field({ nullMeans: 'Not in the top 100.' }), targetsForBoard(board));
  assert.equal(out.key, 'rank');
  assert.equal(out.type, 'number');
  assert.equal(out.kind, 'positions');
  assert.equal(out.scope, 'keyword');
  assert.equal(out.nullMeans, 'Not in the top 100.');
  assert.deepEqual(out.accepts, ['number', 'text']);
  assert.equal(typeof out.refusals, 'object');
  for (const value of Object.values(out)) assert.notEqual(typeof value, 'function');
});

test('publicField omits refusals when no board was supplied', () => {
  // `listConnectors` describes a provider with no board in hand; refusals are
  // meaningless there and would be a fabricated answer.
  assert.equal('refusals' in publicField(field()), false);
});
