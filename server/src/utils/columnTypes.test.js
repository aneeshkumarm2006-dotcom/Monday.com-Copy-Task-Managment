/**
 * columnTypes.test.js — unit tests for the column type registry.
 *
 * Run from the server directory:
 *     node --test src/utils/columnTypes.test.js
 *
 * Uses the built-in `node:test` runner so no new dependency is required.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const {
  columnTypes,
  getColumnType,
  validateColumnValue,
  evaluateFormula,
  validateFormulaExpression,
  MAX_PAYMENTS,
  MAX_PAYMENT_AMOUNT,
  MAX_CLIENT_NAME,
} = require('./columnTypes');

const okValidate = (type, value, settings = {}) =>
  assert.doesNotThrow(() => columnTypes[type].validate(value, settings));

const badValidate = (type, value, settings = {}) =>
  assert.throws(() => columnTypes[type].validate(value, settings));

// ---------------------------------------------------------------------------
// text / long_text
// ---------------------------------------------------------------------------
test('text: accepts string + null, rejects non-string', () => {
  okValidate('text', 'hello');
  okValidate('text', null);
  badValidate('text', 42);
});

test('text: serialize trims whitespace', () => {
  assert.equal(columnTypes.text.serialize('  hi  '), 'hi');
});

test('long_text: rejects oversize content', () => {
  okValidate('long_text', 'hello');
  badValidate('long_text', 'x'.repeat(20001));
});

// ---------------------------------------------------------------------------
// number
// ---------------------------------------------------------------------------
test('number: accepts numbers + numeric strings, rejects NaN', () => {
  okValidate('number', 42);
  okValidate('number', '42');
  okValidate('number', null);
  badValidate('number', 'abc');
});

test('number: enforces min/max from settings', () => {
  okValidate('number', 5, { min: 0, max: 10 });
  badValidate('number', -1, { min: 0 });
  badValidate('number', 11, { max: 10 });
});

// ---------------------------------------------------------------------------
// date / timeline
// ---------------------------------------------------------------------------
test('date: accepts ISO strings + Date instances', () => {
  okValidate('date', '2026-01-01');
  okValidate('date', new Date());
  okValidate('date', null);
  badValidate('date', 'not-a-date');
});

test('timeline: enforces start <= end', () => {
  okValidate('timeline', { start: '2026-01-01', end: '2026-02-01' });
  badValidate('timeline', { start: '2026-02-01', end: '2026-01-01' });
});

// ---------------------------------------------------------------------------
// person
// ---------------------------------------------------------------------------
test('person: accepts array of ObjectIds, rejects bad ids', () => {
  const a = new mongoose.Types.ObjectId().toString();
  const b = new mongoose.Types.ObjectId().toString();
  okValidate('person', [a, b]);
  okValidate('person', []);
  badValidate('person', ['not-an-id']);
  badValidate('person', 'single-string');
});

test('person: serialize deduplicates ids', () => {
  const a = new mongoose.Types.ObjectId().toString();
  assert.deepEqual(columnTypes.person.serialize([a, a]), [a]);
});

// ---------------------------------------------------------------------------
// status / dropdown
// ---------------------------------------------------------------------------
const statusSettings = {
  options: [
    { id: 'new', label: 'New', color: '#000', order: 0 },
    { id: 'won', label: 'Won', color: '#0f0', order: 1, isDefault: true },
  ],
};

test('status: accepts an option id, rejects unknown id', () => {
  okValidate('status', 'new', statusSettings);
  badValidate('status', 'closed', statusSettings);
});

test('status: defaultValue picks the option flagged as default', () => {
  assert.equal(columnTypes.status.defaultValue(statusSettings), 'won');
});

test('dropdown: rejects unknown option id', () => {
  okValidate('dropdown', 'new', statusSettings);
  badValidate('dropdown', 'mystery', statusSettings);
});

// ---------------------------------------------------------------------------
// tags
// ---------------------------------------------------------------------------
test('tags: accepts option ids, rejects unknown', () => {
  const opts = { options: [{ id: 'a' }, { id: 'b' }] };
  okValidate('tags', ['a', 'b'], opts);
  badValidate('tags', ['c'], opts);
});

// ---------------------------------------------------------------------------
// checkbox / rating
// ---------------------------------------------------------------------------
test('checkbox: only boolean is valid', () => {
  okValidate('checkbox', true);
  okValidate('checkbox', false);
  badValidate('checkbox', 'true');
});

test('rating: enforces integer in [0..max]', () => {
  okValidate('rating', 3);
  okValidate('rating', 0);
  badValidate('rating', 6, { max: 5 });
  badValidate('rating', 2.5);
});

// ---------------------------------------------------------------------------
// link / phone / email
// ---------------------------------------------------------------------------
test('link: accepts object or string', () => {
  okValidate('link', 'https://example.com');
  okValidate('link', { url: 'https://example.com', label: 'site' });
});

test('phone: accepts plausible formats, rejects garbage', () => {
  okValidate('phone', '+1 (555) 123-4567');
  badValidate('phone', 'not-a-number');
});

test('email: validates shape', () => {
  okValidate('email', 'a@b.co');
  badValidate('email', 'a@b');
});

// ---------------------------------------------------------------------------
// location / file
// ---------------------------------------------------------------------------
test('location: validates lat/lng bounds', () => {
  okValidate('location', { lat: 53.5, lng: -113.5, label: 'Edmonton' });
  badValidate('location', { lat: 91 });
  badValidate('location', { lng: -181 });
});

const FILE_URL = 'https://res.cloudinary.com/demo/raw/upload/v1/macan/board-files/64b000000000000000000001/ab12-INV';

test('file: accepts attachment list, rejects non-array', () => {
  okValidate('file', [{ url: FILE_URL, name: 'n', mime: 'image/png', size: 100 }]);
  badValidate('file', { url: FILE_URL });
});

test('file: publicId survives serialize, so the asset can be destroyed later', () => {
  // It used to be dropped here, which made every file-column PDF undeletable:
  // the delete cascade needs the id, and without it the invoice stays public.
  okValidate('file', [{ url: FILE_URL, name: 'n', publicId: 'macan/tasks/1-INV' }]);
  badValidate('file', [{ url: FILE_URL, publicId: 42 }]);
  const [f] = columnTypes.file.serialize([
    { url: 'https://x/raw/upload/v1/macan/tasks/1-INV.pdf', name: 'INV.pdf', mime: 'application/pdf', size: 10, publicId: 'macan/tasks/1-INV' },
  ]);
  assert.equal(f.publicId, 'macan/tasks/1-INV');
  // Older rows never had one — a string either way, never undefined.
  assert.equal(columnTypes.file.serialize([{ url: FILE_URL }])[0].publicId, '');
});

test('file: only an https:// link is a file', () => {
  /**
   * The cell renders as a link and is fetched for the PDF preview. A
   * `javascript:` URL there is a script in the next reader's browser, and an
   * `http:` one is an invoice fetched in the clear — every URL this app issues
   * is https (Cloudinary's `secure_url`), so nothing legitimate is refused.
   */
  okValidate('file', [{ url: 'https://files.example.com/a.pdf' }]);
  for (const url of [
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'http://res.cloudinary.com/demo/raw/upload/v1/x.pdf',
    'ftp://example.com/x.pdf',
    '//res.cloudinary.com/demo/raw/upload/v1/x.pdf',
    'https://',
    ' https://example.com/padded.pdf',
    'u',
    '',
  ]) {
    badValidate('file', [{ url, name: 'x' }]);
  }
  // A file with no link at all is not a file.
  badValidate('file', [{ name: 'orphan.pdf' }]);
  // One bad entry refuses the whole write rather than storing the rest.
  badValidate('file', [{ url: 'https://ok.example.com/a.pdf' }, { url: 'javascript:void 0' }]);
});

