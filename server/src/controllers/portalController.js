const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const Board = require('../models/Board');
const TaskGroup = require('../models/TaskGroup');
const Task = require('../models/Task');
const Update = require('../models/Update');
const ClientContact = require('../models/ClientContact');
const ChannelContactRead = require('../models/ChannelContactRead');
const MailThreadRead = require('../models/MailThreadRead');
const PortalDigest = require('../models/PortalDigest');
const Organisation = require('../models/Organisation');
const { loadBoardContext, requireCapability } = require('../utils/boardContext');
const {
  inviteServiceContacts,
  createServiceWithInvites,
} = require('../services/portalBatchInvite');
const { boardHasServices } = require('../utils/portalActivation');
const { unreadByChannel } = require('../services/portalUnread');
const { resolveColors } = require('../services/serviceCatalogService');
const Channel = require('../models/Channel');
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
  sendInviteEmail,
  inviteContact,
  issueSetupToken,
  // The TTLs, so the forgot-password cooldown can date a token from its expiry
  // rather than storing an issued-at nobody else needs.
  SETUP_TTL_MS,
  RESET_TTL_MS,
} = require('../services/portalInviteService');
const {
  loadRequestAttachments,
  isClientVisibleAttachment,
} = require('../utils/portalAttachments');
const { destroyCloudinaryAssets } = require('../config/cloudinary');
const { portalTaskFilter, isTeamAuthoredIssue } = require('../utils/portalVisibility');
const { isClientBoard } = require('../utils/clientBoard');
const portalStream = require('../services/portalStream');

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

const clientLabel = (board) =>
  (board.portalClientName && board.portalClientName.trim()) || board.name;

/**
 * Resolve a public portal token to its live client board, or null.
 *
 * Every public endpoint needs the same three facts — the board exists, its link
 * is enabled, and it really is a client board — so they all go through here.
 * A disabled link and a nonexistent one are indistinguishable to the caller by
 * design.
 *
 * `+portalToken` because the field is `select: false`: callers mint session
 * JWTs from it (the `ptk` claim), which is the whole reason to load it.
 */
const loadPortalBoard = async (portalToken) => {
  if (!portalToken) return null;
  const board = await Board.findOne({ portalToken, portalEnabled: true }).select(
    '+portalToken name portalClientName boardType organisation statuses portalCategories'
  );
  if (!board || !isClientBoard(board)) return null;
  return { board };
};

/**
 * Mint the scoped portal session JWT for a signed-in client contact.
 *
 * No `groupId` claim: the portal is board-scoped, a contact sees every
 * workstream, and there is nothing left for a group id to narrow. Tokens minted
 * before the move still carry one and stay valid — `verifyPortalToken` ignores it.
 */
