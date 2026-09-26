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
const { roleColumn } = require('../utils/columnRoles');
const {
  fileColumnAssets,
  destroyFileColumnAssets,
  droppedFileAssets,
  destroyAssets,
  withoutIdsHeldElsewhere,
} = require('../utils/fileColumnAssets');
const { normaliseCurrencyCode, boardCurrencyOf, isMoneyColumn } = require('../utils/money');
const { settledStatusFor, touchesSettleColumns } = require('../utils/paymentsSettle');
const { buildTaskDeepLink } = require('../utils/taskDeepLink');
const { embedMirrorValues } = require('../services/mirrorRefresh');
const { loadBoardContext, requireCapability } = require('../utils/boardContext');
const { resolveAccess } = require('../utils/permissions');
const { isMonthKey, monthKeyOf } = require('../utils/monthKey');
const ClientContact = require('../models/ClientContact');
const { isResolvedStatus } = require('../utils/doneStatus');
const Goal = require('../models/Goal');
const {
  MAX_GOAL_LINKS,
  linkedGoalIds,
  isDismissed,
  isAttachable,
} = require('../utils/goalEvidence');
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
 * Client Portal: email the board's client contacts when the team PUBLISHES a
 * task to their portal. A shared item is the team asking something of the
 * client, so it can't wait to be discovered on a page nobody was told to open.
 *
 * Every contact on the board is mailed, not one submitter, because a shared task
 * belongs to the whole client company — the same audience that can already read
 * it in the portal, so this discloses nothing new.
 *
 * Only for team-shared items: a client-raised ticket (`portalSubmitter`) is
 * already theirs, and a subitem never reaches the portal at all. Silent when the
 * board's portal is off — mailing a link that refuses them is worse than nothing.
 *
 * Fire-and-forget: swallows its own errors so sharing never fails on the mail.
 */
