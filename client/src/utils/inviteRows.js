/**
 * The invite table's pure logic: parsing a pasted list, previewing what a batch
 * will do, and painting per-row results.
 *
 * React-free and dependency-free, on the same doctrine as `chatSurfaces.js`: the
 * dedupe rule is the feature, and a rule that can only be exercised by clicking
 * through a modal is a rule that never gets tested. `inviteRows.test.mjs` runs
 * these under `node --test` with no DOM.
 *
 * EVERYTHING HERE IS AN AFFORDANCE, NEVER ENFORCEMENT. The server re-validates
 * and re-dedupes the whole batch in `services/portalBatchInvite.js`; this exists
 * so the person typing can SEE what is about to happen before they commit to it.
 */

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Matches the server's MAX_ROWS. */
export const MAX_ROWS = 25;

const norm = (s) => (typeof s === 'string' ? s.trim() : '');

/** The comparison key for a service name — mirrors `serviceSlug` on the server. */
export const serviceKeyOf = (name) => {
  const n = norm(name).slice(0, 60).trim();
  if (!n) return null;
  const slug = n
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || null;
};

let seq = 0;
export const newRow = (patch = {}) => ({
  id: `r${(seq += 1)}`,
  service: '',
  email: '',
  authMethod: 'google',
  status: null,
  message: '',
  ...patch,
});

/**
 * Turn a pasted block into rows.
 *
 * Accepts, per line, the shapes people actually paste out of a spreadsheet or an
 * email: a bare address; `email, Service`; `Service<TAB>email`; `Name <email>`;
 * `email;Service;password`. The address is found by testing each token rather
 * than by position, because column order is exactly what varies between sources.
 *
 * A line with no recognisable address is REPORTED as skipped, not dropped
 * silently — a paste that quietly loses two of eleven people is worse than one
 * that refuses.
 */
export const parsePastedInvites = (text, { catalog = [], defaultService = '' } = {}) => {
  const rows = [];
  const skipped = [];
  const byKey = new Map(catalog.map((c) => [serviceKeyOf(c), c]));

  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    const angled = line.match(/<([^>]+)>/);
    const tokens = (angled ? line.replace(/<[^>]*>/, ' ') : line)
      .split(/[,;\t|]+/)
      .map((t) => t.trim())
      .filter(Boolean);

    const emailToken = angled
      ? angled[1].trim()
      : tokens.find((t) => EMAIL_RE.test(t)) || '';

    if (!EMAIL_RE.test(emailToken)) {
      skipped.push(line);
      continue;
    }

    const rest = tokens.filter((t) => t !== emailToken);
    const authToken = rest.find((t) => /^(password|google)$/i.test(t));
    const serviceToken = rest.find((t) => t !== authToken) || defaultService;

    // Fuzzy-match to the catalog so "seo" pasted from a spreadsheet becomes the
    // "SEO" everybody else already sees.
    const key = serviceKeyOf(serviceToken);
    const service = (key && byKey.get(key)) || norm(serviceToken);

    rows.push(
      newRow({
        service,
        email: emailToken.toLowerCase(),
        authMethod: authToken && /password/i.test(authToken) ? 'password' : 'google',
      })
    );
  }

  return { rows, skipped };
};

/**
 * What submitting this table would do, in the words the preview line uses.
 *
 * The dedupe is made VISIBLE here on purpose. "One email for four services" is
 * the single most surprising thing about this feature, and a person who
 * discovers it only after sending has already worried about spamming a client.
 */
export const planInvites = (rows, { services = [], existingEmails = [] } = {}) => {
  const rowErrors = {};
  const existingKeys = new Set(services.map((s) => serviceKeyOf(s.name)).filter(Boolean));
  const known = new Set(existingEmails.map((e) => String(e).toLowerCase()));

  const serviceOrder = [];
  const seenServices = new Map();
  const emails = new Map();

  rows.forEach((row) => {
    const email = norm(row.email).toLowerCase();
    const key = serviceKeyOf(row.service);

    if (!email) rowErrors[row.id] = 'Add an email address.';
    else if (!EMAIL_RE.test(email)) rowErrors[row.id] = 'That is not an email address.';
    else if (!key) rowErrors[row.id] = 'Name the service this person looks after.';

    if (!email || !key) return;

    if (!seenServices.has(key)) {
      seenServices.set(key, norm(row.service));
      serviceOrder.push(key);
    }
    if (!emails.has(email)) emails.set(email, { email, rows: [row.id], keys: [key] });
    else {
      const e = emails.get(email);
      e.rows.push(row.id);
      if (!e.keys.includes(key)) e.keys.push(key);
    }
  });

  const toCreate = serviceOrder.filter((k) => !existingKeys.has(k)).map((k) => seenServices.get(k));
  const reused = serviceOrder.filter((k) => existingKeys.has(k)).length;
  const uniqueEmails = [...emails.values()];
  const duplicated = uniqueEmails.filter((e) => e.rows.length > 1);

  const parts = [];
  if (toCreate.length) {
    parts.push(
      `creates ${toCreate.length} service${toCreate.length === 1 ? '' : 's'} (${toCreate.join(', ')})`
    );
  }
  if (reused) parts.push(`uses ${reused} you already have`);
  if (uniqueEmails.length) {
    parts.push(`emails ${uniqueEmails.length} ${uniqueEmails.length === 1 ? 'person' : 'people'}`);
  }

  let summary = parts.length ? `This ${parts.join(', ')}.` : '';
  for (const d of duplicated) {
    summary += ` ${d.email} is on ${d.rows.length} rows — one email, listing all of them.`;
  }
  const returning = uniqueEmails.filter((e) => known.has(e.email));
  if (returning.length) {
    summary += ` ${returning.length} ${
      returning.length === 1 ? 'person already has' : 'people already have'
    } access; their services are added to what they already had.`;
  }
  if (summary) summary += ' Everyone invited can see every service.';

  return {
    ok: Object.keys(rowErrors).length === 0 && rows.length > 0 && rows.length <= MAX_ROWS,
    rowErrors,
    servicesToCreate: toCreate,
    servicesReused: reused,
    uniqueEmails: uniqueEmails.map((e) => e.email),
    duplicateRowIds: duplicated.flatMap((d) => d.rows.slice(1)),
    summary: summary.trim(),
  };
};

/**
 * Paint the server's index-aligned `rows` back onto the table.
 *
 * Succeeded rows collapse to read-only; FAILED ROWS STAY EDITABLE, which is the
 * whole reason the table is not cleared on submit — the fix for a failure is
 * almost always a typo in the row that failed.
 */
export const mergeResults = (rows, results = []) =>
  rows.map((row, i) => {
    const r = results[i];
    if (!r) return row;
    return {
      ...row,
      status: r.outcome === 'failed' ? 'failed' : 'done',
      message: r.error || (r.serviceCreated ? 'Service created' : ''),
    };
  });
