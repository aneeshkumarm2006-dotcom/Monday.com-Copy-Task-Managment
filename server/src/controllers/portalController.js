const jwt = require('jsonwebtoken');
const Board = require('../models/Board');
const TaskGroup = require('../models/TaskGroup');
const Task = require('../models/Task');
const Update = require('../models/Update');
const ClientContact = require('../models/ClientContact');
const PortalMagicToken = require('../models/PortalMagicToken');
const Organisation = require('../models/Organisation');
const { loadBoardContext } = require('../utils/boardContext');
const { isResolvedStatus } = require('../utils/doneStatus');
const { generatePortalToken } = require('../utils/portalCrypto');
const { createNotificationsForUsers } = require('../services/notificationService');
const { sendPortalReplyEmail } = require('../services/emailService');
const { sendGroupInvite } = require('../services/portalInviteService');

const CLIENT_URL = () => process.env.CLIENT_URL || 'http://localhost:5173';
const PORTAL_JWT_TTL = '7d';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const clientLabel = (group) =>
  (group.portalClientName && group.portalClientName.trim()) || group.name;

/** Mint the scoped portal session JWT for a signed-in client contact. */
const signPortalToken = (contact, group) =>
  jwt.sign(
    {
      scope: 'portal',
      contactId: String(contact._id),
      groupId: String(group._id),
      boardId: String(group.board),
      orgId: contact.organisation ? String(contact.organisation) : null,
      email: contact.email,
      ptk: group.portalToken,
    },
    process.env.JWT_SECRET,
    { expiresIn: PORTAL_JWT_TTL }
  );

// ---- serializers (never leak internal fields to the client) -----------------

const serializeIssue = (task, board) => ({
  id: String(task._id),
  name: task.name,
  note: task.note || '',
  category: task.portalCategory || '',
  createdAt: task.createdAt,
  resolved: isResolvedStatus(board, task.status),
});

const cleanAttachments = (attachments) =>
  (Array.isArray(attachments) ? attachments : [])
    .filter((a) => a && typeof a.url === 'string' && a.url.length > 0)
    .map((a) => ({
      url: a.url,
      name: a.name || '',
      mime: a.mime || '',
      size: Number.isFinite(a.size) ? a.size : 0,
      publicId: a.publicId || '',
    }));

// ============================================================================
// PUBLIC (no auth) — the client hasn't signed in yet.
// ============================================================================

/**
 * GET /api/portal/:portalToken
 * Public branding shown on the invitation landing page. No secrets.
 */