// ---------------------------------------------------------------------------
// payments
// ---------------------------------------------------------------------------
const pay = (extra = {}) => ({ amount: 500, date: '2026-09-05', ...extra });

test('payments: accepts a list of payments, and nothing', () => {
  okValidate('payments', null);
  okValidate('payments', []);
  okValidate('payments', [pay(), pay({ amount: 12.5, method: 'Wire', note: 'part 1' })]);
  okValidate('payments', [pay({ by: new mongoose.Types.ObjectId().toString() })]);
});

test('payments: refuses what is not a payment', () => {
  badValidate('payments', { amount: 500 });
  badValidate('payments', 'paid');
  badValidate('payments', [null]);
  badValidate('payments', [[500]]);
  badValidate('payments', [pay({ amount: 0 })]);
  badValidate('payments', [pay({ amount: -10 })]);
  badValidate('payments', [pay({ amount: Infinity })]);
  badValidate('payments', [pay({ amount: 'lots' })]);
  badValidate('payments', [pay({ date: 'not-a-date' })]);
  badValidate('payments', [pay({ date: '2026-02-31' })]);
  badValidate('payments', [pay({ date: undefined })]);
  badValidate('payments', [pay({ by: 'someone' })]);
  badValidate('payments', Array.from({ length: MAX_PAYMENTS + 1 }, () => pay()));
});

