const mongoose = require('mongoose');
const Organisation = require('../models/Organisation');
const User = require('../models/User');
const Board = require('../models/Board');
const Task = require('../models/Task');
const Update = require('../models/Update');
const Notification = require('../models/Notification');
const NotificationPreference = require('../models/NotificationPreference');
const ItemFollow = require('../models/ItemFollow');
const PushSubscription = require('../models/PushSubscription');
const SavedMessage = require('../models/SavedMessage');
const ChannelRead = require('../models/ChannelRead');
const Channel = require('../models/Channel');
const DueDigest = require('../models/DueDigest');
const ExecutiveView = require('../models/ExecutiveView');
const { destroyCloudinaryAssets } = require('../config/cloudinary');
const { roleColumn } = require('../utils/columnRoles');
const { purgeChannels } = require('./workstreamSurfaces');
const { logExecutiveRemoved } = require('./executiveActivity');

/**
 * ONE PERSON leaving — either a single workspace, or the product entirely.
 *
 * ---- WHY THIS IS A SERVICE ------------------------------------------------
 *
 * There are three ways a person stops being present, and until this file they
 * were three unrelated blocks of code that agreed on almost nothing:
 *
 *   `orgController.removeMember`   — an admin removes them from a workspace
 *   `profileController.deleteAccount` — they delete themselves
 *   `orgCascade.cascadeDeleteOrg`  — the workspace itself is torn down
 *
 * The first cleaned up three fields on one document. The second cleaned up six
 * collections out of the twenty-odd that carry a `ref: 'User'`. Both left the
 * person's DERIVED SUBSCRIPTIONS behind — board grants, follows, notification
 * rows, Web Push credentials — which is not a cosmetic orphan: the fan-out
 * keeps finding those rows and keeps delivering that workspace's task names to
 * somebody who was removed from it, over a push channel nothing can unregister.
 *
 * `services/boardGrants.js` already made exactly this argument for ONE board
 * and fixed it in `revoke`. This is the same fix one scope up, and the two are
 * deliberately consistent: revoking a grant takes the derived rows with it.
 *
 * ---- THE OTHER HALF: REFUSING TO CASCADE ---------------------------------
 *
 * `deleteAccount` used to loop every org where `admin === you` straight into
 * `cascadeDeleteOrg`. One person clicking "Delete my account" therefore
 * destroyed every board, task, comment, file, vault, client roster and chat
 * message belonging to everyone else in every workspace they happened to own —
 * with no transaction, no export, no undo, and a weaker confirmation than the
 * app already demands for deleting a SINGLE workspace (which makes you type its
 * name).
 *
 * `ownedOrgBlockers` is the answer, and it is a refusal rather than a smarter
 * cascade on purpose: the repo already has the correct action for this
 * situation — `POST /api/orgs/:id/transfer-ownership`, the only writer of
 * `Organisation.admin` after creation. A workspace with other people in it is
 * theirs as much as yours, so the account deletion stops and names it.
 *
 * A workspace you are ALONE in is still cascaded, because there is nobody to
 * hand it to and leaving it behind would orphan the whole thing.
 */

/** Compare ids without caring whether the ref arrived populated. */
const idOf = (ref) => String(ref?._id || ref || '');

/**
 * Everyone in `org` who is not `userId`, as a de-duplicated id list.
 *
 * Reads all four places membership is expressed — `admin`, `admins`, `members`
 * and `memberRoles` — rather than `members` alone. That is not belt-and-braces:
 * `joinOrg` writes membership on two documents in two untransacted writes and
 * reconciles them on next join, so a workspace really can hold somebody in one
 * array and not another. This function decides whether it is safe to DESTROY
 * that workspace, so it must fail towards "somebody is still in there".
 *
 * Pure, and exported for exactly that reason — the guard it feeds is the one
 * piece of this file worth pinning with a test that needs no database.
 */
