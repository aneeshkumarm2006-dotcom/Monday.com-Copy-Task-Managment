const ClientContact = require('../models/ClientContact');
const TaskGroup = require('../models/TaskGroup');
const { resolveGroupName } = require('../controllers/groupController');
const { logGroupCreated } = require('./groupActivity');
const { createSurfaces } = require('./workstreamSurfaces');
const { recordServiceUse } = require('./serviceCatalogService');
const { issueSetupToken, sendInviteEmail } = require('./portalInviteService');
const { ensurePortalLive } = require('../utils/portalActivation');
const { normaliseServiceName, serviceSlug } = require('../utils/serviceCatalog');
const eventBus = require('./eventBus');

/**
 * THE BATCH INVITE — several people, several services, one submission.
 *
 * The shape this exists for: an agency runs Meta Ads, Google Ads, SEO and web
 * development for one client, and on the client side each discipline has a
 * different manager. The team types a table —
 *
 *     SEO              asha@acme.com
 *     Meta Ads         asha@acme.com
 *     Google Ads       raj@acme.com
 *     Web Development  asha@acme.com
 *
 * — and those four rows must become FOUR services on the board and TWO emails:
 * one to Asha naming her three, one to Raj naming his one. Four different
 * addresses would have meant four emails. That collapse is the whole feature,
 * and `planInvites` below is where it happens.
 *
 * ---- WHY THIS IS ORDERED AND IDEMPOTENT RATHER THAN ATOMIC ----------------
 *
 * There are no transactions available. `services/connectors/budget.js` records
 * the house position: `config/db.js` connects with a bare URI and does not
 * require a replica set, so `session.withTransaction` cannot be assumed to exist
 * at runtime — and there are no `startSession` call sites anywhere in the
 * server. So the guarantee on offer is not all-or-nothing, it is:
 *
 *   phase 2  groups    idempotent by name, via resolveGroupName
 *   phase 3  catalog   idempotent by the (organisation, slug) unique index
 *   phase 4  surfaces  idempotent by (board, group, mode, audience) unique index
 *   phase 5  contacts  idempotent by (board, email) + $addToSet
 *   phase 6  email     the ONLY non-idempotent step, and therefore LAST
 *
 * Re-submitting an identical batch converges on the same state; only the emails
 * repeat. That ordering is the point: the expensive-to-undo work is the work
 * that can safely be repeated.
 *
 * If groups are created and the mail then fails, NOTHING IS ROLLED BACK. A
 * service the team asked for is a service they want, and un-creating it would
 * destroy the surfaces just minted inside it along with anything raced into
 * them. The response says `emailSent: false` with the reason, and the team
 * resends from the roster — which is exactly what the per-contact resend
 * endpoint is for.
 */

/** No board needs more than this in one go, and it bounds every loop below. */
const MAX_ROWS = 25;

/**
 * The cap for ONE service's invite list, which is deliberately lower than
 * MAX_ROWS.
 *
 * It is a mail budget, not a UI limit. `routes/portal.js` allows 6 requests a
 * minute to `POST /boards/:id/services` because adding several services during
 * setup is ordinary; 6 x 10 = 60 emails a minute, under the same 75-email
 * ceiling `inviteBatchLimit` (3 x MAX_ROWS) was sized to hold one team's Gmail
 * account to. Raising either number without the other moves that ceiling.
 *
 * Ten people on one service is already far past what an agency has; the bulk
 * table on the People tab is where a genuinely large roster goes.
 */
const MAX_SERVICE_INVITES = 10;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const AUTH_METHODS = ['google', 'password'];

/**
 * Validate, normalise and DEDUPE a table of `{ service, email, authMethod }`.
 *
 * Pure — no database, no network. That is deliberate: the dedupe rule IS the
 * feature, and this is the half of it `npm test` can reach without a mongod
 * (see portalBatchInvite.test.js).
 *
 * VALIDATION IS ALL-OR-NOTHING. The caller is a table the user is still editing;
 * half-applying it would leave them unable to tell which rows landed, and
 * re-submitting the corrected table would then double the rows that did. WRITES,
 * by contrast, are per-row best-effort — see `inviteServiceContacts`.
 *
 * @returns {{
 *   ok: boolean,
 *   errors: Array<{index: number|null, field: string, message: string}>,
 *   services: Array<{name: string, slug: string, color: string|null, rowIndexes: number[]}>,
 *   contacts: Array<{email: string, authMethod: string, slugs: string[], rowIndexes: number[]}>,
 *   warnings: string[],
 * }}
 */
