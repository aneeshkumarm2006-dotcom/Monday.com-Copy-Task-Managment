const { test } = require('node:test');
const assert = require('node:assert');

const { cloudinary } = require('../config/cloudinary');
const {
  fileColumnAssets,
  destroyFileColumnAssets,
  droppedFileAssets,
  destroyAssets,
  publicIdFromUrl,
  boardFilePrefix,
  isBoardFileOf,
  isBoardFileId,
} = require('./fileColumnAssets');

/**
 * The files held in FILE COLUMNS — an invoice's PDF — and which of them a
 * teardown may destroy.
 *
 * No delete path used to read these cells, so deleting an invoice left its PDF
 * public at its URL. Then the fix went too far the other way: the cleanup
 * destroyed whatever `publicId` a cell named — and a cell is written by the
 * client — so an editor of any row could plant somebody else's id (another
 * workspace's invoice, an avatar, a logo), clear the cell, and have the server
 * delete that asset with the account-wide secret.
 *
 * The rule these pin: an asset is destroyed on a row's behalf ONLY when its id
 * sits under `macan/board-files/<the row's own board id>/`, the folder the
 * board-file upload writes into. Nothing is ever derived from a URL. Cells
 * arrive as a Mongoose Map from a hydrated doc and a plain object from
 * `.lean()`, and both must read the same.
 *
 * Nothing here connects anywhere: the tests that destroy swap
 * `cloudinary.uploader.destroy` for a recorder.
 */

const BOARD = '64b000000000000000000001';
const OTHER_BOARD = '64b000000000000000000002';
const PREFIX = `macan/board-files/${BOARD}/`;
const OTHER_PREFIX = `macan/board-files/${OTHER_BOARD}/`;

const PDF_COL = { _id: 'col-pdf', key: 'pdf', type: 'file' };
const AMOUNT_COL = { _id: 'col-amount', key: 'amount', type: 'number' };

const RAW_URL =
  'https://res.cloudinary.com/demo/raw/upload/v1726000000/macan/tasks/1726000000-INV-12';
const RAW_URL_EXT =
  'https://res.cloudinary.com/demo/raw/upload/v1726000000/macan/tasks/1726000000-INV-12.pdf';
const IMG_URL =
  'https://res.cloudinary.com/demo/image/upload/v1726000001/macan/tasks/1726000001-scan.png';

/** A file this app uploaded for BOARD, as the upload endpoint describes it. */
const own = (name, extra = {}) => ({
  url: `https://res.cloudinary.com/demo/raw/upload/v1726000000/${PREFIX}${name}`,
  name: `${name}.pdf`,
  mime: 'application/pdf',
  publicId: `${PREFIX}${name}`,
  ...extra,
});

const onBoard = (cell, board = BOARD) => ({ board, columnValues: { 'col-pdf': cell } });

// ---------------------------------------------------------------------------
// publicIdFromUrl — kept for one-off migrations, used by no destroy path
// ---------------------------------------------------------------------------

test('a raw URL keeps its extension; an image URL drops it', () => {
  // For raw resources the extension IS part of the public id; for images it is
  // the delivery format and destroying "x.png" would miss the asset "x".
  assert.equal(publicIdFromUrl(RAW_URL, 'application/pdf'), 'macan/tasks/1726000000-INV-12');
  assert.equal(publicIdFromUrl(RAW_URL_EXT, 'application/pdf'), 'macan/tasks/1726000000-INV-12.pdf');
  assert.equal(publicIdFromUrl(IMG_URL, 'image/png'), 'macan/tasks/1726000001-scan');
});

test('the URL\'s own resource type beats a missing mime', () => {
  assert.equal(publicIdFromUrl(IMG_URL, ''), 'macan/tasks/1726000001-scan');
});

test('transformations before the version, and a query string, are not part of the id', () => {
  const url =
    'https://res.cloudinary.com/demo/image/upload/c_fill,w_200/v1726000001/macan/tasks/a%20b.jpg?_a=xyz';
  assert.equal(publicIdFromUrl(url, 'image/jpeg'), 'macan/tasks/a b');
});

test('a URL that is not a versioned Cloudinary upload is not guessed at', () => {
  assert.equal(publicIdFromUrl('https://example.com/files/INV-12.pdf', 'application/pdf'), null);
  assert.equal(publicIdFromUrl('https://res.cloudinary.com/demo/raw/upload/macan/x.pdf', ''), null);
  assert.equal(publicIdFromUrl('', ''), null);
  assert.equal(publicIdFromUrl(null, ''), null);
});

