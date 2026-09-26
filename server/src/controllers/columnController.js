/**
 * columnController.js — CRUD for the flexible-columns engine (Phase 1, F1).
 *
 * Routes (wired in routes/boards.js under `:id`):
 *   GET    /api/boards/:id/columns
 *   POST   /api/boards/:id/columns
 *   PATCH  /api/boards/:id/columns/reorder
 *   PATCH  /api/boards/:id/columns/:cid
 *   DELETE /api/boards/:id/columns/:cid
 *
 *   PATCH  /api/boards/:id/currency       (the board's money unit — see below)
 *
 * Reading columns needs only board read access, which `loadBoardContext` already
 * enforces. Every mutation here — including the connect/mirror columns that own
 * a BoardConnection edge — is gated on `column.manage`: retyping or deleting a
 * column restructures the board for everyone on it, so it sits on the `edit`
 * rung rather than with the day-to-day task capabilities. Validation hits
 * `columnTypes.js` before persistence.
 */

const mongoose = require('mongoose');
const Board = require('../models/Board');
const Task = require('../models/Task');
const BoardConnection = require('../models/BoardConnection');
const {
  getColumnType,
  MIRROR_AGGREGATIONS,
  validateFormulaExpression,
} = require('../utils/columnTypes');
const {
  sanitizeColumnCurrency,
  normaliseCurrencyCode,
  boardCurrencyOf,
  isMoneyColumn,
  isOwnMoneyColumn,
} = require('../utils/money');
const {
  ROLE_COLUMN_TYPE,
  NO_ROLE,
  isRole,
  columnRole,
} = require('../utils/columnRoles');
const { settleColumns } = require('../utils/paymentsSettle');
const { wouldCreateMirrorCycle } = require('../services/mirrorRefresh');
const { loadBoardContext, requireCapability } = require('../utils/boardContext');
// The board's money unit — reconcile, relabel, follow, announce. It lives in
// the service because the workspace currency change (orgController) runs the
// very same relabel over every following board.
const {
  formulaRefs,
  moneyCodeOf,
  NUMERIC_MIRROR_AGGREGATIONS,
  reconcileMoneyUnits,
  unitSnapshot,
  unitsMoved,
  followMirrors,
  announceBoardChanged,
  relabelBoardMoney,
  workspaceCurrencyOf,
} = require('../services/boardCurrency');
// Reached through the module object rather than destructured, so the cleanup a
// column delete hands off to can be swapped by a test (boardCurrency.test.js
// replaces it before this file loads; either way works).
const fileColumnAssetsLib = require('../utils/fileColumnAssets');

/**
 * Every route here addresses the board by id straight from the URL. The shared
 * `loadBoardContext` hands an unparseable id to `findById`, which throws a
 * CastError and surfaces as a 500 — so the shape check stays local to keep the
 * 400 these routes have always returned.
 */
const badBoardId = (boardId) =>
  !boardId || !mongoose.Types.ObjectId.isValid(boardId)
    ? { status: 400, error: 'Invalid board id' }
    : null;

const serializeColumns = (board) =>
  (board.columns || [])
    .slice()
    .sort((a, b) => (a.order || 0) - (b.order || 0));

/**
 * Generate a stable slug from a name, then suffix it with `-2`, `-3`, ...
 * until it's unique within the board. Slugs only contain [a-z0-9_].
 */
const slugify = (name) => {
  const base = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return base || 'column';
};

const uniqueSlug = (board, baseName) => {
  const existing = new Set((board.columns || []).map((c) => c.key));
  const base = slugify(baseName);
  if (!existing.has(base)) return base;
  let i = 2;
  while (existing.has(`${base}_${i}`)) i += 1;
  return `${base}_${i}`;
};

const nextOrder = (board) => {
  const cols = board.columns || [];
  if (cols.length === 0) return 0;
  return Math.max(...cols.map((c) => c.order || 0)) + 1;
};

// ---------------------------------------------------------------------------
// F2 — cross-board column settings validation + BoardConnection sync
// ---------------------------------------------------------------------------

/**
 * Validate `connect_boards` settings. `targetBoardIds` must be a non-empty
 * list of board ids in the SAME organisation as the source board (a board
 * can't connect to itself; cross-workspace targets arrive with F3 grants).
 * The synchronous registry validator only checks value shape, so the
 * DB-aware checks live here.
 */
const validateConnectSettings = async (board, settings) => {
  const targetBoardIds = Array.isArray(settings && settings.targetBoardIds)
    ? settings.targetBoardIds
    : [];
  if (targetBoardIds.length === 0) {
    return { error: 'connect_boards requires at least one target board' };
  }
  const ids = [];
  for (const raw of targetBoardIds) {
    const id = raw == null ? '' : raw.toString();
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return { error: 'targetBoardIds contains an invalid board id' };
    }
    if (id === board._id.toString()) {
      return { error: 'A board cannot connect to itself' };
    }
    ids.push(id);
  }
  const uniqueIds = [...new Set(ids)];
  const targets = await Board.find({ _id: { $in: uniqueIds } }).select('organisation');
  if (targets.length !== uniqueIds.length) {
    return { error: 'One or more target boards do not exist' };
  }
  for (const tb of targets) {
    if (!tb.organisation || tb.organisation.toString() !== board.organisation.toString()) {
      return {
        error:
          'Target boards must be in the same workspace (cross-workspace links require a grant — F3)',
      };
    }
  }
  return { ok: true };
};

