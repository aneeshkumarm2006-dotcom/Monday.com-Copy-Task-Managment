const mongoose = require('mongoose');

const Goal = require('../models/Goal');
const GoalConnectorLink = require('../models/GoalConnectorLink');
const ConnectorProject = require('../models/ConnectorProject');
const ConnectorSnapshot = require('../models/ConnectorSnapshot');
const ConnectorFieldMapping = require('../models/ConnectorFieldMapping');

const { getConnector } = require('../services/connectors');
const {
  targetsForBoard,
  targetId,
  parseTargetId,
  readGoalTarget,
} = require('../services/connectors/fieldMapping');
const {
  runWriteback,
  applyWrite,
} = require('../services/connectorGoalWriteback');
const { isConnectorProvider } = require('../utils/connectorProviders');
const { isMonthKey, monthKeyOf } = require('../utils/monthKey');
const { gateBoard } = require('./connectorController');

/**
 * The GOAL LINK plane — which tracked keyword a goal is about, and what to do
 * about a cell the connector no longer owns.
 *
 * Fourth file in the connector set, and it keeps the same split the other three
 * make. `connectorController.js` is accounts and enablement,
 * `connectorDataController.js` is the readings, `connectorFieldController.js` is
 * which value fills which cell — and this one is which ROW each reading belongs
 * to, plus the two human gestures the writeback needs: accepting a suggestion,
 * and asking it to run now. `gateBoard` is imported, never copied.
 *
 * ---- Nothing here contacts a provider --------------------------------------
 *
 * Including the writeback endpoint. Collecting spends quota and lives in
 * `snapshotService`; deciding where what was already collected goes is free and
 * reads our own database. That is why "Fill goals now" can sit next to "Refresh"
 * and be a materially cheaper button.
 *
 * ---- Why linking is `connector.manage` and accepting is not -----------------
 *
 * Linking a goal to a keyword writes nothing to a goal — it is the same act as
 * saying which project feeds which group, and it sits on the same rung.
 *
 * ACCEPTING a suggestion does write, so it is gated on what the target implies:
 * `goal.track` for a result, `goal.manage` for anything under `config`. That is
 * the promise/result split `goalController.RESULT_ONLY_FIELDS` already makes,
 * enforced here at the moment a value actually lands — which is the moment the
 * phase-4 panel said it would be.
 */

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

const MAX_KEYWORD_LENGTH = 300;
/** A ceiling on the keyword picker's list, so one board cannot send 5,000. */
const MAX_KEYWORD_OPTIONS = 1000;

/**
 * Resolve a goal id to its board and run the board gate.
 *
 * The same shape as `goalController.gateByGoal`, and deliberately a second copy
 * rather than an import: that one gates on the GOAL capabilities and this one
 * gates on the CONNECTOR ones, and collapsing them into a shared helper with a
 * capability argument would hide which of the two ladders a handler is on.
 */
const gateByGoal = async (req, res, capability) => {
  const { id } = req.params;
  if (!isValidId(id)) {
    res.status(400).json({ error: 'Invalid goal id' });
    return null;
  }
  const goal = await Goal.findById(id);
  if (!goal) {
    res.status(404).json({ error: 'Goal not found' });
    return null;
  }
  req.params.boardId = String(goal.board);
  const ctx = await gateBoard(req, res, capability);
  if (!ctx) return null;
  return { ctx, goal };
};

/**
 * A cell entry in a shape safe to serialise, decorated with the two labels the
 * row needs.
 *
 * The labels are resolved HERE rather than on the client for the same reason the
 * refusal sentences are: the client would have to hold the provider's catalog
 * and the board's target list and join them itself, which is a second
 * implementation of something the server already knows.
 */
const publicCell = (entry, { fieldLabel = null, targetLabel = null } = {}) => {
  if (!entry) return null;
  return {
    value: entry.value ?? null,
    targetId: entry.targetId || null,
    at: entry.at || null,
    fieldLabel,
    targetLabel,
  };
};

