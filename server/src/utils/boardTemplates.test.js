const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  BOARD_TEMPLATES,
  templateByKey,
  isTemplateKey,
  templateSummaries,
} = require('./boardTemplates');
const { getColumnType } = require('./columnTypes');
const { NUMBER_FORMATS, CURRENCY_CODES } = require('./money');

/**
 * A template is data, and every way it can be wrong is silent.
 *
 * A column type that does not exist renders as an empty cell; a duplicate key
 * loses one column's values into the other's; a missing primary means a board
 * with no row title. None of those throw at creation — they produce a board
 * that looks fine and behaves wrongly, on somebody's real work. So the shape
 * gets a test even though nothing here executes any logic.
 */

test('every template names real column types', () => {
  for (const t of BOARD_TEMPLATES) {
    for (const c of t.columns) {
      assert.ok(
        getColumnType(c.type),
        `${t.key}.${c.key} uses "${c.type}", which is not a column type`
      );
    }
  }
});

test('column keys are unique within a template', () => {
  // Two columns sharing a key write to the same `columnValues` entry — one
  // silently overwrites the other, and only on rows where both are filled.
  for (const t of BOARD_TEMPLATES) {
    const keys = t.columns.map((c) => c.key);
    assert.equal(
      new Set(keys).size,
      keys.length,
      `${t.key} has a duplicate column key`
    );
  }
});

test('every template with columns has exactly one primary', () => {
  // The primary column is the row title and cannot be deleted. None means a
  // board whose rows have no name; two means the board picks arbitrarily.
  for (const t of BOARD_TEMPLATES) {
    if (t.columns.length === 0) continue;
    const primaries = t.columns.filter((c) => c.isPrimary);
    assert.equal(primaries.length, 1, `${t.key} must have exactly one primary column`);
  }
});

test('the primary column is a text column, and is first', () => {
  // A row title that is a date or a dropdown is not a title. First, because the
  // board renders columns in order and the name belongs at the left.
  for (const t of BOARD_TEMPLATES) {
    if (t.columns.length === 0) continue;
    assert.equal(t.columns[0].isPrimary, true, `${t.key}'s first column should be the primary`);
    assert.equal(t.columns[0].type, 'text', `${t.key}'s primary should be text`);
  }
});

test('blank stays a no-op', () => {
  // It is the default. If it ever seeds anything, every board anybody makes
  // without thinking about it changes shape.
  const blank = templateByKey('blank');
  assert.deepEqual(blank.columns, []);
  assert.deepEqual(blank.groups, []);
  assert.equal(blank.defaultView, 'table');
});

test('every template ships the four status rungs the app relies on', () => {
  // `key` is load-bearing well outside the board: dashboard stats, My Work's
  // overdue count and `computeBoardProgress` all look for `key === 'done'`.
  // Renaming Done to "Paid" is fine; dropping the key is not.
  const required = ['not_started', 'working_on_it', 'done', 'stuck'];
  for (const t of BOARD_TEMPLATES) {
    const keys = t.statuses.map((s) => s.key);
    for (const k of required) {
      assert.ok(keys.includes(k), `${t.key} is missing the "${k}" status rung`);
    }
    assert.equal(
      t.statuses.filter((s) => s.isDefault).length,
      1,
      `${t.key} must have exactly one default status`
    );
  }
});

test('currency columns name a currency we actually offer', () => {
  const codes = new Set(CURRENCY_CODES);
  for (const t of BOARD_TEMPLATES) {
    for (const c of t.columns) {
      const f = c.settings?.format;
      if (!f) continue;
      assert.ok(NUMBER_FORMATS.includes(f), `${t.key}.${c.key} has format "${f}"`);
      if (f === 'currency') {
        assert.ok(codes.has(c.settings.currency), `${t.key}.${c.key} uses an unknown currency`);
      }
    }
  }
});

test('a formula only references columns that exist on its own template', () => {
  // `column.spend` where the column is called `spent` evaluates to null forever
  // and the cell just sits empty.
  for (const t of BOARD_TEMPLATES) {
    const keys = new Set(t.columns.map((c) => c.key));
    for (const c of t.columns) {
      if (c.type !== 'formula') continue;
      const expr = c.settings?.expression || '';
      assert.ok(expr, `${t.key}.${c.key} is a formula with no expression`);
      for (const ref of expr.matchAll(/column\.([a-zA-Z_][a-zA-Z0-9_]*)/g)) {
        assert.ok(keys.has(ref[1]), `${t.key}.${c.key} references missing column "${ref[1]}"`);
      }
    }
  }
});

