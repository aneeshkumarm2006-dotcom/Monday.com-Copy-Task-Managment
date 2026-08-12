const mongoose = require('mongoose');
const Board = require('../models/Board');
const Task = require('../models/Task');
const TaskGroup = require('../models/TaskGroup');
const Update = require('../models/Update');
const ActivityLog = require('../models/ActivityLog');
const Organisation = require('../models/Organisation');
const User = require('../models/User');
const {
  createNotificationsForUsers,
  notifyTaskAudience,
  filterByEmailPreference,
} = require('../services/notificationService');
const { sendTaskAssignmentEmail } = require('../services/emailService');
const Notification = require('../models/Notification');
const ItemFollow = require('../models/ItemFollow');
const eventBus = require('../services/eventBus');
const { logActivity } = require('../services/activityService');
const { destroyCloudinaryAssets } = require('../config/cloudinary');
const { getColumnType } = require('../utils/columnTypes');
const { buildTaskDeepLink } = require('../utils/taskDeepLink');
const { embedMirrorValues } = require('../services/mirrorRefresh');
const { loadBoardContext, requireCapability } = require('../utils/boardContext');
const { resolveAccess } = require('../utils/permissions');
const { isMonthKey, monthKeyOf } = require('../utils/monthKey');
const ClientContact = require('../models/ClientContact');
const { isResolvedStatus } = require('../utils/doneStatus');
const {
  sendPortalResolvedEmail,
  sendPortalSharedTaskEmail,
} = require('../services/emailService');
const { portalLink, clientLabel } = require('../services/portalInviteService');
const { loadRequestAttachments } = require('../utils/portalAttachments');
const { isClientVisibleTask } = require('../utils/portalVisibility');

/**
 * Client Portal: when a client-submitted task moves to a "done" status, email
 * the external client who raised it. No-op for internal tasks. Fire-and-forget —
 * swallows its own errors so it never blocks the status change.
 */
const emailClientOnResolve = async (task, board) => {
  try {
    if (!task || task.source !== 'client' || !task.portalSubmitter) return;
    if (!isResolvedStatus(board, task.status)) return;
    const contact = await ClientContact.findById(task.portalSubmitter).select('email');
    if (!contact?.email) return;
    const org = await Organisation.findById(board.organisation).select('name');
    await sendPortalResolvedEmail({
      to: contact.email,
      orgName: org?.name || '',
      taskName: task.name,
      link: `${process.env.CLIENT_URL || 'http://localhost:5173'}/portal`,
    });
  } catch (err) {
    console.error('emailClientOnResolve error:', err);
  }
};

/**
 * Human-friendly ticket reference, matching what the client sees in the portal:
 * sequential once a `portalRef` was claimed, id-derived for pre-ref tasks.
 * Mirrors portalController.issueRef.
 */
const portalRefLabel = (task) =>
  task.portalRef
    ? `REQ-${task.portalRef}`
    : `REQ-${String(task._id).slice(-5).toUpperCase()}`;

/**
 * Client Portal: email the group's client contacts when the team PUBLISHES a
 * task to their portal. A shared item is the team asking something of the
 * client, so it can't wait to be discovered on a page nobody was told to open.
 *
 * Every contact on the group is mailed, not one submitter, because a shared task
 * belongs to the whole client company — the same audience that can already read
 * it in the portal, so this discloses nothing new.
 *
 * Only for team-shared items: a client-raised ticket (`portalSubmitter`) is
 * already theirs, and a subitem never reaches the portal at all. Silent when the
 * group's portal is off — mailing a link that refuses them is worse than nothing.
 *
 * Fire-and-forget: swallows its own errors so sharing never fails on the mail.
 */
const emailClientsOnPortalShare = async (task, board) => {
  try {
    if (!task || !board || board.boardType !== 'client') return;
    if (!task.portalShared || task.parent || task.portalSubmitter) return;

    const group = await TaskGroup.findById(task.group).select(
      'name portalClientName portalEnabled portalToken'
    );
    if (!group?.portalEnabled || !group.portalToken) return;

    const contacts = await ClientContact.find({ group: group._id })
      .select('email')
      .lean();
    const recipients = contacts.map((c) => c.email).filter(Boolean);
    if (recipients.length === 0) return;

    const org = await Organisation.findById(board.organisation).select('name');
    // The group's own portal URL rather than the bare /portal dashboard: an
    // invited contact who has never signed in on this device needs the landing
    // page, and one who has is a click from the same list either way.
    const link = portalLink(group);

    const results = await Promise.allSettled(
      recipients.map((to) =>
        sendPortalSharedTaskEmail({
          to,
          orgName: org?.name || '',
          clientName: clientLabel(group),
          taskName: task.name,
          ref: portalRefLabel(task),
          dueDate: task.dueDate || null,
          note: task.note || '',
          link,
          taskId: String(task._id),
        })
      )
    );
    results.forEach((result, i) => {
      if (result.status === 'rejected') {
        console.error(
          `[email] Failed to send shared-task mail to ${recipients[i]}:`,
          result.reason?.message || result.reason
        );
      }
    });
  } catch (err) {
    console.error('emailClientsOnPortalShare error:', err);
  }
};

/**
 * Client Portal: record a status change as a 'system' timeline event on the
 * task's thread so the client sees "Status changed to X" in their portal.
 * No-op for tasks the client cannot see. Best-effort — never blocks the change.
 *
 * Fires for a team-SHARED task too, unlike the resolve email above. The two are
 * not the same promise: this writes into a thread the client has to come and
 * look at, and a shared item with a silent status is exactly the "is anyone
 * looking at this?" the portal exists to answer. Only the share itself pushes
 * mail to the whole group (see emailClientsOnPortalShare); every status hop
 * after it stays in the thread.
 */
const logClientStatusChange = async (task, statusName) => {
  try {
    if (!isClientVisibleTask(task) || !statusName) return;
    await Update.create({
      task: task._id,
      authorType: 'system',
      author: null,
      bodyText: `Status changed to ${statusName}`,
    });
  } catch (err) {
    console.error('logClientStatusChange error:', err);
  }
};

/**
 * The gate on publishing an internal task to a client's portal. Shared by the
 * create path and the standalone toggle so the two can never drift. Returns
 * `{ status, error }` to refuse, or null to allow.
 *
 * `task` may be a not-yet-created draft — only `parent` and `portalSubmitter`
 * are read.
 */
const denyPortalShare = (ctx, task) => {
  if (ctx.board.boardType !== 'client') {
    return { status: 400, error: 'This board has no client portal' };
  }
  if (task.parent) {
    // The portal renders a flat list, so a shared subitem would arrive as a
    // stray top-level card with none of its parent's context.
    return { status: 400, error: 'Subitems cannot be shared with the client' };
  }
  if (task.portalSubmitter) {
    // A client-raised ticket already reaches the person who raised it. Sharing
    // is group-wide, so flipping it here would hand one contact's ticket to
    // everyone else at their company — a disclosure, not a convenience.
    return {
      status: 400,
      error: 'This request came from a client and is already visible to them',
    };
  }
  // Publishing to an outside party is a stronger act than adding a row, so it
  // answers to the `edit` rung rather than to `task.create`.
  return requireCapability(
    ctx,
    'task.edit_any',
    'You do not have permission to share tasks with the client'
  );
};

/**
 * Claim the next human-friendly ticket number for a board, so a shared task can
 * be quoted by the same "REQ-1042" the client sees on client-raised ones.
 * Mirrors portalController.createMyIssue. Best-effort: a task with no ref still
 * renders, it just falls back to an id-derived reference.
 */
const claimPortalRef = async (boardId) => {
  try {
    const bumped = await Board.findByIdAndUpdate(
      boardId,
      { $inc: { portalTicketSeq: 1 } },
      { new: true, select: 'portalTicketSeq' }
    );
    return bumped?.portalTicketSeq || null;
  } catch (err) {
    console.error('claimPortalRef error:', err);
    return null;
  }
};

const VALID_PRIORITIES = ['critical', 'high', 'medium', 'low'];
// Legacy enum keys — accepted for personal tasks (which don't have a board).
const LEGACY_STATUS_KEYS = ['not_started', 'working_on_it', 'done', 'stuck'];
// Map legacy enum keys → the display name they originally seeded with. Used
// as a last-resort fallback in `findBoardStatus` when a board's status was
// recreated/renamed and lost its `key`, but still carries a recognisable name.
const LEGACY_KEY_TO_NAME = {
  not_started: 'not started',
  working_on_it: 'working on it',
  done: 'done',
  stuck: 'stuck',
};
// Mirrors boardController.DEFAULT_STATUSES — kept in sync so we can lazily
// seed any pre-migration board the user accesses through the task API.
const DEFAULT_STATUSES = [
  { key: 'not_started',   name: 'Not Started',   color: '#6B7280', order: 0, isDefault: true  },
  { key: 'working_on_it', name: 'Working on it', color: '#D97706', order: 1, isDefault: false },
  { key: 'done',          name: 'Done',          color: '#16A34A', order: 2, isDefault: false },
  { key: 'stuck',         name: 'Stuck',         color: '#DC2626', order: 3, isDefault: false },
];

/**
 * Lazily seed a board's `statuses` array with the legacy default set if it's
 * empty. Catches pre-migration boards (where `migrateLabelsStatuses.js` never
 * ran) and any board that somehow lost its statuses, so the client's status
 * picker — which falls back to legacy enum options when `board.statuses` is
 * empty — sends values the server can resolve.
 */
const ensureBoardStatuses = async (board) => {
  if (!board) return board;
  if (Array.isArray(board.statuses) && board.statuses.length > 0) return board;
  board.statuses = DEFAULT_STATUSES.map((s) => ({ ...s }));
  if (!Array.isArray(board.labels)) board.labels = [];
  await board.save();
  return board;
};

/**
 * The shared board context, plus the status backfill the task API alone needs.
 *
 * Authorization is entirely `loadBoardContext`'s job — ask `ctx.can(capability)`.
 * This wrapper exists only because the task API is the one path that can reach a
 * pre-migration board whose `statuses` were never seeded, and every status read
 * and write below resolves against them. The seed now runs AFTER the shared read
 * gate rather than before it, so a caller who cannot open the board can no longer
 * provoke a write to it.
 */
const loadTaskBoardContext = async (boardId, userId) => {
  const ctx = await loadBoardContext(boardId, userId);
  if (ctx.error) return ctx;
  await ensureBoardStatuses(ctx.board);
  return ctx;
};

