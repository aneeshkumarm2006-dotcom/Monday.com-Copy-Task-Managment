const FxSnapshot = require('../../models/FxSnapshot');
const Organisation = require('../../models/Organisation');
const connectorCrypto = require('../../utils/connectorCrypto');
const { FX_BASE, sanitizeRates, isDayKey, providerNeedsKey } = require('../../utils/money');
const { getProvider } = require('./index');
const { FxError } = require('./errors');

/**
 * FETCH, STORE AND RESOLVE EXCHANGE RATES.
 *
 * The one place that talks to a provider and the one place that reads a
 * snapshot back. Everything above it — the runner, the API, the backfill
 * script — goes through here, so there is exactly one answer to "which rate
 * applied" and one place where that answer can be wrong.
 */

/** Today as a day key, in UTC. Rates are published per calendar day, not per zone. */
const todayKey = () => new Date().toISOString().slice(0, 10);

/**
 * The period a day belongs to, for a given cadence.
 *
 * This is the whole of what `cadence` means. It does NOT change the shape of
 * what gets stored — a snapshot is always keyed by a real day — it only decides
 * how often a new one is worth fetching. A monthly workspace ends up with
 * twelve rows a year, each stamped with the day it was actually published.
 *
 * Letting cadence change the KEY shape ('2026-03' versus '2026-03-15') would
 * put two incomparable formats in one collection the first time somebody
 * switched the setting, and "the newest at or before this day" would stop
 * meaning anything.
 */
const periodOf = (dayKey, cadence) => (cadence === 'daily' ? dayKey : dayKey.slice(0, 7));

/**
 * The workspace's FX configuration, with the API key decrypted if there is one.
 *
 * The ONLY reader of `fx.sealedApiKey` — the same single-reader rule
 * `services/connectors/session.js` follows for OAuth tokens, and for the same
 * reason: a credential with one reader has one place to audit.
 */
const configFor = async (orgId) => {
  /**
   * Fields named INDIVIDUALLY, not `fx` plus `+fx.sealedApiKey`.
   *
   * Selecting a sub-document and one of its own paths in the same projection is
   * a path collision — MongoDB refuses the query outright with
   * "Path collision at fx.sealedApiKey". The `select: false` field has to be
   * asked for explicitly, so the parent cannot also be asked for wholesale.
   */
  const org = await Organisation.findById(orgId)
    .select('baseCurrency fx.provider fx.cadence fx.lastFetchAt +fx.sealedApiKey')
    .lean();
  if (!org) return null;

  const provider = org.fx?.provider || 'frankfurter';
  let apiKey = null;

  if (org.fx?.sealedApiKey) {
    try {
      apiKey = connectorCrypto.open(org.fx.sealedApiKey, { orgId: String(orgId), provider: 'fx' });
    } catch {
      // A key sealed under a rotated-away encryption key, or one moved between
      // workspaces. Unusable rather than fatal: the provider will report that
      // it has no credential, which is the truth and says what to do about it.
      apiKey = null;
    }
  }

  return {
    baseCurrency: org.baseCurrency || 'INR',
    provider,
    cadence: org.fx?.cadence || 'monthly',
    apiKey,
    lastFetchAt: org.fx?.lastFetchAt || null,
  };
};

/**
 * Ask a provider for one day's rates and write them down.
 *
 * `dayKey` omitted means "latest". The day a snapshot is FILED under comes from
 * the provider's own response, not from what we asked for: request a Sunday and
 * Frankfurter answers with Friday's rates, and filing those under Sunday would
 * claim a publication that never happened.
 *
 * Idempotent by the unique `(base, dayKey)` index — a second fetch of the same
 * day updates in place rather than duplicating, which is what makes the
 * backfill script safe to re-run.
 */
