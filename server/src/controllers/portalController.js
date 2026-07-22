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
const {
  hashPasscode,
  verifyPasscode,
  generatePortalToken,
  generateMagicToken,
  hashMagicToken,
} = require('../utils/portalCrypto');
const { rateLimit } = require('../utils/portalRateLimit');
const { createNotificationsForUsers } = require('../services/notificationService');
const {
  sendPortalMagicLinkEmail,
  sendPortalReplyEmail,
} = require('../services/emailService');

const CLIENT_URL = () => process.env.CLIENT_URL || 'http://localhost:5173';
const MAGIC_TTL_MS = 15 * 60 * 1000; // 15 minutes
const PORTAL_JWT_TTL = '7d';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const clientIp = (req) =>
  (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
  req.socket?.remoteAddress ||
  'unknown';

const clientLabel = (group) =>
  (group.portalClientName && group.portalClientName.trim()) || group.name;

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
 * Public branding + whether a passcode is required. No secrets.
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
      passcodeRequired: !!group.portalPasscodeHash,
    });
  } catch (err) {
    console.error('getPortalMeta error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/portal/:portalToken/request-link   Body: { email, passcode }
 * Verify the passcode, upsert the ClientContact, mint a magic token, email it.
 * Email existence is never revealed; a wrong passcode is reported (throttled).
 */
const requestMagicLink = async (req, res) => {
  try {
    const { portalToken } = req.params;
    const email = (req.body?.email || '').trim().toLowerCase();
    const passcode = req.body?.passcode ?? '';

    const rl = rateLimit(`${clientIp(req)}:${portalToken}`, { max: 8 });
    if (!rl.allowed) {
      return res
        .status(429)
        .json({ error: `Too many attempts. Try again in ${rl.retryAfterSec}s.` });
    }

    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    const group = await TaskGroup.findOne({ portalToken, portalEnabled: true });
    if (!group) return res.status(404).json({ error: 'Portal not found' });

    const board = await Board.findById(group.board).select('boardType organisation');
    if (!board || board.boardType !== 'client') {
      return res.status(404).json({ error: 'Portal not found' });
    }

    // Passcode gate (constant-time). Reported clearly for UX, throttled above.
    if (group.portalPasscodeHash) {
      const ok = verifyPasscode(passcode, group.portalPasscodeSalt, group.portalPasscodeHash);
      if (!ok) return res.status(401).json({ error: 'Incorrect passcode.' });
    }

    // Upsert the contact for (group, email).
    const contact = await ClientContact.findOneAndUpdate(
      { group: group._id, email },
      {
        $setOnInsert: {
          group: group._id,
          board: board._id,
          organisation: board.organisation,
          email,
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    const { raw, hash } = generateMagicToken();
    await PortalMagicToken.create({
      tokenHash: hash,
      contact: contact._id,
      group: group._id,
      board: board._id,
      expiresAt: new Date(Date.now() + MAGIC_TTL_MS),
    });

    const org = await Organisation.findById(board.organisation).select('name');
    const link = `${CLIENT_URL()}/portal/verify?token=${raw}`;
    try {
      await sendPortalMagicLinkEmail({
        to: email,
        orgName: org?.name || '',
        clientName: clientLabel(group),
        link,
      });
    } catch (mailErr) {
      console.error('sendPortalMagicLinkEmail error:', mailErr);
      // Don't leak send failures as a way to probe; still return generic success.
    }

    return res.json({ message: 'Check your email for a sign-in link.' });
  } catch (err) {
    console.error('requestMagicLink error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * GET /api/portal/verify?token=RAW
 * Redeem a magic token (single-use, unexpired) → a scoped portal JWT.
 */
const verifyMagicLink = async (req, res) => {
  try {
    const raw = (req.query?.token || '').toString();
    if (!raw) return res.status(400).json({ error: 'Missing token' });

    const record = await PortalMagicToken.findOne({ tokenHash: hashMagicToken(raw) });
    if (!record || record.usedAt || record.expiresAt.getTime() < Date.now()) {
      return res.status(400).json({ error: 'This link is invalid or has expired.' });
    }

    const group = await TaskGroup.findById(record.group);
    if (!group || !group.portalEnabled) {
      return res.status(400).json({ error: 'This portal is no longer available.' });
    }

    record.usedAt = new Date();
    await record.save();

    const contact = await ClientContact.findById(record.contact);
    if (!contact) return res.status(400).json({ error: 'This link is invalid.' });
    if (!contact.verified) {
      contact.verified = true;
      await contact.save();
    }

    const org = await Organisation.findById(contact.organisation).select('name');

    const token = jwt.sign(
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

    return res.json({
      token,
      portal: { orgName: org?.name || '', clientName: clientLabel(group) },
    });
  } catch (err) {
    console.error('verifyMagicLink error:', err);
    return res.status(500).json({ error: 'Server error' });
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
  passcodeSet: !!group.portalPasscodeHash,
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
 * Body: { enabled?, clientName?, passcode?, regenerateLink? }
 * Enable/disable, set the client label, (re)set the passcode, rotate the link.
 */
const savePortalConfig = async (req, res) => {
  try {
    const ctx = await loadManageContext(req.params.groupId, req.user.userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    const { group } = ctx;
    const { enabled, clientName, passcode, regenerateLink } = req.body || {};

    if (typeof clientName === 'string') {
      group.portalClientName = clientName.trim();
    }

    if (typeof passcode === 'string' && passcode.length > 0) {
      const { salt, hash } = hashPasscode(passcode);
      group.portalPasscodeSalt = salt;
      group.portalPasscodeHash = hash;
    }

    // Mint a token the first time the portal is enabled, or on explicit rotate.
    const needsToken = !group.portalToken;
    if (regenerateLink || needsToken) {
      group.portalToken = generatePortalToken();
      // Rotating the link kills every outstanding magic link for this group.
      await PortalMagicToken.deleteMany({ group: group._id });
    }

    if (typeof enabled === 'boolean') {
      group.portalEnabled = enabled;
    }

    // Enabling requires a passcode to exist (the plan's "revocable + passcode").
    if (group.portalEnabled && !group.portalPasscodeHash) {
      return res
        .status(400)
        .json({ error: 'Set a passcode before enabling the client link.' });
    }

    await group.save();
    return res.json({ portal: adminPortalPayload(group) });
  } catch (err) {
    console.error('savePortalConfig error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

module.exports = {
  // public
  getPortalMeta,
  requestMagicLink,
  verifyMagicLink,
  // portal-authed
  getMyIssues,
  createMyIssue,
  uploadIssueAttachment,
  getIssueThread,
  postIssueThreadMessage,
  // team admin
  getPortalConfig,
  savePortalConfig,
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
