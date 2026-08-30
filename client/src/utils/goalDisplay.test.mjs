/**
 * goalDisplay.test.mjs — the two places the goals table decides something the
 * server already decided.
 *
 * This file holds no scoring and must not start holding any: every percentage
 * on a goal row arrives computed from `utils/goalTypes.js`. What it does hold is
 * the mapping from a goal TYPE to the cells its row draws, and that is exactly
 * the kind of thing that quietly diverges — a table here saying `threshold →
 * limit` is a second declaration of something the scorer already publishes, and
 * a type it has never heard of renders an uneditable dash where its target
 * belongs, on every row, with nothing on screen to say why.
 *
 * `band` — "land inside 1-3" — is the type that found it. The fix was to have
 * the server declare `targetConfigKey`, so these assertions are about the
 * PRECEDENCE between the server's answer and the local fallback rather than
 * about the fallback's contents.
 *
 * Run from the client directory:
 *     node --test src/utils/goalDisplay.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { targetFieldOf, hasBaselineField, describeGoal } from './goalDisplay.js';

/** The shape `GET /api/goal-types` sends, cut to what these two functions read. */
const spec = (over = {}) => ({
  key: 'band',
  targetConfigKey: 'high',
  configFields: [
    { key: 'low', label: 'What is the lowest it can be?', type: 'number' },
    { key: 'high', label: 'What is the highest it can be?', type: 'number' },
    { key: 'baseline', label: 'Where were you before? (optional)', type: 'number' },
  ],
  ...over,
});

// ---------------------------------------------------------------------------
// Which config field the Target cell edits
// ---------------------------------------------------------------------------

test('the server’s answer wins, and it carries the field’s own label', () => {
  const field = targetFieldOf(spec(), 'band');
  assert.equal(field.key, 'high');
  assert.equal(field.kind, 'number');
  assert.equal(field.label, 'What is the highest it can be?');
});

test('a declared NULL is a real answer and does not fall through to the map', () => {
  // "Did we do it?" and "Judge it manually" promise no number, so their Target
  // cell must stay a dash nobody can type into. A truthiness check here would
  // read that null as "the server did not say" and reach for the local table.
  assert.equal(targetFieldOf(spec({ key: 'boolean', targetConfigKey: null, configFields: [] }), 'boolean'), null);
  assert.equal(targetFieldOf(spec({ key: 'rating', targetConfigKey: null, configFields: [] }), 'rating'), null);
});

test('a spec that has not arrived yet still renders the four original types', () => {
  // The row draws before `GET /api/goal-types` comes back — and at all, if it
  // fails — so the local table stays as the fallback rather than being deleted.
  assert.equal(targetFieldOf(null, 'numeric').key, 'target');
  assert.equal(targetFieldOf(null, 'checklist').key, 'total');
  assert.equal(targetFieldOf(null, 'threshold').key, 'limit');
  assert.equal(targetFieldOf(null, 'deadline').kind, 'date');
  assert.equal(targetFieldOf(null, 'band').key, 'high');
  assert.equal(targetFieldOf(null, 'boolean'), null);
});

test('an OLDER server that declares no target key still falls back', () => {
  // The key is absent rather than null, which is the distinction the `in` check
  // exists for.
  const older = { key: 'threshold', configFields: [{ key: 'limit', label: 'The line', type: 'number' }] };
  assert.equal(targetFieldOf(older, 'threshold').key, 'limit');
});

test('the Start cell is derived from the config fields, not from a list of types', () => {
  assert.equal(hasBaselineField(spec(), 'band'), true);
  assert.equal(hasBaselineField(spec({ configFields: [] }), 'band'), false);
  // Fallback for a row drawn before the spec arrives.
  assert.equal(hasBaselineField(null, 'numeric'), true);
  assert.equal(hasBaselineField(null, 'checklist'), false);
});

// ---------------------------------------------------------------------------
// The sentence — the same one the form previews and the row shows as a tooltip
// ---------------------------------------------------------------------------

test('a band reads as a range, not as a target', () => {
  const sentence = describeGoal(
    { name: 'Main keyword', type: 'band', config: { low: 1, high: 3 } },
    spec()
  );
  assert.match(sentence, /land between 1 and 3/);
  assert.match(sentence, /in or out/);
});

test('the sentence only promises partial credit when the start is OUTSIDE the range', () => {
  /**
   * Mirrors the scorer, which gives graded credit only from outside the band on
   * the same side — starting inside it and falling out is a miss. A preview
   * that said "getting closer counts for something" to somebody already inside
   * the range would be describing a rule that does not exist.
   */
  const outside = describeGoal(
    { name: 'Main keyword', type: 'band', config: { low: 1, high: 3, baseline: 8 } },
    spec()
  );
  assert.match(outside, /getting closer counts for something/);

  const inside = describeGoal(
    { name: 'Main keyword', type: 'band', config: { low: 1, high: 3, baseline: 2 } },
    spec()
  );
  assert.match(inside, /already inside it/);
  assert.doesNotMatch(inside, /getting closer/);
});

test('a half-filled band says its own name and nothing it cannot support', () => {
  const half = describeGoal({ name: 'Main keyword', type: 'band', config: { low: 1 } }, spec());
  assert.equal(half, 'Main keyword');
  assert.equal(describeGoal({ name: '', type: 'band', config: { low: 1, high: 3 } }, spec()), '');
});

test('the units a band is measured in follow it into the sentence', () => {
  const sentence = describeGoal(
    { name: 'Booked time', type: 'band', unit: 'percent', config: { low: 80, high: 95 } },
    spec()
  );
  assert.match(sentence, /between 80% and 95%/);
});
