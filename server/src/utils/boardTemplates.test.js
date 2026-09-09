const test = require('node:test');
const assert = require('node:assert');

const {
  BOARD_TEMPLATES,
  templateByKey,
  isTemplateKey,
  templateSummaries,
} = require('./boardTemplates');
const { getColumnType } = require('./columnTypes');
const { NUMBER_FORMATS, CURRENCIES, formatNumber } = require('./numberFormat');

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
  const codes = new Set(CURRENCIES.map((c) => c.code));
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

test('no template names a view the board cannot render', () => {
  /**
   * The board page's tabs are board / chat / delivery / goals / people / vault
   * / addons / adsbudget / connector / seo — plus 'table', which is what
   * `Board.defaultView` calls the default. There is NO calendar tab: /calendar
   * is a separate page over every board.
   *
   * A template naming a view that does not exist does not error. `resolveView`
   * falls back to the board view and the template quietly does not do the thing
   * its blurb says — which is the failure this test exists to catch, since the
   * content template wants a calendar and cannot have one yet.
   */
  const RENDERABLE = new Set(['table', 'board']);
  for (const t of BOARD_TEMPLATES) {
    assert.ok(
      RENDERABLE.has(t.defaultView),
      `${t.key} opens on "${t.defaultView}", which the board page cannot render`
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

test('the number formatter renders rupees the Indian way', () => {
  // 1,80,000 — lakhs, not 180,000. This is why each currency carries a locale
  // rather than just a symbol.
  const out = formatNumber(180000, { format: 'currency', currency: 'INR', decimals: 0 });
  assert.match(out, /1,80,000/);
  assert.match(out, /₹/);
});

test('an empty cell formats as empty, not zero', () => {
  // On a budget board the difference between "not set yet" and "nothing left"
  // is the whole point of the column.
  for (const v of [null, undefined, '']) {
    assert.equal(formatNumber(v, { format: 'currency', currency: 'INR' }), '');
  }
  assert.notEqual(formatNumber(0, { format: 'currency', currency: 'INR' }), '');
});

test('percent stores the percentage, not the fraction', () => {
  // 85 means 85%. Storing 0.85 would make every formula referencing it wrong.
  assert.equal(formatNumber(85, { format: 'percent' }), '85%');
});
