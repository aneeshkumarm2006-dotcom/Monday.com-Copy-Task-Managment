const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { ensurePortalLive, boardHasServices } = require('./portalActivation');

/**
 * WHEN A CLIENT PORTAL BECOMES REACHABLE — the rule, and the two ways it breaks.
 *
 * A client board is created with no `portalToken` and the portal off, because a
 * portal with no services renders "Your portal is being set up" and a link to
 * one is worse than no link. The FIRST SERVICE brings it to life.
 *
 * Two halves here, both deliberate:
 *
 *   1. `ensurePortalLive` is idempotent AND MUST NOT ROTATE. Minting a second
 *      token on a board that already has one invalidates the client's link and
 *      kills every signed-in contact's session — the single worst thing this
 *      function can do, and it is one `if` away at all times.
 *
 *   2. SOURCE PROBES on the callers. Two orderings matter and neither is
 *      visible at the call site: activation must come AFTER the group exists
 *      (or a failed create leaves a live link with nothing behind it) and
 *      BEFORE `createSurfaces` (which refuses the whole plan — team room
 *      included — on a board whose portal is not yet on, and refuses it
 *      quietly, into a return value nobody reads).
 *
 * No mongoose here on purpose: the module imports no models, which is what lets
 * this run under `node --test` with no database.
 */

/** A Board stand-in that records whether it was written. */
const fakeBoard = (fields = {}) => {
  const board = { saves: 0, ...fields };
  board.save = async () => {
    board.saves += 1;
  };
  return board;
};

// ---------------------------------------------------------------------------
// ensurePortalLive
// ---------------------------------------------------------------------------

test('a board with neither token nor enabled gets both, and reports the change', async () => {
  const board = fakeBoard();
  const res = await ensurePortalLive(board);

  assert.strictEqual(typeof board.portalToken, 'string');
  assert.ok(board.portalToken.length >= 32, `token too short: ${board.portalToken}`);
  assert.strictEqual(board.portalEnabled, true);
  assert.deepStrictEqual(res, { minted: true, enabled: true, changed: true, live: true });
  assert.strictEqual(board.saves, 1);
});

test('IT NEVER ROTATES AN EXISTING TOKEN — the whole point of the projection rule', async () => {
  const board = fakeBoard({ portalToken: 'a-live-client-link', portalEnabled: true });
  const res = await ensurePortalLive(board);

  assert.strictEqual(
    board.portalToken,
    'a-live-client-link',
    'rotating here would invalidate the client link and kill every live session'
  );
  assert.deepStrictEqual(res, { minted: false, enabled: false, changed: false, live: true });
  assert.strictEqual(board.saves, 0, 'nothing changed, so nothing may be written');
});

test('IT NEVER REVERSES THE KILL SWITCH: a board with a token that was switched off STAYS off', async () => {
  const board = fakeBoard({ portalToken: 'keep-me', portalEnabled: false });
  const res = await ensurePortalLive(board);

  assert.strictEqual(board.portalToken, 'keep-me');
  assert.strictEqual(
    board.portalEnabled,
    false,
    'somebody pressed "Disable link"; adding a service must not undo that, or the ' +
      'offboarded client\'s original link and every JWT issued against that ptk start ' +
      'working again'
  );
  assert.deepStrictEqual(res, { minted: false, enabled: false, changed: false, live: false });
  assert.strictEqual(board.saves, 0, 'nothing may be written on a deliberately-off board');
});

test('a board with a token and portalEnabled undefined is left alone too — a token means it has been live before', async () => {
  const board = fakeBoard({ portalToken: 'tok' });
  const res = await ensurePortalLive(board);
  assert.strictEqual(res.minted, false);
  assert.strictEqual(res.changed, false);
  assert.strictEqual(res.live, false);
  assert.strictEqual(board.saves, 0);
});

test('`changed` is true exactly once: the second call over the same board reports nothing', async () => {
  const board = fakeBoard();
  const first = await ensurePortalLive(board);
  const token = board.portalToken;
  const second = await ensurePortalLive(board);

  assert.strictEqual(first.changed, true);
  assert.strictEqual(second.changed, false);
  assert.strictEqual(second.live, true);
  assert.strictEqual(board.portalToken, token, 'the second service must not re-mint');
  assert.strictEqual(board.saves, 1);
});

test('`live` is what callers must pass to createSurfaces, and it tracks the flag, not the write', async () => {
  assert.strictEqual((await ensurePortalLive(fakeBoard())).live, true);
  assert.strictEqual(
    (await ensurePortalLive(fakeBoard({ portalToken: 't', portalEnabled: false }))).live,
    false,
    'a caller that asked for client rooms here would have its WHOLE plan refused, ' +
      'team room included'
  );
});

test('two boards do not share a token', async () => {
  const a = fakeBoard();
  const b = fakeBoard();
  await ensurePortalLive(a);
  await ensurePortalLive(b);
  assert.notStrictEqual(a.portalToken, b.portalToken);
});

// ---------------------------------------------------------------------------
// boardHasServices
// ---------------------------------------------------------------------------

/** A `TaskGroup` stand-in whose `countDocuments` is chainable, as mongoose's is. */
const fakeModel = (count, sink = {}) => ({
  countDocuments(filter) {
    sink.filter = filter;
    return {
      limit(n) {
        sink.limit = n;
        return Promise.resolve(count);
      },
    };
  },
});

