const mongoose = require('mongoose');

const ConnectorFieldMapping = require('../models/ConnectorFieldMapping');
const BoardConnector = require('../models/BoardConnector');

const { getConnector } = require('../services/connectors');
const {
  targetsForBoard,
  findTarget,
  parseTargetId,
  targetId,
  checkCompatibility,
  publicField,
  GOAL_BUILTINS,
} = require('../services/connectors/fieldMapping');
const { isConnectorProvider } = require('../utils/connectorProviders');
const { gateBoard } = require('./connectorController');

/**
 * The connector FIELD MAPPING plane — which provider value fills which goal cell.
 *
 * Third file in the set, and the split is the same one the other two already
 * make. `connectorController.js` is accounts and enablement; `connectorDataController.js`
 * is the readings themselves; this is the WIRING between the two vocabularies.
 * The gate is imported, never copied — there is exactly one `gateBoard`.
 *
 * ---- Nothing here contacts a provider --------------------------------------
 *
 * Every handler reads our own database and the descriptor's static catalog.
 * That is what lets the read sit on `connector.view`, the bottom rung, and be
 * safe on every render — the same property `getConnectorData` holds and for the
 * same reason: quota is finite and shared across the whole workspace.
 *
 * ---- Why the refusal happens here and not at 3am ---------------------------
 *
 * A type-incompatible mapping breaks nothing at save time. It breaks inside a
 * weekly run, on one field of one board, and the only symptom is a cell that
 * never fills — which is indistinguishable from "the sync has not run yet" and
 * goes unreported for a month. So `checkCompatibility` runs on the way in, and
 * the 400 carries the sentence naming both sides.
 */

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

/**
 * The gate every handler here shares: board, capability, board type, provider —
 * plus the one thing specific to this plane, which is that the provider must
 * actually declare a field catalog.
 *
 * A provider that has not reached phase 4 exists, can be connected, and has
 * projects and snapshots. It simply has nothing to map. Saying so beats a 500
 * from iterating `null`, and beats an empty panel with no explanation.
 */
const gateFields = async (req, res, capability) => {
  const { provider } = req.params;

  const ctx = await gateBoard(req, res, capability);
  if (!ctx) return null;

  const connector = isConnectorProvider(provider) ? getConnector(provider) : null;
  if (!connector) {
    res.status(400).json({ error: `Unknown connector "${provider}"` });
    return null;
  }
  if (!Array.isArray(connector.fields)) {
    res.status(409).json({
      error: `${connector.label} has no fields that can be mapped yet.`,
      code: 'NO_FIELD_SUPPORT',
    });
    return null;
  }

  return { ctx, connector, provider };
};

/**
 * The public shape of a mapping row. Hand-built for the same reason
 * `publicAccount` and `publicSnapshot` are: a field added to the model later
 * must not reach a client by default.
 *
 * `targetId` is the flattened wire form — one string, so the panel's `Dropdown`
 * can use it as a value without the client reassembling `kind` + `columnId`
 * into a key of its own and getting the format subtly wrong.
 */
const publicMapping = (row) => ({
  _id: row._id,
  provider: row.provider,
  sourceField: row.sourceField,
  target: {
    kind: row.target?.kind || null,
    columnId: row.target?.columnId ? String(row.target.columnId) : null,
    builtin: row.target?.builtin || null,
  },
  targetId: targetId(row.target),
  autoFill: row.autoFill !== false,
  updatedAt: row.updatedAt || null,
});

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * GET /api/boards/:boardId/connectors/:provider/fields
 *
 * Everything the mapping panel needs, in one request: the provider's catalog,
 * this board's targets, the refusals, and the mappings that already exist.
 *
 * The REFUSALS are the part worth naming. They are computed here, per (field,
 * target) pair, from the same `checkCompatibility` the save path uses — so the
 * option the panel greys out and the save the server would reject are the same
 * decision made once. A client that re-derived the rule would be a second
 * implementation of it, and two implementations of a rule agree right up until
 * they quietly do not.
 */
