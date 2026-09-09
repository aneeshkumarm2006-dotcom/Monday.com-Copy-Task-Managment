const { test } = require('node:test');
const assert = require('node:assert');

/**
 * WHO MAY PUT BYTES IN THE ACCOUNT.
 *
 * `POST /api/boards/:id/files` is the only endpoint on a board that writes to
 * storage without writing to any document — it exists so an invoice PDF can
 * land BEFORE the row that will hold it. That makes it the easiest one to leave
 * open by accident: nothing in the database changes, so a missing check has no
 * visible symptom until somebody's Cloudinary bill does.
 *
 * The stubs are installed on the boardContext exports object BEFORE the
 * controller is required, because the controller destructures its helpers at
 * require time and would otherwise capture the real ones.
 */

const boardContext = require('../utils/boardContext');

let contextResult = null;
let contextThrows = null;
let capabilityAsked = null;
let capabilityResult = null;

// A STABLE function that reads mutable state, rather than a stub swapped per
// test: the controller destructures its helpers at require time, so reassigning
// this property later would have no effect and every test would silently
// exercise the same happy path.
boardContext.loadBoardContext = async () => {
  if (contextThrows) throw contextThrows;
  return contextResult;
};
boardContext.requireCapability = (ctx, capability) => {
  capabilityAsked = capability;
  return capabilityResult;
};

// Required AFTER the stubs are in place.
const { uploadBoardFile } = require('./boardFileController');

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

const req = (file) => ({ params: { id: 'b1' }, user: { userId: 'u1' }, file });

const A_FILE = {
  path: 'https://res.cloudinary.com/x/raw/upload/v1/macan/tasks/123-INV.pdf',
  originalname: 'INV-2026-015 Kredoo.pdf',
  mimetype: 'application/pdf',
  size: 48210,
  filename: 'macan/tasks/123-INV',
};

const reset = () => {
  contextResult = { board: { _id: 'b1' } };
  contextThrows = null;
  capabilityAsked = null;
  capabilityResult = null;
};

test('an unreadable board is refused with its own status', async () => {
  reset();
  contextResult = { status: 404, error: 'Board not found' };
  const res = mockRes();
  await uploadBoardFile(req(A_FILE), res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, 'Board not found');
  assert.equal(res.body.file, undefined, 'a refusal must not hand back a file');
});

test('a viewer who cannot add rows cannot upload', async () => {
  // The gate that matters. Read access to a board must not imply write access
  // to the account's storage.
  reset();
  capabilityResult = { status: 403, error: 'nope' };
  const res = mockRes();
  await uploadBoardFile(req(A_FILE), res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.file, undefined);
});

test('the capability asked for is task.create', async () => {
  // Not a bespoke upload permission: the next call this enables is creating a
  // row, so it answers to the same authority. Naming it here means widening it
  // later has to be deliberate.
  reset();
  const res = mockRes();
  await uploadBoardFile(req(A_FILE), res);
  assert.equal(capabilityAsked, 'task.create');
  assert.equal(res.statusCode, 201);
});

test('a permitted upload returns the descriptor a file column stores', async () => {
  reset();
  const res = mockRes();
  await uploadBoardFile(req(A_FILE), res);
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.body.file, {
    url: A_FILE.path,
    name: 'INV-2026-015 Kredoo.pdf',
    mime: 'application/pdf',
    size: 48210,
    publicId: 'macan/tasks/123-INV',
  });
});

test('a request with no file is a 400, not a 201 with nulls', async () => {
  // Multer leaves `req.file` undefined when the field is missing. Returning 201
  // here would create a row carrying a file descriptor pointing at nothing.
  reset();
  const res = mockRes();
  await uploadBoardFile(req(undefined), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.file, undefined);
});

test('a file missing its optional metadata still yields a usable descriptor', async () => {
  // Cloudinary storage has occasionally omitted `size`. A descriptor with
  // `size: undefined` fails the file column's own validation, which would
  // reject the write with a message about a column the person never touched.
  reset();
  const res = mockRes();
  await uploadBoardFile(req({ path: 'https://x/y.pdf' }), res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.file.name, 'file');
  assert.equal(res.body.file.size, 0);
  assert.equal(res.body.file.mime, 'application/octet-stream');
  assert.equal(res.body.file.publicId, null);
});

test('an unexpected failure is a 500 that says nothing about internals', async () => {
  reset();
  contextThrows = new Error('mongo is on fire at 10.0.0.4');
  const res = mockRes();
  await uploadBoardFile(req(A_FILE), res);
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, 'Failed to upload the file');
  assert.ok(!/mongo|10\.0\.0\.4/.test(JSON.stringify(res.body)), 'no internals in the reply');
});
