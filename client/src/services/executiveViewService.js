import api from './api';

/**
 * Executive views — the client's side of both planes of one feature.
 *
 * An executive view is a per-(organisation, user) profile describing what ONE
 * person's screen looks like: which boards are on their list and in what order,
 * what their home page is composed of, which rail entries they kept. The server
 * exposes it through two very different doors, and this file wraps both:
 *
 *   ADMIN PLANE  `/api/orgs/:orgId/executive-views/...`
 *     Gated on `org.manage_executive_views`. Read by the Members page and the
 *     configurator. `addExecutiveBoard`, `removeExecutiveBoard` and
 *     `copyExecutiveView` write and revoke real board GRANTS through the share
 *     path — they are the only three functions in this file that change what
 *     anybody can reach, and all three are authorised PER BOARD against the
 *     caller's own standing on it.
 *
 *   SELF PLANE   `/api/me/executive-view?org=:orgId`
 *     Any signed-in caller, no extra capability. Reads and rewrites the SHAPE of
 *     their own profile and nothing else: the server runs it with
 *     `allowReachChange: false`, so a board entry the caller cannot already read
 *     is dropped rather than honoured, and no grant is ever written. That is
 *     what makes an "edit my own home" button safe to offer at all.
 *
 * ---- WHY THE SELF PLANE TAKES `?org=` ON BOTH VERBS ------------------------
 *
 * A person can belong to several workspaces and be an Executive in one of them.
 * The server cannot guess which one is on screen, so it asks — exactly as every
 * other "mine" endpoint in this codebase does (`GET /api/tasks/my?org=`, the
 * calendar). It is a query parameter even on the PUT: the body is the shape, and
 * mixing the addressing into it would mean two places to look for which document
 * a write lands on. Callers must pass `orgId` to both.
 *
 * ---- HOUSE STYLE -----------------------------------------------------------
 *
 * Named exports, `data` unwrapped at the call site, and a comment on each saying
 * what the caller actually gets back — the same contract `orgService.js` follows,
 * so a store never has to remember whether a wrapper returned the envelope or the
 * thing inside it. Nothing here catches: an error is the caller's to handle, and
 * `services/api.js` has already toasted the 5xx and network cases.
 */

// ---------------------------------------------------------------------------
// Self plane — the caller's own view.
// ---------------------------------------------------------------------------

/**
 * GET /api/me/executive-view — the caller's profile, resolved against their own
 * access.
 *
 * Returns `{ profile, skipped }`:
 *  - `profile` is `null` (with a 200, not a 404) when the caller is not an
 *    Executive. That is the answer, not an error — `isExecutive` on the client
 *    is exactly `profile !== null`, and this endpoint is called by every session
 *    in the workspace on every sign-in.
 *  - `skipped` is `[{ board, name, reason }]` — entries on the list the caller
 *    can no longer read, dropped from `profile.boards` and reported here so the
 *    shell can say so instead of rendering tiles that 403 on click. `reason` is
 *    the server's `SKIP_REASONS` vocabulary (`'deleted'` | `'no-access'`).
 */
export const getMine = async (orgId) => {
  const { data } = await api.get('/api/me/executive-view', {
    params: { org: orgId },
  });
  return data; // { profile|null, skipped: [{ board, name, reason }] }
};

/**
 * PUT /api/me/executive-view — the Executive rewrites their own shape.
 *
 * THE BODY MUST CARRY ALL THREE OF `{ boards, home, nav }`, not just the part
 * being edited. This endpoint REPLACES the document: the server's
 * `validateShape` reads an absent `home` as "no sections" and an absent `nav` as
 * "every switch on", and then assigns all three fields, so a body of `{ home }`
 * deletes the person's curated board list and answers 200 with an empty
 * `dropped`. Nothing merges, on either side of the wire.
 *
 * Which is why nothing should call this wrapper directly: `executiveViewStore`'s
 * `saveMine(shape)` is the front door, and it fills the parts you did not pass
 * from the loaded profile. This function stays a faithful transport — it has no
 * profile to merge from — and the rule is written here so a future caller who
 * reaches past the store at least reads it first.
 *
 * Returns `{ profile, dropped }`. `dropped` is the board ids the server refused
 * to keep because the caller cannot read them — the self plane never grants, so
 * listing a board you cannot open is not an error, it is a no-op the caller has
 * to be told about. 404s when there is no profile: this path EDITS a view an
 * admin created, it never creates one.
 */