const getConnectorFields = async (req, res) => {
  try {
    const gated = await gateFields(req, res, 'connector.view');
    if (!gated) return undefined;
    const { ctx, connector, provider } = gated;

    const targets = targetsForBoard(ctx.board);

    const [rows, boardConnector] = await Promise.all([
      ConnectorFieldMapping.find({ board: ctx.board._id, provider })
        .sort({ sourceField: 1 })
        .lean(),
      BoardConnector.findOne({ board: ctx.board._id, provider })
        .select('enabled kinds')
        .lean(),
    ]);

    /**
     * Which snapshot kinds this board actually collects.
     *
     * An empty `kinds` selection means EVERYTHING — the same rule
     * `resolveKinds` applies on the descriptor, and repeating it here rather
     * than reading it as "collect nothing" is what stops the panel telling a
     * freshly enabled board that none of its fields will ever fill.
     */
    const resolved =
      typeof connector.resolveKinds === 'function'
        ? connector.resolveKinds(boardConnector?.kinds, { includeManualOnly: true })
        : connector.kinds;
    const collected = new Set((resolved || []).map((k) => k.key));

    return res.json({
      canManage: !!ctx.can('connector.manage'),
      provider: {
        name: connector.name,
        label: connector.label,
        kinds: (connector.kinds || []).map((k) => ({
          key: k.key,
          label: k.label,
          blurb: k.blurb,
        })),
      },
      enabled: !!boardConnector?.enabled,
      fields: connector.fields.map((f) => ({
        ...publicField(f, targets),
        // A field whose kind this board switched off can still be mapped — the
        // selection is changeable and a mapping outliving it is the point — but
        // it will not fill until the kind comes back, and the panel says so
        // rather than leaving a cell mysteriously empty.
        collected: collected.has(f.kind),
      })),
      targets,
      builtins: GOAL_BUILTINS,
      mappings: rows.map(publicMapping),
    });
  } catch (err) {
    console.error('getConnectorFields error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * PUT /api/boards/:boardId/connectors/:provider/fields/:field
 * Body: { targetId: 'column:<id>' | 'builtin:<key>', autoFill?: boolean }
 *
 * Bind one provider field to one place on the goal, replacing whatever that
 * field was bound to before.
 *
 * `connector.manage`, not `goal.manage`. Deciding that "Search volume fills the
 * Volume column" is connector wiring — the same act as deciding which project
 * feeds which group — and it writes nothing to a goal on its own. The capability
 * a mapping IMPLIES for the eventual sync is carried on the target and shown in
 * the panel; enforcing it is phase 5's job, at the moment a value is actually
 * written, where the principal is known.
 */
const setConnectorFieldMapping = async (req, res) => {
  try {
    const gated = await gateFields(req, res, 'connector.manage');
    if (!gated) return undefined;
    const { ctx, connector, provider } = gated;

    const fieldKey = req.params.field;
    const field = connector.fields.find((f) => f.key === fieldKey) || null;
    if (!field) {
      return res.status(400).json({
        error: `${connector.label} has no "${fieldKey}" field.`,
      });
    }

    const wanted = req.body?.targetId;
    if (typeof wanted !== 'string' || !wanted) {
      return res.status(400).json({ error: 'Choose where this field should go.' });
    }

    const parsed = parseTargetId(wanted);
    if (!parsed) {
      return res.status(400).json({ error: 'That is not somewhere a value can go.' });
    }
    if (parsed.kind === 'goalColumn' && !isValidId(parsed.columnId)) {
      return res.status(400).json({ error: 'Invalid column id' });
    }

    // Resolved against THIS board, which is what stops a mapping naming a column
    // on somebody else's board — and the reason the target is an `_id` rather
    // than a key: a slug would resolve on any board that happened to use the
    // same word.
    const target = findTarget(ctx.board, wanted);
    if (!target) {
      return res.status(400).json({ error: 'That column is not on this board.' });
    }
    if (target.archived) {
      return res.status(400).json({
        error: `“${target.label}” is archived, so nothing would be able to see what lands in it. Restore the column first.`,
        code: 'COLUMN_ARCHIVED',
      });
    }

    const verdict = checkCompatibility(field, target);
    if (!verdict.ok) {
      // The one refusal this whole file exists for. A 400 with a sentence now,
      // rather than a cell that silently never fills after a weekly run at 3am.
      return res.status(400).json({ error: verdict.reason, code: 'INCOMPATIBLE_TYPE' });
    }

    // A target holds ONE source. Ask first so the answer names the field that
    // already has it, rather than a duplicate-key error the panel has to guess
    // at — the same courtesy `setConnectorProjectGroup` extends for a group.
    const clashFilter =
      target.kind === 'goalColumn'
        ? { board: ctx.board._id, 'target.columnId': parsed.columnId }
        : { board: ctx.board._id, 'target.builtin': parsed.builtin };
    const clash = await ConnectorFieldMapping.findOne({
      ...clashFilter,
      sourceField: { $ne: fieldKey },
    })
      .select('sourceField provider')
      .lean();
    if (clash) {
      const other = getConnector(clash.provider);
      const otherField = (other?.fields || []).find((f) => f.key === clash.sourceField);
      return res.status(409).json({
        error: `“${target.label}” is already filled by ${otherField?.label || clash.sourceField}. Unmap that first.`,
        code: 'TARGET_TAKEN',
      });
    }

    const update = {
      organisation: ctx.board.organisation,
      target: {
        kind: parsed.kind,
        columnId: parsed.kind === 'goalColumn' ? parsed.columnId : null,
        builtin: parsed.kind === 'goalBuiltin' ? parsed.builtin : null,
      },
      updatedBy: req.user.userId,
    };
    if (typeof req.body?.autoFill === 'boolean') update.autoFill = req.body.autoFill;

    let row;
    try {
      // Upsert against (board, provider, sourceField), so re-pointing a field
      // REPLACES its binding rather than adding a second one. That is what makes
      // "remap it and the old column stops updating" true by construction.
      row = await ConnectorFieldMapping.findOneAndUpdate(
        { board: ctx.board._id, provider, sourceField: fieldKey },
        { $set: update, $setOnInsert: { createdBy: req.user.userId } },
        { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true }
      ).lean();
    } catch (err) {
      // The indexes are still the authority — two admins mapping the same column
      // at the same moment both pass the check above.
      if (err.code === 11000) {
        return res.status(409).json({
          error: 'That column was just mapped to another field. Reload and try again.',
          code: 'TARGET_TAKEN',
        });
      }
      throw err;
    }

    return res.json({ mapping: publicMapping(row) });
  } catch (err) {
    console.error('setConnectorFieldMapping error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * DELETE /api/boards/:boardId/connectors/:provider/fields/:field
 *
 * Unbind. Nothing already written is touched — a value the connector put in a
 * cell is a real reading somebody may have reported to a client, and removing
 * the wiring is not a statement about it. Only the future stops.
 */
const deleteConnectorFieldMapping = async (req, res) => {
  try {
    const gated = await gateFields(req, res, 'connector.manage');
    if (!gated) return undefined;
    const { ctx, provider } = gated;

    // Idempotent: unbinding something already unbound is the outcome the caller
    // asked for, not a 404 to handle.
    await ConnectorFieldMapping.deleteOne({
      board: ctx.board._id,
      provider,
      sourceField: req.params.field,
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error('deleteConnectorFieldMapping error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

module.exports = {
  getConnectorFields,
  setConnectorFieldMapping,
  deleteConnectorFieldMapping,
  // Exported for the tests and for phase 5, which reads the same shape.
  publicMapping,
  gateFields,
};