test('payments: serialize normalises, keeps ids and mints the missing ones', () => {
  const out = columnTypes.payments.serialize([
    { id: 'keepme', amount: '250', date: '2026-09-10T00:00:00.000Z', method: '  Wire  ', note: ' first ' },
    { amount: 100, date: '2026-09-01' },
  ]);
  assert.equal(out.length, 2);
  // Date order, not entry order.
  assert.deepEqual(out.map((p) => p.date), ['2026-09-01', '2026-09-10']);
  const kept = out.find((p) => p.id === 'keepme');
  assert.ok(kept, 'an existing id must survive');
  assert.equal(kept.amount, 250);
  assert.equal(kept.method, 'Wire');
  assert.equal(kept.note, 'first');
  assert.equal(kept.by, null);
  assert.ok(!Number.isNaN(new Date(kept.at).getTime()), 'at is stamped when absent');
  const minted = out.find((p) => p.id !== 'keepme');
  assert.match(minted.id, /^[0-9a-f]{12}$/);
});

test('payments: a YYYY-MM-DD prefix is the date, never re-read through a zone', () => {
  // '2026-09-05' picked in IST must not become the 4th because UTC midnight
  // is still the previous evening somewhere.
  const [p] = columnTypes.payments.serialize([pay({ date: '2026-09-05T23:30:00+05:30' })]);
  assert.equal(p.date, '2026-09-05');
});

test('payments: same-day payments keep the order they were entered in', () => {
  const out = columnTypes.payments.serialize([
    pay({ id: 'a', date: '2026-09-05' }),
    pay({ id: 'b', date: '2026-09-01' }),
    pay({ id: 'c', date: '2026-09-05' }),
  ]);
  assert.deepEqual(out.map((p) => p.id), ['b', 'a', 'c']);
});

test('payments: a duplicated id is re-minted rather than trusted twice', () => {
  const out = columnTypes.payments.serialize([pay({ id: 'x' }), pay({ id: 'x' })]);
  assert.equal(new Set(out.map((p) => p.id)).size, 2);
});

test('payments: strings are clamped, a bad `by` becomes null', () => {
  const [p] = columnTypes.payments.serialize([
    pay({ method: 'm'.repeat(80), note: 'n'.repeat(400), by: 'nobody' }),
  ]);
  assert.equal(p.method.length, 40);
  assert.equal(p.note.length, 200);
  assert.equal(p.by, null);
});