/**
 * THE 'only my own tasks' rule, in one place.
 *
 * `task.edit_assigned` is what makes the `contribute` rung worth having: you may
 * edit the work that is yours without being handed power over everyone else's.
 * `task.edit_any` is the unrestricted form.
 *
 * Every path that mutates an EXISTING task — its fields, its checklist, its
 * attachments — routes through here so the three cannot drift apart. Callers must
 * consult it BEFORE applying a patch, while `task.assignedTo` still holds the
 * pre-patch list; otherwise a user could assign themselves into their own
 * permission.
 *
 * The `createdBy` arm reads wider than the capability it is keyed to
 * ('task.edit_assigned' — "Edit tasks assigned to them"), and that is deliberate,
 * not an oversight: a `contribute` member may create a task, and a task you can
 * add but never touch again is not a contribution. The rung's own purpose — do
 * your own work — covers the work you entered as much as the work handed to you.
 * It confers nothing over anyone else's rows.
 */
const canEditTask = (ctx, task, userId) => {
  if (ctx.can('task.edit_any')) return true;
  if (!ctx.can('task.edit_assigned')) return false;
  const uid = String(userId);
  return (
    (task.assignedTo || []).some((u) => u && u.toString() === uid) ||
    (!!task.createdBy && task.createdBy.toString() === uid)
  );
};

/**
 * Resolve the default-status ObjectId for a board. Falls back to the first
 * status, then to the legacy enum string 'not_started' if the board has
 * no statuses configured (shouldn't happen post-migration, but guards the
 * controller against bad data).
 */
const resolveDefaultStatus = (board) => {
  if (!board || !Array.isArray(board.statuses) || board.statuses.length === 0) {
    return 'not_started';
  }
  const fav = board.statuses.find((s) => s.isDefault);
  return (fav || board.statuses[0])._id;
};

/**
 * Validate that the provided status is one of the board's statuses.
 * Returns the matching status subdoc, or null. Accepts:
 *   - string ObjectIds / Mongoose ObjectIds (the new representation)
 *   - legacy enum strings ('not_started' | 'working_on_it' | 'done' | 'stuck'),
 *     matched against the status's `key` field. This keeps legacy clients,
 *     stale client state (board.statuses not yet hydrated), and pre-migration
 *     task records working without forcing a client round-trip.
 */
const findBoardStatus = (board, statusInput) => {
  if (!board || !Array.isArray(board.statuses)) return null;
  if (statusInput == null) return null;
  const target = statusInput.toString();
  const legacyName = LEGACY_KEY_TO_NAME[target];
  return (
    board.statuses.find((s) => s._id.toString() === target) ||
    board.statuses.find((s) => s.key && s.key === target) ||
    (legacyName
      ? board.statuses.find(
          (s) => s.name && s.name.toLowerCase() === legacyName
        )
      : null) ||
    null
  );
};

/**
 * Filter the input label-id list down to ids that exist on the board.
 * Returns null when input is not an array (i.e. caller didn't pass labels).
 */
const sanitizeLabelsForBoard = (board, input) => {
  if (!Array.isArray(input)) return null;
  if (!board || !Array.isArray(board.labels)) return [];
  const known = new Set(board.labels.map((l) => l._id.toString()));
  const seen = new Set();
  const out = [];
  for (const raw of input) {
    if (!raw) continue;
    const id = raw.toString();
    if (!mongoose.Types.ObjectId.isValid(id)) continue;
    if (!known.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
};

/**
 * Validate a list of assignee user ids against an org's members. Returns a
 * de-duplicated list of string ids that are actually members, or an error
 * message if any id is invalid.
 *
 * Assignees must be able to READ the board, not merely belong to the org.
 * Assigning someone spawns a notification and an email that deep-link the board,
 * so an org-only check meant work could be handed to a person who then hits a 403
 * when they click through. Mirrors the same rule in automationController.
 *
 * `board` is null on paths with no board to gate on.
 */
const validateAssignees = async (assignedTo, org, board) => {
  if (!Array.isArray(assignedTo)) return { ids: [] };
  const memberIds = new Set(org.members.map((m) => m.toString()));
  const seen = new Set();
  const ids = [];
  for (const raw of assignedTo) {
    if (!raw) continue;
    const id = raw.toString();
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return { error: 'Invalid assignee id' };
    }
    if (!memberIds.has(id)) {
      return { error: 'Assignee is not a member of this organisation' };
    }
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (!ids.length || !board) return { ids };

  // `resolveAccess`, not the bare board standing: whether a user may open a board
  // depends on their ORG ROLE too — a Guest cannot reach a public board at all.
  const blocked = ids.filter((id) => !resolveAccess(board, org, id).canRead);
  if (blocked.length) {
    return { error: 'Assignee does not have access to this board' };
  }
  return { ids };
};

/**
 * The ids of the boards in `org` that `userId` may actually READ.
 *
 * The cross-board views (My Work, the calendar) scoped their board query on
 * `organisation` alone, which is not a permission: it handed every org member the
 * task names, due dates and — through the populated `board` — the NAMES of private
 * boards they cannot open. Org membership is not board membership, so resolve the
 * board layer per board and keep only what the caller can read.
 *
 * Selects exactly the fields `resolveAccess` reads. `org` must be the full
 * document: the org role is the other half of the AND, so `roles`/`memberRoles`
 * have to be on it.
 */
const readableBoardIds = async (org, userId) => {
  const boards = await Board.find({ organisation: org._id }).select(
    'visibility publicDefaultLevel memberAccess createdBy organisation'
  );
  return boards
    .filter((b) => resolveAccess(b, org, userId).canRead)
    .map((b) => b._id);
};

const populateTask = (query) =>
  query
    .populate('assignedTo', 'name profilePic email')
    .populate('createdBy', 'name profilePic email');

/**
 * Annotate a list of POJO tasks with `hasSubitems: bool` and
 * `subitemCount: number` so the board view can show an expand chevron and a
 * count badge next to rows that own children. One aggregation groups children
 * by parent — cheaper than per-row counts.
 */
const annotateHasSubitems = async (tasks) => {
  if (!Array.isArray(tasks) || tasks.length === 0) return tasks;
  const ids = tasks.map((t) => t._id).filter(Boolean);
  if (ids.length === 0) {
    for (const t of tasks) {
      t.hasSubitems = false;
      t.subitemCount = 0;
    }
    return tasks;
  }
  const counts = await Task.aggregate([
    { $match: { parent: { $in: ids } } },
    { $group: { _id: '$parent', count: { $sum: 1 } } },
  ]);
  const byParent = new Map(counts.map((c) => [c._id.toString(), c.count]));
  for (const t of tasks) {
    const count = t?._id ? byParent.get(t._id.toString()) || 0 : 0;
    t.subitemCount = count;
    t.hasSubitems = count > 0;
  }
  return tasks;
};

/**
 * Annotate a list of POJO tasks with `updatesCount: number` so the board view
 * can show a discussion-count badge on each row's updates icon. One aggregation
 * groups updates by task — cheaper than a per-row count query.
 */
const annotateUpdateCounts = async (tasks) => {
  if (!Array.isArray(tasks) || tasks.length === 0) return tasks;
  const ids = tasks.map((t) => t._id).filter(Boolean);
  if (ids.length === 0) {
    for (const t of tasks) t.updatesCount = 0;
    return tasks;
  }
  const counts = await Update.aggregate([
    // Exclude 'system' timeline events (portal-only status-change markers) so the
    // board's update-count badge reflects real discussion posts. BOTH threads are
    // counted: on a client board the team and client threads are separate tabs,
    // and the row badge means "this task has discussion" rather than tracking one
    // of them. Everyone who can read the row can read both.
    { $match: { task: { $in: ids }, authorType: { $ne: 'system' } } },
    { $group: { _id: '$task', count: { $sum: 1 } } },
  ]);
  const byTask = new Map(counts.map((c) => [c._id.toString(), c.count]));
  for (const t of tasks) {
    t.updatesCount = t?._id ? byTask.get(t._id.toString()) || 0 : 0;
  }
  return tasks;
};

/**
 * Friendly status label for notification messages. Uses the board's
 * status name if the task references one of its statuses; otherwise
 * falls back to a humanised version of the input.
 */
const describeStatus = (board, statusInput) => {
  const found = findBoardStatus(board, statusInput);
  if (found) return found.name;
  if (typeof statusInput === 'string') {
    return statusInput.replace(/_/g, ' ');
  }
  return 'updated';
};

/**
 * Compare two column values for equality. Handles arrays (ObjectId lists for
 * person/tags), plain objects (link/location/timeline), Dates, and primitives.
 * Used by the event-emit step to suppress no-op writes.
 */
const columnValuesEqual = (a, b) => {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    const aIds = a.map((v) => (v == null ? '' : v.toString())).sort();
    const bIds = b.map((v) => (v == null ? '' : v.toString())).sort();
    return aIds.every((v, i) => v === bIds[i]);
  }
  if (typeof a === 'object' && typeof b === 'object') {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch (_err) {
      return false;
    }
  }
  return a.toString() === b.toString();
};

/**
 * Validate and apply a `columnValues` patch onto a task. Returns either
 * `{ ok: true, changes: [{ column, fromValue, toValue }] }` or
 * `{ ok: false, errors: [{ columnId, message }] }` so the caller can ship a
 * 400 with field-level errors.
 *
 * Merges into the existing Map — keys not present in the patch are left alone.
 */
const applyColumnValuePatch = (task, board, patch) => {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, errors: [{ columnId: null, message: 'columnValues must be an object' }] };
  }
  if (!board || !Array.isArray(board.columns) || board.columns.length === 0) {
    return { ok: false, errors: [{ columnId: null, message: 'Board has no columns configured' }] };
  }

  const columnsById = new Map(board.columns.map((c) => [c._id.toString(), c]));
  const errors = [];
  const changes = [];

  for (const [cidRaw, rawValue] of Object.entries(patch)) {
    const cid = cidRaw.toString();
    const col = columnsById.get(cid);
    if (!col) {
      errors.push({ columnId: cid, message: 'Unknown column id on this board' });
      continue;
    }
    const entry = getColumnType(col.type);
    if (!entry) {
      errors.push({ columnId: cid, message: `Unknown column type: ${col.type}` });
      continue;
    }
    try {
      entry.validate(rawValue, col.settings || {});
    } catch (err) {
      errors.push({ columnId: cid, message: err.message, code: err.code });
      continue;
    }
    const serialized = entry.serialize ? entry.serialize(rawValue) : rawValue;
    const prevValue = task.columnValues ? task.columnValues.get(cid) : undefined;
    if (columnValuesEqual(prevValue, serialized)) continue;
    task.columnValues.set(cid, serialized);
    changes.push({ column: col, fromValue: prevValue == null ? null : prevValue, toValue: serialized });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, changes };
};

