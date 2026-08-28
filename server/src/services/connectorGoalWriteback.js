const Board = require('../models/Board');
const Goal = require('../models/Goal');
const GoalConnectorLink = require('../models/GoalConnectorLink');
const ConnectorFieldMapping = require('../models/ConnectorFieldMapping');
const ConnectorProject = require('../models/ConnectorProject');
const ConnectorSnapshot = require('../models/ConnectorSnapshot');

const { getConnector } = require('./connectors');
const { snapshotGoal, logGoalChanges } = require('./goalActivity');
const {
  parseTargetId,
  targetId,
  targetsForBoard,
  readGoalTarget,
  sameCellValue,
  isEmptyCellValue,
  targetAppliesTo,
} = require('./connectors/fieldMapping');
const { getGoalType, isGoalType } = require('../utils/goalTypes');
const {
  isMonthKey,
  monthKeyOf,
  firstDayKeyOf,
  lastDayKeyOf,
} = require('../utils/monthKey');

/**
 * Goal writeback — the payoff, and the generic half of it.
 *
 * ---- What this file knows, and what it deliberately does not ---------------
 *
 * It does not know what a rank is, what a keyword is, or that Ubersuggest
 * exists. It reads three kinds of row and joins them:
 *
 *   `ConnectorFieldMapping`  — "on this board, `rank` fills the column `<id>`"
 *   `GoalConnectorLink`      — "this goal is about the phrase `<keyword>`"
 *   `ConnectorSnapshot`      — the readings themselves
 *
 * …and asks the PROVIDER DESCRIPTOR to pull the value out
 * (`connector.readField`). Everything trade-shaped is in one of those three
 * places, which is why the Ads-board connector needs no second writeback.
 *
 * The moment this file gains an `if (provider === …)`, or a mention of a field
 * key, the seam is gone. Same rule as `snapshotService.js` and
 * `projectMirror.js` next door.
 *
 * ---- The ownership rule, which is the whole feature ------------------------
 *
 * A team stops trusting an integration the first time it silently overwrites
 * something somebody typed. So, per (goal × mapped field):
 *
 *   FIRST RUN AFTER LINKING (`link.claimedAt == null`) — the connector CLAIMS
 *     the cell and writes regardless of what is in it. This is the deliberate
 *     answer to the day-one problem: every goal on these boards was typed by
 *     hand, so a pure never-overwrite rule would fill nothing at all and the
 *     feature would look broken on the day it shipped. Claiming is also what
 *     repairs the known-bad rows — the zero volumes, the impossible difficulty
 *     scores, the row where volume and KD were entered the wrong way round —
 *     as a side effect of linking rather than as a migration.
 *
 *   EVERY RUN AFTER THAT — write only if the cell still holds what the
 *     connector last put there (`applied[field].value`), or is empty. Otherwise
 *     a human has taken it: record `suggested[field]`, leave the value alone,
 *     and let the row offer "Ubersuggest says 1,400 — accept?".
 *
 * `claimedAt` is stamped ONCE per link, so re-pointing a link at a different
 * keyword does not silently re-claim cells a human has since corrected.
 *
 * ---- Why an unattended run will not touch the PROMISE ----------------------
 *
 * `goalController.RESULT_ONLY_FIELDS` splits a goal in half: `actual`,
 * `actualDayKey` and `columnValues` are the RESULT and need `goal.track`;
 * anything under `config` is the PROMISE and needs `goal.manage`. The weekly run
 * has no principal — nobody was watching, and there is nobody whose permission
 * it could be acting under — so it fills the result half and records the promise
 * half as a SUGGESTION for a person holding `goal.manage` to accept.
 *
 * That is not a permissions technicality. Rewriting what a team promised a
 * client, unattended, at 04:00, is a different act from recording what happened,
 * and it should stay one somebody chose.
 */

/** How far back to look for "where this stood when the month began". */
const LOOKBACK_DAYS = 120;

/** A ceiling on the per-project history query, so one run cannot pull a year. */
const MAX_SNAPSHOT_ROWS = 400;