test('payments: never more than the cap, and the newest are the ones kept', () => {
  const many = Array.from({ length: MAX_PAYMENTS + 5 }, (_, i) =>
    pay({ id: `p${i}`, date: `2026-01-01`, amount: i + 1 })
  );
  const out = columnTypes.payments.serialize(many);
  assert.equal(out.length, MAX_PAYMENTS);
  assert.equal(out[out.length - 1].id, `p${MAX_PAYMENTS + 4}`);
});

test('payments: a single payment is capped at a trillion', () => {
  // A slipped key (or a script) must not put a figure into the strip and the
  // auto-Paid rule that a double can no longer add up exactly.
  okValidate('payments', [pay({ amount: MAX_PAYMENT_AMOUNT })]);
  badValidate('payments', [pay({ amount: MAX_PAYMENT_AMOUNT + 1 })]);
  badValidate('payments', [pay({ amount: '5e15' })]);
  // serialize agrees with validate, for a caller that skipped it.
  assert.deepEqual(columnTypes.payments.serialize([pay({ amount: 1e13 })]), []);
  assert.equal(columnTypes.payments.serialize([pay({ amount: 1e12 })]).length, 1);
});

test('payments: an empty cell is an empty list', () => {
  assert.deepEqual(columnTypes.payments.defaultValue(), []);
  assert.deepEqual(columnTypes.payments.serialize(null), []);
  assert.deepEqual(getColumnType('payments').serialize('junk'), []);
});

// ---------------------------------------------------------------------------
// formula / connect_boards / mirror
// ---------------------------------------------------------------------------
test('formula: a real write is refused as read-only', () => {
  let code = null;
  assert.throws(
    () => columnTypes.formula.validate(1, {}),
    (err) => { code = err.code; return /read-only/i.test(err.message); }
  );
  assert.equal(code, 'READ_ONLY');
});

test('formula: a null probe passes, so the column can be created and edited', () => {
  // addColumn/updateColumn validate the default value against the settings.
  // Throwing on "nothing" made every formula column impossible to configure.
  okValidate('formula', null);
  okValidate('formula', undefined);
  okValidate('formula', columnTypes.formula.defaultValue());
});

// ---------------------------------------------------------------------------
// validateFormulaExpression
// ---------------------------------------------------------------------------
const boardCols = [
  { key: 'amount', name: 'Amount', type: 'number', settings: {} },
  { key: 'paid', name: 'Paid', type: 'payments', settings: {} },
  { key: 'fee', name: 'Fee', type: 'mirror', settings: {} },
  { key: 'title', name: 'Title', type: 'text', settings: {} },
  { key: 'net', name: 'Net', type: 'formula', settings: { expression: 'column.amount - column.paid' } },
  { key: 'gross', name: 'Gross', type: 'formula', settings: { expression: 'column.net + column.fee' } },
];

test('validateFormulaExpression: accepts numeric references and arithmetic', () => {
  assert.deepEqual(validateFormulaExpression('column.amount - column.paid', boardCols), { ok: true });
  assert.deepEqual(validateFormulaExpression('(column.net + column.fee) * 1.18', boardCols), { ok: true });
  assert.deepEqual(validateFormulaExpression('100 / 0', boardCols), { ok: true });
});

test('validateFormulaExpression: refuses what would sit empty forever', () => {
  assert.ok(validateFormulaExpression('', boardCols).error);
  assert.ok(validateFormulaExpression(undefined, boardCols).error);
  assert.match(validateFormulaExpression('column.spend - 1', boardCols).error, /not a column/);
  assert.match(validateFormulaExpression('column.title * 2', boardCols).error, /not a number column/);
  assert.match(validateFormulaExpression('column.amount +', boardCols).error, /not valid/);
  assert.match(validateFormulaExpression('process.exit(0)', boardCols).error, /not valid/);
});