const otherMemberIds = (org, userId) => {
  const me = idOf(userId);
  const seen = new Set();
  const out = [];
  const push = (ref) => {
    const id = idOf(ref);
    if (!id || id === me || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };

  push(org?.admin);
  (org?.admins || []).forEach(push);
  (org?.members || []).forEach(push);
  (org?.memberRoles || []).forEach((entry) => push(entry?.user));

  return out;
};

/**
 * Split the workspaces this person OWNS into the ones account deletion may
 * quietly cascade and the ones it must refuse.
 *
 * The membership count is the UNION of the org's own arrays (`otherMemberIds`)
 * and the reverse side (`User.organisations`), for the dual-sided reason above.
 * Both are consulted because either one alone can be the only record that
 * somebody is still in the room.
 *
 * @returns {Promise<{blocking: Array, solo: Array}>}
 *   blocking — `[{ _id, name, memberCount, memberNames }]`, orgs with other people in
 *   solo     — `[orgDoc]`, orgs this person is alone in
 */
const ownedOrgBlockers = async (userId) => {
  const owned = await Organisation.find({ admin: userId }).select(
    '_id name admin admins members memberRoles'
  );

  const blocking = [];
  const solo = [];

  for (const org of owned) {
    const otherIds = new Set(otherMemberIds(org, userId));
    // The reverse side of the dual-sided membership. A user document naming
    // this org is a member of it even if the org's own arrays lost them.
    const reverse = await User.find({
      organisations: org._id,
      _id: { $ne: userId },
    }).select('_id name email');
    reverse.forEach((u) => otherIds.add(idOf(u._id)));

    if (otherIds.size === 0) {
      solo.push(org);
      continue;
    }

    // ONLY IDS THAT RESOLVE TO A LIVE USER COUNT, and this is the line that
    // stops the guard becoming a trap.
    //
    // `otherMemberIds` reads four arrays and fails towards "somebody is still in
    // there", which is right for deciding whether to destroy a workspace and
    // wrong as a final answer: a stale id — a person whose account was deleted
    // before this file existed, when the old `deleteAccount` pulled them from
    // `members` and `admins` but never from `memberRoles` — is not another
    // person. Counting one would refuse the delete forever while naming nobody,
    // and the Members screen cannot offer a Remove button for a row it renders
    // from a populate that came back null. The owner would be locked out of
    // deleting their own account with no route in the UI to fix it.
    //
    // The guard is not weakened by this. A live member is found whether they are
    // named by the org's arrays or only by their own `User.organisations`; both
    // sets were unioned above and both are resolved here.
    //
    // Everything is fetched — no `.limit` — because the COUNT has to be exact;
    // only the names shown to the user are capped.
    const people = await User.find({ _id: { $in: [...otherIds] } })
      .select('name email')
      .lean();

    if (people.length === 0) {
      solo.push(org);
      continue;
    }

    blocking.push({
      _id: org._id,
      name: org.name,
      memberCount: people.length,
      // Names, not just a count: "3 other members" is not enough for somebody to
      // decide who to hand the workspace to.
      memberNames: people
        .slice(0, 25)
        .map((p) => p.name || p.email)
        .filter(Boolean),
    });
  }

  return { blocking, solo };
};

/**
 * Take ONE person out of ONE workspace, and take their derived subscriptions
 * with them.
 *
 * Shared by `removeMember` (an admin removed them) and `deleteAccount` (they
 * left of their own accord). Those two differ only in who decided; what has to
 * be cleaned up afterwards is identical, and writing it twice is how the two
 * drifted in the first place.
 *
 * What it deliberately does NOT touch:
 *   - Their authored CONTENT. Tasks they created, updates they wrote, messages
 *     they posted all stay. Removing somebody from a workspace is not a licence
 *     to delete the team's history, and `Task.createdBy` pointing at a person
 *     who left is a normal state this app already renders.
 *   - DMs. A direct line belongs to its two people, not to the workspace it was
 *     opened in — `workstreamSurfaces.deleteWorkspaceChannels` says so outright
 *     and excludes them from the org teardown for the same reason.
 *
 * `boardSave` is off by default because the caller almost always follows with
 * its own `org.save()`; pass the org document in already mutated, or let this
 * do it.
 */
const revokeUserFromOrg = async ({ userId, orgId, org = null }) => {
  const targetId = idOf(userId);
  const orgDoc = org || (await Organisation.findById(orgId));
  if (!orgDoc) return { removed: false };

  // ---- 1. Membership, on both sides -------------------------------------
  orgDoc.admins = (orgDoc.admins || []).filter((a) => idOf(a) !== targetId);
  orgDoc.members = (orgDoc.members || []).filter((m) => idOf(m) !== targetId);
  orgDoc.memberRoles = (orgDoc.memberRoles || []).filter(
    (m) => idOf(m?.user) !== targetId
  );
  await orgDoc.save();

  await User.findByIdAndUpdate(userId, { $pull: { organisations: orgDoc._id } });

  const boardIds = await Board.distinct('_id', { organisation: orgDoc._id });

  // ---- 2. Per-board grants ----------------------------------------------
  // A surviving `memberAccess` entry is worse than untidy: it keeps counting
  // this person as a reader of a PRIVATE board, so the fan-out keeps minting
  // rows for them, and re-joining the workspace silently restores every private
  // board they used to be able to open. `$pull` in one write rather than
  // `boardGrants.revoke` per board — the derived rows that `revoke` cleans up
  // per board are cleaned up org-wide in step 3, which is a superset.
  await Board.updateMany(
    { organisation: orgDoc._id },
    { $pull: { memberAccess: { user: userId } } }
  );

  // ---- 3. Derived subscriptions -----------------------------------------
  // Everything below is a row that exists only because this person could see
  // this workspace. Each one is a delivery path, not a record.
  await ItemFollow.deleteMany({ user: userId, organisation: orgDoc._id });
  if (boardIds.length) {
    // Follows written before `ItemFollow.organisation` existed carry no org, so
    // the sweep above cannot see them and they have to be found through their
    // task's board instead.
    //
    // Driven from THIS PERSON'S follows rather than from the workspace's tasks.
    // The obvious shape — `Task.distinct('_id', { board: { $in: boardIds } })` —
    // pulls every task id in the entire workspace into memory on every member
    // removal, which on a mature workspace is hundreds of thousands of ObjectIds
    // marshalled to answer a question about one person who probably follows a
    // dozen rows. Starting from the follows bounds the whole thing by that
    // dozen, and the `$in` on `_id` is then an index lookup.
    const legacyFollows = await ItemFollow.find({
      user: userId,
      organisation: null,
    })
      .select('task')
      .lean();
    if (legacyFollows.length) {
      const followedHere = await Task.distinct('_id', {
        _id: { $in: legacyFollows.map((f) => f.task).filter(Boolean) },
        board: { $in: boardIds },
      });
      if (followedHere.length) {
        await ItemFollow.deleteMany({ user: userId, task: { $in: followedHere } });
      }
    }
    await Notification.deleteMany({ user: userId, board: { $in: boardIds } });
    await NotificationPreference.updateMany(
      { user: userId },
      { $pull: { mutedBoards: { $in: boardIds } } }
    );
  }
  await Notification.deleteMany({ user: userId, organisation: orgDoc._id });

  // This workspace's rooms. DMs are excluded — a direct line belongs to its two
  // PEOPLE rather than to the workspace it was opened in, which is the same call
  // `workstreamSurfaces.deleteWorkspaceChannels` makes when it refuses to delete
  // one on an org teardown.
  //
  // The exclusion is load-bearing for BOTH sweeps below, and the reason it has
  // to be done this way rather than by `organisation` is easy to miss:
  // `Channel.organisation` is REQUIRED on every room including a DM, and both
  // `toggleSave` and the read-marker writer copy the channel's fields onto their
  // rows. So scoping either sweep by `organisation` would reach into a DM this
  // person keeps — deleting their bookmarks and resetting their unread line on a
  // conversation that survives them leaving the workspace entirely.
  const channelIds = await Channel.distinct('_id', {
    organisation: orgDoc._id,
    kind: { $ne: 'dm' },
  });
  if (channelIds.length) {
    await SavedMessage.deleteMany({ user: userId, channel: { $in: channelIds } });
    await ChannelRead.deleteMany({ user: userId, channel: { $in: channelIds } });
  }

  // ---- 4. Their executive profile ---------------------------------------
  // The model's own comment describes this query — "does this person have a
  // profile anywhere, asked when a member is removed or an account is deleted"
  // — and indexes `user` for it. Nothing ever asked it. Left behind, the person
  // keeps appearing in the workspace's Executives list as an editable row
  // pointing at a non-member, and re-joining silently restores the curated view
  // somebody deliberately took away.
  //
  // Logged, not just deleted — `executive.removed` is what every other path that
  // takes a profile away already writes, and an audit trail with a hole in it
  // exactly where somebody was removed by an admin is the hole worth not having.
  // Read before the delete so `boardCount` can be counted while there is still
  // something to count, and `actorType: 'system'` because the person who pressed
  // the button was removing a MEMBER; the profile going with them is a
  // consequence, not their instruction.
  const profiles = await ExecutiveView.find({
    organisation: orgDoc._id,
    user: userId,
  })
    .select('boards')
    .lean();
  await ExecutiveView.deleteMany({ organisation: orgDoc._id, user: userId });
  for (const profile of profiles) {
    await logExecutiveRemoved({
      organisation: orgDoc._id,
      targetUser: { _id: userId },
      actor: null,
      actorType: 'system',
      actorLabel: 'Workspace membership',
      boardCount: (profile.boards || []).length,
    });
  }

  return { removed: true, org: orgDoc };
};

/**
 * Delete ONE person and everything that exists only because they did.
 *
 * Assumes the caller has already dealt with the workspaces they own — see
 * `ownedOrgBlockers`. This function will happily run on somebody who still owns
 * a populated workspace and will leave it ownerless, which is exactly why the
 * refusal lives in the controller above it rather than here.
 *
 * ---- WHAT IS DELETED vs WHAT IS KEPT -------------------------------------
 *
 * DELETED: anything that is a DELIVERY PATH to this person (push subscriptions,
 * notifications, follows, digests, read markers, preferences), anything only
 * they could ever see (personal tasks, their executive views, their saved
 * messages), and every Cloudinary blob behind the above — an asset nothing
 * points at is billed forever and can never be found again.
 *
 * KEPT: content they authored inside a workspace that still exists. Their
 * tasks, their comments, their chat messages and their activity rows stay, with
 * `createdBy`/`author`/`actor` pointing at an id that no longer resolves. That
 * is a deliberate trade — the alternative is one person's departure punching
 * holes in a shared board's history — and it is a state the read paths must
 * therefore tolerate, which is a separate concern from this file.
 *
 * ORDER IS FOR CRASH-SAFETY. The User document goes LAST, so a run that dies
 * halfway leaves a findable user whose cleanup can simply be run again, rather
 * than orphans nothing can locate.
 */
const cascadeDeleteUser = async (userId) => {
  // ---- 1. Leave every workspace, cleanly --------------------------------
  const memberOrgIds = await Organisation.distinct('_id', {
    $or: [
      { members: userId },
      { admins: userId },
      { 'memberRoles.user': userId },
    ],
  });
  for (const orgId of memberOrgIds) {
    await revokeUserFromOrg({ userId, orgId });
  }
  // Orgs that only the reverse side knows about (see `ownedOrgBlockers`).
  const reverseOrgIds = await User.findById(userId)
    .select('organisations')
    .lean()
    .then((u) => (u?.organisations || []).map(idOf));
  for (const orgId of reverseOrgIds) {
    if (memberOrgIds.some((id) => idOf(id) === idOf(orgId))) continue;
    await revokeUserFromOrg({ userId, orgId });
  }

  // ---- 2. Personal tasks ------------------------------------------------
  // Only this person could ever see these, so they go with them — attachments
  // included. Every other delete path in the repo destroys its Cloudinary
  // assets before dropping the rows that name them; this one did not, which
  // meant each deleted account left its files in the account forever, still
  // publicly fetchable by URL and still billed.
  const personalTaskIds = await Task.distinct('_id', {
    isPersonal: true,
    createdBy: userId,
  });
  if (personalTaskIds.length) {
    // `attachments` is the whole of a personal task's files. The other place a
    // task can hold one — a file COLUMN (see utils/fileColumnAssets.js) — needs
    // a board, and a personal task has none: both task write paths refuse
    // `columnValues` on it. So there is no second sweep to run here.
    const taskDocs = await Task.find({ _id: { $in: personalTaskIds } })
      .select('attachments')
      .lean();
    const updateDocs = await Update.find({ task: { $in: personalTaskIds } })
      .select('attachments')
      .lean();
    await destroyCloudinaryAssets([
      ...taskDocs.flatMap((t) => t.attachments || []),
      ...updateDocs.flatMap((u) => u.attachments || []),
    ]);
    await Update.deleteMany({ task: { $in: personalTaskIds } });
    await Notification.deleteMany({ task: { $in: personalTaskIds } });
    await ItemFollow.deleteMany({ task: { $in: personalTaskIds } });
    await Task.deleteMany({ _id: { $in: personalTaskIds } });
  }

  // ---- 3. Take their name off shared work -------------------------------
  // The rows themselves stay (see the header); only the pointer that would keep
  // addressing work to a person who is gone comes off.
  await Task.updateMany({ assignedTo: userId }, { $pull: { assignedTo: userId } });
  // On a flexible-columns board that pointer has a second copy: the column
  // playing the `assignee` role (billing's Owner, content's Writer — see
  // utils/columnRoles.js). The task's save hook copies that cell back onto
  // `assignedTo`, so pulling only the field would put the person straight back
  // on the row the next time anybody edited it. Pull the cell too. Only the ROLE
  // column: other person cells never feed `assignedTo`, and what they record is
  // the board's content, which this cascade keeps.
  //
  // Scoped to the workspaces they belonged to — assignees must be members, so
  // no other board can name them. Cells hold id STRINGS (the person column's
  // serializer), with ObjectIds pulled as well for rows written by hand.
  const everyOrgId = [...new Set([...memberOrgIds, ...reverseOrgIds].map(idOf))];
  if (everyOrgId.length) {
    const roleBoards = await Board.find({
      organisation: { $in: everyOrgId },
      useFlexibleColumns: true,
      'columns.type': 'person',
    })
      .select('columns templateKey')
      .lean();
    const uid = idOf(userId);
    const asIds = [uid, ...(mongoose.Types.ObjectId.isValid(uid) ? [new mongoose.Types.ObjectId(uid)] : [])];
    for (const board of roleBoards) {
      const ownerCol = roleColumn(board, 'assignee');
      if (!ownerCol) continue;
      const path = `columnValues.${String(ownerCol._id)}`;
      await Task.updateMany(
        { board: board._id, [path]: { $in: asIds } },
        { $pull: { [path]: { $in: asIds } } }
      );
    }
  }

  // ---- 4. Comments they authored ----------------------------------------
  // Deleted, as before — an update is addressed FROM somebody in a way a task
  // is not, and a thread of anonymous comments reads worse than a shorter
  // thread. Their attachments go too, for the same reason as above.
  const authoredUpdates = await Update.find({ author: userId })
    .select('attachments')
    .lean();
  if (authoredUpdates.length) {
    await destroyCloudinaryAssets(
      authoredUpdates.flatMap((u) => u.attachments || [])
    );
    await Update.deleteMany({ author: userId });
  }

  // ---- 5. Direct messages -----------------------------------------------
  // A DM belongs to its two people. One of them deleting their account ends the
  // conversation for both — there is no version of it that is still a
  // conversation, and the surviving party's client renders the other side from
  // a `members` entry that now resolves to nothing. `purgeChannels` takes the
  // messages, both kinds of read marker, and the Cloudinary assets behind any
  // files shared in them.
  const dmIds = await Channel.distinct('_id', { kind: 'dm', members: userId });
  if (dmIds.length) {
    await SavedMessage.deleteMany({ channel: { $in: dmIds } });
    await purgeChannels(dmIds.map((id) => id));
  }

  // ---- 6. Everything addressed TO them ----------------------------------
  await Notification.deleteMany({ user: userId });
  // Notifications they CAUSED, which name them as the actor. Kept where they
  // are part of a shared record, deleted where the whole row is about them:
  // `actor` is display-only on a notification and the row is a delivery, not
  // history, so a row whose actor cannot be resolved renders as "Someone".
  // Left in place deliberately — see the null-guard work in notificationLink.
  await NotificationPreference.deleteMany({ user: userId });
  await ItemFollow.deleteMany({ user: userId });
  await DueDigest.deleteMany({ user: userId });
  await SavedMessage.deleteMany({ user: userId });
  await ChannelRead.deleteMany({ user: userId });
  await ExecutiveView.deleteMany({ user: userId });
  // Web Push. The single most important row in this list: it holds a live
  // endpoint URL plus the `p256dh` and `auth` ENCRYPTION KEYS for this person's
  // browser. Left behind it is both an indefinite credential and a live delivery
  // path — the push service will keep accepting sends to it until the browser
  // itself unregisters, which a deleted account never does.
  await PushSubscription.deleteMany({ user: userId });

  // ---- 7. The person -----------------------------------------------------
  await User.findByIdAndDelete(userId);
};

module.exports = {
  otherMemberIds,
  ownedOrgBlockers,
  revokeUserFromOrg,
  cascadeDeleteUser,
};