export const saveMine = async (orgId, shape) => {
  const { data } = await api.put('/api/me/executive-view', shape, {
    params: { org: orgId },
  });
  return data; // { profile, dropped: [boardId] }
};

/**
 * GET /api/me/executive-home — the composed home page, `{ sections: [...] }`,
 * each section an envelope of
 * `{ id, type, order, width, config, state, data, error }`.
 *
 * A SIBLING OF THE VIEW READ, NOT A FLAG ON IT, because the two are asked for at
 * different moments and at very different cost: the view is read once per
 * sign-in by everybody to decide `isExecutive` and must stay cheap, while this
 * one runs a scorer per section and is only ever asked for by somebody who
 * already knows they have a home to draw.
 *
 * 404s when the caller has no profile — deliberately, and unlike the view read
 * next door. Reaching this without one means the client asked for a page that
 * does not exist for this person, and `sections: []` would read as "your home
 * page is empty", which a real profile can genuinely be.
 */
export const getMyHome = async (orgId) => {
  const { data } = await api.get('/api/me/executive-home', {
    params: { org: orgId },
  });
  return data; // { sections: [...] }
};

// ---------------------------------------------------------------------------
// Admin plane — someone else's view. Every call needs
// `org.manage_executive_views`, and the board calls need the caller's own
// `canManageAccess` on the board in question (checked server-side, per board).
// ---------------------------------------------------------------------------

/**
 * GET /api/orgs/:orgId/executive-views — everyone in the workspace who has a
 * view, as a SUMMARY for the Executives strip on the Members page.
 *
 * Returns `{ executives: [{ id, user, boardCount, createdAt, updatedAt }] }`.
 * `user` is `{ _id, name, email, profilePic }` — or **null** for a profile whose
 * person has been deleted. This list is the only surface in the app that could
 * ever show such an orphan, so it keeps the row rather than hiding it; every
 * renderer must null-check.
 */
export const listExecutives = async (orgId) => {
  const { data } = await api.get(`/api/orgs/${orgId}/executive-views`);
  return data; // { executives: [...] }
};

/**
 * GET /api/orgs/:orgId/executive-views/:userId — one person's profile, resolved
 * AS THAT PERSON.
 *
 * Same `{ profile, skipped }` shape as the self read, and the same 200-with-null
 * when they have no view — which is how the Members row decides between "Make
 * executive" and "Edit executive view". `skipped` here is the honest answer the
 * configurator flags (invariant 4): it is computed against the TARGET's access,
 * never the admin's, so an owner does not see an empty `skipped` on a list half
 * of whose boards the person lost weeks ago.
 */
export const getExecutiveView = async (orgId, userId) => {
  const { data } = await api.get(
    `/api/orgs/${orgId}/executive-views/${userId}`
  );
  return data; // { profile|null, skipped: [...] }
};

/**
 * PUT /api/orgs/:orgId/executive-views/:userId — create or replace the shape.
 *
 * Returns `{ profile, dropped }`. `dropped` is normally empty on this plane: an
 * admin MAY list a board the target cannot currently read, because they are
 * about to grant it (or already did through `addExecutiveBoard`). The entry
 * confers nothing on its own; the resolve flags it until the grant exists.
 */
export const saveExecutiveView = async (orgId, userId, shape) => {
  const { data } = await api.put(
    `/api/orgs/${orgId}/executive-views/${userId}`,
    shape
  );
  return data; // { profile, dropped: [boardId] }
};