test('validateFormulaExpression: a formula may not reach itself, directly or through another', () => {
  assert.match(validateFormulaExpression('column.net * 2', boardCols, 'net').error, /itself/);
  // net -> gross -> net
  assert.match(validateFormulaExpression('column.gross - 1', boardCols, 'net').error, /itself/);
});

// ---------------------------------------------------------------------------
// client — one of the workspace's clients
// ---------------------------------------------------------------------------
const CLIENT_BOARD = '64b0000000000000000000c1';

test('client: a client board, a typed name, or nothing', () => {
  okValidate('client', null);
  okValidate('client', undefined);
  okValidate('client', { boardId: CLIENT_BOARD, name: 'Kredoo' });
  // No board yet — a one-off, a prospect: the name is all there is.
  okValidate('client', { boardId: null, name: 'Walk-in client' });
  // A board with no name yet: the server writes the board's own name in.
  okValidate('client', { boardId: CLIENT_BOARD, name: '' });
  okValidate('client', { boardId: new mongoose.Types.ObjectId(), name: 'As an ObjectId' });
  assert.equal(getColumnType('client'), columnTypes.client);
  assert.equal(columnTypes.client.defaultValue(), null);
});

test('client: refuses what is not a client', () => {
  badValidate('client', 'Kredoo'); // a bare string is not the shape
  badValidate('client', ['Kredoo']);
  badValidate('client', 42);
  badValidate('client', { boardId: 'not-an-id', name: 'x' });
  badValidate('client', { boardId: 'abcdefabcdef', name: 'x' }); // 12 chars: valid to Mongo, not a board id
  badValidate('client', { boardId: CLIENT_BOARD, name: 7 });
  badValidate('client', { boardId: null, name: 'x'.repeat(MAX_CLIENT_NAME + 1) });
  // …but surrounding whitespace does not count against the cap.
  okValidate('client', { boardId: null, name: `  ${'x'.repeat(MAX_CLIENT_NAME)}  ` });
});

test('client: serialize trims, normalises the id, and stores nothing for nothing', () => {
  assert.deepEqual(
    columnTypes.client.serialize({ boardId: CLIENT_BOARD.toUpperCase(), name: '  Kredoo   Pvt  Ltd ' }),
    { boardId: CLIENT_BOARD, name: 'Kredoo Pvt Ltd' }
  );
  assert.deepEqual(
    columnTypes.client.serialize({ boardId: new mongoose.Types.ObjectId(CLIENT_BOARD), name: 'K' }),
    { boardId: CLIENT_BOARD, name: 'K' }
  );
  assert.deepEqual(columnTypes.client.serialize({ boardId: '', name: 'Typed' }), { boardId: null, name: 'Typed' });
  assert.deepEqual(columnTypes.client.serialize({ boardId: CLIENT_BOARD }), { boardId: CLIENT_BOARD, name: '' });
  // Both empty is an empty cell, not an empty object.
  assert.equal(columnTypes.client.serialize({ boardId: null, name: '   ' }), null);
  assert.equal(columnTypes.client.serialize({}), null);
  assert.equal(columnTypes.client.serialize(null), null);
  assert.equal(columnTypes.client.serialize('Kredoo'), null);
  // Extra keys never reach the database.
  assert.deepEqual(
    Object.keys(columnTypes.client.serialize({ boardId: CLIENT_BOARD, name: 'K', logo: 'x', admin: true })).sort(),
    ['boardId', 'name']
  );
});

test('client: validateColumnValue speaks for it like any other type', () => {
  const col = { _id: 'c1', type: 'client', settings: {} };
  assert.deepEqual(validateColumnValue(col, { boardId: CLIENT_BOARD, name: 'K' }), { ok: true });
  assert.equal(validateColumnValue(col, { boardId: 'nope', name: 'K' }).ok, false);
});

