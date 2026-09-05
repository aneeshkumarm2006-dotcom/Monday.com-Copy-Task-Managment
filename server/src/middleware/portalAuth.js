const jwt = require('jsonwebtoken');
const ClientContact = require('../models/ClientContact');
const Board = require('../models/Board');
const { isClientBoard } = require('../utils/clientBoard');

/**
 * Verify a portal JWT and resolve who it belongs to.
 *
 * PURE-ish and exported on purpose: the middleware below is not the only thing
 * that has to make this decision. An SSE stream authenticates from a `?token=`
 * query param (EventSource cannot set headers) and therefore cannot sit behind
 * the middleware — and a long-lived connection is precisely where "the team
 * disabled this portal" must still be enforced. Two copies of these checks is
 * how the connection-based one ends up missing the newest of them.
 *
 * Every failure returns `null`. The caller decides the status code; nothing in
 * here distinguishes "no such contact" from "link rotated", because the client
 * must not be able to tell those apart either.
 *
 * @param {string} token - the raw JWT
 * @returns {Promise<{contact, board, claims}|null>}
 */
const verifyPortalToken = async (token) => {
  if (!token) return null;

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return null;
  }
  if (decoded.scope !== 'portal' || !decoded.contactId || !decoded.boardId) {
    return null;
  }

  const contact = await ClientContact.findById(decoded.contactId);
  // Never trust the token's board id over the stored contact. A contact that
  // was removed, or whose row was rewritten onto another board, is done.
  //
  // Note we deliberately do NOT check the token's `groupId` claim. Tokens
  // minted before the portal moved from group-scoped to board-scoped still
  // carry one, they are valid for up to PORTAL_JWT_TTL, and there is nothing
  // wrong with them — the claim is simply ignored now.
  if (!contact || String(contact.board) !== String(decoded.boardId)) return null;

  // `+portalToken` because the field is `select: false` — it is a credential,
  // and the comparison below is the entire point of loading it.
  const board = await Board.findById(contact.board).select(
    '+portalToken portalEnabled portalClientName boardType name organisation'
  );
  if (!board || !isClientBoard(board)) return null;

  // The board must still be a live portal, AND its current token must match the
  // one baked into the JWT (`ptk`). This is what makes "disable" and "regenerate
  // link" instantly kill existing client sessions: disabling clears
  // portalEnabled, regenerating changes portalToken — either way this fails on
  // the very next request.
  if (!board.portalEnabled || board.portalToken !== decoded.ptk) return null;

  return { contact, board, claims: decoded };
};

/**
 * Auth guard for the external Client Portal (`/api/portal/me/*`). It is the
 * mirror image of middleware/auth.js:
 *
 *  - It ONLY accepts tokens signed with `scope: 'portal'` (minted in the portal
 *    verify flow); a normal user token is rejected here, and a portal token is
 *    rejected by auth.js. This mutual exclusion is a security requirement.
 *  - It loads the ClientContact named in the token and attaches the trusted
 *    scope to `req.portal`. Controllers derive the board from `req.portal`,
 *    NEVER from request params/body, so a client can only ever reach their own
 *    board's data.
 */
const portalAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res
      .status(401)
      .json({ error: 'Missing or invalid authorization header' });
  }
  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) {
    return res.status(401).json({ error: 'Missing token' });
  }

  try {
    const resolved = await verifyPortalToken(token);
    if (!resolved) {
      return res.status(401).json({ error: 'This portal is no longer available' });
    }
    const { contact, board } = resolved;

    // The board doc carries `+portalToken`, and everything below this line is
    // handed to controllers serving an EXTERNAL client. Strip the credential
    // here rather than trusting every one of them not to serialize it — the
    // same reason the field is `select: false` in the first place.
    board.portalToken = undefined;

    req.portal = {
      contactId: String(contact._id),
      boardId: String(board._id),
      orgId: board.organisation ? String(board.organisation) : null,
      email: contact.email,
      // Precomputed so no handler has to reach into the board for it, and so
      // the label is derived in exactly one place.
      clientName: (board.portalClientName || '').trim() || board.name,
      contact,
      board,
    };

    // Best-effort presence stamp; never block the request on it.
    contact.lastSeenAt = new Date();
    contact.save().catch(() => {});

    return next();
  } catch (err) {
    console.error('portalAuth error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

module.exports = portalAuth;
module.exports.verifyPortalToken = verifyPortalToken;
