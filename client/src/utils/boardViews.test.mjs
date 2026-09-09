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
  // A Billing board created today stores defaultView 'table'; one created after
  // the ledger ships stores 'ledger'. Roll the ledger back and this is the case
  // that decides whether those boards open or break.
  assert.equal(resolveBoardView(null, board('billing', 'ledger')), TABLE);
  assert.equal(resolveBoardView(null, board('content', 'calendar')), TABLE);
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
