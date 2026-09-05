const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { isClientBoard, isLiveClientBoard } = require('./clientBoard');

/**
 * The client-board predicates, and the proof that the TIER IS ACTUALLY GONE.
 *
 * This file replaces `clientTierUpgrade.test.js`, which tested the one-way
 * upgrade machinery that no longer exists. Two halves, both deliberate:
 *
 *   1. `isLiveClientBoard` is the ONE predicate every gate calls, and with the
 *      tier removed it is now the ONLY thing standing between a disabled portal
 *      and an open client room. It has to fail CLOSED for every shape a board
 *      can arrive in, including the shape a `.select()` that forgot
 *      `portalEnabled` produces — which is the realistic way this breaks.
 *
 *   2. SOURCE PROBES. A deleted concept comes back by being re-added somewhere
 *      nobody is looking, and every gate that used to read the tier failed OPEN
 *      when it read `undefined`. These assertions are the tripwire, and they
 *      are the reason this file reads the filesystem at all.
 */

test('isClientBoard is true only for boardType "client"', () => {
  assert.strictEqual(isClientBoard({ boardType: 'client' }), true);
  for (const board of [undefined, null, {}, { boardType: 'standard' }, { boardType: 'tracker' }]) {
    assert.strictEqual(isClientBoard(board), false, `expected false for ${JSON.stringify(board)}`);
  }
});

test('isLiveClientBoard fails CLOSED for everything it does not recognise', () => {
  const cases = [
    [undefined, 'undefined'],
    [null, 'null'],
    [{}, 'an empty object'],
    [{ boardType: 'standard', portalEnabled: true }, 'a standard board with the flag on'],
    [{ boardType: 'tracker', portalEnabled: true }, 'a tracker board with the flag on'],
    [{ boardType: 'client' }, 'a client board loaded WITHOUT portalEnabled selected'],
    [{ boardType: 'client', portalEnabled: false }, 'a client board with the portal disabled'],
    // Truthy-but-not-true: the predicate uses === true precisely so a stray
    // string from a query param or a raw driver read cannot open a room.
    [{ boardType: 'client', portalEnabled: 'true' }, 'portalEnabled as a string'],
    [{ boardType: 'client', portalEnabled: 1 }, 'portalEnabled as a number'],
  ];
  for (const [board, label] of cases) {
    assert.strictEqual(isLiveClientBoard(board), false, `expected false for ${label}`);
  }
});

test('isLiveClientBoard is true only for a client board with the portal live', () => {
  assert.strictEqual(isLiveClientBoard({ boardType: 'client', portalEnabled: true }), true);
});

test('the portal tier is gone from the source, not merely unused', () => {
  const src = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  assert.ok(
    !fs.existsSync(path.join(__dirname, 'clientTierUpgrade.js')),
    'utils/clientTierUpgrade.js should have been deleted with the tier'
  );

  assert.ok(
    !/portalTier|PORTAL_TIERS/.test(src('models/Board.js').replace(/\/\*[\s\S]*?\*\//g, '')),
    'models/Board.js still declares portalTier outside a comment'
  );

  assert.ok(
    !/isAdvancedClientBoard/.test(src('utils/clientBoard.js').replace(/\/\*[\s\S]*?\*\//g, '')),
    'isAdvancedClientBoard should survive only in the docblock explaining its removal'
  );

  // `requireChat` asserted the tier and nothing else, so a repointed version
  // would be a guard that can never fail — see the note in its place.
  assert.ok(
    !/requireChat/.test(src('controllers/portalChatController.js').replace(/\/\*[\s\S]*?\*\//g, '')),
    'portalChatController.js still calls requireChat outside a comment'
  );
});

test('chatAudience gates client contacts on isLiveClientBoard', () => {
  // A source probe rather than a DB test: the failure this catches is somebody
  // dropping the gate entirely while removing the tier, and that is visible in
  // the text. The behavioural proof lives in e2e/clientPortalV2.e2e.js.
  const src = fs.readFileSync(path.join(__dirname, '..', 'services/chatAudience.js'), 'utf8');
  assert.match(src, /if \(!isLiveClientBoard\(board\)\) \{\s*return \{ userIds, contactIds: \[\] \};/);
});