// ---------------------------------------------------------------------------
// connect_boards (F2)
// ---------------------------------------------------------------------------
test('connect_boards: accepts null + empty links', () => {
  okValidate('connect_boards', null);
  okValidate('connect_boards', { links: [] });
});

test('connect_boards: accepts a link to a target board', () => {
  const board = new mongoose.Types.ObjectId().toString();
  const taskId = new mongoose.Types.ObjectId().toString();
  okValidate(
    'connect_boards',
    { links: [{ boardId: board, taskId }] },
    { targetBoardIds: [board], allowMultiple: true }
  );
});

test('connect_boards: rejects a link outside targetBoardIds', () => {
  const allowed = new mongoose.Types.ObjectId().toString();
  const other = new mongoose.Types.ObjectId().toString();
  const taskId = new mongoose.Types.ObjectId().toString();
  badValidate(
    'connect_boards',
    { links: [{ boardId: other, taskId }] },
    { targetBoardIds: [allowed] }
  );
});

test('connect_boards: rejects multiple links when allowMultiple is false', () => {
  const board = new mongoose.Types.ObjectId().toString();
  const t1 = new mongoose.Types.ObjectId().toString();
  const t2 = new mongoose.Types.ObjectId().toString();
  badValidate(
    'connect_boards',
    { links: [{ boardId: board, taskId: t1 }, { boardId: board, taskId: t2 }] },
    { targetBoardIds: [board], allowMultiple: false }
  );
});

test('connect_boards: rejects invalid task ids', () => {
  const board = new mongoose.Types.ObjectId().toString();
  badValidate('connect_boards', { links: [{ boardId: board, taskId: 'not-an-id' }] }, { targetBoardIds: [board] });
});

test('connect_boards: serialize dedupes by taskId and normalises ids', () => {
  const board = new mongoose.Types.ObjectId().toString();
  const taskId = new mongoose.Types.ObjectId().toString();
  const out = columnTypes.connect_boards.serialize({
    links: [{ boardId: board, taskId }, { boardId: board, taskId }],
  });
  assert.equal(out.links.length, 1);
  assert.equal(out.links[0].taskId, taskId);
});

// ---------------------------------------------------------------------------
// mirror (F2) — read-only
// ---------------------------------------------------------------------------
test('mirror: allows a null probe so column creation passes', () => {
  okValidate('mirror', null);
});

test('mirror: rejects a direct value write with READ_ONLY', () => {
  let code = null;
  assert.throws(
    () => columnTypes.mirror.validate('anything', {}),
    (err) => {
      code = err.code;
      return /read-only/i.test(err.message);
    }
  );
  assert.equal(code, 'READ_ONLY');
});

// ---------------------------------------------------------------------------
// evaluateFormula
// ---------------------------------------------------------------------------
test('evaluateFormula: simple sum over column references', () => {
  const expr = 'column.a + column.b';
  assert.equal(evaluateFormula(expr, { a: 2, b: 3 }), 5);
});

test('evaluateFormula: returns null when a referenced column is missing', () => {
  assert.equal(evaluateFormula('column.a * 2', {}), null);
});

test('evaluateFormula: rejects unsupported tokens', () => {
  assert.throws(() => evaluateFormula('process.exit(0)', {}), /unsupported/i);
});

// ---------------------------------------------------------------------------
// validateColumnValue convenience
// ---------------------------------------------------------------------------
test('validateColumnValue: returns { ok: true } on valid input', () => {
  const col = { _id: 'c1', type: 'number', settings: {} };
  const result = validateColumnValue(col, 42);
  assert.equal(result.ok, true);
});

test('validateColumnValue: returns { ok: false, error } on invalid input', () => {
  const col = { _id: 'c1', type: 'number', settings: {} };
  const result = validateColumnValue(col, 'nope');
  assert.equal(result.ok, false);
  assert.match(result.error.message, /number/);
});

test('getColumnType: returns null for unknown type', () => {
  assert.equal(getColumnType('not-a-type'), null);
});
