/**
 * What a Client Portal board is, in one place.
 *
 * A `boardType: 'client'` board IS one client company. Its GROUPS are that
 * client's SERVICES (SEO, Meta Ads, Google Ads, Web Development) — not, as they
 * once were, separate clients. One portal link per board; a signed-in contact
 * sees the whole board, every service on it.
 *
 * THERE ARE NO TIERS. `portalTier` ('basic' | 'advanced') is gone, along with
 * `isAdvancedClientBoard`, `utils/clientTierUpgrade.js` and the two upgrade
 * routes. Chat and mail are what a client portal IS, not an upsell:
 * every service gets a client chat, a client mailbox and a private team room the
 * day it is created (`services/workstreamSurfaces.js`).
 *
 * That removal was not a simplification for its own sake. The tier defaulted to
 * 'basic', no UI ever called the upgrade endpoint, and `chatAudience` therefore
 * returned an empty contact list for every board in existence — so the entire
 * client chat and mail feature was unreachable in production while looking, to
 * anyone reading the code, like a shipped one.
 *
 * Deliberately dependency-free (no models, no mongoose) so it can be required
 * from a controller, a service or a plain node test without a database.
 */

/**
 * Is this a Client Portal board at all?
 * @param {Object} board - a Board doc or plain object; reads `boardType`
 */
const isClientBoard = (board) => board?.boardType === 'client';

/**
 * Is this a LIVE client portal board — the ONLY place a `ClientContact` may
 * ever see or post in a channel?
 *
 * This replaces `isAdvancedClientBoard`. What survives from it is the half that
 * was always the real gate: the KILL SWITCH. Disabling a portal must stop a
 * long-lived SSE stream, not merely the next request, which is why
 * `services/chatAudience.js` re-reads this on every call rather than trusting
 * whatever was true when the connection opened.
 *
 * With the tier gone this is now the only thing standing between a disabled
 * portal and an open room, so it is load-bearing in a way its predecessor was
 * not — `src/e2e/clientPortalV2.e2e.js` exercises it directly.
 *
 * Fails closed by construction: no board, a board loaded without
 * `portalEnabled` selected, and every non-client board all answer false.
 *
 * @param {Object} board - a Board doc or plain object
 * @returns {boolean}
 */
const isLiveClientBoard = (board) =>
  isClientBoard(board) && board?.portalEnabled === true;

module.exports = { isClientBoard, isLiveClientBoard };
