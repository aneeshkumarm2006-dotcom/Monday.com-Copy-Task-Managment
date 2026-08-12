const { test } = require('node:test');
const assert = require('node:assert');

const { checkConversion, describeEffects } = require('./monthlyConvert');

const board = (over = {}) => ({
  boardType: 'standard',
  monthTimezone: null,
  useFlexibleColumns: false,
  ...over,
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

test('a client board is refused in both directions, with no override', () => {
  const toMonthly = checkConversion({
    board: board({ boardType: 'client' }),
    to: 'monthly',
    timezone: 'Asia/Kolkata',
  });
  assert.strictEqual(toMonthly.ok, false);
  assert.match(toMonthly.refusals[0], /Client Portal/);

  // Even reverting a client board is refused — it was never monthly, and the
  // request itself indicates a confused caller.
  const toStandard = checkConversion({ board: board({ boardType: 'client' }), to: 'standard' });
  assert.strictEqual(toStandard.ok, false);
});

test('converting to monthly without a usable timezone is refused', () => {
  const none = checkConversion({ board: board(), to: 'monthly' });
  assert.strictEqual(none.ok, false);
  assert.match(none.refusals[0], /timezone is required/i);

  const junk = checkConversion({ board: board(), to: 'monthly', timezone: 'Mars/Olympus' });
  assert.strictEqual(junk.ok, false);
  assert.match(junk.refusals[0], /not a timezone/i);

  // Empty string is not a timezone either, and must not read as "not supplied".
  assert.strictEqual(checkConversion({ board: board(), to: 'monthly', timezone: '' }).ok, false);
});

test('an unknown target type is refused rather than assumed', () => {
  const r = checkConversion({ board: board(), to: 'weekly' });
  assert.strictEqual(r.ok, false);
  assert.match(r.refusals[0], /Unknown board type/);
});

test('a missing board is refused, not crashed on', () => {
  const r = checkConversion({ board: null, to: 'monthly', timezone: 'UTC' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.refusals.length, 1);
});

// ---------------------------------------------------------------------------
// Allowed conversions
// ---------------------------------------------------------------------------

test('a standard board converts to monthly with a valid timezone', () => {
  const r = checkConversion({ board: board(), to: 'monthly', timezone: 'Asia/Kolkata' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.noop, false);
  assert.strictEqual(r.timezone, 'Asia/Kolkata');
  assert.deepStrictEqual(r.refusals, []);
  assert.deepStrictEqual(r.warnings, []);
});

test('an already-monthly board reuses its stored timezone when none is supplied', () => {
  const r = checkConversion({
    board: board({ boardType: 'standard', monthTimezone: 'Europe/London' }),
    to: 'monthly',
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.timezone, 'Europe/London');
});

test('an explicit timezone overrides the stored one', () => {
  const r = checkConversion({
    board: board({ monthTimezone: 'Europe/London' }),
    to: 'monthly',
    timezone: 'America/New_York',
  });
  assert.strictEqual(r.timezone, 'America/New_York');
});

test('an explicit timezone wins even when the board is ALREADY monthly', () => {
  // The refile case. Returning the stored zone here made a timezone change
  // recompute every month against the zone being changed away from — which
  // reports "0 changed" and looks like success.
  const r = checkConversion({
    board: board({ boardType: 'monthly', monthTimezone: 'America/Toronto' }),
    to: 'monthly',
    timezone: 'Asia/Calcutta',
  });
  assert.strictEqual(r.noop, true, 'still a no-op as far as the TYPE goes');
  assert.strictEqual(r.timezone, 'Asia/Calcutta', 'but the new zone must come back');

  // With no timezone supplied, the stored one still stands.
  const kept = checkConversion({
    board: board({ boardType: 'monthly', monthTimezone: 'America/Toronto' }),
    to: 'monthly',
  });
  assert.strictEqual(kept.timezone, 'America/Toronto');

  // Junk does not silently replace a good stored zone.
  const junk = checkConversion({
    board: board({ boardType: 'monthly', monthTimezone: 'America/Toronto' }),
    to: 'monthly',
    timezone: 'Mars/Olympus',
  });
  assert.strictEqual(junk.timezone, 'America/Toronto');
});

test('converting a board to what it already is, is a no-op rather than an error', () => {
  const m = checkConversion({
    board: board({ boardType: 'monthly', monthTimezone: 'UTC' }),
    to: 'monthly',
  });
  assert.strictEqual(m.ok, true);
  assert.strictEqual(m.noop, true);

  const s = checkConversion({ board: board({ boardType: 'standard' }), to: 'standard' });
  assert.strictEqual(s.ok, true);
  assert.strictEqual(s.noop, true);
});

// ---------------------------------------------------------------------------
// Warnings — allowed, but say something
// ---------------------------------------------------------------------------

test('a flexible-columns board converts, with a warning that Goals does not reuse them', () => {
  const r = checkConversion({
    board: board({ useFlexibleColumns: true }),
    to: 'monthly',
    timezone: 'UTC',
  });
  assert.strictEqual(r.ok, true, 'flexible columns must not block conversion');
  assert.strictEqual(r.warnings.length, 1);
  assert.match(r.warnings[0], /flexible columns/i);
});

test('reverting to standard warns about the tabs but promises no data loss', () => {
  const r = checkConversion({
    board: board({ boardType: 'monthly', monthTimezone: 'UTC' }),
    to: 'standard',
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.noop, false);
  assert.match(r.warnings.join(' '), /Delivery and Goals tabs will disappear/);
  assert.match(r.warnings.join(' '), /Nothing is deleted/);
});

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

test('describeEffects states consequences the user wants, per direction', () => {
  const monthly = describeEffects('monthly');
  assert.strictEqual(monthly.length, 3);
  assert.match(monthly.join(' '), /month picker/);

  const standard = describeEffects('standard');
  assert.match(standard.join(' '), /hidden/);
  assert.notDeepStrictEqual(monthly, standard);
});
