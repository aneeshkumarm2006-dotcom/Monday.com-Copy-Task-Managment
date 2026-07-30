const jwt = require('jsonwebtoken');
const Board = require('../models/Board');
const TaskGroup = require('../models/TaskGroup');
const Task = require('../models/Task');
const Update = require('../models/Update');
const ClientContact = require('../models/ClientContact');
const Organisation = require('../models/Organisation');
const { loadBoardContext } = require('../utils/boardContext');
const { isResolvedStatus } = require('../utils/doneStatus');
const {
  generatePortalToken,
  hashSetupToken,
  hashPassword,
  verifyPassword,
  verifyDummyPassword,
} = require('../utils/portalCrypto');
const { createNotificationsForUsers } = require('../services/notificationService');
const { logActivity } = require('../services/activityService');
const { sendPortalReplyEmail } = require('../services/emailService');
const {
  sendGroupInvite,
  inviteContact,
  issueSetupToken,
} = require('../services/portalInviteService');
const {
  loadRequestAttachments,
  isClientVisibleAttachment,
} = require('../utils/portalAttachments');

const CLIENT_URL = () => process.env.CLIENT_URL || 'http://localhost:5173';
const PORTAL_JWT_TTL = '7d';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Password rules for client accounts. Deliberately just a length floor: forced
// character classes push people toward "Password1!" and these are low-value
// accounts scoped to one client group. The upper bound only exists because
// scrypt hashes whatever it's given and there's no reason to burn CPU on a
// megabyte of input.
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 200;

// Per-contact brake on guessing, on top of the per-IP route limiter.
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

const clientLabel = (group) =>
  (group.portalClientName && group.portalClientName.trim()) || group.name;

/**
 * Resolve a public portal token to its live group + board, or null.
 *
 * Every public endpoint needs the same three facts — the group exists, its link
 * is enabled, and it really is on a client board — so they all go through here.
 * A disabled link and a nonexistent one are indistinguishable to the caller by
 * design.
 */
const loadPortalGroup = async (portalToken) => {
  if (!portalToken) return null;
  const group = await TaskGroup.findOne({ portalToken, portalEnabled: true });
  if (!group) return null;
  const board = await Board.findById(group.board).select('boardType organisation');
  if (!board || board.boardType !== 'client') return null;
  return { group, board };
};

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

/**
 * The status subdoc a task points at, plus a client-friendly 3-way bucket:
 *   - resolved → the board's "done" status
 *   - open     → the default / not-started status (nothing has happened yet)
 *   - ongoing  → anything in between (working on it, stuck, custom in-progress)
 * We surface the real status name + colour so the portal can show the same
 * label the team sees, not a flattened open/closed.
 */
const classifyIssue = (board, statusValue) => {
  const statuses = Array.isArray(board.statuses) ? board.statuses : [];
  const st = statuses.find((s) => String(s._id) === String(statusValue));

  if (isResolvedStatus(board, statusValue)) {
    return { state: 'resolved', label: st?.name || 'Resolved', color: st?.color || '#059669' };
  }
  const isOpen = st ? st.isDefault || st.key === 'not_started' : statusValue === 'not_started';
  return {
    state: isOpen ? 'open' : 'ongoing',
    label: st?.name || (isOpen ? 'Open' : 'In progress'),
    color: st?.color || (isOpen ? '#B45309' : '#2563EB'),
  };
};

// Request types the client can raise, and the priorities they can set.
const PORTAL_TYPES = [
  'bug',
  'feature',
  'requirement',
  'question',
  'meta_ads',
  'google_ads',
  'email_marketing',
  'website_development',
];
const PORTAL_PRIORITIES = ['low', 'medium', 'high', 'critical'];

/**
 * The earliest "needed by" date a client may submit.
 *
 * A date input posts a bare `YYYY-MM-DD`, which parses as UTC midnight, but the
 * client picked it against THEIR calendar — and clients are spread across
 * roughly a 26-hour span of local dates. Anchoring the floor on the server's own
 * midnight would reject the genuine today of anyone far enough west, so it sits
 * a day earlier. That is wide enough to cover every timezone and still narrow
 * enough that nothing meaningfully in the past gets through.
 */