/**
 * Validate `mirror` settings. The source connect column must be a
 * `connect_boards` column on THIS board; `sourceColumnId` is required; the
 * aggregation must be a supported mode.
 */
const validateMirrorSettings = (board, settings) => {
  const connectId =
    settings && settings.sourceConnectColumnId ? settings.sourceConnectColumnId.toString() : '';
  if (!connectId) return { error: 'mirror requires a sourceConnectColumnId' };
  const connectCol = (board.columns || []).find((c) => c._id.toString() === connectId);
  if (!connectCol || connectCol.type !== 'connect_boards') {
    return {
      error: 'sourceConnectColumnId must reference a connect_boards column on this board',
    };
  }
  if (!settings.sourceColumnId) {
    return { error: 'mirror requires a sourceColumnId' };
  }
  if (settings.aggregation && !MIRROR_AGGREGATIONS.includes(settings.aggregation)) {
    return { error: `aggregation must be one of: ${MIRROR_AGGREGATIONS.join(', ')}` };
  }
  return { ok: true };
};

/**
 * The currency on a money column, validated, normalised and — when absent —
 * PINNED. Returns `{ settings }` (a new object) or `{ error }`.
 *
 * ---- Why an unknown code is a 400 and not a silent default -----------------
 *
 * `column.settings` is `Mixed`, and the only shapes validated here used to be
 * `connect_boards` and `mirror` — so any string at all could be stored as a
 * currency. The client then resolved an unrecognised code to the FIRST entry
 * of its catalog, which was rupees. That was cosmetic for exactly as long as
 * the code only picked a symbol; the moment a rate is looked up by the same
 * code, a column holding dollars under a code we do not carry would be
 * treated as rupees and multiplied by ~96 for a reader in USD.
 *
 * ---- Why the STORED code is the normalised one -----------------------------
 *
 * The check used to validate `normalise(raw)` and then store `raw`, so 'cad'
 * and ' CAD ' passed and landed in the database verbatim — where the client's
 * exact-match lookups did not recognise them.
 *
 * ---- Why an absent code is pinned, not left open ---------------------------
 *
 * A money column with no code renders in whatever the fallback happens to be
 * at READ time — the workspace currency today, a different one after somebody
 * changes the setting. That silently relabels figures that were typed in a
 * specific unit. So a column that is created as, or switched to, currency with
 * no code is stamped NOW with the unit the board already resolves to
 * (`boardCurrencyOf`): its own `currency`, else its other money columns, else
 * the workspace's. `previous` keeps a column's existing code when an edit
 * resends the format without one.
 */
const normaliseMoneySettings = (settings, { board, org, previous = null }) => {
  if (!settings || settings.format !== 'currency') return { settings };
  const raw = settings.currency;
  if (raw !== undefined && raw !== null && raw !== '') {
    const r = sanitizeColumnCurrency(raw);
    if (!r.ok) return { error: r.error };
    return { settings: { ...settings, currency: r.code } };
  }
  const stamp = normaliseCurrencyCode(previous) || boardCurrencyOf(board, org && org.baseCurrency);
  return { settings: stamp ? { ...settings, currency: stamp } : settings };
};

/**
 * The formulas on `board` whose expression names `key` — the columns that
 * would silently compute to nothing if it went away.
 */
const formulasReferencing = (board, key, exceptId = null) =>
  (board.columns || []).filter(
    (c) =>
      c.type === 'formula' &&
      (!exceptId || c._id.toString() !== exceptId) &&
      formulaRefs(c.settings && c.settings.expression).includes(key)
  );

/** The two meanings a column may claim — see utils/columnRoles.js. */
const COLUMN_ROLE_TYPES = ROLE_COLUMN_TYPE;

/**
 * `settings.role`, checked. A role names what a column MEANS on this board
 * ("the due date"), and the filters, My Work and the ledger resolve it by type
 * as well — so a text column claiming to be the due date would be ignored
 * everywhere while looking configured. Refused rather than stored.
 *
 * Three ways to say something other than a role:
 *
 *   undefined     — the caller did not mention it; whatever is stored stays.
 *   null / ''     — back to the DEFAULT: the key is deleted, so the column's
 *                   template role (or legacy slug) applies again.
 *   'none'        — explicitly NO role, on any column type. Stored, and
 *                   honoured by utils/columnRoles.js over the template
 *                   fallback — the only way to say "Billing's Due is not the
 *                   due date on this board". The header menu resends
 *                   `{ ...col.settings, summary }`, so a stored 'none' must
 *                   come back through here as valid, not as a 400.
 *
 * Claiming a real role is only half the write: every OTHER column that plays
 * it has to let go (`releaseRole`), which needs the board and so is done by
 * the callers after this check passes.
 */