/**
 * DELETE /api/orgs/:orgId/executive-views/:userId — delete the profile, and
 * NOTHING else.
 *
 * Returns `{ removed, roleUnchanged, grantsUnchanged, boardCount }`. The two
 * `*Unchanged` flags are in the payload precisely because they are surprising:
 * the person keeps their role and keeps every board grant they were given, they
 * simply get the standard app back. Read the confirm dialog's sentence off these
 * rather than hardcoding one, so it cannot drift from what the server did.
 * 404s when there is no profile.
 */
export const deleteExecutiveView = async (orgId, userId) => {
  const { data } = await api.delete(
    `/api/orgs/${orgId}/executive-views/${userId}`
  );
  return data; // { removed, roleUnchanged, grantsUnchanged, boardCount }
};

/**
 * POST /api/orgs/:orgId/executive-views/:userId/declare — "Make executive":
 * assign the Executive role AND create the empty profile, in one call.
 *
 * `{ assignRole: false }` skips the role half (and the `org.assign_roles` check
 * that comes with it) for the case where somebody is already in the right role
 * and only needs the view. Anything else defaults to assigning it.
 *
 * Returns `{ profile, created, roleAssigned, role }`; 201 when the profile was
 * created, 200 when it already existed. Both halves are idempotent, so pressing
 * the button twice is safe — and the second press changes nothing, which is why
 * `created` and `roleAssigned` are reported separately rather than assumed.
 */
export const declareExecutive = async (orgId, userId, options = {}) => {
  const body = {};
  if (options.assignRole !== undefined) body.assignRole = options.assignRole;
  const { data } = await api.post(
    `/api/orgs/${orgId}/executive-views/${userId}/declare`,
    body
  );
  return data; // { profile, created, roleAssigned, role }
};

/**
 * POST /api/orgs/:orgId/executive-views/:userId/boards — add a board to the list
 * AND write the grant that makes it openable, in one step.
 *
 * Defaults to full access (`edit` + `canManage`), which is what the Executive
 * role means on the boards somebody is actually given; pass `level` / `canManage`
 * to lower it. The call is refused unless the CALLER could share that board
 * themselves — that check is the reason this route cannot be used to hand
 * yourself reach you were never given.
 *
 * Returns `{ profile, board, level, canManage, added }`. `added` is false when
 * the board was already on the list and this call only changed the grant, which
 * is how the configurator edits a level.
 */
export const addExecutiveBoard = async (orgId, userId, boardId, options = {}) => {
  const body = { boardId };
  if (options.level !== undefined) body.level = options.level;
  if (options.canManage !== undefined) body.canManage = options.canManage;
  const { data } = await api.post(
    `/api/orgs/${orgId}/executive-views/${userId}/boards`,
    body
  );
  return data; // { profile, board, level, canManage, added }
};

/**
 * DELETE /api/orgs/:orgId/executive-views/:userId/boards/:boardId — take a board
 * off the list and, BY DEFAULT, revoke the grant with it.
 *
 * Revoking is the default because taking a board off a curated list normally
 * means the person should not be able to open it any more; pass
 * `{ revoke: false }` for the other case (a board they also reach some other way
 * that was only ever being tidied off the list).
 *
 * Returns `{ profile, removed, revoked, grantLeft, reason }`. Read `revoked`,
 * never the flag you sent: the entry always goes, but the revoke can be refused
 * on its own when the caller cannot manage access on that board — then
 * `grantLeft` is true and `reason` carries the server's `KEEP_REASONS`
 * vocabulary, so the UI can say "removed from the list, but they can still open
 * it" rather than reading a bare `revoked: false` as "you asked us not to".
 */
export const removeExecutiveBoard = async (
  orgId,
  userId,
  boardId,
  options = {}
) => {
  const { data } = await api.delete(
    `/api/orgs/${orgId}/executive-views/${userId}/boards/${boardId}`,
    // The server parses this leniently (`'false'`, `'0'`, `'no'`), but only a
    // literal false is sent here — anything vaguer would be this file guessing
    // at an intention on a call that removes somebody's access.
    { params: options.revoke === false ? { revoke: 'false' } : undefined }
  );
  return data; // { profile, removed, revoked, grantLeft, reason }
};

