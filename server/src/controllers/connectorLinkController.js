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
 * The newest `positions` snapshot per project, plus every market we hold for it.
 *
 * ONE definition of "newest", used by the picker, by the match proposal, and by
 * nothing else. Two callers disagreeing about which snapshot is the current one
 * would show a keyword list from last week beside a rank from this one, and the
 * disagreement would be invisible on screen.
 *
 * @param {any[]} projectIds
 * @returns {Promise<Map<string, {newest: any, variants: Set<string>}>>}
 */
const newestPositionsByProject = async (projectIds) => {
  const byProject = new Map();
  if (!projectIds.length) return byProject;

  const rows = await ConnectorSnapshot.find({
    project: { $in: projectIds },
    kind: 'positions',
  })
    .select('project variant periodKey data')
    .sort({ periodKey: -1, fetchedAt: -1 })
    .limit(MAX_KEYWORD_OPTIONS)
    .lean();

  for (const row of rows) {
    const key = String(row.project);
    if (!byProject.has(key)) byProject.set(key, { newest: row, variants: new Set() });
    byProject.get(key).variants.add(row.variant);
  }
  return byProject;
};

/**
 * The one keyword-validation rule, shared by the single link and the bulk one.
 *
 * Returns the trimmed phrase, `null` for "link the project and no keyword", or
 * `undefined` for a value that is not a keyword at all — three outcomes, because
 * the caller has to tell the second apart from the third to answer 400.
 */
const normaliseKeyword = (raw) => {
  if (typeof raw === 'string' && raw.trim()) return raw.trim().slice(0, MAX_KEYWORD_LENGTH);
  if (raw === undefined || raw === null || raw === '') return null;
  return undefined;
};

/** Same rule for a market, which is a free string at the provider. */
const normaliseVariant = (raw) =>
  typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 120) : null;

/**
 * Write one link. THE single writer, so the bulk path cannot drift from the one
 * a person makes by hand in the modal.
 *
 * `claimedAt` is deliberately absent from the update: re-pointing a link must
 * not hand the connector permission to overwrite cells a human corrected after
 * the first sync. Same reason it is absent from `setGoalLink` — this IS that
 * code, moved.
 */
const upsertLink = ({ board, goal, provider, project, keyword, variant, autoFill, userId }) => {
  const update = {
    board: board._id,
    organisation: board.organisation,
    group: goal.group,
    monthKey: goal.monthKey,
    provider,
    project: project._id,
    keyword: keyword ?? null,
    variant: variant ?? null,
    updatedBy: userId,
  };
  if (typeof autoFill === 'boolean') update.autoFill = autoFill;

  return GoalConnectorLink.findOneAndUpdate(
    { goal: goal._id },
    { $set: update, $setOnInsert: { linkedBy: userId } },
    { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true }
  ).lean();
};

/**
 * Which of this board's cells a connector value is bound to, decorated for the
 * client.
 *
 * Shared by the Goals tab's own read and by the match proposal, because both
 * have to answer the same question before anybody links anything: "will this
 * actually fill a cell?" A board with a project mapped, links made, and NO field
 * mapping fills nothing at all, and that is worth saying before twenty-six links
 * are made rather than after.
 */