const getPortalMeta = async (req, res) => {
  try {
    const { portalToken } = req.params;
    const group = await TaskGroup.findOne({ portalToken, portalEnabled: true });
    if (!group) return res.status(404).json({ error: 'Portal not found' });

    const board = await Board.findById(group.board).select('boardType organisation');
    if (!board || board.boardType !== 'client') {
      return res.status(404).json({ error: 'Portal not found' });
    }
    const org = await Organisation.findById(board.organisation).select('name');

    return res.json({
      orgName: org?.name || '',
      clientName: clientLabel(group),
    });
  } catch (err) {
    console.error('getPortalMeta error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * GET /api/portal/auth/google/callback
 * The client returns here after "Accept invitation" → Google sign-in. Passport
 * (`google-portal`) has verified the Google account and attached the raw
 * identity to `req.user`; the group being joined rode along in `req.query.state`
 * as its portalToken. We upsert the ClientContact for (group, email), mint the
 * scoped portal JWT, and hand it to the frontend via a redirect. NEVER creates
 * an app User. On any failure we bounce to the portal verify page with an error.
 */
const portalGoogleCallback = async (req, res) => {
  const fail = () => res.redirect(`${CLIENT_URL()}/portal/verify?error=1`);
  try {
    const profile = req.user; // { email, name, picture } from google-portal strategy
    const portalToken = (req.query?.state || '').toString();
    if (!profile?.email || !portalToken) return fail();

    const group = await TaskGroup.findOne({ portalToken, portalEnabled: true });
    if (!group) return fail();

    const board = await Board.findById(group.board).select('boardType organisation');
    if (!board || board.boardType !== 'client') return fail();

    const email = String(profile.email).toLowerCase();
    const contact = await ClientContact.findOneAndUpdate(
      { group: group._id, email },
      {
        $setOnInsert: {
          group: group._id,
          board: board._id,
          organisation: board.organisation,
          email,
        },
        // Signing in with Google IS the verification, and it's a fresh chance to
        // pick up their display name.
        $set: { verified: true, ...(profile.name ? { name: profile.name } : {}) },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    const token = signPortalToken(contact, group);
    return res.redirect(
      `${CLIENT_URL()}/portal/verify?ptoken=${encodeURIComponent(token)}`
    );
  } catch (err) {
    console.error('portalGoogleCallback error:', err);
    return fail();
  }
};

// ============================================================================
// PORTAL-AUTHED (req.portal set by middleware/portalAuth) — the client's own data.
// ============================================================================

/**
 * GET /api/portal/me/issues
 * The signed-in contact's own issues + dashboard context (branding, categories).
 */
const getMyIssues = async (req, res) => {
  try {
    const { contactId, groupId, boardId } = req.portal;
    const board = await Board.findById(boardId).select('statuses portalCategories organisation');
    if (!board) return res.status(404).json({ error: 'Board not found' });

    const tasks = await Task.find({ group: groupId, portalSubmitter: contactId })
      .sort({ createdAt: -1 });

    const org = await Organisation.findById(board.organisation).select('name');

    return res.json({
      issues: tasks.map((t) => serializeIssue(t, board)),
      context: {
        orgName: org?.name || '',
        clientName: clientLabel(req.portal.group),
        categories: Array.isArray(board.portalCategories) ? board.portalCategories : [],
      },
    });
  } catch (err) {
    console.error('getMyIssues error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/portal/me/issues   Body: { name, note?, category? }
 * Create a client issue as a real board Task. Board/group come from the JWT,
 * never from input. Does NOT fire item.created automations (internal workflow).
 */
const createMyIssue = async (req, res) => {
  try {
    const { contactId, groupId, boardId } = req.portal;
    const name = (req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Please describe your issue.' });

    const board = await Board.findById(boardId).select('statuses portalCategories organisation');
    if (!board) return res.status(404).json({ error: 'Board not found' });

    // Default status _id (the board's isDefault status), same rule as createTask.
    let status = 'not_started';
    if (Array.isArray(board.statuses) && board.statuses.length > 0) {
      const fav = board.statuses.find((s) => s.isDefault);
      status = (fav || board.statuses[0])._id;
    }

    // Category is optional and must be one the board actually offers.
    let portalCategory = '';
    const requested = (req.body?.category || '').trim();
    if (requested && Array.isArray(board.portalCategories) && board.portalCategories.includes(requested)) {
      portalCategory = requested;
    }

    const last = await Task.findOne({ group: groupId }).sort({ order: -1 }).select('order');
    const order = (last?.order ?? -1) + 1;

    const task = await Task.create({
      name,
      note: (req.body?.note || '').toString().slice(0, 8000) || undefined,
      board: boardId,
      group: groupId,
      status,
      order,
      source: 'client',
      portalSubmitter: contactId,
      portalCategory,
      createdBy: null,
    });

    // Alert the team (in-app). createNotificationsForUsers filters the recipient
    // list down to board-readers itself, so passing all org members is safe.
    try {
      const org = await Organisation.findById(board.organisation).select('members');
      const memberIds = (org?.members || []).map((m) => String(m?._id || m));
      if (memberIds.length) {
        await createNotificationsForUsers({
          userIds: memberIds,
          type: 'clientIssueCreated',
          message: `New client issue from ${clientLabel(req.portal.group)}: "${name}"`,
          taskId: task._id,
          orgId: board.organisation,
          actorId: null,
          boardId,
        });
      }
    } catch (notifyErr) {
      console.error('createMyIssue notify error:', notifyErr);
    }

    return res.status(201).json({ issue: serializeIssue(task, board) });
  } catch (err) {
    console.error('createMyIssue error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Load an issue that MUST belong to the signed-in contact. Returns the task or
 * null — the caller 404s so we never confirm the existence of others' tasks.
 */
const loadOwnIssue = async (req, taskId) => {
  if (!taskId) return null;
  const task = await Task.findOne({
    _id: taskId,
    group: req.portal.groupId,
    portalSubmitter: req.portal.contactId,
  });
  return task || null;
};

/**
 * POST /api/portal/me/issues/:id/attachments   (multipart, field: file)
 * Attach a file/screenshot to one of the contact's own issues.
 */
const uploadIssueAttachment = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const task = await loadOwnIssue(req, req.params.id);
    if (!task) return res.status(404).json({ error: 'Issue not found' });

    const attachment = {
      url: req.file.path,
      name: req.file.originalname || '',
      mime: req.file.mimetype || '',
      size: req.file.size || 0,
      publicId: req.file.filename || '',
      uploadedBy: null,
    };
    task.attachments.push(attachment);
    await task.save();

    const saved = task.attachments[task.attachments.length - 1];
    return res.status(201).json({
      attachment: {
        id: String(saved._id),
        url: saved.url,
        name: saved.name,
        mime: saved.mime,
        size: saved.size,
      },
    });
  } catch (err) {
    console.error('uploadIssueAttachment error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * GET /api/portal/me/issues/:id/thread
 * The shared comment thread, projected so no internal user identity leaks: team
 * posts show as the org name, the client's own posts as their name.
 */
const getIssueThread = async (req, res) => {
  try {
    const task = await loadOwnIssue(req, req.params.id);
    if (!task) return res.status(404).json({ error: 'Issue not found' });

    const updates = await Update.find({ task: task._id }).sort({ createdAt: 1 });
    const org = await Organisation.findById(req.portal.orgId).select('name');
    const orgName = org?.name || 'Support team';
    const myName = req.portal.contact?.name || 'You';

    const messages = updates.map((u) => {
      const mine = u.authorType === 'client';
      return {
        id: String(u._id),
        mine,
        authorLabel: mine ? myName : orgName,
        bodyText: u.bodyText || '',
        attachments: (u.attachments || []).map((a) => ({
          url: a.url,
          name: a.name,
          mime: a.mime,
          size: a.size,
        })),
        createdAt: u.createdAt,
      };
    });

    return res.json({ issue: { id: String(task._id), name: task.name }, messages });
  } catch (err) {
    console.error('getIssueThread error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/portal/me/issues/:id/thread   Body: { bodyText, attachments? }
 * Post a client message into the shared thread, then alert the team.
 */
const postIssueThreadMessage = async (req, res) => {
  try {
    const task = await loadOwnIssue(req, req.params.id);
    if (!task) return res.status(404).json({ error: 'Issue not found' });

    const bodyText = (req.body?.bodyText || '').toString().trim();
    const attachments = cleanAttachments(req.body?.attachments);
    if (!bodyText && attachments.length === 0) {
      return res.status(400).json({ error: 'Message cannot be empty' });
    }

    const update = await Update.create({
      task: task._id,
      authorType: 'client',
      portalAuthor: req.portal.contactId,
      author: null,
      body: null,
      bodyText: bodyText.slice(0, 4000),
      attachments,
    });

    // Alert the team.
    try {
      const org = await Organisation.findById(req.portal.orgId).select('members');
      const memberIds = (org?.members || []).map((m) => String(m?._id || m));
      if (memberIds.length) {
        await createNotificationsForUsers({
          userIds: memberIds,
          type: 'clientReplied',
          message: `${clientLabel(req.portal.group)} replied on "${task.name}"`,
          taskId: task._id,
          orgId: req.portal.orgId,
          actorId: null,
          tab: 'updates',
          boardId: task.board,
        });
      }
    } catch (notifyErr) {
      console.error('postIssueThreadMessage notify error:', notifyErr);
    }

    return res.status(201).json({
      message: {
        id: String(update._id),
        mine: true,
        authorLabel: req.portal.contact?.name || 'You',
        bodyText: update.bodyText,
        attachments: update.attachments.map((a) => ({
          url: a.url,
          name: a.name,
          mime: a.mime,
          size: a.size,
        })),
        createdAt: update.createdAt,
      },
    });
  } catch (err) {
    console.error('postIssueThreadMessage error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

// ============================================================================
// TEAM ADMIN (req.user set by middleware/auth) — manage a group's portal link.
// Gated on board-manage: only the owner + full-access managers.
// ============================================================================

/**
 * Shared loader for the admin endpoints: verify the group is on a client board
 * the caller may MANAGE. Returns { group, board, org } or an { status, error }.
 */
const loadManageContext = async (groupId, userId) => {
  const group = await TaskGroup.findById(groupId);
  if (!group) return { status: 404, error: 'Group not found' };
  const ctx = await loadBoardContext(group.board, userId);
  if (ctx.error) return { status: ctx.status, error: ctx.error };
  if (ctx.board.boardType !== 'client') {
    return { status: 400, error: 'This board is not a client portal board' };
  }
  if (!ctx.access.canManageAccess) {
    return { status: 403, error: 'Only board managers can manage client links' };
  }
  return { group, board: ctx.board, org: ctx.org };
};

const adminPortalPayload = (group) => ({
  groupId: String(group._id),
  portalEnabled: !!group.portalEnabled,
  clientName: group.portalClientName || '',
  link: group.portalToken ? `${CLIENT_URL()}/portal/${group.portalToken}` : null,
});

/**
 * GET /api/portal/groups/:groupId/config  — current portal state for the modal.
 */
const getPortalConfig = async (req, res) => {
  try {
    const ctx = await loadManageContext(req.params.groupId, req.user.userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    return res.json({ portal: adminPortalPayload(ctx.group) });
  } catch (err) {
    console.error('getPortalConfig error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * PUT /api/portal/groups/:groupId/config
 * Body: { enabled?, clientName?, regenerateLink? }
 * Set the client label, enable/disable, or rotate the link. The link itself is
 * minted at group creation; this only mints one lazily for legacy groups.
 */
const savePortalConfig = async (req, res) => {
  try {
    const ctx = await loadManageContext(req.params.groupId, req.user.userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    const { group } = ctx;
    const { enabled, clientName, regenerateLink } = req.body || {};

    if (typeof clientName === 'string') {
      group.portalClientName = clientName.trim();
    }

    // Mint a token the first time (legacy groups from before auto-mint), or on
    // explicit rotate. Rotating invalidates the old link and, via portalAuth's
    // ptk check, kills every live client session on this group.
    const needsToken = !group.portalToken;
    if (regenerateLink || needsToken) {
      group.portalToken = generatePortalToken();
      await PortalMagicToken.deleteMany({ group: group._id });
    }

    if (typeof enabled === 'boolean') {
      group.portalEnabled = enabled;
    }

    await group.save();
    return res.json({ portal: adminPortalPayload(group) });
  } catch (err) {
    console.error('savePortalConfig error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/portal/groups/:groupId/invite   Body: { email }
 * Email (or re-email) the invitation link to a client. Ensures the group has a
 * live link first, so this doubles as "turn the portal on and invite".
 */
const sendPortalInvite = async (req, res) => {
  try {
    const ctx = await loadManageContext(req.params.groupId, req.user.userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    const { group, board } = ctx;

    const email = (req.body?.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    if (!group.portalToken) group.portalToken = generatePortalToken();
    if (!group.portalEnabled) group.portalEnabled = true;
    await group.save();

    const ok = await sendGroupInvite({ group, board, email });
    if (!ok) {
      return res
        .status(502)
        .json({ error: 'Could not send the invite email. Check the mail settings.' });
    }
    return res.json({ message: `Invitation sent to ${email}.`, portal: adminPortalPayload(group) });
  } catch (err) {
    console.error('sendPortalInvite error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

module.exports = {
  // public
  getPortalMeta,
  portalGoogleCallback,
  // portal-authed
  getMyIssues,
  createMyIssue,
  uploadIssueAttachment,
  getIssueThread,
  postIssueThreadMessage,
  // team admin
  getPortalConfig,
  savePortalConfig,
  sendPortalInvite,
  // reused by updateController for the "team replied on a client task" email hook
  sendPortalReplyEmailForTask: async (task, snippet = '') => {
    try {
      if (!task || task.source !== 'client' || !task.portalSubmitter) return;
      const contact = await ClientContact.findById(task.portalSubmitter).select('email');
      if (!contact?.email) return;
      const board = await Board.findById(task.board).select('organisation');
      const org = board ? await Organisation.findById(board.organisation).select('name') : null;
      await sendPortalReplyEmail({
        to: contact.email,
        orgName: org?.name || '',
        taskName: task.name,
        snippet: (snippet || '').toString().slice(0, 280),
        link: `${CLIENT_URL()}/portal`,
      });
    } catch (err) {
      console.error('sendPortalReplyEmailForTask error:', err);
    }
  },
};
