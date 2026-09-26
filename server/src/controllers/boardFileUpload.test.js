const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

/**
 * WHO MAY PUT BYTES IN THE ACCOUNT.
 *
 * `POST /api/boards/:id/files` is the only endpoint on a board that writes to
 * storage without writing to any document — it exists so an invoice PDF can
 * land BEFORE the row that will hold it. That makes it the easiest one to leave
 * open by accident: nothing in the database changes, so a missing check has no
 * visible symptom until somebody's Cloudinary bill does.
 *
 * And the check has to run BEFORE the storage middleware, not merely somewhere.
 * multer-storage-cloudinary uploads while it parses; a refusal issued after it
 * is a refusal of a file that is already stored. The last group of tests here
 * drives the real router and asserts a refused request never reaches storage.
 *
 * The stubs are installed on the shared exports objects BEFORE anything is
 * required, because the controllers destructure their helpers at require time
 * and would otherwise capture the real ones.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'board-file-upload-test';

const boardContext = require('../utils/boardContext');
const cloudinaryConfig = require('../config/cloudinary');

let contextResult = null;
let contextThrows = null;
let contextCalls = 0;
let capabilityAsked = null;
let capabilityResult = null;
let destroyed = [];
let storageReached = 0;

// A STABLE function that reads mutable state, rather than a stub swapped per
// test: the controller destructures its helpers at require time, so reassigning
// this property later would have no effect and every test would silently
// exercise the same happy path.
boardContext.loadBoardContext = async () => {
  contextCalls += 1;
  if (contextThrows) throw contextThrows;
  return contextResult;
};
boardContext.requireCapability = (ctx, capability) => {
  capabilityAsked = capability;
  return capabilityResult;
};
cloudinaryConfig.destroyCloudinaryAssets = async (list) => {
  destroyed.push(...list);
};

const A_FILE = {
  path: 'https://res.cloudinary.com/x/raw/upload/v1/macan/board-files/64b000000000000000000001/ab12cd34ef56ab78-INV-2026-015_Kredoo',
  originalname: 'INV-2026-015 Kredoo.pdf',
  mimetype: 'application/pdf',
  size: 48210,
  filename: 'macan/board-files/64b000000000000000000001/ab12cd34ef56ab78-INV-2026-015_Kredoo',
};

// Captured BEFORE the stub below replaces it, so the real multer instance (and
// the filter wired into it) can still be exercised.
const realBoardFileUpload = cloudinaryConfig.boardFileUpload;

// The storage middleware, as the router sees it. Records that it ran, and
// "stores" the file the way multer would — by putting it on `req.file`.
cloudinaryConfig.boardFileUpload = {
  single: () => (req, res, next) => {
    storageReached += 1;
    req.file = { ...A_FILE };
    next();
  },
};

// Required AFTER the stubs are in place.
const { authorizeBoardFile, uploadBoardFile } = require('./boardFileController');

const BOARD = '64b000000000000000000001';

const mockRes = () => {
  const res = { statusCode: null, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    return res;
  };
  return res;
};

const req = (file, extra = {}) => ({ params: { id: BOARD }, user: { userId: 'u1' }, file, ...extra });

const reset = () => {
  contextResult = { board: { _id: BOARD } };
  contextThrows = null;
  contextCalls = 0;
  capabilityAsked = null;
  capabilityResult = null;
  destroyed = [];
  storageReached = 0;
};

/** Run the gate; resolve with what it did. */
const runGate = async (request) => {
  const res = mockRes();
  let nextCalled = false;
  await authorizeBoardFile(request, res, () => { nextCalled = true; });
  return { res, nextCalled };
};

// ---------------------------------------------------------------------------
// The gate — authorizeBoardFile
// ---------------------------------------------------------------------------

test('the gate refuses an unreadable board with its own status, and stops there', async () => {
  reset();
  contextResult = { status: 404, error: 'Board not found' };
  const { res, nextCalled } = await runGate(req());
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, 'Board not found');
  assert.equal(nextCalled, false, 'a refusal must not hand on to the storage middleware');
});

