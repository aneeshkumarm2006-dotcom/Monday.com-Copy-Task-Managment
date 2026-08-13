const mongoose = require('mongoose');
const TaskGroup = require('../models/TaskGroup');
const User = require('../models/User');
const Task = require('../models/Task');
const Update = require('../models/Update');
const Note = require('../models/Note');
const Notification = require('../models/Notification');
const ItemFollow = require('../models/ItemFollow');
const ClientContact = require('../models/ClientContact');
const Tracker = require('../models/Tracker');
const TrackerEntry = require('../models/TrackerEntry');
const Goal = require('../models/Goal');
const eventBus = require('../services/eventBus');
const { loadBoardContext, requireCapability } = require('../utils/boardContext');
const { requireFeature } = require('../utils/userFeatures');
const { ownerForMonth, setOwnerForMonth } = require('../utils/groupOwner');
const { isMonthKey, monthKeyOf, addMonths, compareMonthKeys } = require('../utils/monthKey');
const { generatePortalToken } = require('../utils/portalCrypto');
const { inviteContact } = require('../services/portalInviteService');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Longest a group name may be. Matches the clamp already used for board labels
// and statuses (boardController `sanitizeName`) so every user-authored label on
// a board obeys the same ceiling.
const MAX_GROUP_NAME = 60;

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Every group mutation on this board — create, rename, reorder, delete — is one
 * capability: `group.manage`. Restructuring a board's groups is a single power,
 * so it is a single gate.
 */

/**
 * Normalise and validate a user-supplied group name, then check it against the
 * rest of the board. Shared by create and rename so a board can never end up
 * with two groups the user can't tell apart — renaming used to be able to
 * produce exactly the collision create refuses.
 *
 * `excludeId` is the group being renamed: without it, saving a group under its
 * own unchanged name would collide with itself.
 *
 * Returns `{ name }` on success, or `{ error, status }` to hand straight back.
 */
const resolveGroupName = async (rawName, boardId, excludeId = null) => {
  // Trim again after the clamp: slicing can land mid-gap and leave a trailing space.
  const name = String(rawName).trim().slice(0, MAX_GROUP_NAME).trim();
  if (!name) {
    return { error: 'Group name is required', status: 400 };
  }

  const filter = {
    board: boardId,
    name: new RegExp(`^${escapeRegExp(name)}$`, 'i'),
  };
  if (excludeId) filter._id = { $ne: excludeId };

  const duplicate = await TaskGroup.findOne(filter).select('_id').lean();
  if (duplicate) {
    return {
      error: `A group named "${name}" already exists on this board. Please choose a different name.`,
      status: 409,
    };
  }

  return { name };
};

// ---------------------------------------------------------------------------
// Group owner (tracker boards) — resolution on the way out
// ---------------------------------------------------------------------------

/**
 * The timeline is server-internal. Nothing leaves this controller carrying it —
 * that is the enforcement mechanism behind "utils/groupOwner.js is the only
 * resolver". A client cannot derive a second, drifting answer from data it was
 * never given.
 */
const stripTimeline = (g) => {
  const { ownerTimeline, ...rest } = g;
  return rest;
};

/**
 * Which month should a group list resolve its owners against?
 *
 * Never trusts the client for "now" — a bad or absent `?month=` falls back
 * through `monthKeyOf` with the BOARD's timezone, per the rule at the top of
 * utils/monthKey.js. Returns null on any board that has no months.
 */
const resolveGroupMonth = (board, requested) => {
  if (board?.boardType !== 'tracker') return null;
  if (isMonthKey(requested)) return requested;
  return monthKeyOf(new Date(), board.monthTimezone || 'UTC');
};

/**
 * Attach each group's resolved owner for `monthKey`, and strip the raw timeline.
 *
 * On a non-tracker board this is JUST the strip, so standard and client boards
 * receive exactly the response they always did — `owner` is ABSENT, not null, so
 * nothing there can start depending on it.
 *
 * ONE batched User query for the whole board rather than a populate: populating
 * `ownerTimeline.user` would hydrate every historical entry of every group to
 * render one avatar each.
 *
 * Populating rather than returning a bare id also settles a permissions problem.
 * The org member list is only fetched client-side for board editors
 * (BoardDetailPage), because handing the workspace roster to everyone who can
 * open a public board would leak it. A viewer needs the owner's name and picture
 * but has no roster to look them up in — so the server sends the one user
 * actually being displayed, and the roster stays where it was.
 */
