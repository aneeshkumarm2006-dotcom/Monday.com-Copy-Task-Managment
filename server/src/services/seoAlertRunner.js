const cron = require('node-cron');
const Board = require('../models/Board');
const BoardConnector = require('../models/BoardConnector');
const ConnectorProject = require('../models/ConnectorProject');
const ConnectorSnapshot = require('../models/ConnectorSnapshot');
const Organisation = require('../models/Organisation');
const { getConnector, listConnectors } = require('./connectors');
const { createNotificationsForUsers } = require('./notificationService');
const { usersWithBoardCapability } = require('../utils/boardAudience');

/**
 * The SEO alert pass.
 *
 * A direct sibling of [goalReminderRunner.js](./goalReminderRunner.js) — same
 * `node-cron` dependency, same module-level `started` guard, same
 * start-from-server.js shape, same claim-first-then-work ordering.
 *
 * ---- What it may and may not do --------------------------------------------
 *
 * IT READS SNAPSHOTS AND WRITES NOTIFICATIONS. It contacts no provider, holds no
 * session, and cannot spend a cent — which is why it is a plain cron rather than
 * something hung off a connector client's `runOnce` the way the reservation
 * reconciler is. Everything it reads was bought by the collection pass hours
 * earlier and is sitting in `ConnectorSnapshot`.
 *
 * That constraint is what makes the cadence free. It runs hourly, thirteen
 * minutes after the buying pass, so an alert lands within an hour of the reading
 * that caused it rather than a day later.
 *
 * ---- Why the rule lives on the DESCRIPTOR and the delivery lives here -------
 *
 * `connector.alerts.evaluate` is the provider's business: it knows what a rank
 * is, what depth means, and which pairs of readings may be subtracted. Who gets
 * told, whether they have muted the category, and whether this exact reading has
 * already been announced are all generic. So this file names no provider and no
 * kind — it iterates whichever connectors declare an `alerts` hook, and a
 * provider that declares none is invisible to it.
 *
 * ---- The three gates, in order ---------------------------------------------
 *
 * 1. THE BOARD SWITCHED THE CONNECTOR ON (`BoardConnector.enabled`).
 * 2. THE BOARD SWITCHED THE ALERTS SCREEN ON (`enabledScreens`, resolved through
 *    the descriptor so "empty means everything" and "always-on" are the
 *    provider's rules and not ours).
 * 3. THE PERSON HAS NOT MUTED THE CATEGORY — which is `notificationService`'s
 *    job and happens inside `createNotificationsForUsers`, gated on the `seo`
 *    category. That third gate only exists because the two alert types are
 *    MAPPED in `TYPE_CATEGORY`; an unmapped type would sail straight past it.
 */

const SCREEN_KEY = 'alerts';
let started = false;

/**
 * The claim key for one (rule, project, variant).
 *
 * Composed rather than hashed, so somebody reading a `BoardConnector` document
 * in a shell can see which alert was last sent about which site. Dots are what
 * would break a Mongo update path, and none of the three parts can contain one:
 * a rule key is `[a-z_]`, an id is hex, a variant is `2840|en|desktop`.
 */
const claimKey = (rule, projectId, variant) =>
  `${rule}|${String(projectId)}|${variant || 'default'}`;

/**
 * The newest reading of each kind for one project, and the one before it.
 *
 * ---- Two rules that make the pair honest ------------------------------------
 *
 * ONLY `ok` ROWS. A `partial` reading is a short collection, and half a keyword
 * list compared with a whole one reports every missing keyword as having fallen
 * out of the rankings — which is the single most alarming false alarm this
 * feature could produce.
 *
 * ONE VARIANT AT A TIME. A US rank and a UK rank are two facts, and the newest
 * two rows of a two-market site are one reading from each — subtracting them
 * compares countries and reports the difference as movement. So the rows are
 * grouped by `(kind, variant)` before anything is paired.
 *
 * @param {Object} project
 * @returns {Promise<Map<string, {variant: string, kind: string, current: Object,
 *   previous: Object|null}>>}
 */
const pairsFor = async (project) => {
  const rows = await ConnectorSnapshot.find({ project: project._id, status: 'ok' })
    .select('kind variant periodKey collectedAt status data')
    .sort({ periodKey: -1, fetchedAt: -1 })
    .limit(400)
    .lean();

  const pairs = new Map();
  for (const row of rows) {
    const key = `${row.kind}|${row.variant}`;
    const held = pairs.get(key);
    if (!held) {
      pairs.set(key, { kind: row.kind, variant: row.variant, current: row, previous: null });
      continue;
    }
    if (!held.previous) held.previous = row;
  }
  return pairs;
};

/**
 * Group the pairs by VARIANT, so one evaluation sees one market's readings.
 *
 * `evaluateAll` takes `{snapshots, previousSnapshots}` keyed by kind — the same
 * shape `connectorDataController` hands the screen, deliberately, so the runner
 * and the screen are asking the identical question of the identical function.
 */
const byVariant = (pairs) => {
  const out = new Map();
  for (const pair of pairs.values()) {
    if (!out.has(pair.variant)) {
      out.set(pair.variant, { snapshots: {}, previousSnapshots: {} });
    }
    const bucket = out.get(pair.variant);
    bucket.snapshots[pair.kind] = pair.current;
    if (pair.previous) bucket.previousSnapshots[pair.kind] = pair.previous;
  }
  return out;
};

