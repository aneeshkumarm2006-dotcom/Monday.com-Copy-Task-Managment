/**
 * dateRange.test.mjs — the timezone bug that is invisible to whoever ships it.
 *
 * The whole point of these day keys is that they are UTC, because a snapshot's
 * `periodKey` is UTC and the endpoint that filters on it parses UTC. A preset
 * built from local-time dates works perfectly in London and drops the newest
 * column of every chart for everybody in New York — which is a bug you cannot
 * see, cannot reproduce, and will be told about as "the data looks a day behind".
 *
 * `process.env.TZ` is set before the module is imported, so these run against a
 * timezone that would expose it.
 *
 * Run from the client directory:
 *     node --test src/utils/dateRange.test.mjs
 */

process.env.TZ = 'America/Los_Angeles';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RANGE_PRESETS,
  isRangeInvalid,
  prettyDay,
  resolveRangePreset,
  toDayKey,
} from './dateRange.js';

test('a day key is the UTC day, not the local one', () => {
  // 17:30 in Los Angeles on 31 August is already 1 September in UTC. The key has
  // to be the UTC one, or a "this month" preset run in the evening starts a day
  // out of step with the period keys it is filtering.
  assert.equal(toDayKey(new Date('2026-09-01T00:30:00Z')), '2026-09-01');
  assert.equal(toDayKey(new Date('2026-08-31T23:59:59Z')), '2026-08-31');
});

test('every preset answers two well-formed day keys, in order', () => {
  for (const preset of RANGE_PRESETS) {
    if (!preset.range) continue;
    const { from, to } = resolveRangePreset(preset.key, { from: '', to: '' });
    assert.match(from, /^\d{4}-\d{2}-\d{2}$/, `${preset.key} from`);
    assert.match(to, /^\d{4}-\d{2}-\d{2}$/, `${preset.key} to`);
    assert.ok(from <= to, `${preset.key} is reversed`);
    assert.equal(isRangeInvalid({ from, to }), false);
  }
});

test('"custom" is a sentinel that hands back what the caller already had', () => {
  const held = { from: '2026-01-01', to: '2026-02-01' };
  assert.deepEqual(resolveRangePreset('custom', held), held);
  // An unknown key behaves the same way rather than silently widening the range
  // to everything.
  assert.deepEqual(resolveRangePreset('not-a-preset', held), held);
});

test('"last month" ends on the last day of last month, not the first of this one', () => {
  // Day 0 of this month is the last day of the previous one — the off-by-one
  // that otherwise reports one day of the current month as part of the last.
  const { from, to } = resolveRangePreset('lastMonth', { from: '', to: '' });
  const now = new Date();
  const expectedMonth = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)
  );
  assert.equal(from, toDayKey(expectedMonth));
  assert.equal(to.slice(0, 7), from.slice(0, 7));
});

test('a reversed range is refused rather than silently returning nothing', () => {
  assert.equal(isRangeInvalid({ from: '2026-05-01', to: '2026-04-01' }), true);
  assert.equal(isRangeInvalid({ from: '', to: '2026-04-01' }), true);
  assert.equal(isRangeInvalid({ from: '2026-04-01', to: '' }), true);
  assert.equal(isRangeInvalid({ from: '2026-04-01', to: '2026-04-01' }), false);
});

test('prettyDay renders the UTC day and never "Invalid Date"', () => {
  assert.equal(prettyDay(''), '');
  assert.equal(prettyDay('last tuesday'), '');
  assert.equal(prettyDay(null), '');
  // The day itself must survive the render, whatever the reader's timezone.
  assert.match(prettyDay('2026-09-01'), /1/);
  assert.match(prettyDay('2026-09-01'), /2026/);
});