const serializeGroups = async (groups, { board, org, monthKey }) => {
  const plain = groups.map((g) => (g?.toObject ? g.toObject() : g));
  if (board?.boardType !== 'tracker' || !monthKey) return plain.map(stripTimeline);

  const resolved = plain.map((g) => ({ g, owner: ownerForMonth(g, monthKey) }));

  const ids = [...new Set(resolved.map((r) => r.owner.userId).filter(Boolean))];
  const users = ids.length
    ? await User.find({ _id: { $in: ids } }).select('name profilePic email').lean()
    : [];
  const byId = new Map(users.map((u) => [String(u._id), u]));
  const memberIds = new Set((org?.members || []).map((m) => String(m?._id || m)));

  return resolved.map(({ g, owner }) => ({
    ...stripTimeline(g),
    // The month this was resolved AGAINST. The client echoes it back on write,
    // which is what stops a stale tab assigning into a month nobody is looking at.
    ownerMonth: monthKey,
    owner: owner.userId ? byId.get(owner.userId) || null : null,
    ownerFromMonth: owner.fromMonth,
    ownerInherited: owner.inherited,
    // Removing someone from the org does NOT scrub the groups they owned — the
    // same rule Task.assignedTo already follows, and scrubbing would rewrite
    // history that was true at the time. Flagged rather than hidden, because the
    // group still needs a new owner.
    ownerActive: owner.userId ? memberIds.has(owner.userId) : true,
  }));
};

/**
 * GET /api/boards/:boardId/groups?month=YYYY-MM
 *
 * List groups for a board, sorted by order asc then createdAt asc.
 * Anyone who can read the board can list its groups — `loadBoardContext` already
 * rejects users who cannot, so there is no further gate here.
 *
 * On a tracker board `month` selects which owner each group resolves to. Note
 * the deliberate asymmetry with `getTasks`, which REQUIRES a month and 400s
 * without one: groups are the board's skeleton, and a month with no tasks must
 * still render every group, so failing the whole list over a decoration would
 * blank the board. A missing or malformed month falls back to the board's
 * current month instead. (Tasks are the opposite case: silently returning three
 * years of them is worse than an error.)
 */
