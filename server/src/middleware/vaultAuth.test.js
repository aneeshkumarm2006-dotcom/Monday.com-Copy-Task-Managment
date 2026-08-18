/**
 * vaultAuth.test.js — the token-scope separation.
 *
 * Three kinds of token are now signed with the SAME secret: the app session,
 * the Client Portal's, and the vault's. They are only kept apart by each
 * middleware checking `scope`, and a missing check does not throw — it quietly
 * accepts a token nobody meant it to. The 'vault' scope is the dangerous one to
 * get wrong in that direction, because unlike a portal token it carries a real
 * `userId`: without auth.js's rejection a 15-minute proof-of-unlock would work
 * as a full app session on every endpoint in the API.
 *
 * So the matrix is pinned here. Also covered: the vault token is bound to one
 * user and one vault, which is what stops it being passed to a colleague who
 * does not know the password.
 *
 * Run from the server directory:
 *     node --test src/middleware/vaultAuth.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-vault-auth';

const vaultAuth = require('./vaultAuth');
const { signVaultToken } = vaultAuth;
const authMiddleware = require('./auth');

const VAULT = { _id: 'vault-1', board: 'board-1' };
const USER = 'user-1';

/** Minimal express doubles: capture the status/body, or the fact next() ran. */
const run = (middleware, req) => {
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  let nexted = false;
  middleware(req, res, () => {
    nexted = true;
  });
  return { res, nexted };
};

const vaultReq = (token, userId = USER) => ({
  headers: token ? { 'x-vault-token': token } : {},
  user: { userId },
});

const appReq = (token) => ({
  headers: { authorization: `Bearer ${token}` },
});

// ---------------------------------------------------------------------------

test('a vault token opens the vault routes', () => {
  const { res, nexted } = run(vaultAuth, vaultReq(signVaultToken(VAULT, USER)));
  assert.equal(nexted, true, res.body?.error);
});

test('the request carries the vault it was minted for', () => {
  const req = vaultReq(signVaultToken(VAULT, USER));
  run(vaultAuth, req);
  // Controllers compare this against the vault they loaded from the URL. It is
  // the only thing stopping an unlock on one board reaching another's items.
  assert.deepEqual(req.vault, { vaultId: 'vault-1', boardId: 'board-1' });
});

test('a vault token is bound to the user who unlocked', () => {
  // Handing the token to a colleague must not let them read a vault whose
  // password they do not know.
  const token = signVaultToken(VAULT, USER);
  const { res, nexted } = run(vaultAuth, vaultReq(token, 'someone-else'));
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'VAULT_LOCKED');
});

test('an APP token is refused by vaultAuth', () => {
  // Signed with the same secret and verifies fine — only the scope check
  // separates them.
  const appToken = jwt.sign({ userId: USER, email: 'a@b.c' }, process.env.JWT_SECRET);
  const { res, nexted } = run(vaultAuth, vaultReq(appToken));
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 401);
});

test('a PORTAL token is refused by vaultAuth', () => {
  const portalToken = jwt.sign(
    { scope: 'portal', contactId: 'c1', groupId: 'g1' },
    process.env.JWT_SECRET
  );
  const { res, nexted } = run(vaultAuth, vaultReq(portalToken));
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 401);
});

test('a VAULT token is refused as an app session', () => {
  // The inverse, and the one that matters most: a vault token carries a real
  // userId, so without auth.js's scope check it would authenticate every
  // endpoint in the API for fifteen minutes.
  const token = signVaultToken(VAULT, USER);
  const { res, nexted } = run(authMiddleware, appReq(token));
  assert.equal(nexted, false, 'a vault token must never be an app session');
  assert.equal(res.statusCode, 401);
});

test('a PORTAL token is still refused as an app session', () => {
  const portalToken = jwt.sign({ scope: 'portal', contactId: 'c1' }, process.env.JWT_SECRET);
  const { nexted } = run(authMiddleware, appReq(portalToken));
  assert.equal(nexted, false);
});

test('an app token still works as an app session', () => {
  const appToken = jwt.sign({ userId: USER, email: 'a@b.c' }, process.env.JWT_SECRET);
  const { nexted } = run(authMiddleware, appReq(appToken));
  assert.equal(nexted, true);
});

test('a missing, blank or forged vault token reads as locked', () => {
  for (const token of [null, '   ', 'not-a-jwt', jwt.sign({ scope: 'vault' }, 'wrong-secret')]) {
    const { res, nexted } = run(vaultAuth, vaultReq(token));
    assert.equal(nexted, false, `accepted: ${token}`);
    assert.equal(res.statusCode, 401);
    // The client turns this code into "unlock again" rather than an error.
    assert.equal(res.body.code, 'VAULT_LOCKED');
  }
});

test('a vault token without a vaultId is refused', () => {
  // Right scope, wrong shape — a hand-rolled token, or an older format.
  const token = jwt.sign({ scope: 'vault', userId: USER }, process.env.JWT_SECRET);
  const { nexted } = run(vaultAuth, vaultReq(token));
  assert.equal(nexted, false);
});

test('an expired vault token reads as locked', () => {
  const token = jwt.sign(
    { scope: 'vault', vaultId: 'vault-1', boardId: 'board-1', userId: USER },
    process.env.JWT_SECRET,
    { expiresIn: -10 }
  );
  const { res, nexted } = run(vaultAuth, vaultReq(token));
  assert.equal(nexted, false);
  assert.equal(res.body.code, 'VAULT_LOCKED');
});

test('the vault token is short-lived', () => {
  const decoded = jwt.decode(signVaultToken(VAULT, USER));
  const lifetime = decoded.exp - decoded.iat;
  assert.ok(lifetime <= 15 * 60, `${lifetime}s is too long for a proof-of-unlock`);
  assert.ok(lifetime >= 60, 'so short it would be unusable');
});
