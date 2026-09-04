const test = require('node:test');
const assert = require('node:assert');

const { isClientBoard, isAdvancedClientBoard, PORTAL_TIERS } = require('./clientBoard');
const { checkUpgrade, describeEffects } = require('./clientTierUpgrade');

/**
 * These two modules are the whole confidentiality boundary for client chat:
 * `isAdvancedClientBoard` is the ONE predicate every gate calls, and
 * `checkUpgrade` is the one that decides whether a board may cross it.
 *
 * Both are pure, so this file needs no database — which is the point. A rule
 * that can only be exercised against Mongo is a rule nobody exercises.
 */

// ---------------------------------------------------------------------------
// clientBoard: the predicate every gate rides on
// ---------------------------------------------------------------------------

test('isAdvancedClientBoard fails CLOSED for everything it does not recognise', () => {
  // Each of these must answer false. A true here is a client reading a room.
  const closed = [
    undefined,
    null,
    {},
    { boardType: 'standard' },
    { boardType: 'tracker' },
    { boardType: 'client' },                          // tier absent (pre-field board)
    { boardType: 'client', portalTier: 'basic' },
    { boardType: 'tracker', portalTier: 'advanced' }, // tier set on the wrong type
    { portalTier: 'advanced' },                       // no boardType at all
  ];
  for (const board of closed) {
    assert.strictEqual(
      isAdvancedClientBoard(board),
      false,
      `must fail closed for ${JSON.stringify(board)}`
    );
  }
});

test('isAdvancedClientBoard is true only for a client board on the advanced tier', () => {
  assert.strictEqual(
    isAdvancedClientBoard({ boardType: 'client', portalTier: 'advanced' }),
    true
  );
});

test('a board with no portalTier reads as basic, which is what it already was', () => {
  // Every board predating the field must need no migration. `isClientBoard` is
  // still true for it — only the chat half is off.
  const legacy = { boardType: 'client' };
  assert.strictEqual(isClientBoard(legacy), true);
  assert.strictEqual(isAdvancedClientBoard(legacy), false);
});

test('the tier vocabulary is exactly basic and advanced', () => {
  assert.deepStrictEqual([...PORTAL_TIERS].sort(), ['advanced', 'basic']);
});

// ---------------------------------------------------------------------------
// checkUpgrade
// ---------------------------------------------------------------------------

test('checkUpgrade refuses a board that is not a client board', () => {
  for (const boardType of ['standard', 'tracker']) {
    const r = checkUpgrade({ board: { boardType, portalTier: 'basic' } });
    assert.strictEqual(r.ok, false, `${boardType} must be refused`);
    assert.ok(r.refusals.length > 0);
  }
});

test('checkUpgrade refuses a missing board rather than throwing', () => {
  const r = checkUpgrade({ board: null });
  assert.strictEqual(r.ok, false);
  assert.match(r.refusals[0], /not found/i);
});