const planInvites = (rows) => {
  const errors = [];
  const warnings = [];

  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      ok: false,
      errors: [{ index: null, field: 'rows', message: 'Add at least one row.' }],
      services: [],
      contacts: [],
      warnings,
    };
  }
  if (rows.length > MAX_ROWS) {
    return {
      ok: false,
      errors: [
        { index: null, field: 'rows', message: 'Too many rows - ' + MAX_ROWS + ' at a time.' },
      ],
      services: [],
      contacts: [],
      warnings,
    };
  }

  // Insertion-ordered, so services land on the board in the order they were
  // typed and the invitation email lists them the same way.
  const services = new Map(); // slug -> { name, slug, color, rowIndexes }
  const contacts = new Map(); // email -> { email, authMethod, slugs, rowIndexes }

  rows.forEach((raw, index) => {
    const row = raw || {};

    const email = String(row.email || '').trim().toLowerCase();
    if (!email) {
      errors.push({ index, field: 'email', message: 'Email is required.' });
    } else if (!EMAIL_RE.test(email)) {
      errors.push({ index, field: 'email', message: 'That is not an email address.' });
    }

    const name = normaliseServiceName(row.service);
    const slug = serviceSlug(row.service);
    if (!name || !slug) {
      errors.push({ index, field: 'service', message: 'Service is required.' });
    }

    let authMethod = row.authMethod == null ? 'google' : String(row.authMethod);
    if (!AUTH_METHODS.includes(authMethod)) {
      errors.push({ index, field: 'authMethod', message: 'That is not a sign-in method.' });
      authMethod = 'google';
    }

    if (!email || !slug) return;

    // ---- service dedupe: FIRST CASING WINS --------------------------------
    // "SEO" then "seo" is one service, keeping the spelling of whoever typed it
    // first — so one person's hurried lowercase cannot restyle a service that
    // everyone else already reads a particular way.
    if (services.has(slug)) {
      services.get(slug).rowIndexes.push(index);
    } else {
      services.set(slug, {
        name,
        slug,
        color: typeof row.color === 'string' && row.color.trim() ? row.color.trim() : null,
        rowIndexes: [index],
      });
    }

    // ---- contact dedupe: ONE ADDRESS, ONE PERSON, ONE EMAIL ---------------
    if (contacts.has(email)) {
      const c = contacts.get(email);
      c.rowIndexes.push(index);
      if (!c.slugs.includes(slug)) c.slugs.push(slug);
      // PASSWORD WINS on a conflict. Someone whose address is not a Google
      // account needs a password regardless of which row happened to ask for
      // one, and the opposite default would send them a link they cannot use.
      if (authMethod === 'password' && c.authMethod !== 'password') {
        c.authMethod = 'password';
        c.mixedAuth = true;
      } else if (authMethod === 'google' && c.authMethod === 'password') {
        c.mixedAuth = true;
      }
    } else {
      contacts.set(email, {
        email,
        authMethod,
        slugs: [slug],
        rowIndexes: [index],
        mixedAuth: false,
      });
    }
  });

  for (const c of contacts.values()) {
    if (c.mixedAuth) {
      warnings.push(
        c.email +
          ' appears with more than one sign-in method - invited with a password, because one of their rows asked for one.'
      );
    }
    delete c.mixedAuth;
  }

  return {
    ok: errors.length === 0,
    errors,
    services: [...services.values()],
    contacts: [...contacts.values()],
    warnings,
  };
};

/**
 * A board whose client link was deliberately switched OFF may not be emailed
 * into. Shared by both flows below so the sentence and the code exist once.
 *
 * `board.portalToken` is what separates the two meanings of
 * `portalEnabled: false`: with no token the board has simply never been live
 * and adding a service is what brings it up; with one, somebody pressed
 * "Disable link" and `sendPortalInvite` already refuses for the same reason.
 * See `utils/portalActivation.js`.
 *
 * @returns a refusal object, or null when there is nothing to refuse.
 */
