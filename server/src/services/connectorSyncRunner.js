const cron = require('node-cron');
const ConnectorProject = require('../models/ConnectorProject');
const Board = require('../models/Board');
const Organisation = require('../models/Organisation');
const eventBus = require('./eventBus');
const { usersWithBoardCapability } = require('../utils/boardAudience');
const { CONNECTOR_PROVIDERS } = require('../utils/connectorProviders');
const { getConnector } = require('./connectors');
const {
  collectSnapshots,
  scheduleForProvider,
} = require('./connectors/snapshotService');
const { writeBackForProjects } = require('./connectorGoalWriteback');

/**
 * The unattended connector sync.
 *
 * A direct sibling of [goalReminderRunner.js](./goalReminderRunner.js) and
 * [automationRunner.js](./automationRunner.js): same `node-cron`, same
 * module-level `started` guard, same start-from-server.js shape.
 *
 * ---- Why the tick is hourly and the WORK is weekly -------------------------
 *
 * Ubersuggest collects rankings ONCE A WEEK on every plan — daily was withdrawn
 * in December 2025, and their own marketing page still says otherwise. Polling
 * faster returns byte-identical data and spends a quota shared by the whole
 * workspace to do it. So the cadence is weekly.
 *
 * But a weekly CRON is the wrong way to get a weekly cadence. Render restarts
 * this process on every deploy and on its own schedule, and a `0 4 * * 1` that
 * happens to be asleep at 04:00 on Monday does not run again until the following
 * Monday — a whole week of history missed, unrecoverably, with nothing in the
 * logs. So the tick is hourly and the DECISION is per (project, kind): the
 * snapshot service skips anything already collected inside the provider's
 * cadence, which means an hourly tick does no work 167 times out of 168 and
 * catches up the moment a missed window is noticed.
 *
 * The same property makes the runner safe to double-start and safe to run on two
 * instances: freshness is read from the snapshot rows, and the unique index on
 * (project, kind, variant, period) is the backstop when two ticks race.
 *
 * ---- The overlap guard -----------------------------------------------------
 *
 * A full pass can take minutes — an async rank report per project, sequential
 * per account because they share a quota. The hourly tick must not start a
 * second pass on top of a slow one, or both spend the same quota to write the
 * same rows. Same `running` flag as `inboundMailPoller.js`.
 */

const CRON_EXPRESSION = '17 * * * *'; // hourly, off the hour
let started = false;
let running = false;

/**
 * Tell everyone looking at a board that its connector data moved.
 *
 * `board.changed` is scoped to a single user — the SSE registry is keyed by user
 * id — so a background job has to fan out itself. `automationEventDispatcher`
 * pings only the person whose action triggered it, which is right for an
 * automation and wrong here: nobody triggered this, so the audience is everyone
 * who could be looking at the tab.
 *
 * Best effort throughout. A board we cannot load, or an org without roles, must
 * not fail a sync that already succeeded — the tab reconciles on its next load.
 */
const announceBoards = async (boardIds) => {
  for (const boardId of boardIds) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const board = await Board.findById(boardId)
        .select('_id organisation visibility publicDefaultLevel memberAccess createdBy')
        .lean();
      if (!board) continue;

      // NOT lean, for the same reason goalReminderRunner is not: a workspace
      // predating the role system resolves every capability to false, which
      // would silently mean zero recipients and a live refresh that never
      // arrives. Same lazy heal `loadBoardContext` does on first touch.
      // eslint-disable-next-line no-await-in-loop
      const org = await Organisation.findById(board.organisation).select(
        'admin admins members roles memberRoles'
      );
      if (!org) continue;
      // eslint-disable-next-line no-await-in-loop
      if (org.ensureSystemRoles?.()) await org.save();

      for (const userId of usersWithBoardCapability(board, org, 'connector.view')) {
        eventBus.emit('board.changed', { userId, boardId: String(boardId) });
      }
    } catch (err) {
      console.error('[connectorSync] could not announce board', String(boardId), err);
    }
  }
};

/**
 * One pass over one provider.
 *
 * Returns a report rather than logging one, so the manual path in the controller
 * can share this code and hand the numbers to a toast.
 *
 * @param {string} provider
 * @param {Object} [opts]
 * @param {Date} [opts.now]
 * @returns {Promise<Object|null>} null when there is nothing enabled anywhere
 */
