const Organisation = require('../models/Organisation');
const {
  CAPABILITY_GROUPS,
  ALL_CAPABILITIES,
  BOARD_LEVELS,
  LEVEL_ADDS,
  OWNER_ONLY_CAPABILITIES,
  NEVER_IMPLICIT,
  OWNER_ROLE_KEY,
  DEFAULT_ROLE_KEY,
  sanitizePermissions,
} = require('../utils/capabilities');
const { loadOrgContext } = require('../utils/boardContext');
const { resolveOrgAccess } = require('../utils/permissions');

/**
 * Roles — the editor behind the permissions matrix.
 *
 * A role is a named bundle of capability keys (see
 * [capabilities.js](../utils/capabilities.js)). These endpoints are the CRUD for
 * that data; the matrix UI is just a table view of it.
 *
 * Two invariants are enforced here and never relaxed:
 *
 *  1. THE OWNER CANNOT BE CONSTRAINED. The `owner` role is not editable and the
 *     resolver ignores its stored permissions anyway. A matrix edit that could
 *     lock the owner out of their own workspace is a bug, not a feature.
 *
 *  2. OWNER-ONLY POWERS STAY OWNER-ONLY. Anything in OWNER_ONLY_CAPABILITIES is
 *     stripped from every role on write. (`org.manage_roles` used to be in that
 *     set; it is now grantable — by default the admin role holds it — so matrix
 *     editing can be delegated.)
 */

/** Turn a display name into a slug that won't collide with the system keys. */
const slugify = (name) =>
  String(name)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'role';

const uniqueKey = (org, base) => {
  const taken = new Set((org.roles || []).map((r) => r.key));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
};

const publicRole = (role, memberRoles) => ({
  id: role._id,
  key: role.key,
  name: role.name,
  description: role.description || '',
  color: role.color,
  isSystem: role.isSystem === true,
  isOwner: role.key === OWNER_ROLE_KEY,
  isDefault: role.key === DEFAULT_ROLE_KEY,
  permissions: role.permissions || [],
  memberCount: (memberRoles || []).filter(
    (m) => m.role.toString() === role._id.toString()
  ).length,
});

/**
 * GET /api/orgs/:id/roles
 *
 * Returns the catalog (so the client never hardcodes capability keys) alongside
 * the org's roles. Any member may READ the matrix — knowing who can do what is
 * not itself a privilege, and the UI needs it to render honest affordances.
 */