// ---------------------------------------------------------------------------
// The prefix — what "uploaded for this board" means
// ---------------------------------------------------------------------------

test('the prefix is the board folder, and only for a real board id', () => {
  assert.equal(boardFilePrefix(BOARD), PREFIX);
  assert.equal(boardFilePrefix({ _id: BOARD }), PREFIX, 'a populated board');
  assert.equal(boardFilePrefix(BOARD.toUpperCase()), PREFIX, 'stored lower-case, as uploaded');
  for (const junk of [null, undefined, '', 'b1', '../../avatars', '*', 42]) {
    assert.equal(boardFilePrefix(junk), null, String(junk));
  }
});

test('an id is this board\'s only when it sits under this board\'s folder', () => {
  assert.ok(isBoardFileOf(`${PREFIX}ab12-INV`, BOARD));
  assert.ok(isBoardFileOf(`${PREFIX}sub/ab12-INV.pdf`, BOARD));
  assert.ok(!isBoardFileOf(`${OTHER_PREFIX}ab12-INV`, BOARD), 'another board');
  assert.ok(!isBoardFileOf('macan/avatars/victim', BOARD), 'an avatar');
  assert.ok(!isBoardFileOf('macan/tasks/1726000000-INV-12', BOARD), 'a task attachment');
  assert.ok(!isBoardFileOf(PREFIX, BOARD), 'the folder itself');
  assert.ok(!isBoardFileOf(`${PREFIX}../${OTHER_BOARD}/x`, BOARD), 'climbing out');
  assert.ok(!isBoardFileOf(`${PREFIX}/x`, BOARD), 'an empty segment');
  assert.ok(!isBoardFileOf(`${PREFIX}x`, null), 'no board, nothing is anybody\'s');
  assert.ok(isBoardFileId(`${OTHER_PREFIX}x`));
  assert.ok(!isBoardFileId('macan/board-files/not-a-board/x'));
  assert.ok(!isBoardFileId('macan/logos/boards/x'));
});

// ---------------------------------------------------------------------------
// fileColumnAssets — what a teardown takes with it
// ---------------------------------------------------------------------------

test('a stored id under the row\'s own board is returned as-is', () => {
  const a = own('ab12-INV');
  assert.deepStrictEqual(fileColumnAssets([PDF_COL], [onBoard([a])]), [
    { publicId: a.publicId, url: a.url, mime: 'application/pdf' },
  ]);
});

test('a planted id is never returned, whoever it belongs to', () => {
  /**
   * THE ATTACK. Every one of these is an id somebody could type into a file
   * cell on a board they can edit: another board's invoice, another tenant's,
   * an avatar, a logo, a vault blob, a Files-tab attachment. None is this
   * board's to destroy.
   */
  const planted = [
    `${OTHER_PREFIX}their-invoice`,
    'macan/avatars/victim',
    'macan/logos/orgs/acme',
    'macan/vault/0123456789abcdef',
    'macan/tasks/1726000000-INV-12',
    `${PREFIX}../${OTHER_BOARD}/x`,
  ].map((publicId) => ({ url: RAW_URL, mime: 'application/pdf', publicId }));
  assert.deepStrictEqual(fileColumnAssets([PDF_COL], [onBoard(planted)]), []);
});

test('an id is never derived from a URL any more', () => {
  // A URL in a cell is exactly as client-controlled as a publicId. A legacy
  // cell that holds only a URL is left alone rather than guessed at.
  const urlOnly = [
    { url: RAW_URL, name: 'INV-12.pdf', mime: 'application/pdf' },
    { url: `https://res.cloudinary.com/demo/raw/upload/v1/${PREFIX}looks-owned`, mime: 'application/pdf', publicId: '' },
  ];
  assert.deepStrictEqual(fileColumnAssets([PDF_COL], [onBoard(urlOnly)]), []);
});

test('the board comes from the task, else the caller, else nothing is destroyed', () => {
  const a = own('ab12-INV');
  const unscoped = { columnValues: { 'col-pdf': [a] } };
  // No board anywhere: fail closed.
  assert.deepStrictEqual(fileColumnAssets([PDF_COL], [unscoped]), []);
  // The caller names it (a teardown that loaded rows without `board`).
  assert.equal(fileColumnAssets([PDF_COL], [unscoped], { boardId: BOARD }).length, 1);
  // The task's own board wins over the caller's: a row on ANOTHER board does
  // not become this board's because the caller said so.
  assert.deepStrictEqual(fileColumnAssets([PDF_COL], [onBoard([a], OTHER_BOARD)], { boardId: BOARD }), []);
  // A populated board and an ObjectId-like one read the same.
  assert.equal(fileColumnAssets([PDF_COL], [{ ...unscoped, board: { _id: BOARD } }]).length, 1);
  assert.equal(fileColumnAssets([PDF_COL], [{ ...unscoped, board: { toString: () => BOARD } }]).length, 1);
});

