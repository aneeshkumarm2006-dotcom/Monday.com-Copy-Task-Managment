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
const todayKey = (now = new Date()) => now.toISOString().slice(0, 10);

/**
 * `dayKey` moved by `days` calendar days, as a day key.
 *
 * Done in UTC on the key's own Y-M-D, never through a local Date, so it cannot
 * be shifted a day by the server's timezone — the same rule every other day-key
 * helper in this codebase keeps.
 */
const shiftDayKey = (dayKey, days) => {
  const [y, m, d] = dayKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

/**
 * How many of the NEWEST snapshots the browser gets in full, every one of them.
 * About four months at a daily cadence, ten years at a monthly one.
 */
const RECENT_SNAPSHOTS = 120;

/**
 * Which stored days `snapshotsFor` sends, newest first. Pure — the whole policy,
 * so it can be tested without a database.
 *
 *   1. the newest `recent`, all of them;
 *   2. further back, ONE per calendar month: the EARLIEST held in that month.
 *
 * ---- Why thin rather than cap ----------------------------------------------
 *
 * This used to be a hard `limit(120)`. At a daily cadence that is four months,
 * so an invoice raised five months ago had no snapshot at or before its day in
 * the browser and rendered unconverted — even though the server was holding the
 * exact rate it needed. A cap trades away the OLD records, which are the ones a
 * year-end view is made of.
 *
 * Thinning trades away precision instead, and only where precision is worth
 * least: for a record older than the dense window, "the rate this month opened
 * at" rather than "the rate that exact day". The payload stays bounded by months
 * of history, not days of it.
 *
 * ---- Why the EARLIEST in each month ----------------------------------------
 *
 * A record converts at the newest snapshot at or before its own day (see
 * `rateTableOn`, and `snapshotFor` on the client). The earliest snapshot in a
 * month is the one that is "at or before" the most days of that month, so it is
 * the single row that keeps the most of the month convertible at a rate from the
 * month itself — the latest would leave every day before it reaching back into
 * the previous month. It is also exactly what `backfillFxSnapshots` stores: the
 * first of each month.
 *
 * The month the dense window starts in is included too: its days before the
 * window's oldest row would otherwise fall through to the month before.
 */
const thinSnapshotDays = (dayKeys, { recent = RECENT_SNAPSHOTS } = {}) => {
  const keep = Number.isFinite(recent) && recent >= 0 ? Math.floor(recent) : RECENT_SNAPSHOTS;
  const newestFirst = [...new Set((dayKeys || []).filter(isDayKey))].sort().reverse();
  const out = newestFirst.slice(0, keep);

  // Walking newest → oldest, the LAST key seen for a month is its earliest.
  const earliestByMonth = new Map();
  for (const key of newestFirst.slice(keep)) earliestByMonth.set(key.slice(0, 7), key);
  // A Map iterates in insertion order — newest month first — so the result
  // stays newest first without a second sort.
  for (const key of earliestByMonth.values()) out.push(key);
  return out;
};

/**
 * Whether the stored history is too shallow to convert what a workspace already
 * holds, in which case `fxRateRunner` backfills it once at boot. Pure.
 *
 * Shallow means EITHER of:
 *   - fewer than `minMonths` distinct months held — a board with a year of
 *     invoices needs a rate for each of them;
 *   - nothing held from at least `minAgeDays` ago — a history that only starts
 *     this month converts nothing raised before it, however many rows it has.
 *
 * An empty history is shallow. The two tests together are what stop a deployment
 * that has run daily for three weeks (twenty rows, one month) from counting as
 * "has history".
 */
const isShallowHistory = (dayKeys, { today = todayKey(), minMonths = 12, minAgeDays = 60 } = {}) => {
  const keys = (dayKeys || []).filter(isDayKey);
  if (keys.length === 0) return true;
  const months = new Set(keys.map((k) => k.slice(0, 7)));
  if (months.size < minMonths) return true;
  const cutoff = shiftDayKey(today, -minAgeDays);
  return !keys.some((k) => k <= cutoff);
};

/**
 * The days a backfill asks the provider about, oldest first. Pure.
 *
 * Monthly by default — the FIRST of each month, which is exactly what a record
 * dated anywhere in that month resolves to under "newest snapshot at or before
 * this day". Asking for 730 individual days to get the same answers would be a
 * discourtesy to a free endpoint. The current month's first is included once it
 * is in the past: today itself is the latest fetch's job, not a backfill's.
 *
 * `daily` is there for a workspace that genuinely tracks the market and wants a
 * dense history. It is deliberately not the default.
 *
 * Lived in `scripts/backfillFxSnapshots.js` until the refresh runner needed the
 * same list at boot; it is here now so the script and the runner cannot drift.
 */
const daysToFetch = ({ months = 24, daily = false, now = new Date() } = {}) => {
  const out = [];
  const today = todayKey(now);

  if (daily) {
    const total = Math.round(months * 30.44);
    for (let i = total; i >= 1; i -= 1) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
      out.push(d.toISOString().slice(0, 10));
    }
    return out;
  }

  for (let i = months; i >= 0; i -= 1) {
    const key = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)).toISOString().slice(0, 10);
    if (key < today) out.push(key);
  }
  return out;
};

