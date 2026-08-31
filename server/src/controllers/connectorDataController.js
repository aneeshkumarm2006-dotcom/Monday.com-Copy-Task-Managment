const mongoose = require('mongoose');

const ConnectorProject = require('../models/ConnectorProject');
const ConnectorSnapshot = require('../models/ConnectorSnapshot');
const BoardConnector = require('../models/BoardConnector');

const { getConnector } = require('../services/connectors');
const {
  collectSnapshots,
  projectsForBoard,
  writeSnapshot,
} = require('../services/connectors/snapshotService');
const { openSession } = require('../services/connectors/session');
const { describeBudget, monthKeyFor } = require('../services/connectors/budget');
const { runWriteback } = require('../services/connectorGoalWriteback');
const { isConnectorProvider } = require('../utils/connectorProviders');
const { gateBoard, publicProject } = require('./connectorController');

/**
 * The connector DATA plane — snapshots in, snapshots out.
 *
 * Split from `connectorController.js` deliberately. That file is the ACCOUNT and
 * ENABLEMENT plane: who may attach an external identity to the workspace, which
 * board has a connector switched on, which project feeds which group. This one
 * is about the readings themselves, and the two answer to different questions
 * often enough that keeping them apart is worth one extra file. The gate and the
 * public shapes are imported rather than copied — there is exactly one
 * `gateBoard`, and it stays that way.
 *
 * ---- The rule this file exists to hold -------------------------------------
 *
 * THE READ ENDPOINT NEVER CONTACTS A PROVIDER. Quota is finite and shared across
 * the entire workspace, and every person who opens this tab would otherwise
 * spend it — ten people with a browser open would exhaust the week on page
 * loads alone, and a third-party outage would put a blank tab in front of
 * someone looking at data we already hold. `getConnectorData` touches
 * `ConnectorSnapshot` and `ConnectorProject` and nothing else.
 *
 * Two things spend quota, both of them deliberate acts by a person or a
 * schedule: `refreshConnectorData` and `runConnectorAction`. Both sit on
 * `connector.manage`.
 */

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

/** How far back the tab looks when nobody says otherwise. */
const DEFAULT_HISTORY_DAYS = 90;

/** A hard ceiling on the history query, so one request cannot pull three years. */
const MAX_HISTORY_ROWS = 400;

/** `YYYY-MM-DD`, UTC. */
const dayKey = (date) => new Date(date).toISOString().slice(0, 10);

/**
 * Read a `YYYY-MM-DD` out of a query string.
 *
 * Rejects anything else rather than coercing. `new Date('last tuesday')` is
 * `Invalid Date`, and letting that through would silently widen the range to
 * everything.
 */
const parseDay = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : value;
};

/**
 * The window the tab is asking about.
 *
 * Note `to` is NOT clamped to today. A board looking at a month that has not
 * finished still wants the whole month's columns, and clamping would make the
 * chart's right edge move under the user as the month went on.
 */
const resolveRange = (query = {}, now = new Date()) => {
  const to = parseDay(query.to) || dayKey(now);
  if (query.from) {
    const from = parseDay(query.from);
    if (from) return { from: from <= to ? from : to, to };
  }
  const from = new Date(`${to}T00:00:00.000Z`);
  from.setUTCDate(from.getUTCDate() - DEFAULT_HISTORY_DAYS);
  return { from: dayKey(from), to };
};

/**
 * The public shape of a snapshot.
 *
 * Hand-built for the same reason `publicProject` is, and with the same one
 * omission: `raw` is the provider's payload verbatim, kept so a field the
 * normaliser missed is a code change rather than lost history, but it is bulky
 * and nothing renders it. Returned only when asked for, and only to somebody who
 * could re-fetch it anyway.
 */
const publicSnapshot = (snap, { includeRaw = false } = {}) => {
  if (!snap) return null;
  const out = {
    _id: snap._id,
    kind: snap.kind,
    variant: snap.variant,
    periodKey: snap.periodKey,
    collectedAt: snap.collectedAt || null,
    subject: snap.subject || '',
    status: snap.status,
    note: snap.note || '',
    data: snap.data ?? null,
    fetchedAt: snap.fetchedAt || null,
  };
  if (includeRaw) out.raw = snap.raw ?? null;
  return out;
};