const mappedFieldsFor = async (board, provider) => {
  const mappings = await ConnectorFieldMapping.find({
    board: board._id,
    ...(provider ? { provider } : {}),
  }).lean();

  const targetById = new Map(targetsForBoard(board).map((t) => [t.id, t]));
  const fieldLabels = new Map();
  for (const row of mappings) {
    const connector = getConnector(row.provider);
    const field = (connector?.fields || []).find((f) => f.key === row.sourceField);
    if (field) fieldLabels.set(`${row.provider}|${row.sourceField}`, field.label);
  }

  const mappedFields = mappings
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
    .filter(Boolean);

  return { mappings, targetById, fieldLabels, mappedFields };
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

  const byProject = await newestPositionsByProject(projects.map((p) => p._id));

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

    const [links, resolved, sources] = await Promise.all([
      GoalConnectorLink.find(linkFilter).lean(),
      mappedFieldsFor(ctx.board, provider || null),
      keywordSourcesFor(ctx.board, provider || null),
    ]);
    const { targetById, fieldLabels, mappedFields } = resolved;

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
      mappedFields,
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

    const keyword = normaliseKeyword(req.body?.keyword);
    if (keyword === undefined) {
      return res.status(400).json({ error: 'That is not a keyword.' });
    }

    const link = await upsertLink({
      board: ctx.board,
      goal,
      provider,
      project,
      keyword,
      variant: normaliseVariant(req.body?.variant),
      autoFill: req.body?.autoFill,
      userId: req.user.userId,
    });

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

// ---------------------------------------------------------------------------
// Linking a whole month at once
// ---------------------------------------------------------------------------

/** A ceiling on one bulk call. A month of goals, not a migration. */
const MAX_BULK_LINKS = 300;

/**
 * Normalise a phrase for COMPARISON only — never for storage.
 *
 * Case and repeated spaces are the two ways the same phrase gets typed
 * differently by a person and by a provider, and neither changes what the
 * phrase IS. Nothing else is touched: no stemming, no plural folding, no
 * punctuation stripping. "thca quarter pound" and "thca quarter pounds" are two
 * keywords that rank differently, and a matcher clever enough to join them is
 * exactly the fuzzy match this feature refuses to make.
 *
 * The value STORED on a link is always the provider's own spelling, because
 * that is what `readField` looks the row up by.
 */
const matchKey = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * GET /api/boards/:boardId/goal-links/matches?month=YYYY-MM&provider=…
 *
 * PROPOSES a keyword for each goal, by exact name. Writes nothing at all.
 *
 * ---- Why this is not the fuzzy match the modal refuses to make -------------
 *
 * `GoalLinkModal` says it plainly: a fuzzy match that is wrong produces an
 * entirely plausible number in the wrong row, on a report somebody sends a
 * client. That is still true, and this endpoint does not weaken it — it makes
 * the SAME choice a person makes in that modal, twenty-six times, and hands the
 * whole list back for them to read and confirm. The rule is exact
 * (case-insensitive, spaces collapsed), a goal matching two keywords is reported
 * as ambiguous rather than resolved, and NOTHING is written until the client
 * posts an explicit list of pairs back to `bulkSetGoalLinks`.
 *
 * So the guarantee is unchanged — the phrase on a link was chosen by a person,
 * from a list, once. What changes is that they confirm twenty-six of them on one
 * screen instead of opening twenty-six dialogs.
 *
 * `connector.manage` — the same rung as making one link, because that is what
 * this is a proposal for.
 */
const getGoalLinkMatches = async (req, res) => {
  try {
    const ctx = await gateBoard(req, res, 'connector.manage');
    if (!ctx) return undefined;

    const month = isMonthKey(req.query?.month)
      ? req.query.month
      : monthKeyOf(new Date(), ctx.board.monthTimezone || 'UTC');

    const provider = req.query?.provider;
    if (provider && !isConnectorProvider(provider)) {
      return res.status(400).json({ error: `Unknown connector "${provider}"` });
    }

    const projectFilter = { board: ctx.board._id, group: { $ne: null } };
    if (provider) projectFilter.provider = provider;
    const projects = await ConnectorProject.find(projectFilter)
      .select('_id group provider name domain missing')
      .sort({ name: 1 })
      .lean();

    const { mappedFields } = await mappedFieldsFor(ctx.board, provider || null);

    if (!projects.length) {
      return res.json({ monthKey: month, groups: [], mappedFields });
    }

    const [byProject, goals, links] = await Promise.all([
      newestPositionsByProject(projects.map((p) => p._id)),
      Goal.find({
        board: ctx.board._id,
        monthKey: month,
        group: { $in: projects.map((p) => p.group) },
      })
        .select('_id name group type order')
        .sort({ order: 1, createdAt: 1 })
        .lean(),
      GoalConnectorLink.find({ board: ctx.board._id, monthKey: month })
        .select('goal provider keyword')
        .lean(),
    ]);

    const linkByGoal = new Map(links.map((l) => [String(l.goal), l]));
    const goalsByGroup = new Map();
    for (const goal of goals) {
      const key = String(goal.group);
      if (!goalsByGroup.has(key)) goalsByGroup.set(key, []);
      goalsByGroup.get(key).push(goal);
    }

    const groups = projects.map((project) => {
      const found = byProject.get(String(project._id));
      const rows = Array.isArray(found?.newest?.data?.keywords)
        ? found.newest.data.keywords
        : [];

      /** matchKey → every tracked row that normalises to it. */
      const rowsByKey = new Map();
      for (const row of rows) {
        const phrase = typeof row?.keyword === 'string' ? row.keyword.trim() : '';
        if (!phrase) continue;
        const key = matchKey(phrase);
        if (!rowsByKey.has(key)) rowsByKey.set(key, []);
        rowsByKey.get(key).push(row);
      }

      const proposals = [];
      const unmatched = [];

      for (const goal of goalsByGroup.get(String(project.group)) || []) {
        const existing = linkByGoal.get(String(goal._id));
        const candidates = rowsByKey.get(matchKey(goal.name)) || [];

        if (candidates.length > 1) {
          unmatched.push({
            goal: String(goal._id),
            name: goal.name,
            type: goal.type,
            reason: 'ambiguous',
          });
          continue;
        }
        if (candidates.length === 0) {
          unmatched.push({
            goal: String(goal._id),
            name: goal.name,
            type: goal.type,
            // A goal already pointed at a keyword its name does not match is a
            // deliberate choice somebody made, not a gap. Saying so stops this
            // screen reading as though the link were missing.
            reason: existing?.keyword ? 'linked-elsewhere' : 'no-match',
            linkedTo: existing?.keyword || null,
          });
          continue;
        }

        const row = candidates[0];
        const already =
          existing && matchKey(existing.keyword) === matchKey(row.keyword);

        proposals.push({
          goal: String(goal._id),
          name: goal.name,
          type: goal.type,
          keyword: String(row.keyword).trim(),
          position: Number.isFinite(row?.position) ? row.position : null,
          previousPosition: Number.isFinite(row?.previousPosition)
            ? row.previousPosition
            : null,
          // Already pointed at this exact keyword — there is nothing to do, and
          // re-linking it would throw away the provenance that protects a cell
          // a human has since corrected.
          alreadyLinked: !!already,
          // Pointed somewhere else. Offered, but never ticked by default: taking
          // it REPLACES a choice somebody made by hand.
          relinkFrom: existing && !already ? existing.keyword || null : null,
        });
      }

      return {
        group: String(project.group),
        provider: project.provider,
        projectId: String(project._id),
        projectName: project.name || project.domain || '',
        domain: project.domain || null,
        missing: !!project.missing,
        collectedOn: found?.newest?.periodKey || null,
        keywordCount: rowsByKey.size,
        proposals,
        unmatched,
      };
    });

    return res.json({ monthKey: month, groups, mappedFields });
  } catch (err) {
    console.error('getGoalLinkMatches error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/boards/:boardId/connectors/:provider/goal-links/bulk
 * Body: { links: [{ goal, keyword?, variant?, autoFill? }] }
 *
 * Make many links in one act, from an EXPLICIT list of pairs.
 *
 * The server does no matching here — it is handed the pairs a person ticked and
 * writes exactly those. That split is the point: `/matches` proposes and cannot
 * write, this one writes and cannot propose, so there is no path from "a name
 * looked similar" to "a number appeared in a client's report" that nobody walked
 * through.
 *
 * One bad row never fails the batch. A goal on another board, a group with no
 * project, a keyword that is not a string — each comes back in `skipped` with a
 * sentence, and the rest are linked. Refusing twenty-five good pairs because a
 * twenty-sixth was stale would be the worse answer, and the same one
 * `acceptGoalSuggestions` already gives per field.
 */
const bulkSetGoalLinks = async (req, res) => {
  try {
    const ctx = await gateBoard(req, res, 'connector.manage');
    if (!ctx) return undefined;

    const { provider } = req.params;
    if (!isConnectorProvider(provider) || !getConnector(provider)) {
      return res.status(400).json({ error: `Unknown connector "${provider}"` });
    }

    const rows = Array.isArray(req.body?.links) ? req.body.links : null;
    if (!rows || !rows.length) {
      return res.status(400).json({ error: 'There is nothing to link.' });
    }
    if (rows.length > MAX_BULK_LINKS) {
      return res.status(400).json({
        error: `That is more than ${MAX_BULK_LINKS} goals at once. Link one month at a time.`,
      });
    }

    /**
     * goal id → the pair asked for. Last one wins, so a row sent twice is not
     * two writes racing each other on the same unique index.
     */
    const wanted = new Map();
    const skipped = [];
    for (const row of rows) {
      const goalId = String(row?.goal || '');
      if (!isValidId(goalId)) {
        skipped.push({ goal: goalId, name: null, reason: 'That is not a goal.' });
        continue;
      }
      wanted.set(goalId, row);
    }
    if (!wanted.size) return res.json({ linked: [], skipped });

    const goals = await Goal.find({
      _id: { $in: [...wanted.keys()] },
      board: ctx.board._id,
    })
      .select('_id name group monthKey')
      .lean();

    const found = new Set(goals.map((g) => String(g._id)));
    for (const id of wanted.keys()) {
      if (!found.has(id)) {
        skipped.push({ goal: id, name: null, reason: 'That goal is not on this board.' });
      }
    }

    const projects = await ConnectorProject.find({
      group: { $in: goals.map((g) => g.group) },
      provider,
    })
      .select('_id group name domain')
      .lean();
    const projectByGroup = new Map(projects.map((p) => [String(p.group), p]));

    const linked = [];
    for (const goal of goals) {
      const row = wanted.get(String(goal._id));
      const project = projectByGroup.get(String(goal.group));
      if (!project) {
        skipped.push({
          goal: String(goal._id),
          name: goal.name,
          reason: 'That goal’s group is not mapped to a project yet.',
        });
        continue;
      }

      const keyword = normaliseKeyword(row?.keyword);
      if (keyword === undefined) {
        skipped.push({
          goal: String(goal._id),
          name: goal.name,
          reason: 'That is not a keyword.',
        });
        continue;
      }

      try {
        const link = await upsertLink({
          board: ctx.board,
          goal,
          provider,
          project,
          keyword,
          variant: normaliseVariant(row?.variant),
          autoFill: row?.autoFill,
          userId: req.user.userId,
        });
        linked.push({
          goal: String(goal._id),
          name: goal.name,
          keyword: link.keyword || null,
        });
      } catch (err) {
        console.error('bulkSetGoalLinks row error:', err);
        skipped.push({
          goal: String(goal._id),
          name: goal.name,
          reason:
            err?.code === 11000
              ? 'That goal was linked from somewhere else at the same moment.'
              : 'Could not link that goal.',
        });
      }
    }

    return res.json({ linked, skipped });
  } catch (err) {
    console.error('bulkSetGoalLinks error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

module.exports = {
  getGoalLinks,
  getGoalLinkMatches,
  setGoalLink,
  bulkSetGoalLinks,
  clearGoalLink,
  acceptGoalSuggestions,
  runBoardWriteback,
  // Exported for the tests.
  publicLink,
  matchKey,
  upsertLink,
  keywordSourcesFor,
  gateByGoal,
  readGoalTarget,
};