test('a workspace teardown matches each row to its own board', () => {
  const mine = own('mine');
  const theirs = { ...own('theirs'), publicId: `${OTHER_PREFIX}theirs` };
  const out = fileColumnAssets([PDF_COL], [
    onBoard([mine], BOARD),
    onBoard([theirs], OTHER_BOARD),
    // A row on OTHER_BOARD holding an id from BOARD is still not destroyable.
    onBoard([own('crossed')], OTHER_BOARD),
  ]);
  assert.deepStrictEqual(out.map((a) => a.publicId).sort(), [mine.publicId, theirs.publicId].sort());
});

test('a Mongoose-style Map and a lean object read the same', () => {
  const cell = [own('ab12-INV')];
  const asMap = { board: BOARD, columnValues: new Map([['col-pdf', cell]]) };
  const asObject = onBoard(cell);
  assert.deepStrictEqual(
    fileColumnAssets([PDF_COL], [asMap]),
    fileColumnAssets([PDF_COL], [asObject])
  );
  assert.equal(fileColumnAssets([PDF_COL], [asMap]).length, 1);
});

test('only FILE columns are read, and ObjectId-like column ids are matched as strings', () => {
  const oid = { toString: () => 'col-pdf' };
  const tasks = [
    {
      board: BOARD,
      columnValues: {
        'col-pdf': [own('a')],
        // A number column with an object in it must not be mistaken for a file.
        'col-amount': [own('b')],
      },
    },
  ];
  const out = fileColumnAssets([{ ...PDF_COL, _id: oid }, AMOUNT_COL], tasks);
  assert.equal(out.length, 1);
  assert.equal(out[0].publicId, `${PREFIX}a`);
});

test('the same asset on two rows is listed once; junk entries are skipped', () => {
  const entry = own('p1');
  const tasks = [
    onBoard([entry, null, 'nope', {}]),
    onBoard([entry]),
    { board: BOARD, columnValues: null },
    null,
  ];
  assert.deepStrictEqual(fileColumnAssets([PDF_COL], tasks).map((a) => a.publicId), [entry.publicId]);
});

test('no file columns, no work', () => {
  assert.deepStrictEqual(fileColumnAssets([AMOUNT_COL], [{ board: BOARD, columnValues: {} }]), []);
  assert.deepStrictEqual(fileColumnAssets(null, null), []);
});

// ---------------------------------------------------------------------------
// droppedFileAssets — what a cell edit let go of
// ---------------------------------------------------------------------------

test('droppedFileAssets names only files the edit let go of, and only this board\'s', () => {
  const a = own('pa');
  const b = own('pb', { mime: 'image/png' });
  const legacy = { url: RAW_URL_EXT, name: 'old.pdf', mime: 'application/pdf', publicId: '' };
  const planted = { url: RAW_URL, mime: 'application/pdf', publicId: 'macan/avatars/victim' };
  assert.deepStrictEqual(droppedFileAssets([a, b, legacy, planted], [b], BOARD), [
    { publicId: a.publicId, url: a.url, mime: 'application/pdf' },
  ]);
  assert.deepStrictEqual(droppedFileAssets([a], [a], BOARD), []);
  assert.deepStrictEqual(droppedFileAssets(null, [a], BOARD), []);
  assert.deepStrictEqual(droppedFileAssets([a], null, BOARD).map((f) => f.publicId), [a.publicId]);
});

test('droppedFileAssets without a board lets go of nothing', () => {
  // The fail-closed default: a caller that forgets the board leaks a blob, it
  // never deletes one it cannot vouch for.
  const a = own('pa');
  assert.deepStrictEqual(droppedFileAssets([a], [], undefined), []);
  assert.deepStrictEqual(droppedFileAssets([a], [], 'not-a-board'), []);
  // …and another board's id is not this board's to drop.
  assert.deepStrictEqual(droppedFileAssets([a], [], OTHER_BOARD), []);
});

test('the plant-then-clear attack destroys nothing', () => {
  // Step 1 wrote a cell holding a victim's id; step 2 clears it. The edit
  // "dropped" the victim — and must not name it for destruction.
  const planted = [
    { url: 'https://evil.example.com/x', mime: 'image/webp', publicId: 'macan/avatars/victim' },
    { url: RAW_URL, mime: 'application/pdf', publicId: `${OTHER_PREFIX}their-invoice` },
  ];
  assert.deepStrictEqual(droppedFileAssets(planted, [], BOARD), []);
});