const signPortalToken = (contact, board) =>
  jwt.sign(
    {
      scope: 'portal',
      contactId: String(contact._id),
      boardId: String(board._id),
      orgId: contact.organisation ? String(contact.organisation) : null,
      email: contact.email,
      ptk: board.portalToken,
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

/**
 * THERE IS NO REQUEST-TYPE LIST ANY MORE, and no category list either.
 *
 * `PORTAL_TYPES` used to hold eight values, four of which — meta_ads,
 * google_ads, email_marketing, website_development — were SERVICE NAMES. They
 * existed because there was no service axis: the only way to say "this is about
 * Meta Ads" was to pick it as a type. There is one now. A client raising a
 * request is already inside a service, so asking "which service is this?" a
 * second time under a different label was asking them to answer twice and give
 * two answers that could disagree.
 *
 * The remaining four (bug / feature / requirement / question) went with them,
 * deliberately: a request is a title, some detail, a priority and a needed-by
 * date, inside a known service. Every extra field on an intake form is a
 * decision someone has to make before they can ask for help.
 *
 * `Board.portalCategories` is retired for the same reason and one more: the
 * board form no longer offers any way to SET it, so the dropdown could only ever
 * have been empty.
 *
 * `Task.portalType` and `Task.portalCategory` remain on the model, and
 * `serializeIssue` still reports them, so requests raised before this change
 * keep their badge. Nothing writes them any more.
 */
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

/**
 * @param {Object} task
 * @param {Object} board
 * @param {Map<string, {id, name}>} [workstreams] — group id → workstream, so a
 *   card can say which service line it belongs to. A task whose group was
 *   deleted still renders; it just has no workstream.
 */
const serializeIssue = (task, board, workstreams = null) => {
  const { state, label, color } = classifyIssue(board, task.status);
  return {
    id: String(task._id),
    ref: issueRef(task),
    // Which of this client's workstreams (SEO, Ads, Web Development) the
    // request belongs to. The portal groups and filters its list by this.
    workstream: (workstreams && workstreams.get(String(task.group))) || null,
    // Who put this on the client's list. A team-shared item is the team asking
    // something OF the client, which is the opposite of a support ticket — the
    // portal has to say so or the client reads their own to-do list as a log of
    // complaints they never made.
    fromTeam: isTeamAuthoredIssue(task),
    sharedAt: task.portalSharedAt || null,
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

/**
 * Turn the attachments a client REPLAYED onto a thread message into the real
 * ones, taken from that task's own file drawer.
 *
 * ---- NONE OF THE POSTED METADATA IS KEPT, AND THAT IS THE POINT ------------
 *
 * This used to copy `url`, `mime`, `size` and `publicId` straight out of the
 * request body. Both of those fields leave the portal and get acted on by the
 * team's side: `updateController` hands `publicId` to
 * `cloudinary.uploader.destroy()` when a team member edits or deletes the
 * message, and the team's app renders `url` as an `<img src>`. One Cloudinary
 * account serves the whole workspace, so a forged `publicId` names a real asset
 * belonging to another board — another CLIENT — and an ordinary tidy-up by the
 * team destroys it. A forged `url` points the team's browser wherever the client
 * chose, under a filename they also chose.
 *
 * So a client's entries are treated as REFERENCES, not as data: each is looked
 * up in `task.attachments` by the subdocument id `uploadIssueAttachment` handed
 * back, or by url (what an older bundle sends), and the STORED copy is what gets
 * persisted. An entry matching nothing is dropped silently — there is nothing
 * legitimate it could have been.
 *
 * Only files the client can actually see are eligible
 * (`isClientVisibleAttachment`), so the team's own Files-tab uploads on the same
 * task cannot be pulled into a client-visible message either.
 *
 * MAX_THREAD_ATTACHMENTS caps the array. Nothing bounded it before, and an
 * Update document is not the place to find that out.
 */
const MAX_THREAD_ATTACHMENTS = 10;

const cleanAttachments = (attachments, task) => {
  const drawer = Array.isArray(task?.attachments) ? task.attachments : [];
  const byId = new Map();
  const byUrl = new Map();
  drawer.forEach((a) => {
    if (!a || !isClientVisibleAttachment(a)) return;
    if (a._id) byId.set(String(a._id), a);
    if (a.url) byUrl.set(String(a.url), a);
  });

  const seen = new Set();
  const out = [];
  for (const posted of Array.isArray(attachments) ? attachments : []) {
    if (!posted) continue;
    const found =
      (posted.id && byId.get(String(posted.id))) ||
      (posted._id && byId.get(String(posted._id))) ||
      (typeof posted.url === 'string' && byUrl.get(posted.url)) ||
      null;
    if (!found) continue;
    const key = String(found._id || found.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      url: found.url,
      name: found.name || '',
      mime: found.mime || '',
      size: Number.isFinite(found.size) ? found.size : 0,
      publicId: found.publicId || '',
    });
    if (out.length >= MAX_THREAD_ATTACHMENTS) break;
  }
  return out;
};

// ============================================================================
// PUBLIC (no auth) — the client hasn't signed in yet.
// ============================================================================

/**
 * GET /api/portal/:portalToken
 * Public branding shown on the invitation landing page. No secrets.
 */
const getPortalMeta = async (req, res) => {
  try {
    const ctx = await loadPortalBoard(req.params.portalToken);
    if (!ctx) return res.status(404).json({ error: 'Portal not found' });

    const org = await Organisation.findById(ctx.board.organisation).select('name');

    return res.json({
      orgName: org?.name || '',
      clientName: clientLabel(ctx.board),
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
 * identity to `req.user`; the board being joined rode along in `req.query.state`
 * as its portalToken. We upsert the ClientContact for (board, email), mint the
 * scoped portal JWT, and hand it to the frontend via a redirect. NEVER creates
 * an app User. On any failure we bounce to the portal verify page with an error.
 */
const portalGoogleCallback = async (req, res) => {
  const fail = () => res.redirect(`${CLIENT_URL()}/portal/verify?error=1`);
  try {
    const profile = req.user; // { email, name, picture } from google-portal strategy
    const portalToken = (req.query?.state || '').toString();
    if (!profile?.email || !portalToken) return fail();

    const ctx = await loadPortalBoard(portalToken);
    if (!ctx) return fail();
    const { board } = ctx;

    const email = String(profile.email).toLowerCase();
    const contact = await ClientContact.findOneAndUpdate(
      { board: board._id, email },
      {
        $setOnInsert: {
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

    const token = signPortalToken(contact, board);
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
const loadContactBySetupToken = async (board, rawToken) => {
  if (!rawToken) return null;
  const contact = await ClientContact.findOne({
    board: board._id,
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
    const ctx = await loadPortalBoard(req.params.portalToken);
    if (!ctx) return res.status(404).json({ error: 'Portal not found' });

    const email = (req.body?.email || '').toString().trim().toLowerCase();
    const password = (req.body?.password || '').toString();
    if (!EMAIL_RE.test(email) || !password) {
      return res.status(400).json({ error: 'Enter your email address and password.' });
    }

    const contact = await ClientContact.findOne({ board: ctx.board._id, email }).select(
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

    return res.json({ token: signPortalToken(contact, ctx.board) });
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
 *
 * ---- THE IDENTICAL BODY WAS NOT ENOUGH ------------------------------------
 *
 * An unknown address used to return after one indexed `findOne` — milliseconds.
 * A known one wrote a document and then AWAITED a Gmail SMTP round trip —
 * seconds. Anyone holding the portal link (it is in every invitation email, so a
 * forwarded invite is enough) could read that difference off a stopwatch and
 * enumerate exactly who at the client has portal access. A failing send made it
 * cruder still: only a real contact ever reached the send, so its 500 named the
 * address outright.
 *
 * Both branches now return at the same moment — the token and the email happen
 * OFF the response path, and nothing only a real contact can reach is allowed to
 * change the status code. That is the property `portalPasswordLogin` buys with
 * `verifyDummyPassword`.
 *
 * ---- AND A PER-CONTACT COOLDOWN -------------------------------------------
 *
 * The route's IP limiter is the only other brake, and one accepted call both
 * mails the client and INVALIDATES the setup link they may already be holding.
 * So a contact whose one-time token was issued moments ago is left alone: same
 * QUIET answer, no second email. The issue time is derived from
 * `setupTokenExpires` minus the TTL for its purpose rather than stored — the
 * same two fields the token already needs.
 */
const RESEND_COOLDOWN_MS = 2 * 60 * 1000;

const setupTokenIsFresh = (contact) => {
  if (!contact?.setupTokenExpires) return false;
  const ttl = contact.setupTokenPurpose === 'reset' ? RESET_TTL_MS : SETUP_TTL_MS;
  const issuedAt = contact.setupTokenExpires.getTime() - ttl;
  return Date.now() - issuedAt < RESEND_COOLDOWN_MS;
};

const portalRequestPasswordLink = async (req, res) => {
  const QUIET = {
    message: "If that email has portal access, we've sent it a link. Check your inbox.",
  };
  try {
    const ctx = await loadPortalBoard(req.params.portalToken);
    if (!ctx) return res.status(404).json({ error: 'Portal not found' });

    const email = (req.body?.email || '').toString().trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    const contact = await ClientContact.findOne({ board: ctx.board._id, email }).select(
      '+passwordHash'
    );
    if (contact && contact.authMethod === 'password' && !setupTokenIsFresh(contact)) {
      const purpose = contact.passwordHash ? 'reset' : 'setup';
      // Deliberately NOT awaited — see the docblock. Every failure is logged
      // here and none of them reaches the response, which has already gone.
      issueSetupToken(contact, purpose)
        .then((raw) =>
          sendInviteEmail({
            board: ctx.board,
            email,
            authMethod: 'password',
            setupToken: raw,
            purpose,
          })
        )
        .catch((sendErr) =>
          console.error('portalRequestPasswordLink send error:', sendErr)
        );
    }

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
    const ctx = await loadPortalBoard(req.params.portalToken);
    if (!ctx) return res.status(404).json({ error: 'Portal not found' });

    const contact = await loadContactBySetupToken(ctx.board, req.params.token);
    if (!contact) return res.status(400).json({ error: EXPIRED_TOKEN });

    const org = await Organisation.findById(ctx.board.organisation).select('name');
    return res.json({
      email: contact.email,
      purpose: contact.setupTokenPurpose || 'setup',
      orgName: org?.name || '',
      clientName: clientLabel(ctx.board),
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
    const ctx = await loadPortalBoard(req.params.portalToken);
    if (!ctx) return res.status(404).json({ error: 'Portal not found' });

    const contact = await loadContactBySetupToken(ctx.board, req.params.token);
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

    return res.json({ token: signPortalToken(contact, ctx.board) });
  } catch (err) {
    console.error('portalCompletePasswordSetup error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

// ============================================================================
// PORTAL-AUTHED (req.portal set by middleware/portalAuth) — the client's own data.
// ============================================================================

/**
 * GET  /api/portal/me/preferences
 * PATCH /api/portal/me/preferences   Body: { notifyEmail?: boolean }
 *
 * The client's own switch for "email me when a message is waiting". Exists
 * because these emails go out over the team's Gmail, and a client who cannot
 * turn them off marks them as spam instead — a complaint against the sending
 * domain is a far more expensive outcome than a missed notification.
 *
 * Scoped to the contact in the TOKEN. There is no id in the URL, so one client
 * cannot reach another's preferences even on the same board.
 */
const getPortalPreferences = async (req, res) => {
  try {
    const contact = await ClientContact.findById(req.portal.contactId).select('notifyEmail');
    if (!contact) return res.status(404).json({ error: 'Not found' });
    return res.json({ notifyEmail: contact.notifyEmail !== false });
  } catch (err) {
    console.error('getPortalPreferences error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

const updatePortalPreferences = async (req, res) => {
  try {
    const patch = {};
    if (typeof req.body?.notifyEmail === 'boolean') patch.notifyEmail = req.body.notifyEmail;
    if (!Object.keys(patch).length) {
      return res.status(400).json({ error: 'Nothing to update.' });
    }
    const contact = await ClientContact.findByIdAndUpdate(
      req.portal.contactId,
      { $set: patch },
      { new: true }
    ).select('notifyEmail');
    if (!contact) return res.status(404).json({ error: 'Not found' });
    return res.json({ notifyEmail: contact.notifyEmail !== false });
  } catch (err) {
    console.error('updatePortalPreferences error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * GET /api/portal/me/home
 *
 * Everything the portal's SERVICE TABLE needs, in one call: who the client is,
 * who is signed in, and one row per service carrying its request counts, its
 * chat and mail unread, and when anything last happened on it.
 *
 * ---- WHY THIS IS NOT ASSEMBLED FROM THE TWO ENDPOINTS THAT EXIST -----------
 *
 * `getMyIssues` + `getPortalChannels` between them hold most of these numbers,
 * and using them would be wrong for one decisive reason: `getPortalChannels`
 * FILTERS OUT a group with no channel (`groups.filter(g => byGroup.has(...))`).
 * That is right for a channel list and fatal for a service table — a service the
 * client is paying for would silently vanish from their home screen the moment
 * its rooms were missing. This endpoint is authoritative about services and must
 * never inherit that filter: it lists EVERY group on the board, and reports
 * `channels: { chat: null, mail: null }` for one that has no rooms yet.
 *
 * ---- SIX ROUND TRIPS, NO N+1 -----------------------------------------------
 *
 *   1  board          5  requests + last activity, ONE grouped aggregate
 *   2  organisation   6  chat/mail unread, ONE aggregate (services/portalUnread)
 *   3  groups         +  colours resolved for every slug in ONE catalog query
 *   4  channels
 *
 * The `$match` reuses `portalTaskFilter` verbatim, including the throw that
 * refuses to build an unscoped filter, and the `$lookup` is served by Update's
 * existing `{ task, visibility, createdAt }` index — no new index. Step 5
 * returns one row per (service, status) rather than one per task, so nothing
 * here grows with the length of the client's history.
 *
 * Bucketing into open / in-progress / resolved happens in JS, NOT in Mongo.
 * `utils/doneStatus.js` owns what "resolved" means for a board, and re-encoding
 * that rule in an aggregation pipeline is precisely what that file's header
 * exists to prevent.
 */
const getPortalHome = async (req, res) => {
  try {
    const { contactId, boardId } = req.portal;

    const board = await Board.findById(boardId).select(
      'statuses portalCategories organisation portalAnnouncement portalFaqs name portalClientName portalToken'
    );
    if (!board) return res.status(404).json({ error: 'Board not found' });

    const [org, groups] = await Promise.all([
      Organisation.findById(board.organisation).select('name'),
      TaskGroup.find({ board: boardId })
        .select('name order serviceKey')
        .sort({ order: 1, createdAt: 1 })
        .lean(),
    ]);

    // ---- requests, per service, plus last activity ------------------------
    //
    // COUNTS COME BACK AS COUNTS. This used to fetch every task the contact can
    // see and tally them in JS, which on a board that has been running a year is
    // the client's entire shared history pulled over the wire to produce nine
    // numbers — and then every one of those ids fed into a second `$in`
    // aggregate. Both steps are one grouped pipeline now, whose result is
    // (services x statuses) rows, so the cost stops tracking that history.
    //
    // Bucketing into open / in-progress / resolved still happens in JS below,
    // for the reason in this handler's header: `utils/doneStatus.js` owns what
    // "resolved" means for a board and must not be re-encoded in a pipeline.
    //
    // The `$match` reuses `portalTaskFilter` verbatim — including the throw that
    // refuses an unscoped filter — but the two id fields are re-cast by hand:
    // `find()` casts a string id against the schema and `aggregate()` does NOT,
    // so handing the token's string board id straight to a pipeline matches
    // nothing and reports an empty portal.
    const toObjectId = (v) => new mongoose.Types.ObjectId(String(v));
    const taskMatch = {
      ...portalTaskFilter({ boardId, contactId }),
      board: toObjectId(boardId),
      $or: [{ portalSubmitter: toObjectId(contactId) }, { portalShared: true }],
    };

    const rows = await Task.aggregate([
      { $match: taskMatch },
      {
        // Newest client-visible message per task.
        $lookup: {
          from: Update.collection.name,
          let: { taskId: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ['$task', '$$taskId'] },
                // Written as a NEGATION on purpose: rows that predate the field
                // carry no `visibility` at all, so an inclusive match would
                // silently report every existing thread as empty.
                visibility: { $ne: 'internal' },
              },
            },
            { $group: { _id: null, lastAt: { $max: '$createdAt' } } },
          ],
          as: 'lastUpdate',
        },
      },
      {
        $group: {
          _id: { group: '$group', status: '$status' },
          count: { $sum: 1 },
          lastAt: {
            $max: {
              $ifNull: [
                { $arrayElemAt: ['$lastUpdate.lastAt', 0] },
                { $ifNull: ['$updatedAt', '$createdAt'] },
              ],
            },
          },
        },
      },
    ]);

    const perGroup = new Map();
    const bucketFor = (gid) => {
      const key = String(gid || '');
      if (!perGroup.has(key)) {
        perGroup.set(key, { open: 0, ongoing: 0, resolved: 0, total: 0, lastAt: null });
      }
      return perGroup.get(key);
    };
    for (const r of rows) {
      const b = bucketFor(r._id?.group);
      const { state } = classifyIssue(board, r._id?.status);
      b[state] += r.count;
      b.total += r.count;
      if (r.lastAt && (!b.lastAt || r.lastAt > b.lastAt)) b.lastAt = r.lastAt;
    }

    // ---- conversations, per service ---------------------------------------
    const channels = await Channel.find({
      board: boardId,
      audience: 'client',
      archived: false,
    })
      .select('_id group mode')
      .lean();

    const unreadMap = await unreadByChannel({
      channelIds: channels.map((c) => c._id),
      contactId,
    });

    const convByGroup = new Map();
    for (const ch of channels) {
      const key = String(ch.group || '');
      if (!convByGroup.has(key)) {
        convByGroup.set(key, { chat: null, mail: null, unread: { chat: 0, mail: 0 }, lastAt: null });
      }
      const slot = convByGroup.get(key);
      const mode = ch.mode === 'mail' ? 'mail' : 'chat';
      slot[mode] = String(ch._id);
      const u = unreadMap.get(String(ch._id));
      if (u) {
        // Mail is read one THREAD at a time, so its badge counts conversations,
        // not messages — otherwise the home screen and the mailbox disagree.
        slot.unread[mode] = mode === 'mail' ? u.unreadThreads : u.unread;
        if (u.lastAt && (!slot.lastAt || u.lastAt > slot.lastAt)) slot.lastAt = u.lastAt;
      }
    }

    // ---- one query for every colour on the page ---------------------------
    const colors = await resolveColors(
      board.organisation,
      groups.map((g) => g.serviceKey).filter(Boolean)
    );

    const services = groups.map((g) => {
      const key = String(g._id);
      const r = perGroup.get(key) || { open: 0, ongoing: 0, resolved: 0, total: 0, lastAt: null };
      const c = convByGroup.get(key) || {
        chat: null,
        mail: null,
        unread: { chat: 0, mail: 0 },
        lastAt: null,
      };
      const lastActivityAt =
        r.lastAt && c.lastAt ? (r.lastAt > c.lastAt ? r.lastAt : c.lastAt) : r.lastAt || c.lastAt;
      return {
        id: key,
        name: g.name,
        slug: g.serviceKey || null,
        color: g.serviceKey ? colors.get(g.serviceKey) || null : null,
        order: g.order || 0,
        channels: { chat: c.chat, mail: c.mail },
        requests: { open: r.open, ongoing: r.ongoing, resolved: r.resolved, total: r.total },
        unread: c.unread,
        lastActivityAt: lastActivityAt || null,
      };
    });

    // A request whose group was deleted has `group: null` and would otherwise be
    // unreachable under a per-service IA. Reported rather than hidden.
    const unfiled = perGroup.get('') || { open: 0, ongoing: 0, resolved: 0, total: 0 };

    const contact = req.portal.contact;
    const name = contact?.name || '';

    return res.json({
      contact: {
        // The contact id, which no portal payload has ever carried. Without it
        // the client keys its local read-state on "company|name", so two people
        // with the same name at one company share a browser bucket.
        id: String(contactId),
        name,
        firstName: (name || contact?.email || '').split(' ')[0] || '',
        email: contact?.email || req.portal.email || '',
      },
      company: { name: req.portal.clientName, orgName: org?.name || '' },
      portal: {
        linkToken: board.portalToken || null,
        announcement: board.portalAnnouncement || '',
        faqs: (Array.isArray(board.portalFaqs) ? board.portalFaqs : [])
          .filter((f) => f && (f.q || f.a))
          .map((f) => ({ q: f.q || '', a: f.a || '' })),
        categories: Array.isArray(board.portalCategories) ? board.portalCategories : [],
      },
      services,
      unfiled: { requests: unfiled },
      // Relative times computed against a client clock that is an hour out read
      // as nonsense. One field, and "12m ago" becomes trustworthy.
      serverTime: new Date().toISOString(),
    });
  } catch (err) {
    console.error('getPortalHome error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * GET /api/portal/me/issues[?service=<groupId>]
 * The signed-in contact's own issues + dashboard context (branding, categories).
 *
 * `?service=` narrows to one service, which is what makes the home screen's
 * counts clickable. The group is validated against the board FROM THE TOKEN —
 * the same check `createMyIssue` makes, and the only security property either
 * needs, since a contact may see every service on their own board but none on
 * anyone else's.
 *
 * ---- IT IS PAGED NOW ------------------------------------------------------
 *
 * This used to be `Task.find(filter).sort(...)` with no limit, no projection and
 * full hydration — every task the contact can see, notes, whole attachment
 * arrays and every custom field, and then every one of those ids into an `$in`
 * aggregate. On a client board with a year of shared work behind it the request
 * hit the portal's own 20s axios timeout, and there was no way to ask for less.
 *
 * `?limit=` (capped at MAX_ISSUE_PAGE) and `?before=` (a `createdAt` cursor,
 * matching the newest-first sort) page it. The default is deliberately generous
 * rather than small: the portal has no "load more" control yet, and a tight
 * default would silently hide requests from a client with no way to reveal them.
 * The response carries `page.nextCursor` for the day it grows one.
 */
const DEFAULT_ISSUE_PAGE = 100;
const MAX_ISSUE_PAGE = 200;

const getMyIssues = async (req, res) => {
  try {
    const { contactId, boardId } = req.portal;
    const board = await Board.findById(boardId)
      .select('statuses portalCategories organisation portalAnnouncement portalFaqs name portalClientName');
    if (!board) return res.status(404).json({ error: 'Board not found' });

    // Board-scoped: this board IS the client, and its groups are that client's
    // workstreams — they see all of them. Served by Task's existing
    // { board, createdAt } index, which the old group filter had none of.
    // Optional narrowing to one service. Validated against the board from the
    // TOKEN before it is trusted, exactly as createMyIssue validates a submitted
    // workstream — an id from another board must not select anything.
    const filter = portalTaskFilter({ boardId, contactId });
    const wantService = (req.query?.service || '').toString().trim();
    if (wantService) {
      const group = await TaskGroup.findOne({ _id: wantService, board: boardId })
        .select('_id')
        .lean()
        .catch(() => null);
      if (!group) return res.status(400).json({ error: 'Unknown service.' });
      filter.group = group._id;
    }

    const rawLimit = Number(req.query?.limit);
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(Math.trunc(rawLimit), MAX_ISSUE_PAGE)
        : DEFAULT_ISSUE_PAGE;
    // The cursor is the `createdAt` of the last row the caller already holds.
    // Ignored when it isn't a date rather than 400'd — a stale bookmarked query
    // string should show the first page, not an error.
    const before = new Date((req.query?.before || '').toString());
    if (!Number.isNaN(before.getTime())) filter.createdAt = { $lt: before };

    // One extra row, fetched purely to answer "is there more?" without a second
    // count query. It is dropped before anything is serialized.
    const page = await Task.find(filter)
      .select(
        'name note status priority dueDate createdAt updatedAt group portalRef portalType ' +
          'portalCategory portalRating portalShared portalSharedAt portalSubmitter attachments'
      )
      .sort({ createdAt: -1 })
      .limit(limit + 1)
      .lean();
    const hasMore = page.length > limit;
    const tasks = hasMore ? page.slice(0, limit) : page;

    const org = await Organisation.findById(board.organisation).select('name');

    // The client's workstreams, in the team's own group order — this drives
    // both the list's grouping and the new-request form's picker.
    const groups = await TaskGroup.find({ board: boardId })
      .select('name order')
      .sort({ order: 1, createdAt: 1 })
      .lean();
    const workstreams = groups.map((g) => ({ id: String(g._id), name: g.name }));
    const workstreamById = new Map(workstreams.map((w) => [w.id, w]));

    const company = req.portal.clientName;
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
      const base = serializeIssue(t, board, workstreamById);
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
      // Additive: a caller that only reads `issues` behaves exactly as before.
      page: {
        limit,
        hasMore,
        nextCursor: hasMore ? tasks[tasks.length - 1]?.createdAt || null : null,
      },
      context: {
        orgName: org?.name || '',
        companyName: company,
        contactName, // the client's Google display name
        clientName: company, // kept for backward compat
        categories: Array.isArray(board.portalCategories) ? board.portalCategories : [],
        // The client's service lines. Empty means the board has no groups yet,
        // and the portal must say so rather than offer an unusable form.
        workstreams,
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
 * POST /api/portal/me/issues
 *   Body: { name, workstream (group id), note?, category?, type?, priority?, dueDate? }
 *
 * Create a client issue as a real board Task. The BOARD comes from the JWT and
 * never from input. The WORKSTREAM does come from input — the client picks
 * which service line their request is for — so it is validated against that
 * board below. That validation is the whole security property here: a group id
 * accepted on trust would let a client file a task onto any board in any
 * workspace.
 *
 * Does NOT fire item.created automations (internal workflow).
 */
const createMyIssue = async (req, res) => {
  try {
    const { contactId, boardId } = req.portal;
    const name = (req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Please describe your issue.' });

    const board = await Board.findById(boardId).select('statuses portalCategories organisation');
    if (!board) return res.status(404).json({ error: 'Board not found' });

    // Which workstream this request belongs to. Scoped by `board: boardId` from
    // the token — never a board id from the body.
    const requestedGroup = (req.body?.workstream || req.body?.groupId || '').toString().trim();
    let groupId = null;
    if (requestedGroup) {
      // `.catch(() => null)` for the same reason getMyIssues has one: a
      // workstream id that isn't a valid ObjectId is a bad REQUEST, and letting
      // the CastError out turns it into a 500 the client can do nothing with.
      const group = await TaskGroup.findOne({ _id: requestedGroup, board: boardId })
        .select('_id')
        .catch(() => null);
      if (!group) {
        return res.status(400).json({ error: 'That workstream is not available.' });
      }
      groupId = group._id;
    } else {
      // A client with one workstream should not be made to choose it, and the
      // UI hides the picker in that case — so accept the omission only when
      // there is exactly one thing it could have meant.
      const groups = await TaskGroup.find({ board: boardId }).select('_id').limit(2).lean();
      if (groups.length === 1) {
        groupId = groups[0]._id;
      } else if (groups.length === 0) {
        return res
          .status(400)
          .json({ error: 'This portal is not set up yet. Please contact your account manager.' });
      } else {
        return res.status(400).json({ error: 'Please choose which workstream this is for.' });
      }
    }

    // Default status _id (the board's isDefault status), same rule as createTask.
    let status = 'not_started';
    if (Array.isArray(board.statuses) && board.statuses.length > 0) {
      const fav = board.statuses.find((s) => s.isDefault);
      status = (fav || board.statuses[0])._id;
    }

    // `type` and `category` are no longer accepted — see the note by
    // PORTAL_PRIORITIES. A client that still posts them is not an error; the
    // fields are simply ignored, which is what keeps an older cached bundle
    // working rather than 400ing on a field it was told to send.
    //
    // Priority IS still validated against a fixed set, so a client can never
    // inject an arbitrary value onto the team's board.
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
          message: `New client issue from ${req.portal.clientName}: "${name}"`,
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
 * Load an issue the signed-in contact is allowed to see — one they raised, or
 * one the team shared with their group (see utils/portalVisibility.js). Returns
 * the task or null; the caller 404s so we never confirm the existence of a task
 * outside that set.
 *
 * Every mutating portal endpoint funnels through here, which is what gives a
 * shared task the same rights as the client's own: reply, attach, reopen, rate.
 */
const loadVisibleIssue = async (req, taskId) => {
  // A malformed id is "no such issue", not a server fault. Without this the
  // CastError escapes into each caller's outer catch, every one of which answers
  // 500 "Server error" — so a mangled bookmark or a stale/empty id in page state
  // showed the client a red failure instead of "Issue not found".
  if (!taskId || !mongoose.isValidObjectId(taskId)) return null;
  const task = await Task.findOne({
    _id: taskId,
    ...portalTaskFilter(req.portal),
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
  // The route runs `updateUpload.single('file')` BEFORE this handler, so by the
  // time authorization is checked the file is already in Cloudinary and already
  // being paid for. Every early return that skips cleanup strands a paid asset
  // in the bucket with nothing referencing it — and nothing on the team's side
  // ever lists these, so they surface only on the bill. Mirrors
  // updateController's `discardUpload()`, for the same reason.
  const discardUpload = async () => {
    if (!req.file) return;
    try {
      await destroyCloudinaryAssets([
        {
          publicId: req.file.filename || req.file.public_id || '',
          mime: req.file.mimetype || '',
        },
      ]);
    } catch (cleanupErr) {
      console.error('uploadIssueAttachment cleanup error:', cleanupErr);
    }
  };

  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const task = await loadVisibleIssue(req, req.params.id);
    if (!task) {
      await discardUpload();
      return res.status(404).json({ error: 'Issue not found' });
    }

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
    // A save that failed leaves exactly the orphan a 404 would.
    await discardUpload();
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
    const task = await loadVisibleIssue(req, req.params.id);
    if (!task) return res.status(404).json({ error: 'Issue not found' });

    const board = await Board.findById(task.board).select('statuses organisation');
    const updates = await Update.find({ task: task._id, visibility: { $ne: 'internal' } })
      .sort({ createdAt: 1 })
      .populate('author', 'name profilePic')
      // The CLIENT-side author. A shared task is readable and postable by every
      // contact on the board (utils/portalVisibility.js), so "a client wrote
      // this" says nothing about WHICH client — see the mapping below.
      .populate('portalAuthor', 'name');
    const org = await Organisation.findById(req.portal.orgId).select('name');
    const orgName = org?.name || 'Support team';
    const myName = req.portal.contact?.name || 'You';

    const messages = updates.map((u) => {
      // 'system' events (status changes) render as a centered timeline chip.
      if (u.authorType === 'system') {
        return { id: String(u._id), system: true, bodyText: u.bodyText || '', createdAt: u.createdAt };
      }
      // WHICH client, not merely "a client". `authorType === 'client'` was being
      // used as `mine`, so on any board with two contacts — the ordinary case,
      // and the one the batch invite exists for — a colleague's reply rendered
      // on the right-hand side under the READER's own name, and the reader's own
      // replies were shown to their colleague as theirs. Identity is compared
      // against the signed-in contact instead; a post with no portalAuthor
      // (legacy rows) reads as a colleague, never as the reader.
      const isClient = u.authorType === 'client';
      const authorId = String(u.portalAuthor?._id || u.portalAuthor || '');
      const mine = isClient && authorId === String(req.portal.contactId);
      const clientName = u.portalAuthor?.name || 'A colleague';
      // Team replies show the actual team member who replied (falls back to the
      // org name for legacy posts with no stored author).
      const teamName = u.author?.name || orgName;
      return {
        id: String(u._id),
        mine,
        authorLabel: mine ? myName : isClient ? clientName : teamName,
        authorTeam: isClient ? '' : orgName,
        authorAvatar: isClient ? '' : u.author?.profilePic || '',
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
        // The opening block is the client's own words on a ticket they raised,
        // and the team's on one the team shared. Crediting a shared item to the
        // client would have them reading their own name over a request they are
        // being asked to answer.
        fromTeam: isTeamAuthoredIssue(task),
        sharedAt: task.portalSharedAt || null,
        authorLabel: isTeamAuthoredIssue(task) ? orgName : myName,
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
    const task = await loadVisibleIssue(req, req.params.id);
    if (!task) return res.status(404).json({ error: 'Issue not found' });

    const bodyText = (req.body?.bodyText || '').toString().trim();
    // Rebuilt from THIS task's drawer — see cleanAttachments. Nothing the client
    // posted about a file is stored.
    const attachments = cleanAttachments(req.body?.attachments, task);
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
          message: `${req.portal.clientName} replied on "${task.name}"`,
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
    const task = await loadVisibleIssue(req, req.params.id);
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
      message: `${req.portal.clientName} reopened "${task.name}"`,
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
 *
 * "Once resolved" is now ENFORCED, not just described. A score on a ticket
 * nobody has finished means nothing, and `reopenIssue` nulls a rating when the
 * request comes back — so a rating accepted early was quietly deleted later and
 * the team's satisfaction data lost rows without saying so. The precondition is
 * checked the same way reopenIssue checks its own.
 *
 * CHANGING a rating stays allowed and is SILENT. Re-submitting used to fan a
 * fresh `clientReplied` notification out to every board member, so one ticket
 * could put thirty rows in everyone's bell inside a minute — each a real
 * Notification document plus an email evaluation. The team is told once, when a
 * score first arrives.
 */
const rateIssue = async (req, res) => {
  try {
    const task = await loadVisibleIssue(req, req.params.id);
    if (!task) return res.status(404).json({ error: 'Issue not found' });

    const rating = Number(req.body?.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be between 1 and 5.' });
    }

    const board = await Board.findById(task.board).select('statuses');
    if (!board || !isResolvedStatus(board, task.status)) {
      return res
        .status(400)
        .json({ error: 'You can rate a request once it has been resolved.' });
    }

    const wasRated = task.portalRating != null;
    task.portalRating = rating;
    await task.save();

    if (!wasRated) {
      await notifyTeam({
        orgId: req.portal.orgId,
        type: 'clientReplied',
        message: `${req.portal.clientName} rated "${task.name}" ${rating}/5`,
        taskId: task._id,
        boardId: task.board,
      });
    }

    return res.json({ rating });
  } catch (err) {
    console.error('rateIssue error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

// ============================================================================
// TEAM ADMIN (req.user set by middleware/auth) — manage a client BOARD's portal:
// its link, its label, its people, and the services that bring it to life.
// Gated on board-manage: only the owner + full-access managers.
// ============================================================================

/**
 * Shared loader for the admin endpoints: verify this is a client board the
 * caller may MANAGE. Returns { board, org } or an { status, error }.
 *
 * Loads `+portalToken` because every caller either shows the link or mints one.
 * That projection is REQUIRED, not an optimisation: without it
 * `if (!board.portalToken)` is true on a board that HAS one, and every path
 * below that writes the token — the explicit rotate, the safety-net mint on the
 * invite endpoints, and `ensurePortalLive` inside the add-a-service flow —
 * would rotate a live client link and kill every signed-in contact's session.
 */
const loadManageContext = async (boardId, userId) => {
  const ctx = await loadBoardContext(boardId, userId, { select: '+portalToken' });
  if (ctx.error) return { status: ctx.status, error: ctx.error };
  if (!isClientBoard(ctx.board)) {
    return { status: 400, error: 'This board is not a client portal board' };
  }
  if (!ctx.access.canManageAccess) {
    return { status: 403, error: 'Only board managers can manage client links' };
  }
  // `ctx` as well, so a caller needing a SECOND capability (the batch invite
  // also restructures the board, so it wants `group.manage`) can ask without
  // reloading the board. Additive — every existing destructure still works.
  return { board: ctx.board, org: ctx.org, ctx };
};

/**
 * @param {object}   board
 * @param {boolean}  hasServices — does this board carry at least one service?
 *
 * `hasServices` is not decoration. A client board is created with NO portal
 * token and the portal off (see `utils/portalActivation.js`), so `link` is null
 * until the first service lands. The UI has to be able to tell "no link yet,
 * add a service" apart from "the link was switched off", and those two states
 * are `link: null, hasServices: false` and `portalEnabled: false` respectively.
 *
 * Every caller must pass it rather than let it default, because the honest
 * answer costs one indexed count and a guess costs the client a dead link.
 */
const adminPortalPayload = (board, hasServices) => ({
  boardId: String(board._id),
  portalEnabled: !!board.portalEnabled,
  clientName: board.portalClientName || '',
  link: board.portalToken ? `${CLIENT_URL()}/portal/${board.portalToken}` : null,
  hasServices: !!hasServices,
  announcement: board.portalAnnouncement || '',
  faqs: (Array.isArray(board.portalFaqs) ? board.portalFaqs : []).map((f) => ({
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
 * GET /api/portal/boards/:boardId/config  — current portal state for the modal.
 */
const getPortalConfig = async (req, res) => {
  try {
    const ctx = await loadManageContext(req.params.boardId, req.user.userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    return res.json({
      portal: adminPortalPayload(ctx.board, await boardHasServices(TaskGroup, ctx.board._id)),
    });
  } catch (err) {
    console.error('getPortalConfig error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * PUT /api/portal/boards/:boardId/config
 * Body: { enabled?, clientName?, regenerateLink?, announcement?, faqs? }
 * Set the client label, enable/disable, rotate the link, or edit the portal
 * announcement + FAQ.
 *
 * ---- IT WILL NOT CONJURE A LINK OUT OF A BOARD WITH NO SERVICES -----------
 *
 * This used to mint one lazily whenever `portalToken` was missing. Now that a
 * client board is deliberately created WITHOUT a token
 * (`utils/portalActivation.js`), that branch would fire on the very first save
 * — renaming the client, say — and hand back a live link to an empty portal,
 * which is the whole thing this change removes. So minting and enabling are
 * both refused until the board carries at least one service; adding one is what
 * turns the portal on.
 */
const savePortalConfig = async (req, res) => {
  try {
    const ctx = await loadManageContext(req.params.boardId, req.user.userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    const { board } = ctx;
    const { enabled, clientName, regenerateLink, announcement, faqs } = req.body || {};

    const hasServices = await boardHasServices(TaskGroup, board._id);

    // Asking to rotate or switch ON a portal that has nothing in it is a
    // mistake worth naming rather than quietly granting. Everything else on
    // this endpoint — the client label, the announcement, the FAQ, and
    // switching a live portal OFF — stays available on an empty board.
    if ((regenerateLink || enabled === true) && !hasServices) {
      return res.status(409).json({
        error:
          'Add a service to this board first. Until then the portal has nothing in it, and its link would open on an empty page.',
        code: 'PORTAL_NO_SERVICES',
      });
    }

    if (typeof clientName === 'string') {
      board.portalClientName = clientName.trim();
    }

    // Rotate on explicit request. Rotating invalidates the old link and, via
    // portalAuth's ptk check, kills every live client session on this board.
    //
    // `loadManageContext` selected `+portalToken`, which is what makes
    // `!board.portalToken` mean what it says. Loaded without it this branch
    // would fire on EVERY save and silently rotate a working client link.
    //
    // THE LAZY MINT IS GONE. A missing token now means "no service has been
    // added yet", which is a state to report, not one to fix behind the user's
    // back — see the docblock. The guard above is what makes that safe: by here
    // a rotate implies the board has services, and a board with services was
    // given its token when the first one landed.
    const rotated = Boolean(regenerateLink) && !!board.portalToken;
    if (regenerateLink) {
      board.portalToken = generatePortalToken();
    }

    const wasEnabled = board.portalEnabled;
    if (typeof enabled === 'boolean') {
      board.portalEnabled = enabled;
    }
    const disabled = wasEnabled && board.portalEnabled === false;

    if (typeof announcement === 'string') {
      board.portalAnnouncement = announcement.trim().slice(0, 1000);
    }
    if (Array.isArray(faqs)) {
      board.portalFaqs = cleanFaqs(faqs);
    }

    await board.save();

    // Close any live SSE stream on this board when the link is rotated or the
    // portal switched off.
    //
    // The `ptk` check in portalAuth already kills a client's session on their
    // next REQUEST — but a stream makes no requests. It is one socket opened
    // once, and without this a client whose access was just revoked keeps
    // receiving every message posted in their rooms for as long as they leave
    // the tab open. "Disable" has to mean now, not next time they click.
    if (rotated || disabled) {
      try {
        portalStream.dropBoard(board._id);
      } catch (streamErr) {
        // Best-effort: the credential change has already landed, which is the
        // part that matters. A socket we failed to close still dies on its own
        // heartbeat or on the client's next navigation.
      }
    }

    return res.json({ portal: adminPortalPayload(board, hasServices) });
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
  /**
   * The services this person was invited on - chips in the team's roster, so
   * "Asha - SEO, Meta Ads" survives the moment the invite table was submitted.
   *
   * LABELLING ONLY. It grants nothing: every contact on a client board can see
   * every service on it. See the field comment on ClientContact.services.
   *
   * A populated entry that came back null is SKIPPED rather than throwing -
   * losing one chip beats failing the whole roster read because a group was
   * deleted in a way that missed the $pull in groupController.deleteGroup.
   */
  services: (contact.services || [])
    .filter((g) => g && g.name)
    .map((g) => ({ id: String(g._id), name: g.name, serviceKey: g.serviceKey || null })),
});

const listBoardContacts = (boardId) =>
  ClientContact.find({ board: boardId })
    .select('+passwordHash')
    .populate('services', 'name serviceKey')
    .sort({ createdAt: 1 })
    .then((rows) => rows.map(serializeContact));

/**
 * POST /api/portal/boards/:boardId/invites
 * Body: `{ rows: [{ service, email, authMethod?, color? }], notify? }`
 *
 * THE BATCH INVITE. Several people, several services, one submission — the
 * shape an agency actually works in, where Meta Ads, Google Ads, SEO and web
 * development each have a different manager at the client and some of them are
 * the same person twice.
 *
 * N rows become N services (groups) on the board, each with its client chat,
 * client mailbox and private team room; and ONE email per unique address,
 * naming every service that person manages. The dedupe rule and the phase
 * ordering live in services/portalBatchInvite.js.
 *
 * ---- TWO CAPABILITIES, NOT ONE --------------------------------------------
 *
 * `canManageAccess` (via loadManageContext) because this hands out portal
 * access, AND `group.manage` because it also RESTRUCTURES THE BOARD. Either one
 * alone would let someone do half of something they were not trusted with, and
 * the second gate costs a line because loadManageContext now returns its ctx.
 *
 * Plural route, not a variant of `/invite`: this is a different resource that
 * happens to send mail, and folding it into the singular endpoint would put a
 * 25-row body behind a limiter sized for one address.
 */
const sendPortalInviteBatch = async (req, res) => {
  try {
    const mc = await loadManageContext(req.params.boardId, req.user.userId);
    if (mc.error) return res.status(mc.status).json({ error: mc.error });

    const denied = requireCapability(
      mc.ctx,
      'group.manage',
      'You do not have permission to add services to this board'
    );
    if (denied) return res.status(denied.status).json({ error: denied.error });

    const result = await inviteServiceContacts({
      board: mc.board,
      orgName: mc.org?.name || '',
      actorId: req.user.userId,
      rows: req.body?.rows,
      notify: req.body?.notify !== false,
    });

    if (!result.ok) {
      return res.status(result.status || 400).json({
        errors: result.errors,
        error: result.errors?.[0]?.message || 'Could not send those invitations.',
        ...(result.code ? { code: result.code } : {}),
      });
    }

    return res.json({
      // It created at least one service, so by construction the board now has
      // one and its portal is live.
      portal: adminPortalPayload(mc.board, true),
      services: result.services,
      contacts: result.contacts,
      // Index-aligned with the request, so the UI can mark each table row.
      rows: result.rows,
      warnings: result.warnings,
      roster: await listBoardContacts(mc.board._id),
    });
  } catch (err) {
    console.error('sendPortalInviteBatch error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/portal/boards/:boardId/invite   Body: { email, authMethod? }
 * Email (or re-email) the invitation to a client — one address, no service.
 *
 * `authMethod` is how this client signs in: 'google' (default) sends the shared
 * portal link, 'password' registers the address and sends a one-time link to
 * choose a password.
 *
 * ---- IT NO LONGER DOUBLES AS "TURN THE PORTAL ON AND INVITE" --------------
 *
 * It used to mint the token and flip `portalEnabled` itself, which made it a
 * way to email a client the link to a board with nothing on it. Adding a
 * SERVICE is the only thing that brings a portal to life now
 * (`utils/portalActivation.js`), so this refuses on a board that has none and
 * says what to do instead. Every other invite path either creates a service as
 * part of its work (the batch, add-a-service) or is a re-send to somebody
 * already on a live board.
 */
const sendPortalInvite = async (req, res) => {
  try {
    const ctx = await loadManageContext(req.params.boardId, req.user.userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    const { board } = ctx;

    const email = (req.body?.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    const authMethod = req.body?.authMethod === 'password' ? 'password' : 'google';

    if (!(await boardHasServices(TaskGroup, board._id))) {
      return res.status(409).json({
        error:
          'Add a service to this board before inviting anyone. Until then the invitation would open on an empty portal.',
        code: 'PORTAL_NO_SERVICES',
      });
    }
    // A board with services was given its token when the first one landed, so
    // this is a safety net for a board that predates that rule rather than the
    // ordinary path.
    if (!board.portalToken) {
      board.portalToken = generatePortalToken();
      await board.save();
    }
    // ENABLING IS REFUSED, NOT DONE SILENTLY. This used to flip `portalEnabled`
    // itself, so sending mail quietly undid a deliberate "Disable link" — the
    // one control the team has for cutting a client off. Simply dropping that
    // and carrying on would be worse in the other direction: the email would go
    // out carrying a link `loadPortalBoard` refuses, and the client would be
    // told to visit a page that does not load. So say so, and let the toggle in
    // portal settings be the only thing that turns a portal back on.
    if (!board.portalEnabled) {
      return res.status(409).json({
        error:
          "This board's client link is switched off, so the invitation would not open. Turn it back on in portal settings first.",
        code: 'PORTAL_DISABLED',
      });
    }

    const { ok } = await inviteContact({ board, email, authMethod });
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
      portal: adminPortalPayload(board, true),
      contacts: await listBoardContacts(board._id),
    });
  } catch (err) {
    console.error('sendPortalInvite error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/portal/boards/:boardId/services
 * Body: `{ name, color?, invites?: [{ email, authMethod? }], notify? }`
 *
 * ADD ONE SERVICE, AND TELL THE PEOPLE WHO CARE ABOUT IT. This is the endpoint
 * behind "Add service" on a client board, and it is where a client portal comes
 * into existence.
 *
 * ---- WHY THIS EXISTS RATHER THAN AN `invites` FIELD ON createGroup --------
 *
 * A PERMISSION BOUNDARY. `POST /api/boards/:boardId/groups` is gated on
 * `group.manage` alone, because restructuring a board's groups is one power.
 * Handing a stranger access to a client's portal is a DIFFERENT power, gated on
 * `canManageAccess`. Letting `createGroup` accept invitations would hand every
 * `group.manage` holder the second capability along with the first, silently.
 *
 * So the split is: `createGroup` still creates a service and still brings the
 * portal to life (a link nobody has been given is not access), and THIS
 * endpoint — holding both gates, exactly as the batch invite does — is the only
 * one that can also email somebody.
 *
 * ---- WHY NOT JUST USE THE BATCH -------------------------------------------
 *
 * `POST .../invites` reuses a service the board already has, because a row
 * reading `SEO / asha@acme.com` on a board with an SEO service is the ordinary
 * second-invite case. "Add service" means a NEW one, and a name already on the
 * board is a mistake worth a 409 — the policy `createGroup` has always had, and
 * the reason `resolveGroupName` reports a collision instead of refusing one.
 *
 * `invites` may be EMPTY. Adding a service before anyone knows who at the
 * client will look after it is normal, and so is adding a second service for a
 * client whose people are already invited. The service is created and the
 * portal goes live either way; only the mail is conditional.
 */
const createPortalService = async (req, res) => {
  try {
    const mc = await loadManageContext(req.params.boardId, req.user.userId);
    if (mc.error) return res.status(mc.status).json({ error: mc.error });

    // Both gates, for the reason in the docblock above. Either one alone would
    // let someone do half of something they were not trusted with.
    const denied = requireCapability(
      mc.ctx,
      'group.manage',
      'You do not have permission to add services to this board'
    );
    if (denied) return res.status(denied.status).json({ error: denied.error });

    const result = await createServiceWithInvites({
      board: mc.board,
      orgName: mc.org?.name || '',
      actorId: req.user.userId,
      name: req.body?.name,
      color: typeof req.body?.color === 'string' ? req.body.color : null,
      invites: req.body?.invites,
      notify: req.body?.notify !== false,
    });

    if (!result.ok) {
      return res.status(result.status || 400).json({
        errors: result.errors,
        // The first message, so a caller that only renders `error` still says
        // something true. Every other endpoint here answers in that shape.
        error: result.errors?.[0]?.message || 'Could not add that service.',
        // Forwarded so the UI can match on the reason rather than on the
        // sentence, as it does for PORTAL_NO_SERVICES.
        ...(result.code ? { code: result.code } : {}),
      });
    }

    return res.status(201).json({
      service: result.service,
      contacts: result.contacts,
      warnings: result.warnings,
      // True exactly once per board — the service that brought the portal to
      // life. The UI tells the team their client link is now live, once.
      portalActivated: result.portalActivated,
      // Whether the link opens AT ALL right now. False on a board whose portal
      // the team switched off: the service was created, but nothing about the
      // client's access changed and the UI must not say otherwise.
      portalLive: result.portalLive,
      portal: adminPortalPayload(mc.board, true),
      roster: await listBoardContacts(mc.board._id),
    });
  } catch (err) {
    console.error('createPortalService error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * GET /api/portal/boards/:boardId/contacts
 * Who has been invited to this client's portal and how far they've got.
 */
const listPortalContacts = async (req, res) => {
  try {
    const ctx = await loadManageContext(req.params.boardId, req.user.userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    return res.json({ contacts: await listBoardContacts(ctx.board._id) });
  } catch (err) {
    console.error('listPortalContacts error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/portal/boards/:boardId/contacts/:contactId/resend
 * Re-send whatever this contact needs: the Google invite, a first set-password
 * link, or a reset link if they already have a password. One button, three
 * outcomes, so the team doesn't have to know which case they're in.
 */
const resendPortalInvite = async (req, res) => {
  try {
    const ctx = await loadManageContext(req.params.boardId, req.user.userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    const { board } = ctx;

    const existing = await ClientContact.findOne({
      _id: req.params.contactId,
      board: board._id,
    }).select('+passwordHash');
    if (!existing) return res.status(404).json({ error: 'Contact not found' });

    if (!(await boardHasServices(TaskGroup, board._id))) {
      return res.status(409).json({
        error:
          'This board has no services yet, so there is nothing to send anyone to. Add one first.',
        code: 'PORTAL_NO_SERVICES',
      });
    }
    // Mint only, and only as a safety net for a board that predates the
    // activation rule.
    if (!board.portalToken) {
      board.portalToken = generatePortalToken();
      await board.save();
    }
    // Same refusal as `sendPortalInvite`, for the same two reasons: forcing
    // `portalEnabled` true here silently undid a deliberate "Disable link", and
    // omitting the force without saying anything would mail a link that does
    // not open. See that handler.
    if (!board.portalEnabled) {
      return res.status(409).json({
        error:
          "This board's client link is switched off, so the email would not open. Turn it back on in portal settings first.",
        code: 'PORTAL_DISABLED',
      });
    }

    const wasSet = !!existing.passwordHash;
    const { ok } = await inviteContact({
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
      contacts: await listBoardContacts(board._id),
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
  getPortalHome,
  getPortalPreferences,
  updatePortalPreferences,
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
  sendPortalInviteBatch,
  createPortalService,
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