/**
 * Gate a `columnValues` patch on the capabilities its COLUMN TYPES carry.
 *
 * A cell write is not always "just an edit" — two column types ARE the mechanism
 * for a power that has its own capability elsewhere in this file, and reaching
 * them through the generic patch bypassed both gates:
 *
 *   person         → assignment. This controller emits 'task.person_assigned' off
 *                    a person column, so writing one hands the task to someone
 *                    exactly as `body.assignedTo` does. `task.assign` guarded only
 *                    the latter, which made the gate trivially avoidable by
 *                    writing the column instead.
 *   connect_boards → the cross-board wiring linkController guards with
 *                    `column.manage` PLUS read standing on every target board. A
 *                    link into a board you cannot open surfaces its rows through a
 *                    mirror on a board you can, which routes around board privacy.
 *
 * Runs BEFORE the patch is applied, so a denied write never touches the task.
 * Returns `{ status, error }` when denied, or null when allowed.
 */
const requireColumnPatchCapabilities = async (ctx, patch, userId) => {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return null;

  const columns = Array.isArray(ctx.board.columns) ? ctx.board.columns : [];
  const columnsById = new Map(columns.map((c) => [c._id.toString(), c]));

  let touchesPerson = false;
  let touchesConnect = false;
  const targetTaskIds = new Set();

  for (const [cidRaw, rawValue] of Object.entries(patch)) {
    const col = columnsById.get(cidRaw.toString());
    // An unknown column id is `applyColumnValuePatch`'s 400 to raise, not ours —
    // it writes nothing, so there is no power here to gate.
    if (!col) continue;
    if (col.type === 'person') touchesPerson = true;
    if (col.type === 'connect_boards') {
      touchesConnect = true;
      const links =
        rawValue && Array.isArray(rawValue.links) ? rawValue.links : [];
      for (const link of links) {
        // Collect the TASK id, never the caller's `boardId`. See below.
        const tid = link && link.taskId != null ? link.taskId.toString() : '';
        if (tid) targetTaskIds.add(tid);
      }
    }
  }

  if (touchesPerson) {
    const denied = requireCapability(
      ctx,
      'task.assign',
      'You do not have permission to assign people to tasks'
    );
    if (denied) return denied;
  }

  if (touchesConnect) {
    const denied = requireCapability(
      ctx,
      'column.manage',
      'You do not have permission to link tasks on this board'
    );
    if (denied) return denied;
  }

  // Clearing a connect cell names no target, so there is nothing further to
  // check — dropping a reference exposes nothing (mirrors linkController.unlink).
  if (targetTaskIds.size === 0) return null;

  const ids = [...targetTaskIds].filter((tid) =>
    mongoose.Types.ObjectId.isValid(tid)
  );
  if (ids.length !== targetTaskIds.size) {
    return { status: 400, error: 'connect_boards link has an invalid taskId' };
  }

  // THE LINK'S `boardId` IS NOT TRUSTED, AND MUST NOT BE.
  //
  // A link is `{ boardId, taskId }`, but only `taskId` is load-bearing: the mirror
  // renderer resolves the linked row purely by task id
  // (mirrorRefresh.js — `Task.find({ _id: { $in: links.map(l => l.taskId) } })`)
  // and reads its values against that task's OWN board. `boardId` is never
  // consulted again after the write.
  //
  // So gating on the caller's `boardId` gates a field nobody reads. Forge
  // `{ boardId: <a board I can read>, taskId: <a row on a board I cannot> }` and
  // the check passes while the mirror happily renders the private row. Revoking
  // someone's grant would not even help — they keep every task id they ever saw.
  //
  // Resolve the REAL board off each target task instead, and check that.
  const targetTasks = await Task.find({ _id: { $in: ids } }).select(
    'board isPersonal'
  );
  if (targetTasks.length !== ids.length) {
    return { status: 400, error: 'Target task not found' };
  }

  const boardIds = new Set();
  for (const t of targetTasks) {
    // A personal task belongs to no board, so there is no board access to check
    // and no legitimate reason to mirror one.
    if (t.isPersonal || !t.board) {
      return { status: 400, error: 'Cannot link to a personal task' };
    }
    boardIds.add(t.board.toString());
  }

  // Loaded whole rather than projected: resolving access reads `createdBy`,
  // `visibility`, `publicDefaultLevel` and `memberAccess`, not just the columns.
  const targets = await Board.find({ _id: { $in: [...boardIds] } });

  for (const target of targets) {
    // `ctx.org` is only the right org to resolve against for boards inside it.
    // Pre-F3 there is no cross-workspace grant, so a foreign target is refused
    // outright rather than resolved against the wrong org — the same rule
    // linkTask enforces, and fail-closed if that ever changes.
    if (target.organisation.toString() !== ctx.board.organisation.toString()) {
      return {
        status: 403,
        error: 'Cross-workspace links require a grant (arrives with F3)',
      };
    }
    if (!resolveAccess(target, ctx.org, userId).canRead) {
      return { status: 403, error: 'You do not have access to the target board' };
    }
  }

  return null;
};

/**
 * Emit the three F1 column events on eventBus for every successful column
 * change. Dormant in Phase 1 (no subscriber); F4 wires up triggers in Phase 2.
 *
 * - task.column_changed : fired for every change
 * - task.status_became  : fired when the column type is `status`
 * - task.person_assigned: fired when a `person` column gains user ids
 */
const emitColumnChangeEvents = (task, boardId, changes, actorId) => {
  for (const change of changes) {
    const { column, fromValue, toValue } = change;
    const payload = {
      taskId: task._id,
      boardId,
      columnId: column._id,
      fromValue,
      toValue,
      actorId,
    };
    eventBus.emit('task.column_changed', payload);

    if (column.type === 'status') {
      eventBus.emit('task.status_became', payload);
    }
    if (column.type === 'person') {
      const fromIds = new Set(
        (Array.isArray(fromValue) ? fromValue : []).map((v) => (v == null ? '' : v.toString()))
      );
      const toIds = Array.isArray(toValue) ? toValue : [];
      const addedUserIds = toIds
        .map((v) => (v == null ? '' : v.toString()))
        .filter((id) => id && !fromIds.has(id));
      if (addedUserIds.length > 0) {
        eventBus.emit('task.person_assigned', {
          taskId: task._id,
          boardId,
          columnId: column._id,
          addedUserIds,
          actorId,
        });
      }
    }
  }
};

/**
 * GET /api/tasks?board=:id&group=:id&month=YYYY-MM
 *
 * On a MONTHLY board `month` is REQUIRED. That is deliberate rather than
 * defaulting to the current month: an unfiltered read on a three-year retainer
 * board returns every task ever created and renders them all as though they
 * were this month's, which is precisely the "silently returns the wrong rows"
 * failure this board type exists to prevent. A caller that forgets the param
 * gets a 400 telling it so.
 *
 * The response echoes `monthKey` so the client can discard a stale in-flight
 * response for a month the user has already switched away from.
 */