test('recruitment is private and nothing else forces visibility', () => {
  // The deliberate exception. If a second template ever pins visibility it
  // should be a decision somebody made, not one that arrived with a copy-paste.
  const forced = BOARD_TEMPLATES.filter((t) => t.forceVisibility);
  assert.deepEqual(forced.map((t) => t.key), ['recruitment']);
  assert.equal(forced[0].forceVisibility, 'private');
});

test('every template names its views, and opens on the first of them', () => {
  /**
   * `views` is what a board OFFERS; `defaultView` is which of them it opens on.
   *
   * The old version of this test refused any template naming a view the board
   * could not render, because back then naming one meant `resolveView` quietly
   * falling back and the template not doing what its blurb said. That failure
   * mode is gone: `client/src/utils/boardViews.js` now holds a `BUILT` set and
   * draws the table for anything unbuilt, and its own test proves a board can
   * never resolve to a view it cannot draw.
   *
   * So a template may now name the view it was DESIGNED for before that view
   * exists — which is what lets the five views ship one at a time without
   * touching this file again. What still has to hold is the shape.
   */
  for (const t of BOARD_TEMPLATES) {
    assert.ok(Array.isArray(t.views) && t.views.length > 0, `${t.key} has no views`);
    assert.ok(t.views.includes('table'), `${t.key} must keep the table as its fallback`);
    assert.equal(
      t.defaultView,
      t.views[0],
      `${t.key} opens on "${t.defaultView}" but its first view is "${t.views[0]}"`
    );
    assert.equal(new Set(t.views).size, t.views.length, `${t.key} lists a view twice`);
  }
});

test('the blank template offers no view but the table', () => {
  // The seal. A switcher only appears when a board has more than one view, so
  // this single assertion is what keeps every existing task board looking
  // exactly as it did before views existed.
  const blank = templateByKey('blank');
  assert.deepEqual(blank.views, ['table']);
  assert.equal(blank.defaultView, 'table');
});

test('the client registry knows every view the server names', () => {
  /**
   * Same tripwire as `boardTemplateDisplay.test.js`, for the same reason: the
   * board page picks a view on first paint and cannot ask the server which one.
   * A view named here and unknown there would be dropped silently and the board
   * would open on the table forever.
   */
  const clientSource = fs.readFileSync(
    path.join(__dirname, '../../../client/src/utils/boardViews.js'),
    'utf8'
  );
  for (const t of BOARD_TEMPLATES) {
    if (t.key === 'blank') continue;
    const block = clientSource.match(new RegExp(`\\n  ${t.key}: \\[([^\\]]*)\\]`));
    assert.ok(block, `client boardViews has no entry for "${t.key}"`);
    const named = [...block[1].matchAll(/'([a-z]+)'|TABLE/g)].map((m) => m[1] || 'table');
    assert.deepEqual(
      named,
      t.views,
      `${t.key} views differ between server and client`
    );
    assert.ok(
      clientSource.includes(`${t.defaultView}:`) || t.defaultView === 'table',
      `client boardViews has no label for "${t.defaultView}"`
    );
  }
});

test('content still carries the date column a calendar would read', () => {
  // The column the calendar tab will point at when it exists.
  const content = templateByKey('content');
  assert.ok(content.columns.some((c) => c.type === 'date'));
});

test('keys are unique and isTemplateKey agrees with the list', () => {
  const keys = BOARD_TEMPLATES.map((t) => t.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const k of keys) assert.equal(isTemplateKey(k), true);
  assert.equal(isTemplateKey('nope'), false);
  assert.equal(templateByKey('nope'), null);
});

test('the picker payload carries no formula expressions or settings', () => {
  // The summaries go to a screen that shows what you will get. Shipping the
  // full settings would put currency config and formula source on it.
  for (const t of templateSummaries()) {
    for (const c of t.columns) {
      assert.deepEqual(Object.keys(c).sort(), ['name', 'type']);
    }
  }
});