test('the gate refuses a viewer who cannot add rows', async () => {
  // The gate that matters. Read access to a board must not imply write access
  // to the account's storage.
  reset();
  capabilityResult = { status: 403, error: 'nope' };
  const { res, nextCalled } = await runGate(req());
  assert.equal(res.statusCode, 403);
  assert.equal(nextCalled, false);
});

test('the capability asked for is task.create', async () => {
  // Not a bespoke upload permission: the next call this enables is creating a
  // row, so it answers to the same authority. Naming it here means widening it
  // later has to be deliberate.
  reset();
  await runGate(req());
  assert.equal(capabilityAsked, 'task.create');
});

test('a malformed board id is a 400 before any lookup', async () => {
  // Handed to findById, it would throw a CastError and surface as a 500.
  reset();
  const { res, nextCalled } = await runGate({ params: { id: 'b1' }, user: { userId: 'u1' } });
  assert.equal(res.statusCode, 400);
  assert.equal(nextCalled, false);
  assert.equal(contextCalls, 0);
});

test('a permitted caller passes through, with the context handed on', async () => {
  reset();
  const request = req();
  const { nextCalled } = await runGate(request);
  assert.equal(nextCalled, true);
  assert.deepEqual(request.boardCtx, contextResult, 'the handler must not have to load the board again');
});

test('a failing lookup in the gate is a 500 that says nothing about internals', async () => {
  reset();
  contextThrows = new Error('mongo is on fire at 10.0.0.4');
  const { res, nextCalled } = await runGate(req());
  assert.equal(res.statusCode, 500);
  assert.equal(nextCalled, false);
  assert.ok(!/mongo|10\.0\.0\.4/.test(JSON.stringify(res.body)), 'no internals in the reply');
});

// ---------------------------------------------------------------------------
// The handler — uploadBoardFile
// ---------------------------------------------------------------------------

test('a permitted upload returns the descriptor a file column stores', async () => {
  reset();
  const res = mockRes();
  await uploadBoardFile(req(A_FILE, { boardCtx: contextResult }), res);
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.body.file, {
    url: A_FILE.path,
    name: 'INV-2026-015 Kredoo.pdf',
    mime: 'application/pdf',
    size: 48210,
    publicId: A_FILE.filename,
  });
  assert.equal(contextCalls, 0, 'the gate already loaded the board');
});

test('a request with no file is a 400, not a 201 with nulls', async () => {
  // Multer leaves `req.file` undefined when the field is missing. Returning 201
  // here would create a row carrying a file descriptor pointing at nothing.
  reset();
  const res = mockRes();
  await uploadBoardFile(req(undefined, { boardCtx: contextResult }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.file, undefined);
});

test('a file missing its optional metadata still yields a usable descriptor', async () => {
  // Cloudinary storage has occasionally omitted `size`. A descriptor with
  // `size: undefined` fails the file column's own validation, which would
  // reject the write with a message about a column the person never touched.
  reset();
  const res = mockRes();
  await uploadBoardFile(req({ path: 'https://x/y.pdf' }, { boardCtx: contextResult }), res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.file.name, 'file');
  assert.equal(res.body.file.size, 0);
  assert.equal(res.body.file.mime, 'application/octet-stream');
  assert.equal(res.body.file.publicId, null);
});

test('mounted without the gate, the handler still refuses — and deletes what was stored', async () => {
  /**
   * The belt to the gate's braces. If a future route forgets the gate, the
   * handler authorises anyway; by then the bytes ARE stored, so a refusal has
   * to destroy them or it is the original leak again.
   */
  reset();
  capabilityResult = { status: 403, error: 'nope' };
  const res = mockRes();
  await uploadBoardFile(req(A_FILE), res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.file, undefined);
  assert.deepEqual(destroyed, [{ publicId: A_FILE.filename, mime: A_FILE.mimetype }]);
});

test('an unexpected failure is a 500, and the stored file is discarded', async () => {
  reset();
  contextThrows = new Error('mongo is on fire at 10.0.0.4');
  const res = mockRes();
  await uploadBoardFile(req(A_FILE), res);
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, 'Failed to upload the file');
  assert.ok(!/mongo|10\.0\.0\.4/.test(JSON.stringify(res.body)), 'no internals in the reply');
  assert.equal(destroyed.length, 1);
});