test('boardHasServices is false on an empty board and true on one with a service', async () => {
  assert.strictEqual(await boardHasServices(fakeModel(0), 'b1'), false);
  assert.strictEqual(await boardHasServices(fakeModel(1), 'b1'), true);
  assert.strictEqual(await boardHasServices(fakeModel(7), 'b1'), true);
});

test('boardHasServices scopes to the board and stops at one — it is a existence check, not a census', async () => {
  const sink = {};
  await boardHasServices(fakeModel(3, sink), 'board-42');
  assert.deepStrictEqual(sink.filter, { board: 'board-42' });
  assert.strictEqual(sink.limit, 1);
});

// ---------------------------------------------------------------------------
// SOURCE PROBES — the orderings no unit test can reach
// ---------------------------------------------------------------------------

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

/**
 * The same file with every line comment and block comment removed.
 *
 * Needed because these probes assert on the ABSENCE of things, and the comments
 * that explain why they are absent name them. A probe that a prose sentence can
 * fail is a probe that gets deleted the first time it cries wolf.
 */
const readCode = (rel) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

test('createGroup activates the portal BEFORE createSurfaces, or the first service loses all three rooms', () => {
  const src = readCode('controllers/groupController.js');
  const activate = src.indexOf('ensurePortalLive(');
  const surfaces = src.indexOf('createSurfaces(');
  assert.ok(activate > 0, 'createGroup no longer activates the portal at all');
  assert.ok(surfaces > 0, 'createGroup no longer creates surfaces');
  assert.ok(
    activate < surfaces,
    'createSurfaces gates client rooms on isLiveClientBoard, which is false until ' +
      'the portal is on — and chatSurfaces refuses the WHOLE plan, team room included'
  );
});

test('createGroup creates the group BEFORE activating, so a failed create cannot leave a live empty portal', () => {
  const src = readCode('controllers/groupController.js');
  const create = src.indexOf('await TaskGroup.create(');
  const activate = src.indexOf('ensurePortalLive(');
  assert.ok(create > 0 && activate > 0);
  assert.ok(create < activate, 'the link must not exist before the service does');
});

test('createGroup loads the board WITH +portalToken, or activation rotates a live link', () => {
  const src = readCode('controllers/groupController.js');
  assert.match(
    src,
    /loadBoardContext\(boardId, userId, \{ select: '\+portalToken' \}\)/,
    'without the projection `!board.portalToken` is true on a board that has one'
  );
});

test('the batch invite also activates before its surfaces, and after its groups', () => {
  const src = readCode('services/portalBatchInvite.js');
  const activate = src.indexOf('await ensurePortalLive(board);');
  const groups = src.indexOf('resolveOrCreateService({');
  const surfaces = src.indexOf('ensureSurfacesFor(');
  assert.ok(activate > 0 && groups > 0 && surfaces > 0);
  assert.ok(groups < activate, 'services first');
  assert.ok(activate < surfaces, 'then the portal, then the rooms');
});

test('BOARD CREATION MINTS NOTHING — the regression this whole change exists to prevent', () => {
  const src = readCode('controllers/boardController.js');
  assert.ok(
    !src.includes('generatePortalToken'),
    'createBoard must not mint a portal token: a board with no services has ' +
      'nothing behind its link'
  );
  assert.ok(
    !src.includes('inviteContact'),
    'createBoard must not email a client: there is nothing for them to look at yet'
  );
  assert.ok(
    !/portalEnabled:\s*true/.test(src),
    'createBoard must not switch the portal on'
  );
});

test('neither auto-create path asks for client rooms unconditionally', () => {
  // `planSurfaces` refuses the WHOLE selection when a client-facing room is
  // requested on a board that is not live, so a hardcoded `clientChat: true`
  // costs the new service its private team room as well.
  for (const rel of ['controllers/groupController.js', 'services/portalBatchInvite.js']) {
    const src = readCode(rel);
    assert.ok(
      !/clientChat:\s*true,\s*clientMail:\s*true/.test(src),
      `${rel} must gate the client surfaces on whether the portal is actually live`
    );
  }
});

test('BOTH invite flows refuse a switched-off portal through the same helper', () => {
  const src = readCode('services/portalBatchInvite.js');
  assert.strictEqual(
    (src.match(/const refusalIfPortalDisabled = /g) || []).length,
    1,
    'one definition of the refusal'
  );
  assert.strictEqual(
    (src.match(/refusalIfPortalDisabled\(board\)/g) || []).length,
    2,
    'both inviteServiceContacts and createServiceWithInvites must call it'
  );
  // Before the first write, or a 409 would leave a service behind.
  const guard = src.indexOf('refusalIfPortalDisabled(board)');
  const firstWrite = src.indexOf('resolveOrCreateService({');
  assert.ok(guard < firstWrite, 'the refusal must precede every write');
});

test('ensurePortalLive is defined in exactly one place', () => {
  const here = read('utils/portalActivation.js');
  assert.match(here, /const ensurePortalLive = async \(board\) => \{/);

  for (const rel of ['services/portalBatchInvite.js', 'controllers/groupController.js']) {
    const src = readCode(rel);
    assert.ok(
      !/const ensurePortalLive\s*=/.test(src),
      `${rel} must import the rule, not restate it`
    );
    assert.match(
      src,
      /require\('\.\.\/utils\/portalActivation'\)/,
      `${rel} must import from utils/portalActivation`
    );
  }
});
