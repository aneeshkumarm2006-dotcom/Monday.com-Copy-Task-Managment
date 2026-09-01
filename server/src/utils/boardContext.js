const Board = require('../models/Board');
const Organisation = require('../models/Organisation');
const { resolveAccess, resolveOrgAccess } = require('./permissions');

/**
 * THE choke point for board authorization.
 *
 * There used to be six near-identical `loadBoardContext` functions — one each in
 * boardController, groupController, columnController, linkController,
 * taskController and automationController — and they had already drifted apart.
 * The automation copy resolved permission with a bare `isOrgAdmin` and never
 * consulted board access at all, which is how an org admin could manage
 * automations on a private board they could not open while the board's own
 * creator could not. Six copies means six places to thread a new rule through and
 * one of them will be missed. So: one copy.
 *
 * Everything a controller needs to decide is on the returned context:
 *
 *   ctx.can('task.delete')   → the two-layer AND, the answer to every question
 *   ctx.board, ctx.org       → the loaded documents
 *   ctx.access               → the full resolved access object
 *   ctx.isAdmin, ctx.readOnly→ the old vocabulary, derived (do not add new uses)
 *
 * On failure it returns `{ status, error }` — the shape every existing caller
 * already checks with `if (ctx.error) return res.status(ctx.status)...`.
 */

/**
 * Load a board + its org and resolve the caller's access.
 *
 * @param {string} boardId
 * @param {string} userId
 * @param {Object} [opts]
 * @param {boolean} [opts.requireRead=true] - 403 unless the user can read the board
 */
const loadBoardContext = async (boardId, userId, { requireRead = true } = {}) => {
  const board = await Board.findById(boardId);
  if (!board) return { status: 404, error: 'Board not found' };

  const org = await Organisation.findById(board.organisation);
  if (!org) return { status: 404, error: 'Organisation not found' };

  const isMember = org.members.some(
    (m) => String(m?._id || m) === String(userId)
  );
  if (!isMember) {
    return { status: 403, error: 'Not a member of this workspace' };
  }

  // An org created before the role system carries no `roles`, so every capability
  // would resolve to false and its members would be locked out of every board in
  // their own workspace. Seed on first touch — the same lazy heal that
  // requireCapability does, and the reason this system can ship before the
  // backfill migration has run everywhere.
  if (org.ensureSystemRoles()) await org.save();

  const access = resolveAccess(board, org, userId);
  if (requireRead && !access.canRead) {
    return { status: 403, error: 'Access denied' };
  }

  return {
    board,
    org,
    access,
    can: access.can,
    capabilities: access.capabilities,
    // Legacy vocabulary, derived from the new model so the two cannot drift.
    // `isAdmin` never meant "org admin" on these paths — it meant "may
    // restructure this board's content". New code should ask `can(...)`.
    isAdmin: access.canEdit,
    readOnly: access.readOnly,
  };
};

/**
 * Guard helper: returns an `{ status, error }` when the user lacks `capability`,
 * or null when they hold it. Keeps the controllers to two lines per gate.
 *
 *   const denied = requireCapability(ctx, 'task.delete');
 *   if (denied) return res.status(denied.status).json({ error: denied.error });
 */
const requireCapability = (ctx, capability, message) => {
  if (ctx.can(capability)) return null;
  return {
    status: 403,
    error: message || `You do not have permission to do this (${capability})`,
  };
};

/**
 * Org-only context, for routes with no board in play (members, roles, invites).
 */
const loadOrgContext = async (orgId, userId) => {
  const org = await Organisation.findById(orgId);
  if (!org) return { status: 404, error: 'Organisation not found' };

  const isMember = org.members.some(
    (m) => String(m?._id || m) === String(userId)
  );
  if (!isMember) {
    return { status: 403, error: 'Not a member of this workspace' };
  }

  if (org.ensureSystemRoles()) await org.save();

  const access = resolveOrgAccess(org, userId);
  return { org, access, can: access.can, isOwner: access.isOwner };
};

module.exports = { loadBoardContext, requireCapability, loadOrgContext };
