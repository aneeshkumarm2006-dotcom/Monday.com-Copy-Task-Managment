const DfsTask = require('../../../models/DfsTask');
const B = require('../budget');
const C = require('./constants');
const { KINDS } = require('./kinds');
const { RUNNERS } = require('./screens');
const serpCache = require('./serpCache');

/**
 * What this board's collections have cost, and what is still owed to us.
 *
 * ---- The rule this file inherits -------------------------------------------
 *
 * IT NEVER CONTACTS A PROVIDER. Every number below is read out of `DfsTask`,
 * which is our own ledger of what we posted and what we were charged. The
 * temptation is `/v3/appendix/user_data`, which returns the live account balance
 * for free — and it is still wrong here, for two reasons that both matter: that
 * balance is the WHOLE SHARED ACCOUNT across every organisation on it, so it
 * answers a question this screen is not asking; and a read endpoint that reaches
 * a provider is one browser tab away from being a rate limit. The balance is
 * written once per sync pass onto `ConnectorAccount.lastSeenQuota`, is
 * documented there as display-only, and is read from that row if it is wanted.
 *
 * ---- The distinction the copy must not blur --------------------------------
 *
 * There are two timestamps here and they mean different things:
 *
 *   `postedAt` / `costUsd`  — WHEN WE WERE CHARGED. DataForSEO bills at post.
 *   `readyAt`               — when WE OBSERVED a result. Diagnostics only.
 *
 * A "last collected" line built from `readyAt` and captioned as spend would
 * report the ten-minute sweep — which cannot spend money by construction — as
 * the thing that took the money. `DfsTask.costUsd` and `ConnectorBudget` are the
 * money. Nothing else is.
 */

/** How many months of ledger the screen draws by default. */
const DEFAULT_MONTHS = 6;

/** A hard ceiling, so one request cannot walk the whole collection. */
const MAX_TASK_ROWS = 2000;

/** How many in-flight jobs the panel lists. A wall of rows is not a status. */
const MAX_IN_FLIGHT_ROWS = 50;

const round6 = (n) => Math.round((Number(n) || 0) * 1e6) / 1e6;

/**
 * The `YYYY-MM` keys the screen draws, newest first.
 *
 * Built from the same `monthKeyFor` the budget documents are keyed on, so a
 * column on this screen and a `ConnectorBudget` row are guaranteed to be talking
 * about the same month. Two spellings of "this month" is how a spend chart ends
 * up one column out of step with the cap it is drawn against.
 *
 * @param {number} count
 * @param {Date} [now]
 * @returns {string[]}
 */
const monthKeys = (count, now = new Date()) => {
  const keys = [];
  const cursor = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0)
  );
  for (let i = 0; i < count; i += 1) {
    keys.push(B.monthKeyFor(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() - 1);
  }
  return keys;
};

/**
 * Which month a task's MONEY belongs to.
 *
 * `postedAt`, never `readyAt` and never `createdAt`. The charge happens at post;
 * a job posted on 31 August and collected on 1 September is August's money, and
 * filing it under the collection would move spend across a month boundary and
 * make this ledger disagree with `ConnectorBudget` — which reserves against the
 * period key computed at reserve time, which is post time.
 *
 * A row with no `postedAt` was never posted (a claim that failed before the HTTP
 * call), so it has no month and no cost, and it is skipped rather than filed
 * under today.
 *
 * @param {Object} task
 * @returns {string|null}
 */
const moneyMonthOf = (task) =>
  task && task.postedAt ? B.monthKeyFor(new Date(task.postedAt)) : null;

/**
 * The provider's `describeUsage` hook.
 *
 * Called by `connectorDataController.getConnectorUsage` through the DESCRIPTOR,
 * so the generic controller never learns that one of its providers has a task
 * queue — the same seam `queuedCount` already uses. A provider without one
 * declares nothing and the controller answers with the budget alone.
 *
 * @param {Object} args
 * @param {Array<Object>} args.projects - the board's ConnectorProject rows
 * @param {number} [args.months]
 * @param {Date} [args.now]
 * @returns {Promise<Object>}
 */
