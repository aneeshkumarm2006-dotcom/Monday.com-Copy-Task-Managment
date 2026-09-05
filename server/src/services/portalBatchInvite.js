const ClientContact = require('../models/ClientContact');
const TaskGroup = require('../models/TaskGroup');
const { resolveGroupName } = require('../controllers/groupController');
const { logGroupCreated } = require('./groupActivity');
const { createSurfaces } = require('./workstreamSurfaces');
const { recordServiceUse } = require('./serviceCatalogService');
const { issueSetupToken, sendInviteEmail } = require('./portalInviteService');
const { generatePortalToken } = require('../utils/portalCrypto');
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

  // ---- phase 1: the portal must be live before a link is emailed ---------
  // The two lines sendPortalInvite already does. A batch is often the first
  // thing done to a board, and an invitation to a disabled portal is a dead link.
  if (!board.portalToken) board.portalToken = generatePortalToken();
  if (!board.portalEnabled) board.portalEnabled = true;
  await board.save();

  // ---- phase 2: resolve or create each service group, SEQUENTIALLY -------
  // Sequential is required, not stylistic: `order` is a countDocuments and has
  // to see the previous insert, or two new services collide on one position.
  const bySlug = new Map();
  for (const svc of plan.services) {
    const resolved = await resolveGroupName(svc.name, board._id);
    if (resolved.error) {
      // Cannot happen - planInvites already refused empty names - but a silent
      // skip here would drop a service the team asked for.
      bySlug.set(svc.slug, { service: svc, error: resolved.error });
      continue;
    }

    if (resolved.duplicate) {
      bySlug.set(svc.slug, { service: svc, group: resolved.duplicate, created: false });
      continue;
    }

    const order = await TaskGroup.countDocuments({ board: board._id });
    let group;
    try {
      group = await TaskGroup.create({
        name: resolved.name,
        board: board._id,
        order,
        createdBy: actorId,
        serviceKey: svc.slug,
      });
    } catch (err) {
      // There is no unique index on (board, name), so this is a duplicate by
      // TIMING - two batches submitted at once. Read back the winner.
      const raced = await TaskGroup.findOne({ board: board._id, name: resolved.name });
      if (!raced) throw err;
      bySlug.set(svc.slug, { service: svc, group: raced, created: false });
      continue;
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

    bySlug.set(svc.slug, { service: svc, group, created: true });
  }

  // ---- phase 3: grow the organisation's service catalog ------------------
  for (const entry of bySlug.values()) {
    if (!entry.group) continue;
    try {
      const cat = await recordServiceUse({
        orgId: board.organisation,
        name: entry.service.name,
        color: entry.service.color,
        actorId,
      });
      entry.color = cat ? cat.color : null;
    } catch (err) {
      // The catalog is a convenience for the NEXT invite. Failing it must not
      // fail an invite that has already created groups.
      console.error('portalBatchInvite catalog error:', err);
    }
  }

  // ---- phase 4: every service can be talked about, reused ones included --
  for (const entry of bySlug.values()) {
    if (!entry.group) continue;
    try {
      const made = await createSurfaces(
        board,
        entry.group,
        { clientChat: true, clientMail: true, team: true },
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
  }

  // ---- phase 5: one contact per unique address ---------------------------
  const contactResults = [];
  for (const c of plan.contacts) {
    const groupIds = c.slugs.map((slug) => bySlug.get(slug)?.group?._id).filter(Boolean);

    // `$addToSet` IS the union rule, and it is also what makes a re-submission a
    // no-op: a contact already on SEO and Meta Ads does not gain them twice.
    const contact = await ClientContact.findOneAndUpdate(
      { board: board._id, email: c.email },
      {
        $setOnInsert: { board: board._id, organisation: board.organisation, email: c.email },
        $set: { authMethod: c.authMethod, invitedAt: new Date() },
        $addToSet: { services: { $each: groupIds } },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).select('+passwordHash +setupTokenHash');

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
        try {
          let setupToken = null;
          let purpose = 'setup';
          if (r.authMethod === 'password') {
            // Exactly the rule inviteContact already implements: someone who has
            // a password gets a RESET link, someone who does not gets a SETUP one.
            purpose = r.contact.passwordHash ? 'reset' : 'setup';
            setupToken = await issueSetupToken(r.contact, purpose);
          }
          const sent = await sendInviteEmail({
            board,
            email: r.email,
            authMethod: r.authMethod,
            setupToken,
            purpose,
            services: r.serviceLinks,
            orgName,
          });
          r.emailSent = !!sent;
          if (!sent) r.error = 'The invitation email could not be sent.';
        } catch (err) {
          console.error('portalBatchInvite email error:', err);
          r.error = 'The invitation email could not be sent.';
        }
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

module.exports = { MAX_ROWS, planInvites, inviteServiceContacts };