/** A Map or a lean object, as a plain object. `Goal.columnValues`' sharp edge. */
const asObject = (value) => {
  if (!value) return {};
  if (value instanceof Map) return Object.fromEntries(value);
  if (typeof value.toObject === 'function') return value.toObject();
  return value;
};

/**
 * The public shape of a link. Hand-built for the same reason `publicAccount`
 * and `publicSnapshot` are — a field added to the model later must not reach a
 * client by default.
 */
const publicLink = (link, { labelFor = () => ({}) } = {}) => {
  const applied = asObject(link.applied);
  const suggested = asObject(link.suggested);
  const decorate = (bag) =>
    Object.fromEntries(
      Object.entries(bag).map(([key, entry]) => [key, publicCell(entry, labelFor(key, entry))])
    );

  return {
    _id: link._id,
    goal: String(link.goal),
    group: String(link.group),
    monthKey: link.monthKey,
    provider: link.provider,
    project: link.project ? String(link.project) : null,
    keyword: link.keyword || null,
    variant: link.variant || null,
    autoFill: link.autoFill !== false,
    claimedAt: link.claimedAt || null,
    lastSyncAt: link.lastSyncAt || null,
    lastNote: link.lastNote || '',
    applied: decorate(applied),
    suggested: decorate(suggested),
  };
};

/**
 * The keyword lists, one per (group, provider), read out of the newest rank
 * snapshot we hold.
 *
 * Reading them from a SNAPSHOT rather than asking the provider is the point:
 * the picker opens instantly, spends nothing, and works during an outage. The
 * cost is that a keyword added at the provider since the last collection is not
 * in the list — which is why the link accepts a free-typed phrase too, and says
 * so in the UI rather than refusing.
 */
const keywordSourcesFor = async (board, provider) => {
  const filter = { board: board._id, group: { $ne: null } };
  if (provider) filter.provider = provider;

  const projects = await ConnectorProject.find(filter)
    .select('_id group provider name domain missing')
    .sort({ name: 1 })
    .lean();
  if (!projects.length) return [];

  const rows = await ConnectorSnapshot.find({
    project: { $in: projects.map((p) => p._id) },
    kind: 'positions',
  })
    .select('project variant periodKey data')
    .sort({ periodKey: -1, fetchedAt: -1 })
    .limit(MAX_KEYWORD_OPTIONS)
    .lean();

  const byProject = new Map();
  for (const row of rows) {
    const key = String(row.project);
    if (!byProject.has(key)) byProject.set(key, { newest: row, variants: new Set() });
    byProject.get(key).variants.add(row.variant);
  }

  return projects.map((project) => {
    const found = byProject.get(String(project._id));
    const keywords = [
      ...new Set(
        (found?.newest?.data?.keywords || [])
          .map((k) => (typeof k?.keyword === 'string' ? k.keyword.trim() : ''))
          .filter(Boolean)
      ),
    ]
      .sort((a, b) => a.localeCompare(b))
      .slice(0, MAX_KEYWORD_OPTIONS);

    return {
      group: String(project.group),
      provider: project.provider,
      projectId: String(project._id),
      projectName: project.name || project.domain || '',
      domain: project.domain || null,
      missing: !!project.missing,
      collectedOn: found?.newest?.periodKey || null,
      variants: [...(found?.variants || [])].sort(),
      keywords,
    };
  });
};

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * GET /api/boards/:boardId/goal-links?month=YYYY-MM&provider=…
 *
 * Everything the Goals tab needs to show a linked row, in one request: the
 * links for that month, the keyword lists to pick from, and which of the
 * provider's fields are mapped anywhere on this board.
 *
 * `connector.view`, the bottom rung — it reads our own database, so it is safe
 * on every render of the Goals tab. A board with no connector enabled gets
 * empty arrays rather than a 404, because the tab renders either way and an
 * error there would be an error about something the user did not ask for.
 */