const emailClientsOnPortalShare = async (task, board) => {
  try {
    if (!task || !board || board.boardType !== 'client') return;
    if (!task.portalShared || task.parent || task.portalSubmitter) return;

    // Re-read the board WITH the token: `board` arrives from loadBoardContext,
    // which does not select it (`Board.portalToken` is `select: false` — it is a
    // credential). One extra read on a fire-and-forget path, and explicit beats
    // a silently empty link.
    const portalBoard = await Board.findById(board._id).select(
      '+portalToken name portalClientName portalEnabled'
    );
    if (!portalBoard?.portalEnabled || !portalBoard.portalToken) return;

    const contacts = await ClientContact.find({ board: portalBoard._id })
      .select('email')
      .lean();
    const recipients = contacts.map((c) => c.email).filter(Boolean);
    if (recipients.length === 0) return;

    const org = await Organisation.findById(board.organisation).select('name');
    // The client's own portal URL rather than the bare /portal dashboard: an
    // invited contact who has never signed in on this device needs the landing
    // page, and one who has is a click from the same list either way.
    const link = portalLink(portalBoard);

    const results = await Promise.allSettled(
      recipients.map((to) =>
        sendPortalSharedTaskEmail({
          to,
          orgName: org?.name || '',
          clientName: clientLabel(portalBoard),
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
    // is board-wide, so flipping it here would hand one contact's ticket to
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
 * Is this update nothing but the caller CLAIMING the task — writing their own
 * name, and only their own name, into an otherwise untouched assignee list?
 *
 * `task.edit_assigned` says you may work on what is yours, and on its own that
 * is unreachable: a row you did not create and are not on is one you can never
 * make yours, so an unassigned task could only ever be handed to you by an
 * editor. That is the same gap `requireAssignCapability` closes one layer up,
 * and it has to be closed here too or the carve-out only ever helps people who
 * already had the task.
 *
 * Deliberately narrow on three axes:
 *   - assignedTo is the ONLY field in the patch. Claiming a task is not a
 *     licence to rewrite it; the next edit answers to `canEditTask` as usual,
 *     which by then passes because they are on it.
 *   - STRICTLY ADDITIVE. Every existing name survives, so this can never take
 *     work off somebody else — the one thing an "assign" gate exists to stop.
 *   - the single added name is the caller's own.
 *
 * A true claim falls THROUGH to the ordinary edit path rather than writing
 * anything itself, so validation, the activity log and the assignment
 * notification all behave exactly as they always have.
 */
const isSelfClaim = (ctx, task, body, userId) => {
  if (!ctx.can('task.edit_assigned')) return false;

  const touched = Object.keys(body).filter((k) => body[k] !== undefined);
  if (touched.length !== 1 || touched[0] !== 'assignedTo') return false;
  if (!Array.isArray(body.assignedTo)) return false;

  const prev = (task.assignedTo || []).map((u) => u.toString());
  const next = body.assignedTo
    .map((u) => (u == null ? '' : u.toString()))
    .filter(Boolean);
  const nextSet = new Set(next);
  const prevSet = new Set(prev);

  if (prev.some((id) => !nextSet.has(id))) return false;
  const added = [...new Set(next.filter((id) => !prevSet.has(id)))];
  return added.length === 1 && added[0] === String(userId);
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
      return { error: 'Assignee is not a member of this workspace' };
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
 * The user ids in a `person` cell, as strings. Accepts the stored array, a raw
 * patch value, or null/undefined for an empty cell — see the `person` entry in
 * utils/columnTypes.js, whose serializer produces exactly this shape.
 */
const personIdsOf = (value) => {
  if (!Array.isArray(value)) return [];
  return value.map((v) => (v == null ? '' : v.toString())).filter(Boolean);
};

/**
 * THE self-assignment carve-out. Every `task.assign` gate in this file goes
 * through here so the three of them cannot drift apart.
 *
 * `task.assign` stays on the `edit` rung, and deliberately so: putting work on
 * SOMEONE ELSE is a board-shaping act. Picking work up yourself is not — it is
 * the same "do your own work" that `contribute` already covers with
 * `task.create` and `task.edit_assigned`. Before this, a contributor could add a
 * row and edit it but could not put their own name on it, so on every board
 * whose public default is `contribute` an admin had to hand rows out one at a
 * time. That is not a permission boundary anyone chose; it fell out of assigning
 * yourself and assigning others being one capability.
 *
 * The rule is about the CHANGE, never the resulting list. A contributor may add
 * or remove themselves while a dozen other names sit in the cell untouched; the
 * moment the delta names anybody else the full capability is required. Removal
 * counts as much as addition — taking someone else's work away is the same
 * power as giving it — which is what keeps this a carve-out rather than a hole:
 * it can only ever move the caller's own name.
 *
 * An empty delta is not a power at all. A client that echoes the current
 * assignees back while editing an unrelated field must not trip a gate it never
 * meant to touch.
 *
 * Returns `{ status, error }` to refuse, or null to allow.
 */
const requireAssignCapability = (ctx, userId, changedIds) => {
  const changed = new Set(
    (changedIds || []).map((id) => (id == null ? '' : id.toString())).filter(Boolean)
  );
  if (changed.size === 0) return null;
  if (changed.size === 1 && changed.has(String(userId))) return null;
  return requireCapability(
    ctx,
    'task.assign',
    'You do not have permission to assign people to tasks'
  );
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
    .populate('createdBy', 'name profilePic email')
    // The ledger renders "told Aneesh, 3 days ago" on first paint, so the
    // people have to arrive with the row. Same three fields as the others —
    // enough for an avatar and a name, and nothing that is not already on
    // screen elsewhere.
    .populate('notifiedUsers', 'name profilePic email');

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
 * A plain record — `{ url, name }`, `{ id, amount, date }` — as opposed to an
 * ObjectId, a Date or a primitive. The prototype test is what tells them apart:
 * an ObjectId and a Date are objects too, but they are VALUES with a
 * meaningful `toString()`, where a record's is always "[object Object]".
 */
const isPlainRecord = (v) =>
  v != null && typeof v === 'object' && !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/**
 * Compare two column values for equality. Handles arrays (ObjectId lists for
 * person/tags, record lists for file/payments), plain objects
 * (link/location/timeline/client), Dates, and primitives. Used to suppress
 * no-op writes — a cell that compares equal is not set, not logged and not
 * announced.
 *
 * TWO KINDS OF ARRAY, compared two different ways:
 *
 *   - ids and scalars (person, tags): a SET. Order means nothing — [A, B] and
 *     [B, A] are the same two people — so both sides are stringified and
 *     sorted.
 *   - records (file, payments): a LIST, compared element by element IN ORDER.
 *     The sorted-toString comparison above turned every record into
 *     "[object Object]", so any two lists of the same LENGTH compared equal:
 *     swapping one PDF for another, or correcting a payment from 100 to 250,
 *     was dropped with a 200 — nothing stored, nothing logged, and the
 *     replaced file never cleaned up. Both serializers emit a stable order and
 *     key order (payments by date then entry order, files as sent), so a
 *     positional JSON compare is exact. It errs towards WRITING: a legacy row
 *     with different key order compares unequal and is simply re-saved, which
 *     is harmless, where a false "equal" loses somebody's edit.
 */
const columnValuesEqual = (a, b) => {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    if (a.some(isPlainRecord) || b.some(isPlainRecord)) {
      try {
        return a.every((v, i) => JSON.stringify(v) === JSON.stringify(b[i]));
      } catch (_err) {
        return false;
      }
    }
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
 * The column that IS the row title: the board's primary column, when it is
 * plain text. Null on a board without flexible columns, and on one whose
 * primary is some other type — there is nothing to mirror a name into then.
 */
const primaryTextColumn = (board) => {
  if (!board || !board.useFlexibleColumns || !Array.isArray(board.columns)) return null;
  return board.columns.find((c) => c && c.isPrimary && c.type === 'text') || null;
};

/** Same wording on every path that refuses a blank title. */
const EMPTY_TITLE_MESSAGE = "The title can't be empty";

/**
 * Validate and apply a `columnValues` patch onto a task. Returns either
 * `{ ok: true, changes: [{ column, fromValue, toValue }], droppedFiles }` or
 * `{ ok: false, errors: [{ columnId, message }] }` so the caller can ship a
 * 400 with field-level errors.
 *
 * Merges into the existing Map — keys not present in the patch are left alone.
 *
 * THE PRIMARY TEXT COLUMN IS THE TASK'S NAME. The two used to be separate
 * values: the ledger tile, the panel header, notifications and search read
 * `task.name`, the Table read the cell, and neither write reached the other —
 * so every dropped invoice showed a blank Invoice cell, and typing a number
 * into that cell renamed nothing. Writing the primary cell now renames the task
 * (callers log that as ONE `name` change, not a name change and a column
 * change), and an empty primary is refused rather than allowed to blank the
 * row's title.
 *
 * `droppedFiles` lists the files a file-column write let go of. Nothing is
 * destroyed here — the patch has not been saved, and a Cloudinary delete
 * cannot be rolled back — so the caller destroys them once the save lands.
 *
 * `opts.clientNames` is what `resolveClientCells` found: `Map<boardId, name>`
 * for every client board this patch names. A `client` cell pointing at one of
 * them has its `name` REPLACED by that board's own display name, so the
 * snapshot the cell keeps is the board's, never whatever the request said the
 * client was called. Synchronous on purpose — the lookups happened in the
 * async gate before this, which is also where a bad board id was refused.
 */
const applyColumnValuePatch = (task, board, patch, opts = {}) => {
  const clientNames = opts && opts.clientNames instanceof Map ? opts.clientNames : null;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, errors: [{ columnId: null, message: 'columnValues must be an object' }] };
  }
  if (!board || !Array.isArray(board.columns) || board.columns.length === 0) {
    return { ok: false, errors: [{ columnId: null, message: 'Board has no columns configured' }] };
  }

  const columnsById = new Map(board.columns.map((c) => [c._id.toString(), c]));
  const errors = [];
  const changes = [];
  const droppedFiles = [];

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
    let serialized = entry.serialize ? entry.serialize(rawValue) : rawValue;

    if (
      col.type === 'client' &&
      clientNames &&
      serialized &&
      typeof serialized === 'object' &&
      serialized.boardId != null &&
      clientNames.has(String(serialized.boardId))
    ) {
      serialized = { ...serialized, name: clientNames.get(String(serialized.boardId)) };
    }

    if (col.isPrimary && col.type === 'text') {
      const title = typeof serialized === 'string' ? serialized.trim() : '';
      if (!title) {
        errors.push({ columnId: cid, message: EMPTY_TITLE_MESSAGE, code: 'EMPTY_TITLE' });
        continue;
      }
      task.name = title;
    }

    const prevValue = task.columnValues ? task.columnValues.get(cid) : undefined;
    if (columnValuesEqual(prevValue, serialized)) continue;
    task.columnValues.set(cid, serialized);
    // Only files uploaded into THIS board's folder can ever be let go of — see
    // utils/fileColumnAssets.js; without the board id nothing is returned.
    if (col.type === 'file') {
      droppedFiles.push(...droppedFileAssets(prevValue, serialized, task.board || board._id));
    }
    changes.push({ column: col, fromValue: prevValue == null ? null : prevValue, toValue: serialized });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, changes, droppedFiles };
};

/**
 * The board status this write SETTLES the row into, or null.
 *
 * A row whose payments now cover its amount is done — see
 * utils/paymentsSettle.js for the rule and why it is generic. Only a write
 * that moved the amount or the payments (`changes`, from
 * `applyColumnValuePatch`) may settle: somebody who deliberately moved a
 * covered row back out of done keeps that status through every later edit of
 * its title, due date or owner.
 *
 * Returns the board's status subdoc, so the caller can record the change
 * exactly the way a person's status change is recorded — the activity row, the
 * audience notification, the client-portal "resolved" email.
 */
const settledStatusOf = (task, board, changes) => {
  if (!touchesSettleColumns(board, changes)) return null;
  const doneId = settledStatusFor(board, task);
  if (!doneId) return null;
  // A migrated board's status CELL would put the old status straight back
  // (see `legacyStatusCellOf`). Settle only where the cell can say done too;
  // otherwise the row would stay open while the activity row, notification
  // and client email all claimed it closed — again on every later edit.
  const legacy = legacyStatusCellOf(task, board);
  if (legacy && !legacy.options.some((o) => o && String(o.id) === String(doneId))) return null;
  return findBoardStatus(board, doneId);
};

/**
 * A board migrated from the legacy table (scripts/migrateLegacyColumns.js)
 * has a column KEYED 'status' whose options are the board's statuses, and the
 * save hook copies that cell onto `task.status` on every save (models/Task.js
 * `LEGACY_COLUMN_KEY_TO_TASK_FIELD`). Returns `{ id, options }` for it when the
 * row holds a value there — the only case the hook copies — else null.
 */
const legacyStatusCellOf = (task, board) => {
  const col = ((board && board.columns) || []).find((c) => c && c.key === 'status' && c._id != null);
  if (!col) return null;
  const id = String(col._id);
  const cv = task && task.columnValues;
  const value = cv && typeof cv.get === 'function' ? cv.get(id) : cv ? cv[id] : undefined;
  if (value === undefined) return null;
  const options = col.settings && Array.isArray(col.settings.options) ? col.settings.options : [];
  return { id, options };
};

/** Move the row to `status` — and its legacy status cell with it, so the hook agrees. */
const applySettledStatus = (task, board, status) => {
  task.status = status._id;
  const legacy = legacyStatusCellOf(task, board);
  if (legacy) task.columnValues.set(legacy.id, String(status._id));
};

/**
 * Tell the people a write put on a row that they are on it: the in-app
 * "assigned" notification and the assignment email, gated by each person's
 * email preferences.
 *
 * One helper for every way somebody gets assigned — `assignedTo` from the
 * panel, and the Owner cell written from the Table, the ledger or the invoice
 * sheet, which the save hook copies onto `assignedTo`. Before, only the first
 * announced anything, so assigning an invoice from its Owner cell handed the
 * row over in silence.
 *
 * The ACTOR is never told. The in-app notification always skipped them
 * (`excludeUserId`), but the email did not, so claiming a row sent you an
 * email saying you had been assigned to it.
 */
const announceAssignment = async ({ task, ids, actorId, actorName, orgId, boardId, taskLink }) => {
  const actor = String(actorId);
  const targets = [...new Set((ids || []).map((id) => (id == null ? '' : id.toString())))]
    .filter((id) => id && id !== actor);
  if (!targets.length) return;

  await createNotificationsForUsers({
    userIds: targets,
    type: 'assigned',
    message: `You were assigned to "${task.name}"`,
    taskId: task._id,
    orgId,
    excludeUserId: actorId,
    actorId,
    boardId,
  });

  const assigneeUsers = await User.find({ _id: { $in: targets } }).select('email').lean();
  const emailAllowed = await filterByEmailPreference(targets, 'assigned', { boardId, actorId });
  const recipients = assigneeUsers.filter((u) => u.email && emailAllowed.has(u._id.toString()));
  const emailResults = await Promise.allSettled(
    recipients.map((u) =>
      sendTaskAssignmentEmail({
        to: u.email,
        taskName: task.name,
        priority: task.priority,
        dueDate: task.dueDate,
        taskLink,
        assignedByName: actorName || '',
      })
    )
  );
  emailResults.forEach((result, i) => {
    if (result.status === 'rejected') {
      console.error(`[email] Failed to send to ${recipients[i]?.email}:`, result.reason?.message || result.reason);
    }
  });
};

/**
 * Mirror `task.name` into the primary text column. The other half of the
 * primary ↔ name contract above: a rename from the panel or the ledger now
 * reaches the Table too. No-op on a board with no primary text column.
 */
const syncPrimaryFromName = (task, board) => {
  const primary = primaryTextColumn(board);
  if (!primary || typeof task.name !== 'string' || !task.name) return null;
  const cid = primary._id.toString();
  const prevValue = task.columnValues.get(cid);
  if (prevValue === task.name) return null;
  task.columnValues.set(cid, task.name);
  return { column: primary, fromValue: prevValue == null ? null : prevValue, toValue: task.name };
};

/**
 * Write a legacy field's new value into the column that plays its ROLE
 * (utils/columnRoles.js), through that column type's own serializer — the same
 * path a `columnValues` PUT takes, so the cell is exactly what the grid would
 * have written.
 *
 * Why the controller writes it rather than leaving it to the pre-save hook
 * alone: the panel's Due date and Assigned to controls set the FIELD, and the
 * ledger, the Table and the Due/Owner columns read the CELL. Writing both here
 * means the request's own response already agrees with itself, and the hook
 * (which takes the column's side whenever the cell was written in the save)
 * copies it straight back onto the field instead of reverting it.
 *
 * Skipped when the same request's `columnValues` addresses that column: an
 * explicit cell write is the more specific instruction, and the hook will carry
 * it across to the field.
 *
 * Returns the change `{ column, fromValue, toValue }`, or null when there is no
 * role column or nothing moved.
 */
const writeRoleColumn = (task, board, role, value, patch) => {
  if (!board || !board.useFlexibleColumns) return null;
  const col = roleColumn(board, role);
  if (!col) return null;
  const cid = col._id.toString();
  if (patch && typeof patch === 'object' && Object.prototype.hasOwnProperty.call(patch, cid)) {
    return null;
  }
  const entry = getColumnType(col.type);
  const serialized = entry && entry.serialize ? entry.serialize(value) : value;
  const prevValue = task.columnValues.get(cid);
  if (columnValuesEqual(prevValue, serialized)) return null;
  task.columnValues.set(cid, serialized);
  return { column: col, fromValue: prevValue == null ? null : prevValue, toValue: serialized };
};

/**
 * What an activity row about a column needs to be read back later, stamped at
 * WRITE time because none of it is recoverable afterwards: the column can be
 * renamed or deleted, and a money column's currency can be changed (which
 * relabels, never converts — so an old "12,000" is only correct in the unit it
 * was typed in). Both renderers — services/activityFormat.js and the client's
 * ActivityEntry.jsx — branch on `columnType`.
 *
 *   columnLabel   the column's display name
 *   columnType    its type, which says how to read the values
 *   currency      for a money column: the unit the figures were entered in
 *   optionLabels  for status / dropdown / tags: { optionId: label } for every
 *                 choice either side names, so a choice deleted later still
 *                 reads as itself
 */
const columnActivityMeta = (column, board, org, fromValue, toValue) => {
  const meta = { columnLabel: column.name, columnType: column.type };
  const settings = column.settings && typeof column.settings === 'object' ? column.settings : {};
  if (isMoneyColumn(column)) {
    const code =
      normaliseCurrencyCode(settings.currency) ||
      boardCurrencyOf(board, org ? org.baseCurrency : null);
    if (code) meta.currency = code;
  }
  if (['status', 'dropdown', 'tags'].includes(column.type) && Array.isArray(settings.options)) {
    const ids = new Set(
      [fromValue, toValue]
        .flatMap((v) => (Array.isArray(v) ? v : [v]))
        .filter((v) => v != null && v !== '')
        .map((v) => v.toString())
    );
    const optionLabels = {};
    for (const o of settings.options) {
      if (!o || o.id == null) continue;
      const id = o.id.toString();
      if (ids.has(id)) optionLabels[id] = o.label || o.name || '';
    }
    if (Object.keys(optionLabels).length) meta.optionLabels = optionLabels;
  }
  return meta;
};

/** A column change as the activity loop logs it. */
const columnActivityChange = (change, board, org) => ({
  field: `column:${change.column.key}`,
  oldValue: change.fromValue,
  newValue: change.toValue,
  meta: columnActivityMeta(change.column, board, org, change.fromValue, change.toValue),
});

/**
 * Destroy the files a saved cell edit let go of — unless the task still holds
 * the same asset somewhere else (another file column, or its Files tab), in
 * which case destroying it would break a live link. Fire-and-forget and never
 * throws: the edit has already been saved and answered for.
 *
 * …and unless ANOTHER row on the board still holds it. The board prefix only
 * scopes a destroy to the board, and every reader sees every row's ids, so a
 * member who may edit only their own row could otherwise plant a colleague's
 * invoice id there, clear it, and have that PDF destroyed from under her row
 * (see `withoutIdsHeldElsewhere` in utils/fileColumnAssets.js).
 */
const destroyDroppedColumnFiles = (task, board, dropped) => {
  if (!Array.isArray(dropped) || dropped.length === 0) return;
  (async () => {
    const boardId = task.board || (board && board._id);
    const columns = board ? board.columns : [];
    const stillHeld = new Set([
      ...(task.attachments || []).map((a) => a && a.publicId).filter(Boolean),
      ...fileColumnAssets(columns, [task], { boardId }).map((a) => a.publicId),
    ]);
    const gone = dropped.filter((f) => f && f.publicId && !stillHeld.has(f.publicId));
    if (!gone.length) return;
    const free = await withoutIdsHeldElsewhere(gone, { boardId, columns, excludeTaskIds: [task._id] });
    if (free.length) await destroyAssets(free);
  })().catch((err) => {
    console.error('destroyDroppedColumnFiles error:', err && err.message);
  });
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
 * `task` is the row the patch is about to land on, and it is what makes the
 * person diff possible — see `personChanged` below. Returns `{ status, error }`
 * when denied, or null when allowed.
 */
const requireColumnPatchCapabilities = async (ctx, patch, userId, task = null) => {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return null;

  const columns = Array.isArray(ctx.board.columns) ? ctx.board.columns : [];
  const columnsById = new Map(columns.map((c) => [c._id.toString(), c]));

  // Who this patch MOVES in or out of a person cell — not who ends up in it.
  // The gate below is `requireAssignCapability`, which asks about the delta, so
  // it needs one: without the diff, a contributor adding themselves to a cell
  // that already names three other people would be refused for the three names
  // they never touched. Diffing here mirrors what the `assignedTo` path does
  // against `task.assignedTo`, which is the point — a person column IS
  // assignment, so the two must answer the same question the same way.
  const personChanged = new Set();
  const personAdded = new Set();
  let touchesConnect = false;
  const targetTaskIds = new Set();

  for (const [cidRaw, rawValue] of Object.entries(patch)) {
    const cid = cidRaw.toString();
    const col = columnsById.get(cid);
    // An unknown column id is `applyColumnValuePatch`'s 400 to raise, not ours —
    // it writes nothing, so there is no power here to gate.
    if (!col) continue;
    if (col.type === 'person') {
      const prevRaw = task && task.columnValues ? task.columnValues.get(cid) : null;
      const prev = new Set(personIdsOf(prevRaw));
      const next = new Set(personIdsOf(rawValue));
      for (const id of next) {
        if (prev.has(id)) continue;
        personChanged.add(id);
        personAdded.add(id);
      }
      for (const id of prev) if (!next.has(id)) personChanged.add(id);
    }
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

  // WHO may be put in a person cell — the same rule `body.assignedTo` answers
  // to in `validateAssignees`: a member of this workspace who can READ this
  // board. The capability gate below only asks whether the CALLER may move
  // names; without this, the Owner cell (which the save hook copies into
  // `assignedTo`) took any id at all — someone from another workspace, or a
  // member locked out of this private board — and handed them the row, its
  // notification and a deep link that 403s. Every person cell, not only the
  // Owner: each one IS assignment (see above).
  //
  // Only the ADDED names are judged. A name already in the cell was let in
  // when it was written; someone who has since left the workspace must not
  // make the cell unwritable, including by the edit that takes them out.
  // Malformed ids are left to the column type's validator, which answers with
  // the field-level `errors[]` shape the grid reads.
  const addedIds = [...personAdded].filter((id) => mongoose.Types.ObjectId.isValid(id));
  if (addedIds.length) {
    const { error: personErr } = await validateAssignees(addedIds, ctx.org, ctx.board);
    if (personErr) return { status: 400, error: personErr };
  }

  const personDenied = requireAssignCapability(ctx, userId, [...personChanged]);
  if (personDenied) return personDenied;

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

/** How long a client name may be — the `client` column type's own limit. */
const CLIENT_NAME_MAX = 120;

/**
 * What a client board is called: its portal label, else its board name —
 * whitespace-collapsed and clamped the way the `client` serializer stores a
 * typed name, so a board name and a typed one never differ by a double space.
 */
const clientBoardDisplayName = (b) =>
  String((b && (b.portalClientName || '').trim()) || (b && b.name) || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, CLIENT_NAME_MAX);

/**
 * Resolve every `client` cell in a patch that points at a board, BEFORE the
 * patch is applied. Returns `{ clientNames: Map<boardId, name> }` for
 * `applyColumnValuePatch` to stamp, or `{ status, error }` to refuse.
 *
 * A `client` cell is `{ boardId, name }`: a workspace CLIENT board (one board
 * is one client, and its display name is `portalClientName || name`), or,
 * with `boardId` null, a name typed in for a client that has no board. The
 * name is a SNAPSHOT so the row still reads for somebody who cannot open that
 * board — which is exactly why the server writes it, not the request. Left to
 * the client, a cell could point at one board while calling it something
 * else, and every ledger, filter and export would believe the label.
 *
 * A board id NEW to the cell must be:
 *   - a board that exists (boards are hard-deleted, so "not deleted" is
 *     "found");
 *   - `boardType: 'client'` — a standard or tracker board is not a client;
 *   - in THIS workspace — a board id from another tenant would otherwise
 *     leak that tenant's client names through the snapshot;
 *   - readable by the caller. Linking a private client board you cannot open
 *     would put its name on a board you can, the same read channel
 *     `connect_boards` is gated against above.
 *
 * A board id the cell ALREADY held is not re-judged, the same rule person
 * cells follow: a client board since deleted, converted or made private must
 * not make the row unwritable, least of all by the edit that moves it off
 * that client. It keeps its name refreshed while the board still qualifies,
 * and keeps the previous snapshot when it no longer does.
 *
 * Malformed values (not an object, an id that is not an ObjectId) are left to
 * the column type's validator in `applyColumnValuePatch`, which answers with
 * the field-level `errors[]` the grid reads.
 */
const resolveClientCells = async (ctx, patch, userId, task = null) => {
  const clientNames = new Map();
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { clientNames };

  const columns = Array.isArray(ctx.board.columns) ? ctx.board.columns : [];
  const columnsById = new Map(columns.map((c) => [c._id.toString(), c]));

  // boardId -> { isNew, prevName } across every client cell in the patch.
  const wanted = new Map();
  for (const [cidRaw, rawValue] of Object.entries(patch)) {
    const cid = cidRaw.toString();
    const col = columnsById.get(cid);
    if (!col || col.type !== 'client') continue;
    if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) continue;
    // Lower-cased the way the column type's serializer stores it, so the map
    // this returns is keyed exactly as `applyColumnValuePatch` looks it up.
    const bid = rawValue.boardId == null ? '' : String(rawValue.boardId).trim().toLowerCase();
    if (!/^[a-f0-9]{24}$/.test(bid)) continue;

    const prev = task && task.columnValues ? task.columnValues.get(cid) : null;
    const prevBid =
      prev && typeof prev === 'object' && prev.boardId != null ? String(prev.boardId).toLowerCase() : '';
    const held = prevBid === bid;
    const seen = wanted.get(bid);
    wanted.set(bid, {
      // New to ANY cell in the patch makes it new: two cells naming the same
      // board are judged once, strictly.
      isNew: (seen ? seen.isNew : false) || !held,
      prevName: held && typeof prev.name === 'string' ? prev.name : (seen ? seen.prevName : ''),
    });
  }
  if (wanted.size === 0) return { clientNames };

  const boards = await Board.find({ _id: { $in: [...wanted.keys()] } }).select(
    'name portalClientName boardType organisation visibility publicDefaultLevel memberAccess createdBy'
  );
  const byId = new Map(boards.map((b) => [b._id.toString(), b]));
  const orgId = ctx.board.organisation.toString();

  for (const [bid, { isNew, prevName }] of wanted) {
    const target = byId.get(bid);
    const qualifies =
      !!target &&
      target.boardType === 'client' &&
      !!target.organisation &&
      target.organisation.toString() === orgId;

    if (!qualifies) {
      if (isNew) {
        return { status: 400, error: "Client must be one of this workspace's client boards" };
      }
      if (prevName) clientNames.set(bid, prevName.slice(0, CLIENT_NAME_MAX));
      continue;
    }
    if (isNew && !resolveAccess(target, ctx.org, userId).canRead) {
      return { status: 403, error: 'You do not have access to that client board' };
    }
    const name = clientBoardDisplayName(target);
    if (name) clientNames.set(bid, name);
  }

  return { clientNames };
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
 * On a TRACKER board `month` is REQUIRED. That is deliberate rather than
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

    const isTracker = ctx.board?.boardType === 'tracker';
    if (isTracker && month !== 'all') {
      if (!isMonthKey(month)) {
        return res.status(400).json({
          error: 'A month (YYYY-MM) is required when reading a tracker board',
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

    // Which groups actually have a goal this month. The board grid needs it to
    // decide whether a done, unattached task is an ORPHAN or simply a task in a
    // group nobody set goals for — the rule that stops the orphan marker being
    // wallpaper (see utils/goalEvidence.js).
    //
    // Carried on this read rather than fetched separately because it is one
    // distinct() on a query that already ran, and the whole reason the links are
    // embedded on the Task is that the grid should need no extra round trip to
    // render its marker.
    let groupsWithGoals = null;
    if (isTracker && filter.monthKey) {
      const ids = await Goal.distinct('group', {
        board: boardId,
        monthKey: filter.monthKey,
      });
      groupsWithGoals = ids.map(String);
    }

    return res.json({
      tasks,
      monthKey: isTracker ? month : null,
      groupsWithGoals,
    });
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
      group: requestedGroupId,
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
      columnValues,
    } = req.body;

    // Mutable because a SUBITEM's group is not the caller's to choose — it is
    // overwritten with the parent's a little further down. See the comment at
    // that line for why a divergent group is a data-loss bug rather than a
    // cosmetic one.
    let groupId = requestedGroupId;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Task name is required' });
    }

    if (priority && !VALID_PRIORITIES.includes(priority)) {
      return res.status(400).json({ error: 'Invalid priority' });
    }

    // Personal task path
    if (isPersonal) {
      if (columnValues !== undefined) {
        // Same refusal as updateTask: a personal task has no board, so no columns.
        return res
          .status(400)
          .json({ error: 'Personal tasks do not support columnValues' });
      }
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
      // A SUBITEM TAKES ITS PARENT'S GROUP, whatever the body asked for.
      //
      // The board is validated above and nesting is refused, but nothing forced
      // the group — so `POST /api/tasks` with a parent on group A and
      // `group: B` created a subitem living in a different group from its
      // parent. That is the same divergence the move handler now prevents
      // (`subitemGroupFollow`), reached from the other end: deleting group B
      // would silently wipe a live subitem of a task that still exists in A,
      // and deleting group A would leave the subitem orphaned under a parent
      // whose own group is gone.
      //
      // Overwritten rather than refused with a 400. A subitem's group is not a
      // property anybody chooses — it is derived from the parent, every client
      // in this repo sends the parent's group already, and the group is
      // deliberately kept on the row (rather than looked up through the parent)
      // only so the group-scoped queries can find it. Rejecting the request
      // would turn a field nobody means to set into a failure mode.
      groupId = parentTask.group ? parentTask.group.toString() : groupId;
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

    // Adding work to the board and putting it on ANOTHER PERSON are two
    // different powers: `contribute` holds the first, only `edit` the second.
    // Naming yourself is the first — a task starts with no assignees, so the
    // delta here is the whole payload, and `requireAssignCapability` waves it
    // through when it names nobody but the caller. An unassigned task and a
    // self-assigned one both stay open to every contributor.
    const assignDenied = requireAssignCapability(ctx, userId, assigneeIds);
    if (assignDenied) {
      return res.status(assignDenied.status).json({ error: assignDenied.error });
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
    if (ctx.board.boardType === 'tracker') {
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

    // Built in memory and saved ONCE, so the row and its cells land in a single
    // insert. The ledger's invoice drop used to create the row by name and then
    // write the PDF cell with a second request; when that second call failed the
    // board kept an invoice row with no invoice on it — the one state the drop
    // flow exists to prevent.
    const task = new Task({
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
      portalRef: null,
    });

    // The title cell starts as the name (see applyColumnValuePatch on why the
    // two are one value), and the Due / Owner cells start as the fields they
    // stand for. Written BEFORE the caller's own cells, so an explicit cell in
    // `columnValues` wins over either.
    syncPrimaryFromName(task, ctx.board);
    if (dueDate) writeRoleColumn(task, ctx.board, 'dueDate', dueDate, columnValues);
    if (assigneeIds.length) writeRoleColumn(task, ctx.board, 'assignee', assigneeIds, columnValues);

    // The caller's cells: gated and validated exactly as `updateTask` gates and
    // validates them, and refused before anything is written. The row is new,
    // so the person gate diffs against empty cells — every name in the payload
    // is judged, which is the same rule `assignedTo` gets above.
    let createdColumnChanges = [];
    // Set when the row is created already paid in full: the payments it was
    // created with cover its amount. See `settledStatusOf`.
    let settledOnCreate = null;
    if (columnValues !== undefined) {
      const colDenied = await requireColumnPatchCapabilities(ctx, columnValues, userId, task);
      if (colDenied) {
        return res.status(colDenied.status).json({ error: colDenied.error });
      }
      const clientCells = await resolveClientCells(ctx, columnValues, userId, task);
      if (clientCells.error) {
        return res.status(clientCells.status).json({ error: clientCells.error });
      }
      const result = applyColumnValuePatch(task, ctx.board, columnValues, {
        clientNames: clientCells.clientNames,
      });
      if (!result.ok) {
        return res.status(400).json({ errors: result.errors, error: result.errors[0]?.message });
      }
      createdColumnChanges = result.changes;

      // A status the caller NAMED is their instruction and stands; only a row
      // left on the board's default is settled by what it was created with.
      const namedStatus = status !== undefined && status !== null && status !== '';
      if (!namedStatus) {
        const settled = settledStatusOf(task, ctx.board, createdColumnChanges);
        if (settled) {
          settledOnCreate = { from: task.status != null ? task.status.toString() : null, status: settled };
          applySettledStatus(task, ctx.board, settled);
          resolvedStatus = settled._id;
        }
      }
    }

    // Claimed last: a ticket number is a counter increment, and a request
    // refused above must not burn one.
    if (wantsPortalShare) task.portalRef = await claimPortalRef(boardId);

    await task.save();

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
    // The cells the row was created WITH ("attached INV-12.pdf"), so its
    // history says what it started as. The title is the task name, which the
    // creation row already carries.
    for (const change of createdColumnChanges) {
      if (change.column.isPrimary && change.column.type === 'text') continue;
      const c = columnActivityChange(change, ctx.board, ctx.org);
      logActivity({
        task,
        actor: userId,
        type: 'task.field_changed',
        field: c.field,
        oldValue: c.oldValue,
        newValue: c.newValue,
        metadata: { taskName: task.name, ...c.meta },
      });
    }
    // Created already covered by its payments: the move to done is recorded as
    // the status change it is — a history row saying why, and the same
    // audience notification and client "resolved" email a person's status
    // change sends — rather than the row silently appearing done.
    if (settledOnCreate) {
      logActivity({
        task,
        actor: userId,
        type: 'task.field_changed',
        field: 'status',
        oldValue: settledOnCreate.from,
        newValue: settledOnCreate.status._id.toString(),
        metadata: { taskName: task.name, settledBy: 'payments' },
      });
      await notifyTaskAudience(task, {
        type: 'statusChanged',
        message: `Status of "${task.name}" changed to ${settledOnCreate.status.name}`,
        orgId: ctx.board.organisation,
        excludeUserId: userId,
        actorId: userId,
        boardId,
      });
      emailClientOnResolve(task, ctx.board);
      logClientStatusChange(task, settledOnCreate.status.name);
    }

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

    // Everybody the new row is assigned to, read off the SAVED row rather than
    // `assignedTo` from the body: an Owner cell in `columnValues` is an
    // assignment too (the save hook copies it onto `assignedTo`), and when the
    // two disagree the cell is the one that landed. A row created from the
    // ledger with its Owner already filled in used to notify nobody.
    const createdAssigneeIds = (task.assignedTo || []).map((u) => u.toString());
    if (createdAssigneeIds.length > 0) {
      await announceAssignment({
        task,
        ids: createdAssigneeIds,
        actorId: userId,
        actorName: req.user?.name || '',
        orgId: ctx.board.organisation,
        boardId,
        taskLink: buildTaskDeepLink(task, { boardId }),
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
    // get exactly two things through: a status change, and claiming it. Dragging
    // a card along the board is its own capability precisely because it is not
    // the same power as rewriting what the card says; putting your own name on
    // an unassigned row is how `task.edit_assigned` becomes reachable at all
    // (see isSelfClaim). A claim falls through to the full-edit path below —
    // it names no other field, so nothing else can ride along.
    if (!canEditTask(ctx, task, userId) && !isSelfClaim(ctx, task, body, userId)) {
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
    // The column playing the assignee ROLE (the Owner cell) and who it named
    // before this write. Anyone the write puts on the row who was in neither
    // this cell nor `assignedTo` is newly assigned and gets told so — see
    // `announceAssignment` after the save.
    const assigneeRoleCol = ctx.board.useFlexibleColumns ? roleColumn(ctx.board, 'assignee') : null;
    const prevOwnerCellIds = assigneeRoleCol
      ? personIdsOf(task.columnValues.get(assigneeRoleCol._id.toString()))
      : [];
    let statusChanged = false;
    let newAssigneeIds = null;
    let removedAssigneeIds = null;
    let statusName = null;
    let columnChanges = [];
    let droppedFiles = [];
    const activityChanges = [];

    // ----- columnValues patch (flexible-columns engine, F1) ---------------
    if (body.columnValues !== undefined) {
      // `canEditTask` above says you may edit THIS task. It does not say you may
      // assign it to someone or wire it to another board — those are separate
      // capabilities, and a person / connect_boards cell is how you exercise them.
      // `task` goes in so the person gate can diff the cell rather than judge the
      // whole of it; the patch has not been applied yet, so it still reads the
      // BEFORE value.
      const colDenied = await requireColumnPatchCapabilities(
        ctx,
        body.columnValues,
        userId,
        task
      );
      if (colDenied) {
        return res.status(colDenied.status).json({ error: colDenied.error });
      }
      // A `client` cell names a client BOARD: it must be one of this
      // workspace's, and the name it keeps is that board's, not the request's.
      const clientCells = await resolveClientCells(ctx, body.columnValues, userId, task);
      if (clientCells.error) {
        return res.status(clientCells.status).json({ error: clientCells.error });
      }
      const result = applyColumnValuePatch(task, ctx.board, body.columnValues, {
        clientNames: clientCells.clientNames,
      });
      if (!result.ok) {
        // `error` alongside the field-level list so a client that toasts
        // `error` (most of them) says something readable.
        return res.status(400).json({ errors: result.errors, error: result.errors[0]?.message });
      }
      columnChanges = result.changes;
      droppedFiles = result.droppedFiles || [];
      for (const change of result.changes) {
        // The primary text cell is the task's name: the rename is logged once,
        // as `name`, below — not a second time as a column.
        if (change.column.isPrimary && change.column.type === 'text') continue;
        activityChanges.push(columnActivityChange(change, ctx.board, ctx.org));
      }
    }

    if (typeof body.name === 'string') {
      if (!body.name.trim()) {
        return res.status(400).json({ error: 'Task name cannot be empty' });
      }
      task.name = body.name.trim();
      // …and the Table's title cell with it. Not logged: the name change below
      // already says it.
      const primaryChange = syncPrimaryFromName(task, ctx.board);
      if (primaryChange) columnChanges.push(primaryChange);
    }
    // One `name` row however the title moved — from `body.name` or from the
    // primary cell — judged against where it started.
    if (task.name !== prevName) {
      activityChanges.push({ field: 'name', oldValue: prevName, newValue: task.name });
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
        // Only an actual change of the assignee set counts as assigning, and
        // only the people it MOVES are gated — adding or dropping yourself is
        // the contributor's own work, anyone else is the `edit` rung's call.
        const assignDenied = requireAssignCapability(ctx, userId, [
          ...newAssigneeIds,
          ...removedAssigneeIds,
        ]);
        if (assignDenied) {
          return res.status(assignDenied.status).json({ error: assignDenied.error });
        }
        activityChanges.push({ field: 'assignees', oldValue: prevAssigneeIds, newValue: ids });
      }
      // The Owner cell follows (see `writeRoleColumn`). That cell can name
      // people `assignedTo` does not — a row whose Owner was set in the Table
      // before the two were kept in step — and the panel, which shows
      // `assignedTo`, never showed them. So what the request sent is not the
      // whole truth about the cell, and what happens to those unseen names
      // depends on who is asking:
      //
      //   - someone holding `task.assign` REPLACES, as they always have. Their
      //     list is an instruction about who is on the row, and dropping a
      //     name is a power they hold.
      //   - anyone else can only have reached here moving their OWN name (the
      //     gate above refuses any other delta), so their write is MERGED into
      //     the cell: its previous names, minus anyone this request removed,
      //     plus everyone it asked for. Refusing that with a 403 — the old
      //     behaviour — meant a contributor could not claim a row at all
      //     because of names they could not see; overwriting instead would take
      //     those people off the work, the one thing the assign gate exists to
      //     stop.
      //
      // The save hook copies the cell onto `assignedTo` (the cell was written,
      // so the column wins), so the merged list is set on the field here too
      // rather than left for the hook to overwrite. The activity row above
      // keeps the caller's own delta: it is a record of what THEY did, and the
      // names that surface from the cell were put there by somebody else.
      // (When the same request writes the Owner cell itself, that write was
      // gated as a person patch and `writeRoleColumn` stands aside.)
      const ownerCol = assigneeRoleCol;
      const patchWritesOwner =
        !!ownerCol &&
        !!body.columnValues &&
        typeof body.columnValues === 'object' &&
        Object.prototype.hasOwnProperty.call(body.columnValues, ownerCol._id.toString());
      let resulting = ids;
      if (ownerCol && !patchWritesOwner && !ctx.can('task.assign')) {
        const cellPrev = personIdsOf(task.columnValues.get(ownerCol._id.toString()));
        const unseen = cellPrev.filter((id) => !nextSet.has(id) && !prevSet.has(id));
        if (unseen.length) {
          const removedSet = new Set(removedAssigneeIds);
          resulting = [
            ...cellPrev.filter((id) => !removedSet.has(id)),
            ...ids.filter((id) => !cellPrev.includes(id)),
          ];
        }
      }
      task.assignedTo = resulting;
      const roleChange = writeRoleColumn(task, ctx.board, 'assignee', resulting, body.columnValues);
      if (roleChange) columnChanges.push(roleChange);
    }
    if (body.dueDate !== undefined) {
      const nextDue = body.dueDate || null;
      const nextIso = nextDue ? new Date(nextDue).toISOString() : null;
      if (prevDueIso !== nextIso) activityChanges.push({ field: 'dueDate', oldValue: prevDueIso, newValue: nextIso });
      task.dueDate = body.dueDate || undefined;
      // The Due cell follows, so the ledger and the Table agree with the panel
      // and the save hook does not revert the field from the old cell.
      const roleChange = writeRoleColumn(task, ctx.board, 'dueDate', nextDue, body.columnValues);
      if (roleChange) columnChanges.push(roleChange);
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
        // A subitem has no group of its own to change: it lives wherever its
        // parent lives, and the two disagreeing is exactly the split family the
        // cascade after `save()` exists to prevent. `moveTasksToMonth` and
        // `reorderTasks` already refuse a child on these grounds for the other
        // partition key ("Subitems move with their parent and cannot be refiled
        // on their own"); this branch was the one way left to write the
        // divergence by hand, and leaving it open would let a single PUT
        // recreate the state we are here to remove.
        //
        // Gated on a REAL change for the same reason the capability check below
        // is: a client echoing a subitem's current group back is not moving
        // anything, and 400ing it would break callers that round-trip the whole
        // task object.
        if (task.parent) {
          return res.status(400).json({
            error: 'Subitems move with their parent and cannot be refiled on their own',
          });
        }
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

    // Paid in full: a write that moved the payments or the amount, leaving the
    // payments covering the amount, moves the row to the board's done status —
    // logged, notified and emailed below exactly like a status change somebody
    // made by hand, because to everyone reading the board it is one. Never the
    // other way: a payment removed later does not reopen the row.
    //
    // A status this same request CHANGED is the more specific instruction and
    // stands — the same rule `writeRoleColumn` follows for the Due and Owner
    // cells. A status merely echoed back unchanged is not an instruction.
    if (!statusChanged) {
      const settled = settledStatusOf(task, ctx.board, columnChanges);
      if (settled) {
        statusChanged = true;
        activityChanges.push({
          field: 'status',
          oldValue: prevStatus,
          newValue: settled._id.toString(),
          meta: { settledBy: 'payments' },
        });
        applySettledStatus(task, ctx.board, settled);
        statusName = settled.name;
      }
    }

    await task.save();

    // The parent has landed in its new group; its subitems are still in the old
    // one, because they carry a `group` of their own and nothing above touched
    // them. That split is not cosmetic — deleting either group then destroys or
    // orphans half the family (see `subitemGroupFollow`), which is why this
    // mirrors what `moveTasksToMonth` already does for `monthKey`: "Subitems
    // follow, so a parent and its children are never in different months". The
    // group half was simply never carried over.
    //
    // Deliberately AFTER `task.save()`. `save()` is where the whole edit is
    // validated, and moving the children first would strand them under a parent
    // that never moved, on a request the caller was told had failed. This way
    // round the worst partial state is the one we already had, the children are
    // still findable in the old group, and re-issuing the same move repairs it.
    //
    // Guarded by the body rather than by `activityChanges`, so that a retry of a
    // move whose child write died still reconciles: by then `prevGroup` already
    // equals the new group and nothing was logged, but the children are still
    // behind.
    if (body.group !== undefined && body.group !== null) {
      const follow = subitemGroupFollow([task._id], task.group);
      if (follow) await Task.updateMany(follow.filter, follow.update);
    }

    // Only now that the edit is saved: a file the cell let go of is gone for
    // good once Cloudinary drops it, so it must not go on a request that failed.
    destroyDroppedColumnFiles(task, ctx.board, droppedFiles);

    for (const c of activityChanges) {
      logActivity({
        task,
        actor: userId,
        type: 'task.field_changed',
        field: c.field,
        oldValue: c.oldValue,
        newValue: c.newValue,
        // `taskName` is read here, after the save, so a rename in the same
        // request is logged under the name the row now has.
        metadata: { taskName: task.name, ...(c.meta || {}) },
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

    // Who this write put on the row. `newAssigneeIds` is what `assignedTo` in
    // the body added. The rest is read off the SAVED row: an Owner cell written
    // from the Table or the ledger is copied onto `assignedTo` by the save hook,
    // so anyone there now who was in neither the old `assignedTo` nor the old
    // Owner cell was assigned by this write, whichever way it came in. Someone
    // already named in the cell before (a row from before the two were kept in
    // step) is not newly assigned and is not told again.
    //
    // Both lists are checked against the SAVED row: when the same request also
    // wrote the Owner cell, the save hook lets the cell win, and telling
    // somebody "you were assigned" (or "removed") over a value that never
    // landed is a notification and an email about a thing that did not happen.
    const prevPeople = new Set([...prevAssigneeIds, ...prevOwnerCellIds]);
    const savedPeople = new Set((task.assignedTo || []).map((u) => u.toString()));
    const bodyAdded = (newAssigneeIds || []).filter((id) => savedPeople.has(id));
    const cellAdded = [...savedPeople].filter((id) => !prevPeople.has(id) && !bodyAdded.includes(id));
    const assignedNow = [...bodyAdded, ...cellAdded];
    if (removedAssigneeIds) removedAssigneeIds = removedAssigneeIds.filter((id) => !savedPeople.has(id));
    if (assignedNow.length > 0) {
      await announceAssignment({
        task,
        ids: assignedNow,
        actorId: userId,
        actorName: req.user?.name || '',
        orgId: ctx.board.organisation,
        boardId: task.board,
        taskLink: buildTaskDeepLink(task),
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
 * Which of the dropped ids are actually CHANGING group.
 *
 * Pulled out of `reorderWriteOps` so that the two things which depend on that
 * judgement — stamping `groupChangedAt`, and dragging a card's subitems along
 * behind it — cannot drift apart. They answered the same question in two
 * places before, and a card that counts as "moved" for the clock but not for
 * its children is precisely the split family this whole area is about.
 *
 * An id with no prior row counts as arriving, which is the existing behaviour
 * and the safe answer either way: see stageMove.test.js for why.
 *
 * @param {Array<string>} orderedIds  the target group's full order after the drop
 * @param {Array<{_id:*, group:*}>} priorTasks  the same tasks as they are NOW
 * @param {*} targetGroupId
 * @returns {Array<string>} the subset of `orderedIds` whose group changes
 */
const movedGroupIds = (orderedIds, priorTasks, targetGroupId) => {
  const targetIdStr = targetGroupId ? targetGroupId.toString() : null;
  const priorGroup = new Map(
    (priorTasks || []).map((t) => [t._id.toString(), t.group ? t.group.toString() : null])
  );
  return (orderedIds || []).filter((id) => priorGroup.get(String(id)) !== targetIdStr);
};

/**
 * The child rows a group move has to carry with it.
 *
 * A subitem stores its own `group`, but it has no independent existence — it is
 * reachable only through its parent. Every task delete in the server keys on
 * `group` alone, so the moment a parent's group and its children's disagree,
 * deleting the OLD group destroys live subitems of a task that still exists
 * elsewhere (the parent is no longer in that group to shelter them, and no
 * activity row is written for the children), while deleting the NEW group
 * leaves the children behind a dead parent, invisible to the board and
 * unreachable by any link. Both halves of the move path — `updateTask`'s
 * `body.group` branch and the drag through `reorderTasks` — go through here, so
 * there is one answer to "which children follow" rather than two.
 *
 * Two deliberate choices, both load-bearing.
 *
 * The filter matches on DIVERGENCE (`group: { $ne: targetGroupId }`) rather
 * than on `parent` alone. The write is then about the state of the data, not
 * about what this particular request changed: children already in the right
 * group cost nothing, and a family left split by an earlier half-completed move
 * is repaired by the next move of that parent instead of needing a sweeper.
 * That is what makes re-issuing a failed move a repair rather than a no-op.
 *
 * The `$set` carries `group` and nothing else. In particular it must not stamp
 * `groupChangedAt`: that field means "time in stage" for a top-level card on
 * the stages view (models/Task.js), and a subitem never appears there, so
 * writing it would put a meaningless clock on rows no view can show.
 *
 * Returns null rather than a no-op write when there is nothing to carry, so a
 * caller can skip the round trip entirely.
 *
 * @param {Array<*>} parentIds  ids of the tasks that are moving
 * @param {*} targetGroupId  the group they are moving into
 * @returns {{filter: Object, update: Object}|null}
 */
const subitemGroupFollow = (parentIds, targetGroupId) => {
  const ids = (parentIds || []).filter(Boolean);
  if (ids.length === 0 || !targetGroupId) return null;
  return {
    filter: { parent: { $in: ids }, group: { $ne: targetGroupId } },
    update: { $set: { group: targetGroupId } },
  };
};

/**
 * The bulk writes one reorder produces.
 *
 * Pure, and exported, so the one rule with teeth here can be asserted rather
 * than described: `groupChangedAt` is stamped ONLY on rows that actually
 * changed group.
 *
 * "Time in stage" is the number the stages view exists to show — a deal sitting
 * in Qualified for six weeks is the most useful thing a pipeline card can say.
 * If tidying the order inside a column reset that clock, the oldest deal on the
 * board would read as the newest, and nothing would look broken.
 *
 * One timestamp for the whole batch, so every card moved by a single drag
 * shares an instant rather than drifting by however long the loop took.
 *
 * These ops cover the dropped rows and nothing else. Carrying their subitems
 * across is a separate write in `reorderTasks`, built from
 * `subitemGroupFollow`, deliberately kept out of this list: every op here is an
 * `updateOne` keyed by `_id`, and the child write is an `updateMany` over a
 * `parent` filter, so folding it in would make the return value two shapes.
 *
 * @param {Array<string>} orderedIds  the target group's full order after the drop
 * @param {Array<{_id:*, group:*}>} priorTasks  the same tasks as they are NOW
 * @param {*} targetGroupId
 * @param {Date} at
 * @returns {Array<Object>} bulkWrite ops
 */
const reorderWriteOps = (orderedIds, priorTasks, targetGroupId, at) => {
  const movedIds = new Set(
    movedGroupIds(orderedIds, priorTasks, targetGroupId).map((id) => String(id))
  );
  return (orderedIds || []).map((id, idx) => {
    const moved = movedIds.has(String(id));
    return {
      updateOne: {
        filter: { _id: id },
        update: {
          $set: {
            order: idx,
            group: targetGroupId,
            ...(moved ? { groupChangedAt: at } : {}),
          },
        },
      },
    };
  });
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

    if (ctx.board.boardType !== 'tracker') {
      return res.status(400).json({ error: 'This board is not a tracker board' });
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

/**
 * PUT /api/tasks/reorder
 * Body: { targetGroupId, orderedIds: [id,...], month?: 'YYYY-MM' }
 *
 * `month` scopes the task list in the RESPONSE, never the write. On a tracker
 * board the client only ever holds one month, so the reply must be that same
 * month or the client's replace-the-bucket update pulls in every other month.
 * It is optional (and derived from the moved rows when absent) because a reorder
 * has already been persisted by the time we build the reply — this is not a
 * place to 400 the way the read path does.
 */
const reorderTasks = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { orderedIds, targetGroupId, month } = req.body || {};

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
    // `group` is selected so the write below can tell a MOVE from a reorder —
    // see `groupChangedAt`. Without it every drag inside a group would reset
    // the stages view's "time in stage" clock.
    const tasks = await Task.find({ _id: { $in: orderedIds } }).select(
      '_id board parent monthKey group'
    );
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

    const ops = reorderWriteOps(orderedIds, tasks, targetGroupId, new Date());
    if (ops.length > 0) await Task.bulkWrite(ops);

    // A drag re-homes the cards the client named, and subitems are never among
    // them (this endpoint refuses a child outright, a few lines up), so the
    // children of anything that crossed a group boundary have to be carried
    // over by us or they stay behind in a group their parent has left — see
    // `subitemGroupFollow` for what that costs the next time either group is
    // deleted. Only the ids that actually changed group are passed: a tidy-up
    // drag inside one column must not touch a single subitem row.
    //
    // After the parents, not before. The parent's group is what the board
    // renders and what everything else reads, so if only one of the two writes
    // lands it should be that one; a crash in between leaves the children
    // findable in the old group, and the next move of the same parent repairs
    // them because the follow filter matches divergence rather than this
    // request.
    const follow = subitemGroupFollow(
      movedGroupIds(orderedIds, tasks, targetGroupId),
      targetGroupId
    );
    if (follow) await Task.updateMany(follow.filter, follow.update);

    await Board.updateOne({ _id: targetGroup.board }, { $set: { updatedAt: new Date() } });

    // The client REPLACES its bucket for this group with whatever comes back,
    // so this read has to be scoped exactly like `getTasks` was — on a tracker
    // board that means one month. Returning the group's whole history here made
    // every drag inside a month dump three years of rows into the group, which
    // looks like "reordering cleared the month filter".
    const readFilter = { group: targetGroupId, parent: null, isPersonal: { $ne: true } };
    if (ctx.board?.boardType === 'tracker') {
      // Prefer the month the client says it is looking at. Fall back to the
      // month of the rows just moved — they all come from one month's view, so
      // a single distinct value is the month on screen. Only a genuinely
      // ambiguous case (empty list, or mixed/legacy null monthKeys) falls
      // through unscoped, which is the old behaviour and no worse than it.
      let scope = isMonthKey(month) ? month : null;
      if (!scope) {
        const seen = new Set(tasks.map((t) => t.monthKey || null));
        const only = seen.size === 1 ? [...seen][0] : null;
        if (isMonthKey(only)) scope = only;
      }
      if (scope) readFilter.monthKey = scope;
    }

    const updated = await populateTask(Task.find(readFilter))
      .sort({ order: 1, createdAt: 1 })
      .lean();
    await annotateHasSubitems(updated);
    await annotateUpdateCounts(updated);
    // Same reason as the month scope: match what `getTasks` hands the client,
    // or mirror columns render as raw cache wrappers after a drag.
    await embedMirrorValues(updated, ctx.board);

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
 * PUT /api/tasks/:id/goal-links
 * Body: { goalIds?: string[], dismissed?: boolean }
 *
 * Attach a task to the goals it counted towards, on a tracker board. EVIDENCE
 * ONLY — this writes nothing to any Goal, and `utils/goalTypes.js` never reads
 * what it writes. See utils/goalEvidence.js.
 *
 * A FULL REPLACE, not add/remove deltas, so the on-done prompt and the task
 * panel submit identically and two open surfaces cannot race into a half state.
 *
 * WHY THIS IS NOT `PUT /api/tasks/:id`. Three reasons, in order of weight:
 *   1. The generic route's full-edit branch gates on `canEditTask`, which is the
 *      wrong standing. The person who just finished a task should be able to say
 *      what it was for without being able to rewrite everyone else's rows.
 *   2. It would need a fourth carve-out beside the status-only branch, which is
 *      already the one exception that route carries.
 *   3. It avoids `task.save()`, whose pre-save hook does a `Board.findById` on
 *      every write to sync legacy columns — pointless on a write that touches
 *      neither `columnValues` nor a legacy field.
 *
 * CAPABILITY: `task.change_status` AND `goal.view`. Not `goal.track`, which is
 * "fill in the final numbers on existing goals" — this write changes no number,
 * and borrowing that rung would blur the one line the three-rung goal split
 * exists to draw. The AND is what makes it exact: a `viewer` holds `goal.view`
 * but not `task.change_status`, and a `guest` holds `task.change_status` but not
 * `goal.view`, so both are refused without a single new role.
 */
const setTaskGoalLinks = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    const { goalIds, dismissed } = req.body || {};

    const hasGoalIds = goalIds !== undefined;
    const hasDismissed = dismissed !== undefined;
    if (!hasGoalIds && !hasDismissed) {
      return res
        .status(400)
        .json({ error: 'Provide goalIds, dismissed, or both' });
    }
    if (hasGoalIds && !Array.isArray(goalIds)) {
      return res.status(400).json({ error: 'goalIds must be an array' });
    }
    if (hasDismissed && typeof dismissed !== 'boolean') {
      return res.status(400).json({ error: 'dismissed must be a boolean' });
    }

    const task = await Task.findById(id);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    // 400 rather than 404: the task exists, it just cannot carry evidence.
    if (!isAttachable(task)) {
      return res.status(400).json({
        error: 'Only top-level tasks on a tracker board can be linked to goals',
      });
    }

    const ctx = await loadTaskBoardContext(task.board, userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    if (ctx.board.boardType !== 'tracker') {
      return res.status(400).json({
        error: 'This board does not have goals',
        code: 'NOT_TRACKER_BOARD',
      });
    }

    const denied = requireCapability(
      ctx,
      'task.change_status',
      'You do not have permission to link tasks to goals'
    );
    if (denied) return res.status(denied.status).json({ error: denied.error });
    if (!ctx.can('goal.view')) {
      return res
        .status(403)
        .json({ error: 'You do not have permission to see the goals on this board' });
    }

    // De-duped, order preserved: the prompt attaches one chip at a time and can
    // be double-clicked.
    const requested = hasGoalIds
      ? [...new Set(goalIds.map((g) => String(g)))]
      : linkedGoalIds(task);

    if (requested.length > MAX_GOAL_LINKS) {
      return res
        .status(422)
        .json({ error: `A task can be linked to at most ${MAX_GOAL_LINKS} goals` });
    }
    if (requested.some((g) => !mongoose.Types.ObjectId.isValid(g))) {
      return res.status(400).json({ error: 'goalIds contains an invalid id' });
    }

    // THE SCOPE RULE, enforced at the only place it can be: same board, same
    // group, same month. `task.monthKey` is what "the month it was completed
    // in" means on a tracker board — there is no completedAt, deliberately
    // (see utils/trackerEvaluate.js), and a task created on 31 July for
    // August's work is an August task.
    let goals = [];
    if (requested.length > 0) {
      goals = await Goal.find({
        _id: { $in: requested },
        board: task.board,
        group: task.group,
        monthKey: task.monthKey,
      }).select('_id name');
      if (goals.length !== requested.length) {
        return res.status(422).json({
          error: 'A task can only be linked to goals in its own group and month',
          code: 'GOAL_OUT_OF_SCOPE',
        });
      }
    }

    // Existing links keep their original author and timestamp — re-saving the
    // set from the panel must not rewrite who attached what, or the record of
    // who claimed the work is destroyed by anyone who opens the picker.
    const existingByGoal = new Map(
      (task.goalLinks || []).map((link) => [String(link.goal), link])
    );
    const nextLinks = requested.map((goalId) => {
      const prior = existingByGoal.get(goalId);
      if (prior) return prior;
      return {
        goal: goalId,
        monthKey: task.monthKey,
        group: task.group,
        linkedBy: userId,
      };
    });

    const prevIds = linkedGoalIds(task);
    const prevDismissed = isDismissed(task);
    // Attaching anything clears the dismissal: a task cannot be both attached
    // and deliberately unattached.
    const nextDismissed =
      nextLinks.length > 0 ? false : hasDismissed ? dismissed : prevDismissed;

    const linksChanged =
      prevIds.length !== requested.length
      || prevIds.some((gid, i) => gid !== requested[i]);
    const dismissChanged = prevDismissed !== nextDismissed;

    if (linksChanged || dismissChanged) {
      await Task.updateOne(
        { _id: task._id },
        {
          $set: {
            goalLinks: nextLinks,
            goalLinkDismissedAt: nextDismissed ? new Date() : null,
            goalLinkDismissedBy: nextDismissed ? userId : null,
          },
        }
      );

      // Goal NAMES are denormalised into metadata rather than looked up at read
      // time, so the row still reads after the goal is deleted — the same trick
      // logGoalDeleted uses. Names for goals being REMOVED come from a second
      // lookup, which is why both sides are collected here.
      const goalNames = {};
      for (const g of goals) goalNames[String(g._id)] = g.name;
      const missing = prevIds.filter((gid) => !goalNames[gid]);
      if (missing.length > 0) {
        const priorGoals = await Goal.find({ _id: { $in: missing } }).select('_id name');
        for (const g of priorGoals) goalNames[String(g._id)] = g.name;
      }

      if (linksChanged) {
        logActivity({
          task,
          actor: userId,
          type: 'task.field_changed',
          field: 'goalLinks',
          oldValue: prevIds,
          newValue: requested,
          metadata: { taskName: task.name, monthKey: task.monthKey, goalNames },
        });
      }
      if (dismissChanged) {
        logActivity({
          task,
          actor: userId,
          type: 'task.field_changed',
          field: 'goalLinks',
          oldValue: prevDismissed ? 'not_goal_work' : null,
          newValue: nextDismissed ? 'not_goal_work' : null,
          metadata: { taskName: task.name, monthKey: task.monthKey },
        });
      }

      eventBus.emit('task.updated', { taskId: task._id, boardId: task.board });
      // The Goals tab refetches its evidence off the debounced `board.changed`
      // signal, and this write touches a Task, not a Goal — without this bump
      // another user's chip count lags behind until they reload.
      await Board.updateOne({ _id: task.board }, { $set: { updatedAt: new Date() } });
    }

    const populated = await populateTask(Task.findById(task._id));
    return res.json({ task: populated });
  } catch (err) {
    console.error('setTaskGoalLinks error:', err);
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

    // The board's columns, for the file cells below. A personal task has no
    // board and so no columns — nothing of its can be in a file cell.
    let boardColumns = [];
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
      boardColumns = ctx.board.columns || [];
    }

    // Cascade subitems first — fetch their ids so their updates and
    // notifications are also cleaned up.
    const subitems = await Task.find({ parent: id }).select('_id attachments columnValues').lean();
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
    // …and the files in FILE COLUMNS, which no delete path used to reach: an
    // invoice's PDF lives in one, and deleting the invoice left the PDF public
    // at its URL. Before the rows go, because the cell is the only record of
    // the asset. See utils/fileColumnAssets.js.
    // The board id rides along explicitly: the subitems above were read
    // without `board`, and a row whose board cannot be named destroys nothing.
    // `excludeTaskIds`: a file another row on the board still links to (a
    // Retry that created the row twice, a planted copy) is kept.
    await destroyFileColumnAssets(boardColumns, [task, ...subitems], {
      boardId: task.board,
      excludeTaskIds: idsToDelete,
    });

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
  reorderWriteOps,
  // The "a family moves together" rule, exported for subitemGroupFollow.test.js.
  // Both are pure: ids need only `.toString()`, so plain strings stand in for
  // ObjectIds.
  movedGroupIds,
  subitemGroupFollow,
  moveTasksToMonth,
  setTaskPinned,
  setTaskGoalLinks,
  setTaskPortalShared,
  addChecklistItem,
  updateChecklistItem,
  deleteChecklistItem,
  reorderChecklist,
  getTaskAttachments,
  uploadTaskAttachment,
  deleteTaskAttachment,
  getClientRequest,
  // The self-assignment carve-out, exported for selfAssign.test.js. Both are
  // pure — hand them a ctx-like `{ can }` and plain objects.
  requireAssignCapability,
  isSelfClaim,
  // The no-op-write test, exported for taskColumnSync.test.js. Pure.
  columnValuesEqual,
};
