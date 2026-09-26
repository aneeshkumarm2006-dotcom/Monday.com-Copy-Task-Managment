const cron = require('node-cron');
const Organisation = require('../models/Organisation');
const FxSnapshot = require('../models/FxSnapshot');
const {
  refreshIfDue,
  todayKey,
  isShallowHistory,
  daysToFetch,
  backfillPlan,
  backfillHistory,
  PUBLICATION_SLACK_DAYS,
} = require('./fx/rateService');
const { FxError } = require('./fx/errors');
const { FX_BASE } = require('../utils/money');

/**
 * The exchange-rate refresh pass.
 *
 * A direct sibling of [seoAlertRunner.js](./seoAlertRunner.js) and
 * [dueDigestRunner.js](./dueDigestRunner.js) — same `node-cron` dependency,
 * same module-level `started` guard, same start-from-server.js shape.
 *
 * ---- Why it ticks hourly and fetches almost never --------------------------
 *
 * The tick is not the cadence. It runs every hour and then asks each workspace
 * whether a fetch is DUE, which `refreshIfDue` answers by looking at whether
 * the current period already has a snapshot. A workspace set to `monthly`
 * therefore fetches twelve times a year and skips the other ~8,700 ticks; one
 * set to `daily` fetches once a day.
 *
 * Hourly rather than daily so that switching a workspace from monthly to daily
 * takes effect within the hour instead of tomorrow, and so a day the provider
 * was down is retried the same day rather than lost.
 *
 * ---- Why it iterates workspaces when the snapshots are global --------------
 *
 * A rate is a public fact, so `FxSnapshot` is not org-scoped and the FIRST
 * workspace to find a fetch due writes the row every other workspace then
 * reads. The loop exists because the CONFIGURATION is per-org: which provider
 * to ask, how often, and with whose credential. In practice this means one
 * request per period for the whole deployment, not one per workspace — which is
 * what keeps a free, keyless, unmetered endpoint willing to keep serving us.
 *
 * ---- What it may and may not do --------------------------------------------
 *
 * IT FETCHES PUBLIC RATES AND WRITES SNAPSHOTS. It never touches a board, a
 * task, a goal or an amount. Money is converted at RENDER time from these rows;
 * nothing here rewrites a figure anybody entered, which is why a bug in this
 * file can make money render in the wrong currency but can never change what
 * the product believes an invoice is worth.
 */

// Seventeen past the hour, so it does not contend with the connector passes on
// the hour or the digest runners at :00/:15.
const CRON_EXPRESSION = '17 * * * *';

let started = false;

/**
 * One pass over every workspace.
 *
 * Errors are recorded on the org and swallowed, never thrown: one workspace
 * with a rejected API key must not stop the keyless default working for
 * everybody else, and a rate refresh is not worth crashing a tick over.
 */
const tick = async () => {
  const orgs = await Organisation.find({}).select('_id name').lean();

  for (const org of orgs) {
    try {
      const result = await refreshIfDue(org._id);
      if (!result.skipped) {
        console.log(
          `[fx] ${org.name}: stored ${result.count} rates for ${result.dayKey} via ${result.provider}`
        );
        // One fetch serves everyone, so once a period's snapshot exists every
        // remaining workspace will report `already-current` and skip.
        if (result.opening && result.opening.dayKey) {
          console.log(`[fx] ${org.name}: month opening ${result.opening.requested} -> ${result.opening.dayKey}`);
        } else if (result.opening && result.opening.error) {
          // Not recorded on the org: the latest fetch worked, which is what the
          // settings screen reports on. The boot pass retries a missing opening.
          console.warn(`[fx] ${org.name}: month opening ${result.opening.requested}:`, result.opening.error);
        }
      }
    } catch (err) {
      const display = err instanceof FxError ? err.toDisplay() : 'Could not fetch exchange rates.';
      // Recorded where the person who can fix it will see it — the Currency
      // settings tab reads `fx.lastError`. A rejected key is a sentence on a
      // settings screen, not a line in a log nobody reads.
      await Organisation.updateOne(
        { _id: org._id },
        { $set: { 'fx.lastError': display } }
      ).catch(() => {});
      console.error(`[fx] ${org.name}:`, display);
    }
  }
};

/**
 * How long after boot the first pass runs.
 *
 * ---- Why there is a pass at boot at all ------------------------------------
 *
 * The cron fires at :17. A deploy at :18 on a fresh database therefore had NO
 * snapshot for up to an hour, and every reader who had chosen a display
 * currency saw figures silently left in their source unit for that hour. One
 * pass at startup closes the gap. It costs nothing when snapshots already
 * exist: `refreshIfDue` skips a workspace whose period is current.
 *
 * Delayed rather than immediate so it does not compete with the boot itself
 * (index builds, the other runners' first ticks), and `unref`'d so a process
 * that is otherwise done — a script that happened to load this — is not held
 * open for it.
 */
const STARTUP_DELAY_MS = 20_000;

/**
 * How far back the boot pass reaches when history is shallow — the same two
 * years `scripts/backfillFxSnapshots.js` defaults to. Monthly, so at most one
 * request per month: twenty-five, once.
 */
const BACKFILL_MONTHS = 24;