// ---------------------------------------------------------------------------
// The real route — the ORDER is the fix
// ---------------------------------------------------------------------------

const withBoardsRouter = async (fn) => {
  const express = require('express');
  const jwt = require('jsonwebtoken');
  const router = require('../routes/boards');
  const app = express();
  app.use(express.json());
  app.use('/api/boards', router);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const token = jwt.sign({ userId: '64b0000000000000000000aa' }, process.env.JWT_SECRET);
  const post = async () => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/boards/${BOARD}/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  try {
    await fn(post);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

test('through the real router, a refused upload never reaches storage', async () => {
  await withBoardsRouter(async (post) => {
    reset();
    capabilityResult = { status: 403, error: 'nope' };
    const denied = await post();
    assert.equal(denied.status, 403);
    assert.equal(storageReached, 0, 'the file was stored before the refusal');

    reset();
    contextResult = { status: 403, error: 'Not a member of this workspace' };
    const outsider = await post();
    assert.equal(outsider.status, 403);
    assert.equal(storageReached, 0, 'an outsider reached the storage middleware');

    reset();
    const allowed = await post();
    assert.equal(allowed.status, 201);
    assert.equal(storageReached, 1);
    assert.equal(contextCalls, 1, 'the board is loaded once, by the gate');
    assert.equal(allowed.body.file.publicId, A_FILE.filename);
  });
});

// ---------------------------------------------------------------------------
// WHERE the bytes go — one folder per board
// ---------------------------------------------------------------------------

test('a board file is stored under its own board folder, with an unguessable id', () => {
  /**
   * The folder is what the file-column cleanup keys on: it only ever destroys
   * ids under `macan/board-files/<the row's board>/`. Files used to land in the
   * shared `macan/tasks` folder, where "this board's file" could not be told
   * from anybody else's.
   */
  const { boardFileParams } = cloudinaryConfig;
  const file = { originalname: 'INV-2026-015 Kredoo (final).pdf', mimetype: 'application/pdf' };
  const a = boardFileParams({ params: { id: BOARD } }, file);
  const b = boardFileParams({ params: { id: BOARD } }, file);
  assert.equal(a.folder, `macan/board-files/${BOARD}`);
  assert.equal(a.resource_type, 'raw');
  assert.match(a.public_id, /^[0-9a-f]{16}-INV-2026-015_Kredoo__final_$/);
  assert.notEqual(a.public_id, b.public_id, 'two uploads of one file must not collide or be guessable');

  const img = boardFileParams({ params: { id: BOARD } }, { originalname: 'scan.png', mimetype: 'image/png' });
  assert.equal(img.resource_type, 'image');
  // A long name is clipped, not stored whole in every URL.
  const long = boardFileParams({ params: { id: BOARD } }, { originalname: `${'x'.repeat(300)}.pdf`, mimetype: 'application/pdf' });
  assert.ok(long.public_id.length <= 16 + 1 + 60);
});

test('no valid board id, no upload — never a folder called "undefined"', () => {
  const { boardFileParams } = cloudinaryConfig;
  for (const id of [undefined, '', 'b1', '../avatars', '64b00000000000000000000z']) {
    assert.throws(
      () => boardFileParams({ params: { id } }, { originalname: 'a.pdf', mimetype: 'application/pdf' }),
      (err) => err.code === 'BOARD_FILE_NO_BOARD',
      String(id)
    );
  }
});

// ---------------------------------------------------------------------------
// WHAT may be stored — the MIME allowlist
// ---------------------------------------------------------------------------

test('PDFs, images and office documents are accepted', () => {
  const { isAllowedBoardFile } = cloudinaryConfig;
  for (const [mimetype, originalname] of [
    ['application/pdf', 'INV.pdf'],
    ['image/png', 'scan.png'],
    ['image/jpeg', 'receipt.jpg'],
    ['image/heic', 'IMG_0001.HEIC'],
    ['application/msword', 'cv.doc'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'cv.docx'],
    ['application/vnd.ms-excel', 'ledger.xls'],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'ledger.xlsx'],
    ['application/vnd.ms-powerpoint', 'deck.ppt'],
    ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'deck.pptx'],
    ['text/csv', 'export.csv'],
    ['text/plain', 'notes.txt'],
    ['Application/PDF; charset=binary', 'INV.pdf'],
  ]) {
    assert.ok(isAllowedBoardFile({ mimetype, originalname }), `${mimetype} should be accepted`);
  }
});

