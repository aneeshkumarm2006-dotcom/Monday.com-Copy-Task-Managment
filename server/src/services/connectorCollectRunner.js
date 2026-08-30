const cron = require('node-cron');
const ConnectorProject = require('../models/ConnectorProject');
const { CONNECTOR_PROVIDERS } = require('../utils/connectorProviders');
const { getConnector } = require('./connectors');
const { announceBoards } = require('./connectorSyncRunner');
const { writeBackForProjects } = require('./connectorGoalWriteback');

/**
 * The collection-only tick — every ten minutes, and it cannot spend a cent.
 *
 * ---- Why there are two runners and not one faster one -----------------------
 *
 * `connectorSyncRunner` decides what to BUY. It resolves boards, cadences and
 * keyword lists, asks whether a reading is stale, and purchases when it is. That
 * is why it runs hourly: running it every ten minutes would be six chances an
 * hour to conclude that something is stale and spend money on it, and the whole
 * `DfsTask` design exists because this provider bills at POST.
 *
 * Collecting is a completely different act. It starts from rows that are already
 * `state: 'open'` — work already paid for — and asks a free endpoint whether the
 * answer has arrived. DataForSEO's Standard queue answers in ~5 minutes, so
 * folding collection into an hourly tick was costing ~30 minutes of median
 * latency for no reason at all: a result that landed at :20 sat there until
 * :17 the following hour.
 *
 * Splitting them means the fast clock is attached to the half that has nothing
 * to spend. That is the design property, and it is worth stating plainly:
 *
 *   THE FREQUENT RUNNER CANNOT BUY, AND THE RUNNER THAT CAN BUY IS NOT FREQUENT.
 *
 * ---- What makes "cannot buy" structural rather than a promise ---------------
 *
 * The provider hook this calls (`descriptor.collectReady`) runs behind a client
 * whose transport REFUSES any endpoint that is not free — see
 * `services/connectors/dataforseo/collect.js`, which sets out the four
 * independent barriers. Nothing here passes a `force`, a kind list, a board or a
 * cadence, because there is no argument this runner could pass that would cause
 * a purchase.
 *
 * ---- Why it is a descriptor hook and not a DataForSEO import ----------------
 *
 * Same reason `reconcile` and `queuedCount` are. Only one provider buys work
 * asynchronously today; a provider that answers in the same HTTP call has
 * nothing to collect later and simply does not declare the hook, and this file
 * never learns which is which. Ubersuggest is untouched by construction.
 *
 * The overlap guard, the `started` flag and the shape of `tick()` are copied
 * from `connectorSyncRunner` deliberately — two runners that look different
 * invite the question of which one is right.
 */

const CRON_EXPRESSION = '*/10 * * * *';
let started = false;
let running = false;

/**
 * One collection pass over every provider that buys work asynchronously.
 *
 * Returns the reports rather than logging only, so a test and a future operator
 * endpoint can both read the numbers.
 *
 * @param {Object} [opts]
 * @param {Date} [opts.now]
 * @returns {Promise<Array<Object>>}
 */
const tick = async ({ now = new Date() } = {}) => {
  const reports = [];
  const touchedBoards = new Set();

  for (const provider of CONNECTOR_PROVIDERS) {
    const connector = getConnector(provider);
    if (!connector || typeof connector.collectReady !== 'function') continue;

    let report;
    try {
      // eslint-disable-next-line no-await-in-loop
      report = await connector.collectReady({ now });
    } catch (err) {
      // One provider's collector failing says nothing about the next one's, and
      // this runs unattended every ten minutes — a throw here would be a log
      // line every ten minutes and a process nobody restarts.
      console.error(`[connectorCollect] ${provider} pass failed:`, err);
      continue;
    }
    if (!report) continue;
    reports.push({ provider, ...report });

    if (report.written > 0 && report.projectIds?.length) {
      /**
       * The same two follow-ups the hourly pass does when a row lands, and for
       * the same reasons — otherwise a snapshot collected at :10 would show the
       * new rank in the connector tab while the goal cell beside it still held
       * last week's number until :17 of the following hour.
       *
       * Both read our own database only. Neither can spend anything, and
       * `writeBackForProjects` never throws.
       */
      // eslint-disable-next-line no-await-in-loop
      const rows = await ConnectorProject.find({ _id: { $in: report.projectIds } })
        .select('board')
        .lean();
      rows.forEach((r) => r.board && touchedBoards.add(String(r.board)));

      // eslint-disable-next-line no-await-in-loop
      const writebacks = await writeBackForProjects(report.projectIds, {
        provider,
        now,
      });
      const filled = writebacks.reduce((s, r) => s + r.written, 0);
      const offered = writebacks.reduce((s, r) => s + r.suggested, 0);
      if (filled || offered) {
        console.log(
          `[connectorCollect] ${provider}: ${filled} goal cell(s) filled, ${offered} suggested`
        );
      }
    }

    // Silent when there was nothing to do, which is most ticks — this runs six
    // times an hour and a line per tick would bury everything else in the log.
    if (report.collected || report.written || report.failed) {
      console.log(
        `[connectorCollect] ${provider}: ${report.collected} collected, ` +
          `${report.written} written, ${report.pending} still queued, ` +
          `${report.failed} failed`
      );
    }
  }

  if (touchedBoards.size) await announceBoards(touchedBoards);
  return reports;
};

const startConnectorCollectRunner = () => {
  if (started) return;
  started = true;
  cron.schedule(CRON_EXPRESSION, () => {
    if (running) {
      // A slow pass is still going. Skipping is correct rather than queueing:
      // ten minutes from now the same rows will still be open and will be picked
      // up then, and two collectors polling one account is politeness spent for
      // nothing.
      console.warn('[connectorCollect] previous pass still running; skipping this tick');
      return;
    }
    running = true;
    tick()
      .catch((err) => console.error('[connectorCollect] tick error:', err))
      .finally(() => {
        running = false;
      });
  });
  console.log('connector collect runner started');
};

module.exports = { startConnectorCollectRunner, tick, CRON_EXPRESSION };