// ---------------------------------------------------------------------------
// The second executive — copying a view, and looking at one.
//
// Both are admin-plane routes and both carry the same capability gate as the
// rest of this section. They are grouped apart because neither is part of
// editing a view: one CREATES the contents of a new one, the other only reads.
// ---------------------------------------------------------------------------

/**
 * POST /api/orgs/:orgId/executive-views/:userId/copy-from/:sourceUserId — start
 * a new view from an existing one.
 *
 * Copies SHAPE ONLY: the home layout, the eight nav switches, and each board
 * entry's presentation (nickname, default tab, tab allowlist). Every board then
 * goes through the same `addBoard` the "Add board" button uses, so the CALLER's
 * own `canManageAccess` is re-checked per board — copying a view can never hand
 * out reach the caller could not hand out one board at a time. The level comes
 * off the SOURCE's resolved access to that board, not off a default, so the copy
 * cannot grant more than the person being copied from actually holds.
 *
 * It creates NO profile: 404 unless the target is already an Executive
 * (`declareExecutive` is the one route that decides that, and the one that
 * checks `org.assign_roles` before a role moves). The create flow calls declare
 * first and this second.
 *
 * Returns `{ profile, copied, skipped }`.
 *
 * ---- `skipped` IS THE REASON THIS CALL IS WORTH MAKING HONESTLY -----------
 *
 * `[{ board, name, reason, error }]`. A board the caller cannot share does not
 * fail the whole copy — the other nine should still land — so it is SKIPPED and
 * named. `reason` is the server's `COPY_SKIP_REASONS` vocabulary:
 *
 *   'deleted'           the board is gone from this workspace
 *   'source-no-access'  the person being copied FROM can no longer open it, so
 *                       there was no level to copy
 *   'cannot-share'      the CALLER cannot share it (the 403 the service returns)
 *   'failed'            any other refusal, with the service's own words in
 *                       `error` — which is null on the three above
 *
 * A caller that drops this array is telling an admin the two views match when
 * they do not. It must be shown, and shown somewhere it cannot be missed.
 *
 * `copied` is the other half of the audit: `[{ board, name, level, canManage,
 * added }]`, where `level` is what the grant service NORMALISED rather than what
 * was asked for.
 */
export const copyExecutiveView = async (orgId, userId, sourceUserId) => {
  const { data } = await api.post(
    `/api/orgs/${orgId}/executive-views/${userId}/copy-from/${sourceUserId}`
  );
  return data; // { profile, copied, skipped: [{ board, name, reason, error }] }
};

/**
 * GET /api/orgs/:orgId/executive-views/:userId/preview — the configurator's
 * Preview step: the target's home and rail, composed AS THE TARGET.
 *
 * Returns `{ profile, skipped, sections, nav, permissions }`:
 *
 *  - `profile` / `skipped` — `resolveForViewer` run against the TARGET, so the
 *    board entries that survive and the ones that did not are theirs, never the
 *    caller's. An admin can usually read more boards than the person they are
 *    composing for, which is exactly the flattering error this endpoint exists
 *    to prevent.
 *  - `sections` — `compose` run as the target: the same envelopes
 *    `getMyHome` answers with, scored by the same code, with `unavailable` on
 *    any board they cannot open.
 *  - `nav` — a normalised echo of `profile.nav`, all eight keys present, so a
 *    pane drawing the rail never has to infer a default for a switch that was
 *    added after the profile was written.
 *  - `permissions` — `{ role, isOwner, capabilities }` FOR THE TARGET, in the
 *    same shape `GET /api/orgs/:id` ships for the caller. The rail needs it:
 *    `nav` can only hide a row a capability already allowed, so applying the
 *    switches over the ADMIN's capabilities would draw rows the target will
 *    never see.
 *
 * 404 when that person has no view — the same answer, and the same sentence,
 * `getMyHome` gives for the same reason. It never 403s on a board the target
 * cannot read: showing that is the whole point of looking.
 */
export const previewExecutiveView = async (orgId, userId) => {
  const { data } = await api.get(
    `/api/orgs/${orgId}/executive-views/${userId}/preview`
  );
  return data; // { profile, skipped, sections, nav, permissions }
};