/** Shift a `YYYY-MM-DD` day key by whole days, UTC. */
const shiftDayKey = (dayKey, days) => {
  const d = new Date(`${dayKey}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return dayKey;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/**
 * The two readings a month needs, per snapshot kind.
 *
 * `latest` is the newest reading INSIDE the month — never a later one, because
 * September's rank is not August's result, and never an earlier one, because a
 * month with no collection in it has no result and saying so is better than
 * quietly reporting July's.
 *
 * `monthStart` is where the number stood when the month began: the last reading
 * at or before the first of the month. A link made mid-month has none, so it
 * falls back to the EARLIEST reading inside the month — which is the closest
 * honest answer to "where did we start" and is still a fixed point, unlike
 * `latest`, so the goal does not score itself against itself.
 *
 * Pure. Rows must arrive newest-first.
 *
 * @param {Array<Object>} rows - snapshot rows, sorted by periodKey descending
 * @param {{monthStart: string, monthEnd: string, variant: string|null}} window
 * @returns {Map<string, {latest: Object|null, monthStart: Object|null}>}
 */
const selectSnapshots = (rows, { monthStart, monthEnd, variant = null }) => {
  const out = new Map();

  // Which rank-tracking series to read. An explicit choice on the link wins;
  // otherwise the newest one, which is the right answer for the ordinary
  // project that only tracks one market.
  const positionsRows = rows.filter((r) => r.kind === 'positions');
  const resolvedVariant =
    (variant && positionsRows.some((r) => r.variant === variant) ? variant : null) ||
    positionsRows[0]?.variant ||
    null;

  for (const row of rows) {
    // A rank report for another market is a different fact about the same
    // keyword, and mixing the two would make one goal's history flip between
    // countries week to week.
    if (row.kind === 'positions' && resolvedVariant && row.variant !== resolvedVariant) {
      continue;
    }
    if (!out.has(row.kind)) {
      out.set(row.kind, { latest: null, monthStart: null, earliestInMonth: null });
    }
    const slot = out.get(row.kind);

    if (row.periodKey >= monthStart && row.periodKey <= monthEnd) {
      if (!slot.latest) slot.latest = row;
      // Rows arrive newest-first, so the last one seen inside the month is the
      // earliest one.
      slot.earliestInMonth = row;
    } else if (row.periodKey < monthStart && !slot.monthStart) {
      slot.monthStart = row;
    }
  }

  for (const slot of out.values()) {
    if (!slot.monthStart) slot.monthStart = slot.earliestInMonth;
    delete slot.earliestInMonth;
  }
  return out;
};

/**
 * What one run would do to one goal, decided without writing anything.
 *
 * Pure, and separated for exactly that reason: the ownership rule above is the
 * part that must be right, and "did it correctly refuse to overwrite a hand
 * edit" is a property worth asserting without a database.
 *
 * @param {Object} args
 * @param {Object} args.goal      - a Goal document or lean object
 * @param {Object} args.link      - a GoalConnectorLink, lean
 * @param {Array<Object>} args.mappings - the board's mapping rows for one provider
 * @param {(key: string) => Object|null} args.fieldFor  - the provider's catalog
 * @param {(key, data, ctx) => any} args.readField      - the provider's extractor
 * @param {Map} args.snapshots    - from `selectSnapshots`
 * @param {(capability: string) => boolean} args.canWrite
 * @param {Date} args.now
 * @returns {{writes: Array, suggestions: Array, notes: string[], skipped: number}}
 */
const planGoalWrites = ({
  goal,
  link,
  mappings,
  fieldFor,
  readField,
  snapshots,
  canWrite,
  now = new Date(),
}) => {
  const writes = [];
  const suggestions = [];
  const notes = [];
  let skipped = 0;

  const typeSpec = isGoalType(goal.type) ? getGoalType(goal.type) : null;
  const claiming = !link?.claimedAt;
  const rowAutoFill = link?.autoFill !== false;
  const applied = link?.applied instanceof Map
    ? Object.fromEntries(link.applied)
    : (link?.applied || {});
  const keyword = link?.keyword || null;

  /** Said once per kind rather than once per field of that kind. */
  const notedKinds = new Set();
  const noteOnce = (key, sentence) => {
    if (notedKinds.has(key)) return;
    notedKinds.add(key);
    notes.push(sentence);
  };

  for (const mapping of mappings) {
    const field = fieldFor(mapping.sourceField);
    // A mapping can outlive the field it names — somebody removed an entry from
    // a provider catalog while a board still had it bound. Skipping is the only
    // sane answer; throwing would take every other field on the board down with
    // it.
    if (!field) {
      skipped += 1;
      continue;
    }

    const target = parseTargetId(targetId(mapping.target));
    if (!target) {
      skipped += 1;
      continue;
    }

    // A board's goals are a MIXTURE of types and a mapping is per board, so the
    // same mapping meets all of them. Writing `config.target` onto a checklist,
    // or a number into a deadline's `actual`, would be invisible and wrong.
    if (!targetAppliesTo(target, typeSpec)) {
      skipped += 1;
      continue;
    }

    // A fact about one phrase needs to know which phrase. A goal linked to the
    // project alone fills the project-scoped fields and nothing else — that is
    // what `scope` on the catalog is for, and guessing the keyword from the
    // goal's NAME is the one failure mode worth engineering against: a fuzzy
    // match that is wrong produces an entirely plausible number in the wrong
    // row.
    if (field.scope === 'keyword' && !keyword) {
      skipped += 1;
      continue;
    }

    const slot = snapshots.get(field.kind);
    // WHICH WEEK'S reading, decided by the target rather than here — see
    // `period` on `GOAL_BUILTINS`. Only the starting point looks backwards, and
    // that one rule lives in `fieldMapping.js` beside the target it belongs to.
    const period = mapping.targetPeriod === 'monthStart' ? 'monthStart' : 'latest';
    const snapshot = slot?.[period] || null;
    if (!snapshot) {
      noteOnce(
        `${field.kind}:${period}`,
        period === 'monthStart'
          ? `No ${field.kind.replace(/_/g, ' ')} reading from before this month, so the starting point could not be filled.`
          : `No ${field.kind.replace(/_/g, ' ')} collected for this month yet.`
      );
      skipped += 1;
      continue;
    }

    const value = readField(field.key, snapshot.data, { keyword });

    /**
     * A null is NEVER written.
     *
     * Two different nulls arrive here and both come out the same way. One is an
     * ANSWER — the domain does not rank in the top 100 — and the other is a gap,
     * a keyword the last collection did not carry. Neither may be written,
     * because every goal cell's empty state already reads as "not reported yet",
     * so writing a null would replace a real hand-typed number with something
     * that looks like nobody has done the work. That is precisely the clobber
     * the ownership rule exists to prevent, and it would happen on a CLAIM,
     * where the ownership rule is deliberately not looking.
     *
     * The answer-shaped null is still worth saying out loud, so it becomes a
     * note on the row rather than silence.
     */
    if (isEmptyCellValue(value)) {
      if (field.nullMeans) noteOnce(`null:${field.key}`, `${field.label}: ${field.nullMeans}`);
      skipped += 1;
      continue;
    }

    const entry = {
      sourceField: field.key,
      fieldLabel: field.label,
      target,
      targetId: targetId(mapping.target),
      targetLabel: mapping.targetLabel || null,
      value,
      capability: mapping.targetCapability || 'goal.track',
      periodKey: snapshot.periodKey,
      collectedAt: snapshot.collectedAt || null,
      at: now,
    };

    // Two switches, two scopes, and both mean "show me, do not write". The
    // mapping's says this VALUE never fills itself anywhere; the link's says
    // this ROW does not.
    if (mapping.autoFill === false || !rowAutoFill) {
      suggestions.push({ ...entry, reason: 'autoFillOff' });
      continue;
    }

    // The promise half of a goal, from a run with nobody behind it. See the
    // header.
    if (!canWrite(entry.capability)) {
      suggestions.push({ ...entry, reason: 'needsPermission' });
      continue;
    }

    const current = readGoalTarget(goal, target);
    const previous = applied[field.key];

    if (
      claiming ||
      isEmptyCellValue(current) ||
      (previous && sameCellValue(current, previous.value))
    ) {
      // Nothing to do when it already says exactly this — but the run still
      // OWNS the cell, so `applied` is refreshed either way and the write is
      // marked as a no-op so the report does not claim work it did not do.
      writes.push({ ...entry, noop: sameCellValue(current, value) });
      continue;
    }

    suggestions.push({ ...entry, reason: 'humanEdited', current });
  }

  return { writes, suggestions, notes, skipped };
};

/**
 * Put a planned value into a goal document.
 *
 * DELIBERATELY NOT through `PUT /api/goals/:id`. That handler's job is to
 * validate a HUMAN's payload — it re-runs `validateConfig`, it refuses a save
 * while an unrelated required column is empty, and it decides its own gate from
 * the shape of the body. None of that is right for a run that has already
 * decided, per cell, that it is allowed to write this one value: a required
 * column somebody has not filled in on an unrelated row is not a reason to
 * refuse a rank, and re-deriving the gate from the payload would undo the
 * per-target capability check above.
 *
 * What it must NOT do is change the SHAPE of a value, and it does not. There is
 * no stored score to recompute — `goalTypes.js` scores on read — so a written
 * cell is picked up by every reader on the next request with nothing to keep in
 * sync.
 *
 * @param {Object} goal - a Goal DOCUMENT (not lean)
 * @param {Object} write - one entry from `planGoalWrites().writes`
 */
const applyWrite = (goal, write) => {
  const { target, value } = write;
  if (target.kind === 'goalColumn') {
    const id = String(target.columnId);
    if (!goal.columnValues) goal.columnValues = new Map();
    if (typeof goal.columnValues.set === 'function') goal.columnValues.set(id, value);
    else goal.columnValues[id] = value;
    return;
  }
  if (target.builtin === 'actual') {
    goal.actual = value;
    return;
  }
  if (target.builtin === 'actualDayKey') {
    goal.actualDayKey = value;
    return;
  }
  if (target.builtin === 'config.baseline' || target.builtin === 'config.target') {
    const key = target.builtin.slice('config.'.length);
    goal.config = { ...(goal.config || {}), [key]: value };
    // `config` is Mixed, so mongoose cannot see a replaced object on its own.
    goal.markModified('config');
  }
};

/**
 * Turn a plan into rows on the link.
 *
 * `applied` is REPLACED for the fields this run wrote and left alone for the
 * rest, rather than rebuilt from the plan — a field whose snapshot was missing
 * this week must keep the provenance of the value it wrote last week, or the
 * next run would read "we never wrote this" and overwrite a human edit made in
 * between.
 *
 * `suggested` is cleared for anything that was written, because a suggestion
 * that has just been superseded by a write is noise on the row.
 */
const stampLink = (link, plan, now) => {
  const applied = link.applied instanceof Map ? link.applied : new Map(Object.entries(link.applied || {}));
  const suggested = link.suggested instanceof Map ? link.suggested : new Map(Object.entries(link.suggested || {}));

  for (const write of plan.writes) {
    applied.set(write.sourceField, {
      value: write.value,
      targetId: write.targetId,
      at: now,
    });
    suggested.delete(write.sourceField);
  }
  for (const suggestion of plan.suggestions) {
    suggested.set(suggestion.sourceField, {
      value: suggestion.value,
      targetId: suggestion.targetId,
      at: now,
    });
  }

  link.applied = applied;
  link.suggested = suggested;
  link.markModified('applied');
  link.markModified('suggested');
  link.lastSyncAt = now;
  link.lastNote = plan.notes[0] || '';
  if (!link.claimedAt && plan.writes.length > 0) link.claimedAt = now;
};

/**
 * The board's mapping rows, resolved against its targets.
 *
 * The CAPABILITY comes from the resolved target rather than from the mapping
 * row, because it is a property of where the value lands and not of the binding
 * — and because a mapping row saved before a column was created could otherwise
 * carry a stale one. `targetsForBoard` is the single place that decides it.
 *
 * An ARCHIVED column is dropped here. Its mapping is deliberately kept (an
 * archived column keeps its values and can be restored, which is why the purge
 * deletes the mapping and the archive does not) but filling a cell nobody can
 * see is work with no reader.
 */
const resolveMappings = (board, rows) => {
  const byId = new Map(targetsForBoard(board).map((t) => [t.id, t]));
  return rows
    .map((row) => {
      const id = targetId(row.target);
      const target = id ? byId.get(id) : null;
      if (!target || target.archived) return null;
      return {
        sourceField: row.sourceField,
        provider: row.provider,
        target: row.target,
        autoFill: row.autoFill !== false,
        targetCapability: target.capability,
        targetPeriod: target.period || 'latest',
        targetLabel: target.label,
      };
    })
    .filter(Boolean)
    .sort((a, b) => (a.sourceField < b.sourceField ? -1 : 1));
};

/**
 * One writeback pass over one board.
 *
 * Reads STORED SNAPSHOTS ONLY and never contacts a provider — the same property
 * `getConnectorData` holds, and for the same reason: quota is finite and shared
 * across the whole workspace, and this runs after every collection and behind
 * every button. Collecting is `snapshotService`'s job; this one only decides
 * where what was collected goes.
 *
 * @param {Object} args
 * @param {Object} args.board - a Board document or lean object
 * @param {string} [args.provider] - one provider, or every mapped one
 * @param {string} [args.monthKey] - defaults to the board's current month
 * @param {Array<string>} [args.goalIds] - narrow to specific goals
 * @param {{userId: string, can: (cap: string) => boolean}|null} [args.actor]
 *   null for the unattended run, which is what limits it to the result half
 * @param {Date} [args.now]
 * @returns {Promise<Object>} a report
 */
const runWriteback = async ({
  board,
  provider = null,
  monthKey = null,
  goalIds = null,
  actor = null,
  now = new Date(),
}) => {
  const report = {
    boardId: String(board._id),
    monthKey: null,
    linked: 0,
    goalsWritten: 0,
    written: 0,
    suggested: 0,
    skipped: 0,
    claimed: 0,
    notes: [],
  };

  const month = isMonthKey(monthKey)
    ? monthKey
    : monthKeyOf(now, board.monthTimezone || 'UTC');
  report.monthKey = month;

  const monthStart = firstDayKeyOf(month);
  const monthEnd = lastDayKeyOf(month);
  if (!monthStart || !monthEnd) return report;

  const linkFilter = { board: board._id, monthKey: month };
  if (provider) linkFilter.provider = provider;
  if (goalIds) linkFilter.goal = { $in: goalIds };

  const links = await GoalConnectorLink.find(linkFilter);
  if (!links.length) return report;
  report.linked = links.length;

  const goals = await Goal.find({ _id: { $in: links.map((l) => l.goal) } });
  const goalById = new Map(goals.map((g) => [String(g._id), g]));

  const mappingFilter = { board: board._id };
  if (provider) mappingFilter.provider = provider;
  const mappingRows = await ConnectorFieldMapping.find(mappingFilter).lean();
  const resolved = resolveMappings(board, mappingRows);
  const mappingsByProvider = new Map();
  for (const row of resolved) {
    if (!mappingsByProvider.has(row.provider)) mappingsByProvider.set(row.provider, []);
    mappingsByProvider.get(row.provider).push(row);
  }

  /**
   * The project each (group, provider) currently feeds — re-read on every run
   * rather than trusted from the link. A group re-pointed at a different domain
   * is a statement about whose numbers this client's rows carry, and a link
   * still reading the old project would keep filling cells with somebody else's
   * ranks: silently, and with entirely plausible numbers.
   */
  const groupIds = [...new Set(links.map((l) => String(l.group)))];
  const projectRows = await ConnectorProject.find({
    group: { $in: groupIds },
    ...(provider ? { provider } : {}),
  })
    .select('_id group provider domain name')
    .lean();
  const projectFor = new Map(
    projectRows.map((p) => [`${String(p.group)}|${p.provider}`, p])
  );

  // One history read per project, shared by every goal that links to it.
  const projectIds = [...new Set(projectRows.map((p) => String(p._id)))];
  const snapshotRows = projectIds.length
    ? await ConnectorSnapshot.find({
        project: { $in: projectIds },
        periodKey: { $gte: shiftDayKey(monthStart, -LOOKBACK_DAYS), $lte: monthEnd },
      })
        .select('project kind variant periodKey collectedAt data status')
        .sort({ periodKey: -1, fetchedAt: -1 })
        .limit(MAX_SNAPSHOT_ROWS * Math.max(1, projectIds.length))
        .lean()
    : [];

  const rowsByProject = new Map();
  for (const row of snapshotRows) {
    const key = String(row.project);
    if (!rowsByProject.has(key)) rowsByProject.set(key, []);
    rowsByProject.get(key).push(row);
  }

  /**
   * What this run is allowed to write.
   *
   * `goal.track` for a run with nobody behind it — the result half of a goal.
   * Anything under `config` is the promise, and a schedule does not get to
   * rewrite what a team told a client they would do. See the header.
   */
  const canWrite = (capability) =>
    actor ? !!actor.can(capability) : capability === 'goal.track';

  const notes = new Set();

  for (const link of links) {
    const goal = goalById.get(String(link.goal));
    // A goal deleted while its link survived. Cleaned up rather than skipped —
    // a link with no goal can never do anything again.
    if (!goal) {
      // eslint-disable-next-line no-await-in-loop
      await GoalConnectorLink.deleteOne({ _id: link._id });
      report.skipped += 1;
      continue;
    }

    const connector = getConnector(link.provider);
    if (!connector || typeof connector.readField !== 'function') {
      report.skipped += 1;
      continue;
    }

    const mappings = mappingsByProvider.get(link.provider) || [];
    if (!mappings.length) {
      report.skipped += 1;
      continue;
    }

    const project = projectFor.get(`${String(link.group)}|${link.provider}`) || null;
    if (!project) {
      notes.add(
        'A linked group has no project mapped for this connector, so nothing could be read for it.'
      );
      link.lastSyncAt = now;
      link.lastNote = 'This group is not mapped to a project any more.';
      // eslint-disable-next-line no-await-in-loop
      await link.save();
      report.skipped += 1;
      continue;
    }

    const snapshots = selectSnapshots(rowsByProject.get(String(project._id)) || [], {
      monthStart,
      monthEnd,
      variant: link.variant || null,
    });

    const wasUnclaimed = !link.claimedAt;
    const plan = planGoalWrites({
      goal,
      link,
      mappings,
      fieldFor: (key) => (connector.fields || []).find((f) => f.key === key) || null,
      readField: connector.readField,
      snapshots,
      canWrite,
      now,
    });

    // The before-image, read while the goal still holds what it held. A number
    // that changed itself overnight is the single most alarming thing a client
    // report can contain, so the writeback logs like any other editor — the
    // difference is only in WHO it says did it.
    const before = snapshotGoal(goal);

    let changed = false;
    for (const write of plan.writes) {
      if (write.noop) continue;
      applyWrite(goal, write);
      changed = true;
      report.written += 1;
    }
    if (changed) {
      goal.updatedBy = actor?.userId || goal.updatedBy || null;
      // eslint-disable-next-line no-await-in-loop
      await goal.save();
      report.goalsWritten += 1;
      // eslint-disable-next-line no-await-in-loop
      await logGoalChanges({
        goal,
        before,
        columns: (board.goalColumns || []).filter((c) => !c.archived),
        // A run somebody pressed a button for is that person's edit; the hourly
        // pass belongs to nobody, so it is stamped `system` and named after the
        // connector rather than left as an anonymous change.
        actor: actor?.userId || null,
        actorType: actor ? 'user' : 'system',
        actorLabel: actor ? '' : (connector.label || link.provider),
      });
    }

    link.project = project._id;
    stampLink(link, plan, now);
    if (wasUnclaimed && link.claimedAt) report.claimed += 1;
    // eslint-disable-next-line no-await-in-loop
    await link.save();

    report.suggested += plan.suggestions.length;
    report.skipped += plan.skipped;
    plan.notes.forEach((n) => notes.add(n));
  }

  report.notes = [...notes];
  return report;
};

/**
 * Run the writeback for every board a set of projects feeds.
 *
 * The runner's entry point. Projects are what a collection pass knows about;
 * boards are what a writeback needs, and the two are many-to-many — a project
 * mapped to groups on two boards fills goals on both.
 *
 * Never throws. A board whose writeback fails must not abandon the next board's,
 * for the same reason a project that failed to collect does not end the run:
 * the pass either has partial results or none, and partial is better.
 *
 * @param {Array<string>} projectIds
 * @param {Object} [opts]
 * @returns {Promise<Array<Object>>} one report per board
 */
const writeBackForProjects = async (projectIds, { provider = null, now = new Date() } = {}) => {
  if (!projectIds?.length) return [];

  const boardIds = await ConnectorProject.distinct('board', {
    _id: { $in: projectIds },
    board: { $ne: null },
  });
  if (!boardIds.length) return [];

  const boards = await Board.find({ _id: { $in: boardIds }, boardType: 'tracker' })
    .select('_id organisation goalColumns monthTimezone')
    .lean();

  const reports = [];
  for (const board of boards) {
    try {
      // eslint-disable-next-line no-await-in-loop
      reports.push(await runWriteback({ board, provider, actor: null, now }));
    } catch (err) {
      console.error('[connectorWriteback] board', String(board._id), 'failed:', err);
    }
  }
  return reports;
};

module.exports = {
  runWriteback,
  writeBackForProjects,
  // Pure, and exported because they are what the tests assert on.
  planGoalWrites,
  selectSnapshots,
  applyWrite,
  stampLink,
  resolveMappings,
  shiftDayKey,
  LOOKBACK_DAYS,
};