const syncProvider = async (provider, { now = new Date() } = {}) => {
  const connector = getConnector(provider);
  // A provider that has not reached phase 3 yet is skipped rather than crashing
  // the tick for the ones that have. Both halves are checked: a descriptor with
  // a fetcher but no kind resolver is half-built, and finding that out inside
  // the loop would abandon whatever it had already collected.
  if (
    !connector ||
    typeof connector.fetch !== 'function' ||
    typeof connector.resolveKinds !== 'function'
  ) {
    return null;
  }

  const schedule = await scheduleForProvider(provider);
  if (!schedule.length) return null;

  const kindsByProject = new Map(
    schedule.map((e) => [String(e.project._id), e.kinds])
  );
  /**
   * The cadence each project's boards asked for, already reduced to a min by
   * `scheduleForProvider`. Null where nobody asked, which the snapshot service
   * turns back into the descriptor's own default.
   */
  const intervalByProject = new Map(
    schedule.map((e) => [String(e.project._id), e.intervalHours ?? null])
  );

  const report = await collectSnapshots({
    provider,
    projects: schedule.map((e) => e.project),
    // The board's own selection, resolved through the descriptor so
    // dependencies are pulled in and manual-only kinds stay out of an
    // unattended run. `includeManualOnly` is deliberately absent: starting a
    // site-audit crawl is somebody pressing a button, never a schedule.
    kindsFor: (project) =>
      connector.resolveKinds(kindsByProject.get(String(project._id))),
    // The sibling seam. Both answer a per-project question resolved from
    // BoardConnector rows, which is knowledge the snapshot service deliberately
    // does not have.
    intervalHoursFor: (project) =>
      intervalByProject.get(String(project._id)) ?? null,
    force: false,
    actorId: null, // nobody was watching
    now,
  });

  return report;
};

/**
 * One tick: every provider, then one round of live-refresh pings.
 */
const tick = async ({ now = new Date() } = {}) => {
  const touchedBoards = new Set();
  const reports = [];

  for (const provider of CONNECTOR_PROVIDERS) {
    let report;
    try {
      // eslint-disable-next-line no-await-in-loop
      report = await syncProvider(provider, { now });
    } catch (err) {
      console.error(`[connectorSync] ${provider} pass failed:`, err);
      continue;
    }
    if (!report) continue;
    reports.push({ provider, ...report });

    if (report.written > 0) {
      // Only boards whose projects actually gained a row. A pass that skipped
      // everything as already-current must not ping every open tab hourly — and
      // must not re-run the writeback on data that has not moved.
      const projectIds = report.accounts
        .flatMap((a) => a.projects || [])
        .filter((p) => p.written > 0)
        .map((p) => p.projectId);
      if (projectIds.length) {
        // eslint-disable-next-line no-await-in-loop
        const rows = await ConnectorProject.find({ _id: { $in: projectIds } })
          .select('board')
          .lean();
        rows.forEach((r) => r.board && touchedBoards.add(String(r.board)));

        /**
         * The goals, filled from what was just collected.
         *
         * Here rather than inside `collectSnapshots`, because collecting and
         * writing back are genuinely different jobs with different failure
         * modes: one spends a shared quota against a third party, the other
         * reads our own database. A writeback that throws must not make a
         * successful collection look like a failed one, which is why
         * `writeBackForProjects` never throws and this line is not in a try.
         *
         * NOBODY IS WATCHING, so the actor is null and the pass fills only the
         * result half of a goal. Anything under `config` is the promise, and a
         * schedule does not get to rewrite what a team told a client — it
         * records a suggestion and the row offers it. See the writeback header.
         */
        // eslint-disable-next-line no-await-in-loop
        const writebacks = await writeBackForProjects(projectIds, { provider, now });
        const filled = writebacks.reduce((s, r) => s + r.written, 0);
        const offered = writebacks.reduce((s, r) => s + r.suggested, 0);
        if (filled || offered) {
          console.log(
            `[connectorSync] ${provider}: ${filled} goal cell(s) filled, ${offered} suggested`
          );
        }
      }
    }

    // `queued` earns its place in the condition as well as in the line: a pass
    // that did nothing but poll a provider's outstanding requests wrote nothing
    // and failed nothing, and would otherwise log nothing at all — which is
    // indistinguishable in the logs from a connector that has stopped working.
    if (report.written || report.failed || report.queued) {
      console.log(
        `[connectorSync] ${provider}: ${report.written} written, ` +
          `${report.ok} collected, ${report.failed} failed, ${report.skipped} current` +
          (report.queued ? `, ${report.queued} queued` : '') +
          (report.quotaExhausted ? ' (quota exhausted on at least one account)' : '')
      );
    }
  }

  if (touchedBoards.size) await announceBoards(touchedBoards);
  return reports;
};

const startConnectorSyncRunner = () => {
  if (started) return;
  started = true;
  cron.schedule(CRON_EXPRESSION, () => {
    if (running) {
      // A pass is still going. Skipping is correct rather than queueing: the
      // next hour's tick will find whatever the slow pass did not reach still
      // stale, and will pick it up then.
      console.warn('[connectorSync] previous pass still running; skipping this tick');
      return;
    }
    running = true;
    tick()
      .catch((err) => console.error('[connectorSync] tick error:', err))
      .finally(() => {
        running = false;
      });
  });
  console.log('connector sync runner started');
};

module.exports = {
  startConnectorSyncRunner,
  tick,
  syncProvider,
  announceBoards,
  CRON_EXPRESSION,
};