const getTasks = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { board: boardId, group: groupId, month } = req.query;

    if (!boardId) {
      return res.status(400).json({ error: 'Board ID required' });
    }

    const ctx = await loadTaskBoardContext(boardId, userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

    // Top-level tasks only — subitems are fetched on demand via /:id/subitems.
    const filter = {
      board: boardId,
      isPersonal: { $ne: true },
      parent: null,
    };
    if (groupId) filter.group = groupId;

    const isMonthly = ctx.board?.boardType === 'monthly';
    if (isMonthly && month !== 'all') {
      if (!isMonthKey(month)) {
        return res.status(400).json({
          error: 'A month (YYYY-MM) is required when reading a monthly board',
          code: 'MONTH_REQUIRED',
        });
      }
      filter.monthKey = month;
    }
    // `month=all` is the deliberate opt-out, for callers that legitimately want
    // every month: the connect-boards picker listing link targets, for one. It
    // has to be asked for explicitly — the point of the 400 above is that
    // FORGETTING the month must not silently return three years of rows.
    //
    // On a standard or client board `month` is ignored rather than rejected —
    // a stale URL carrying ?month= should not break the board.

    const tasks = await populateTask(Task.find(filter))
      .sort({ order: 1, createdAt: 1 })
      .lean();
    await annotateHasSubitems(tasks);
    await annotateUpdateCounts(tasks);
    // F2: replace any mirror column cache wrappers with their bare computed
    // value so the DataGrid renders a plain value (no-op when the board has no
    // mirror columns).
    await embedMirrorValues(tasks, ctx.board);

    return res.json({ tasks, monthKey: isMonthly ? month : null });
  } catch (err) {
    console.error('getTasks error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * GET /api/tasks/:id/subitems — list direct children of a task.
 *
 * Any org member who can see the parent can read its subitems. Sorted by
 * creation time so they show in the order the user added them.
 */
const getSubitems = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid task id' });
    }

    const parent = await Task.findById(id);
    if (!parent) return res.status(404).json({ error: 'Task not found' });

    if (parent.isPersonal) {
      if (!parent.createdBy || parent.createdBy.toString() !== userId) {
        return res.status(403).json({ error: 'Not authorised' });
      }
    } else {
      const ctx = await loadTaskBoardContext(parent.board, userId);
      if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    }

    const subitems = await populateTask(Task.find({ parent: id })).sort({
      createdAt: 1,
    });

    return res.json({ tasks: subitems });
  } catch (err) {
    console.error('getSubitems error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * GET /api/tasks/my?org=:orgId
 *
 * Assigned board tasks are scoped to boards within `org` so switching
 * organisations doesn't leak work from another org. Personal tasks have no
 * organisation and are always included for the current user.
 */
const getMyTasks = async (req, res) => {
  try {
    const userId = req.user.userId;
    const userObjectId = new mongoose.Types.ObjectId(userId);

    const orgId = req.query.org;

    let boardTaskFilter = null;
    if (orgId && mongoose.Types.ObjectId.isValid(orgId)) {
      const org = await Organisation.findById(orgId);
      if (org) {
        const isMember = org.members.some((m) => m.toString() === userId);
        if (isMember) {
          // An org predating the role system carries no `roles`, so every
          // capability — board read included — resolves false and this view would
          // come back empty. Same lazy heal `loadBoardContext` does on first touch.
          if (org.ensureSystemRoles()) await org.save();
          const boardIds = await readableBoardIds(org, userId);
          if (boardIds.length > 0) {
            boardTaskFilter = {
              board: { $in: boardIds },
              assignedTo: userObjectId,
              isPersonal: { $ne: true },
              // Subitems assigned to the user are included so they can surface
              // on the My Work calendar. The Work/Personal list tabs filter
              // back down to top-level tasks client-side.
            };
          }
        }
      }
    }

    const personalFilter = {
      isPersonal: true,
      createdBy: userObjectId,
    };

    const filters = [personalFilter];
    if (boardTaskFilter) filters.push(boardTaskFilter);

    const tasks = await Task.find({ $or: filters })
      .populate('assignedTo', 'name profilePic email')
      .populate('createdBy', 'name profilePic email')
      .populate('board', 'name visibility statuses labels boardType')
      .populate('group', 'name')
      .populate('parent', 'name')
      .sort({ dueDate: 1, createdAt: -1 })
      .lean();
    await annotateHasSubitems(tasks);
    await annotateUpdateCounts(tasks);

    return res.json({ tasks });
  } catch (err) {
    console.error('getMyTasks error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * GET /api/tasks/calendar?month=:m&year=:y&org=:orgId
 */
const getCalendarTasks = async (req, res) => {
  try {
    const userId = req.user.userId;
    const userObjectId = new mongoose.Types.ObjectId(userId);

    const now = new Date();
    const rawMonth = parseInt(req.query.month, 10);
    const rawYear = parseInt(req.query.year, 10);
    const month =
      Number.isInteger(rawMonth) && rawMonth >= 1 && rawMonth <= 12
        ? rawMonth
        : now.getMonth() + 1;
    const year =
      Number.isInteger(rawYear) && rawYear >= 1970 && rawYear <= 9999
        ? rawYear
        : now.getFullYear();

    const start = new Date(year, month - 1, 1);
    const end = new Date(year, month, 1);

    const orgId = req.query.org;

    let boardTaskFilter = null;
    if (orgId && mongoose.Types.ObjectId.isValid(orgId)) {
      const org = await Organisation.findById(orgId);
      if (org) {
        const isMember = org.members.some((m) => m.toString() === userId);
        if (isMember) {
          // See getMyTasks — an org with no `roles` yet must be healed before the
          // resolver can answer, or the calendar silently empties.
          if (org.ensureSystemRoles()) await org.save();
          const boardIds = await readableBoardIds(org, userId);
          if (boardIds.length > 0) {
            boardTaskFilter = {
              board: { $in: boardIds },
              isPersonal: { $ne: true },
              // Subitems are included on the calendar (no `parent: null`):
              // a subtask with its own due date should still show up.
              dueDate: { $gte: start, $lt: end },
            };
          }
        }
      }
    }

    const personalFilter = {
      isPersonal: true,
      createdBy: userObjectId,
      dueDate: { $gte: start, $lt: end },
    };

    const filters = [personalFilter];
    if (boardTaskFilter) filters.push(boardTaskFilter);

    const tasks = await Task.find({ $or: filters })
      .populate('assignedTo', 'name profilePic email')
      .populate('createdBy', 'name profilePic email')
      .populate('board', 'name visibility statuses labels boardType')
      .populate('parent', 'name')
      .sort({ dueDate: 1, createdAt: 1 })
      .lean();
    await annotateHasSubitems(tasks);
    await annotateUpdateCounts(tasks);

    return res.json({ tasks, month, year });
  } catch (err) {
    console.error('getCalendarTasks error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/tasks
 *
 * Create a task. Two modes:
 *   - Board task: requires `board` and `group`, and `task.create`. `status` must
 *     be an ObjectId in the target board's `statuses`; if omitted, falls back
 *     to the board's default status. `labels` must reference ids in
 *     board.labels.
 *   - Personal task: `isPersonal: true`. Belongs to its creator alone, so it
 *     bypasses board permissions entirely. `status` accepts the legacy enum
 *     strings.
 */
const createTask = async (req, res) => {
  try {
    const userId = req.user.userId;
    const {
      name,
      board: boardId,
      group: groupId,
      priority,
      status,
      assignedTo,
      dueDate,
      note,
      isPersonal,
      labels,
      parent: parentId,
      portalShared,
      monthKey,
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Task name is required' });
    }

    if (priority && !VALID_PRIORITIES.includes(priority)) {
      return res.status(400).json({ error: 'Invalid priority' });
    }

    // Personal task path
    if (isPersonal) {
      const personalStatus =
        typeof status === 'string' && LEGACY_STATUS_KEYS.includes(status)
          ? status
          : 'not_started';
      const task = await Task.create({
        name: name.trim(),
        priority: priority || 'medium',
        status: personalStatus,
        dueDate: dueDate || undefined,
        note: note || undefined,
        isPersonal: true,
        createdBy: userId,
      });
      logActivity({
        task,
        actor: userId,
        type: 'task.created',
        metadata: { taskName: task.name },
      });
      const populated = await populateTask(Task.findById(task._id));
      return res.status(201).json({ task: populated });
    }

    // Board task path — requires board + group
    if (!boardId || !groupId) {
      return res
        .status(400)
        .json({ error: 'Board and group are required for board tasks' });
    }

    const ctx = await loadTaskBoardContext(boardId, userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    const denied = requireCapability(
      ctx,
      'task.create',
      'You do not have permission to create tasks on this board'
    );
    if (denied) return res.status(denied.status).json({ error: denied.error });

    const group = await TaskGroup.findById(groupId);
    if (!group || group.board.toString() !== boardId) {
      return res.status(400).json({ error: 'Group does not belong to board' });
    }

    // Validate parent task (subitem creation). Parent must exist on the same
    // board; nesting beyond one level is not supported in this iteration.
    let resolvedParent = null;
    if (parentId) {
      if (!mongoose.Types.ObjectId.isValid(parentId)) {
        return res.status(400).json({ error: 'Invalid parent id' });
      }
      const parentTask = await Task.findById(parentId);
      if (!parentTask) {
        return res.status(400).json({ error: 'Parent task not found' });
      }
      if (!parentTask.board || parentTask.board.toString() !== boardId) {
        return res.status(400).json({ error: 'Parent task is on a different board' });
      }
      if (parentTask.parent) {
        return res.status(400).json({ error: 'Subitems cannot be nested further' });
      }
      resolvedParent = parentTask._id;
    }

    // Validate status against the board's configured statuses.
    let resolvedStatus = resolveDefaultStatus(ctx.board);
    if (status !== undefined && status !== null && status !== '') {
      const match = findBoardStatus(ctx.board, status);
      if (!match) {
        return res.status(400).json({ error: 'Invalid status for this board' });
      }
      resolvedStatus = match._id;
    }

    // Validate labels against the board's configured labels.
    let resolvedLabels = [];
    if (labels !== undefined) {
      const sanitized = sanitizeLabelsForBoard(ctx.board, labels);
      if (sanitized === null) {
        return res.status(400).json({ error: 'Invalid labels payload' });
      }
      resolvedLabels = sanitized;
    }

    const { ids: assigneeIds, error: assigneeErr } = await validateAssignees(
      assignedTo,
      ctx.org,
      ctx.board
    );
    if (assigneeErr) return res.status(400).json({ error: assigneeErr });

    // Adding work to the board and putting it on another person are two
    // different powers: `contribute` holds the first, only `edit` the second.
    // Gated on the payload actually naming someone, so creating an unassigned
    // task stays open to every contributor.
    if (assigneeIds.length > 0) {
      const assignDenied = requireCapability(
        ctx,
        'task.assign',
        'You do not have permission to assign people to tasks'
      );
      if (assignDenied) {
        return res.status(assignDenied.status).json({ error: assignDenied.error });
      }
    }

    // Client Portal: the creator can publish the task to the client's portal in
    // the same keystroke ("we need X from you"). Same gate as the standalone
    // toggle, run against the task we are about to build.
    const wantsPortalShare = portalShared === true;
    if (wantsPortalShare) {
      const shareDenied = denyPortalShare(ctx, {
        parent: resolvedParent,
        portalSubmitter: null,
      });
      if (shareDenied) {
        return res.status(shareDenied.status).json({ error: shareDenied.error });
      }
    }

    // Assign the next order so new tasks land at the end of their group
    // (or end of their parent's subitem list).
    const orderScope = resolvedParent
      ? { parent: resolvedParent }
      : { group: groupId, parent: null };
    const lastSibling = await Task.findOne(orderScope)
      .sort({ order: -1 })
      .select('order')
      .lean();
    const nextTaskOrder = (lastSibling?.order ?? -1) + 1;

    // Which month does this task belong to?
    //
    // The SELECTED month, not today's — creating a task while looking at July
    // must file it in July, which is the whole reason `monthKey` is stored
    // rather than derived from `createdAt`. Falls back to the board's current
    // month when the client sends nothing (an older client, or the API).
    //
    // A subitem always inherits its parent's month, ignoring anything the
    // client sent: a subitem added in September to an August task is part of
    // August's work, and letting the two drift apart would put a parent and its
    // own child in different months.
    let resolvedMonthKey = null;
    if (ctx.board.boardType === 'monthly') {
      if (resolvedParent) {
        const parentDoc = await Task.findById(resolvedParent).select('monthKey').lean();
        resolvedMonthKey = parentDoc?.monthKey || null;
      } else if (isMonthKey(monthKey)) {
        resolvedMonthKey = monthKey;
      }
      if (!resolvedMonthKey) {
        resolvedMonthKey = monthKeyOf(new Date(), ctx.board.monthTimezone || 'UTC');
      }
    }

    const task = await Task.create({
      name: name.trim(),
      board: boardId,
      group: groupId,
      monthKey: resolvedMonthKey,
      priority: priority || 'medium',
      status: resolvedStatus,
      labels: resolvedLabels,
      assignedTo: assigneeIds,
      dueDate: dueDate || undefined,
      note: note || undefined,
      isPersonal: false,
      parent: resolvedParent,
      order: nextTaskOrder,
      createdBy: userId,
      portalShared: wantsPortalShare,
      portalSharedAt: wantsPortalShare ? new Date() : null,
      portalRef: wantsPortalShare ? await claimPortalRef(boardId) : null,
    });

    await Board.updateOne({ _id: boardId }, { $set: { updatedAt: new Date() } });

    logActivity({
      task,
      actor: userId,
      type: 'task.created',
      metadata: {
        taskName: task.name,
        isSubitem: !!resolvedParent,
        portalShared: wantsPortalShare,
      },
    });

    // Created already visible to the client — tell them, same as flipping the
    // toggle later would. Fire-and-forget; the helper swallows its own errors.
    if (wantsPortalShare) {
      emailClientsOnPortalShare(task, ctx.board);
    }

    // Fan out an item.created event for ITEM_CREATED automations. Subitems
    // are excluded to avoid recursion (a CREATE_SUBITEM action could otherwise
    // re-trigger itself). Personal tasks never enter this branch.
    if (!resolvedParent) {
      eventBus.emit('item.created', {
        taskId: task._id,
        boardId,
        groupId,
        statusId: resolvedStatus,
        createdByUserId: userId,
      });
    }

    // Apply POSITION_ITEM automations synchronously so the response already
    // reflects the task's final spot — the client can drop it straight into
    // place instead of showing it at the bottom and hopping it to the top when
    // the async item.created path lands. Idempotent with that async path.
    // Lazy require avoids a load-time cycle (dispatcher -> automationController).
    let groupTasks = null;
    if (!resolvedParent) {
      try {
        const {
          applyItemCreatedPositioning,
        } = require('../services/automationEventDispatcher');
        const movedGroupId = await applyItemCreatedPositioning({
          taskId: task._id,
          boardId,
          groupId,
          statusId: resolvedStatus,
          createdByUserId: userId,
        });
        if (movedGroupId) {
          groupTasks = await populateTask(
            Task.find({ group: movedGroupId, parent: null, isPersonal: { $ne: true } })
          )
            .sort({ order: 1, createdAt: 1 })
            .lean();
          await annotateHasSubitems(groupTasks);
          await annotateUpdateCounts(groupTasks);
        }
      } catch (err) {
        console.error('createTask positioning error:', err);
      }
    }

    if (assigneeIds.length > 0) {
      await createNotificationsForUsers({
        userIds: assigneeIds,
        type: 'assigned',
        message: `You were assigned to "${task.name}"`,
        taskId: task._id,
        orgId: ctx.board.organisation,
        excludeUserId: userId,
        actorId: userId,
        boardId,
      });
    }

    if (assigneeIds.length > 0) {
      const taskLink = buildTaskDeepLink(task, { boardId });
      const assigneeUsers = await User.find({ _id: { $in: assigneeIds } }).select('email').lean();
      const emailAllowed = await filterByEmailPreference(assigneeIds, 'assigned', {
        boardId,
        actorId: userId,
      });
      const emailResults = await Promise.allSettled(
        assigneeUsers
          .filter((u) => u.email && emailAllowed.has(u._id.toString()))
          .map((u) =>
            sendTaskAssignmentEmail({
              to: u.email,
              taskName: task.name,
              priority: task.priority,
              dueDate: task.dueDate,
              taskLink,
              assignedByName: req.user?.name || '',
            })
          )
      );
      emailResults.forEach((result, i) => {
        if (result.status === 'rejected') {
          console.error(`[email] Failed to send to ${assigneeUsers[i]?.email}:`, result.reason?.message || result.reason);
        }
      });
    }

    const populated = await populateTask(Task.findById(task._id));
    return res.status(201).json({ task: populated, groupTasks });
  } catch (err) {
    console.error('createTask error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * PUT /api/tasks/:id
 */
const updateTask = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    const body = req.body || {};

    const task = await Task.findById(id);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    // ----- Personal task branch -----
    if (task.isPersonal) {
      if (!task.createdBy || task.createdBy.toString() !== userId) {
        return res.status(403).json({ error: 'Not authorised' });
      }
      if (body.columnValues !== undefined) {
        // Personal tasks have no board, so no columns — reject the write.
        return res
          .status(400)
          .json({ error: 'Personal tasks do not support columnValues' });
      }
      const changes = [];
      if (typeof body.name === 'string') {
        if (!body.name.trim()) {
          return res.status(400).json({ error: 'Task name cannot be empty' });
        }
        const next = body.name.trim();
        if (next !== task.name) changes.push({ field: 'name', oldValue: task.name, newValue: next });
        task.name = next;
      }
      if (body.priority !== undefined) {
        if (!VALID_PRIORITIES.includes(body.priority)) {
          return res.status(400).json({ error: 'Invalid priority' });
        }
        if (body.priority !== task.priority) changes.push({ field: 'priority', oldValue: task.priority, newValue: body.priority });
        task.priority = body.priority;
      }
      if (body.status !== undefined) {
        if (typeof body.status !== 'string' || !LEGACY_STATUS_KEYS.includes(body.status)) {
          return res.status(400).json({ error: 'Invalid status' });
        }
        if (body.status !== task.status) changes.push({ field: 'status', oldValue: task.status, newValue: body.status });
        task.status = body.status;
      }
      if (body.dueDate !== undefined) {
        const nextDue = body.dueDate || null;
        const prevDue = task.dueDate || null;
        const prevIso = prevDue ? new Date(prevDue).toISOString() : null;
        const nextIso = nextDue ? new Date(nextDue).toISOString() : null;
        if (prevIso !== nextIso) changes.push({ field: 'dueDate', oldValue: prevIso, newValue: nextIso });
        task.dueDate = body.dueDate || undefined;
      }
      if (body.note !== undefined) {
        const nextNote = body.note || '';
        const prevNote = task.note || '';
        if (nextNote !== prevNote) changes.push({ field: 'note', oldValue: prevNote, newValue: nextNote });
        task.note = body.note || undefined;
      }
      await task.save();
      for (const c of changes) {
        logActivity({
          task,
          actor: userId,
          type: 'task.field_changed',
          field: c.field,
          oldValue: c.oldValue,
          newValue: c.newValue,
          metadata: { taskName: task.name },
        });
      }
      const populated = await populateTask(Task.findById(task._id));
      return res.json({ task: populated });
    }

    // ----- Board task branch -----
    const ctx = await loadTaskBoardContext(task.board, userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

    // THE 'only my own tasks' rule. Someone who may not edit THIS task can still
    // get exactly one thing through: a status change. Dragging a card along the
    // board is its own capability precisely because it is not the same power as
    // rewriting what the card says.
    if (!canEditTask(ctx, task, userId)) {
      const touchedKeys = Object.keys(body).filter((k) => body[k] !== undefined);
      const statusOnly =
        touchedKeys.length === 1 && touchedKeys[0] === 'status';
      if (!statusOnly || !ctx.can('task.change_status')) {
        return res
          .status(403)
          .json({ error: 'You do not have permission to edit this task' });
      }
      const match = findBoardStatus(ctx.board, body.status);
      if (!match) {
        return res.status(400).json({ error: 'Invalid status for this board' });
      }
      const prevStatus = task.status ? task.status.toString() : null;
      task.status = match._id;
      await task.save();

      // F2: a board task changed — mirrors on boards that link to it may now
      // be stale. Dormant unless a BoardConnection targets this board.
      eventBus.emit('task.updated', { taskId: task._id, boardId: task.board });

      if (prevStatus !== match._id.toString()) {
        await notifyTaskAudience(task, {
          type: 'statusChanged',
          message: `Status of "${task.name}" changed to ${match.name}`,
          orgId: ctx.board.organisation,
          excludeUserId: userId,
          actorId: userId,
          boardId: task.board,
        });
        emailClientOnResolve(task, ctx.board);
        logClientStatusChange(task, match.name);
        logActivity({
          task,
          actor: userId,
          type: 'task.field_changed',
          field: 'status',
          oldValue: prevStatus,
          newValue: match._id.toString(),
          metadata: { taskName: task.name },
        });
      }

      const populated = await populateTask(Task.findById(task._id));
      return res.json({ task: populated });
    }

    // Full-edit path. Every field is editable, save for the two that carry a
    // capability of their own: handing the task to someone else (task.assign) and
    // re-homing it in another group (task.move). The `edit` rung confers both, so
    // this only bites a `contribute` member editing a task of their own, or a
    // custom role that was deliberately denied them.
    const prevStatus = task.status ? task.status.toString() : null;
    const prevAssigneeIds = task.assignedTo.map((u) => u.toString());
    const prevLabelIds = (task.labels || []).map((l) => l.toString());
    const prevName = task.name;
    const prevPriority = task.priority;
    const prevDueIso = task.dueDate ? new Date(task.dueDate).toISOString() : null;
    const prevNote = task.note || '';
    const prevGroup = task.group ? task.group.toString() : null;
    let statusChanged = false;
    let newAssigneeIds = null;
    let removedAssigneeIds = null;
    let statusName = null;
    let columnChanges = [];
    const activityChanges = [];

    // ----- columnValues patch (flexible-columns engine, F1) ---------------
    if (body.columnValues !== undefined) {
      // `canEditTask` above says you may edit THIS task. It does not say you may
      // assign it to someone or wire it to another board — those are separate
      // capabilities, and a person / connect_boards cell is how you exercise them.
      const colDenied = await requireColumnPatchCapabilities(
        ctx,
        body.columnValues,
        userId
      );
      if (colDenied) {
        return res.status(colDenied.status).json({ error: colDenied.error });
      }
      const result = applyColumnValuePatch(task, ctx.board, body.columnValues);
      if (!result.ok) {
        return res.status(400).json({ errors: result.errors });
      }
      columnChanges = result.changes;
      for (const change of result.changes) {
        activityChanges.push({
          field: `column:${change.column.key}`,
          oldValue: change.fromValue,
          newValue: change.toValue,
        });
      }
    }

    if (typeof body.name === 'string') {
      if (!body.name.trim()) {
        return res.status(400).json({ error: 'Task name cannot be empty' });
      }
      const next = body.name.trim();
      if (next !== prevName) activityChanges.push({ field: 'name', oldValue: prevName, newValue: next });
      task.name = next;
    }
    if (body.priority !== undefined) {
      if (!VALID_PRIORITIES.includes(body.priority)) {
        return res.status(400).json({ error: 'Invalid priority' });
      }
      if (body.priority !== prevPriority) activityChanges.push({ field: 'priority', oldValue: prevPriority, newValue: body.priority });
      task.priority = body.priority;
    }
    if (body.status !== undefined && body.status !== null) {
      const requestedStatus = body.status.toString();
      if (requestedStatus !== prevStatus) {
        const match = findBoardStatus(ctx.board, body.status);
        if (!match) {
          return res.status(400).json({
            error: `Status "${requestedStatus}" is not configured for this board`,
            field: 'status',
          });
        }
        statusChanged = true;
        activityChanges.push({ field: 'status', oldValue: prevStatus, newValue: match._id.toString() });
        task.status = match._id;
        statusName = match.name;
      }
    }
    if (body.labels !== undefined) {
      const sanitized = sanitizeLabelsForBoard(ctx.board, body.labels);
      if (sanitized === null) {
        return res.status(400).json({ error: 'Invalid labels payload' });
      }
      const prevSet = new Set(prevLabelIds);
      const nextSet = new Set(sanitized.map((s) => s.toString()));
      const labelsChanged =
        prevSet.size !== nextSet.size ||
        [...prevSet].some((id) => !nextSet.has(id));
      if (labelsChanged) {
        activityChanges.push({ field: 'labels', oldValue: prevLabelIds, newValue: sanitized });
      }
      task.labels = sanitized;
    }
    if (body.assignedTo !== undefined) {
      const { ids, error: assigneeErr } = await validateAssignees(
        body.assignedTo,
        ctx.org,
        ctx.board
      );
      if (assigneeErr) return res.status(400).json({ error: assigneeErr });
      const prevSet = new Set(prevAssigneeIds);
      newAssigneeIds = ids.filter((id) => !prevSet.has(id));
      const nextSet = new Set(ids);
      removedAssigneeIds = prevAssigneeIds.filter((id) => !nextSet.has(id));
      const assigneesChanged =
        prevSet.size !== nextSet.size ||
        [...prevSet].some((id) => !nextSet.has(id));
      if (assigneesChanged) {
        // Only an actual change of the assignee set counts as assigning. A client
        // that echoes the current list back while editing an unrelated field must
        // not trip a gate it never meant to touch.
        const assignDenied = requireCapability(
          ctx,
          'task.assign',
          'You do not have permission to assign people to tasks'
        );
        if (assignDenied) {
          return res.status(assignDenied.status).json({ error: assignDenied.error });
        }
        activityChanges.push({ field: 'assignees', oldValue: prevAssigneeIds, newValue: ids });
      }
      task.assignedTo = ids;
    }
    if (body.dueDate !== undefined) {
      const nextDue = body.dueDate || null;
      const nextIso = nextDue ? new Date(nextDue).toISOString() : null;
      if (prevDueIso !== nextIso) activityChanges.push({ field: 'dueDate', oldValue: prevDueIso, newValue: nextIso });
      task.dueDate = body.dueDate || undefined;
    }
    if (body.note !== undefined) {
      const nextNote = body.note || '';
      if (nextNote !== prevNote) activityChanges.push({ field: 'note', oldValue: prevNote, newValue: nextNote });
      task.note = body.note || undefined;
    }
    if (body.group !== undefined && body.group !== null) {
      const newGroup = await TaskGroup.findById(body.group);
      if (!newGroup || newGroup.board.toString() !== task.board.toString()) {
        return res
          .status(400)
          .json({ error: 'Group does not belong to board' });
      }
      if (prevGroup !== body.group.toString()) {
        // Same reasoning as assignees: only a real re-home is a move, so a client
        // echoing the task's current group back does not need `task.move`.
        const moveDenied = requireCapability(
          ctx,
          'task.move',
          'You do not have permission to move tasks between groups'
        );
        if (moveDenied) {
          return res.status(moveDenied.status).json({ error: moveDenied.error });
        }
        activityChanges.push({ field: 'group', oldValue: prevGroup, newValue: body.group.toString() });
      }
      task.group = body.group;
    }

    await task.save();
    for (const c of activityChanges) {
      logActivity({
        task,
        actor: userId,
        type: 'task.field_changed',
        field: c.field,
        oldValue: c.oldValue,
        newValue: c.newValue,
        metadata: { taskName: task.name },
      });
    }
    // F1: emit column-change events for direct columnValues writes. Dormant
    // in Phase 1 (no Phase 1 subscriber); F4 triggers will pick them up.
    if (columnChanges.length > 0) {
      emitColumnChangeEvents(task, task.board, columnChanges, userId);
    }
    // F2: signal that a board task changed so mirrorRefresh can invalidate any
    // mirrors on boards that link to it.
    eventBus.emit('task.updated', { taskId: task._id, boardId: task.board });
    await Board.updateOne(
      { _id: task.board },
      { $set: { updatedAt: new Date() } }
    );

    if (newAssigneeIds && newAssigneeIds.length > 0) {
      await createNotificationsForUsers({
        userIds: newAssigneeIds,
        type: 'assigned',
        message: `You were assigned to "${task.name}"`,
        taskId: task._id,
        orgId: ctx.board.organisation,
        excludeUserId: userId,
        actorId: userId,
        boardId: task.board,
      });
    }
    if (removedAssigneeIds && removedAssigneeIds.length > 0) {
      await createNotificationsForUsers({
        userIds: removedAssigneeIds,
        type: 'unassigned',
        message: `You were removed from "${task.name}"`,
        taskId: task._id,
        orgId: ctx.board.organisation,
        excludeUserId: userId,
        actorId: userId,
        boardId: task.board,
      });
    }
    if (statusChanged) {
      await notifyTaskAudience(task, {
        type: 'statusChanged',
        message: `Status of "${task.name}" changed to ${statusName || describeStatus(ctx.board, task.status)}`,
        orgId: ctx.board.organisation,
        excludeUserId: userId,
        actorId: userId,
        boardId: task.board,
      });
      emailClientOnResolve(task, ctx.board);
      logClientStatusChange(task, statusName || describeStatus(ctx.board, task.status));
    }
    if (activityChanges.some((c) => c.field === 'group')) {
      await notifyTaskAudience(task, {
        type: 'taskMoved',
        message: `"${task.name}" was moved to a new group`,
        orgId: ctx.board.organisation,
        excludeUserId: userId,
        actorId: userId,
        boardId: task.board,
      });
    }
    if (activityChanges.some((c) => c.field === 'dueDate')) {
      await notifyTaskAudience(task, {
        type: 'dueDateChanged',
        message: `Due date for "${task.name}" was updated`,
        orgId: ctx.board.organisation,
        excludeUserId: userId,
        actorId: userId,
        boardId: task.board,
      });
    }

    if (newAssigneeIds && newAssigneeIds.length > 0) {
      const taskLink = buildTaskDeepLink(task);
      const assigneeUsers = await User.find({ _id: { $in: newAssigneeIds } }).select('email').lean();
      const emailAllowed = await filterByEmailPreference(newAssigneeIds, 'assigned', {
        boardId: task.board,
        actorId: userId,
      });
      const emailResults = await Promise.allSettled(
        assigneeUsers
          .filter((u) => u.email && emailAllowed.has(u._id.toString()))
          .map((u) =>
            sendTaskAssignmentEmail({
              to: u.email,
              taskName: task.name,
              priority: task.priority,
              dueDate: task.dueDate,
              taskLink,
              assignedByName: req.user?.name || '',
            })
          )
      );
      emailResults.forEach((result, i) => {
        if (result.status === 'rejected') {
          console.error(`[email] Failed to send to ${assigneeUsers[i]?.email}:`, result.reason?.message || result.reason);
        }
      });
    }

    const populated = await populateTask(Task.findById(task._id));
    return res.json({ task: populated });
  } catch (err) {
    console.error('updateTask error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Load a task and the caller's standing on its board, for the paths that mutate
 * a task's CONTENT rather than its fields — checklist items and attachments.
 *
 * This is the READ gate only; the caller applies whatever capability its own
 * mutation needs (see `requireTaskEdit`). Personal tasks have no board and belong
 * to their creator alone, so they resolve here with `ctx: null` and never consult
 * board permissions.
 *
 * Returns { task, ctx } on success, or { status, error } on failure.
 */
const loadTaskContext = async (taskId, userId) => {
  if (!mongoose.Types.ObjectId.isValid(taskId)) {
    return { status: 400, error: 'Invalid task id' };
  }
  const task = await Task.findById(taskId);
  if (!task) return { status: 404, error: 'Task not found' };

  if (task.isPersonal) {
    if (!task.createdBy || task.createdBy.toString() !== userId) {
      return { status: 403, error: 'Not authorised' };
    }
    return { task, ctx: null };
  }

  const ctx = await loadTaskBoardContext(task.board, userId);
  if (ctx.error) return { status: ctx.status, error: ctx.error };
  return { task, ctx };
};

/**
 * Gate a mutation of an existing task's content. Returns `{ status, error }` when
 * denied, or null when allowed.
 *
 * Checklist items and attachments were writable by anyone who could merely SEE
 * the board — a view-only member could tick another team's checkboxes or delete
 * their files. They are task content, so they now answer to exactly the same rule
 * as editing the task itself.
 *
 * A personal task (`ctx === null`) was already authorised by ownership in
 * `loadTaskContext` and has no board to consult.
 */
const requireTaskEdit = (ctx, task, userId) => {
  if (!ctx) return null;
  if (canEditTask(ctx, task, userId)) return null;
  return { status: 403, error: 'You do not have permission to edit this task' };
};

/**
 * POST /api/tasks/:id/checklist — add a new checklist item.
 */
const addChecklistItem = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';

    if (!text) {
      return res.status(400).json({ error: 'Checklist item text is required' });
    }

    const result = await loadTaskContext(id, userId);
    if (result.error) return res.status(result.status).json({ error: result.error });
    const task = result.task;
    const denied = requireTaskEdit(result.ctx, task, userId);
    if (denied) return res.status(denied.status).json({ error: denied.error });

    task.checklist.push({ text, done: false });
    await task.save();

    logActivity({
      task,
      actor: userId,
      type: 'checklist.added',
      metadata: { itemText: text, taskName: task.name },
    });

    const populated = await populateTask(Task.findById(task._id));
    return res.status(201).json({ task: populated });
  } catch (err) {
    console.error('addChecklistItem error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * PUT /api/tasks/:id/checklist/:itemId — toggle done and/or rename.
 */
const updateChecklistItem = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id, itemId } = req.params;
    const body = req.body || {};

    const result = await loadTaskContext(id, userId);
    if (result.error) return res.status(result.status).json({ error: result.error });
    const task = result.task;
    const denied = requireTaskEdit(result.ctx, task, userId);
    if (denied) return res.status(denied.status).json({ error: denied.error });

    const item = task.checklist.id(itemId);
    if (!item) return res.status(404).json({ error: 'Checklist item not found' });

    const prevText = item.text;
    const prevDone = item.done;
    const events = [];

    if (body.text !== undefined) {
      if (typeof body.text !== 'string') {
        return res.status(400).json({ error: 'Invalid text' });
      }
      const next = body.text.trim();
      if (next !== prevText) {
        events.push({ type: 'checklist.renamed', oldValue: prevText, newValue: next, metadata: { itemText: next, taskName: task.name } });
      }
      item.text = next;
    }
    if (body.done !== undefined) {
      const next = !!body.done;
      if (next !== prevDone) {
        events.push({ type: 'checklist.toggled', oldValue: prevDone, newValue: next, metadata: { itemText: item.text, taskName: task.name } });
      }
      item.done = next;
    }

    await task.save();

    for (const e of events) {
      logActivity({ task, actor: userId, ...e });
    }

    const populated = await populateTask(Task.findById(task._id));
    return res.json({ task: populated });
  } catch (err) {
    console.error('updateChecklistItem error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * DELETE /api/tasks/:id/checklist/:itemId
 */
const deleteChecklistItem = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id, itemId } = req.params;

    const result = await loadTaskContext(id, userId);
    if (result.error) return res.status(result.status).json({ error: result.error });
    const task = result.task;
    const denied = requireTaskEdit(result.ctx, task, userId);
    if (denied) return res.status(denied.status).json({ error: denied.error });

    const item = task.checklist.id(itemId);
    if (!item) return res.status(404).json({ error: 'Checklist item not found' });

    const removedText = item.text;
    task.checklist.pull(itemId);
    await task.save();

    logActivity({
      task,
      actor: userId,
      type: 'checklist.deleted',
      metadata: { itemText: removedText, taskName: task.name },
    });

    const populated = await populateTask(Task.findById(task._id));
    return res.json({ task: populated });
  } catch (err) {
    console.error('deleteChecklistItem error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * PUT /api/tasks/:id/checklist/reorder — reorder checklist items.
 * Body: { orderedIds: [itemId, ...] } — must list every existing item exactly once.
 */
const reorderChecklist = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    const orderedIds = Array.isArray(req.body?.orderedIds) ? req.body.orderedIds : null;

    if (!orderedIds) {
      return res.status(400).json({ error: 'orderedIds[] is required' });
    }

    const result = await loadTaskContext(id, userId);
    if (result.error) return res.status(result.status).json({ error: result.error });
    const task = result.task;
    const denied = requireTaskEdit(result.ctx, task, userId);
    if (denied) return res.status(denied.status).json({ error: denied.error });

    const currentIds = task.checklist.map((i) => i._id.toString());
    if (
      orderedIds.length !== currentIds.length ||
      !orderedIds.every((oid) => currentIds.includes(oid.toString()))
    ) {
      return res.status(400).json({ error: 'orderedIds must list every checklist item exactly once' });
    }

    const byId = new Map();
    for (const item of task.checklist) byId.set(item._id.toString(), item);
    const prevOrder = currentIds.slice();
    const nextOrder = orderedIds.map((oid) => oid.toString());
    task.checklist = orderedIds.map((oid) => byId.get(oid.toString()));
    await task.save();

    const moved = prevOrder.some((prevId, i) => prevId !== nextOrder[i]);
    if (moved) {
      logActivity({
        task,
        actor: userId,
        type: 'checklist.reordered',
        metadata: { taskName: task.name, itemCount: nextOrder.length },
      });
    }

    const populated = await populateTask(Task.findById(task._id));
    return res.json({ task: populated });
  } catch (err) {
    console.error('reorderChecklist error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * PUT /api/tasks/reorder — reorder tasks within a single target group.
 *
 * Body: { orderedIds: [taskId,...], targetGroupId }
 *
 * Handles both intra-group reordering and cross-group moves. The client
 * sends the FULL desired order of the target group after the drop; tasks
 * not present in the target group before the drop are assumed to have
 * moved in from another group on the same board and will have their
 * `group` field updated. All ids must reference top-level board tasks on
 * the same board as the target group.
 */
/**
 * PUT /api/tasks/move-month
 * Body: { taskIds: [id,...], monthKey: 'YYYY-MM' }
 *
 * Refiles tasks into a different month. Serves both the row menu (one id) and
 * the bulk selection bar (many), the same way "Move to group" does.
 *
 * Gated on `task.move` — the same authority as moving a task between groups,
 * and for the same reason: it relocates somebody else's row out of the view
 * they are working in.
 *
 * A separate endpoint rather than an extra field on `reorderTasks`, because
 * that one rewrites `order` across the whole target group, which is meaningless
 * here — a task keeps its position within its group when it changes month.
 *
 * Subitems follow their parent automatically and cannot be moved on their own.
 */
const MAX_MONTH_MOVE = 500;

const moveTasksToMonth = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { taskIds, monthKey } = req.body || {};

    if (!Array.isArray(taskIds) || taskIds.length === 0) {
      return res.status(400).json({ error: 'taskIds must be a non-empty array' });
    }
    if (taskIds.length > MAX_MONTH_MOVE) {
      return res.status(400).json({
        error: `Cannot move more than ${MAX_MONTH_MOVE} tasks at once`,
      });
    }
    if (!isMonthKey(monthKey)) {
      return res.status(400).json({ error: 'A valid month (YYYY-MM) is required' });
    }

    const tasks = await Task.find({ _id: { $in: taskIds } }).select('_id board parent monthKey');
    if (tasks.length !== new Set(taskIds.map(String)).size) {
      return res.status(400).json({ error: 'One or more task ids were not found' });
    }

    const boardIds = new Set(tasks.map((t) => t.board && String(t.board)));
    if (boardIds.size !== 1 || boardIds.has('undefined')) {
      return res.status(400).json({ error: 'All tasks must belong to the same board' });
    }
    for (const t of tasks) {
      if (t.parent) {
        return res.status(400).json({
          error: 'Subitems move with their parent and cannot be refiled on their own',
        });
      }
    }

    const boardId = [...boardIds][0];
    const ctx = await loadTaskBoardContext(boardId, userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

    if (ctx.board.boardType !== 'monthly') {
      return res.status(400).json({ error: 'This board is not organised by month' });
    }

    const denied = requireCapability(
      ctx,
      'task.move',
      'You do not have permission to move tasks'
    );
    if (denied) return res.status(denied.status).json({ error: denied.error });

    const ids = tasks.map((t) => t._id);
    await Task.updateMany({ _id: { $in: ids } }, { $set: { monthKey } });
    // Subitems follow, so a parent and its children are never in different months.
    await Task.updateMany({ parent: { $in: ids } }, { $set: { monthKey } });

    await Board.updateOne({ _id: boardId }, { $set: { updatedAt: new Date() } });

    // `logActivity` derives the board from the task doc, so pass the doc. Note
    // `'monthKey'` had to be added to ActivityLog's FIELD_KEYS for these rows to
    // persist at all — that list is a validator and logActivity swallows its own
    // errors, so an unlisted field writes nothing and reports nothing.
    await Promise.all(
      tasks
        .filter((t) => t.monthKey !== monthKey)
        .map((t) =>
          logActivity({
            task: t,
            actor: userId,
            type: 'task.field_changed',
            field: 'monthKey',
            oldValue: t.monthKey || null,
            newValue: monthKey,
          })
        )
    );

    return res.json({ moved: ids.length, monthKey });
  } catch (err) {
    console.error('moveTasksToMonth error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

const reorderTasks = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { orderedIds, targetGroupId } = req.body || {};

    if (!Array.isArray(orderedIds)) {
      return res.status(400).json({ error: 'orderedIds must be an array' });
    }
    if (!targetGroupId || !mongoose.Types.ObjectId.isValid(targetGroupId)) {
      return res.status(400).json({ error: 'Valid targetGroupId is required' });
    }

    const targetGroup = await TaskGroup.findById(targetGroupId);
    if (!targetGroup) {
      return res.status(404).json({ error: 'Target group not found' });
    }

    const ctx = await loadTaskBoardContext(targetGroup.board, userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    // This endpoint had NO permission check: anyone who could open the board could
    // re-order it and drag tasks between groups. It rewrites `order` and `group`
    // on other people's rows, which is exactly `task.move`.
    const denied = requireCapability(
      ctx,
      'task.move',
      'You do not have permission to move tasks between groups'
    );
    if (denied) return res.status(denied.status).json({ error: denied.error });

    // Load every supplied task and validate same board, top-level, etc.
    const tasks = await Task.find({ _id: { $in: orderedIds } }).select('_id board parent');
    if (tasks.length !== orderedIds.length) {
      return res.status(400).json({ error: 'One or more task ids were not found' });
    }
    const boardIdStr = targetGroup.board.toString();
    for (const t of tasks) {
      if (!t.board || t.board.toString() !== boardIdStr) {
        return res.status(400).json({ error: 'All tasks must belong to the target board' });
      }
      if (t.parent) {
        return res.status(400).json({ error: 'Subitems cannot be reordered via this endpoint' });
      }
    }

    const ops = orderedIds.map((id, idx) => ({
      updateOne: {
        filter: { _id: id },
        update: { $set: { order: idx, group: targetGroupId } },
      },
    }));
    if (ops.length > 0) await Task.bulkWrite(ops);

    await Board.updateOne({ _id: targetGroup.board }, { $set: { updatedAt: new Date() } });

    const updated = await populateTask(
      Task.find({ group: targetGroupId, parent: null, isPersonal: { $ne: true } })
    )
      .sort({ order: 1, createdAt: 1 })
      .lean();
    await annotateHasSubitems(updated);
    await annotateUpdateCounts(updated);

    return res.json({ tasks: updated, groupId: targetGroupId });
  } catch (err) {
    console.error('reorderTasks error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * PUT /api/tasks/:id/pin
 * Body: { value: boolean }
 *
 * Team pin — floats the task to the top of its group for everyone on the board.
 *
 * Two deliberate choices here:
 *  - `value` is explicit rather than a blind toggle, so a double-click can't
 *    race itself into the wrong state (same reasoning as notification bookmarks).
 *  - `order` is never touched. Pinning is a display transform the client applies
 *    on render, which is what lets an unpin drop the row straight back into its
 *    real slot with no bookkeeping.
 */
const setTaskPinned = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    const { value } = req.body || {};

    if (typeof value !== 'boolean') {
      return res.status(400).json({ error: 'value must be a boolean' });
    }

    const task = await Task.findById(id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (task.isPersonal) {
      return res.status(400).json({ error: 'Personal tasks cannot be pinned' });
    }
    if (task.parent) {
      return res.status(400).json({ error: 'Subitems cannot be pinned' });
    }

    const ctx = await loadTaskBoardContext(task.board, userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    // A team pin changes where the row sits for everyone — the same authority
    // `reorderTasks` gates on, so it answers to the same capability.
    const denied = requireCapability(
      ctx,
      'task.move',
      'You do not have permission to pin tasks'
    );
    if (denied) return res.status(denied.status).json({ error: denied.error });

    const prevPinned = task.pinned === true;
    if (prevPinned !== value) {
      task.pinned = value;
      await task.save();
      logActivity({
        task,
        actor: userId,
        type: 'task.field_changed',
        field: 'pinned',
        oldValue: prevPinned,
        newValue: value,
        metadata: { taskName: task.name },
      });
      eventBus.emit('task.updated', { taskId: task._id, boardId: task.board });
      await Board.updateOne(
        { _id: task.board },
        { $set: { updatedAt: new Date() } }
      );
    }

    const populated = await populateTask(Task.findById(task._id));
    return res.json({ task: populated });
  } catch (err) {
    console.error('setTaskPinned error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * PUT /api/tasks/:id/portal-share   Body: { value: boolean }
 *
 * Publish an internal task to (or pull it back from) the client's portal. This
 * is the ONLY way a team-created row becomes readable by an outside party, so
 * it is a route of its own rather than a field on updateTask: the audience of a
 * task is not the same kind of edit as its due date, and it deserves its own
 * capability check, its own refusals, and its own line in the activity log.
 *
 * `value` is explicit rather than a toggle so a double-click can't race itself
 * into showing a client something the user just hid.
 */
const setTaskPortalShared = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    const { value } = req.body || {};

    if (typeof value !== 'boolean') {
      return res.status(400).json({ error: 'value must be a boolean' });
    }

    const task = await Task.findById(id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (task.isPersonal) {
      return res
        .status(400)
        .json({ error: 'Personal tasks cannot be shared with a client' });
    }

    const ctx = await loadTaskBoardContext(task.board, userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    const denied = denyPortalShare(ctx, task);
    if (denied) return res.status(denied.status).json({ error: denied.error });

    const prevShared = task.portalShared === true;
    if (prevShared !== value) {
      task.portalShared = value;
      // Re-stamped on every share, not just the first: unsharing and resharing
      // makes the card appear on the client's list again, and dating it to the
      // first time would file it under work they had already looked past.
      task.portalSharedAt = value ? new Date() : null;
      // Claimed once and then kept. The client may already have quoted the
      // reference in an email, so a task that comes back must come back as the
      // same ticket.
      if (value && !task.portalRef) {
        task.portalRef = await claimPortalRef(task.board);
      }
      await task.save();

      logActivity({
        task,
        actor: userId,
        type: 'task.field_changed',
        field: 'portalShared',
        oldValue: prevShared,
        newValue: value,
        metadata: { taskName: task.name },
      });
      eventBus.emit('task.updated', { taskId: task._id, boardId: task.board });
      await Board.updateOne(
        { _id: task.board },
        { $set: { updatedAt: new Date() } }
      );

      // Only on the false → true edge, which this branch already is: unsharing
      // is silent, and a re-share is a deliberate second ask, so it mails again
      // for the same reason portalSharedAt is re-stamped.
      if (value) emailClientsOnPortalShare(task, ctx.board);
    }

    const populated = await populateTask(Task.findById(task._id));
    return res.json({ task: populated });
  } catch (err) {
    console.error('setTaskPortalShared error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * DELETE /api/tasks/:id
 */
const deleteTask = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;

    const task = await Task.findById(id);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    if (task.isPersonal) {
      if (!task.createdBy || task.createdBy.toString() !== userId) {
        return res.status(403).json({ error: 'Not authorised' });
      }
    } else {
      const ctx = await loadTaskBoardContext(task.board, userId);
      if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
      const denied = requireCapability(
        ctx,
        'task.delete',
        'You do not have permission to delete tasks'
      );
      if (denied) return res.status(denied.status).json({ error: denied.error });
    }

    // Cascade subitems first — fetch their ids so their updates and
    // notifications are also cleaned up.
    const subitems = await Task.find({ parent: id }).select('_id attachments').lean();
    const subitemIds = subitems.map((s) => s._id);
    const idsToDelete = [id, ...subitemIds];

    // Destroy all Cloudinary assets for the task, its subitems, and their updates.
    const updateDocs = await Update.find({ task: { $in: idsToDelete } }).select('attachments').lean();
    const allAttachments = [
      ...(task.attachments || []),
      ...subitems.flatMap((s) => s.attachments || []),
      ...updateDocs.flatMap((u) => u.attachments || []),
    ];
    await destroyCloudinaryAssets(allAttachments);

    // Log the deletion before the row disappears so the log can resolve task name.
    logActivity({
      task,
      actor: userId,
      type: 'task.deleted',
      metadata: { taskName: task.name, deletedSubitems: subitemIds.length },
    });

    await Update.deleteMany({ task: { $in: idsToDelete } });
    await Notification.deleteMany({ task: { $in: idsToDelete } });
    await ItemFollow.deleteMany({ task: { $in: idsToDelete } });
    await ActivityLog.deleteMany({ task: { $in: idsToDelete } });
    if (subitemIds.length > 0) {
      await Task.deleteMany({ _id: { $in: subitemIds } });
    }
    await Task.deleteOne({ _id: id });

    // F2: a deleted board task may be a connect-link target. Signal each
    // removed id so mirrorRefresh pulls the dead link and recomputes mirrors.
    if (!task.isPersonal && task.board) {
      for (const deletedId of idsToDelete) {
        eventBus.emit('task.deleted', { taskId: deletedId, boardId: task.board });
      }
    }

    return res.json({ success: true, deletedSubitems: subitemIds.length });
  } catch (err) {
    console.error('deleteTask error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * GET /api/tasks/:id/attachments — list files attached to a task.
 * A read: personal tasks → creator only; board tasks → anyone who can open the
 * board. No capability beyond that, so a viewer still sees the Files tab.
 */
const getTaskAttachments = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;

    const result = await loadTaskContext(id, userId);
    if (result.error) {
      return res.status(result.status).json({ error: result.error });
    }

    const task = await Task.findById(id).populate(
      'attachments.uploadedBy',
      'name profilePic email'
    );

    return res.json({ attachments: task.attachments || [] });
  } catch (err) {
    console.error('getTaskAttachments error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * GET /api/tasks/:id/client-request — the request as the client raised it.
 *
 * A Client Portal request arrives as a Task, not as an Update: its title, its
 * description and — the part that kept going missing — the screenshots the client
 * attached while raising it all live on the task document. The team's Client tab
 * renders Updates, so none of that appeared in the thread the team actually reads,
 * and the files were reachable only by clicking into the Files tab. This endpoint
 * hands the whole request over so the thread can open with it.
 *
 * Serves a team-SHARED task too, where the same block is the team's own ask
 * rather than the client's complaint. The team is answering in a thread the
 * client is reading; without this they were replying under a blank space with
 * no sight of the opening message the client sees above their own replies.
 *
 * Read-gated exactly like the thread itself (board read), and 404s for any task
 * the client cannot see — there is no shared opening block to show.
 */
const getClientRequest = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;

    const result = await loadTaskContext(id, userId);
    if (result.error) {
      return res.status(result.status).json({ error: result.error });
    }
    const { task } = result;
    if (!isClientVisibleTask(task)) {
      return res.status(404).json({ error: 'Not a client request' });
    }

    // Only a client-raised task has an external author to name.
    const fromTeam = !task.portalSubmitter;
    const contact = fromTeam
      ? null
      : await ClientContact.findById(task.portalSubmitter).select('name email');
    const attachments = await loadRequestAttachments(task);

    return res.json({
      request: {
        // Says which of the two blocks this is, so the card can stop calling the
        // team's own ask "the client's original request".
        fromTeam,
        sharedAt: task.portalSharedAt || null,
        // Sequential ticket number where one was claimed; the id-suffix fallback
        // matches what the client sees on their side for pre-ref requests.
        ref: portalRefLabel(task),
        name: task.name,
        note: task.note || '',
        type: task.portalType || '',
        category: task.portalCategory || '',
        priority: task.priority || 'medium',
        dueDate: task.dueDate || null,
        createdAt: task.createdAt,
        submitter: {
          name: contact?.name || '',
          email: contact?.email || '',
        },
        attachments: attachments.map((a) => ({
          _id: String(a._id),
          url: a.url,
          name: a.name,
          mime: a.mime,
          size: a.size,
        })),
      },
    });
  } catch (err) {
    console.error('getClientRequest error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Delete an already-uploaded file that this request is not going to keep.
 *
 * `taskAttachmentUpload.single('file')` runs as route middleware, so multer and
 * CloudinaryStorage have PUSHED THE ASSET TO CLOUDINARY before this controller —
 * and therefore before the permission gate — gets to run at all. Every early
 * return on the upload route then leaves a file nothing references: a 403 that
 * still costs storage, and still leaves the uploader's content sitting in the
 * account. The gate cannot move earlier without restructuring the route, so the
 * denial cleans up after it.
 *
 * Maps the multer file onto the attachment shape `destroyCloudinaryAssets` reads
 * (`publicId` + `mime`) — the same fields the success path pulls off `req.file`.
 */
const discardUploadedFile = async (file) => {
  if (!file) return;
  const publicId = file.public_id || file.filename || '';
  if (!publicId) return;
  await destroyCloudinaryAssets([{ publicId, mime: file.mimetype || '' }]);
};

/**
 * POST /api/tasks/:id/attachments — upload a file (multer + Cloudinary middleware
 * does the upload) and persist its URL on the task.
 */
const uploadTaskAttachment = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;

    const result = await loadTaskContext(id, userId);
    if (result.error) {
      await discardUploadedFile(req.file);
      return res.status(result.status).json({ error: result.error });
    }
    const denied = requireTaskEdit(result.ctx, result.task, userId);
    if (denied) {
      await discardUploadedFile(req.file);
      return res.status(denied.status).json({ error: denied.error });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const attachment = {
      url: req.file.path || req.file.secure_url || req.file.url,
      name: req.file.originalname || '',
      mime: req.file.mimetype || '',
      size: req.file.size || 0,
      publicId: req.file.public_id || req.file.filename || '',
      uploadedBy: userId,
      // The Files tab is the team's own upload path — never part of the client's
      // request, even on a Client Portal board.
      source: 'team',
    };

    const updated = await Task.findByIdAndUpdate(
      id,
      { $push: { attachments: attachment } },
      { new: true }
    ).populate('attachments.uploadedBy', 'name profilePic email');

    const created = updated.attachments[updated.attachments.length - 1];

    logActivity({
      task: updated,
      actor: userId,
      type: 'attachment.uploaded',
      metadata: {
        attachmentName: attachment.name || 'file',
        attachmentUrl: attachment.url,
        taskName: updated.name,
      },
    });

    return res.status(201).json({ attachment: created });
  } catch (err) {
    console.error('uploadTaskAttachment error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * DELETE /api/tasks/:id/attachments/:attachmentId — remove an attachment from
 * the task. The Cloudinary asset itself is left in place (cheaper and simpler
 * than tracking public_ids; a periodic job can prune orphaned assets).
 */
const deleteTaskAttachment = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id, attachmentId } = req.params;

    const result = await loadTaskContext(id, userId);
    if (result.error) {
      return res.status(result.status).json({ error: result.error });
    }
    const task = result.task;
    const denied = requireTaskEdit(result.ctx, task, userId);
    if (denied) return res.status(denied.status).json({ error: denied.error });

    const attachment = task.attachments.id(attachmentId);
    if (!attachment) {
      return res.status(404).json({ error: 'Attachment not found' });
    }

    const attachmentName = attachment.name || 'file';

    await Task.findByIdAndUpdate(id, {
      $pull: { attachments: { _id: attachmentId } },
    });

    await destroyCloudinaryAssets([attachment]);

    logActivity({
      task,
      actor: userId,
      type: 'attachment.deleted',
      metadata: { attachmentName, taskName: task.name },
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error('deleteTaskAttachment error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

module.exports = {
  getTasks,
  getMyTasks,
  getCalendarTasks,
  getSubitems,
  createTask,
  updateTask,
  deleteTask,
  reorderTasks,
  moveTasksToMonth,
  setTaskPinned,
  setTaskPortalShared,
  addChecklistItem,
  updateChecklistItem,
  deleteChecklistItem,
  reorderChecklist,
  getTaskAttachments,
  uploadTaskAttachment,
  deleteTaskAttachment,
  getClientRequest,
};