/** The gate every handler here shares: board, capability, board type, provider. */
const gateProvider = async (req, res, capability) => {
  const { provider } = req.params;

  const ctx = await gateBoard(req, res, capability);
  if (!ctx) return null;

  const connector = isConnectorProvider(provider) ? getConnector(provider) : null;
  if (!connector) {
    res.status(400).json({ error: `Unknown connector "${provider}"` });
    return null;
  }
  // A provider that has not reached phase 3 yet exists, can be connected, and
  // has projects — it simply has no readings. Saying so beats a 500 from a null
  // `fetch`, and beats an empty tab with no explanation.
  if (!Array.isArray(connector.kinds)) {
    res.status(409).json({
      error: `${connector.label} cannot collect data yet.`,
      code: 'NO_DATA_SUPPORT',
    });
    return null;
  }

  return { ctx, connector, provider };
};

// ---------------------------------------------------------------------------
// Read — snapshots only
// ---------------------------------------------------------------------------

/**
 * GET /api/boards/:boardId/connectors/:provider/data
 *
 * Query: project, variant, from, to, keyword, includeRaw
 *
 * Everything the Ubersuggest tab renders, out of our own database.
 *
 * The project list is the board's MAPPED projects plus anything that already
 * carries readings. The second half matters: a project that was mapped, polled
 * for six months and then unmapped still has six months of history, and hiding
 * it would make that history unreachable through the UI while leaving it on
 * disk forever.
 */