const normaliseRole = (settings, type) => {
  if (!settings || settings.role === undefined) return { settings };
  if (settings.role === null || settings.role === '') {
    const { role, ...rest } = settings;
    return { settings: rest };
  }
  if (settings.role === NO_ROLE) return { settings };
  const wants = COLUMN_ROLE_TYPES[settings.role];
  if (!wants) {
    return {
      error: `role must be one of: ${[...Object.keys(COLUMN_ROLE_TYPES), NO_ROLE].join(', ')}`,
    };
  }
  if (wants !== type) {
    return {
      error: settings.role === 'dueDate'
        ? 'Only a date column can be the due date.'
        : 'Only a person column can be the owner.',
    };
  }
  return { settings };
};

/**
 * A role is held by ONE column. When `keepId` claims `role`, every other
 * column of the matching type that would still resolve to it lets go — and
 * the column that just claimed it is the one the filters, My Work, the due
 * digest and the ledger then read.
 *
 * Without this a second claim silently lost: `roleColumn` keeps the FIRST
 * own-role column in array order, a new column is always appended, and every
 * billing board is born with `due` marking itself the due date — so marking a
 * new "Payment due" column did nothing at all while looking configured.
 *
 * Letting go is done in the weakest way that works. A stored role is deleted;
 * if the column would STILL resolve to the role after that — its template or a
 * legacy slug hands it back — it is told `'none'` instead, because a role that
 * two columns claim (one by hand, one by template) is exactly the ambiguity
 * this exists to remove, and the client shows each column's role. Columns of
 * another type are left alone: a text column called "due" can never be
 * resolved as the due date anyway.
 *
 * Mutates `board.columns` in place (the caller saves) and returns the columns
 * it changed. It does NOT rewrite `task.dueDate` / `assignedTo` on existing
 * rows: the Task pre-save sync copies only into an empty side, so rows where
 * both are filled keep the old column's value until they are next written.
 */
const releaseRole = (board, keepId, role) => {
  if (!board || !isRole(role)) return [];
  const type = COLUMN_ROLE_TYPES[role];
  const released = [];
  for (const c of board.columns || []) {
    if (!c || String(c._id) === String(keepId)) continue;
    if (c.type !== type || columnRole(board, c) !== role) continue;
    const { role: _dropped, ...rest } = c.settings && typeof c.settings === 'object' ? c.settings : {};
    c.settings = rest;
    if (columnRole(board, c) === role) c.settings = { ...rest, role: NO_ROLE };
    if (typeof c.markModified === 'function') c.markModified('settings');
    released.push(c);
  }
  return released;
};

/**
 * The WIRING keys of a column's settings, which an edit that does not mention
 * them must not erase.
 *
 * `PATCH .../columns/:cid` replaces `settings` whole, and the header menu sends
 * `{ ...col.settings, summary }`. That is fine until a caller sends only what it
 * changed — `{ summary: 'filled' }` — at which point a connect column loses its
 * targets, a mirror its source and a formula its expression, all as a side
 * effect of choosing a footer. These keys are what the column IS; display keys
 * (format, decimals, summary) stay replaceable.
 */
const WIRING_KEYS = {
  connect_boards: ['targetBoardIds'],
  mirror: ['sourceConnectColumnId', 'sourceColumnId', 'aggregation'],
  formula: ['expression'],
};

const keepWiring = (column, settings) => {
  const keys = WIRING_KEYS[column.type];
  if (!keys) return settings;
  const current = column.settings || {};
  const out = { ...settings };
  for (const k of keys) {
    if (out[k] === undefined && current[k] !== undefined) out[k] = current[k];
  }
  return out;
};

/** A payments column is money by definition — it cannot be switched to plain. */
const paymentsSettings = (settings, { creating }) => ({
  ...settings,
  format: 'currency',
  ...(creating && settings.summary === undefined ? { summary: 'sum' } : {}),
});

const idSet = (list) =>
  new Set((Array.isArray(list) ? list : []).map((id) => (id == null ? '' : id.toString())).filter(Boolean));

const sameIdSet = (a, b) => {
  const x = idSet(a);
  const y = idSet(b);
  return x.size === y.size && [...x].every((id) => y.has(id));
};

/**
 * A mirror of a money column is money too.
 *
 * Mirroring "Deal value" from a CAD pipeline onto an invoice board used to
 * produce a bare number, because the mirror had no format of its own and
 * nothing looked at its source. So when the source (on a target board) is a
 * numeric column and the aggregation keeps its unit, the mirror inherits the
 * source's `format`, `currency` and `decimals` — each only where the caller did
 * not set it explicitly. `count` and `concat` are not the source's unit and
 * inherit nothing.
 */