test('droppedFileAssets keeps a file the next cell still holds at the same URL', () => {
  // A client that echoes the cell back without `publicId` is sending the SAME
  // file. Matching on the id alone read it as dropped and destroyed a PDF the
  // cell still linked to.
  const a = own('pa');
  const b = own('pb', { mime: 'image/png' });
  const echoed = [{ url: a.url, name: 'a.pdf' }, { url: b.url, name: 'b.png', publicId: '' }];
  assert.deepStrictEqual(droppedFileAssets([a, b], echoed, BOARD), []);

  // Whitespace around the URL is not a different file either.
  assert.deepStrictEqual(droppedFileAssets([a], [{ url: ` ${a.url} ` }], BOARD), []);

  // Same id at a different URL (a re-derived delivery address) is still kept.
  assert.deepStrictEqual(droppedFileAssets([a], [{ url: `${a.url}.pdf`, publicId: a.publicId }], BOARD), []);

  // A different URL AND a different id is a replacement: the old one goes.
  assert.deepStrictEqual(
    droppedFileAssets([a], [own('pz')], BOARD).map((f) => f.publicId),
    [a.publicId]
  );
});

// ---------------------------------------------------------------------------
// Destroying
// ---------------------------------------------------------------------------

const recordDestroys = async (fn) => {
  const calls = [];
  const original = cloudinary.uploader.destroy;
  cloudinary.uploader.destroy = async (publicId, opts) => {
    calls.push({ publicId, resourceType: opts && opts.resource_type });
    if (/boom$/.test(publicId)) throw new Error('cloudinary down');
    return { result: 'ok' };
  };
  try {
    const result = await fn();
    return { calls, result };
  } finally {
    cloudinary.uploader.destroy = original;
  }
};

test('destroyFileColumnAssets destroys under the right resource type and never throws', async () => {
  const imageUrl = `https://res.cloudinary.com/demo/image/upload/v1726000001/${PREFIX}scan.png`;
  const { calls, result } = await recordDestroys(() => destroyFileColumnAssets([PDF_COL], [
    {
      board: BOARD,
      columnValues: new Map([
        [
          'col-pdf',
          [
            own('INV-12'),
            // No mime stored: the URL says image, so it must not be sent as raw.
            { url: imageUrl, mime: '', publicId: `${PREFIX}scan` },
            own('boom'),
            // Planted: never reaches Cloudinary at all.
            { url: RAW_URL, mime: 'application/pdf', publicId: 'macan/avatars/victim' },
          ],
        ],
      ]),
    },
  ]));
  assert.equal(result, 3);
  const byId = Object.fromEntries(calls.map((c) => [c.publicId, c.resourceType]));
  assert.equal(byId[`${PREFIX}INV-12`], 'raw');
  assert.equal(byId[`${PREFIX}scan`], 'image');
  assert.equal(byId[`${PREFIX}boom`], 'raw');
  assert.equal(byId['macan/avatars/victim'], undefined, 'the planted id was destroyed');
});

test('destroyAssets refuses anything outside the board-files folder, whatever the caller built', async () => {
  // The floor for callers that assemble their own list: no path through this
  // module can reach an avatar, a logo, a vault blob or a task attachment.
  const { calls, result } = await recordDestroys(() => destroyAssets([
    { publicId: `${PREFIX}ok`, mime: 'application/pdf' },
    { publicId: 'macan/avatars/victim', mime: 'image/webp' },
    { publicId: 'macan/tasks/1-INV', mime: 'application/pdf' },
    { publicId: 'macan/board-files/nope/x', mime: 'application/pdf' },
    { publicId: `${PREFIX}../../avatars/victim`, mime: 'image/webp' },
    null,
  ]));
  assert.equal(result, 1);
  assert.deepStrictEqual(calls.map((c) => c.publicId), [`${PREFIX}ok`]);
});

test('destroyFileColumnAssets with nothing to destroy makes no call', async () => {
  const { calls } = await recordDestroys(async () => {
    assert.equal(await destroyFileColumnAssets([PDF_COL], [{ board: BOARD, columnValues: {} }]), 0);
    assert.equal(await destroyFileColumnAssets(undefined, undefined), 0);
    // A board the caller cannot name: nothing, rather than a guess.
    assert.equal(await destroyFileColumnAssets([PDF_COL], [{ columnValues: { 'col-pdf': [own('x')] } }]), 0);
  });
  assert.equal(calls.length, 0);
});
