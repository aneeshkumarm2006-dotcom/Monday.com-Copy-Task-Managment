const express = require('express');
const authMiddleware = require('../middleware/auth');
const {
  list,
  get,
  put,
  del,
  declare,
  addBoard,
  removeBoard,
  copyFrom,
  preview,
  getMine,
  putMine,
  getMyHome,
} = require('../controllers/executiveViewController');

/**
 * Executive views — the admin plane and the self plane, in one router.
 *
 * ---- WHY THIS IS MOUNTED BARE AT `/api` AND NOT ADDED TO `routes/orgs.js` ---
 *
 * This codebase has exactly two mounting conventions and they overlap here:
 *
 *   1. ORG-SCOPED ROUTERS live in `routes/orgs.js`, which `app.js` mounts at
 *      `/api/orgs`, and their paths are written relative to it (`/:id/members`,
 *      `/:id/roles`, `/:id/holidays`).
 *   2. FEATURE ROUTERS are mounted BARE at `/api` and spell their full paths
 *      themselves — `routes/groups.js` owns `/boards/:boardId/...` AND
 *      `/groups/:groupId/...` AND `/notes/:id`, because one feature's endpoints
 *      hang off several nouns.
 *
 * This feature is convention 2 wearing convention 1's prefix on half its routes.
 * Its admin plane is org-scoped (`/orgs/:orgId/executive-views/...`) and its
 * self plane is not (`/me/executive-view`) — and the two halves are one feature
 * over one document with one service behind them. Splitting them so the
 * org-scoped half could live in `routes/orgs.js` would put one feature's routes
 * in two files, and the `/me` half would have to go somewhere anyway; it would
 * end up bare at `/api`, which is where this whole router is going regardless.
 *
 * So: bare at `/api`, with the org prefix spelled out in full below. The URLs
 * are identical either way — `/api/orgs/:orgId/executive-views` resolves the
 * same whichever file answers it — and the choice is only about which file a
 * reader finds them in. A THIRD prefix (`/api/executive-views/...`, say) is
 * deliberately NOT invented: it would be a new shape nobody else follows, and
 * it would hide that these routes are scoped to one workspace.
 *
 * `routes/orgs.js` is therefore untouched. Note that it still runs first —
 * `app.js` mounts it at `/api/orgs` above this router — but nothing in it
 * matches `/:id/executive-views`, so these requests fall through to here. The
 * only side effect is that its `authMiddleware` runs before ours, which is
 * harmless: every route in this file requires the same session anyway.
 *
 * ---- WHY EVERY ROUTE IS AUTHENTICATED AND ONLY SOME ARE CAPABILITY-GATED ----
 *
 * `router.use(authMiddleware)` covers the file. The admin plane's capability
 * check (`org.manage_executive_views`) is NOT a middleware like
 * `requireCapability` in `routes/orgs.js`, because each handler already loads
 * the org context to do its work and that context is where the answer is — a
 * middleware would load the organisation a second time on every request to ask
 * a question the handler is about to ask again. The self plane has no
 * capability gate at all by design: it edits the caller's own shape and can
 * never widen their reach.
 */

const router = express.Router();

router.use(authMiddleware);

// ---------------------------------------------------------------------------
// Self plane — the caller's own view. No capability beyond being signed in.
//
// The organisation comes from `?org=` on BOTH verbs, the way every other "mine"
// endpoint in this codebase takes it: a person can be a member of several
// workspaces and an Executive in one of them, and only the client knows which
// one is on screen.
// ---------------------------------------------------------------------------

// GET /api/me/executive-view?org=:orgId → { profile|null, skipped: [] }
router.get('/me/executive-view', getMine);

// PUT /api/me/executive-view?org=:orgId — shape only; 404 if there is no
// profile, because the self path edits a view it never creates.
router.put('/me/executive-view', putMine);

// GET /api/me/executive-home?org=:orgId → { sections: [...] }
//
// The composed page, NOT a second copy of the profile: this is the only route
// that runs `services/executiveHome.js`. It is a sibling of the view route
// rather than a `?compose=` flag on it, because the two are asked for at
// different moments and at very different cost — the view is read once per
// sign-in by everybody to decide `isExecutive` and must stay cheap, while this
// one runs a scorer per section and is asked for only by somebody who already
// knows they have a home to draw. 404 when they do not; see the handler.
router.get('/me/executive-home', getMyHome);

// ---------------------------------------------------------------------------
// Admin plane — every route requires `org.manage_executive_views`, checked in
// the controller against the loaded org context.
// ---------------------------------------------------------------------------

// GET /api/orgs/:orgId/executive-views — the Executives strip: who has a view.
router.get('/orgs/:orgId/executive-views', list);

// GET    /:userId — the profile, resolved AS THAT PERSON (honest `skipped[]`).
// PUT    /:userId — create or replace the shape.
// DELETE /:userId — delete the profile only; role and grants are untouched.
router.get('/orgs/:orgId/executive-views/:userId', get);
router.put('/orgs/:orgId/executive-views/:userId', put);
router.delete('/orgs/:orgId/executive-views/:userId', del);

// POST /:userId/declare — "Make executive": assign the role AND create the
// empty profile in one sequence. Needs `org.assign_roles` too, but only when a
// role would actually move: `{ assignRole: false }` and a target who already
// holds the Executive role both skip that half and that check.
router.post('/orgs/:orgId/executive-views/:userId/declare', declare);

// POST   /:userId/boards            — add a board and write the grant. 404s
//                                     unless the profile already exists; this
//                                     route adds to a view, it never makes one.
// DELETE /:userId/boards/:boardId   — remove it; `?revoke=` defaults to true.
router.post('/orgs/:orgId/executive-views/:userId/boards', addBoard);
router.delete(
  '/orgs/:orgId/executive-views/:userId/boards/:boardId',
  removeBoard
);

// POST /:userId/copy-from/:sourceUserId — "start from somebody else's view".
//
// Copies SHAPE ONLY: the home layout, the eight nav switches, and each board
// entry's presentation. Every board goes through the same `addBoard` service
// call the route above uses, so the ACTOR's own `canManageAccess` is re-checked
// per board and a board they cannot share is SKIPPED and named in the response
// rather than failing the whole copy. It never creates a profile — `declare` is
// the one route that decides who is an Executive, which is what keeps its
// `org.assign_roles` rule from being reachable around the side. 404 otherwise.
//
// A POST rather than a PUT: it is not idempotent in the way a PUT promises. The
// shape half is (copy twice, same layout), but the board half writes grants and
// reports what it skipped, and the second run's answer legitimately differs from
// the first's — a board somebody shared in between now lands.
router.post(
  '/orgs/:orgId/executive-views/:userId/copy-from/:sourceUserId',
  copyFrom
);

// GET /:userId/preview — the target's home and rail, composed AS THE TARGET.
//
// A sibling of the two routes above rather than a `?preview=` flag on `GET
// /:userId`, and for the same reason `/me/executive-home` is a sibling of
// `/me/executive-view`: this one runs a scorer per section, and the profile read
// beside it is asked for on every open of the configurator and must stay cheap.
//
// The whole point is that it resolves and composes server-side as the TARGET, so
// an admin who can read more boards than that person can never see a preview
// their reach has flattered. It never 403s on a board the target cannot read —
// showing that is what the screen is for. 404 when there is no profile, the same
// answer `/me/executive-home` gives for the same reason.
router.get('/orgs/:orgId/executive-views/:userId/preview', preview);

module.exports = router;