/**
 * Claim one alert, atomically.
 *
 * @returns {Promise<boolean>} true when THIS process won the claim
 */
const claim = async (boardConnectorId, key, periodKey) => {
  const path = `alertState.${key}`;
  const won = await BoardConnector.findOneAndUpdate(
    { _id: boardConnectorId, [path]: { $ne: periodKey } },
    { $set: { [path]: periodKey } },
    { new: false }
  ).lean();
  return !!won;
};

/**
 * Run every armed rule for one board's connector.
 *
 * @param {Object} link - a `BoardConnector` row
 * @param {Object} connector - the descriptor
 */
const alertOne = async (link, connector) => {
  /**
   * THE SCREEN GATE, resolved through the descriptor rather than by reading the
   * array. An empty selection means EVERYTHING and an always-on screen comes
   * back regardless — both of those are the provider's rules, and re-deriving
   * them here is how a board that has expressed no opinion silently stops
   * getting alerts.
   */
  const screens =
    typeof connector.resolveScreens === 'function'
      ? connector.resolveScreens(link.enabledScreens || [])
      : [];
  if (!screens.some((s) => s.key === SCREEN_KEY)) return;

  const board = await Board.findById(link.board).select(
    '_id name organisation visibility publicDefaultLevel memberAccess createdBy'
  );
  if (!board) return;

  const projects = await ConnectorProject.find({
    board: board._id,
    provider: link.provider,
    group: { $ne: null },
  })
    .select('_id name domain organisation')
    .lean();
  if (!projects.length) return;

  let recipients = null;

  for (const project of projects) {
    // eslint-disable-next-line no-await-in-loop
    const pairs = await pairsFor(project);
    if (!pairs.size) continue;

    for (const [variant, readings] of byVariant(pairs)) {
      const siteLabel = project.name || project.domain || board.name;
      const results = connector.alerts.evaluate({
        snapshots: readings.snapshots,
        previousSnapshots: readings.previousSnapshots,
        label: `${board.name} · ${siteLabel}`,
      });

      for (const result of results) {
        if (!result.fired || !result.message || !result.periodKey) continue;

        const key = claimKey(result.rule, project._id, variant);
        // eslint-disable-next-line no-await-in-loop
        const mine = await claim(link._id, key, result.periodKey);
        /**
         * Somebody already told them about this reading — this hour, this
         * morning, or on another instance. Without this the same drop is a
         * notification every hour until a new snapshot lands, which is a week.
         */
        if (!mine) continue;

        if (recipients === null) {
          // eslint-disable-next-line no-await-in-loop
          const org = await Organisation.findById(board.organisation).select(
            'admin admins members roles memberRoles'
          );
          if (!org) return;
          /**
           * A workspace predating the role system resolves every capability to
           * false, which would silently mean zero recipients. The same lazy heal
           * `goalReminderRunner` and `loadBoardContext` do on first touch.
           */
          // eslint-disable-next-line no-await-in-loop
          if (org.ensureSystemRoles?.()) await org.save();
          recipients = usersWithBoardCapability(board, org, 'connector.view');
        }
        if (!recipients.length) return;

        // eslint-disable-next-line no-await-in-loop
        await createNotificationsForUsers({
          userIds: recipients,
          type: result.type,
          message: result.message,
          orgId: board.organisation,
          boardId: board._id,
          /**
           * NO ACTOR. Nobody did this; a robot noticed it. The bell falls back
           * to the type icon, which is what `notificationMeta` is for.
           */
          actorId: null,
          /**
           * Not a task-panel tab — a board VIEW. An alert is about a site, not a
           * row, so it opens the SEO tab.
           */
          tab: 'seo',
        });
      }
    }
  }
};

const tick = async () => {
  /**
   * Which providers have anything to say. A descriptor with no `alerts` hook is
   * not queried for at all, so this pass costs one `BoardConnector` query on a
   * deployment where nothing declares alerts.
   */
  const providers = listConnectors()
    .map((c) => c.name)
    .filter((name) => typeof getConnector(name)?.alerts?.evaluate === 'function');
  if (!providers.length) return;

  let links;
  try {
    links = await BoardConnector.find({
      enabled: true,
      provider: { $in: providers },
    }).select('_id board provider enabledScreens alertState');
  } catch (err) {
    console.error('[seoAlerts] failed to query board connectors:', err);
    return;
  }

  for (const link of links) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await alertOne(link, getConnector(link.provider));
    } catch (err) {
      console.error('[seoAlerts] failed for board', link?.board?.toString(), err);
    }
  }
};

const startSeoAlertRunner = () => {
  if (started) return;
  started = true;
  /**
   * Read off the descriptor's own constant rather than typed here, so the
   * cadence and the reasoning for it live in one file. See
   * `dataforseo/constants.ALERT_CRON_EXPRESSION`.
   */
  const expression =
    // eslint-disable-next-line global-require
    require('./connectors/dataforseo/constants').ALERT_CRON_EXPRESSION;
  cron.schedule(expression, () => {
    tick().catch((err) => console.error('[seoAlerts] tick error:', err));
  });
  console.log('seo alert runner started');
};

module.exports = { startSeoAlertRunner, tick, alertOne, pairsFor, byVariant, claimKey };
