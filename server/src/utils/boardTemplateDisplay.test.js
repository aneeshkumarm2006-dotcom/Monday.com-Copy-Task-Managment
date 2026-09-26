const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { BOARD_TEMPLATES, templateSummaries } = require('./boardTemplates');

/**
 * The naming a template board uses, and the tripwire that keeps two copies of
 * it honest.
 *
 * `client/src/utils/boardTemplateDisplay.js` holds its own copy of the row
 * nouns, the primary action and the filter list, because the board page renders
 * them on FIRST PAINT — asking the server what to call a row would mean every
 * template board flashing "items" before settling. Two copies is the right
 * trade there; two copies that disagree is not, so this compares them.
 */

const clientSource = fs.readFileSync(
  path.join(__dirname, '../../../client/src/utils/boardTemplateDisplay.js'),
  'utf8'
);

/** Pull one template's block out of the client file and read a field from it. */
const clientField = (key, field) => {
  const block = clientSource.match(new RegExp(`\\n  ${key}: \\{([\\s\\S]*?)\\n  \\},`));
  assert.ok(block, `client display is missing "${key}"`);
  const line = block[1].match(new RegExp(`${field}: (\\[[^\\]]*\\]|'[^']*')`));
  assert.ok(line, `client "${key}" is missing ${field}`);
  // eslint-disable-next-line no-eval
  return eval(`(${line[1]})`);
};

const templated = BOARD_TEMPLATES.filter((t) => t.key !== 'blank');

test('every template names what one of its rows is', () => {
  for (const t of BOARD_TEMPLATES) {
    assert.ok(Array.isArray(t.rowNoun) && t.rowNoun.length === 2, `${t.key} rowNoun`);
    const [one, many] = t.rowNoun;
    assert.ok(one && many, `${t.key} rowNoun must be [singular, plural]`);
    assert.notEqual(one, many, `${t.key} singular and plural are the same word`);
    assert.ok(t.rowAction, `${t.key} has no primary action`);
  }
});

test('only the blank board calls its rows items', () => {
  // The whole point. A billing board that says "5 items" is a board nobody has
  // set up for the work.
  for (const t of templated) {
    assert.notEqual(t.rowNoun[1], 'items', `${t.key} still calls its rows items`);
  }
});

test('no template offers a filter that means nothing on it', () => {
  // Priority and Labels are task-board concepts. A control that never narrows
  // anything teaches people the whole row is not worth reading.
  const VALID = new Set(['status', 'priority', 'labels', 'due', 'owner']);
  for (const t of BOARD_TEMPLATES) {
    assert.ok(Array.isArray(t.filters) && t.filters.length > 0, `${t.key} has no filters`);
    for (const f of t.filters) {
      assert.ok(VALID.has(f), `${t.key} offers unknown filter "${f}"`);
    }
  }
  for (const t of templated) {
    assert.ok(!t.filters.includes('priority'), `${t.key} should not offer Priority`);
    assert.ok(!t.filters.includes('labels'), `${t.key} should not offer Labels`);
  }
  // …and the blank board still offers all five, unchanged.
  const blank = BOARD_TEMPLATES.find((t) => t.key === 'blank');
  assert.deepEqual(blank.filters, ['status', 'priority', 'labels', 'due', 'owner']);
});

test('the client copy of the naming has not drifted', () => {
  for (const t of templated) {
    assert.deepEqual(
      clientField(t.key, 'rowNoun'),
      t.rowNoun,
      `${t.key} rowNoun differs between client and server`
    );
    assert.deepEqual(
      clientField(t.key, 'rowAction'),
      t.rowAction,
      `${t.key} rowAction differs between client and server`
    );
    assert.deepEqual(
      clientField(t.key, 'filters'),
      t.filters,
      `${t.key} filters differ between client and server`
    );
  }
});

test('the client knows every template the server offers', () => {
  // A template added on the server and not here renders with the generic
  // "items" wording and all five filters — working, but not what was designed.
  for (const t of templated) {
    assert.ok(
      clientSource.includes(`\n  ${t.key}: {`),
      `client display has no entry for "${t.key}"`
    );
  }
});

test('the billing card describes the board it actually creates', () => {
  /**
   * The blurb used to say "Groups are months" over a template that seeds ONE
   * group — the month is derived from the Issued date on purpose. A card that
   * promises a shape the board does not have is the first thing a new user
   * reads, and the first thing that turns out to be untrue.
   */
  const billing = templateSummaries().find((t) => t.key === 'billing');
  assert.deepEqual(billing.groups, ['Invoices']);
  assert.ok(!/groups are months/i.test(billing.blurb), 'the blurb still promises month groups');
  assert.match(billing.blurb, /Issued/);
  // The payments list is part of what you are shown you will get.
  assert.ok(
    billing.columns.some((c) => c.name === 'Payments' && c.type === 'payments'),
    'the picker does not show the Payments column'
  );
});

test('the picker payload carries the naming', () => {
  // The dialog shows what you will get; the board page reads its own copy.
  for (const t of templateSummaries()) {
    assert.ok(t.rowNoun, `${t.key} summary is missing rowNoun`);
    assert.ok(t.rowAction, `${t.key} summary is missing rowAction`);
    assert.ok(t.filters, `${t.key} summary is missing filters`);
  }
});
