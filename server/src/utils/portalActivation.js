const { generatePortalToken } = require('./portalCrypto');

/**
 * WHEN DOES A CLIENT PORTAL BECOME REACHABLE?
 *
 * Exactly once, on the first SERVICE. This module is the only implementation of
 * that rule, and every path that can create a service calls it:
 *
 *   groupController.createGroup                 "Add service" on the board
 *   portalBatchInvite.createServiceWithInvites  "Add service" + invite people
 *   portalBatchInvite.inviteServiceContacts     the N-row batch invite
 *
 * ---- WHY NOT AT BOARD CREATION, WHERE IT USED TO BE ------------------------
 *
 * `boardController.createBoard` used to mint `portalToken` and set
 * `portalEnabled: true` inline, so a client board's shareable link existed the
 * moment the board did. It also emailed the first contact the address typed
 * into the create form.
 *
 * Both were the wrong moment. A client board with no services on it has nothing
 * for a client to look at: `PortalServiceTable` renders "Your portal is being
 * set up" and there is no request to raise, no chat to open and no mailbox.
 * Handing that link over — or worse, emailing it — spends the one moment the
 * client actually pays attention on an empty room. So the board is now born
 * with no token and the portal off, and this runs when there is finally
 * something behind the link.
 *
 * ---- WHY IT LIVES IN utils/ RATHER THAN IN portalBatchInvite --------------
 *
 * A CYCLE. `services/portalBatchInvite.js` requires `resolveGroupName` from
 * `controllers/groupController.js`; if `createGroup` then required the
 * activation rule back out of that service, whichever module node loaded second
 * would receive a half-built exports object and `resolveGroupName` would be
 * `undefined` at call time — a failure that shows up only when a batch invite
 * runs, not at boot. Depending on nothing but `portalCrypto` makes that
 * impossible by construction, which is the same reason `utils/clientBoard.js`
 * is deliberately dependency-free.
 *
 * @param {object} board — a client Board DOCUMENT (not a lean object) loaded
 *   WITH `.select('+portalToken')`.
 *
 *   THAT PROJECTION IS LOAD-BEARING, not an optimisation. `Board.portalToken`
 *   is `select: false` because it is a live credential, so on a board loaded
 *   without it `!board.portalToken` is true even when the board HAS one — and
 *   this would then mint a fresh token, rotating a working client link and
 *   killing every signed-in contact's session. `loadManageContext` and the
 *   field's own comment on the model both write this trap down; it is the same
 *   one, and this is the third place it can be sprung.
 *
 * ---- IT ONLY EVER TURNS A PORTAL ON *ONCE* -------------------------------
 *
 * The condition is `!board.portalToken`, NOT `portalEnabled !== true`, and the
 * difference is the kill switch.
 *
 * `portalEnabled: false` means two completely different things depending on
 * whether a token exists. With no token it is the BIRTH STATE — the board has
 * never been live and adding a service should bring it to life. With a token it
 * is the KILL SWITCH: somebody pressed "Disable link", `portalStream.dropBoard`
 * cut every open SSE connection, and `middleware/portalAuth.js` has been
 * refusing every request since. Nothing else on the board distinguishes them.
 *
 * Reading the flag alone would conflate the two, and adding a service to an
 * offboarded client — an ordinary internal restructuring, available to anyone
 * with `group.manage` — would silently switch the portal back on. Because the
 * token is never rotated, the client's ORIGINAL link and every portal JWT
 * already issued against that `ptk` would start working again, and
 * `isLiveClientBoard` flipping true would re-open every client chat and mailbox
 * on the board to `chatAudience`. `sendPortalInvite` and `resendPortalInvite`
 * refuse outright rather than do that; this must not be the back door they are
 * not.
 *
 * So: a board that already holds a token has been live before, and its current
 * `portalEnabled` is a DECISION. Only `savePortalConfig`'s toggle may reverse
 * it.
 *
 * @returns {Promise<{minted: boolean, enabled: boolean, changed: boolean, live: boolean}>}
 *   `changed` is true exactly once per board: on the submission that brought
 *   the portal to life. Callers report "the client link is now live" on it, and
 *   say nothing for every service after that — including on a board whose
 *   portal is switched off, where the honest answer is "nothing was activated".
 *
 *   `live` is the state AFTERWARDS, and callers need it separately: it is what
 *   `createSurfaces` will read through `isLiveClientBoard`, and a caller that
 *   asks for client-facing rooms on a board where it is false gets its WHOLE
 *   plan refused — the private team room along with them.
 */
const ensurePortalLive = async (board) => {
  const minted = !board.portalToken;
  if (minted) {
    board.portalToken = generatePortalToken();
    board.portalEnabled = true;
    await board.save();
  }
  return {
    minted,
    enabled: minted,
    changed: minted,
    live: board.portalEnabled === true,
  };
};

/**
 * Does this board have anything for a client to look at yet?
 *
 * The read side of the same rule, for the surfaces that must NOT offer a link
 * or an invitation before a service exists: `getPortalConfig` (which reports it
 * to the modal as `hasServices`), `savePortalConfig`'s enable and rotate, and
 * the single-address invite and resend endpoints. `savePortalConfig` used to
 * lazy-mint a token whenever one was missing; this predicate is what replaced
 * that branch.
 *
 * Takes the model rather than importing it, so this file stays free of the
 * model graph and remains testable without a database.
 *
 * @param {object} TaskGroup — the mongoose TaskGroup model
 * @param {string|ObjectId} boardId
 * @returns {Promise<boolean>}
 */
const boardHasServices = async (TaskGroup, boardId) =>
  (await TaskGroup.countDocuments({ board: boardId }).limit(1)) > 0;

module.exports = { ensurePortalLive, boardHasServices };
