const test = require('node:test');
const assert = require('node:assert/strict');

const {
  OFFERED_SURFACES,
  SURFACE_KEYS,
  surfaceByKey,
  keyForSurface,
  isClientFacing,
  surfaceName,
  describeSurface,
  planSurfaces,
  describePlan,
} = require('./chatSurfaces');

/**
 * The surface vocabulary is the whole modularity claim of this feature — "a new
 * mode is a new row in one table, not new navigation" — so the table itself is
 * what these assert. Pure, no database: that is the point of the module being
 * dependency-free.
 */

test('the offered surfaces are exactly the three the picker shows', () => {
  assert.deepEqual(SURFACE_KEYS, ['clientChat', 'clientMail', 'team']);
  // mail+team is REPRESENTABLE in the model and deliberately not offered. If
  // this ever starts being offered it should be a decision, not a drift.
  assert.equal(
    OFFERED_SURFACES.some((s) => s.mode === 'mail' && s.audience === 'team'),
    false
  );
});

test('every offered surface carries a unique (mode, audience) pair', () => {
  const pairs = OFFERED_SURFACES.map((s) => `${s.mode}:${s.audience}`);
  assert.equal(new Set(pairs).size, pairs.length, 'two surfaces claim the same pair');
});

test('keyForSurface TOLERATES an unoffered pair rather than throwing', () => {
  // The model allows mail+team and a future release may start offering it, so
  // display code must be able to ask about a stored channel without a crash.
  assert.equal(keyForSurface('chat', 'team'), 'team');
  assert.equal(keyForSurface('mail', 'client'), 'clientMail');
  assert.equal(keyForSurface('mail', 'team'), null);
  assert.equal(keyForSurface(undefined, undefined), null);
});

test('surfaceByKey answers null for a key that does not exist', () => {
  assert.equal(surfaceByKey('clientChat').mode, 'chat');
  assert.equal(surfaceByKey('nonsense'), null);
});

test('only the client audience is client-facing', () => {
  assert.equal(isClientFacing('client'), true);
  assert.equal(isClientFacing('team'), false);
  assert.equal(isClientFacing(undefined), false);
});

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

test('a team room keeps the bare workstream name', () => {
  assert.equal(
    surfaceName({ audience: 'team', groupName: 'Ads', clientName: 'Acme Corp' }),
    'Ads'
  );
});

test('a client-facing room names the company too', () => {
  // Because the name is what a notification says out of context — "mentioned
  // you in #Ads" cannot tell you whether the client is in the room.
  assert.equal(
    surfaceName({ audience: 'client', groupName: 'Ads', clientName: 'Acme Corp' }),
    'Ads · Acme Corp'
  );
});

test('a client-facing room with no company name falls back to the workstream', () => {
  assert.equal(surfaceName({ audience: 'client', groupName: 'Ads', clientName: '' }), 'Ads');
  assert.equal(surfaceName({ audience: 'client', groupName: 'Ads' }), 'Ads');
});

test('an unnamed workstream still produces a usable name', () => {
  // Channel.name is `required`, so returning '' here would throw on save at a
  // point far from the cause.
  assert.equal(surfaceName({ audience: 'team', groupName: '   ' }), 'Untitled workstream');
});

test('describeSurface spells out mail and lets chat ride the # convention', () => {
  assert.equal(describeSurface({ mode: 'chat', name: 'Ads' }), '#Ads');
  assert.equal(describeSurface({ mode: 'mail', name: 'Ads' }), 'the Ads mailbox');
  assert.equal(describeSurface(null), '#a channel');
});

// ---------------------------------------------------------------------------
// planSurfaces — the refusals
// ---------------------------------------------------------------------------

test('an EMPTY selection is refused', () => {
  // The one outcome the modal exists to prevent: a workstream nobody can talk
  // in. Treating it as "no change" would let it be reached by accident.
  const plan = planSurfaces({});
  assert.equal(plan.ok, false);
  assert.equal(plan.surfaces.length, 0);
  assert.match(plan.refusals[0], /at least one/i);

  assert.equal(planSurfaces(null).ok, false);
  assert.equal(planSurfaces({ clientChat: false, clientMail: false, team: false }).ok, false);
});

test('client surfaces are refused on a board that is not a live client portal', () => {
  const plan = planSurfaces(
    { clientChat: true, team: true },
    { allowClientSurfaces: false }
  );
  assert.equal(plan.ok, false);
  assert.match(plan.refusals[0], /live client portal/i);
});

test('a TEAM-ONLY selection is fine on a board with no live client portal', () => {
  // The private room has no client in it, so the client-portal gate has nothing
  // to say about it. Refusing it would make the modal useless on every board
  // that is not a live client portal, which is most of them.
  const plan = planSurfaces({ team: true }, { allowClientSurfaces: false });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.surfaces, [{ mode: 'chat', audience: 'team', key: 'team' }]);
});

test('a refused plan yields NO surfaces at all', () => {
  // Not "the allowed subset". A partially-applied selection is a state nobody
  // asked for, and the caller would have no way to report what it did.
  const plan = planSurfaces(
    { clientChat: true, team: true },
    { allowClientSurfaces: false }
  );
  assert.deepEqual(plan.surfaces, []);
});

test('the full selection produces all three, in display order', () => {
  const plan = planSurfaces({ clientChat: true, clientMail: true, team: true });
  assert.equal(plan.ok, true);
  assert.deepEqual(
    plan.surfaces.map((s) => s.key),
    ['clientChat', 'clientMail', 'team']
  );
});

test('unknown keys in the selection are ignored, not obeyed', () => {
  const plan = planSurfaces({ team: true, clientVoice: true, __proto__: true });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.surfaces.map((s) => s.key), ['team']);
});

// ---------------------------------------------------------------------------
// describePlan — the button names its consequence
// ---------------------------------------------------------------------------

test('the submit button names what it will do', () => {
  assert.equal(describePlan([]), 'Create');
  assert.equal(describePlan([{}]), 'Create 1 surface');
  assert.equal(describePlan([{}, {}]), 'Create 2 surfaces');
  assert.equal(describePlan(undefined), 'Create');
});