const getGroups = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { boardId } = req.params;

    const ctx = await loadBoardContext(boardId, userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

    const groups = await TaskGroup.find({ board: boardId })
      .sort({ order: 1, createdAt: 1 })
      .lean();

    return res.json({
      groups: await serializeGroups(groups, {
        board: ctx.board,
        org: ctx.org,
        monthKey: resolveGroupMonth(ctx.board, req.query.month),
      }),
    });
  } catch (err) {
    console.error('getGroups error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/boards/:boardId/groups
 *
 * Requires `group.manage`. Creates a new group. If `order` is not provided, it
 * is set to the next available order number (count of existing groups).
 */
const createGroup = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { boardId } = req.params;
    const { name, order, clientEmail, clientName, clientAuthMethod } = req.body;

    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Group name is required' });
    }

    const ctx = await loadBoardContext(boardId, userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    const denied = requireCapability(
      ctx,
      'group.manage',
      'You do not have permission to create groups'
    );
    if (denied) return res.status(denied.status).json({ error: denied.error });

    // Trim, clamp, and reject a duplicate name on this board (case-insensitive).
    const resolved = await resolveGroupName(name, boardId);
    if (resolved.error) {
      return res.status(resolved.status).json({ error: resolved.error });
    }
    const groupName = resolved.name;

    let resolvedOrder = order;
    if (typeof resolvedOrder !== 'number') {
      resolvedOrder = await TaskGroup.countDocuments({ board: boardId });
    }

    // Client Portal boards mint the shareable link AT CREATION and turn the
    // portal on immediately — the link exists the moment the group does, so it
    // can be shared or emailed straight away. A trimmed client email, if given,
    // gets the invitation. Standard boards are untouched.
    const isClientBoard = ctx.board.boardType === 'client';
    const inviteEmail = (clientEmail || '').trim().toLowerCase();
    const portalFields = isClientBoard
      ? {
          portalToken: generatePortalToken(),
          portalEnabled: true,
          portalClientName: (clientName || '').trim() || groupName,
        }
      : {};

    const group = await TaskGroup.create({
      name: groupName,
      board: boardId,
      order: resolvedOrder,
      ...portalFields,
    });

    // Send the invitation email (best-effort — never fails the create).
    // `clientAuthMethod` says how this client signs in: 'google' (the shared
    // link) or 'password' (register the address and mail a one-time set-password
    // link). inviteContact writes the ClientContact row and picks the email.
    let inviteSent = false;
    if (isClientBoard && EMAIL_RE.test(inviteEmail)) {
      try {
        const { ok } = await inviteContact({
          group,
          board: ctx.board,
          email: inviteEmail,
          authMethod: clientAuthMethod === 'password' ? 'password' : 'google',
        });
        inviteSent = ok;
      } catch (inviteErr) {
        console.error('createGroup invite error:', inviteErr);
      }
    }

    // Fan out a group.created event so GROUP_CREATED automations can
    // spawn predefined tasks into the new group. The dispatcher fetches
    // the live group doc itself, so we only need the ids + name here.
    eventBus.emit('group.created', {
      groupId: group._id,
      groupName: group.name,
      boardId,
      createdByUserId: userId,
    });

    // A brand-new group's timeline is empty, but the rule is "nothing leaves
    // this controller carrying it" — no exceptions to audit later. Creation
    // deliberately does not accept an owner: one write path, one set of gates.
    const [serialized] = await serializeGroups([group], {
      board: ctx.board,
      org: ctx.org,
      monthKey: resolveGroupMonth(ctx.board, null),
    });
    return res.status(201).json({ group: serialized, inviteSent });
  } catch (err) {
    console.error('createGroup error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * PUT /api/groups/:id
 *
 * Requires `group.manage`. Updates name, order, tags, or the owner.
 *
 * A rename runs the same trim/clamp/duplicate checks as create (excluding this
 * group, so re-saving an unchanged name is not a self-collision). It
 * deliberately leaves `portalClientName` alone: on a client board that field is
 * the client-facing company label, seeded from the name at creation but owned
 * from then on by the portal config screen. Renaming the group internally must
 * not rewrite what the client sees.
 *
 * `tags` carries a SECOND gate beyond `group.manage`: the caller's own
 * `features.groupTags` opt-in, since group tags are an extra feature that is off
 * for everyone by default. It is checked only when `tags` is actually present,
 * so a plain rename or reorder never pays for the lookup — or trips over a flag
 * that has nothing to do with it.
 *
 * `owner` + `ownerMonth` pin who is responsible for this group FROM that month
 * onward. Tracker boards only, and it carries no feature flag: unlike group
 * tags, ownership is part of what a tracker board IS, and hiding who is
 * responsible behind a personal switch would defeat the point. See
 * utils/groupOwner.js for why this is a timeline rather than a single field.
 */
const updateGroup = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    const { name, order, tags, owner, ownerMonth } = req.body;

    const group = await TaskGroup.findById(id);
    if (!group) return res.status(404).json({ error: 'Group not found' });

    const ctx = await loadBoardContext(group.board, userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    const denied = requireCapability(
      ctx,
      'group.manage',
      'You do not have permission to edit groups'
    );
    if (denied) return res.status(denied.status).json({ error: denied.error });

    if (typeof name === 'string') {
      if (!name.trim()) {
        return res.status(400).json({ error: 'Group name cannot be empty' });
      }
      const resolved = await resolveGroupName(name, group.board, group._id);
      if (resolved.error) {
        return res.status(resolved.status).json({ error: resolved.error });
      }
      group.name = resolved.name;
    }
    if (typeof order === 'number') {
      group.order = order;
    }

    if (tags !== undefined) {
      if (!Array.isArray(tags)) {
        return res.status(400).json({ error: 'tags must be an array' });
      }
      const off = await requireFeature(
        userId,
        'groupTags',
        'Group tags are off. Turn them on in Settings → Extra features.'
      );
      if (off) {
        return res.status(off.status).json({ error: off.error, code: off.code });
      }
      // Only ids that exist in the board's catalog survive, de-duped. An unknown
      // id is dropped rather than 400'd: a tag the picker showed can be deleted
      // by someone else between render and save, and losing that one chip is a
      // better outcome than rejecting the whole edit.
      const known = new Set(
        (ctx.board.groupTags || []).map((t) => t._id.toString())
      );
      const seen = new Set();
      group.tags = tags
        .map((t) => (t == null ? '' : t.toString()))
        .filter((t) => {
          if (!known.has(t) || seen.has(t)) return false;
          seen.add(t);
          return true;
        });
    }

    // The month the RESPONSE is resolved against — the one the caller was
    // looking at, so the avatar they get back is the one they just set.
    let resolveMonth = null;

    if (owner !== undefined) {
      // 1. TRACKER GATE. 400 rather than goalController's 404: there, the whole
      //    route does not exist on a standard board. Here the group and the
      //    route are real and readable — it is this one FIELD that does not
      //    apply.
      if (ctx.board.boardType !== 'tracker') {
        return res.status(400).json({
          error: 'Group owners are only available on tracker boards',
          code: 'NOT_TRACKER_BOARD',
        });
      }

      // 2. MONTH. Absent or malformed falls back to the board's current month.
      //    A month more than one ahead is refused, matching the ceiling the
      //    month picker itself offers: without the clamp you could bury an entry
      //    in 2031 that silently activates later and that no UI can show you.
      const tz = ctx.board.monthTimezone || 'UTC';
      const currentKey = monthKeyOf(new Date(), tz);
      const month = isMonthKey(ownerMonth) ? ownerMonth : currentKey;
      if (!month) {
        return res.status(400).json({ error: 'This board has no valid month timezone' });
      }
      if (compareMonthKeys(month, addMonths(currentKey, 1)) > 0) {
        return res.status(400).json({ error: 'That month is too far ahead' });
      }

      // 3. OWNER. null writes a tombstone ("unassigned from here on"). Anything
      //    else must be a member of this org.
      //
      //    A non-member is a 400, deliberately breaking the `tags` precedent
      //    above. `tags` is a SET, so dropping one unknown id still lands the
      //    rest of the edit and the race that causes it is benign. `owner` is a
      //    SCALAR: dropping it would mean the request did nothing while the
      //    server said 200, and the user would watch their optimistic avatar
      //    silently revert with no explanation. And the analogous race — the
      //    person left the workspace between the menu rendering and the save —
      //    is exactly when saying so beats silence.
      let ownerId = null;
      if (owner !== null) {
        ownerId = String(owner?._id || owner || '');
        const isMember = (ctx.org.members || [])
          .some((m) => String(m?._id || m) === ownerId);
        if (!mongoose.Types.ObjectId.isValid(ownerId) || !isMember) {
          return res.status(400).json({
            error: 'That person is not a member of this workspace',
          });
        }
      }

      // 4. GENESIS BACKFILL. The first owner a group ever gets, assigned while
      //    looking at the CURRENT month, reaches back to the group's birth month
      //    instead. A first assignment is a statement of fact rather than a
      //    change of guard — there is no prior attribution it could overwrite —
      //    and without this you turn the feature on in September, assign
      //    everyone, flip to August and see nothing, which reads as a bug on day
      //    one. An assignment made while looking at an OLDER month is an
      //    explicit historical claim and is honoured exactly.
      const firstEver = (group.ownerTimeline || []).length === 0;
      const effectiveMonth = firstEver && month === currentKey
        ? (monthKeyOf(group.createdAt, tz) || month)
        : month;

      const next = setOwnerForMonth(group.ownerTimeline, effectiveMonth, ownerId, userId);
      if (next.changed) group.ownerTimeline = next.timeline;
      resolveMonth = month;
    }

    await group.save();

    const [serialized] = await serializeGroups([group], {
      board: ctx.board,
      org: ctx.org,
      monthKey: resolveMonth || resolveGroupMonth(ctx.board, null),
    });
    return res.json({ group: serialized });
  } catch (err) {
    console.error('updateGroup error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * DELETE /api/groups/:id
 *
 * Requires `group.manage`. Cascade deletes the group's tasks and their comments.
 */
const deleteGroup = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;

    const group = await TaskGroup.findById(id);
    if (!group) return res.status(404).json({ error: 'Group not found' });

    const ctx = await loadBoardContext(group.board, userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    const denied = requireCapability(
      ctx,
      'group.manage',
      'You do not have permission to delete groups'
    );
    if (denied) return res.status(denied.status).json({ error: denied.error });

    // Cascade: find tasks in this group, delete their updates, then tasks,
    // then the group itself.
    const taskIds = await Task.distinct('_id', { group: id });
    if (taskIds.length > 0) {
      await Update.deleteMany({ task: { $in: taskIds } });
      await Notification.deleteMany({ task: { $in: taskIds } });
      await ItemFollow.deleteMany({ task: { $in: taskIds } });
    }
    await Note.deleteMany({ group: id });
    await Task.deleteMany({ group: id });
    // Client Portal cleanup: a group can be a client's portal, so drop its
    // external contacts with it.
    await ClientContact.deleteMany({ group: id });
    // Tracker cleanup: drop this group's confirmations/waivers, and take it out
    // of any tracker that named it explicitly.
    //
    // The subtle part is the last step. On a Tracker, `groups: []` means EVERY
    // group — so a tracker that only watched this one group would, after the
    // $pull, silently widen to the whole board. We collect the trackers that
    // named it BEFORE pulling (a tracker already on "all groups" never matches
    // this query, so it is never touched) and disable only the ones the pull
    // actually emptied.
    await TrackerEntry.deleteMany({ group: id });
    // A goal belongs to exactly one group, so deleting the group deletes them.
    await Goal.deleteMany({ group: id });
    const scopedTrackerIds = await Tracker.distinct('_id', {
      board: group.board,
      groups: id,
    });
    if (scopedTrackerIds.length > 0) {
      await Tracker.updateMany(
        { _id: { $in: scopedTrackerIds } },
        { $pull: { groups: id } }
      );
      await Tracker.updateMany(
        { _id: { $in: scopedTrackerIds }, groups: { $size: 0 } },
        { $set: { enabled: false } }
      );
    }
    await TaskGroup.deleteOne({ _id: id });

    return res.json({ success: true });
  } catch (err) {
    console.error('deleteGroup error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * PUT /api/boards/:boardId/groups/reorder
 *
 * Body: { orderedIds: [groupId,...] }
 * Reorders all groups on the board in a single bulk write. Requires
 * `group.manage`: reordering rewrites the board's structure for everyone who
 * opens it, so it is the same power as renaming or deleting a group — not a
 * personal view preference.
 */
const reorderGroups = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { boardId } = req.params;
    const orderedIds = Array.isArray(req.body?.orderedIds) ? req.body.orderedIds : null;
    if (!orderedIds) {
      return res.status(400).json({ error: 'orderedIds must be an array' });
    }

    const ctx = await loadBoardContext(boardId, userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    const denied = requireCapability(
      ctx,
      'group.manage',
      'You do not have permission to reorder groups'
    );
    if (denied) return res.status(denied.status).json({ error: denied.error });

    const currentIds = await TaskGroup.distinct('_id', { board: boardId });
    const currentSet = new Set(currentIds.map((id) => id.toString()));
    const orderedSet = new Set(orderedIds.map((id) => String(id)));
    // The de-duped size must equal the raw length. Comparing only the raw length
    // against the board's group count while membership-checking the SET lets a
    // payload like ['a','a'] through on a two-group board: it is the right length
    // and every distinct id exists, so the bulk write reorders 'a' twice and
    // strands the omitted group at its old `order`. Duplicates are corruption,
    // not a permutation.
    if (
      orderedIds.length !== currentIds.length ||
      orderedSet.size !== orderedIds.length ||
      ![...orderedSet].every((id) => currentSet.has(id))
    ) {
      return res
        .status(400)
        .json({ error: 'orderedIds must list every group on the board exactly once' });
    }

    const ops = orderedIds.map((id, idx) => ({
      updateOne: {
        filter: { _id: id, board: boardId },
        update: { $set: { order: idx } },
      },
    }));
    if (ops.length > 0) await TaskGroup.bulkWrite(ops);

    // Serialized like getGroups, not returned raw. The client replaces its whole
    // group list with this response, so shipping owner-less docs here would wipe
    // every avatar on the board until the next full load.
    const groups = await TaskGroup.find({ board: boardId })
      .sort({ order: 1, createdAt: 1 })
      .lean();
    return res.json({
      groups: await serializeGroups(groups, {
        board: ctx.board,
        org: ctx.org,
        monthKey: resolveGroupMonth(ctx.board, req.query.month),
      }),
    });
  } catch (err) {
    console.error('reorderGroups error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

module.exports = {
  getGroups,
  createGroup,
  updateGroup,
  deleteGroup,
  reorderGroups,
};