const describeUsage = async ({
  projects = [],
  months = DEFAULT_MONTHS,
  now = new Date(),
} = {}) => {
  const wantedMonths = Math.min(Math.max(Number(months) || DEFAULT_MONTHS, 1), 24);
  const keys = monthKeys(wantedMonths, now);
  const oldest = keys[keys.length - 1];

  const projectIds = projects.map((p) => p._id).filter(Boolean);

  const shell = {
    runners: RUNNERS,
    /** The purchase clock's own cadence, so the screen need not re-derive it. */
    cadence: KINDS.map((k) => ({
      key: k.key,
      label: k.label,
      intervalHours: k.intervalHours,
      /** Null on a live kind — `depth` is a SERP parameter and Labs has none. */
      depth: k.depth ?? null,
      /**
       * Which of the two shapes this kind is. The screen needs it because the
       * two answer "when was I charged" differently: a `task` kind is charged at
       * post and collected free minutes later, while a `live` kind is charged
       * and delivered in the same call — so an in-flight row means something
       * quite different in each case.
       */
      transport: k.transport || 'task',
      /** Below this the fetcher refuses to re-buy, whatever a board asked for. */
      minRebuyHours: k.minRebuyHours ?? null,
    })),
    months: keys.map((periodKey) => ({
      periodKey,
      spentUsd: 0,
      reservedUsd: 0,
      tasks: 0,
      keywords: 0,
      /** Collections that happened without a purchase. See `DfsTask.source`. */
      cacheServed: 0,
    })),
    byKind: [],
    queued: 0,
    dead: 0,
    inFlight: [],
    lastPostedAt: null,
    lastObservedAt: null,
    /** True while nothing on this deployment can be billed at all. */
    sandbox: C.IS_SANDBOX,
    /**
     * PHASE 11'S MEASUREMENT, which is the whole reason it is on this screen.
     *
     * The plan gates the cross-tenant cache on a measured hit rate and phase 2's
     * evidence was a `console.log` on a dyno. A number nobody can see is a number
     * nobody decides from, so it is drawn here — beside the spend it would be a
     * discount on, per kind, next to the threshold it is being compared against.
     */
    cache: await serpCache.summarise({ projects, now }),
    truncated: false,
  };

  if (!projectIds.length) return shell;

  /**
   * One bounded read.
   *
   * Scoped to this board's projects, to the months on screen PLUS everything
   * still open — an open job posted before the window is exactly the row the
   * in-flight panel exists to show. Sorted newest first and capped, because an
   * account running for a year holds thousands of rows and this screen draws a
   * dozen numbers. `select` keeps the `request` blob and the `items[]` ledger
   * off the wire; neither is summarised here.
   */
  const rows = await DfsTask.find({
    project: { $in: projectIds },
    $or: [
      { postedAt: { $gte: new Date(`${oldest}-01T00:00:00.000Z`) } },
      { state: 'open' },
    ],
  })
    .select(
      'project kind variant state source budgetState attempt keywords estimateUsd costUsd postedAt expiresAt readyAt closedAt note'
    )
    .sort({ postedAt: -1 })
    .limit(MAX_TASK_ROWS)
    .lean();

  const byMonth = new Map(
    keys.map((k) => [
      k,
      { periodKey: k, spentUsd: 0, reservedUsd: 0, tasks: 0, keywords: 0, cacheServed: 0 },
    ])
  );
  const byKind = new Map();

  let queued = 0;
  let dead = 0;
  let lastPostedAt = null;
  let lastObservedAt = null;
  const inFlight = [];

  const projectNameById = new Map(
    projects.map((p) => [
      String(p._id),
      p.name || p.domain || String(p.externalId || ''),
    ])
  );

  for (const row of rows) {
    const keywordCount = Array.isArray(row.keywords) ? row.keywords.length : 0;

    /**
     * A collection the shared cache answered. A REAL COLLECTION WITH NO MONEY
     * BEHIND IT, so it is counted apart from both spend and purchases: folded
     * into `tasks` it would report a board ordering collections it never
     * ordered, at a per-collection cost of zero, which reads as a price cut;
     * dropped entirely it would report a board collecting less often than it
     * does. Zero of these exist unless somebody set `DATAFORSEO_SERP_CACHE_ORGS`.
     */
    const fromCache = row.source === 'cache';

    const month = moneyMonthOf(row);
    const bucket = month ? byMonth.get(month) : null;
    if (bucket && fromCache) {
      bucket.cacheServed += 1;
    } else if (bucket) {
      bucket.spentUsd = round6(bucket.spentUsd + (row.costUsd || 0));
      /**
       * Money HELD, shown apart from money SPENT.
       *
       * A `reserving` row is a reservation whose post has not settled yet. It is
       * recoverable — `reconcileReservations` gives it back when a pass dies
       * holding it — so adding it to spend would report a crash as a purchase
       * and then quietly un-report it ten minutes later.
       */
      if (row.budgetState === 'reserving') {
        bucket.reservedUsd = round6(bucket.reservedUsd + (row.estimateUsd || 0));
      }
      bucket.tasks += 1;
      bucket.keywords += keywordCount;
    }

    if (!byKind.has(row.kind)) {
      byKind.set(row.kind, {
        kind: row.kind,
        spentUsd: 0,
        tasks: 0,
        keywords: 0,
        cacheServed: 0,
      });
    }
    const k = byKind.get(row.kind);
    if (fromCache) {
      k.cacheServed += 1;
    } else {
      k.spentUsd = round6(k.spentUsd + (row.costUsd || 0));
      k.tasks += 1;
      k.keywords += keywordCount;
    }

    /**
     * "Last charged", and a cache-served row was never charged. Its `postedAt`
     * is when the reading was ASSEMBLED, so letting it move this timestamp would
     * do exactly what this file's header forbids: credit a free path with the
     * money. Same distinction as `readyAt` below, one row further down.
     */
    if (!fromCache && row.postedAt && (!lastPostedAt || row.postedAt > lastPostedAt)) {
      lastPostedAt = row.postedAt;
    }
    if (row.readyAt && (!lastObservedAt || row.readyAt > lastObservedAt)) {
      lastObservedAt = row.readyAt;
    }

    if (row.state === 'open') {
      queued += 1;
      inFlight.push({
        project: String(row.project),
        projectName: projectNameById.get(String(row.project)) || '',
        kind: row.kind,
        variant: row.variant,
        keywords: keywordCount,
        attempt: row.attempt || 1,
        postedAt: row.postedAt || null,
        expiresAt: row.expiresAt || null,
        /** Announced by `tasks_ready`. OUR observation, never a charge. */
        observedAt: row.readyAt || null,
        costUsd: row.costUsd || 0,
      });
    }
    if (row.state === 'dead') dead += 1;
  }

  return {
    ...shell,
    months: keys.map((key) => byMonth.get(key)),
    byKind: [...byKind.values()].sort((a, b) => b.spentUsd - a.spentUsd),
    queued,
    dead,
    inFlight: inFlight
      .sort((a, b) => new Date(b.postedAt || 0) - new Date(a.postedAt || 0))
      .slice(0, MAX_IN_FLIGHT_ROWS),
    lastPostedAt,
    lastObservedAt,
    truncated: rows.length >= MAX_TASK_ROWS,
  };
};

module.exports = {
  describeUsage,
  monthKeys,
  moneyMonthOf,
  DEFAULT_MONTHS,
  MAX_TASK_ROWS,
  MAX_IN_FLIGHT_ROWS,
};