const refusalIfPortalDisabled = (board) => {
  if (!board.portalToken || board.portalEnabled === true) return null;
  return {
    ok: false,
    status: 409,
    code: 'PORTAL_DISABLED',
    errors: [
      {
        index: null,
        field: null,
        message:
          "This board's client link is switched off, so the invitation would not open. Turn it back on in portal settings first.",
      },
    ],
  };
};

/**
 * PHASE 1 — THE PORTAL BECOMES REACHABLE.
 *
 * Lives in `utils/portalActivation.js`, not here: `groupController.createGroup`
 * needs the same rule and this file already requires that controller, so a
 * definition here would close a require cycle. Read that file for why a client
 * board is no longer born with a link at all.
 */

/**
 * PHASE 2 — resolve or create ONE service group.
 *
 * `reuseExisting` is the policy switch `resolveGroupName` was split apart for:
 * the batch invite reuses a service the board already has (a row reading
 * `SEO / asha@acme.com` on a board with an SEO service is the ordinary
 * second-invite case), while "add a service" means a NEW one and must report
 * the collision so its caller can 409.
 *
 * Sequential by contract: `order` is a countDocuments and has to see the
 * previous insert, or two new services collide on one position. Never call this
 * concurrently for the same board.
 */
const resolveOrCreateService = async ({ board, service, actorId, reuseExisting = true }) => {
  const resolved = await resolveGroupName(service.name, board._id);
  if (resolved.error) return { service, error: resolved.error };

  if (resolved.duplicate) {
    if (!reuseExisting) return { service, duplicate: resolved.duplicate };
    return { service, group: resolved.duplicate, created: false };
  }

  const order = await TaskGroup.countDocuments({ board: board._id });
  let group;
  try {
    group = await TaskGroup.create({
      name: resolved.name,
      board: board._id,
      order,
      createdBy: actorId,
      serviceKey: service.slug,
    });
  } catch (err) {
    // There is no unique index on (board, name), so this is a duplicate by
    // TIMING - two submissions at once. Read back the winner.
    const raced = await TaskGroup.findOne({ board: board._id, name: resolved.name });
    if (!raced) throw err;
    if (!reuseExisting) return { service, duplicate: raced };
    return { service, group: raced, created: false };
  }

  await logGroupCreated({ group, board, actor: actorId });
  // The same event createGroup emits, so GROUP_CREATED automations fire for a
  // service created this way exactly as for one added by hand.
  eventBus.emit('group.created', {
    groupId: group._id,
    groupName: group.name,
    boardId: String(board._id),
    createdByUserId: actorId,
  });

  return { service, group, created: true };
};

/**
 * PHASE 3 — grow the organisation's service catalog. Best-effort: the catalog is
 * a convenience for the NEXT invite, and failing it must not fail work that has
 * already created groups. Writes the resolved colour back onto the entry.
 */
const recordCatalogFor = async (entry, board, actorId) => {
  if (!entry.group) return entry;
  try {
    const cat = await recordServiceUse({
      orgId: board.organisation,
      name: entry.service.name,
      color: entry.service.color,
      actorId,
    });
    entry.color = cat ? cat.color : null;
  } catch (err) {
    console.error('portalBatchInvite catalog error:', err);
  }
  return entry;
};

/**
 * PHASE 4 — every service can be talked about from the day it exists, reused
 * ones included. Idempotent under Channel's (board, group, mode, audience)
 * index, and swallowed for the same reason phase 3 is.
 */
const ensureSurfacesFor = async (entry, board, actorId, portalLive = true) => {
  if (!entry.group) return entry;
  try {
    const made = await createSurfaces(
      board,
      entry.group,
      // Only what the board can have: `planSurfaces` refuses the WHOLE plan —
      // team room included — when a client-facing room is asked for on a board
      // that is not live. See the same note in `groupController.createGroup`.
      { clientChat: portalLive, clientMail: portalLive, team: true },
      { createdBy: actorId }
    );
    entry.surfaces = {
      created: (made.created || []).map((c) => c.key),
      existing: (made.existing || []).map((c) => c.key),
    };
  } catch (err) {
    console.error('portalBatchInvite surfaces error:', err);
    entry.surfaces = { created: [], existing: [] };
  }
  return entry;
};