/**
 * How far BEFORE a requested day an existing snapshot may sit and still count as
 * the provider's answer to it.
 *
 * Providers publish on business days. Ask Frankfurter for Sunday the 1st and it
 * answers with Friday the 30th, which `fetchAndStore` files under the 30th — so
 * a plain "do we hold the 1st?" check never finds it, and every re-run asked
 * again for an answer it already had. Four days covers a weekend plus a public
 * holiday on either side of it.
 */
const PUBLICATION_SLACK_DAYS = 4;

/**
 * The days in `days` still worth asking about, given the day keys already held.
 * Pure.
 *
 * A day is skipped when a snapshot exists ON it, or — with `slack` — up to
 * `slack` days before it, because that snapshot is what the provider would
 * answer with anyway. A monthly backfill passes `PUBLICATION_SLACK_DAYS`; a
 * `--daily` one passes 0, since there the day before is a DIFFERENT answer.
 */
const backfillPlan = (days, heldDayKeys, { slack = 0 } = {}) => {
  const held = [...new Set((heldDayKeys || []).filter(isDayKey))].sort();
  const covered = (day) => {
    const from = slack > 0 ? shiftDayKey(day, -slack) : day;
    return held.some((h) => h >= from && h <= day);
  };
  return (days || []).filter((d) => isDayKey(d) && !covered(d));
};

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
 * Fetch and store each of `days`, in order, with `orgId`'s provider — THE
 * backfill loop, shared by `scripts/backfillFxSnapshots.js` and the runner's
 * boot pass so the two cannot disagree about when to give up.
 *
 * Gives up early in two cases, because both mean every remaining day will fail
 * the same way and asking anyway is just spending a free endpoint's goodwill:
 *   - `needsConfig` — a missing or rejected credential (`stopped: 'needs-config'`);
 *   - `maxConsecutiveFailures` failures in a row — the provider is down, or does
 *     not serve history on this plan (`stopped: 'failing'`). Unbounded by
 *     default, which is what the script has always done.
 *
 * Never throws for a provider failure: the result says what happened.
 *
 * @returns {Promise<{ stored: number, failed: number, stopped: null|'needs-config'|'failing', lastError: string|null }>}
 */
const backfillHistory = async ({
  orgId,
  days = [],
  dryRun = false,
  maxConsecutiveFailures = Infinity,
  log = () => {},
  logError = log,
  // The one fetch, injectable so the stopping rules can be tested without a
  // provider or a database. Nothing in the app passes it.
  fetchOne = fetchAndStore,
} = {}) => {
  let stored = 0;
  let failed = 0;
  let inARow = 0;
  let stopped = null;
  let lastError = null;

  for (const dayKey of days) {
    if (dryRun) {
      log(`  would fetch ${dayKey}`);
      stored += 1;
      continue;
    }
    try {
      const result = await fetchOne({ orgId, dayKey });
      // The day it lands under can differ from the day asked for — a weekend
      // request is answered with the previous business day, and we file the
      // provider's answer rather than our question.
      log(`  ${dayKey} -> ${result.dayKey} (${result.count} rates)`);
      stored += 1;
      inARow = 0;
    } catch (err) {
      failed += 1;
      inARow += 1;
      lastError = err instanceof FxError ? err.toDisplay() : (err && err.message) || String(err);
      logError(`  ${dayKey}: ${lastError}`);
      if (err instanceof FxError && err.needsConfig) {
        stopped = 'needs-config';
        break;
      }
      if (inARow >= maxConsecutiveFailures) {
        stopped = 'failing';
        break;
      }
    }
  }

  return { stored, failed, stopped, lastError };
};