const earliestAllowedDueDate = () => {
  const floor = new Date();
  floor.setUTCHours(0, 0, 0, 0);
  floor.setUTCDate(floor.getUTCDate() - 1);
  return floor;
};

// Human-friendly ticket reference. Sequential (REQ-1042) once portalRef is set;
// falls back to a stable id-suffix for legacy issues created before refs existed.
const issueRef = (task) =>
  task.portalRef ? `REQ-${task.portalRef}` : `REQ-${String(task._id).slice(-5).toUpperCase()}`;

const serializeIssue = (task, board) => {
  const { state, label, color } = classifyIssue(board, task.status);
  return {
    id: String(task._id),
    ref: issueRef(task),
    name: task.name,
    note: task.note || '',
    category: task.portalCategory || '',
    type: task.portalType || '',
    priority: task.priority || 'medium',
    rating: task.portalRating || null,
    dueDate: task.dueDate || null,
    createdAt: task.createdAt,
    // Surfaced on the client's list card so an upload is visibly confirmed
    // without having to open the request. Counts only files the client can
    // actually reach — the team's own Files-tab uploads live in the same array
    // but are never rendered in the portal, and counting them would promise
    // files that aren't there.
    attachmentCount: (Array.isArray(task.attachments) ? task.attachments : []).filter(
      isClientVisibleAttachment
    ).length,
    state, // 'open' | 'ongoing' | 'resolved'
    statusLabel: label,
    statusColor: color,
    resolved: state === 'resolved', // kept for backward compat
  };
};

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
    const ctx = await loadPortalGroup(req.params.portalToken);
    if (!ctx) return res.status(404).json({ error: 'Portal not found' });

    const org = await Organisation.findById(ctx.board.organisation).select('name');

    return res.json({
      orgName: org?.name || '',
      clientName: clientLabel(ctx.group),
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

    const ctx = await loadPortalGroup(portalToken);
    if (!ctx) return fail();
    const { group, board } = ctx;

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
        // pick up their display name. Deliberately does NOT touch authMethod: a
        // contact the team invited as 'password' who turns out to have Google
        // may still use it, and flipping the field would strand the password
        // they may already have set.
        $set: {
          verified: true,
          lastSeenAt: new Date(),
          ...(profile.name ? { name: profile.name } : {}),
        },
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

// ---- Password sign-in (clients whose email isn't a Google account) ----------
//
// Every one of these mints its session with the SAME signPortalToken as Google
// above, which is the whole point: middleware/portalAuth needs no knowledge that
// passwords exist, and the `ptk` claim keeps "Rotate link" / "Disable link"
// killing password sessions exactly as it kills Google ones.

/**
 * Find the contact a one-time token belongs to, or null if it is unknown,
 * expired, or already spent (consuming clears the hash).
 */
const loadContactBySetupToken = async (group, rawToken) => {
  if (!rawToken) return null;
  const contact = await ClientContact.findOne({
    group: group._id,
    setupTokenHash: hashSetupToken(rawToken),
  }).select('+setupTokenHash +passwordHash');
  if (!contact) return null;
  if (!contact.setupTokenExpires || contact.setupTokenExpires.getTime() < Date.now()) {
    return null;
  }
  return contact;
};

const validatePassword = (password, email) => {
  const pw = typeof password === 'string' ? password : '';
  if (pw.length < PASSWORD_MIN) {
    return `Please choose a password of at least ${PASSWORD_MIN} characters.`;
  }
  if (pw.length > PASSWORD_MAX) {
    return `Passwords can be at most ${PASSWORD_MAX} characters.`;
  }
  if (email && pw.toLowerCase() === String(email).toLowerCase()) {
    return 'Please choose a password that is not your email address.';
  }
  return null;
};

/**
 * POST /api/portal/:portalToken/auth/password   Body: { email, password }
 * Sign in a client who uses a password. Returns the portal JWT as JSON (the
 * landing page XHRs this), unlike the Google flow which redirects.
 */
const portalPasswordLogin = async (req, res) => {
  // One phrase for every "no" that isn't a lockout, so this can't be used to
  // discover which addresses have portal access.
  const DENIED = 'Incorrect email or password.';
  try {
    const ctx = await loadPortalGroup(req.params.portalToken);
    if (!ctx) return res.status(404).json({ error: 'Portal not found' });

    const email = (req.body?.email || '').toString().trim().toLowerCase();
    const password = (req.body?.password || '').toString();
    if (!EMAIL_RE.test(email) || !password) {
      return res.status(400).json({ error: 'Enter your email address and password.' });
    }

    const contact = await ClientContact.findOne({ group: ctx.group._id, email }).select(
      '+passwordHash'
    );

    // No such contact, or one that signs in with Google. Spend the same time a
    // real check would before answering.
    if (!contact || contact.authMethod !== 'password') {
      await verifyDummyPassword(password);
      return res.status(401).json({ error: DENIED });
    }

    if (contact.lockedUntil && contact.lockedUntil.getTime() > Date.now()) {
      const mins = Math.max(1, Math.ceil((contact.lockedUntil.getTime() - Date.now()) / 60000));
      return res.status(429).json({
        error: `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`,
      });
    }

    // Invited but hasn't chosen a password yet. This one answer does reveal that
    // the address is registered — a deliberate trade: the team picked this
    // address themselves, and the alternative is a client staring at "incorrect
    // password" for a password they were never asked to set.
    if (!contact.passwordHash) {
      return res.status(403).json({
        code: 'NEEDS_SETUP',
        error: "You haven't set a password yet. Ask us to email you a set-up link.",
      });
    }

    const ok = await verifyPassword(password, contact.passwordHash);
    if (!ok) {
      contact.failedLogins = (contact.failedLogins || 0) + 1;
      if (contact.failedLogins >= MAX_FAILED_LOGINS) {
        contact.lockedUntil = new Date(Date.now() + LOCKOUT_MS);
        contact.failedLogins = 0;
      }
      await contact.save();
      return res.status(401).json({ error: DENIED });
    }

    contact.failedLogins = 0;
    contact.lockedUntil = null;
    contact.verified = true;
    contact.lastSeenAt = new Date();
    await contact.save();

    return res.json({ token: signPortalToken(contact, ctx.group) });
  } catch (err) {
    console.error('portalPasswordLogin error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/portal/:portalToken/auth/password/forgot   Body: { email }
 * Email a one-time link to set or replace a password.
 *
 * Always answers identically, whatever the address turns out to be. Unlike the
 * login endpoint this is unauthenticated and unthrottled by any prior knowledge,
 * so it's the one an attacker would actually use to enumerate clients.
 */
const portalRequestPasswordLink = async (req, res) => {
  const QUIET = {
    message: "If that email has portal access, we've sent it a link. Check your inbox.",
  };
  try {
    const ctx = await loadPortalGroup(req.params.portalToken);
    if (!ctx) return res.status(404).json({ error: 'Portal not found' });

    const email = (req.body?.email || '').toString().trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    const contact = await ClientContact.findOne({ group: ctx.group._id, email }).select(
      '+passwordHash'
    );
    if (!contact || contact.authMethod !== 'password') return res.json(QUIET);

    const purpose = contact.passwordHash ? 'reset' : 'setup';
    const raw = await issueSetupToken(contact, purpose);
    await sendGroupInvite({
      group: ctx.group,
      board: ctx.board,
      email,
      authMethod: 'password',
      setupToken: raw,
      purpose,
    });

    return res.json(QUIET);
  } catch (err) {
    console.error('portalRequestPasswordLink error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

const EXPIRED_TOKEN = 'This link has expired or has already been used. Ask for a new one.';

/**
 * GET /api/portal/:portalToken/auth/setup/:token
 * Check a one-time link before showing the form, so the page can name the
 * address it's for and title itself "Set" vs "Reset".
 */
const portalCheckSetupToken = async (req, res) => {
  try {
    const ctx = await loadPortalGroup(req.params.portalToken);
    if (!ctx) return res.status(404).json({ error: 'Portal not found' });

    const contact = await loadContactBySetupToken(ctx.group, req.params.token);
    if (!contact) return res.status(400).json({ error: EXPIRED_TOKEN });

    const org = await Organisation.findById(ctx.board.organisation).select('name');
    return res.json({
      email: contact.email,
      purpose: contact.setupTokenPurpose || 'setup',
      orgName: org?.name || '',
      clientName: clientLabel(ctx.group),
    });
  } catch (err) {
    console.error('portalCheckSetupToken error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/portal/:portalToken/auth/setup/:token   Body: { password, name? }
 * Consume a one-time link: store the password and sign them straight in, so
 * "Set password" doesn't dump them back on a login form they just proved they
 * can pass.
 */
const portalCompletePasswordSetup = async (req, res) => {
  try {
    const ctx = await loadPortalGroup(req.params.portalToken);
    if (!ctx) return res.status(404).json({ error: 'Portal not found' });

    const contact = await loadContactBySetupToken(ctx.group, req.params.token);
    if (!contact) return res.status(400).json({ error: EXPIRED_TOKEN });

    const password = (req.body?.password || '').toString();
    const problem = validatePassword(password, contact.email);
    if (problem) return res.status(400).json({ error: problem });

    contact.passwordHash = await hashPassword(password);
    contact.passwordSetAt = new Date();
    contact.authMethod = 'password';
    contact.verified = true;
    contact.lastSeenAt = new Date();
    // Single-use: clearing the hash is what makes a re-opened link fail.
    contact.setupTokenHash = null;
    contact.setupTokenExpires = null;
    contact.setupTokenPurpose = null;
    contact.failedLogins = 0;
    contact.lockedUntil = null;

    const name = (req.body?.name || '').toString().trim();
    if (name && !contact.name) contact.name = name.slice(0, 120);

    await contact.save();

    return res.json({ token: signPortalToken(contact, ctx.group) });
  } catch (err) {
    console.error('portalCompletePasswordSetup error:', err);
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
    const board = await Board.findById(boardId)
      .select('statuses portalCategories organisation portalAnnouncement portalFaqs');
    if (!board) return res.status(404).json({ error: 'Board not found' });

    const tasks = await Task.find({ group: groupId, portalSubmitter: contactId })
      .sort({ createdAt: -1 });

    const org = await Organisation.findById(board.organisation).select('name');

    const company = clientLabel(req.portal.group);
    const contactName = req.portal.contact?.name || '';

    // Per-issue last activity — the newest thread message and who sent it. Lets
    // the dashboard flag issues that have an unread TEAM reply (the client
    // compares lastActivityAt against what they last opened, kept client-side).
    const taskIds = tasks.map((t) => t._id);
    const lastByTask = new Map();
    if (taskIds.length) {
      const rows = await Update.aggregate([
        // Internal notes are invisible here too, not just in the thread body — a
        // "new activity" dot the client cannot open onto anything would still tell
        // them the team said something, and when.
        { $match: { task: { $in: taskIds }, visibility: { $ne: 'internal' } } },
        { $sort: { createdAt: 1 } },
        { $group: { _id: '$task', lastAt: { $last: '$createdAt' }, lastType: { $last: '$authorType' } } },
      ]);
      rows.forEach((r) => lastByTask.set(String(r._id), r));
    }

    const issues = tasks.map((t) => {
      const base = serializeIssue(t, board);
      const last = lastByTask.get(base.id);
      return {
        ...base,
        lastActivityAt: last?.lastAt || t.updatedAt || t.createdAt,
        // A reply the client hasn't necessarily seen exists when the newest
        // message came from the team (not the client's own post).
        lastReplyFromTeam: last ? last.lastType === 'user' : false,
      };
    });

    return res.json({
      issues,
      context: {
        orgName: org?.name || '',
        companyName: company,
        contactName, // the client's Google display name
        clientName: company, // kept for backward compat
        categories: Array.isArray(board.portalCategories) ? board.portalCategories : [],
        announcement: board.portalAnnouncement || '',
        faqs: (Array.isArray(board.portalFaqs) ? board.portalFaqs : [])
          .filter((f) => f && (f.q || f.a))
          .map((f) => ({ q: f.q || '', a: f.a || '' })),
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

    // Request type + priority are optional and validated against fixed sets, so a
    // client can never inject an arbitrary value onto the team's board.
    const reqType = (req.body?.type || '').toString().trim().toLowerCase();
    const portalType = PORTAL_TYPES.includes(reqType) ? reqType : '';
    const reqPriority = (req.body?.priority || '').toString().trim().toLowerCase();
    const priority = PORTAL_PRIORITIES.includes(reqPriority) ? reqPriority : 'medium';

    // Optional "needed by" date the client sets → the task's due date. The date
    // picker greys out past days, but `min` on an input is a hint, not a
    // guarantee — a typed date or a direct POST walks straight through it — so
    // the floor is enforced here too, where it actually holds.
    let dueDate;
    const rawDue = (req.body?.dueDate || '').toString().trim();
    if (rawDue) {
      const d = new Date(rawDue);
      if (!Number.isNaN(d.getTime())) {
        if (d < earliestAllowedDueDate()) {
          return res.status(400).json({
            error: 'The date you need this by can’t be in the past.',
          });
        }
        dueDate = d;
      }
    }

    const last = await Task.findOne({ group: groupId }).sort({ order: -1 }).select('order');
    const order = (last?.order ?? -1) + 1;

    // Atomically claim the next human-friendly ticket number for this board.
    let portalRef = null;
    try {
      const bumped = await Board.findByIdAndUpdate(
        boardId,
        { $inc: { portalTicketSeq: 1 } },
        { new: true, select: 'portalTicketSeq' }
      );
      portalRef = bumped?.portalTicketSeq || null;
    } catch (seqErr) {
      console.error('createMyIssue seq error:', seqErr);
    }

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
      portalType,
      priority,
      portalRef,
      dueDate,
      createdBy: null,
    });

    // Record the client's action in the task Activity Log (best-effort).
    logActivity({
      task,
      actorType: 'client',
      actorLabel: req.portal.contact?.name || 'Client',
      type: 'client.request_created',
      metadata: { taskName: name },
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
 * Body field `context`: 'request' (attached while raising the issue) | 'thread'
 * (attached to a message). Both land in the task's one file drawer, so the
 * context is what later tells the request's own screenshots apart from files
 * sent weeks into the conversation — see utils/portalAttachments.js.
 * Anything unrecognised is treated as a thread file: mislabelling a file as part
 * of the original request is the more misleading of the two mistakes.
 *
 * Attach a file/screenshot to one of the contact's own issues.
 */
const uploadIssueAttachment = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const task = await loadOwnIssue(req, req.params.id);
    if (!task) return res.status(404).json({ error: 'Issue not found' });

    const context = (req.body?.context || '').toString().trim();
    const attachment = {
      url: req.file.path,
      name: req.file.originalname || '',
      mime: req.file.mimetype || '',
      size: req.file.size || 0,
      publicId: req.file.filename || '',
      uploadedBy: null,
      source: context === 'request' ? 'request' : 'thread',
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
        // Echoed back so that when the portal replays this attachment onto a
        // thread message, the Update's copy carries the Cloudinary id too —
        // without it, deleting that message leaves the asset stranded.
        publicId: saved.publicId,
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
 *
 * `visibility: { $ne: 'internal' }` is the whole enforcement of the team's
 * internal-notes thread. It is written as a NEGATION on purpose: updates created
 * before the field existed carry no `visibility` at all, so an inclusive
 * `{ visibility: 'shared' }` would empty every existing client thread. Any new
 * portal read of Update must repeat this clause.
 */
const getIssueThread = async (req, res) => {
  try {
    const task = await loadOwnIssue(req, req.params.id);
    if (!task) return res.status(404).json({ error: 'Issue not found' });

    const board = await Board.findById(task.board).select('statuses organisation');
    const updates = await Update.find({ task: task._id, visibility: { $ne: 'internal' } })
      .sort({ createdAt: 1 })
      .populate('author', 'name profilePic');
    const org = await Organisation.findById(req.portal.orgId).select('name');
    const orgName = org?.name || 'Support team';
    const myName = req.portal.contact?.name || 'You';

    const messages = updates.map((u) => {
      // 'system' events (status changes) render as a centered timeline chip.
      if (u.authorType === 'system') {
        return { id: String(u._id), system: true, bodyText: u.bodyText || '', createdAt: u.createdAt };
      }
      const mine = u.authorType === 'client';
      // Team replies show the actual team member who replied (falls back to the
      // org name for legacy posts with no stored author).
      const teamName = u.author?.name || orgName;
      return {
        id: String(u._id),
        mine,
        authorLabel: mine ? myName : teamName,
        authorTeam: mine ? '' : orgName,
        authorAvatar: mine ? '' : (u.author?.profilePic || ''),
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

    const cls = board ? classifyIssue(board, task.status) : { state: 'open', label: 'Open', color: '#B45309' };

    // Include the original request itself (its description + any files the client
    // attached when raising it) so the detail view can show it above the replies.
    // Only the files that came in WITH the request — the task's attachment array
    // also holds thread uploads and the team's own, and repeating those here made
    // the request block grow every time anyone attached anything.
    const requestAttachments = await loadRequestAttachments(task);

    return res.json({
      issue: {
        id: String(task._id),
        name: task.name,
        note: task.note || '',
        createdAt: task.createdAt,
        authorLabel: myName,
        state: cls.state,
        statusLabel: cls.label,
        statusColor: cls.color,
        resolved: cls.state === 'resolved',
        type: task.portalType || '',
        priority: task.priority || 'medium',
        rating: task.portalRating || null,
        attachments: requestAttachments.map((a) => ({
          url: a.url,
          name: a.name,
          mime: a.mime,
          size: a.size,
        })),
      },
      messages,
    });
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

    // Record the client's message in the task Activity Log (best-effort).
    logActivity({
      task,
      actorType: 'client',
      actorLabel: req.portal.contact?.name || 'Client',
      type: 'client.update_added',
      metadata: { updateSnippet: (bodyText || '').slice(0, 140) },
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
          tab: 'client',
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

/** Notify the whole team (filtered to board-readers downstream) about a client action. */
const notifyTeam = async ({ orgId, type, message, taskId, boardId, tab }) => {
  try {
    const org = await Organisation.findById(orgId).select('members');
    const memberIds = (org?.members || []).map((m) => String(m?._id || m));
    if (memberIds.length) {
      await createNotificationsForUsers({
        userIds: memberIds, type, message, taskId, orgId, actorId: null, boardId, tab,
      });
    }
  } catch (err) {
    console.error('notifyTeam error:', err);
  }
};

/**
 * POST /api/portal/me/issues/:id/reopen
 * Client reopens a resolved issue: bounce its status back to the board default
 * and drop a note in the thread so the team sees why it's back.
 */
const reopenIssue = async (req, res) => {
  try {
    const task = await loadOwnIssue(req, req.params.id);
    if (!task) return res.status(404).json({ error: 'Issue not found' });

    const board = await Board.findById(task.board).select('statuses organisation');
    if (!board) return res.status(404).json({ error: 'Board not found' });
    if (!isResolvedStatus(board, task.status)) {
      return res.status(400).json({ error: 'This request is already open.' });
    }

    // Reset to the board's default (isDefault) status, same rule as createMyIssue.
    let status = 'not_started';
    if (Array.isArray(board.statuses) && board.statuses.length > 0) {
      const fav = board.statuses.find((s) => s.isDefault);
      status = (fav || board.statuses[0])._id;
    }
    task.status = status;
    task.portalRating = null; // reopening invalidates any prior rating
    await task.save();

    const note = (req.body?.note || '').toString().trim().slice(0, 2000);
    await Update.create({
      task: task._id,
      authorType: 'client',
      portalAuthor: req.portal.contactId,
      author: null,
      bodyText: note || 'Reopened this request — it still needs attention.',
    });

    await notifyTeam({
      orgId: req.portal.orgId,
      type: 'clientReplied',
      message: `${clientLabel(req.portal.group)} reopened "${task.name}"`,
      taskId: task._id,
      boardId: task.board,
      tab: 'client',
    });

    return res.json({ issue: serializeIssue(task, board) });
  } catch (err) {
    console.error('reopenIssue error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/portal/me/issues/:id/rating   Body: { rating: 1..5 }
 * Client rates their satisfaction once an issue is resolved.
 */
const rateIssue = async (req, res) => {
  try {
    const task = await loadOwnIssue(req, req.params.id);
    if (!task) return res.status(404).json({ error: 'Issue not found' });

    const rating = Number(req.body?.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be between 1 and 5.' });
    }

    task.portalRating = rating;
    await task.save();

    await notifyTeam({
      orgId: req.portal.orgId,
      type: 'clientReplied',
      message: `${clientLabel(req.portal.group)} rated "${task.name}" ${rating}/5`,
      taskId: task._id,
      boardId: task.board,
    });

    return res.json({ rating });
  } catch (err) {
    console.error('rateIssue error:', err);
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

const adminPortalPayload = (group, board = null) => ({
  groupId: String(group._id),
  portalEnabled: !!group.portalEnabled,
  clientName: group.portalClientName || '',
  link: group.portalToken ? `${CLIENT_URL()}/portal/${group.portalToken}` : null,
  // Board-level portal content (shared by every group on the client board).
  announcement: board?.portalAnnouncement || '',
  faqs: (Array.isArray(board?.portalFaqs) ? board.portalFaqs : []).map((f) => ({
    q: f.q || '',
    a: f.a || '',
  })),
});

/** Sanitize FAQ input from the admin: keep only entries with real content. */
const cleanFaqs = (faqs) =>
  (Array.isArray(faqs) ? faqs : [])
    .map((f) => ({ q: (f?.q || '').toString().trim().slice(0, 300), a: (f?.a || '').toString().trim().slice(0, 2000) }))
    .filter((f) => f.q || f.a)
    .slice(0, 30);

/**
 * GET /api/portal/groups/:groupId/config  — current portal state for the modal.
 */
const getPortalConfig = async (req, res) => {
  try {
    const ctx = await loadManageContext(req.params.groupId, req.user.userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    return res.json({ portal: adminPortalPayload(ctx.group, ctx.board) });
  } catch (err) {
    console.error('getPortalConfig error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * PUT /api/portal/groups/:groupId/config
 * Body: { enabled?, clientName?, regenerateLink?, announcement?, faqs? }
 * Set the client label, enable/disable, rotate the link, or edit the board's
 * portal announcement + FAQ. The link itself is minted at group creation; this
 * only mints one lazily for legacy groups.
 */
const savePortalConfig = async (req, res) => {
  try {
    const ctx = await loadManageContext(req.params.groupId, req.user.userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    const { group, board } = ctx;
    const { enabled, clientName, regenerateLink, announcement, faqs } = req.body || {};

    if (typeof clientName === 'string') {
      group.portalClientName = clientName.trim();
    }

    // Mint a token the first time (legacy groups from before auto-mint), or on
    // explicit rotate. Rotating invalidates the old link and, via portalAuth's
    // ptk check, kills every live client session on this group.
    const needsToken = !group.portalToken;
    if (regenerateLink || needsToken) {
      group.portalToken = generatePortalToken();
    }

    if (typeof enabled === 'boolean') {
      group.portalEnabled = enabled;
    }

    // Board-level portal content (announcement banner + FAQ / knowledge base).
    let boardDirty = false;
    if (typeof announcement === 'string') {
      board.portalAnnouncement = announcement.trim().slice(0, 1000);
      boardDirty = true;
    }
    if (Array.isArray(faqs)) {
      board.portalFaqs = cleanFaqs(faqs);
      boardDirty = true;
    }

    await group.save();
    if (boardDirty) await board.save();
    return res.json({ portal: adminPortalPayload(group, board) });
  } catch (err) {
    console.error('savePortalConfig error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/** Never leak a hash or a live token to the team UI. */
const serializeContact = (contact) => ({
  id: String(contact._id),
  email: contact.email,
  name: contact.name || '',
  authMethod: contact.authMethod || 'google',
  hasPassword: !!contact.passwordHash,
  verified: !!contact.verified,
  invitedAt: contact.invitedAt || null,
  lastSeenAt: contact.lastSeenAt || null,
});

const listGroupContacts = (groupId) =>
  ClientContact.find({ group: groupId })
    .select('+passwordHash')
    .sort({ createdAt: 1 })
    .then((rows) => rows.map(serializeContact));

/**
 * POST /api/portal/groups/:groupId/invite   Body: { email, authMethod? }
 * Email (or re-email) the invitation to a client. Ensures the group has a live
 * link first, so this doubles as "turn the portal on and invite".
 *
 * `authMethod` is how this client signs in: 'google' (default) sends the shared
 * portal link, 'password' registers the address and sends a one-time link to
 * choose a password.
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
    const authMethod = req.body?.authMethod === 'password' ? 'password' : 'google';

    if (!group.portalToken) group.portalToken = generatePortalToken();
    if (!group.portalEnabled) group.portalEnabled = true;
    await group.save();

    const { ok } = await inviteContact({ group, board, email, authMethod });
    if (!ok) {
      return res
        .status(502)
        .json({ error: 'Could not send the invite email. Check the mail settings.' });
    }
    return res.json({
      message:
        authMethod === 'password'
          ? `Password set-up link sent to ${email}.`
          : `Invitation sent to ${email}.`,
      portal: adminPortalPayload(group, board),
      contacts: await listGroupContacts(group._id),
    });
  } catch (err) {
    console.error('sendPortalInvite error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * GET /api/portal/groups/:groupId/contacts
 * Who has been invited to this group's portal and how far they've got.
 */
const listPortalContacts = async (req, res) => {
  try {
    const ctx = await loadManageContext(req.params.groupId, req.user.userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    return res.json({ contacts: await listGroupContacts(ctx.group._id) });
  } catch (err) {
    console.error('listPortalContacts error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/portal/groups/:groupId/contacts/:contactId/resend
 * Re-send whatever this contact needs: the Google invite, a first set-password
 * link, or a reset link if they already have a password. One button, three
 * outcomes, so the team doesn't have to know which case they're in.
 */
const resendPortalInvite = async (req, res) => {
  try {
    const ctx = await loadManageContext(req.params.groupId, req.user.userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    const { group, board } = ctx;

    const existing = await ClientContact.findOne({
      _id: req.params.contactId,
      group: group._id,
    }).select('+passwordHash');
    if (!existing) return res.status(404).json({ error: 'Contact not found' });

    if (!group.portalToken) group.portalToken = generatePortalToken();
    if (!group.portalEnabled) group.portalEnabled = true;
    await group.save();

    const wasSet = !!existing.passwordHash;
    const { ok } = await inviteContact({
      group,
      board,
      email: existing.email,
      authMethod: existing.authMethod,
    });
    if (!ok) {
      return res
        .status(502)
        .json({ error: 'Could not send the email. Check the mail settings.' });
    }

    const what =
      existing.authMethod === 'password'
        ? wasSet
          ? 'Password reset link sent to'
          : 'Password set-up link sent to'
        : 'Invitation re-sent to';
    return res.json({
      message: `${what} ${existing.email}.`,
      contacts: await listGroupContacts(group._id),
    });
  } catch (err) {
    console.error('resendPortalInvite error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

module.exports = {
  // public
  getPortalMeta,
  portalGoogleCallback,
  portalPasswordLogin,
  portalRequestPasswordLink,
  portalCheckSetupToken,
  portalCompletePasswordSetup,
  // portal-authed
  getMyIssues,
  createMyIssue,
  uploadIssueAttachment,
  getIssueThread,
  postIssueThreadMessage,
  reopenIssue,
  rateIssue,
  // team admin
  getPortalConfig,
  savePortalConfig,
  sendPortalInvite,
  listPortalContacts,
  resendPortalInvite,
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
        taskId: String(task._id),
      });
    } catch (err) {
      console.error('sendPortalReplyEmailForTask error:', err);
    }
  },
};