const fetchAndStore = async ({ orgId, dayKey = null, base = FX_BASE } = {}) => {
  const config = await configFor(orgId);
  if (!config) throw new FxError('That workspace no longer exists.', { needsConfig: true });

  const provider = getProvider(config.provider);

  if (providerNeedsKey(provider.key) && !config.apiKey) {
    throw new FxError(`${provider.label} needs an API key. Add one in Settings → Currency.`, {
      provider: provider.key,
      needsConfig: true,
    });
  }

  const result = await provider.fetchRates({ base, dayKey, apiKey: config.apiKey });

  const filedUnder = isDayKey(result.dayKey) ? result.dayKey : dayKey || todayKey();
  const rates = sanitizeRates(result.rates);

  await FxSnapshot.updateOne(
    { base, dayKey: filedUnder },
    {
      $set: {
        base,
        dayKey: filedUnder,
        rates,
        provider: provider.key,
        fetchedAt: new Date(),
      },
    },
    { upsert: true }
  );

  return { dayKey: filedUnder, base, provider: provider.key, count: Object.keys(rates).length };
};

/**
 * Fetch for this workspace if its cadence says one is due.
 *
 * Returns `{ skipped: true }` when the current period already has a snapshot,
 * which is what turns an hourly tick into twelve requests a year for a monthly
 * workspace. The check is on the SNAPSHOT rather than on `lastFetchAt` so a
 * workspace that switches from monthly to daily starts fetching daily
 * immediately rather than waiting out the month it already covered.
 */
const refreshIfDue = async (orgId) => {
  const config = await configFor(orgId);
  if (!config) return { skipped: true, reason: 'no-org' };

  const today = todayKey();
  const period = periodOf(today, config.cadence);

  // The newest snapshot we hold, and whether it is already in this period.
  const newest = await FxSnapshot.findOne({ base: FX_BASE })
    .sort({ dayKey: -1 })
    .select('dayKey')
    .lean();

  if (newest && periodOf(newest.dayKey, config.cadence) === period) {
    return { skipped: true, reason: 'already-current', dayKey: newest.dayKey };
  }

  const result = await fetchAndStore({ orgId });
  await Organisation.updateOne(
    { _id: orgId },
    { $set: { 'fx.lastFetchAt': new Date(), 'fx.lastError': '' } }
  );
  return { skipped: false, ...result };
};

/**
 * The snapshots a client needs to render money, newest first.
 *
 * ---- Why the client gets a LIST and not a single rate ----------------------
 *
 * Because conversion is per record, not per page. A ledger holds invoices from
 * different months, each of which converts at its own month's rate, so handing
 * the browser one "current" table would either be wrong for most rows or
 * require a round trip per row. The whole set is small — one object of ~171
 * numbers per period, twelve a year for a monthly workspace — so sending it is
 * cheaper than being clever.
 *
 * `limit` bounds a workspace that has been running for years. The cap is stated
 * in the response so a caller can tell a truncated history from a complete one
 * rather than silently valuing an old invoice at the oldest rate it happened to
 * receive.
 */
const snapshotsFor = async ({ base = FX_BASE, limit = 120 } = {}) => {
  const rows = await FxSnapshot.find({ base })
    .sort({ dayKey: -1 })
    .limit(limit)
    .select('dayKey rates provider fetchedAt')
    .lean();

  return rows.map((r) => ({
    dayKey: r.dayKey,
    // A lean() Map comes back as a plain object already, but an older driver
    // can hand back a Map — normalise so the wire shape is always an object.
    rates: r.rates instanceof Map ? Object.fromEntries(r.rates) : r.rates,
    provider: r.provider,
  }));
};

/**
 * The snapshot in force on `dayKey`, server side.
 *
 * Mirrors `client/src/utils/money.js`'s `snapshotFor` and carries the same two
 * rules: never reach FORWARD to a later snapshot, and never apply an age check.
 * A March invoice's rate is six months old and that is exactly correct; the
 * only failure is having nothing at or before the record's own day.
 */
const rateTableOn = async (dayKey, base = FX_BASE) => {
  const query = { base };
  if (isDayKey(dayKey)) query.dayKey = { $lte: dayKey };

  const row = await FxSnapshot.findOne(query).sort({ dayKey: -1 }).select('dayKey rates').lean();
  if (!row) return null;

  return {
    dayKey: row.dayKey,
    rates: row.rates instanceof Map ? Object.fromEntries(row.rates) : row.rates,
  };
};

module.exports = {
  todayKey,
  periodOf,
  configFor,
  fetchAndStore,
  refreshIfDue,
  snapshotsFor,
  rateTableOn,
};