const listRoles = async (req, res) => {
  try {
    const ctx = await loadOrgContext(req.params.id, req.user.userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

    const { org } = ctx;
    if (org.ensureSystemRoles()) await org.save();

    return res.json({
      roles: org.roles.map((r) => publicRole(r, org.memberRoles)),
      catalog: {
        groups: CAPABILITY_GROUPS.map((g) => ({
          key: g.key,
          name: g.name,
          capabilities: g.capabilities.map(([key, description]) => ({
            key,
            description,
          })),
        })),
        ownerOnly: [...OWNER_ONLY_CAPABILITIES],
        neverImplicit: [...NEVER_IMPLICIT],
        boardLevels: BOARD_LEVELS.map((level) => ({
          key: level,
          adds: LEVEL_ADDS[level],
        })),
      },
      // Who holds what, so the matrix can show member counts and the members
      // table can show role chips without a second round trip.
      assignments: org.memberRoles.map((m) => ({
        user: m.user,
        role: m.role,
      })),
      canManage: ctx.can('org.manage_roles'),
    });
  } catch (err) {
    console.error('listRoles error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/orgs/:id/roles — create a custom role.
 * Body: { name, description?, color?, permissions?: string[] }
 */
const createRole = async (req, res) => {
  try {
    const ctx = await loadOrgContext(req.params.id, req.user.userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    if (!ctx.can('org.manage_roles')) {
      return res
        .status(403)
        .json({ error: 'You do not have permission to manage roles' });
    }

    const { name, description, color, permissions } = req.body;
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'Role name is required' });
    }

    const { org } = ctx;
    org.ensureSystemRoles();

    if (
      org.roles.some(
        (r) => r.name.toLowerCase() === String(name).trim().toLowerCase()
      )
    ) {
      return res.status(400).json({ error: 'A role with that name already exists' });
    }

    const role = {
      key: uniqueKey(org, slugify(name)),
      name: String(name).trim(),
      description: description ? String(description).trim() : '',
      color: color || '#6B7280',
      isSystem: false,
      // Unknown keys are dropped, and owner-only powers can never be handed out —
      // no matter what the client posts.
      permissions: sanitizePermissions(permissions).filter(
        (c) => !OWNER_ONLY_CAPABILITIES.has(c)
      ),
    };

    org.roles.push(role);
    await org.save();

    const created = org.roles[org.roles.length - 1];
    return res.status(201).json({ role: publicRole(created, org.memberRoles) });
  } catch (err) {
    console.error('createRole error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * PUT /api/orgs/:id/roles/:roleId — edit a role.
 *
 * System roles keep their key and cannot be renamed out of existence, but their
 * PERMISSIONS are editable — that is the whole point of the matrix. The owner
 * role is the one exception: it is not editable at all.
 */
const updateRole = async (req, res) => {
  try {
    const ctx = await loadOrgContext(req.params.id, req.user.userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    if (!ctx.can('org.manage_roles')) {
      return res
        .status(403)
        .json({ error: 'You do not have permission to manage roles' });
    }

    const { org } = ctx;
    org.ensureSystemRoles();

    const role = org.roles.id(req.params.roleId);
    if (!role) return res.status(404).json({ error: 'Role not found' });

    const { name, description, color, permissions } = req.body;

    // The owner holds everything implicitly, so there is nothing to edit — EXCEPT
    // any NEVER_IMPLICIT capability, which is withheld even from them until
    // deliberately turned on and so must stay togglable on the owner row.
    //
    // That set is empty today, which is why the guard is written against its
    // size rather than assuming it. With nothing to opt into, an owner-role write
    // has no legitimate shape and is refused outright — the old code would have
    // accepted it and silently stored `[]`, which reads as "the owner was just
    // stripped of everything" to anyone inspecting the document, however little
    // the resolver cares.
    if (role.key === OWNER_ROLE_KEY) {
      if (permissions === undefined || NEVER_IMPLICIT.size === 0) {
        return res.status(400).json({
          error:
            'The Owner role always has every permission and cannot be edited',
        });
      }
      const requested = new Set(sanitizePermissions(permissions));
      role.permissions = [...NEVER_IMPLICIT].filter((c) => requested.has(c));
      await org.save();
      return res.json({ role: publicRole(role, org.memberRoles) });
    }

    if (name !== undefined) {
      if (!String(name).trim()) {
        return res.status(400).json({ error: 'Role name cannot be empty' });
      }
      const clash = org.roles.some(
        (r) =>
          r._id.toString() !== role._id.toString() &&
          r.name.toLowerCase() === String(name).trim().toLowerCase()
      );
      if (clash) {
        return res
          .status(400)
          .json({ error: 'A role with that name already exists' });
      }
      role.name = String(name).trim();
    }

    if (description !== undefined) role.description = String(description).trim();
    if (color !== undefined) role.color = color;

    if (permissions !== undefined) {
      role.permissions = sanitizePermissions(permissions).filter(
        (c) => !OWNER_ONLY_CAPABILITIES.has(c)
      );
    }

    await org.save();
    return res.json({ role: publicRole(role, org.memberRoles) });
  } catch (err) {
    console.error('updateRole error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * DELETE /api/orgs/:id/roles/:roleId
 *
 * System roles are undeletable — `owner` is load-bearing and the rest are the
 * fallback every unassigned member lands on. Members holding a deleted custom
 * role are moved to the default role rather than being left with no role at all;
 * losing your role should not lock you out of the workspace.
 */
const deleteRole = async (req, res) => {
  try {
    const ctx = await loadOrgContext(req.params.id, req.user.userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    if (!ctx.can('org.manage_roles')) {
      return res
        .status(403)
        .json({ error: 'You do not have permission to manage roles' });
    }

    const { org } = ctx;
    const role = org.roles.id(req.params.roleId);
    if (!role) return res.status(404).json({ error: 'Role not found' });

    if (role.isSystem) {
      return res
        .status(400)
        .json({ error: 'Built-in roles cannot be deleted' });
    }

    const fallback = org.roleByKey(DEFAULT_ROLE_KEY);
    const roleId = role._id.toString();
    let reassigned = 0;

    org.memberRoles = (org.memberRoles || []).map((m) => {
      if (m.role.toString() !== roleId) return m;
      reassigned += 1;
      return { user: m.user, role: fallback._id };
    });

    org.roles.pull({ _id: role._id });
    await org.save();

    return res.json({ message: 'Role deleted', reassigned });
  } catch (err) {
    console.error('deleteRole error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Apply a role change to an org document IN MEMORY — the decision half of
 * `assignRole`, with the request and the response taken out of it.
 *
 * WHY THIS IS A FUNCTION AND NOT JUST THE HANDLER IT USED TO BE
 *
 * Declaring somebody an Executive (`controllers/executiveViewController.js`)
 * is a role change AND a profile creation, and the two have to be one sequence
 * over one loaded org document: assign, save once, then write the profile.
 * The obvious way to get there is to copy the rules below into that controller,
 * and the rules below are not the kind of thing to keep two copies of. Three of
 * them — the owner's role is unchangeable, you cannot hand out a role holding
 * capabilities you lack, you cannot change the role of somebody who outranks
 * you — ARE the security value of this endpoint. A second copy is a second
 * place for them to rot, and the rot would be silent: the copy keeps working,
 * it just stops refusing things.
 *
 * So the rules live here once, and both callers ask the same function.
 *
 * IT DELIBERATELY DOES NOT SAVE. The caller owns the write, because only the
 * caller knows whether this is the whole transaction (this endpoint: mutate,
 * save, respond) or the first half of one (declare: mutate, save, then create
 * the profile against the same document). A helper that saved would force
 * declare into a second round trip and a window in which the role exists and
 * the profile does not.
 *
 * @param {Object} org           A loaded Organisation document. MUTATED on success.
 * @param {string} targetUserId  Whose role is changing.
 * @param {Object} role          The role subdocument to give them, already looked
 *                               up by the caller — by id, by key, however it found it.
 * @param {Object} opts
 * @param {string} opts.actorUserId  Who is doing this. The two no-escalation
 *                                   checks are resolved against THEIR capabilities.
 *
 *                                   AN ID, AND NOT AN ALREADY-RESOLVED ACCESS
 *                                   OBJECT, deliberately. Both call sites are
 *                                   holding `ctx.access`, and passing it would
 *                                   save one `resolveOrgAccess` call — but this
 *                                   function is nothing except escalation
 *                                   guards, and a guard has to be judged
 *                                   against the org document it is about to
 *                                   MUTATE. Taking the id means the actor and
 *                                   the target are resolved the same way, here,
 *                                   against that document, and there is no way
 *                                   to hand this function a stale or
 *                                   wrong-workspace set of capabilities and have
 *                                   it quietly agree with them. A guard that can
 *                                   be fed its own answer is not a guard, and
 *                                   one `resolveOrgAccess` over an in-memory
 *                                   document is not a cost worth trading for it.
 * @param {boolean} opts.isOwner     Whether the actor is the workspace owner, in
 *                                   which case both checks are skipped — they hold
 *                                   every capability, so both pass trivially.
 *                                   Passed rather than recomputed because the
 *                                   caller already asked `loadOrgContext` and
 *                                   the answer travels on the context it
 *                                   returned; `isOrgOwner(org, actorUserId)`
 *                                   would agree with it on every call.
 * @returns {{status:number, error:string, missing?:string[]}|null}
 *          A refusal, whose non-`status` keys are the HTTP response body
 *          verbatim, or null when `org` has been mutated and is ready to save.
 */
const applyRoleAssignment = (
  org,
  targetUserId,
  role,
  { actorUserId, isOwner = false } = {}
) => {
  // `String(x?._id || x)` rather than `.toString()`: these refs arrive raw from
  // `loadOrgContext` today, but a POPULATED ref's toString() is its inspect
  // string and never the hex id. The safe idiom costs nothing here and removes
  // the trap for whoever populates this org one day.
  const idOf = (ref) => String(ref?._id || ref || '');
  const target = String(targetUserId);

  const isMember = org.members.some((m) => idOf(m) === target);
  if (!isMember) {
    return { status: 400, error: 'User is not a member of this workspace' };
  }

  // The owner's role is nobody's to change — not even their own. Demoting the
  // owner here would orphan the workspace's root of trust. Ownership moves
  // through POST /api/orgs/:id/transfer-ownership instead, which is one atomic
  // write that can never leave the org with zero owners or two.
  if (org.admin && idOf(org.admin) === target) {
    return {
      status: 400,
      error: "The workspace owner's role cannot be changed",
    };
  }

  if (!role) return { status: 400, error: 'Unknown role' };
  if (role.key === OWNER_ROLE_KEY) {
    return {
      status: 400,
      error:
        'There can only be one owner — use Transfer ownership rather than assigning the role',
    };
  }

  // You cannot hand out a role more powerful than your own. Without this an
  // admin could mint a custom role holding capabilities they lack, assign it to
  // an ally, and escalate by proxy. (The owner passes trivially — they hold
  // everything.)
  const mine = resolveOrgAccess(org, actorUserId).capabilities;
  if (!isOwner) {
    const excess = (role.permissions || []).filter((c) => !mine.has(c));
    if (excess.length) {
      return {
        status: 403,
        error:
          'You cannot assign a role with permissions you do not have yourself',
        missing: excess,
      };
    }
    // Same reasoning in the other direction: you cannot demote someone whose
    // current role outranks yours.
    const current = resolveOrgAccess(org, targetUserId);
    const targetExcess = [...current.capabilities].filter((c) => !mine.has(c));
    if (targetExcess.length) {
      return {
        status: 403,
        error: 'You cannot change the role of someone who outranks you',
      };
    }
  }

  org.memberRoles = (org.memberRoles || []).filter(
    (m) => idOf(m.user) !== target
  );
  org.memberRoles.push({ user: targetUserId, role: role._id });

  // Keep the legacy array truthful for the not-yet-migrated fallback path.
  const admins = new Set((org.admins || []).map((a) => idOf(a)));
  if (role.key === 'admin') admins.add(target);
  else admins.delete(target);
  org.admins = [...admins];

  return null;
};

/**
 * PUT /api/orgs/:id/members/:userId/role — assign a role to a member.
 * Body: { roleId } — or the legacy { role: 'admin' | 'member' }.
 *
 * The legacy shape is still accepted so the old client keeps working through the
 * rollout; it is translated to the system role of the same key.
 *
 * `org.admins[]` is kept in sync with the admin role. Nothing reads it for
 * permission decisions any more, but the resolver falls back to it for orgs that
 * have not been backfilled, and letting it rot would make that fallback lie.
 *
 * Everything from "is the target a member" down to that reconciliation now lives
 * in `applyRoleAssignment` above, which the executive-view controller shares.
 * What stays here is the HTTP shell: the capability gate, finding the role the
 * body names, the save, and the response.
 */
const assignRole = async (req, res) => {
  try {
    const { id: orgId, userId: targetUserId } = req.params;
    const ctx = await loadOrgContext(orgId, req.user.userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    if (!ctx.can('org.assign_roles')) {
      return res
        .status(403)
        .json({ error: 'You do not have permission to change roles' });
    }

    const { org } = ctx;
    org.ensureSystemRoles();

    const { roleId, role: legacyRole } = req.body;
    let role = null;
    if (roleId) {
      role = org.roles.id(roleId);
    } else if (legacyRole) {
      role = org.roleByKey(legacyRole);
    }

    const denied = applyRoleAssignment(org, targetUserId, role, {
      actorUserId: req.user.userId,
      isOwner: ctx.isOwner,
    });
    if (denied) {
      // Everything but `status` IS the body. The escalation refusal carries a
      // `missing` list the matrix renders, and that shape is part of the API.
      const { status, ...body } = denied;
      return res.status(status).json(body);
    }

    await org.save();

    return res.json({
      message: 'Role updated',
      role: publicRole(role, org.memberRoles),
      adminIds: org.admins.map((a) => a.toString()),
    });
  } catch (err) {
    console.error('assignRole error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

module.exports = {
  listRoles,
  createRole,
  updateRole,
  deleteRole,
  assignRole,
  // Exported for `executiveViewController.declare`, which assigns the Executive
  // role and creates the profile as one sequence and must not carry its own copy
  // of the escalation guards. See the function's header.
  applyRoleAssignment,
  publicRole,
  ALL_CAPABILITIES,
};
