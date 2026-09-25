const cron = require('node-cron');
const Organisation = require('../models/Organisation');
const { refreshIfDue } = require('./fx/rateService');
const { FxError } = require('./fx/errors');

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

const startFxRateRunner = () => {
  if (started) return;
  started = true;
  cron.schedule(CRON_EXPRESSION, () => {
    tick().catch((err) => console.error('[fx] tick error:', err));
  });
  console.log('fx rate runner started');
};

module.exports = { startFxRateRunner, tick, CRON_EXPRESSION };