test('anything else is refused', () => {
  const { isAllowedBoardFile } = cloudinaryConfig;
  for (const [mimetype, originalname] of [
    ['application/zip', 'invoices.zip'],
    ['application/x-msdownload', 'setup.exe'],
    ['text/html', 'page.html'],
    ['application/javascript', 'x.js'],
    ['video/mp4', 'call.mp4'],
    ['application/x-sh', 'run.sh'],
    // A PDF-looking name does not launder a declared type we refuse.
    ['application/zip', 'INV.pdf'],
  ]) {
    assert.ok(!isAllowedBoardFile({ mimetype, originalname }), `${mimetype} (${originalname}) should be refused`);
  }
});

test('a type the browser could not name is judged by its extension', () => {
  // Windows sends octet-stream (or nothing) for a CSV with no associated app.
  // Refusing that would refuse an ordinary spreadsheet; accepting every
  // octet-stream would make the allowlist a formality.
  const { isAllowedBoardFile } = cloudinaryConfig;
  assert.ok(isAllowedBoardFile({ mimetype: 'application/octet-stream', originalname: 'export.CSV' }));
  assert.ok(isAllowedBoardFile({ mimetype: '', originalname: 'INV.pdf' }));
  assert.ok(!isAllowedBoardFile({ mimetype: 'application/octet-stream', originalname: 'tool.exe' }));
  assert.ok(!isAllowedBoardFile({ mimetype: 'application/octet-stream', originalname: 'no-extension' }));
  assert.ok(!isAllowedBoardFile({}));
});

test('the filter refuses with a code the upload handler turns into a 415 that says why', () => {
  const { boardFileFilter, handleUploadError } = cloudinaryConfig;
  let verdict = null;
  boardFileFilter({}, { mimetype: 'application/zip', originalname: 'x.zip' }, (err, ok) => { verdict = { err, ok }; });
  assert.equal(verdict.err.code, 'BOARD_FILE_BAD_TYPE');
  boardFileFilter({}, { mimetype: 'application/pdf', originalname: 'x.pdf' }, (err, ok) => { verdict = { err, ok }; });
  assert.equal(verdict.err, null);
  assert.equal(verdict.ok, true);

  const res = mockRes();
  const err = new Error('That kind of file can\u2019t be added here.');
  err.code = 'BOARD_FILE_BAD_TYPE';
  handleUploadError(err, {}, res, () => {});
  assert.equal(res.statusCode, 415);
  assert.equal(res.body.code, 'BOARD_FILE_BAD_TYPE');
  assert.match(res.body.error, /can.t be added here/);
});

test('through the REAL multer instance, a refused type never reaches storage', async () => {
  /**
   * The filter is only a fix if it is wired into the multer instance the route
   * uses — multer runs it BEFORE the storage engine, so a refused file never
   * starts a Cloudinary upload. Driven through a live request with the real
   * `boardFileUpload`; a refused type is the only case safe to send, since an
   * accepted one would really upload.
   */
  const express = require('express');
  const { handleUploadError } = cloudinaryConfig;
  const app = express();
  let handlerReached = false;
  app.post(
    '/api/boards/:id/files',
    realBoardFileUpload.single('file'),
    handleUploadError,
    (req, res) => { handlerReached = true; res.status(201).json({ ok: true }); }
  );
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const form = new FormData();
    form.append('file', new Blob([Buffer.from('PK\u0003\u0004 not an invoice')], { type: 'application/zip' }), 'invoices.zip');
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/boards/${BOARD}/files`, {
      method: 'POST',
      body: form,
    });
    const body = await r.json();
    assert.equal(r.status, 415);
    assert.equal(body.code, 'BOARD_FILE_BAD_TYPE');
    assert.equal(handlerReached, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
