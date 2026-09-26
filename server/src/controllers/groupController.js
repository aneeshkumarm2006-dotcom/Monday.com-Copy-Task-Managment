const mongoose = require('mongoose');
const TaskGroup = require('../models/TaskGroup');
const Task = require('../models/Task');
const Update = require('../models/Update');
const Note = require('../models/Note');
const Notification = require('../models/Notification');
const ItemFollow = require('../models/ItemFollow');
const ActivityLog = require('../models/ActivityLog');
const Automation = require('../models/Automation');
const Tracker = require('../models/Tracker');
const TrackerEntry = require('../models/TrackerEntry');
const Goal = require('../models/Goal');
const AdsBudget = require('../models/AdsBudget');
const GoalConnectorLink = require('../models/GoalConnectorLink');
const ConnectorProject = require('../models/ConnectorProject');
const eventBus = require('../services/eventBus');
const { invalidateMirrorsForDeletedTasks } = require('../services/mirrorRefresh');
const ClientContact = require('../models/ClientContact');
const { deleteSurfacesForGroup, createSurfaces } = require('../services/workstreamSurfaces');
const { isClientBoard } = require('../utils/clientBoard');
const { destroyCloudinaryAssets, destroyLogos } = require('../config/cloudinary');
const { destroyFileColumnAssets } = require('../utils/fileColumnAssets');
const { recordServiceUse } = require('../services/serviceCatalogService');
const { ensurePortalLive } = require('../utils/portalActivation');
const { loadBoardContext, requireCapability } = require('../utils/boardContext');
const { requireFeature } = require('../utils/userFeatures');
const { setOwnerForMonth } = require('../utils/groupOwner');
const { resolveOwnerDisplay, EMPTY_OWNER_DISPLAY } = require('../services/groupOwnerDisplay');
const { isMonthKey, monthKeyOf, addMonths, compareMonthKeys } = require('../utils/monthKey');
const {
  logGroupCreated,
  logGroupRenamed,
  logGroupDeleted,
} = require('../services/groupActivity');

// Longest a group name may be. Matches the clamp already used for board labels
// and statuses (boardController `sanitizeName`) so every user-authored label on
// a board obeys the same ceiling.
const MAX_GROUP_NAME = 60;

// The User fields a group's byline needs, and the only ones it may carry. Same
// projection the task/automation reads use, so a person's chip looks identical
// wherever it is drawn.
const CREATOR_FIELDS = 'name profilePic email';

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
 * ---- WHY THIS REPORTS A COLLISION RATHER THAN REFUSING ONE ----------------
 *
 * It used to return `{ error, status: 409 }` and callers handed that straight
 * back. That is right for `createGroup`, where the request means "make me a NEW
 * group" and an existing one of that name is a mistake — but wrong for the batch
 * invite (`services/portalBatchInvite.js`), where a row reading
 * `SEO / asha@acme.com` on a board that already has an SEO service is the normal
 * second-invite case and must resolve to the existing group.
 *
 * So this reports the FACT and lets each caller pick the policy:
 *
 *   { name }                     — free, nothing else on the board holds it
 *   { name, duplicate: <group> }  — taken; createGroup 409s, the batch reuses it
 *   { error, status: 400 }        — the name is empty, which is never valid
 *
 * One function, two policies. The alternative — a second copy of the trim, the
 * clamp and the case-insensitive check inside the invite service — is how the
 * two drift and a board ends up with "SEO" and "seo".
 *
 * Exported for that reason; it was module-private while this file was its only
 * caller.
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

  // The whole document, not just `_id`: the batch invite reuses it directly
  // rather than issuing a second read for the group it was just told about.
  const duplicate = await TaskGroup.findOne(filter);
  if (duplicate) return { name, duplicate };

  return { name };
};

/**
 * The 409 `createGroup` and `updateGroup` both raise for a taken name. Here so
 * the sentence is written once and the two paths cannot drift apart.
 */