/**
 * Make sure the period's FIRST day has a rate, for a monthly workspace.
 *
 * A monthly fetch files the rate under the day it happens to run — the 25th, if
 * that is when the server first ticked in the month. Every record dated the 1st
 * to the 24th then resolved to the PREVIOUS month's snapshot, a month out of
 * date, and on a fresh install to nothing at all. One historical request for
 * `${period}-01` gives the whole month a rate from inside it.
 *
 * Skipped when a snapshot is already on or just before the 1st (see
 * `PUBLICATION_SLACK_DAYS`: a Sunday the 1st is answered with Friday the 30th),
 * and when today IS the 1st, which the latest fetch has just answered.
 *
 * Best-effort by design: it runs only right after a successful latest fetch, and
 * a failure here must not turn that success into an error on the settings
 * screen. It is not retried hourly either — a provider that will not serve
 * history would be asked 720 times a month for nothing. The runner's boot pass
 * picks up a missing opening instead.
 */
const ensurePeriodOpening = async ({ orgId, period, today = todayKey(), base = FX_BASE } = {}) => {
  const opening = `${period}-01`;
  if (!isDayKey(opening) || opening >= today) return null;
  try {
    const held = await FxSnapshot.exists({
      base,
      dayKey: { $gte: shiftDayKey(opening, -PUBLICATION_SLACK_DAYS), $lte: opening },
    });
    if (held) return null;
    const result = await fetchAndStore({ orgId, dayKey: opening, base });
    return { requested: opening, dayKey: result.dayKey };
  } catch (err) {
    return {
      requested: opening,
      error: err instanceof FxError ? err.toDisplay() : 'Could not fetch exchange rates.',
    };
  }
};

/**
 * Fetch for this workspace if its cadence says one is due.
 *
 * Returns `{ skipped: true }` when the current period already has a snapshot,
 * which is what turns an hourly tick into twelve requests a year for a monthly
 * workspace. The check is on the SNAPSHOT rather than on `lastFetchAt` so a
 * workspace that switches from monthly to daily starts fetching daily
 * immediately rather than waiting out the month it already covered.
 *
 * A monthly workspace also gets its month's opening day (`ensurePeriodOpening`),
 * so a month's records convert at that month's rate from the 1st rather than
 * from whichever day the fetch happened to run. Reported as `opening`: null
 * when nothing was needed, else `{ requested, dayKey }` or `{ requested, error }`.
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
  // After the latest fetch, not before: a latest answer filed ON the 1st (or
  // just before it) already covers the opening, and must be found as such.
  const opening =
    config.cadence === 'daily' ? null : await ensurePeriodOpening({ orgId, period, today });
  return { skipped: false, ...result, opening };
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
 * ---- Why it is thinned, not capped ----------------------------------------
 *
 * A workspace that has run for years still needs its oldest invoices to
 * convert. So the newest `recent` snapshots come in full, and further back one
 * per calendar month — `thinSnapshotDays` has the policy and the reasons. The
 * payload grows by one row a month, never by one a day.
 *
 * Two reads rather than one: the day keys alone (index-only, a few bytes each)
 * to decide what to send, then the rate tables for just those days. Loading
 * every table in order to throw most of them away is the cost this avoids.
 */
const snapshotsFor = async ({ base = FX_BASE, recent = RECENT_SNAPSHOTS } = {}) => {
  const held = await FxSnapshot.find({ base }).select('dayKey -_id').lean();
  const wanted = thinSnapshotDays(
    held.map((r) => r.dayKey),
    { recent }
  );
  if (wanted.length === 0) return [];

  const rows = await FxSnapshot.find({ base, dayKey: { $in: wanted } })
    .sort({ dayKey: -1 })
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
  shiftDayKey,
  periodOf,
  configFor,
  fetchAndStore,
  backfillHistory,
  ensurePeriodOpening,
  refreshIfDue,
  snapshotsFor,
  rateTableOn,
  // Pure policy, exported for the backfill script, the runner and the tests.
  RECENT_SNAPSHOTS,
  PUBLICATION_SLACK_DAYS,
  thinSnapshotDays,
  isShallowHistory,
  daysToFetch,
  backfillPlan,
};
