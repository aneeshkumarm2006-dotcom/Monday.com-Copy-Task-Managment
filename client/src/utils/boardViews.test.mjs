import test from 'node:test';
import assert from 'node:assert';

import {
  TABLE,
  TEMPLATE_VIEWS,
  BUILT,
  VIEW_LABELS,
  boardViews,
  resolveBoardView,
  hasViewChoice,
} from './boardViews.js';

/**
 * The two properties this registry exists for:
 *
 *   1. a board NEVER resolves to a view that cannot render, whatever the URL,
 *      the stored default, or a half-rolled-back deploy says, and
 *   2. the ordinary task board is untouched.
 *
 * Both are the kind of thing that fails silently — a blank pane, or a task
 * board that quietly grew a control nobody asked for — so they are asserted
 * rather than described.
 */

const board = (templateKey, defaultView) => ({ templateKey, defaultView });

test('a board with no template offers the table and nothing else', () => {
  // Every board that predates templates, and every Blank board since. If this
  // ever returns more than one view, the task board grows a switcher — which is
  // exactly the change that was promised would not happen.
  for (const b of [null, undefined, {}, board(null, null), board(undefined, 'table')]) {
    assert.deepEqual(boardViews(b), [TABLE]);
    assert.equal(hasViewChoice(b), false);
  }
});

test('the blank template is sealed', () => {
  assert.equal(TEMPLATE_VIEWS.blank, undefined, 'blank must not register views');
  assert.deepEqual(boardViews(board('blank', 'table')), [TABLE]);
  assert.equal(hasViewChoice(board('blank', 'table')), false);
});

test('every board can always fall back to the table', () => {
  // The table is the floor. A template whose views were all unbuilt would
  // otherwise resolve to an empty list and render nothing at all.
  for (const key of Object.keys(TEMPLATE_VIEWS)) {
    assert.ok(boardViews(board(key)).includes(TABLE), `${key} lost the table`);
  }
  assert.ok(BUILT.has(TABLE), 'the table must always be built');
});

test('a designed-but-unbuilt view is skipped, not offered', () => {
  // The whole shipping model. Billing wants the ledger; until 'ledger' is in
  // BUILT the board offers the table alone and never names a view it cannot
  // draw.
  for (const [key, wanted] of Object.entries(TEMPLATE_VIEWS)) {
    const offered = boardViews(board(key));
    for (const v of offered) {
      assert.ok(BUILT.has(v), `${key} offers unbuilt view "${v}"`);
    }
    for (const v of wanted) {
      if (!BUILT.has(v)) {
        assert.ok(!offered.includes(v), `${key} offered "${v}" before it was built`);
      }
    }
  }
});

test('resolveBoardView never returns something the board cannot draw', () => {
  const cases = [
    ['ledger', board('billing', 'ledger')],      // designed, not built yet
    ['nonsense', board('pipeline', 'stages')],   // junk in the URL
    [null, board('pipeline', 'stages')],
    [undefined, board('blank', 'table')],
    ['stages', board('blank', 'table')],         // a view this board never offers
    ['calendar', board('content', 'calendar')],  // unbuilt default AND unbuilt url
  ];
  for (const [raw, b] of cases) {
    const got = resolveBoardView(raw, b);
    assert.ok(
      boardViews(b).includes(got),
      `resolveBoardView(${JSON.stringify(raw)}, ${b.templateKey}) → "${got}", which is not offered`
    );
  }
});

test('the URL wins over the stored default, when both are real', () => {
  assert.equal(resolveBoardView(TABLE, board('pipeline', 'stages')), TABLE);
  assert.equal(resolveBoardView('stages', board('pipeline', 'table')), 'stages');
});

test('the stored default is used when the URL says nothing', () => {
  assert.equal(resolveBoardView(null, board('pipeline', 'stages')), 'stages');
  assert.equal(resolveBoardView(null, board('pipeline', TABLE)), TABLE);
});

test('an unbuilt default falls through to the table rather than blanking', () => {
  /**
   * Every template stores the view it was DESIGNED for, whether or not that
   * view exists yet — so this is the case that decides whether a board opens or
   * breaks between drops, and after a rollback.
   *
   * The examples here have to be views that are still unbuilt. When one ships,
   * this test fails and gets repointed, which is the tripwire working: it
   * failed on `billing`/`ledger` the day the ledger landed.
   */
  for (const [templateKey, designed] of [
    ['content', 'calendar'],
    ['budget', 'allocation'],
    ['expenses', 'queue'],
  ]) {
    assert.ok(!BUILT.has(designed), `"${designed}" now ships — repoint this test`);
    assert.equal(resolveBoardView(null, board(templateKey, designed)), TABLE);
    assert.equal(resolveBoardView(designed, board(templateKey, designed)), TABLE);
  }
});

test('a built default IS opened on', () => {
  // The other half. A board whose designed view has shipped must actually open
  // on it, or every template would be permanently stuck on the table.
  assert.equal(resolveBoardView(null, board('billing', 'ledger')), 'ledger');
  assert.equal(resolveBoardView(null, board('pipeline', 'stages')), 'stages');
  // …and an older board of the same template, stored before the view shipped,
  // keeps opening where it always did and merely gains the choice.
  assert.equal(resolveBoardView(null, board('billing', TABLE)), TABLE);
  assert.deepEqual(boardViews(board('billing', TABLE)), ['ledger', TABLE]);
});

test('every view that can be offered has a label', () => {
  // A missing label renders an empty switcher segment — clickable, nameless.
  for (const v of BUILT) {
    assert.ok(VIEW_LABELS[v], `built view "${v}" has no label`);
  }
  for (const wanted of Object.values(TEMPLATE_VIEWS)) {
    for (const v of wanted) assert.ok(VIEW_LABELS[v], `designed view "${v}" has no label`);
  }
});

test('stages is offered to exactly the two boards designed for it', () => {
  const withStages = Object.entries(TEMPLATE_VIEWS)
    .filter(([, v]) => v.includes('stages'))
    .map(([k]) => k)
    .sort();
  assert.deepEqual(withStages, ['pipeline', 'recruitment']);
});
