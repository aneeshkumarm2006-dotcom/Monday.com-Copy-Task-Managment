/**
 * What a Client Portal board is, in one place.
 *
 * A `boardType: 'client'` board IS one client company. Its GROUPS are that
 * client's workstreams (SEO, Ads, Web Development) — not, as they once were,
 * separate clients. One portal link per board; a signed-in contact sees the
 * whole board.
 *
 * Two tiers, `Board.portalTier`:
 *
 *   'basic'    — the task list and the per-task Client thread. What every
 *                client board is on creation, and what every board that
 *                predates the field reads back as.
 *   'advanced' — everything basic has, plus chat: a team-only room and a
 *                client-facing room per workstream.
 *
 * The upgrade is ONE-WAY, and that is a product decision with a data reason
 * behind it: advancing a board is a deliberate statement that it holds exactly
 * one company, which is what makes it safe for every contact on it to read
 * every workstream and to share one set of rooms. Walking that back would not
 * un-send the messages.
 *
 * EVERY gate that asks "does client chat exist here?" calls the predicate
 * below rather than re-spelling the two-part test. Two copies of a
 * confidentiality boundary is how one of them ends up checking only half.
 *
 * Deliberately dependency-free (no models, no mongoose) so it can be required
 * from a controller, a service or a plain node test without a database.
 */

const PORTAL_TIERS = ['basic', 'advanced'];

/**
 * Is this a Client Portal board at all?
 * @param {Object} board - a Board doc or plain object; reads `boardType`
 */
const isClientBoard = (board) => board?.boardType === 'client';

/**
 * Is this a client board with chat switched on — the ONLY place a
 * `ClientContact` may ever see or post in a channel?
 *
 * Fails closed by construction: a board loaded without `portalTier`, a board
 * that predates the field, and every non-client board all answer false.
 *
 * @param {Object} board - a Board doc or plain object
 * @returns {boolean}
 */
const isAdvancedClientBoard = (board) =>
  isClientBoard(board) && board?.portalTier === 'advanced';

module.exports = { PORTAL_TIERS, isClientBoard, isAdvancedClientBoard };
