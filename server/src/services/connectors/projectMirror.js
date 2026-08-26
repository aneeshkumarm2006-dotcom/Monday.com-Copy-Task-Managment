const ConnectorAccount = require('../../models/ConnectorAccount');
const ConnectorProject = require('../../models/ConnectorProject');
const { openSession } = require('./session');
const { getConnector } = require('./index');

/**
 * Refresh the local mirror of a provider's projects.
 *
 * ---- Where this sits -------------------------------------------------------
 *
 * This is the ONLY thing in the app that spends quota during phase 2, and it
 * runs only when somebody presses Refresh. Everything else — the Add-ons tab,
 * the mapping, the project picker — reads `ConnectorProject` rows out of our own
 * database. That split is deliberate and load-bearing: quota is shared across
 * the whole workspace, so a tab that fetched on render would let one person with
 * an open browser exhaust the week for everyone.
 *
 * ---- Why it is generic ------------------------------------------------------
 *
 * Nothing below names Ubersuggest. It asks the registry for a descriptor and
 * calls `listProjects(session)` on it. The Ads-org boards are the intended
 * second tenant, and the whole point of the registry seam is that they arrive as
 * a new directory rather than as a branch in here.
 *
 * ---- What a partial failure means -------------------------------------------
 *
 * The account pool is plural, and each account has its own quota and its own
 * grant. One account being out of quota, or needing a reconnect, says nothing
 * about the next one — so a failure is recorded PER ACCOUNT and the run
 * continues. Collapsing that to a single thrown error would mean one stale
 * account could hide every other account's projects from the tab.
 */

/**
 * Work out what a listing means for the rows we already hold.
 *
 * Pure, and separated from the database for exactly that reason: this is the
 * part with the interesting edge — a project that DISAPPEARS from the provider
 * must not be deleted, because it is the parent of every ConnectorSnapshot
 * ever taken for that domain. It is flagged instead.
 *
 * @param {Array<Object>} existing - rows already stored for this account
 * @param {Array<Object>} incoming - normalised projects from the provider
 * @returns {{ upserts: Array<Object>, goneIds: string[], returnedIds: string[] }}
 */
const diffProjects = (existing, incoming) => {
  const incomingIds = new Set(incoming.map((p) => p.externalId));
  const byId = new Map(existing.map((row) => [String(row.externalId), row]));

  const goneIds = [];
  const returnedIds = [];

  for (const row of existing) {
    const id = String(row.externalId);
    if (!incomingIds.has(id)) {
      // Only report a row as newly gone if it was not already flagged, so a
      // repeated refresh does not keep rewriting the same documents.
      if (!row.missing) goneIds.push(id);
    } else if (row.missing) {
      // It came back. Renaming a project at the provider does not change its
      // id, but moving one between accounts does look like this.
      returnedIds.push(id);
    }
  }

  const upserts = incoming.map((project) => ({
    ...project,
    // A project that reappears is un-flagged by the same write that updates it.
    wasMissing: !!byId.get(project.externalId)?.missing,
  }));

  return { upserts, goneIds, returnedIds };
};

/**
 * Refresh one account's projects.
 *
 * @param {Object} account - a ConnectorAccount row (lean is fine)
 * @returns {Promise<Object>} a per-account report; never throws for a provider
 *   failure, because the caller is refreshing a POOL
 */
const refreshAccountProjects = async (account) => {
  const base = {
    accountId: String(account._id),
    label: account.label,
    ok: false,
    count: 0,
    gone: 0,
    quotaExhausted: false,
    needsReauth: false,
    error: '',
  };

  const connector = getConnector(account.provider);
  if (!connector || typeof connector.listProjects !== 'function') {
    return { ...base, error: `${account.provider} cannot list projects.` };
  }

  let session;
  try {
    session = await openSession(account);
  } catch (err) {
    return {
      ...base,
      needsReauth: !!err.needsReauth,
      error: err.message,
    };
  }

  let listing;
  try {
    listing = await connector.listProjects(session);
  } catch (err) {
    if (err.needsReauth) await session.markNeedsReauth();
    return {
      ...base,
      quotaExhausted: !!err.quotaExhausted,
      needsReauth: !!err.needsReauth,
      error: err.message,
    };
  }

  // Identity is a courtesy, not a requirement: `auth_status` costs nothing, but
  // a failure to read it must not fail a listing that already succeeded. This is
  // where the `externalEmail` and `tier` that ConnectorAccount has carried as
  // null since phase 1 finally get filled in.
  if (typeof connector.describeAccount === 'function') {
    try {
      const identity = await connector.describeAccount(session);
      await session.recordIdentity(identity);
    } catch (err) {
      console.warn(
        `[connectors] could not read identity for account ${account._id}: ${err.message}`
      );
    }
  }

  const existing = await ConnectorProject.find({ account: account._id })
    .select('externalId missing')
    .lean();

  const { upserts, goneIds, returnedIds } = diffProjects(existing, listing.projects);

  const now = new Date();

  if (upserts.length) {
    await ConnectorProject.bulkWrite(
      upserts.map((project) => ({
        updateOne: {
          filter: { account: account._id, externalId: project.externalId },
          update: {
            $set: {
              organisation: account.organisation,
              provider: account.provider,
              name: project.name,
              domain: project.domain,
              keywordCount: project.keywordCount,
              competitorCount: project.competitorCount,
              locations: project.locations,
              hasBrand: project.hasBrand,
              raw: project.raw,
              lastSeenAt: now,
              missing: false,
            },
          },
          upsert: true,
        },
      })),
      // Unordered: one row failing its unique index must not abandon the rest of
      // the listing, and a concurrent refresh of the same account is exactly the
      // race that produces one.
      { ordered: false }
    );
  }

  if (goneIds.length) {
    await ConnectorProject.updateMany(
      { account: account._id, externalId: { $in: goneIds } },
      { $set: { missing: true } }
    );
  }

  await ConnectorAccount.updateOne(
    { _id: account._id },
    { $set: { lastSyncAt: now } }
  );

  return {
    ...base,
    ok: true,
    count: upserts.length,
    gone: goneIds.length,
    returned: returnedIds.length,
  };
};

/**
 * Refresh every usable account in an org's pool for one provider.
 *
 * A revoked account is skipped silently — it has no tokens left to use. One that
 * `needs_reauth` is still ATTEMPTED, because the stored refresh token may have
 * started working again (the provider's own outage is a common cause of the
 * flag), and a successful refresh clears the status by itself.
 *
 * @param {Object} args
 * @param {string} args.organisation
 * @param {string} args.provider
 * @returns {Promise<{ accounts: Array<Object>, projects: number, quotaExhausted: boolean }>}
 */
const refreshOrgProjects = async ({ organisation, provider }) => {
  const accounts = await ConnectorAccount.find({
    organisation,
    provider,
    status: { $ne: 'revoked' },
  })
    .sort({ label: 1 })
    .lean();

  const reports = [];
  for (const account of accounts) {
    // Sequential on purpose. These accounts often share one Ubersuggest plan's
    // quota, and firing them in parallel turns "we ran out partway through" into
    // "several calls raced past the limit and we cannot say which succeeded".
    reports.push(await refreshAccountProjects(account));
  }

  return {
    accounts: reports,
    projects: reports.reduce((sum, r) => sum + r.count, 0),
    quotaExhausted: reports.some((r) => r.quotaExhausted),
  };
};

module.exports = { refreshOrgProjects, refreshAccountProjects, diffProjects };