/**
 * Failures in a row after which the boot pass stops asking. The provider is
 * down, or this plan does not serve history; either way the next day will fail
 * like the last three did, and the next boot can try again.
 */
const BACKFILL_MAX_FAILURES_IN_A_ROW = 3;

/**
 * How many workspaces' providers the boot pass will try before giving up. The
 * rows are global, so it needs exactly ONE workspace whose provider can answer;
 * it moves on only past a workspace whose provider cannot be asked at all (a
 * keyed provider with no key), and a deployment with hundreds of those should
 * not spend its boot finding that out one by one.
 */
const BACKFILL_MAX_ORGS = 5;

let bootBackfillRan = false;

/**
 * Which days the boot pass asks about, given the day keys already held. Pure.
 *
 *   - SHALLOW history (`isShallowHistory`): the first of each of the last
 *     `BACKFILL_MONTHS` months, and this month's — what `backfillFxSnapshots`
 *     would fetch if somebody had remembered to run it;
 *   - otherwise: only this month's first, which covers a deploy that lands
 *     mid-month on a database whose monthly fetch already ran on the 25th.
 *
 * Either list is then narrowed to days not already answered (`backfillPlan`,
 * with the publication slack: a snapshot filed on the Friday before a Sunday
 * the 1st IS that 1st's answer). On a healthy history the result is empty and
 * the pass costs one index-only read.
 */
const bootBackfillDays = (heldDayKeys, { now = new Date(), months = BACKFILL_MONTHS } = {}) => {
  const shallow = isShallowHistory(heldDayKeys, { today: todayKey(now) });
  const wanted = daysToFetch({ months: shallow ? months : 0, now });
  return { shallow, days: backfillPlan(wanted, heldDayKeys, { slack: PUBLICATION_SLACK_DAYS }) };
};

/**
 * The one-time history backfill, run after the boot tick.
 *
 * ---- Why the runner does this and not only a script ------------------------
 *
 * Because nobody runs the script. A record converts at the newest snapshot at or
 * before its own day and never reaches forward, so on a deployment whose first
 * fetch was today, every invoice raised before today rendered unconverted — the
 * rates to fix it are one keyless request per month away, and the only thing in
 * the way was a command somebody had to know about.
 *
 * ---- Why it cannot hurt a boot ---------------------------------------------
 *
 * Once per process (`bootBackfillRan`), bounded (one request per month of
 * `BACKFILL_MONTHS`, stopping after `BACKFILL_MAX_FAILURES_IN_A_ROW`), sequential, and it
 * never throws for a provider failure — `backfillHistory` reports instead. It
 * writes nothing to the workspace either: `fx.lastError` is what the settings
 * screen shows about the LATEST rate, and a history gap is not that.
 */
const bootBackfill = async ({ now = new Date(), log = console.log } = {}) => {
  if (bootBackfillRan) return { skipped: true, reason: 'already-ran' };
  bootBackfillRan = true;

  const held = (await FxSnapshot.find({ base: FX_BASE }).select('dayKey -_id').lean()).map(
    (r) => r.dayKey
  );
  const { shallow, days } = bootBackfillDays(held, { now });
  if (days.length === 0) return { skipped: true, reason: 'history-ok', shallow };

  const orgs = await Organisation.find({}).select('_id name').limit(BACKFILL_MAX_ORGS).lean();
  for (const org of orgs) {
    const result = await backfillHistory({
      orgId: org._id,
      days,
      maxConsecutiveFailures: BACKFILL_MAX_FAILURES_IN_A_ROW,
    });
    // This workspace's provider cannot be asked (a keyed provider with no key)
    // and nothing landed — another workspace's may be the keyless default.
    if (result.stopped === 'needs-config' && result.stored === 0) continue;

    if (result.stored) {
      log(`[fx] backfilled ${result.stored} of ${days.length} historical snapshot(s) via ${org.name}`);
    }
    if (result.stopped) {
      console.warn(`[fx] history backfill stopped (${result.stopped}):`, result.lastError);
    }
    return { skipped: false, shallow, orgId: org._id, ...result };
  }
  return { skipped: true, reason: 'no-usable-provider', shallow };
};

const startFxRateRunner = () => {
  if (started) return;
  started = true;
  cron.schedule(CRON_EXPRESSION, () => {
    tick().catch((err) => console.error('[fx] tick error:', err));
  });
  // Tick FIRST, so the latest rate is on file before any history is asked for:
  // a reader who opens the app during the backfill converts today's figures
  // straight away. Each step is caught on its own — a provider that is down
  // must cost the boot a log line, never the process.
  const boot = setTimeout(async () => {
    try {
      await tick();
    } catch (err) {
      console.error('[fx] startup tick error:', err);
    }
    try {
      await bootBackfill();
    } catch (err) {
      console.error('[fx] history backfill error:', err);
    }
  }, STARTUP_DELAY_MS);
  if (typeof boot.unref === 'function') boot.unref();
  console.log('fx rate runner started');
};

module.exports = {
  startFxRateRunner,
  tick,
  bootBackfill,
  bootBackfillDays,
  CRON_EXPRESSION,
  STARTUP_DELAY_MS,
  BACKFILL_MONTHS,
};
