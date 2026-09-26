import test from 'node:test';
import assert from 'node:assert';

import { evaluateFormula, formulaReferences } from './formula.js';
import { formulaValue, numericValue } from './columnValues.js';

/**
 * The client port of the server's formula grammar. A formula the server lets
 * you save must compute here; one it refuses must not — and refusing here
 * means an empty cell, never a thrown error that takes the grid down.
 */

test('the budget template formula computes', () => {
  assert.equal(evaluateFormula('column.allocated - column.spent', { allocated: 1000, spent: 250 }), 750);
});

test('numbers, operators and parentheses', () => {
  assert.equal(evaluateFormula('(column.a + column.b) * 2 / 4', { a: 3, b: 5 }), 4);
  assert.equal(evaluateFormula('column.a - -2', { a: 1 }), 3);
  assert.equal(evaluateFormula('10', {}), 10);
});

test('numeric strings are read as numbers, as on the server', () => {
  assert.equal(evaluateFormula('column.a + column.b', { a: '2', b: 3 }), 5);
});

test('a missing or non-numeric input makes the whole formula null', () => {
  assert.equal(evaluateFormula('column.a - column.b', { a: 1 }), null);
  assert.equal(evaluateFormula('column.a - column.b', { a: 1, b: '' }), null);
  assert.equal(evaluateFormula('column.a - column.b', { a: 1, b: 'x' }), null);
  assert.equal(evaluateFormula('column.a', null), null);
});

test('anything outside the whitelist is refused — null, not a throw', () => {
  assert.equal(evaluateFormula('alert(1)', {}), null);
  assert.equal(evaluateFormula('column.a + process.exit()', { a: 1 }), null);
  assert.equal(evaluateFormula('Math.max(column.a, 2)', { a: 1 }), null);
  assert.equal(evaluateFormula('column.a; 1', { a: 1 }), null);
  // Checked before the missing-input bail-out, exactly as the server does.
  assert.equal(evaluateFormula('foo + column.a', {}), null);
});

test('a malformed but whitelisted expression is null, not an exception', () => {
  assert.equal(evaluateFormula('(1 +', {}), null);
  assert.equal(evaluateFormula('1 +* 2', {}), null);
});

test('a non-finite result is null', () => {
  assert.equal(evaluateFormula('column.a / column.b', { a: 1, b: 0 }), null);
});

test('empty and non-string expressions are null', () => {
  assert.equal(evaluateFormula('', {}), null);
  assert.equal(evaluateFormula('   ', {}), null);
  assert.equal(evaluateFormula(undefined, {}), null);
});

test('formulaReferences lists each referenced key once', () => {
  assert.deepEqual(formulaReferences('column.a - column.b + column.a'), ['a', 'b']);
  assert.deepEqual(formulaReferences(null), []);
});

// --- formulas on a real task --------------------------------------------------

const ALLOCATED = { _id: 'c1', key: 'allocated', type: 'number', settings: { format: 'currency' } };
const SPENT = { _id: 'c2', key: 'spent', type: 'number', settings: { format: 'currency' } };
const REMAINING = {
  _id: 'c3',
  key: 'remaining',
  type: 'formula',
  settings: { expression: 'column.allocated - column.spent', format: 'currency' },
};
const COLUMNS = [ALLOCATED, SPENT, REMAINING];
const task = (values) => ({ columnValues: values });

test('formulaValue reads the task cells by column id and the expression by key', () => {
  assert.equal(formulaValue(task({ c1: 1000, c2: 400 }), REMAINING, COLUMNS), 600);
  // A hydrated document hands back a Map; same answer.
  assert.equal(formulaValue(task(new Map([['c1', 1000], ['c2', 400]])), REMAINING, COLUMNS), 600);
});

test('formulaValue without the board columns cannot resolve its inputs', () => {
  assert.equal(formulaValue(task({ c1: 1000, c2: 400 }), REMAINING, null), null);
});

test('a formula can read another formula', () => {
  const pct = {
    _id: 'c4',
    key: 'left_pct',
    type: 'formula',
    settings: { expression: 'column.remaining / column.allocated * 100' },
  };
  assert.equal(formulaValue(task({ c1: 1000, c2: 250 }), pct, [...COLUMNS, pct]), 75);
});

test('a reference cycle computes as null instead of overflowing the stack', () => {
  const a = { _id: 'a', key: 'a', type: 'formula', settings: { expression: 'column.b + 1' } };
  const b = { _id: 'b', key: 'b', type: 'formula', settings: { expression: 'column.a + 1' } };
  assert.equal(formulaValue(task({}), a, [a, b]), null);
});

test('payments feed a formula as their total', () => {
  const amount = { _id: 'p1', key: 'amount', type: 'number' };
  const paid = { _id: 'p2', key: 'payments', type: 'payments' };
  const outstanding = {
    _id: 'p3',
    key: 'outstanding',
    type: 'formula',
    settings: { expression: 'column.amount - column.payments' },
  };
  const cols = [amount, paid, outstanding];
  const row = task({ p1: 1000, p2: [{ id: 'x', amount: 300 }, { id: 'y', amount: 200 }] });
  assert.equal(formulaValue(row, outstanding, cols), 500);
  // Nothing paid yet: the whole amount is outstanding, not a blank.
  assert.equal(formulaValue(task({ p1: 1000 }), outstanding, cols), 1000);
});

test('numericValue per column type', () => {
  const rating = { _id: 'r', key: 'rating', type: 'rating' };
  const mirror = { _id: 'm', key: 'm', type: 'mirror' };
  const text = { _id: 't', key: 't', type: 'text' };
  const row = task({
    c1: '1500',
    r: 4,
    m: { __mirror: true, value: 42 },
    t: '99',
  });
  assert.equal(numericValue(row, ALLOCATED, COLUMNS), 1500);
  assert.equal(numericValue(row, rating, COLUMNS), 4);
  assert.equal(numericValue(row, mirror, COLUMNS), 42);
  assert.equal(numericValue(task({ m: 'Acme' }), mirror, COLUMNS), null, 'a text mirror is not a number');
  assert.equal(numericValue(row, text, COLUMNS), null, 'a text column is never a number');
  assert.equal(numericValue(task({}), ALLOCATED, COLUMNS), null, 'an empty cell is null, not 0');
});