const inheritMirrorFormat = async (board, org, settings) => {
  const aggregation = settings.aggregation || 'first';
  if (!NUMERIC_MIRROR_AGGREGATIONS.includes(aggregation)) return settings;
  const connectId = settings.sourceConnectColumnId ? settings.sourceConnectColumnId.toString() : '';
  const sourceId = settings.sourceColumnId ? settings.sourceColumnId.toString() : '';
  if (!connectId || !sourceId) return settings;

  const connectCol = (board.columns || []).find((c) => c._id.toString() === connectId);
  const targetIds = [...idSet(connectCol && connectCol.settings && connectCol.settings.targetBoardIds)]
    .filter((id) => mongoose.Types.ObjectId.isValid(id));
  if (targetIds.length === 0) return settings;

  const targets = await Board.find({ _id: { $in: targetIds }, organisation: board.organisation })
    .select('columns currency')
    .lean();
  let source = null;
  let sourceBoard = null;
  for (const tb of targets) {
    const hit = (tb.columns || []).find((c) => c._id.toString() === sourceId);
    if (hit) { source = hit; sourceBoard = tb; break; }
  }
  if (!source || !['number', 'formula', 'payments', 'mirror'].includes(source.type)) return settings;

  const src = source.settings || {};
  const out = { ...settings };
  if (out.format === undefined && src.format) out.format = src.format;
  if (out.format === 'currency' && (out.currency === undefined || out.currency === null || out.currency === '')) {
    // The source's own code, else what the SOURCE board resolves to — a figure
    // mirrored from a CAD board is CAD, whatever this board is in. That holds
    // for a plain-number source switched to currency here too: its figures
    // are still that board's, and leaving the code empty would only have
    // `normaliseMoneySettings` stamp THIS board's unit on them instead.
    const code = isMoneyColumn(source)
      ? normaliseCurrencyCode(src.currency) || boardCurrencyOf(sourceBoard, org && org.baseCurrency)
      : boardCurrencyOf(sourceBoard, org && org.baseCurrency);
    if (code) out.currency = code;
  }
  if (out.decimals === undefined && typeof src.decimals === 'number') out.decimals = src.decimals;
  return out;
};

/**
 * Upsert the BoardConnection edge for a connect_boards column. The primary
 * (first) target board is recorded as `toBoardId` — see BoardConnection.js.
 * Idempotent against the `{ fromBoardId, fromColumnId }` unique index.
 */
const syncBoardConnection = async (board, column) => {
  const targetBoardIds = Array.isArray(column.settings && column.settings.targetBoardIds)
    ? column.settings.targetBoardIds
    : [];
  if (targetBoardIds.length === 0) return;
  await BoardConnection.findOneAndUpdate(
    { fromBoardId: board._id, fromColumnId: column._id },
    {
      $set: { toBoardId: targetBoardIds[0] },
      $setOnInsert: {
        fromBoardId: board._id,
        fromColumnId: column._id,
        createdAt: new Date(),
      },
    },
    { upsert: true }
  );
};

const removeBoardConnection = async (boardId, columnId) => {
  await BoardConnection.deleteOne({ fromBoardId: boardId, fromColumnId: columnId });
};

/**
 * GET /api/boards/:id/columns — board read access is the whole gate.
 */