/**
 * PHASE 5 — one contact per unique address.
 *
 * `$addToSet` IS the union rule, and it is also what makes a re-submission a
 * no-op: a contact already on SEO and Meta Ads does not gain them twice.
 * `services` is LABELLING ONLY — read the field comment on the model before
 * reaching for it as a filter.
 */
const upsertContactRow = ({ board, email, authMethod, groupIds }) =>
  ClientContact.findOneAndUpdate(
    { board: board._id, email },
    {
      $setOnInsert: { board: board._id, organisation: board.organisation, email },
      $set: { authMethod, invitedAt: new Date() },
      $addToSet: { services: { $each: groupIds } },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).select('+passwordHash +setupTokenHash');

/**
 * PHASE 6 — the ONE non-idempotent step, and therefore always last.
 *
 * Never throws: an email that could not be sent is reported, not raised. A
 * service the team asked for is a service they want, and un-creating it because
 * the mailer was down would destroy the surfaces just minted inside it.
 */
const mailContact = async ({ board, orgName, contact, email, authMethod, serviceLinks }) => {
  try {
    let setupToken = null;
    let purpose = 'setup';
    if (authMethod === 'password') {
      // Exactly the rule inviteContact already implements: someone who has a
      // password gets a RESET link, someone who does not gets a SETUP one.
      purpose = contact.passwordHash ? 'reset' : 'setup';
      setupToken = await issueSetupToken(contact, purpose);
    }
    const sent = await sendInviteEmail({
      board,
      email,
      authMethod,
      setupToken,
      purpose,
      services: serviceLinks,
      orgName,
    });
    return { sent: !!sent, error: sent ? null : 'The invitation email could not be sent.' };
  } catch (err) {
    console.error('portalBatchInvite email error:', err);
    return { sent: false, error: 'The invitation email could not be sent.' };
  }
};

/**
 * Run a planned batch against the database and the mailer.
 *
 * The phases are numbered in the header. The one worth reading twice is phase 2:
 * a row naming a service the board ALREADY HAS is a SUCCESS, not a conflict.
 * "Put Asha on SEO" when SEO exists is the ordinary second-invite case, and
 * `resolveGroupName` reports the collision rather than refusing it precisely so
 * this caller can reuse the group while `createGroup` still answers 409.
 */
const inviteServiceContacts = async ({
  board,
  orgName = '',
  actorId = null,
  rows,
  notify = true,
}) => {
  const plan = planInvites(rows);
  if (!plan.ok) return { ok: false, status: 400, errors: plan.errors };

  // ---- a switched-off portal is refused BEFORE anything is written -------
  // This batch always has people to email, and mailing a link that
  // `loadPortalBoard` refuses would tell a client to visit a page that does not
  // load. `sendPortalInvite` answers the same way. It is checked HERE, ahead of
  // every phase, because the e2e pins "one bad row creates nothing at all" and
  // a refusal issued after phase 2 would have created services.
  //
  // A board with no token has never been live, so `portalEnabled: false` there
  // is the birth state, not the kill switch — see `utils/portalActivation.js`.
  const disabled = refusalIfPortalDisabled(board);
  if (disabled) return disabled;

  // ---- phase 2 runs FIRST, and phase 1 has moved below it ----------------
  //
  // The numbering is the file header's and is kept, but the order is not what
  // it was. Activation used to be the first thing this function did; a batch
  // whose group creation then failed would leave a live link with nothing
  // behind it, which is the exact state this whole change exists to remove. So
  // the services land first, and the portal goes live once there is something
  // for it to open on.
  //
  // ---- resolve or create each service group, SEQUENTIALLY ---------------
  // Sequential is required, not stylistic: `order` is a countDocuments and has
  // to see the previous insert, or two new services collide on one position.
  //
  // `reuseExisting` is the batch's policy: a row naming a service the board
  // ALREADY HAS is a SUCCESS, not a conflict. "Put Asha on SEO" when SEO exists
  // is the ordinary second-invite case.
  const bySlug = new Map();
  for (const svc of plan.services) {
    const entry = await resolveOrCreateService({
      board,
      service: svc,
      actorId,
      reuseExisting: true,
    });
    bySlug.set(svc.slug, entry);
  }

  // ---- phase 1: THE PORTAL GOES LIVE -------------------------------------
  // Before the surfaces, and that ORDER IS LOAD-BEARING:
  // `workstreamSurfaces.createSurfaces` gates client-facing rooms on
  // `isLiveClientBoard(board)`, so on a board whose portal is not yet on it
  // would refuse the WHOLE plan — client chat, client mailbox AND team room.
  const portal = await ensurePortalLive(board);

  // ---- phase 3: grow the organisation's service catalog ------------------
  for (const entry of bySlug.values()) {
    await recordCatalogFor(entry, board, actorId);
  }

  // ---- phase 4: every service can be talked about, reused ones included --
  for (const entry of bySlug.values()) {
    await ensureSurfacesFor(entry, board, actorId, portal.live);
  }

  // ---- phase 5: one contact per unique address ---------------------------
  const contactResults = [];
  for (const c of plan.contacts) {
    const groupIds = c.slugs.map((slug) => bySlug.get(slug)?.group?._id).filter(Boolean);

    const contact = await upsertContactRow({
      board,
      email: c.email,
      authMethod: c.authMethod,
      groupIds,
    });

    contactResults.push({
      email: c.email,
      contactId: String(contact._id),
      authMethod: c.authMethod,
      slugs: c.slugs,
      services: c.slugs.map((s) => bySlug.get(s)?.service?.name).filter(Boolean),
      serviceLinks: c.slugs
        .map((s) => {
          const e = bySlug.get(s);
          if (!e || !e.group) return null;
          return {
            name: e.service.name,
            slug: s,
            groupId: String(e.group._id),
            color: e.color || null,
          };
        })
        .filter(Boolean),
      rowIndexes: c.rowIndexes,
      contact,
      emailSent: false,
      error: null,
    });
  }

  // ---- phase 6: ONE email per unique address -----------------------------
  if (notify) {
    await Promise.allSettled(
      contactResults.map(async (r) => {
        const { sent, error } = await mailContact({
          board,
          orgName,
          contact: r.contact,
          email: r.email,
          authMethod: r.authMethod,
          serviceLinks: r.serviceLinks,
        });
        r.emailSent = sent;
        r.error = error;
      })
    );
  }

  // ---- the response ------------------------------------------------------
  // `rows` is INDEX-ALIGNED WITH THE REQUEST, which is the entire reason it is
  // reported separately from the deduped `contacts`: the UI puts a tick or a
  // message on each row of the table the user actually typed.
  const rowOutcomes = rows.map((raw, index) => {
    const email = String((raw && raw.email) || '').trim().toLowerCase();
    const slug = serviceSlug(raw && raw.service);
    const entry = slug ? bySlug.get(slug) : null;
    const contact = contactResults.find((c) => c.email === email);
    let outcome = 'invited';
    if (entry && entry.error) outcome = 'failed';
    else if (!notify) outcome = 'added';
    else if (contact && !contact.emailSent) outcome = 'failed';
    return {
      index,
      email,
      service: (entry && entry.service.name) || normaliseServiceName(raw && raw.service),
      groupId: entry && entry.group ? String(entry.group._id) : null,
      serviceCreated: !!(entry && entry.created),
      outcome,
      error: (entry && entry.error) || (contact && contact.error) || null,
    };
  });

  return {
    ok: true,
    services: [...bySlug.values()].map((e) => ({
      name: e.service.name,
      slug: e.service.slug,
      groupId: e.group ? String(e.group._id) : null,
      color: e.color || null,
      created: !!e.created,
      surfaces: e.surfaces || { created: [], existing: [] },
      error: e.error || null,
    })),
    contacts: contactResults.map(({ contact, serviceLinks, ...rest }) => rest),
    rows: rowOutcomes,
    warnings: plan.warnings,
  };
};

/**
 * ADD ONE SERVICE, AND TELL THE PEOPLE WHO CARE ABOUT IT.
 *
 * This is the single-service sibling of `inviteServiceContacts`, and it is the
 * flow the client-portal rewrite is built around: a client board is created
 * EMPTY and with NO portal link, and the first service somebody adds is what
 * brings the portal into existence and sends the first invitation. Creating the
 * board no longer does either (`boardController.createBoard`).
 *
 * ---- HOW IT DIFFERS FROM THE BATCH ----------------------------------------
 *
 *   1. ONE service, named directly rather than repeated down a table.
 *   2. A NEW service. `reuseExisting: false`, so a name the board already
 *      carries is a 409 - the same policy `createGroup` has always had, and the
 *      reason `resolveGroupName` reports a collision instead of refusing one.
 *   3. INVITES ARE OPTIONAL. An empty list still creates the service, still
 *      mints the portal link, and simply sends no mail. Adding a second service
 *      for a client whose people are already invited must not force the team to
 *      re-type their addresses, and the first service is often added before
 *      anyone knows who at the client will be looking after it.
 *
 * Everything else - the phase ordering, the idempotency, the refusal to roll
 * back a created service because the mailer was down - is the header of this
 * file, unchanged.
 *
 * @param {object}   opts.board    - client Board doc loaded WITH `+portalToken`
 * @param {string}   opts.name     - the service name the team typed
 * @param {string?}  opts.color    - optional catalog colour
 * @param {Array}    opts.invites  - `[{ email, authMethod? }]`, possibly empty
 * @param {boolean}  opts.notify   - false to create + register without emailing
 */
const createServiceWithInvites = async ({
  board,
  orgName = '',
  actorId = null,
  name,
  color = null,
  invites = [],
  notify = true,
}) => {
  // ---- validate, all-or-nothing ------------------------------------------
  // The caller is a form the user is still editing. Half-applying it would
  // leave them unable to tell which addresses landed.
  const serviceName = normaliseServiceName(name);
  const slug = serviceSlug(name);
  if (!serviceName || !slug) {
    return {
      ok: false,
      status: 400,
      errors: [{ index: null, field: 'name', message: 'Service name is required.' }],
    };
  }

  const rawInvites = Array.isArray(invites) ? invites : [];
  if (rawInvites.length > MAX_SERVICE_INVITES) {
    return {
      ok: false,
      status: 400,
      errors: [
        {
          index: null,
          field: 'invites',
          message:
            'Too many people - ' +
            MAX_SERVICE_INVITES +
            ' at a time. Use the invite table on the People tab for a larger list.',
        },
      ],
    };
  }

  const errors = [];
  const warnings = [];
  // Same dedupe rule the batch uses, for the same reason: one address is one
  // person and gets ONE email, however many times it was typed.
  const byEmail = new Map();
  rawInvites.forEach((raw, index) => {
    const row = raw || {};
    const email = String(row.email || '').trim().toLowerCase();
    // A blank row is a row the user has not filled in yet, not an error - the
    // form starts with one and the service may legitimately have no contacts.
    if (!email) return;
    if (!EMAIL_RE.test(email)) {
      errors.push({ index, field: 'email', message: 'That is not an email address.' });
      return;
    }
    let authMethod = row.authMethod == null ? 'google' : String(row.authMethod);
    if (!AUTH_METHODS.includes(authMethod)) {
      errors.push({ index, field: 'authMethod', message: 'That is not a sign-in method.' });
      authMethod = 'google';
    }
    const seen = byEmail.get(email);
    if (seen) {
      seen.rowIndexes.push(index);
      // PASSWORD WINS on a conflict, exactly as in `planInvites`: someone whose
      // address is not a Google account needs a password regardless of which
      // row happened to ask for one.
      if (authMethod === 'password' && seen.authMethod !== 'password') {
        seen.authMethod = 'password';
        seen.mixed = true;
      } else if (authMethod === 'google' && seen.authMethod === 'password') {
        seen.mixed = true;
      }
      return;
    }
    byEmail.set(email, { email, authMethod, rowIndexes: [index], mixed: false });
  });

  for (const c of byEmail.values()) {
    if (c.mixed) {
      warnings.push(
        c.email +
          ' was listed with more than one sign-in method - invited with a password, because one of the rows asked for one.'
      );
    }
    delete c.mixed;
  }

  if (errors.length) return { ok: false, status: 400, errors };

  // ---- a switched-off portal refuses the INVITATIONS, not the service ----
  //
  // Adding a service to an offboarded client is ordinary internal
  // restructuring and must keep working — `createGroup` allows it, and this is
  // the only add-a-service path the client-board UI has. What must not happen
  // is an email carrying a link `loadPortalBoard` refuses, telling somebody to
  // visit a page that does not load.
  //
  // So the refusal is conditional on there being someone to write to, and it is
  // raised BEFORE any write: a 409 that had already created a service would
  // contradict the all-or-nothing contract every other refusal here keeps.
  if (byEmail.size && notify) {
    const disabled = refusalIfPortalDisabled(board);
    if (disabled) return disabled;
  }

  // ---- phase 2 (first): is this name free? -------------------------------
  // Before anything is written. `createGroup`'s policy, so the team gets the
  // same 409 wherever they add a service from.
  const entry = await resolveOrCreateService({
    board,
    service: { name: serviceName, slug, color },
    actorId,
    reuseExisting: false,
  });
  if (entry.error) {
    return { ok: false, status: 400, errors: [{ index: null, field: 'name', message: entry.error }] };
  }
  if (entry.duplicate) {
    return {
      ok: false,
      status: 409,
      errors: [
        {
          index: null,
          field: 'name',
          message:
            'A service named "' + entry.duplicate.name + '" already exists on this board.',
        },
      ],
    };
  }

  // ---- phase 1: THE PORTAL GOES LIVE -------------------------------------
  //
  // AFTER the group exists: the invariant this whole change is for is "no link
  // until there is something behind it", and minting first and then failing to
  // create the group would leave exactly the dead link the board no longer
  // mints at creation.
  //
  // BEFORE the surfaces below, and that ORDER IS LOAD-BEARING:
  // `workstreamSurfaces.createSurfaces` gates client-facing rooms on
  // `isLiveClientBoard(board)`, so on a board whose portal is not yet on it
  // refuses the WHOLE plan — client chat, client mailbox AND team room — and
  // does it quietly, in a return value this caller does not inspect.
  const portal = await ensurePortalLive(board);

  // ---- phases 3 and 4 ----------------------------------------------------
  await recordCatalogFor(entry, board, actorId);
  await ensureSurfacesFor(entry, board, actorId, portal.live);

  const serviceLinks = [
    {
      name: entry.service.name,
      slug,
      groupId: String(entry.group._id),
      color: entry.color || null,
    },
  ];

  // ---- phase 5: one contact per unique address ---------------------------
  const contactResults = [];
  for (const c of byEmail.values()) {
    const contact = await upsertContactRow({
      board,
      email: c.email,
      authMethod: c.authMethod,
      groupIds: [entry.group._id],
    });
    contactResults.push({
      email: c.email,
      contactId: String(contact._id),
      authMethod: c.authMethod,
      rowIndexes: c.rowIndexes,
      contact,
      emailSent: false,
      error: null,
    });
  }

  // ---- phase 6: the only non-idempotent step, and therefore last ---------
  if (notify) {
    await Promise.allSettled(
      contactResults.map(async (r) => {
        const { sent, error } = await mailContact({
          board,
          orgName,
          contact: r.contact,
          email: r.email,
          authMethod: r.authMethod,
          serviceLinks,
        });
        r.emailSent = sent;
        r.error = error;
      })
    );
  }

  return {
    ok: true,
    group: entry.group,
    service: {
      name: entry.service.name,
      slug,
      groupId: String(entry.group._id),
      color: entry.color || null,
      created: true,
      surfaces: entry.surfaces || { created: [], existing: [] },
    },
    // True exactly once per board: the submission that brought the portal to
    // life. The UI says "the client link is now live" on the back of this.
    portalActivated: portal.changed,
    // Whether the link works at all right now. False on a board whose portal
    // the team switched off — the service was still created, and the UI should
    // say so rather than claim anything about the client's access.
    portalLive: portal.live,
    contacts: contactResults.map(({ contact, ...rest }) => rest),
    warnings,
  };
};

module.exports = {
  MAX_ROWS,
  planInvites,
  inviteServiceContacts,
  createServiceWithInvites,
  MAX_SERVICE_INVITES,
};
