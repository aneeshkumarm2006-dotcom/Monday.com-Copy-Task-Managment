const ServiceCatalogEntry = require('../models/ServiceCatalogEntry');
const {
  normaliseServiceName,
  serviceSlug,
  colorForSlug,
} = require('../utils/serviceCatalog');

/**
 * Reading and growing the organisation's service catalog.
 *
 * The catalog is "catalog + free text": the invite table offers what is here,
 * and typing a name that is not here mints it. So there is deliberately NO
 * create endpoint — `recordServiceUse` below is the only writer, and it is
 * called from the flows that actually put a service on a board. A catalog entry
 * that exists but is on no board would be a name someone has to tidy up later.
 *
 * `utils/serviceCatalog.js` owns normalisation and is dependency-free so it can
 * be unit-tested; this file is the half that needs a database.
 */

/**
 * The catalog for a workspace, best-first.
 *
 * Sorted by `usageCount` descending before name, so an agency that runs four
 * services sees those four at the top rather than alphabetical order burying
 * "SEO" under "Content" and "Design". `order` wins over both when someone has
 * arranged the list by hand.
 */
const listCatalog = async (orgId, { includeArchived = false } = {}) => {
  if (!orgId) return [];
  const filter = { organisation: orgId };
  if (!includeArchived) filter.archived = { $ne: true };
  const rows = await ServiceCatalogEntry.find(filter)
    .sort({ order: 1, usageCount: -1, name: 1 })
    .select('slug name color order archived usageCount lastUsedAt')
    .lean();
  return rows.map((r) => ({
    slug: r.slug,
    name: r.name,
    color: r.color || colorForSlug(r.slug),
    order: r.order || 0,
    archived: !!r.archived,
    usageCount: r.usageCount || 0,
    lastUsedAt: r.lastUsedAt || null,
  }));
};

/**
 * Record that a service was just put on a board, minting the catalog entry if
 * this is the first time anyone has used that name.
 *
 * Returns `{ slug, name, color, created }` or null when the name has nothing
 * sluggable in it — the caller must treat null as a validation failure rather
 * than storing an empty key.
 *
 * IDEMPOTENT BY THE UNIQUE INDEX, not by a read-then-write. A batch invite can
 * name the same service on four rows and they race each other; the E11000 catch
 * is what makes the losers read back the winner. A `findOne` first would look
 * correct and lose that race silently.
 *
 * `$setOnInsert` on `name` is what makes FIRST CASING WIN. A later row spelling
 * it "seo" bumps the counter but does not restyle the service for everyone who
 * already reads it as "SEO".
 */
const recordServiceUse = async ({ orgId, name, color = null, actorId = null } = {}) => {
  const slug = serviceSlug(name);
  if (!orgId || !slug) return null;

  const display = normaliseServiceName(name);
  const insert = {
    organisation: orgId,
    slug,
    name: display,
    color: color || colorForSlug(slug),
    createdBy: actorId || null,
  };

  try {
    const before = await ServiceCatalogEntry.findOne({ organisation: orgId, slug })
      .select('_id')
      .lean();
    const row = await ServiceCatalogEntry.findOneAndUpdate(
      { organisation: orgId, slug },
      {
        $setOnInsert: insert,
        $set: { lastUsedAt: new Date() },
        $inc: { usageCount: 1 },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
    return {
      slug: row.slug,
      name: row.name,
      color: row.color || colorForSlug(row.slug),
      created: !before,
    };
  } catch (err) {
    if (err?.code === 11000) {
      // The unique index won the race it exists to win. Read back the winner —
      // the same recovery `workstreamSurfaces.createSurfaces` performs.
      const row = await ServiceCatalogEntry.findOne({ organisation: orgId, slug }).lean();
      if (row) {
        return {
          slug: row.slug,
          name: row.name,
          color: row.color || colorForSlug(row.slug),
          created: false,
        };
      }
    }
    throw err;
  }
};

/**
 * `{ slug -> color }` for the slugs on one page, in ONE query.
 *
 * Exists so the portal home and the team workspace can colour every service
 * without a lookup per row. Slugs with no catalog entry (a group renamed to
 * something never invited under) fall back to the deterministic hash, so a
 * missing row costs a colour nobody chose rather than no colour at all.
 */
const resolveColors = async (orgId, slugs = []) => {
  const wanted = [...new Set((slugs || []).filter(Boolean))];
  const out = new Map(wanted.map((s) => [s, colorForSlug(s)]));
  if (!orgId || !wanted.length) return out;
  const rows = await ServiceCatalogEntry.find({ organisation: orgId, slug: { $in: wanted } })
    .select('slug color')
    .lean();
  for (const r of rows) if (r.color) out.set(r.slug, r.color);
  return out;
};

module.exports = { listCatalog, recordServiceUse, resolveColors };
