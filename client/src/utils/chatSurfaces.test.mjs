/**
 * chatSurfaces.test.mjs — the two refusals, asserted rather than commented.
 *
 * This file mirrors `server/src/utils/chatSurfaces.js`, and a mirror that
 * drifts is worse than no mirror: the modal would offer a surface the server
 * rejects, or disable a button the server would have accepted. The tests below
 * pin the parts a drift would break first — the refusal rules and the wire
 * names — so the copy cannot quietly stop matching the original.
 *
 * Nothing here renders anything. That is the whole reason the table lives in a
 * plain module instead of inside `SetUpCommunicationModal`: a rule about what
 * may be created is testable without a DOM, and a rule buried in JSX is not.
 *
 * Run from the client directory:
 *     node --test src/utils/chatSurfaces.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OFFERED_SURFACES,
  SURFACE_KEYS,
  describePlan,
  isClientFacing,
  keyForSurface,
  planSurfaces,
  surfaceByKey,
} from './chatSurfaces.js';

// ---------------------------------------------------------------------------
// The refusal the modal exists to produce
// ---------------------------------------------------------------------------

test('an empty selection is refused, not treated as "no change"', () => {
  // A workstream with no surfaces is a workstream nobody can talk in. Silently
  // succeeding here would leave exactly that state behind, reported as done.
  const plan = planSurfaces({});
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.surfaces, []);
  assert.equal(plan.refusals.length, 1);
  assert.match(plan.refusals[0], /at least one/i);
});

test('every falsy shape of "nothing ticked" is the same refusal', () => {
  // The modal holds its checkboxes as booleans, but `undefined` arrives too —
  // from a partial selection object, or from a caller that only sets the keys
  // it cares about.
  for (const selection of [undefined, null, {}, { clientChat: false, team: false }]) {
    assert.equal(planSurfaces(selection).ok, false, JSON.stringify(selection));
  }
});

test('one tick is enough', () => {
  const plan = planSurfaces({ team: true });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.surfaces, [{ mode: 'chat', audience: 'team', key: 'team' }]);
  assert.deepEqual(plan.refusals, []);
});

// ---------------------------------------------------------------------------
// The tier gate
// ---------------------------------------------------------------------------

test('client surfaces are refused when the board is not a live client portal', () => {
  const plan = planSurfaces(
    { clientChat: true, clientMail: true },
    { allowClientSurfaces: false }
  );
  assert.equal(plan.ok, false);
  assert.match(plan.refusals[0], /live client portal/i);
  // And nothing is planned — not even a partial set. A caller that ignored
  // `ok` must not be handed half a selection to POST.
  assert.deepEqual(plan.surfaces, []);
});

test('the team room is still allowed on a board that has no client surfaces', () => {
  // The private room has no client in it by definition, so the tier has
  // nothing to say about it.
  const plan = planSurfaces({ team: true }, { allowClientSurfaces: false });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.surfaces.map((s) => s.key), ['team']);
});

test('a mixed selection on a basic board is refused whole', () => {
  // Not "create the team room and skip the rest": the person asked for three
  // things, and quietly delivering one of them is a lie about what happened.
  const plan = planSurfaces(
    { clientChat: true, team: true },
    { allowClientSurfaces: false }
  );
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.surfaces, []);
});

test('client surfaces are allowed by default', () => {
  // The default matters: a caller that forgets the options object gets the
  // permissive answer on the CLIENT, where the only consequence is an enabled
  // button. The server passes the real tier explicitly.
  const plan = planSurfaces({ clientChat: true });
  assert.equal(plan.ok, true);
});

// ---------------------------------------------------------------------------
// Display order and wire names
// ---------------------------------------------------------------------------

test('the plan keeps the table’s display order, not the selection’s', () => {
  // The submit button counts these and the modal lists them; both read left to
  // right, so the order has to be the one on screen rather than whatever order
  // the keys happened to be set in.
  const plan = planSurfaces({ team: true, clientMail: true, clientChat: true });
  assert.deepEqual(plan.surfaces.map((s) => s.key), ['clientChat', 'clientMail', 'team']);
});

test('SURFACE_KEYS are the wire names the server validates against', () => {
  assert.deepEqual(SURFACE_KEYS, ['clientChat', 'clientMail', 'team']);
  assert.equal(SURFACE_KEYS.length, OFFERED_SURFACES.length);
});

test('surfaceByKey answers with the row, or null for anything else', () => {
  assert.equal(surfaceByKey('clientMail').mode, 'mail');
  assert.equal(surfaceByKey('clientMail').audience, 'client');
  assert.equal(surfaceByKey('teamMail'), null);
  assert.equal(surfaceByKey(undefined), null);
});

// ---------------------------------------------------------------------------
// The unoffered pair: tolerate, never throw
// ---------------------------------------------------------------------------

test('keyForSurface returns null for the unoffered mail/team pair', () => {
  // The model allows a subject-lined room among the team; the picker does not
  // offer one. Display code calls this to choose an icon, so it has to hand
  // back "I don't know" rather than throw — a channel row must still render.
  assert.equal(keyForSurface('mail', 'team'), null);
});

test('keyForSurface tolerates a channel with nothing useful on it', () => {
  // A manual extra channel with no group, an older row, a half-populated
  // response: all of these reach the icon picker.
  assert.equal(keyForSurface(undefined, undefined), null);
  assert.equal(keyForSurface('chat', 'nobody'), null);
  assert.equal(keyForSurface('carrier-pigeon', 'client'), null);
});

test('keyForSurface names each offered pair', () => {
  assert.equal(keyForSurface('chat', 'client'), 'clientChat');
  assert.equal(keyForSurface('mail', 'client'), 'clientMail');
  assert.equal(keyForSurface('chat', 'team'), 'team');
});

test('isClientFacing is about the audience, never the mode', () => {
  assert.equal(isClientFacing('client'), true);
  assert.equal(isClientFacing('team'), false);
  assert.equal(isClientFacing(undefined), false);
});

// ---------------------------------------------------------------------------
// The button's label
// ---------------------------------------------------------------------------

test('describePlan is singular for one and plural for more', () => {
  assert.equal(describePlan([{ key: 'team' }]), 'Create 1 surface');
  assert.equal(describePlan([{ key: 'team' }, { key: 'clientChat' }]), 'Create 2 surfaces');
  assert.equal(
    describePlan([{ key: 'clientChat' }, { key: 'clientMail' }, { key: 'team' }]),
    'Create 3 surfaces'
  );
});

test('describePlan says a bare "Create" when there is nothing to count', () => {
  // The button is disabled in this state, so the label only has to avoid
  // reading as a promise: "Create 0 surfaces" is a sentence nobody should see.
  assert.equal(describePlan([]), 'Create');
  assert.equal(describePlan(undefined), 'Create');
  assert.equal(describePlan(null), 'Create');
});

test('describePlan and planSurfaces agree on the count', () => {
  const plan = planSurfaces({ clientChat: true, team: true });
  assert.equal(describePlan(plan.surfaces), 'Create 2 surfaces');
});