const getConnectorData = async (req, res) => {
  try {
    const gated = await gateProvider(req, res, 'connector.view');
    if (!gated) return undefined;
    const { ctx, connector, provider } = gated;

    const canManage = !!ctx.can('connector.manage');
    const includeRaw = canManage && req.query?.includeRaw === '1';
    const range = resolveRange(req.query);

    const [mapped, withData, boardConnector] = await Promise.all([
      projectsForBoard(ctx.board._id, provider),
      // Scoped to the ORG, not the board — see above. A project only appears
      // here if a reading exists for it, so this cannot surface the whole pool.
      ConnectorSnapshot.distinct('project', {
        organisation: ctx.board.organisation,
        provider,
      }),
      BoardConnector.findOne({ board: ctx.board._id, provider })
        .select('enabled kinds enabledScreens intervalHours lastRefreshAt')
        .lean(),
    ]);

    const mappedIds = new Set(mapped.map((p) => String(p._id)));
    const extraIds = withData
      .map(String)
      .filter((id) => !mappedIds.has(id));

    const extras = extraIds.length
      ? await ConnectorProject.find({
          _id: { $in: extraIds },
          organisation: ctx.board.organisation,
        })
          .sort({ name: 1 })
          .lean()
      : [];

    const projects = [
      ...mapped.map((p) => ({ ...publicProject(p), mappedHere: true, lastFetchedAt: p.lastFetchedAt || null })),
      ...extras.map((p) => ({ ...publicProject(p), mappedHere: false, lastFetchedAt: p.lastFetchedAt || null })),
    ];

    // Which project the tab is looking at. An explicit id wins; otherwise the
    // first mapped one, so opening the tab shows something rather than an empty
    // picker.
    const requested = req.query?.project;
    const selected =
      (requested && isValidId(requested)
        ? projects.find((p) => String(p._id) === String(requested))
        : null) || projects[0] || null;

    const base = {
      canManage,
      provider: {
        name: connector.name,
        label: connector.label,
        blurb: connector.blurb,
        syncIntervalHours: connector.syncIntervalHours,
        kinds: connector.kinds,
        /**
         * The dashboard screens this provider declares, or `[]` for one that
         * renders through the generic one-section-per-kind tab.
         *
         * Sent from the SAME request the tab already makes, rather than from a
         * second one against the catalog. The shell has to know which screens
         * exist before it can render a nav, and a screen list arriving one round
         * trip after the data is a nav that appears late and moves the page.
         */
        screens: Array.isArray(connector.screens) ? connector.screens : [],
        /**
         * The headings those screens are grouped under, in nav order.
         *
         * Empty for a provider that declares no grouping, which the shell
         * renders as one flat list — the behaviour every provider had before
         * this field existed.
         */
        screenGroups: Array.isArray(connector.screenGroups)
          ? connector.screenGroups
          : [],
        /**
         * The alert rules and their thresholds, as data, so the Alerts screen
         * prints the server's numbers rather than restating them. Empty for a
         * provider with no `alerts` hook.
         */
        alertRules: Array.isArray(connector.alerts?.RULES) ? connector.alerts.RULES : [],
      },
      enabled: !!boardConnector?.enabled,
      selectedKinds: boardConnector?.kinds || [],
      /**
       * What this board RENDERS, beside what it PAYS TO COLLECT above.
       *
       * Resolved through the descriptor rather than passed raw, so an empty
       * selection means "everything" and an always-on screen comes back even if
       * a stored array predates it. The client must not re-derive either rule;
       * see `dataforseo/screens.js`.
       */
      selectedScreens: (typeof connector.resolveScreens === 'function'
        ? connector.resolveScreens(boardConnector?.enabledScreens || [])
        : []
      ).map((s) => s.key),
      /** Null means the descriptor's cadence. See `BoardConnector.intervalHours`. */
      intervalHours: boardConnector?.intervalHours ?? null,
      projects,
      range,
    };

    if (!selected) {
      return res.json({
        ...base,
        project: null,
        variants: [],
        variant: null,
        snapshots: {},
        previousSnapshots: {},
        trend: [],
        queued: 0,
        keywordHistory: null,
      });
    }

    /**
     * How much of this project is bought and not yet delivered.
     *
     * A provider that posts work and collects it later has a state the snapshot
     * collection deliberately cannot represent: paid for, in flight, no
     * `periodKey` yet. Without this the tab shows an empty section for hours
     * after a board is switched on, with nothing to explain the wait — and the
     * obvious fix, writing a placeholder snapshot, mints a row under a guessed
     * day that then outranks the real reading underneath it.
     *
     * Read through the DESCRIPTOR, not by importing a provider's model. This
     * file must not learn that one of its providers has a task queue; a provider
     * without one declares no hook and the count is zero. And it stays a
     * database read, which is what keeps the rule this file exists to hold: THE
     * READ ENDPOINT NEVER CONTACTS A PROVIDER.
     */
    let queued = 0;
    if (typeof connector.queuedCount === 'function') {
      try {
        queued = (await connector.queuedCount(selected)) || 0;
      } catch (err) {
        // A badge is not worth failing a page load for.
        console.warn(`connector queuedCount(${provider}) failed:`, err.message);
      }
    }

    // Every reading this project has, newest first. Selecting the fields keeps
    // `raw` off the wire for the rows we only need to index — the one snapshot
    // the caller actually reads is re-fetched below when raw is wanted.
    const rows = await ConnectorSnapshot.find({ project: selected._id })
      .select(`kind variant periodKey collectedAt subject status note data fetchedAt${includeRaw ? ' raw' : ''}`)
      .sort({ periodKey: -1, fetchedAt: -1 })
      .limit(MAX_HISTORY_ROWS)
      .lean();

    // Which rank-tracking variants this project has ever produced. Ordered so
    // the picker is stable between loads rather than following insertion order.
    const variants = [
      ...new Set(rows.filter((r) => r.kind === 'positions').map((r) => r.variant)),
    ].sort();
    const variant =
      (req.query?.variant && variants.includes(req.query.variant)
        ? req.query.variant
        : null) || variants[0] || 'default';

    // The latest reading of each kind. `positions` is filtered to the chosen
    // variant — a US rank and a UK rank are two facts, and showing whichever was
    // written most recently would flip the table between markets.
    const snapshots = {};
    /**
     * THE READING BEFORE THE LATEST ONE, per kind.
     *
     * Movement is the whole point of a rank tracker, and it is a comparison
     * between two readings — but only one of the two providers stores a
     * previous position on the row it returns. The other bills at post and
     * returns a plain SERP, so "how did this keyword move" can only ever be
     * answered from the week we kept.
     *
     * It costs NO EXTRA QUERY: `rows` above already carries `data` for every
     * snapshot in the window, so this is a second assignment inside a loop that
     * was already running. What it costs is wire bytes — roughly one more
     * aggregate per kind, ~16 KB at 200 keywords — which is why it is the
     * SECOND row and not the whole series. A client wanting more than one step
     * back asks for one keyword's history, which is served separately below.
     */
    const previousSnapshots = {};
    for (const row of rows) {
      /**
       * WHICH STORED VARIANT ANSWERS FOR THE SELECTED ONE — asked of the
       * provider, not decided here.
       *
       * A US rank and a UK rank are two facts, so `positions` has always been
       * filtered to the chosen market: showing whichever was written most
       * recently would flip the table between countries week to week. The rule
       * itself, though, is the PROVIDER's, and one of them now has kinds whose
       * variants are not spelled the same way its rank kind's are — DataForSEO
       * Labs takes a location and a language and NO DEVICE, so its variant key
       * collapses the device and can never equal a `positions` key. Compared
       * literally, every Labs snapshot is filtered out and its screen is
       * permanently empty; not compared at all, a two-market board silently
       * shows one market's competitors under the other's heading.
       *
       * `sameVariant` is optional and the fallback below is the behaviour that
       * was here before it existed, so a provider with one variant shape
       * declares nothing and nothing changes for it.
       */
      const sameVariant =
        typeof connector.sameVariant === 'function'
          ? connector.sameVariant(row.kind, row.variant, variant)
          : row.kind !== 'positions' || row.variant === variant;
      if (!sameVariant) continue;
      if (!snapshots[row.kind]) {
        snapshots[row.kind] = publicSnapshot(row, { includeRaw });
        continue;
      }
      if (previousSnapshots[row.kind]) continue;
      // Only a FINISHED reading may be the baseline. A partial one is a short
      // collection, and half a keyword list would report every missing keyword
      // as having entered the rankings this week.
      if (row.status !== 'ok') continue;
      previousSnapshots[row.kind] = publicSnapshot(row);
    }

    /**
     * The rank-tracking series, COMPACTED.
     *
     * Deliberately drops `keywords[]`. A year of weekly readings on a project
     * tracking 300 keywords is 15,600 rows of per-keyword detail, and the chart
     * draws six numbers per point. The per-keyword series is served separately,
     * for one keyword at a time, below.
     */
    const trend = rows
      .filter(
        (r) =>
          r.kind === 'positions' &&
          r.variant === variant &&
          r.periodKey >= range.from &&
          r.periodKey <= range.to
      )
      .map((r) => ({
        periodKey: r.periodKey,
        collectedAt: r.collectedAt || null,
        status: r.status,
        totals: r.data?.totals || null,
        averagePositions: r.data?.averagePositions || [],
      }))
      .reverse(); // oldest first, so a chart can draw it unchanged

    /**
     * One keyword's history — the thing the provider cannot answer at all.
     *
     * `project_position_info` returns two points per keyword and there is no
     * tool that exposes the "See Trend" view the product shows in its own UI. So
     * this loop over our own stored weeks IS the feature; nothing else will ever
     * be able to produce it.
     */
    let keywordHistory = null;
    const wanted = typeof req.query?.keyword === 'string' ? req.query.keyword.trim() : '';
    if (wanted) {
      const needle = wanted.toLowerCase();
      const points = rows
        .filter((r) => r.kind === 'positions' && r.variant === variant)
        .map((r) => {
          const hit = (r.data?.keywords || []).find(
            (k) => (k.keyword || '').toLowerCase() === needle
          );
          if (!hit) return null;
          return {
            periodKey: r.periodKey,
            collectedAt: r.collectedAt || null,
            /**
             * null here is "not in the top 100" and is a real answer. The client
             * must render it as that, never as a gap in the line.
             *
             * TWO SPELLINGS, and this is the whole of the accommodation. The
             * first provider normalises to `position` (its API's own word) and
             * the second to `rank` (`rank_group`, its API's own word), and
             * neither is going to be renamed: `position` is read by
             * `connectorGoalWriteback` and by a year of stored Ubersuggest
             * snapshots, and `rank` sits beside `rankAbsolute`, whose gap is a
             * free measure of SERP-feature pressure and would read as nonsense
             * spelled `positionAbsolute`.
             *
             * Checked with `typeof` rather than `??` deliberately: `position` is
             * legitimately `null` for "does not rank", and `a ?? b` would fall
             * through that null to an undefined `rank` and turn a real answer
             * into a missing one — collapsing three outcomes into two, which is
             * the exact failure `connectorFormat.formatRank` exists to prevent.
             */
            position:
              typeof hit.position === 'number'
                ? hit.position
                : typeof hit.rank === 'number'
                  ? hit.rank
                  : null,
            ranked: hit.ranked,
            status: hit.status,
          };
        })
        .filter(Boolean)
        .reverse();
      keywordHistory = { keyword: wanted, points };
    }

    /**
     * WHAT THE LATEST READING WOULD SET OFF, and why — phase 10.
     *
     * Asked of the DESCRIPTOR, and computed from `snapshots` and
     * `previousSnapshots` which are already in memory two dozen lines above. No
     * extra query, no provider contact, and — the point — no second
     * implementation: `services/seoAlertRunner.js` calls the identical function
     * with the identical shape when it decides whether to send a notification,
     * so what the screen shows and what the bell says can never disagree about a
     * threshold.
     *
     * That is deliberately unlike `comparability`, which exists twice (here and
     * in two client utilities) because a screen needed the answer without a
     * round trip. This screen has one anyway.
     *
     * A provider declaring no hook gets an empty list, which is exactly what the
     * generic tab renders today.
     */
    let alerts = [];
    if (typeof connector.alerts?.evaluate === 'function') {
      try {
        alerts = connector.alerts.evaluate({
          snapshots,
          previousSnapshots,
          label: selected.name || selected.domain || 'This site',
        });
      } catch (err) {
        // A panel is not worth failing a page load for. Same rule as
        // `queuedCount` above it.
        console.warn(`connector alerts(${provider}) failed:`, err.message);
      }
    }

    return res.json({
      ...base,
      project: selected,
      variants,
      variant,
      snapshots,
      previousSnapshots,
      trend,
      queued,
      keywordHistory,
      alerts,
    });
  } catch (err) {
    console.error('getConnectorData error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * GET /api/boards/:boardId/connectors/:provider/usage
 *
 * Query: months
 *
 * What this board's collections have cost, what is still in flight, and how much
 * of the month's cap is left.
 *
 * ---- It obeys the same rule as the read above it ---------------------------
 *
 * IT NEVER CONTACTS A PROVIDER, and on a provider that bills at post that is a
 * stronger statement than it was for the first one. The obvious source for
 * "what have we spent" is the account's own balance endpoint, which is free —
 * and it is the wrong number twice over: it is the balance of ONE SHARED
 * ACCOUNT across every organisation on it, and a read endpoint that reaches a
 * third party is one open browser tab away from being rate-limited. Everything
 * here comes from `ConnectorBudget` (our ledger of what was reserved and
 * settled) and from the descriptor's own `describeUsage` hook.
 *
 * ---- Who sees which half ---------------------------------------------------
 *
 * The gate is `connector.view`, the same rung as the data read, because the
 * screen's subject is THIS BOARD'S collections. But the ORG cap is a fact about
 * the whole workspace's money and is returned only to somebody holding
 * `connector.manage` — a board reader gets what this board has spent and what
 * its own allocation is, and nothing about the workspace's ceiling. Two
 * questions, two audiences, one endpoint.
 */
const getConnectorUsage = async (req, res) => {
  try {
    const gated = await gateProvider(req, res, 'connector.view');
    if (!gated) return undefined;
    const { ctx, connector, provider } = gated;

    const canManage = !!ctx.can('connector.manage');
    const now = new Date();
    const periodKey = monthKeyFor(now);

    const [projects, boardConnector] = await Promise.all([
      projectsForBoard(ctx.board._id, provider),
      BoardConnector.findOne({ board: ctx.board._id, provider })
        .select('enabled kinds enabledScreens intervalHours budget lastRefreshAt')
        .lean(),
    ]);

    /**
     * The two budget documents, read and never written.
     *
     * `describeBudget` returns null for a period nobody has spent in yet, and
     * null is the honest answer — the row is created at the moment of the first
     * reservation (`ensureBudget`), and minting one from a read endpoint would
     * stamp `capUsd` from today's environment into a month that has not started
     * spending. That is precisely the "a cap silently rose because somebody
     * redeployed" failure `DEFAULT_MONTHLY_CAP_USD` is only read at
     * `$setOnInsert` to avoid.
     */
    const [orgBudget, boardBudget] = await Promise.all([
      canManage
        ? describeBudget({
            organisation: ctx.board.organisation,
            provider,
            scope: 'org',
            scopeId: ctx.board.organisation,
            periodKey,
          })
        : Promise.resolve(null),
      describeBudget({
        organisation: ctx.board.organisation,
        provider,
        scope: 'board',
        scopeId: ctx.board._id,
        periodKey,
      }),
    ]);

    /**
     * The provider's own ledger, through the DESCRIPTOR.
     *
     * Same seam as `queuedCount` on the read above: this controller must not
     * learn that one of its providers buys work asynchronously and keeps a task
     * table. A provider that declares no hook answers with the budget alone,
     * which is a complete and correct screen for one that bills per month.
     */
    let ledger = null;
    if (typeof connector.describeUsage === 'function') {
      try {
        ledger = await connector.describeUsage({
          organisation: ctx.board.organisation,
          board: ctx.board._id,
          projects,
          months: Number(req.query?.months) || undefined,
          now,
        });
      } catch (err) {
        // A spend panel is not worth failing a page load for; the budget half
        // above is the part that answers "may we still collect".
        console.warn(`connector describeUsage(${provider}) failed:`, err.message);
      }
    }

    return res.json({
      canManage,
      periodKey,
      provider: {
        name: connector.name,
        label: connector.label,
        syncIntervalHours: connector.syncIntervalHours,
        kinds: connector.kinds || [],
        screens: connector.screens || [],
      },
      board: {
        enabled: !!boardConnector?.enabled,
        kinds: boardConnector?.kinds || [],
        enabledScreens: boardConnector?.enabledScreens || [],
        intervalHours: boardConnector?.intervalHours ?? null,
        allocationUsd: boardConnector?.budget?.monthlyUsd ?? null,
        alertAtPct: boardConnector?.budget?.alertAtPct ?? 80,
        lastRefreshAt: boardConnector?.lastRefreshAt || null,
        projectCount: projects.length,
      },
      /** Null for a workspace member without `connector.manage`. See the header. */
      orgBudget,
      /** Null when this board has no allocation, which is the normal state. */
      boardBudget,
      ledger,
    });
  } catch (err) {
    console.error('getConnectorUsage error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

// ---------------------------------------------------------------------------
// Write — the two things that spend quota
// ---------------------------------------------------------------------------

/**
 * POST /api/boards/:boardId/connectors/:provider/refresh
 * Body: { project?: id, kinds?: string[] }
 *
 * Collect now, rather than waiting for the weekly pass. `connector.manage`,
 * because it spends a quota shared by the whole workspace.
 *
 * ---- `force` USED TO BE IMPLICIT AND TOTAL. It is not any more --------------
 *
 * The old justification, verbatim, was: "a person pressing Refresh has said they
 * want this now, and the freshness check exists to stop a SCHEDULE from
 * re-reading data that has not moved, not to argue with a human. It is also
 * close to free — the provider bills per report SUBJECT per day, so a second
 * pull of the same project on the same day costs nothing."
 *
 * The first half still holds. THE SECOND HALF IS FALSE FOR ONE OF TWO PROVIDERS
 * and is rewritten rather than deleted, because a justification that is no
 * longer true is how the next person re-introduces the bug it was written to
 * prevent. Ubersuggest bills per report subject per day; DataForSEO bills AT
 * POST, per task, so the same button press there is a purchase — 200 keywords in
 * two markets is $0.24 every time somebody leans on it, and for that provider
 * `force` also resets the attempt chain on a job that has already been given up
 * on.
 *
 * So the descriptor is asked instead of assumed. `forceRefetchIsFree: true` on
 * Ubersuggest keeps its behaviour byte-identical; `false` on DataForSEO makes a
 * plain Refresh respect the cadence and collect for free whatever is already
 * bought. A person who genuinely means "buy it again" sends `{force: true}` in
 * the body — an explicit act, which is the only kind that should be able to
 * spend money by accident-proof design.
 *
 * Answers 200 with a per-account report even when some accounts failed. A pool
 * where one account is out of quota and three are fine is a successful refresh
 * with one gap, and a 500 would hide the three.
 */
const refreshConnectorData = async (req, res) => {
  try {
    const gated = await gateProvider(req, res, 'connector.manage');
    if (!gated) return undefined;
    const { ctx, connector, provider } = gated;

    if (typeof connector.fetch !== 'function') {
      return res.status(409).json({
        error: `${connector.label} cannot collect data yet.`,
        code: 'NO_DATA_SUPPORT',
      });
    }

    const requested = req.body?.project;
    if (requested !== undefined && requested !== null && !isValidId(requested)) {
      return res.status(400).json({ error: 'Invalid project id' });
    }

    let projects;
    if (requested) {
      // A single named project may be UNMAPPED. That is on purpose: the schedule
      // only ever polls mapped projects, so pulling one on demand is the only
      // way to look at a prospect's domain before committing it to a group.
      const one = await ConnectorProject.findOne({
        _id: requested,
        organisation: ctx.board.organisation,
        provider,
      }).lean();
      if (!one) return res.status(404).json({ error: 'Project not found' });
      if (one.missing) {
        return res.status(409).json({
          error: `${one.name || one.domain} no longer exists at ${connector.label}. Its history is kept, but nothing new can be collected.`,
          code: 'PROJECT_MISSING',
        });
      }
      projects = [one];
    } else {
      projects = (await projectsForBoard(ctx.board._id, provider)).filter(
        (p) => !p.missing
      );
    }

    if (!projects.length) {
      return res.status(409).json({
        error:
          'No project on this board is mapped to a group yet. Map one under Add-ons first.',
        code: 'NO_PROJECTS',
      });
    }

    const boardConnector = await BoardConnector.findOne({
      board: ctx.board._id,
      provider,
    })
      .select('kinds')
      .lean();

    const asked = Array.isArray(req.body?.kinds) && req.body.kinds.length
      ? req.body.kinds.filter((k) => typeof k === 'string')
      : boardConnector?.kinds || [];

    const report = await collectSnapshots({
      provider,
      projects,
      kindsFor: () => connector.resolveKinds(asked),
      /**
       * Free to re-fetch → force, exactly as before. Billed per call → only when
       * the caller said so in as many words. See the header.
       *
       * `!== false` rather than `=== true` so a descriptor that has no opinion
       * keeps the old behaviour; opting OUT is the deliberate act, because a
       * provider whose author forgot to think about this is far more likely to be
       * free than to be metered.
       */
      force: connector.forceRefetchIsFree !== false || req.body?.force === true,
      actorId: req.user.userId,
    });

    await BoardConnector.updateOne(
      { board: ctx.board._id, provider },
      {
        $set: {
          organisation: ctx.board.organisation,
          lastRefreshAt: new Date(),
          lastRefreshBy: req.user.userId,
        },
        $setOnInsert: { enabled: true, enabledBy: req.user.userId },
      },
      { upsert: true }
    );

    /**
     * Fill the linked goals from what just arrived.
     *
     * Pressing Refresh and then having to press a second button to see the
     * numbers land is the version of this feature nobody uses. It costs no
     * quota — the writeback reads the rows the line above just wrote — and it
     * runs with the CALLER as the principal, so somebody holding `goal.manage`
     * gets their starting points filled too, where the weekly pass would only
     * have offered them.
     *
     * Best effort. A collection that succeeded must not be reported as a failure
     * because the writeback tripped over one board's goals; the next pass, and
     * the "Fill goals now" button, both pick it up.
     */
    let writeback = null;
    try {
      writeback = await runWriteback({
        board: ctx.board,
        provider,
        actor: { userId: req.user.userId, can: ctx.can },
      });
    } catch (err) {
      console.error('refreshConnectorData writeback error:', err);
    }

    return res.json({ report, writeback });
  } catch (err) {
    console.error('refreshConnectorData error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/boards/:boardId/connectors/:provider/projects/:projectId/actions/:action
 *
 * Run one of the provider's user-triggered actions. Today that is "Run audit",
 * which starts a site-audit crawl.
 *
 * Generic on purpose. The action is looked up on the DESCRIPTOR rather than
 * branched on here, so the Ads connector's own actions arrive as entries in its
 * `actions` map and this handler does not change. That is the same seam
 * `getConnector` already gives the rest of the file.
 *
 * Starting a crawl is separated from reading one because it is expensive at the
 * other end — minutes of somebody else's compute, capped by plan — and an
 * unattended weekly job that started one for every domain in the workspace is
 * how an integration gets switched off from the far side. So: a button, pressed
 * by a person who holds `connector.manage`.
 */
const runConnectorAction = async (req, res) => {
  try {
    const gated = await gateProvider(req, res, 'connector.manage');
    if (!gated) return undefined;
    const { ctx, connector, provider } = gated;

    const { projectId, action: actionKey } = req.params;
    if (!isValidId(projectId)) {
      return res.status(400).json({ error: 'Invalid project id' });
    }

    const action = connector.actions?.[actionKey];
    if (!action) {
      return res
        .status(400)
        .json({ error: `${connector.label} has no "${actionKey}" action.` });
    }

    const project = await ConnectorProject.findOne({
      _id: projectId,
      organisation: ctx.board.organisation,
      provider,
    }).lean();
    if (!project) return res.status(404).json({ error: 'Project not found' });

    if (project.missing) {
      return res.status(409).json({
        error: `${project.name || project.domain} no longer exists at ${connector.label}.`,
        code: 'PROJECT_MISSING',
      });
    }
    if (action.requires && !project[action.requires]) {
      return res.status(409).json({
        error: `This project has no ${action.requires}, so "${action.label}" cannot run for it.`,
        code: 'ACTION_UNAVAILABLE',
      });
    }

    let session;
    try {
      session = await openSession(project.account);
    } catch (err) {
      return res.status(err.needsReauth ? 409 : err.status || 500).json({
        error: err.message,
        code: err.needsReauth ? 'NEEDS_REAUTH' : undefined,
      });
    }

    let result;
    try {
      result = await action.run({ session, project });
    } catch (err) {
      if (err.needsReauth) {
        await session.markNeedsReauth();
        return res.status(409).json({ error: err.message, code: 'NEEDS_REAUTH' });
      }
      if (err.quotaExhausted) {
        // Not a fault. Report limits reset daily and credits monthly, and
        // retrying before then spends nothing but the user's patience.
        return res.status(409).json({ error: err.message, code: 'QUOTA_EXHAUSTED' });
      }
      return res.status(err.status || 502).json({ error: err.message });
    }

    // The action's result is stored like any other reading, under the kind it
    // declares — so a crawl that came back already finished lands in the same
    // place the scheduled read would have put it, and the tab needs no second
    // path to render it.
    const kind = (connector.kinds || []).find((k) => k.key === action.kind);
    if (kind) {
      await writeSnapshot({
        project,
        provider,
        kind,
        variant: { key: 'default' },
        result,
        actorId: req.user.userId,
      });
    }

    return res.json({
      action: actionKey,
      status: result.status,
      note: result.note || '',
      snapshot: publicSnapshot({
        kind: action.kind,
        variant: 'default',
        periodKey: '',
        status: result.status,
        note: result.note || '',
        data: result.data,
        fetchedAt: new Date(),
      }),
    });
  } catch (err) {
    console.error('runConnectorAction error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

module.exports = {
  getConnectorData,
  getConnectorUsage,
  refreshConnectorData,
  runConnectorAction,
  // Exported for the tests and for phases 4-5, which read the same shapes.
  publicSnapshot,
  resolveRange,
  parseDay,
  DEFAULT_HISTORY_DAYS,
  MAX_HISTORY_ROWS,
};