const getGoalLinks = async (req, res) => {
  try {
    const ctx = await gateBoard(req, res, 'connector.view');
    if (!ctx) return undefined;

    const month = isMonthKey(req.query?.month)
      ? req.query.month
      : monthKeyOf(new Date(), ctx.board.monthTimezone || 'UTC');

    const provider = req.query?.provider;
    if (provider && !isConnectorProvider(provider)) {
      return res.status(400).json({ error: `Unknown connector "${provider}"` });
    }

    const linkFilter = { board: ctx.board._id, monthKey: month };
    if (provider) linkFilter.provider = provider;

    const [links, mappings, sources] = await Promise.all([
      GoalConnectorLink.find(linkFilter).lean(),
      ConnectorFieldMapping.find({
        board: ctx.board._id,
        ...(provider ? { provider } : {}),
      }).lean(),
      keywordSourcesFor(ctx.board, provider || null),
    ]);

    const targetById = new Map(targetsForBoard(ctx.board).map((t) => [t.id, t]));
    const fieldLabels = new Map();
    for (const row of mappings) {
      const connector = getConnector(row.provider);
      const field = (connector?.fields || []).find((f) => f.key === row.sourceField);
      if (field) fieldLabels.set(`${row.provider}|${row.sourceField}`, field.label);
    }

    const labelFor = (providerName) => (key, entry) => ({
      fieldLabel: fieldLabels.get(`${providerName}|${key}`) || key,
      targetLabel: targetById.get(entry?.targetId)?.label || null,
    });

    return res.json({
      monthKey: month,
      canManage: !!ctx.can('connector.manage'),
      canTrack: !!ctx.can('goal.track'),
      canManageGoals: !!ctx.can('goal.manage'),
      links: links.map((l) => publicLink(l, { labelFor: labelFor(l.provider) })),
      sources,
      /**
       * Which fields are bound anywhere on this board, so the link modal can
       * say what a link will actually fill instead of promising everything the
       * provider has. A link with no keyword-scoped field mapped fills nothing,
       * and that is worth knowing BEFORE making twenty of them.
       */
      mappedFields: mappings
        .map((row) => {
          const connector = getConnector(row.provider);
          const field = (connector?.fields || []).find((f) => f.key === row.sourceField);
          const target = targetById.get(targetId(row.target));
          if (!field || !target) return null;
          return {
            provider: row.provider,
            key: field.key,
            label: field.label,
            scope: field.scope,
            kind: field.kind,
            autoFill: row.autoFill !== false,
            targetId: target.id,
            targetLabel: target.label,
            targetCapability: target.capability,
            targetArchived: !!target.archived,
          };
        })
        .filter(Boolean),
    });
  } catch (err) {
    console.error('getGoalLinks error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

// ---------------------------------------------------------------------------
// Write — the link itself
// ---------------------------------------------------------------------------

/**
 * PUT /api/goals/:id/connector-link
 * Body: { provider, keyword?, variant?, autoFill? }
 *
 * Bind one goal to one tracked keyword, replacing whatever it was bound to.
 *
 * The keyword is OPTIONAL and a link without one is a real link — it binds the
 * goal to the group's project and fills the project-scoped fields (organic
 * traffic, domain authority, health score) and nothing else. `scope` on the
 * field catalog is what makes that distinction; this is where it is used.
 *
 * `claimedAt` is deliberately NOT cleared when a link is re-pointed. Re-linking
 * would otherwise be a way to make the connector overwrite cells a human has
 * corrected since the first sync, one goal at a time and with nothing on screen
 * to say so.
 */
const setGoalLink = async (req, res) => {
  try {
    const loaded = await gateByGoal(req, res, 'connector.manage');
    if (!loaded) return undefined;
    const { ctx, goal } = loaded;

    const provider = req.body?.provider;
    if (!isConnectorProvider(provider) || !getConnector(provider)) {
      return res.status(400).json({ error: `Unknown connector "${provider}"` });
    }

    const project = await ConnectorProject.findOne({
      group: goal.group,
      provider,
    })
      .select('_id name domain missing')
      .lean();
    if (!project) {
      return res.status(409).json({
        error:
          'This goal’s group is not mapped to a project yet. Map one under Add-ons first.',
        code: 'NO_PROJECT',
      });
    }

    const rawKeyword = req.body?.keyword;
    let keyword = null;
    if (typeof rawKeyword === 'string' && rawKeyword.trim()) {
      keyword = rawKeyword.trim().slice(0, MAX_KEYWORD_LENGTH);
    } else if (rawKeyword !== undefined && rawKeyword !== null && rawKeyword !== '') {
      return res.status(400).json({ error: 'That is not a keyword.' });
    }

    const variant =
      typeof req.body?.variant === 'string' && req.body.variant.trim()
        ? req.body.variant.trim().slice(0, 120)
        : null;

    const update = {
      board: ctx.board._id,
      organisation: ctx.board.organisation,
      group: goal.group,
      monthKey: goal.monthKey,
      provider,
      project: project._id,
      keyword,
      variant,
      updatedBy: req.user.userId,
    };
    if (typeof req.body?.autoFill === 'boolean') update.autoFill = req.body.autoFill;

    const link = await GoalConnectorLink.findOneAndUpdate(
      { goal: goal._id },
      { $set: update, $setOnInsert: { linkedBy: req.user.userId } },
      { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true }
    ).lean();

    return res.json({
      link: publicLink(link),
      project: {
        _id: String(project._id),
        name: project.name || project.domain || '',
        domain: project.domain || null,
        missing: !!project.missing,
      },
    });
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({
        error: 'That goal was just linked from somewhere else. Reload and try again.',
      });
    }
    console.error('setGoalLink error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * DELETE /api/goals/:id/connector-link
 *
 * Unlink. Nothing already written is touched — a value the connector put in a
 * cell is a real reading somebody may have reported to a client, and removing
 * the wiring is not a statement about it. Only the future stops. Same rule as
 * unmapping a field.
 *
 * The PROVENANCE goes with it, and that is the one consequence worth knowing:
 * re-linking the same goal later starts a fresh link, whose first run claims the
 * cells again. That is the honest reading of "unlink and relink" — you asked for
 * the connector's numbers back.
 */
const clearGoalLink = async (req, res) => {
  try {
    const loaded = await gateByGoal(req, res, 'connector.manage');
    if (!loaded) return undefined;
    // Idempotent: unlinking something already unlinked is the outcome the caller
    // asked for, not a 404 to handle.
    await GoalConnectorLink.deleteOne({ goal: loaded.goal._id });
    return res.json({ ok: true });
  } catch (err) {
    console.error('clearGoalLink error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

// ---------------------------------------------------------------------------
// Write — the two gestures that move a value
// ---------------------------------------------------------------------------

/**
 * POST /api/goals/:id/connector-link/accept
 * Body: { fields?: string[] }  — omit for every outstanding suggestion
 *
 * "Ubersuggest says 1,400 — accept?" Says yes.
 *
 * Gated per FIELD on what its target implies, not once for the request:
 * `goal.track` fills a result, `goal.manage` changes the promise. Somebody who
 * can report the month but not redefine it can accept the rank and not the
 * target, and the response says which ones were refused rather than failing the
 * whole call — refusing five acceptable values because a sixth needed a higher
 * rung would be a worse answer than doing the five.
 *
 * The base gate is `goal.track`, the lowest rung any target needs.
 */
const acceptGoalSuggestions = async (req, res) => {
  try {
    const loaded = await gateByGoal(req, res, 'goal.track');
    if (!loaded) return undefined;
    const { ctx, goal } = loaded;

    const link = await GoalConnectorLink.findOne({ goal: goal._id });
    if (!link) return res.status(404).json({ error: 'This goal is not linked.' });

    const suggested = asObject(link.suggested);
    const wanted = Array.isArray(req.body?.fields) && req.body.fields.length
      ? req.body.fields.filter((f) => typeof f === 'string')
      : Object.keys(suggested);

    if (!wanted.length) {
      return res.status(409).json({ error: 'There is nothing to accept on this goal.' });
    }

    const targetById = new Map(targetsForBoard(ctx.board).map((t) => [t.id, t]));
    const now = new Date();
    const accepted = [];
    const refused = [];

    for (const key of wanted) {
      const entry = suggested[key];
      if (!entry) continue;

      const resolved = targetById.get(entry.targetId);
      const parsed = parseTargetId(entry.targetId);
      if (!resolved || !parsed) {
        // The column was purged, or the mapping was re-pointed and the old
        // target no longer exists. Dropped rather than refused: there is nowhere
        // for it to go and leaving it would offer the same dead button forever.
        refused.push({ field: key, reason: 'That column is no longer on this board.' });
        link.suggested.delete(key);
        continue;
      }
      if (!ctx.can(resolved.capability)) {
        refused.push({
          field: key,
          reason: `Filling “${resolved.label}” changes what was promised, which needs permission to manage goals.`,
        });
        continue;
      }

      applyWrite(goal, { target: parsed, value: entry.value });
      link.applied.set(key, {
        value: entry.value,
        targetId: entry.targetId,
        at: now,
      });
      link.suggested.delete(key);
      accepted.push({ field: key, targetId: entry.targetId, value: entry.value });
    }

    if (accepted.length) {
      goal.updatedBy = req.user.userId;
      await goal.save();
    }
    link.markModified('applied');
    link.markModified('suggested');
    // `claimedAt` is deliberately untouched. Accepting one suggestion is not a
    // statement about the cells this run could not reach, and stamping it here
    // would quietly cancel the first-sync claim for every other field on the
    // row.
    await link.save();

    return res.json({
      accepted,
      refused,
      link: publicLink(link),
      goal: {
        _id: String(goal._id),
        actual: goal.actual,
        actualDayKey: goal.actualDayKey,
        config: goal.config,
        columnValues: asObject(goal.columnValues),
      },
    });
  } catch (err) {
    console.error('acceptGoalSuggestions error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/boards/:boardId/connectors/:provider/writeback
 * Body: { month?: 'YYYY-MM' }
 *
 * Fill the goals now, from data we already hold. SPENDS NO QUOTA — it reads
 * stored snapshots, which is what makes it a different and much cheaper button
 * from Refresh next to it.
 *
 * Runs with the CALLER as the principal, which is the whole reason a manual run
 * exists alongside the weekly one: the schedule has nobody behind it and so
 * fills only the result half of a goal, while a person holding `goal.manage`
 * pressing this can also fill the starting point and the target.
 */
const runBoardWriteback = async (req, res) => {
  try {
    const ctx = await gateBoard(req, res, 'connector.manage');
    if (!ctx) return undefined;

    const { provider } = req.params;
    if (!isConnectorProvider(provider) || !getConnector(provider)) {
      return res.status(400).json({ error: `Unknown connector "${provider}"` });
    }

    const month = isMonthKey(req.body?.month) ? req.body.month : null;

    const report = await runWriteback({
      board: ctx.board,
      provider,
      monthKey: month,
      actor: { userId: req.user.userId, can: ctx.can },
    });

    return res.json({ report });
  } catch (err) {
    console.error('runBoardWriteback error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

module.exports = {
  getGoalLinks,
  setGoalLink,
  clearGoalLink,
  acceptGoalSuggestions,
  runBoardWriteback,
  // Exported for the tests.
  publicLink,
  keywordSourcesFor,
  gateByGoal,
  readGoalTarget,
};