test('an already-advanced board is a NOOP, not an error', () => {
  // The endpoint is idempotent, so a double-submitted confirmation dialog must
  // not surface a failure to the user.
  const r = checkUpgrade({ board: { boardType: 'client', portalTier: 'advanced' } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.noop, true);
  assert.deepStrictEqual(r.refusals, []);
});

test('a basic client board may upgrade', () => {
  const r = checkUpgrade({ board: { boardType: 'client', portalTier: 'basic', portalEnabled: true } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.noop, false);
  assert.deepStrictEqual(r.refusals, []);
});

test('the contact count is WARNED about, never refused on', () => {
  // The warning is the load-bearing one: everything advanced switches on
  // assumes one company per board, so the operator has to be told how many
  // people are about to be able to read each other's rooms. But a board with
  // many contacts is not wrong — it is just a board the human must look at.
  const r = checkUpgrade({
    board: { boardType: 'client', portalTier: 'basic', portalEnabled: true },
    groupCount: 3,
    contactCount: 4,
  });
  assert.strictEqual(r.ok, true);
  assert.ok(
    r.warnings.some((w) => w.includes('4 client contacts')),
    'must name the number of contacts gaining access'
  );
  assert.ok(r.warnings.some((w) => /same company/i.test(w)));
});

test('one contact is warned about in the singular', () => {
  const r = checkUpgrade({
    board: { boardType: 'client', portalTier: 'basic', portalEnabled: true },
    contactCount: 1,
  });
  const warning = r.warnings.find((w) => w.includes('client contact'));
  assert.ok(warning, 'a single contact must still be warned about');
  assert.ok(warning.includes('1 client contact on this board'), warning);
  assert.ok(!warning.includes('contacts'), 'must not pluralise for one contact');
});

test('a board with no workstreams upgrades, with a warning that there are no rooms yet', () => {
  const r = checkUpgrade({
    board: { boardType: 'client', portalTier: 'basic', portalEnabled: true },
    groupCount: 0,
  });
  assert.strictEqual(r.ok, true);
  assert.ok(r.warnings.some((w) => /no workstreams yet/i.test(w)));
});

test('a disabled portal upgrades, with a warning that clients cannot reach it', () => {
  const r = checkUpgrade({
    board: { boardType: 'client', portalTier: 'basic', portalEnabled: false },
  });
  assert.strictEqual(r.ok, true);
  assert.ok(r.warnings.some((w) => /disabled/i.test(w)));
});

test('counts are optional — an unknown count produces no warning about it', () => {
  const r = checkUpgrade({ board: { boardType: 'client', portalTier: 'basic', portalEnabled: true } });
  assert.strictEqual(r.ok, true);
  assert.ok(!r.warnings.some((w) => /client contact/.test(w)));
});

// ---------------------------------------------------------------------------
// describeEffects
// ---------------------------------------------------------------------------

test('describeEffects leads with the ACCESS change, not the feature', () => {
  // The tempting order is features first, fine print last — which buries the
  // only line that can cause harm. The first effect must be about who gains
  // access, and the irreversibility must be stated.
  const effects = describeEffects();
  assert.ok(effects.length >= 2);
  assert.match(effects[0], /client contact/i);
  assert.ok(
    effects.some((e) => /cannot be undone|permanent/i.test(e)),
    'the one-way nature must be spelled out to the user'
  );
});

// ---------------------------------------------------------------------------
// The one-way rule, at the model layer
// ---------------------------------------------------------------------------

test('Board refuses an advanced -> basic downgrade on save', () => {
  const Board = require('../models/Board');
  const hooks = Board.schema.s.hooks._pres.get('save') || [];
  const hook = hooks.map((h) => h.fn).find((f) => f.name === 'enforceOneWayPortalTier');
  assert.ok(hook, 'the one-way tier guard must be registered as a pre-save hook');

  // Exercise the hook itself rather than trusting its presence. A stub `this`
  // is enough: the rule reads only isNew / isModified / portalTier.
  const ctx = (over) => ({ isNew: false, portalTier: 'basic', isModified: () => true, ...over });

  assert.throws(() => hook.call(ctx()), /one-way/i, 'advanced -> basic must throw');

  // The cases that must NOT throw:
  assert.doesNotThrow(
    () => hook.call(ctx({ isNew: true })),
    'creating a basic board is not a downgrade'
  );
  assert.doesNotThrow(
    () => hook.call(ctx({ portalTier: 'advanced' })),
    'upgrading is the whole point'
  );
  assert.doesNotThrow(
    () => hook.call(ctx({ isModified: () => false })),
    're-saving an already-basic board must not throw — isModified only fires on a real change'
  );
});

test('Board refuses a tier downgrade on the QUERY path too', () => {
  // pre('save') never runs for updateOne/findOneAndUpdate, which is exactly
  // how a downgrade would slip past a save-only guard.
  const Board = require('../models/Board');
  const hooks = Board.schema.s.hooks._pres.get('updateOne') || [];
  const hook = hooks.map((h) => h.fn).find((f) => f.name === 'refuseTierDowngrade');
  assert.ok(hook, 'the query-path guard must be registered');

  const q = (update, filter = {}) => ({ getUpdate: () => update, getFilter: () => filter });

  assert.throws(() => hook.call(q({ $set: { portalTier: 'basic' } })), /one-way/i);
  assert.throws(() => hook.call(q({ portalTier: 'basic' })), /one-way/i);

  // The upgrade's own conditional write pins portalTier:'basic' in the FILTER
  // while setting 'advanced' — that must sail through.
  assert.doesNotThrow(() =>
    hook.call(q({ $set: { portalTier: 'advanced' } }, { portalTier: 'basic' }))
  );
  assert.doesNotThrow(() => hook.call(q({ $set: { name: 'x' } })));
  assert.doesNotThrow(() => hook.call(q(undefined)));
});

test('Board.portalToken is select:false and has NO default', () => {
  const Board = require('../models/Board');
  const path = Board.schema.path('portalToken');
  assert.strictEqual(path.options.select, false, 'a live portal link must not ship with every board read');
  // The field must be ABSENT, never null: a sparse unique index skips missing
  // fields but DOES index nulls, so a `default: null` collides (E11000) on the
  // second board without a portal.
  assert.strictEqual(path.options.default, undefined);

  const idx = Board.schema.indexes().find(([f]) => f.portalToken === 1);
  assert.ok(idx, 'boards need a portalToken index to resolve a portal link');
  assert.strictEqual(idx[1].unique, true);
  assert.strictEqual(idx[1].sparse, true);
});

test('ClientContact identity is (board, email), and group is no longer required', () => {
  const ClientContact = require('../models/ClientContact');
  const idx = ClientContact.schema.indexes().find(
    ([f]) => f.board === 1 && f.email === 1
  );
  assert.ok(idx, 'contacts must be unique per (board, email)');
  assert.strictEqual(idx[1].unique, true);

  const stale = ClientContact.schema.indexes().find(([f]) => f.group === 1 && f.email === 1);
  assert.strictEqual(stale, undefined, 'the group-scoped identity index must be gone');

  assert.ok(
    !ClientContact.schema.path('group').isRequired,
    'group is vestigial — leaving it required would throw on every new contact'
  );
  assert.ok(ClientContact.schema.path('board').isRequired);
});

test('TaskGroup no longer carries the portal', () => {
  const TaskGroup = require('../models/TaskGroup');
  for (const field of ['portalToken', 'portalEnabled', 'portalClientName']) {
    assert.strictEqual(
      TaskGroup.schema.path(field),
      undefined,
      `TaskGroup.${field} moved to Board — a group is a workstream now, not a client`
    );
  }
  const stale = TaskGroup.schema.indexes().find(([f]) => f.portalToken === 1);
  assert.strictEqual(stale, undefined);
});
