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
        .select('enabled kinds lastRefreshAt')
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
      },
      enabled: !!boardConnector?.enabled,
      selectedKinds: boardConnector?.kinds || [],
      projects,
      range,
    };

    if (!selected) {
      return res.json({ ...base, project: null, variants: [], variant: null, snapshots: {}, trend: [], keywordHistory: null });
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
    for (const row of rows) {
      if (row.kind === 'positions' && row.variant !== variant) continue;
      if (snapshots[row.kind]) continue;
      snapshots[row.kind] = publicSnapshot(row, { includeRaw });
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
            // null here is "not in the top 100" and is a real answer. The client
            // must render it as that, never as a gap in the line.
            position: hit.position,
            ranked: hit.ranked,
            status: hit.status,
          };
        })
        .filter(Boolean)
        .reverse();
      keywordHistory = { keyword: wanted, points };
    }

    return res.json({
      ...base,
      project: selected,
      variants,
      variant,
      snapshots,
      trend,
      keywordHistory,
    });
  } catch (err) {
    console.error('getConnectorData error:', err);
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
 * `force` is implicit and total: a person pressing Refresh has said they want
 * this now, and the freshness check exists to stop a SCHEDULE from re-reading
 * data that has not moved, not to argue with a human. It is also close to free —
 * the provider bills per report SUBJECT per day, so a second pull of the same
 * project on the same day costs nothing.
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
      force: true,
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
  refreshConnectorData,
  runConnectorAction,
  // Exported for the tests and for phases 4-5, which read the same shapes.
  publicSnapshot,
  resolveRange,
  parseDay,
  DEFAULT_HISTORY_DAYS,
  MAX_HISTORY_ROWS,
};