const duplicateGroupNameError = (name) => ({
  error: `A group named "${name}" already exists on this board. Please choose a different name.`,
  status: 409,
});

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

  // The resolve-and-hydrate itself lives in services/groupOwnerDisplay.js, so
  // the Goals tab reads the owner through the same code the board does.
  const display = await resolveOwnerDisplay(plain, monthKey, org);

  return plain.map((g) => ({
    ...stripTimeline(g),
    ...(display.get(String(g._id)) || EMPTY_OWNER_DISPLAY),
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
      .populate('createdBy', CREATOR_FIELDS)
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
    const { name, order } = req.body;

    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Group name is required' });
    }

    // `+portalToken` because a group on a CLIENT board is a service, and the
    // first service on a board is what mints that board's portal link (see the
    // block further down). Without the projection `!board.portalToken` reads
    // true on a board that has one and `ensurePortalLive` would ROTATE A LIVE
    // CLIENT LINK on every service create - the trap `loadManageContext` and
    // `Board.portalToken` both write down. The token is never serialized out of
    // here: this endpoint returns groups, not the board.
    const ctx = await loadBoardContext(boardId, userId, { select: '+portalToken' });
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    const denied = requireCapability(
      ctx,
      'group.manage',
      'You do not have permission to create groups'
    );
    if (denied) return res.status(denied.status).json({ error: denied.error });

    // Trim, clamp, and reject a duplicate name on this board (case-insensitive).
    // This endpoint means "make me a NEW group", so a name that is taken is a
    // mistake — unlike the batch invite, which reuses the existing group.
    const resolved = await resolveGroupName(name, boardId);
    if (resolved.error) {
      return res.status(resolved.status).json({ error: resolved.error });
    }
    if (resolved.duplicate) {
      const denial = duplicateGroupNameError(resolved.name);
      return res.status(denial.status).json({ error: denial.error });
    }
    const groupName = resolved.name;

    let resolvedOrder = order;
    if (typeof resolvedOrder !== 'number') {
      resolvedOrder = await TaskGroup.countDocuments({ board: boardId });
    }

    // A group on a client board is a SERVICE (SEO, Meta Ads, Web Development),
    // not a client.
    //
    // Two things are different on a client board. First, the group is recorded
    // against the organisation's service catalog, so the next client board's
    // invite table offers this name in its dropdown. `serviceKey` is a slug and
    // may be null — a name made only of punctuation slugs to nothing, and a
    // group with no service key is simply a group with a name, which is what it
    // always was.
    //
    // Second, and this one used to be the opposite: THE PORTAL LINK IS THIS
    // FUNCTION'S BUSINESS NOW. A client board is created without a token and
    // with the portal off, because a portal with no services opens on "Your
    // portal is being set up" and a link handed over in that state is worth
    // nothing. The first service to land is what makes the board's link real.
    // See `utils/portalActivation.js`, which is the only implementation of
    // that rule.
    const isClient = isClientBoard(ctx.board);
    let serviceKey = null;
    if (isClient) {
      const entry = await recordServiceUse({
        orgId: ctx.board.organisation,
        name: groupName,
        actorId: userId,
      });
      serviceKey = entry ? entry.slug : null;
    }

    const group = await TaskGroup.create({
      name: groupName,
      board: boardId,
      order: resolvedOrder,
      createdBy: userId,
      serviceKey,
    });

    let portalActivated = false;
    if (isClient) {
      // ---- THE PORTAL GOES LIVE, AND IT MUST HAPPEN BEFORE THE ROOMS -----
      //
      // AFTER the group exists: minting a link and then failing to create the
      // service would leave exactly the dead link this change removes.
      //
      // BEFORE `createSurfaces`, and that ORDER IS LOAD-BEARING.
      // `workstreamSurfaces.createSurfaces` gates client-facing rooms on
      // `isLiveClientBoard(board)`, which is `boardType === 'client' &&
      // portalEnabled === true`. A client board is now born with `portalEnabled`
      // unset, so calling it first would silently REFUSE the client chat and the
      // client mailbox on the very first service of every new board — the team
      // room would be made, the two client rooms would not, and the only sign
      // would be `refusals` nobody reads. Activating first is what makes the
      // gate answer honestly.
      //
      // Idempotent: every service after the first finds both already true and
      // this writes nothing.
      //
      // BEST-EFFORT AND SWALLOWED, on the same argument as the surfaces below:
      // a service that exists without its link is healable (open portal
      // settings, or add the next service), whereas a group create that 500s
      // because `board.save()` raced is a worse outcome than the missing link.
      let portalLive = false;
      try {
        const portal = await ensurePortalLive(ctx.board);
        portalActivated = portal.changed;
        portalLive = portal.live;
      } catch (portalErr) {
        console.error('createGroup portal activation error:', portalErr);
      }

      // Every service can be talked about from the day it exists. See
      // services/workstreamSurfaces.js for why this reverses that file's
      // original "a client workstream starts with NOTHING" position.
      //
      // BEST-EFFORT AND SWALLOWED, deliberately. A channel that failed to mint
      // is healable — reopen the setup modal, or run the migration's
      // --backfill-surfaces — whereas a group create that 500s because a chat
      // room could not be made is a worse outcome than the missing room.
      // Idempotent under Channel's unique index, so a retry converges rather
      // than duplicating.
      //
      // ASK ONLY FOR WHAT THE BOARD CAN HAVE. `planSurfaces` refuses the WHOLE
      // selection when a client-facing room is requested on a board that is not
      // live — the private team room along with it. On a board whose portal was
      // deliberately DISABLED that is exactly the situation, so requesting the
      // client pair unconditionally would leave a new service with no rooms at
      // all rather than with the one it is entitled to. The client chat and
      // mailbox are minted later by `SetUpCommunicationModal` or the
      // migration's --backfill-surfaces, once somebody turns the portal back on.
      try {
        await createSurfaces(
          ctx.board,
          group,
          { clientChat: portalLive, clientMail: portalLive, team: true },
          { createdBy: userId }
        );
      } catch (surfaceErr) {
        console.error('createGroup surfaces error:', surfaceErr);
      }
    }

    // Record the creation. `createdBy` above already carries the byline, but
    // that dies with the group — this row is what still answers "who set this
    // up" after somebody deletes it.
    //
    // AWAITED, like every other logger in goalController and adsBudgetController:
    // `logActivity` swallows its own errors and can never reject, so awaiting
    // costs one round trip and buys the guarantee that the row exists before the
    // caller is told the group does.
    await logGroupCreated({ group, board: ctx.board, actor: userId });

    // Fan out a group.created event so GROUP_CREATED automations can
    // spawn predefined tasks into the new group. The dispatcher fetches
    // the live group doc itself, so we only need the ids + name here.
    eventBus.emit('group.created', {
      groupId: group._id,
      groupName: group.name,
      boardId,
      createdByUserId: userId,
    });

    // Hydrate the byline before it goes out. Every write path returns a group
    // the client swaps into its list wholesale, so an unpopulated `createdBy`
    // here does not merely omit the author — it replaces a hydrated one with a
    // bare id and blanks the chip until the next full load.
    await group.populate('createdBy', CREATOR_FIELDS);

    // A brand-new group's timeline is empty, but the rule is "nothing leaves
    // this controller carrying it" — no exceptions to audit later. Creation
    // deliberately does not accept an owner: one write path, one set of gates.
    const [serialized] = await serializeGroups([group], {
      board: ctx.board,
      org: ctx.org,
      monthKey: resolveGroupMonth(ctx.board, null),
    });
    // `portalActivated` is true exactly once per client board: on the service
    // that brought its portal to life. The UI says "the client link is now
    // live" on the back of it, and says nothing on every service after.
    return res.status(201).json({ group: serialized, portalActivated });
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

    // The name as it stood before this request. Captured here rather than read
    // back after `group.save()`, which would compare the document to its own
    // mutated self and find no change at all.
    const nameBefore = group.name;

    if (typeof name === 'string') {
      if (!name.trim()) {
        return res.status(400).json({ error: 'Group name cannot be empty' });
      }
      const resolved = await resolveGroupName(name, group.board, group._id);
      if (resolved.error) {
        return res.status(resolved.status).json({ error: resolved.error });
      }
      if (resolved.duplicate) {
        const denial = duplicateGroupNameError(resolved.name);
        return res.status(denial.status).json({ error: denial.error });
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

    // Only a real rename writes a row. `resolveGroupName` trims and de-dupes,
    // so a save that re-sends the same name — the tags-only and order-only
    // paths both do — resolves back to what was already there and logs nothing.
    await logGroupRenamed({
      group,
      board: ctx.board,
      from: nameBefore,
      to: group.name,
      actor: userId,
    });

    await group.populate('createdBy', CREATOR_FIELDS);

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

// ---------------------------------------------------------------------------
// Automations that named the group being deleted
// ---------------------------------------------------------------------------

/**
 * Work out what a group delete has to do to the board's automation rules.
 *
 * ---- WHY THIS EXISTS AT ALL -----------------------------------------------
 *
 * `boardController.deleteBoard` already writes this bug down one scope up:
 * "the scheduler keeps picking up orphaned SCHEDULE automations forever,
 * spawning tasks against a board that no longer exists and emailing their
 * assignees." Every word of that is true one level down as well. An Automation
 * names a TaskGroup in three places — `taskTemplate.group`, the `group` inside
 * a CREATE_TASK action's config, and the `value` of an ITEM_IN_GROUP condition
 * — and until now deleting a group repaired none of them. A rule pointed at a
 * dead group goes on creating Tasks with a `group` that resolves to nothing:
 * rows that render on no board (the board view buckets by live group) but do
 * reach My Work and do email their assignees, every run, forever, with nothing
 * in the Automations list to say which rule is doing it.
 *
 * ---- THE SPLIT, WHICH IS THE WHOLE POINT OF THIS FUNCTION -----------------
 *
 * The three pointers fail in two OPPOSITE directions, so they cannot get the
 * same treatment:
 *
 *   SPAWNERS over-fire. The dead group is where the rule PUTS things, so it
 *   keeps running and keeps manufacturing ghost rows and mail. This is active
 *   damage and has to stop on the way out of the delete.
 *
 *   SCOPED rules under-fire. The dead group is the "Runs for" gate the rule is
 *   matched AGAINST (automationEventDispatcher `evaluateConditions`), so the
 *   moment the group is gone the rule can never match again. It does no damage
 *   at all — it simply stops working while still reading Enabled in the list,
 *   which is the kind of silence people debug for a week.
 *
 * Both are disabled, for different reasons: a spawner because it is harmful,
 * a scoped rule because it is lying. Only the spawner gets `nextRunAt` cleared,
 * because `nextRunAt` is the cron runner's queue key and an ITEM_CREATED rule
 * is not on that queue — `updateAutomation` makes exactly the same distinction
 * when it disables a rule.
 *
 * ---- THREE THINGS THIS DELIBERATELY DOES NOT DO ---------------------------
 *
 * It does not DELETE the rules. The Tracker block a few lines below is the
 * precedent: a tracker the group-pull emptied is disabled, not destroyed, so
 * its owner can retarget it. A rule is somebody's configuration, and losing it
 * silently because a group went away is worse than finding it switched off.
 *
 * It does not `$pull` the dead action or the dead condition. Pulling an action
 * is unrecoverable, and — worse — emptying `actions` hands the run path back to
 * a stale `taskTemplate` (`runAutomationOnce` falls through to the legacy
 * template when `actions` is empty), so a rule converted SCHEDULE -> ITEM_CREATED
 * would START spawning an old template on every item created. Pulling a
 * CONDITION is worse still and in the other direction: an empty `conditions`
 * array means "match everything", so removing the dead ITEM_IN_GROUP gate would
 * widen a rule scoped to one client group into one that fires on every task
 * created on the board. That is the identical trap the `Tracker.groups: []`
 * comment below spells out, and the reason the dead pointer is left in place:
 * a condition that can never match is the SAFE failure mode.
 *
 * It does not touch anything that merely mentions the id. A POST_TO_CHANNEL
 * action naming the dead group is already safe — `services/chatSystemPost.js`
 * returns null and posts nowhere when the group is gone — and a CREATE_SUBITEM
 * ignores `config.group` entirely (it inherits the triggering task's), so
 * neither makes a rule a spawner.
 *
 * ---- THE TWO PREDICATES, PRECISELY ----------------------------------------
 *
 * A rule spawns into the dead group when either is true:
 *   - it has a CREATE_TASK action whose `config.group` is the dead id; or
 *   - it has NO actions and its `taskTemplate.group` is the dead id. The
 *     "no actions" half is load-bearing in both directions. `runAutomationOnce`
 *     runs `actions` when there are any and only otherwise falls back to the
 *     template, so a rule flipped SCHEDULE -> ITEM_CREATED keeps a vestigial
 *     `taskTemplate` that never runs — disabling it over a pointer nothing
 *     reads would switch off a working rule. Conversely a rule with no actions
 *     DOES run its template whatever its trigger, so this is not narrowed to
 *     SCHEDULE either.
 *
 * GROUP_CREATED rules are skipped outright, before any of that. They are
 * answered entirely by `groupCreatedTaskTemplates`, they are BORN with
 * `actions: []` and no `taskTemplate`, and their target group is the one that
 * just got created at run time. A predicate keyed on an empty `actions` array
 * would match every one of them on the board, so deleting any group would
 * silently disable every GROUP_CREATED rule the workspace has.
 *
 * The scoped arm is restricted to ITEM_CREATED for the mirror-image reason.
 * `updateAutomation` never clears `conditions` when the trigger type changes,
 * and the cron runner queries by `triggerType`/`nextRunAt` and never calls
 * `evaluateConditions` at all — so a SCHEDULE rule can legitimately carry a
 * leftover ITEM_IN_GROUP condition that nothing ever reads. That rule is
 * healthy and must be left alone.
 *
 * Pure, and exported, because the split above is the decision worth pinning —
 * see groupAutomationRepair.test.js. The caller reads the board's automations
 * into memory rather than filtering in Mongo for two reasons: a condition's
 * `value` is stored as a STRING (`sanitizeConditions` writes `valueId`) while
 * the two group refs are ObjectIds, so one query cannot match all three paths;
 * and a board's rule list is small enough that one indexed read is cheaper than
 * getting that type mismatch subtly wrong.
 *
 * Returns two disjoint id lists: `{ spawnerIds, scopedIds }`.
 */
const planAutomationRepair = (automations, groupId) => {
  const dead = String(groupId);
  const spawnerIds = [];
  const scopedIds = [];

  for (const automation of automations || []) {
    if (!automation?._id) continue;
    const trigger = automation.triggerType || 'SCHEDULE';
    if (trigger === 'GROUP_CREATED') continue;

    const actions = Array.isArray(automation.actions) ? automation.actions : [];

    const spawnsViaAction = actions.some(
      (action) =>
        action?.type === 'CREATE_TASK' &&
        action?.config?.group != null &&
        String(action.config.group) === dead
    );
    const spawnsViaTemplate =
      actions.length === 0 &&
      automation.taskTemplate?.group != null &&
      String(automation.taskTemplate.group) === dead;

    if (spawnsViaAction || spawnsViaTemplate) {
      spawnerIds.push(automation._id);
      continue;
    }

    const conditions = Array.isArray(automation.conditions)
      ? automation.conditions
      : [];
    const scopedToDead =
      trigger === 'ITEM_CREATED' &&
      conditions.some(
        (c) =>
          c?.type === 'ITEM_IN_GROUP' &&
          c?.value != null &&
          String(c.value) === dead
      );
    if (scopedToDead) scopedIds.push(automation._id);
  }

  return { spawnerIds, scopedIds };
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
      // Cloudinary FIRST, and the order is the whole point. A file's `publicId`
      // lives only on the Task or Update row that carries the attachment, so
      // once those rows are deleted nothing anywhere knows the asset exists:
      // it sits in the account forever, still billed, still resolvable at a URL
      // somebody may already have, and no future cleanup job can ever find it.
      // Read the ids out, destroy the blobs, then wipe the rows — the same
      // sequence, for the same stated reason, as services/orgCascade.js and
      // taskController.deleteTask.
      //
      // `taskIds` is the right set and must not be "improved" into a
      // parent-scoped query: subitems carry `group` themselves, so they are
      // already in this list, and it is exactly the list `Task.deleteMany({
      // group: id })` below removes. Collecting a WIDER set than the delete
      // would destroy the files of subitems that survive under a parent in
      // another group — live rows pointing at dead blobs, strictly worse than
      // the leak this fixes.
      // `board` too: a file-column asset is only ever destroyed under ITS OWN
      // board's folder (utils/fileColumnAssets.js), so without it nothing
      // here would be destroyed and every invoice PDF in the group would leak.
      const taskDocs = await Task.find({ _id: { $in: taskIds } })
        .select('attachments columnValues board')
        .lean();
      const updateDocs = await Update.find({ task: { $in: taskIds } })
        .select('attachments')
        .lean();
      await destroyCloudinaryAssets([
        ...taskDocs.flatMap((t) => t.attachments || []),
        ...updateDocs.flatMap((u) => u.attachments || []),
      ]);
      // Files held in FILE COLUMNS (an invoice's PDF) — same reason, same
      // order. Only the Files-tab array used to be read here.
      // `excludeTaskIds`: an id a row OUTSIDE this group still holds is kept
      // (utils/fileColumnAssets.js `withoutIdsHeldElsewhere`).
      await destroyFileColumnAssets(ctx.board.columns || [], taskDocs, {
        boardId: ctx.board._id,
        excludeTaskIds: taskIds,
      });

      await Update.deleteMany({ task: { $in: taskIds } });
      await Notification.deleteMany({ task: { $in: taskIds } });
      await ItemFollow.deleteMany({ task: { $in: taskIds } });
      // Task history, by TASK ID — the same delete taskController.deleteTask,
      // boardController.deleteBoard and orgCascade all do, and the one this
      // path was missing. Without it every field-change row for these tasks
      // survives with `task` pointing at nothing: unreachable through the
      // per-task history panel (it 404s without the task document) yet still
      // picked up by the board activity export, which then pads a client's
      // audit report with hundreds of rows for work the team believes it
      // deleted.
      //
      // Deleting by task id rather than by board is deliberate, for the reason
      // boardController.deleteBoard writes down: `logActivity` only fills
      // `board` when the caller hands it a task DOCUMENT, so rows written from
      // a bare id carry `board: null` and no board-scoped sweep can ever reach
      // them.
      //
      // This does NOT reach the `group.deleted` row logged at the end of this
      // function: that row carries no `task`, and it is written after the
      // cascade precisely so it outlives its subject.
      await ActivityLog.deleteMany({ task: { $in: taskIds } });
    }
    await Note.deleteMany({ group: id });
    await Task.deleteMany({ group: id });
    // A task deleted with its group may be the TARGET of a connect column on
    // another board, and `task.deleted` is the only thing that ever pulls a
    // dead entry out of `columnValues.<col>.links` (services/mirrorRefresh.js).
    // Deleting these rows silently left every chip pointing at them behind:
    // a permanent grey "Linked row" that opens nothing, and — worse, because it
    // is a wrong number rather than a broken link — a mirror column aggregating
    // `count` keeps counting them, since `count` answers from `links.length`
    // without ever loading the targets.
    //
    // The ids come from the list collected BEFORE the delete; after this line
    // there is nothing left to enumerate.
    //
    // AWAITED AND BULK, rather than one `eventBus.emit('task.deleted')` per id
    // the way taskController.deleteTask does it. That shape is right for one
    // task and wrong for a whole group: the listener does a
    // `BoardConnection.find` plus up to three more queries PER EVENT, and
    // `emit` is fire-and-forget, so a group holding a few thousand rows would
    // launch tens of thousands of unawaited queries in a single tick — after
    // the response had gone out, racing this cascade's own
    // `TaskGroup.deleteOne`, with nothing bounding the concurrency and any
    // listener that threw taking the cascade down with it (eventBus is a bare
    // EventEmitter with no try/catch).
    //
    // `invalidateMirrorsForDeletedTasks` performs exactly the same two writes
    // the listener would, batched with `$in`, at a cost proportional to the
    // number of board CONNECTIONS rather than the number of deleted rows.
    await invalidateMirrorsForDeletedTasks({
      taskIds,
      boardId: group.board,
    });
    // NOTE: deliberately NO ClientContact DELETION here. A contact belongs to
    // the BOARD (one client company), not to a service — deleting the Ads group
    // must not sign that client out of their portal. Contacts are cascaded in
    // boardController.deleteBoard and services/orgCascade.js.
    //
    // Their `services` array does have to lose the dead id, though. That is not
    // a contradiction of the paragraph above: the contact survives, only the
    // chip naming a service that no longer exists goes. Exactly what
    // `deleteGroupTag` does when a tag is deleted out from under the groups
    // holding it.
    await ClientContact.updateMany(
      { board: group.board },
      { $pull: { services: id } }
    );
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
    // A goal belongs to exactly one group, so deleting the group deletes them —
    // and a connector link is nothing but a reference to a goal plus the record
    // of which of its cells the connector owned, so it goes with them.
    // Collected BEFORE the delete: a task that was MOVED OUT of this group can
    // still hold evidence links to goals that are about to stop existing, and
    // once the goals are gone there is nothing left to find them by. The tasks
    // still IN the group are deleted above, links and all.
    const goalIds = await Goal.distinct('_id', { group: id });
    await Goal.deleteMany({ group: id });
    await GoalConnectorLink.deleteMany({ group: id });
    // Ads budgets belong to the client this group IS, so they go with it —
    // every month of them, not just the one somebody happens to be looking at.
    // Platform and campaign rows alike: both carry `group`, so the one delete
    // reaches both levels and cannot leave a campaign orphaned.
    await AdsBudget.deleteMany({ group: id });
    if (goalIds.length > 0) {
      await Task.updateMany(
        { board: group.board, 'goalLinks.goal': { $in: goalIds } },
        { $pull: { goalLinks: { goal: { $in: goalIds } } } }
      );
    }
    // Connector projects are UNBOUND, never deleted. The row mirrors something
    // that still exists inside the provider and is the parent of every
    // ConnectorSnapshot ever taken for that domain — deleting the group is a
    // statement about this board, not about the client's rank history. The
    // project simply returns to the pool and can be mapped somewhere else.
    await ConnectorProject.updateMany(
      { group: id },
      { $set: { group: null, board: null, boundBy: null, boundAt: null } }
    );
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
    // Automations that named this group. `planAutomationRepair` above carries
    // the whole argument — which rules are switched off, which are left alone,
    // and why nothing here deletes a rule or pulls a dead action or condition.
    //
    // Two writes rather than one because the two halves are different repairs.
    // A SPAWNER is disabled AND taken off the cron queue: `nextRunAt` is what
    // automationRunner selects on, and leaving it set on a disabled rule is the
    // same inconsistency `updateAutomation` avoids. A SCOPED rule keeps its
    // `nextRunAt` untouched, because an ITEM_CREATED rule is event-driven and
    // that field is not the thing that runs it — writing to it here would only
    // obscure what actually changed.
    const boardAutomations = await Automation.find({ board: group.board })
      .select('triggerType actions taskTemplate conditions')
      .lean();
    const { spawnerIds, scopedIds } = planAutomationRepair(boardAutomations, id);
    if (spawnerIds.length > 0) {
      await Automation.updateMany(
        { _id: { $in: spawnerIds } },
        { $set: { enabled: false, nextRunAt: null } }
      );
    }
    if (scopedIds.length > 0) {
      await Automation.updateMany(
        { _id: { $in: scopedIds } },
        { $set: { enabled: false } }
      );
    }
    // Conversations. Every surface on this workstream, plus its messages and
    // both kinds of read marker.
    //
    // This is not tidiness. The contact-side audience gate keys on
    // `contact.board === channel.board`, and the BOARD outlives the group — so
    // an orphaned `audience:'client'` room stays readable and postable by the
    // client after the team deleted the workstream, while being invisible to
    // the team, who have no group left to reach it through. That is the worst
    // possible way round for a conversation to survive.
    await deleteSurfacesForGroup(id);

    await destroyLogos([group]);
    await TaskGroup.deleteOne({ _id: id });

    // Logged AFTER the group is actually gone, so a cascade that threw halfway
    // never leaves behind a row claiming a delete that did not happen. The
    // counts come from the ids collected above, before the cascade removed the
    // documents they refer to — after this point there is nothing left to count.
    //
    // This row deliberately outlives its subject. `group` now points at an id
    // that resolves to nothing, and `metadata.groupName` is what the export
    // reads instead.
    await logGroupDeleted({
      group,
      board: ctx.board,
      actor: userId,
      taskCount: taskIds.length,
      goalCount: goalIds.length,
    });

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
      .populate('createdBy', CREATOR_FIELDS)
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
  // Exported for services/portalBatchInvite.js, which resolves a service name to
  // a group using the SAME trim/clamp/case-insensitive rule this file applies —
  // and then reuses a duplicate instead of refusing it.
  resolveGroupName,
  duplicateGroupNameError,
  // Exported for groupAutomationRepair.test.js. It is pure, and it holds the
  // one decision in this cascade that is easy to get backwards: which
  // automations a dead group switches off, and which it must leave running.
  planAutomationRepair,
  createGroup,
  updateGroup,
  deleteGroup,
  reorderGroups,
};