const listColumns = async (req, res) => {
  try {
    const bad = badBoardId(req.params.id);
    if (bad) return res.status(bad.status).json({ error: bad.error });

    const ctx = await loadBoardContext(req.params.id, req.user.userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    return res.json({ columns: serializeColumns(ctx.board) });
  } catch (err) {
    console.error('listColumns error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/boards/:id/columns
 * Body: { name, type, settings?, width?, after?, key?, isPrimary? }
 *
 * `after` is the column id to insert the new column after; appends if absent.
 * Requires `column.manage`. Validates `settings` through the type registry.
 */
const addColumn = async (req, res) => {
  try {
    const bad = badBoardId(req.params.id);
    if (bad) return res.status(bad.status).json({ error: bad.error });

    const ctx = await loadBoardContext(req.params.id, req.user.userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

    const denied = requireCapability(
      ctx,
      'column.manage',
      'You do not have permission to manage columns'
    );
    if (denied) return res.status(denied.status).json({ error: denied.error });

    const { board, org } = ctx;
    const { name, type, width, after, key, isPrimary } = req.body || {};
    const rawSettings = req.body ? req.body.settings : undefined;
    if (rawSettings != null && (typeof rawSettings !== 'object' || Array.isArray(rawSettings))) {
      return res.status(400).json({ error: 'settings must be an object' });
    }
    let settings = rawSettings || {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Column name is required' });
    }
    if (!type || typeof type !== 'string') {
      return res.status(400).json({ error: 'Column type is required' });
    }
    const entry = getColumnType(type);
    if (!entry) {
      return res.status(400).json({ error: `Unknown column type: ${type}` });
    }

    // Validate the default value against the new column's settings — this
    // catches malformed `settings` payloads early (e.g. dropdown with no
    // `options`). Registry validators are permissive about null, so we
    // synthesize an option-id when the type needs one.
    try {
      const probe = entry.defaultValue ? entry.defaultValue(settings) : null;
      entry.validate(probe, settings);
    } catch (err) {
      return res.status(400).json({ error: `Invalid settings: ${err.message}` });
    }

    if (type === 'payments') settings = paymentsSettings(settings, { creating: true });
    if (type === 'mirror') settings = await inheritMirrorFormat(board, org, settings);

    const role = normaliseRole(settings, type);
    if (role.error) return res.status(400).json({ error: role.error });
    settings = role.settings;

    const money = normaliseMoneySettings(settings, { board, org });
    if (money.error) return res.status(400).json({ error: money.error });
    settings = money.settings;

    // Build the column subdoc's key up front. `key` is optional in the request;
    // if absent, we derive one from the name and de-dupe. Decided BEFORE the
    // formula check below because that check needs it: a formula can only be
    // caught referring back to itself — directly, or through a formula whose
    // expression still names a key deleted earlier and now being reused — if
    // the validator knows which key it is about to occupy.
    const desiredKey = typeof key === 'string' && key.trim() ? slugify(key) : null;
    let finalKey = desiredKey || uniqueSlug(board, name);
    if ((board.columns || []).some((c) => c.key === finalKey)) {
      finalKey = uniqueSlug(board, name);
    }

    // Only checked when given: an expression-less formula is inert rather than
    // wrong, and older clients created them that way.
    if (type === 'formula' && settings.expression !== undefined) {
      const f = validateFormulaExpression(settings.expression, board.columns || [], finalKey);
      if (f.error) return res.status(400).json({ error: f.error });
    }

    // F2: cross-board column types carry DB-aware invariants the synchronous
    // registry validator can't check (target-board membership, cycle-free
    // mirror graph). Reject bad settings before the column lands.
    if (type === 'connect_boards') {
      const r = await validateConnectSettings(board, settings);
      if (r.error) return res.status(400).json({ error: r.error });
    } else if (type === 'mirror') {
      const r = validateMirrorSettings(board, settings);
      if (r.error) return res.status(400).json({ error: r.error });
      if (await wouldCreateMirrorCycle(board, settings, null)) {
        return res.status(400).json({
          error: 'This mirror would create a circular reference. Pick a different source column.',
        });
      }
    }

    // Insertion: after-id semantics if provided.
    const cols = board.columns || [];
    const insertIndex = after
      ? cols.findIndex((c) => c._id.toString() === after.toString())
      : -1;
    const order = nextOrder(board);

    const column = {
      key: finalKey,
      name: name.trim(),
      type,
      settings,
      order,
      width: typeof width === 'number' && width > 40 ? width : 160,
      isPrimary:
        isPrimary === true && cols.every((c) => c.isPrimary !== true),
    };

    if (insertIndex >= 0 && insertIndex < cols.length - 1) {
      // Renumber order so the new column sits right after the anchor.
      const anchorOrder = cols[insertIndex].order || 0;
      column.order = anchorOrder + 0.5;
      board.columns.push(column);
      // Normalise orders to integers after the splice.
      const sorted = board.columns
        .slice()
        .sort((a, b) => (a.order || 0) - (b.order || 0));
      sorted.forEach((c, i) => {
        c.order = i;
      });
    } else {
      board.columns.push(column);
    }

    // First column on the board is automatically primary.
    if (!board.columns.some((c) => c.isPrimary)) {
      board.columns[0].isPrimary = true;
    }

    // A column born claiming a role takes it from whichever column held it.
    // Looked up after the push, so the subdoc (and its _id) exists.
    if (isRole(settings.role)) {
      const born = board.columns.find((c) => c.key === finalKey);
      if (born) releaseRole(board, born._id, settings.role);
    }

    await board.save();

    const created = board.columns.find((c) => c.key === finalKey);

    // F2: register the connect edge so mirror invalidation can find it.
    if (type === 'connect_boards' && created) {
      await syncBoardConnection(board, created);
    }

    return res.status(201).json({ column: created, columns: serializeColumns(board) });
  } catch (err) {
    console.error('addColumn error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * PATCH /api/boards/:id/columns/:cid
 * Body: { name?, settings?, width? } — type changes are out of scope for v1.
 * Requires `column.manage`.
 */
const updateColumn = async (req, res) => {
  try {
    const bad = badBoardId(req.params.id);
    if (bad) return res.status(bad.status).json({ error: bad.error });

    const ctx = await loadBoardContext(req.params.id, req.user.userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

    const denied = requireCapability(
      ctx,
      'column.manage',
      'You do not have permission to manage columns'
    );
    if (denied) return res.status(denied.status).json({ error: denied.error });

    const { board, org } = ctx;
    const { cid } = req.params;
    const column = board.columns.id(cid);
    if (!column) return res.status(404).json({ error: 'Column not found' });
    // Every column's unit and the board's, as they stood — so what this edit
    // moved (the column, its settle partner, formulas downstream) can be
    // announced and followed by the mirrors reading it (`followMirrors`).
    const unitsBefore = unitSnapshot(board);
    const boardUnitBefore = board.currency || null;

    const { name, width } = req.body || {};
    const rawSettings = req.body ? req.body.settings : undefined;

    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'Column name cannot be empty' });
      }
      column.name = name.trim();
    }
    if (rawSettings !== undefined) {
      if (rawSettings === null || typeof rawSettings !== 'object' || Array.isArray(rawSettings)) {
        return res.status(400).json({ error: 'settings must be an object' });
      }
      const entry = getColumnType(column.type);
      if (!entry) {
        return res.status(400).json({ error: `Unknown column type: ${column.type}` });
      }
      const previous = column.settings || {};
      let settings = keepWiring(column, rawSettings);
      try {
        const probe = entry.defaultValue ? entry.defaultValue(settings) : null;
        entry.validate(probe, settings);
      } catch (err) {
        return res.status(400).json({ error: `Invalid settings: ${err.message}` });
      }

      if (column.type === 'payments') settings = paymentsSettings(settings, { creating: false });
      if (column.type === 'mirror') settings = await inheritMirrorFormat(board, org, settings);

      const role = normaliseRole(settings, column.type);
      if (role.error) return res.status(400).json({ error: role.error });
      settings = role.settings;

      const money = normaliseMoneySettings(settings, { board, org, previous: previous.currency });
      if (money.error) return res.status(400).json({ error: money.error });
      settings = money.settings;

      // Re-checked only when it CHANGES. A formula whose input was deleted
      // since is broken either way, and refusing its footer or width edit
      // would only add a second problem to the first.
      if (column.type === 'formula' && settings.expression !== previous.expression) {
        const f = validateFormulaExpression(settings.expression, board.columns || [], column.key);
        if (f.error) return res.status(400).json({ error: f.error });
      }

      // F2: re-validate cross-board invariants before persisting the new
      // settings (re-targeting a connect column, or re-pointing a mirror).
      if (column.type === 'connect_boards') {
        /**
         * Only when the TARGETS change. Every connect column the Billing
         * template ever seeded has none, and re-validating on every settings
         * write meant choosing its footer summary failed with "requires at
         * least one target board" — an error about a thing the person never
         * touched. Unchanged targets were validated when they were set; a
         * target deleted since is purged from the links, not a reason to
         * refuse an unrelated edit.
         */
        if (!sameIdSet(previous.targetBoardIds, settings.targetBoardIds)) {
          const r = await validateConnectSettings(board, settings);
          if (r.error) return res.status(400).json({ error: r.error });
        }
      } else if (column.type === 'mirror') {
        const r = validateMirrorSettings(board, settings);
        if (r.error) return res.status(400).json({ error: r.error });
        if (await wouldCreateMirrorCycle(board, settings, column._id)) {
          return res.status(400).json({
            error: 'This mirror would create a circular reference. Pick a different source column.',
          });
        }
      }
      const previousUnit =
        previous.format === 'currency' ? normaliseCurrencyCode(previous.currency) : null;
      column.settings = settings;
      // mongoose doesn't track Mixed mutations — flag manually.
      column.markModified('settings');

      // Newly CLAIMED a role: the column that held it lets go. Only on a change
      // — the header menu resends the whole settings object on every footer or
      // format edit, and that must not quietly reshuffle which column is the
      // due date on a board that (from before this rule) has two claiming it.
      if (isRole(settings.role) && settings.role !== previous.role) {
        releaseRole(board, column._id, settings.role);
      }

      // This column's unit moved (relabelled, or switched into or out of
      // money): the formulas computed from it and the board's own unit follow.
      if (moneyCodeOf(column) !== previousUnit) {
        // The amount and the payments column are read as ONE pair — settling
        // (utils/paymentsSettle.js) and the client's ledger both compare
        // receipts against the bill — so relabelling one relabels the other.
        // Left split, the ledger printed INR receipts as CA$ and auto-Paid
        // compared rupees with dollars. Only a real code travels: switching a
        // column OUT of money leaves its partner alone.
        const partner = settlePartnerOf(board, column);
        const code = moneyCodeOf(column);
        if (code && partner && isOwnMoneyColumn(partner) && moneyCodeOf(partner) !== code) {
          partner.settings = { ...partner.settings, currency: code };
          partner.markModified('settings');
          reconcileMoneyUnits(board, partner, org && org.baseCurrency);
        }
        reconcileMoneyUnits(board, column, org && org.baseCurrency);
      }
    }
    if (width !== undefined) {
      if (typeof width !== 'number' || width < 40 || width > 1000) {
        return res.status(400).json({ error: 'width must be between 40 and 1000' });
      }
      column.width = width;
    }

    await board.save();

    // F2: keep the connect edge in sync. On every settings write rather than
    // only when the targets changed: the upsert is idempotent (and a no-op
    // with no targets), and it heals a column whose edge was never written.
    if (column.type === 'connect_boards' && rawSettings !== undefined) {
      await syncBoardConnection(board, column);
    }

    // A unit moved: every other open tab is showing the old symbol (PATCH
    // /currency always announced; this path did not), and mirrors on other
    // boards still say the old code.
    const moved = unitsMoved(board, unitsBefore);
    if (moved.size || (board.currency || null) !== boardUnitBefore) {
      announceBoardChanged(board, org, req.user.userId);
    }
    try {
      await followMirrors(org, moved, req.user.userId);
    } catch (followErr) {
      console.error('updateColumn: mirror follow failed:', followErr && followErr.message);
    }

    // `currency` alongside the columns: a relabel can move the board's own
    // unit too (see `reconcileMoneyUnits`), and the ledger strip reads it.
    return res.json({ column, columns: serializeColumns(board), currency: board.currency || null });
  } catch (err) {
    console.error('updateColumn error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * PATCH /api/boards/:id/columns/reorder
 * Body: { order: [cid, ...] } — must list every column id exactly once.
 * Requires `column.manage`.
 */
const reorderColumns = async (req, res) => {
  try {
    const bad = badBoardId(req.params.id);
    if (bad) return res.status(bad.status).json({ error: bad.error });

    const ctx = await loadBoardContext(req.params.id, req.user.userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

    const denied = requireCapability(
      ctx,
      'column.manage',
      'You do not have permission to manage columns'
    );
    if (denied) return res.status(denied.status).json({ error: denied.error });

    const { board } = ctx;
    const order = Array.isArray(req.body?.order) ? req.body.order : null;
    if (!order) return res.status(400).json({ error: 'order[] is required' });

    const currentIds = board.columns.map((c) => c._id.toString());
    const requestedIds = order.map((id) => id.toString());
    if (
      requestedIds.length !== currentIds.length ||
      !requestedIds.every((id) => currentIds.includes(id)) ||
      new Set(requestedIds).size !== requestedIds.length
    ) {
      return res
        .status(400)
        .json({ error: 'order must list every column id exactly once' });
    }

    const indexById = new Map(requestedIds.map((id, i) => [id, i]));
    for (const col of board.columns) {
      col.order = indexById.get(col._id.toString());
    }
    await board.save();

    return res.json({ columns: serializeColumns(board) });
  } catch (err) {
    console.error('reorderColumns error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * DELETE /api/boards/:id/columns/:cid
 *
 * - Requires `column.manage`.
 * - 400 if the column is the primary.
 * - 400 if a formula on the board uses it, naming the formula. A deleted input
 *   does not break a formula loudly: `evaluateFormula` reads a missing column
 *   as empty, so "Outstanding" would have gone blank on every row with nothing
 *   to say why — and its expression would still name the key, ready to form a
 *   loop with the next column that reuses it.
 * - A FILE column's files are destroyed in storage: the cells are the only
 *   record of those assets, and the `$unset` below erases them. Nothing else
 *   ever swept them, so every PDF in a deleted column stayed billed and
 *   publicly fetchable at its URL. Best-effort — cleanup never blocks the
 *   delete somebody asked for.
 * - Otherwise `$unset` `columnValues.<cid>` on every Task in the board.
 */
const deleteColumn = async (req, res) => {
  try {
    const bad = badBoardId(req.params.id);
    if (bad) return res.status(bad.status).json({ error: bad.error });

    const ctx = await loadBoardContext(req.params.id, req.user.userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

    const denied = requireCapability(
      ctx,
      'column.manage',
      'You do not have permission to manage columns'
    );
    if (denied) return res.status(denied.status).json({ error: denied.error });

    const { board } = ctx;
    const { cid } = req.params;
    const column = board.columns.id(cid);
    if (!column) return res.status(404).json({ error: 'Column not found' });
    if (column.isPrimary) {
      return res.status(400).json({ error: 'Cannot delete the primary column' });
    }

    const users = formulasReferencing(board, column.key, cid);
    if (users.length > 0) {
      const names = users.map((c) => `"${c.name}"`);
      const list = names.length === 1
        ? names[0]
        : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
      return res.status(400).json({
        error: `${list} ${users.length === 1 ? 'uses' : 'use'} this column in a formula. Change ${users.length === 1 ? 'that formula' : 'those formulas'} first, then delete it.`,
        code: 'COLUMN_IN_FORMULA',
        formulas: users.map((c) => ({ _id: c._id, name: c.name })),
      });
    }

    const wasConnect = column.type === 'connect_boards';
    const deleted = column.toObject ? column.toObject() : { ...column };

    board.columns.pull({ _id: cid });
    await board.save();

    if (deleted.type === 'file') {
      try {
        // Read BEFORE the `$unset` — afterwards there is nothing left to name
        // the assets by. A file the same row still holds somewhere else (another
        // file column, its Files tab) is kept: destroying it would break a link
        // that is still on screen.
        //
        // `board` is loaded with the rows because it names the only folder
        // their files may be destroyed from (`macan/board-files/<board>/`);
        // an id a cell carries from anywhere else is never touched. See
        // utils/fileColumnAssets.js.
        const tasks = await Task.find({
          board: board._id,
          [`columnValues.${cid}`]: { $exists: true },
        })
          .select('columnValues attachments board')
          .lean();
        const scope = { boardId: board._id };
        const stillHeld = new Set([
          ...fileColumnAssetsLib.fileColumnAssets(board.columns || [], tasks, scope).map((a) => a.publicId),
          ...tasks.flatMap((t) => (t.attachments || []).map((a) => a && a.publicId)).filter(Boolean),
        ]);
        const doomed = fileColumnAssetsLib
          .fileColumnAssets([deleted], tasks, scope)
          .filter((a) => !stillHeld.has(a.publicId));
        // `tasks` is only the rows that HAD this column: the same id held in
        // another file column on some other row is kept too. The deleted
        // column is already pulled, so `board.columns` names the survivors.
        const free = await fileColumnAssetsLib.withoutIdsHeldElsewhere(doomed, {
          boardId: board._id,
          columns: board.columns || [],
        });
        await fileColumnAssetsLib.destroyAssets(free);
      } catch (cleanupErr) {
        console.error('deleteColumn: file cleanup failed:', cleanupErr && cleanupErr.message);
      }
    }

    await Task.updateMany(
      { board: board._id },
      { $unset: { [`columnValues.${cid}`]: '' } }
    );

    // F2: drop the connect edge so mirror invalidation no longer fans out to a
    // column that no longer exists. Mirror columns that read this connect
    // column are left in place — they compute to their aggregation default.
    if (wasConnect) {
      await removeBoardConnection(board._id, cid);
    }

    return res.json({ columns: serializeColumns(board) });
  } catch (err) {
    console.error('deleteColumn error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * The other half of the amount/payments pair `column` belongs to, or null.
 * Same rule as settling and the client's `ledgerColumns` (`settleColumns`).
 */
const settlePartnerOf = (board, column) => {
  const { amount, payments } = settleColumns(board);
  if (!amount || !payments) return null;
  const id = String(column._id);
  if (String(amount._id) === id) return payments;
  if (String(payments._id) === id) return amount;
  return null;
};

/**
 * PATCH /api/boards/:id/currency — body { currency: 'CAD' | null }
 *
 * The board's money unit, changed in one move: `Board.currency` AND
 * `settings.currency` on every money column the board OWNS (number, formula,
 * payments — anything with `format: 'currency'` that is not a mirror).
 *
 * ---- Override, or follow the workspace --------------------------------------
 *
 *   `currency: 'CAD'` — the board is pinned to CAD (an OVERRIDE): a later
 *                       workspace currency change leaves it alone.
 *   `currency: null`  — the board FOLLOWS the workspace again: `Board.currency`
 *                       goes back to null and its money is relabelled to the
 *                       workspace's unit as it stands now, so it moves with the
 *                       next workspace change (services/boardCurrency.js).
 *
 * `''` is read as null — it is what an unset select sends, and it cannot mean
 * anything else. Leaving `currency` out entirely is still a 400: a request that
 * does not say which is not allowed to guess.
 *
 * Answers `{ board: { _id, currency, columns }, following, effective }` —
 * `currency` is what is STORED (null while following), `effective` the unit
 * every own money column is now in.
 *
 * ---- Mirrors keep their source's unit ---------------------------------------
 *
 * A mirror's figure is computed from another board, in that board's unit
 * (`inheritMirrorFormat`). Relabelling it to this board's code would not make
 * the number any more true — it would make a CAD figure say INR, and a reader
 * in dollars would then see it converted at the rupee rate. So the relabel
 * skips them (`isOwnMoneyColumn`), exactly as every "what unit is this board"
 * vote does.
 *
 * ---- It RELABELS. It never converts. ---------------------------------------
 *
 * The figures on the board are what somebody typed. If they typed 5,000 meaning
 * Canadian dollars and the board said rupees, the fix is to say dollars — not
 * to multiply by a rate and turn a correct figure into a wrong one. Conversion
 * is a READING concern (a reader's display currency, at render time); this
 * endpoint changes what the stored numbers are SAID to be in, and the client
 * confirms exactly that before calling it.
 *
 * ---- Why every column at once ----------------------------------------------
 *
 * The only way to change a board's unit used to be one column at a time from
 * the Table header menu — desktop only, and invisible from the Ledger the
 * billing board opens on. A board half in CAD and half in INR sums nonsense in
 * its strip. Same gate as any column edit (`column.manage`), because that is
 * what this is, many times over.
 */
const setBoardCurrency = async (req, res) => {
  try {
    const bad = badBoardId(req.params.id);
    if (bad) return res.status(bad.status).json({ error: bad.error });

    const ctx = await loadBoardContext(req.params.id, req.user.userId);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

    const denied = requireCapability(
      ctx,
      'column.manage',
      "You do not have permission to change this board's currency"
    );
    if (denied) return res.status(denied.status).json({ error: denied.error });

    const raw = req.body ? req.body.currency : undefined;
    if (raw === undefined) {
      return res.status(400).json({ error: 'currency is required' });
    }
    const { board, org } = ctx;
    const follow = raw === null || raw === '';
    let code;
    if (follow) {
      code = workspaceCurrencyOf(org);
    } else {
      const r = sanitizeColumnCurrency(raw);
      if (!r.ok) return res.status(400).json({ error: r.error });
      code = r.code;
    }

    // Saves, announces the board to its open tabs, and moves the mirrors other
    // boards keep of its money — the one relabel, shared with the workspace
    // currency change.
    const result = await relabelBoardMoney(board, code, {
      org,
      actorId: req.user.userId,
      follow,
    });

    return res.json({
      board: {
        _id: board._id,
        currency: board.currency || null,
        columns: serializeColumns(board),
      },
      following: result.following,
      effective: result.effective,
    });
  } catch (err) {
    console.error('setBoardCurrency error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

module.exports = {
  listColumns,
  addColumn,
  updateColumn,
  reorderColumns,
  deleteColumn,
  setBoardCurrency,
  // For createBoard, which seeds connect columns (template or copy) without
  // going through addColumn and still owes them their edge.
  syncBoardConnection,
};
