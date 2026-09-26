/**
 * services/boardCurrency.js — THE board's money unit: whose it is, and how it
 * moves.
 *
 * ---- Following vs overriding -------------------------------------------------
 *
 *   `Board.currency === null`   the board FOLLOWS the workspace
 *                               (`Organisation.baseCurrency`). The default, for
 *                               every new board and every existing one.
 *   `Board.currency === 'CAD'`  an explicit per-board OVERRIDE.
 *
 * Money columns keep an explicit `settings.currency` either way — every reader
 * and renderer still reads the column's own code, so nothing about rendering
 * changes. What following MEANS is that on such a board every OWN money column
 * (`isOwnMoneyColumn`: never a mirror, whose unit is its source board's) is
 * kept equal to the workspace currency:
 *
 *   - a new board is born with its columns stamped in it (`planNewBoardCurrency`);
 *   - when the workspace currency changes, every following board is relabelled
 *     to the new one (`relabelFollowingBoards`, from the Currency settings save);
 *   - a board can be put back to following (`PATCH /api/boards/:id/currency`
 *     with `currency: null`), which relabels it to the workspace's unit now.
 *
 * An override board is never touched by a workspace change. It moves only when
 * somebody relabels THAT board.
 *
 * ---- It RELABELS. It never converts. -----------------------------------------
 *
 * The figures on a board are what somebody typed. Changing the unit changes what
 * the stored numbers are SAID to be in — 5,000 stays 5,000 — because turning a
 * correct figure into a different one by multiplying it at a rate is how a
 * right number becomes a wrong one. Conversion is a READING concern (a reader's
 * display currency, at render time) and never happens here.
 *
 * ---- Why these live here and not in columnController ------------------------
 *
 * The relabel used to be the body of `setBoardCurrency`. A workspace currency
 * change has to run exactly the same relabel over many boards from the org
 * controller, and the mirror-following and live-refresh halves of it must come
 * along — so the whole unit machinery (reconcile, snapshot, follow, announce)
 * is here, and the column controller imports it like everybody else.
 */

const mongoose = require('mongoose');
const Board = require('../models/Board');
const Organisation = require('../models/Organisation');
const {
  normaliseCurrencyCode,
  boardCurrencyOf,
  isMoneyColumn,
  isOwnMoneyColumn,
} = require('../utils/money');
const { resolveAccess } = require('../utils/permissions');
const eventBus = require('./eventBus');

/** What an org that predates `baseCurrency` (or names none) is taken to be in. */
const DEFAULT_WORKSPACE_CURRENCY = 'INR';

/** The workspace's unit — what a following board is in. Never null. */
const workspaceCurrencyOf = (org) =>
  normaliseCurrencyCode(org && org.baseCurrency) || DEFAULT_WORKSPACE_CURRENCY;

/** Whether a board follows the workspace (no override of its own). */
const isFollowing = (board) => !normaliseCurrencyCode(board && board.currency);

// ---------------------------------------------------------------------------
// Column units
// ---------------------------------------------------------------------------

/**
 * The column keys a formula's expression names, de-duplicated. The same
 * `column.<key>` grammar `validateFormulaExpression` and `evaluateFormula`
 * parse (utils/columnTypes.js) — kept as its own pattern here because the
 * registry does not export one, and a formula that references something this
 * reads differently from the evaluator would be a formula nobody can reason
 * about.
 */
const FORMULA_REF = /column\.([a-zA-Z_][a-zA-Z0-9_]*)/g;

const formulaRefs = (expression) =>
  typeof expression === 'string'
    ? [...new Set([...expression.matchAll(FORMULA_REF)].map((m) => m[1]))]
    : [];

/** The unit a column's money is stored in, or null when it is not money or names none. */
const moneyCodeOf = (col) =>
  isMoneyColumn(col) ? normaliseCurrencyCode(col.settings.currency) : null;

/** Aggregations whose result is the source column's own kind of number. */
const NUMERIC_MIRROR_AGGREGATIONS = ['first', 'sum', 'min', 'max'];

/**
 * Keep a board's money units coherent after ONE column's unit changed.
 *
 * Per-column currency is still editable from the Table header, and on its own
 * that edit left two things stale:
 *
 *   1. FORMULAS downstream of it. "Outstanding = Amount − Paid" was stamped
 *      with the board's unit when it was made, and kept it after Amount and
 *      Paid were both relabelled CAD — so the one column computed from the
 *      others was the one that said rupees. Every money formula that reaches
 *      the changed column (directly, or through another formula) is re-derived
 *      from what it references: all its money inputs agree → that code; they
 *      disagree → the code is REMOVED, because a figure computed from CAD and
 *      INR is in neither, and claiming one would be the lie the client's
 *      "mixed" marker exists to avoid. A formula with no money inputs keeps
 *      whatever it was given. The changed column itself is never re-derived:
 *      that is the edit somebody just made.
 *
 *   2. `Board.currency`. The ledger strip and the Currency tab read it as the
 *      board's unit, and relabelling every money column one at a time left it
 *      naming the old one. When, after the change, every one of the board's
 *      OWN money columns (never a mirror) that names a code names the SAME
 *      code, the board takes it. While they still disagree it is left alone —
 *      the board is mixed, which the Currency tab reports, and guessing a
 *      winner would hide that.
 *
 *      A FOLLOWING board (`currency: null`) is the exception in two ways. Its
 *      columns agreeing on the WORKSPACE's unit is exactly what following
 *      means, so it stays null rather than being pinned to the code it already
 *      follows — pinning would silently stop it following the next workspace
 *      change. Its columns agreeing on ANOTHER unit is somebody relabelling the
 *      whole board by hand, one column at a time: that is an override, and is
 *      pinned.
 *
 *      `pinFollowing: false` — what `followMirrors` passes — leaves
 *      `Board.currency` alone on EVERY board, following or not. A mirror
 *      moving is not anybody's choice about THIS board: in the middle of a
 *      workspace relabel it would pin a following board to the old unit a
 *      moment before its own turn came, and it would move an OVERRIDE board
 *      (one whose only own money is a formula over the mirror) to the new
 *      workspace unit — the one kind of board a workspace change must never
 *      move. The formulas downstream still re-derive; a board left
 *      disagreeing with them reads as mixed, which is the truth.
 *
 * Mutates `board` in place (the caller saves). Chains of formulas settle in at
 * most one pass per formula.
 */
const reconcileMoneyUnits = (board, changed, orgBase = null, { pinFollowing = true } = {}) => {
  const columns = Array.isArray(board.columns) ? board.columns : [];
  const byKey = new Map(columns.map((c) => [c.key, c]));

  const downstream = new Set([changed.key]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of columns) {
      if (c.type !== 'formula' || downstream.has(c.key)) continue;
      const refs = formulaRefs(c.settings && c.settings.expression);
      if (refs.some((k) => downstream.has(k))) {
        downstream.add(c.key);
        grew = true;
      }
    }
  }
  downstream.delete(changed.key);

  const MIXED = '*';
  const formulas = columns.filter((c) => downstream.has(c.key) && isMoneyColumn(c));
  for (let pass = 0; pass <= formulas.length; pass += 1) {
    let moved = false;
    for (const f of formulas) {
      const codes = new Set();
      for (const key of formulaRefs(f.settings.expression)) {
        const ref = byKey.get(key);
        if (!isMoneyColumn(ref)) continue;
        const code = moneyCodeOf(ref);
        if (code) codes.add(code);
        // A money input that names no unit: a formula left that way is itself
        // mixed, so that carries through; anything else renders in the board's
        // unit, so that is the unit it contributes.
        else if (ref.type === 'formula') codes.add(MIXED);
        else {
          const fallback = boardCurrencyOf(board, orgBase);
          codes.add(fallback || MIXED);
        }
      }
      if (codes.size === 0) continue;
      const current = f.settings.currency;
      if (codes.size === 1 && !codes.has(MIXED)) {
        const [code] = codes;
        if (current === code) continue;
        f.settings = { ...f.settings, currency: code };
      } else {
        if (current === undefined) continue;
        const { currency: _dropped, ...rest } = f.settings;
        f.settings = rest;
      }
      f.markModified('settings');
      moved = true;
    }
    if (!moved) break;
  }

  // The board's unit is voted on by its OWN money only: a mirror's code is its
  // source board's (see `isOwnMoneyColumn`), and letting it vote meant one CAD
  // mirror on an INR board stopped `Board.currency` ever following the columns
  // somebody actually typed in.
  if (!pinFollowing) return;
  const units = new Set(columns.filter(isOwnMoneyColumn).map(moneyCodeOf).filter(Boolean));
  if (units.size !== 1) return;
  const [only] = units;
  // Following, and every column in the workspace's unit: still following.
  if (isFollowing(board) && only === (normaliseCurrencyCode(orgBase) || DEFAULT_WORKSPACE_CURRENCY)) return;
  if (board.currency !== only) board.currency = only;
};

/** Every column's stored money code on `board`, by column id. */
const unitSnapshot = (board) =>
  new Map((board.columns || []).map((c) => [String(c._id), moneyCodeOf(c)]));

/**
 * The columns whose code moved since `before` (a `unitSnapshot`), as
 * `Map<columnId, { from, to }>`. Only a code-to-code relabel counts: a column
 * switched into or out of money has no old/new unit a mirror could follow.
 */
const unitsMoved = (board, before) => {
  const out = new Map();
  for (const c of board.columns || []) {
    const from = before.get(String(c._id)) || null;
    const to = moneyCodeOf(c);
    if (from && to && from !== to) out.set(String(c._id), { from, to });
  }
  return out;
};

// ---------------------------------------------------------------------------
// Telling open tabs
// ---------------------------------------------------------------------------

/**
 * Tell every open tab that can see this board that it changed out of band.
 *
 * `board.changed` is per USER — the SSE registry is keyed by user id
 * (services/notificationStream.js) — so a change everybody on the board should
 * see has to fan out itself, the way services/connectorSyncRunner.js does. The
 * audience is everyone who can READ the board: the workspace's members (a
 * public board reaches them through `publicDefaultLevel`), the explicit grants
 * and the creator, each put through `resolveAccess` rather than guessed at. The
 * actor is included, for their OTHER tabs.
 *
 * The client answers the ping by refetching the board DOCUMENT as well as its
 * rows (BoardDetailPage's `boardRefreshSignal` effect → `fetchBoard`), which is
 * what carries a relabel's new `currency` and column codes to a tab that is
 * already open — including every following board a workspace currency change
 * just moved.
 *
 * Best effort: the write it announces has already been saved and answered for,
 * so a failure here costs a stale tab until its next load, never the request.
 */
const announceBoardChanged = (board, org, actorId) => {
  try {
    if (!board || !org) return;
    const boardId = String(board._id);
    const candidates = new Set();
    for (const m of org.members || []) {
      if (m) candidates.add(String(m._id || m));
    }
    for (const a of board.memberAccess || []) {
      if (a && a.user) candidates.add(String(a.user._id || a.user));
    }
    if (board.createdBy) candidates.add(String(board.createdBy._id || board.createdBy));
    for (const userId of candidates) {
      const isActor = actorId != null && userId === String(actorId);
      if (!isActor && !resolveAccess(board, org, userId).canRead) continue;
      eventBus.emit('board.changed', { userId, boardId });
    }
  } catch (err) {
    console.error('announceBoardChanged error:', err && err.message);
  }
};

// ---------------------------------------------------------------------------
// Mirrors on other boards
// ---------------------------------------------------------------------------

/**
 * Mirrors on OTHER boards follow a source column's relabel.
 *
 * A mirror of a money column is stamped with its source's code when it is made
 * (`inheritMirrorFormat`), and nothing re-stamped it afterwards — so after
 * Billing went INR→CAD, a mirror of its Amount on a neighbouring board still
 * said ₹ over CAD figures, and a reader in dollars saw them converted at the
 * rupee rate. The same mislabelling the relabel exists to fix, one board over.
 *
 * `changes` is `Map<sourceColumnId, { from, to }>`. A mirror follows only when
 * it is money, keeps the source's unit (first/sum/min/max — a count does not),
 * and still says the source's OLD code: one somebody deliberately set to a
 * different unit is theirs and is left alone. Each touched board re-derives the
 * formulas downstream of the mirror, is saved and announced, and whatever moved
 * there (the mirror, those formulas) is followed in turn — mirrors of mirrors.
 * `seen` stops a cycle.
 */
const followMirrors = async (org, changes, actorId, seen = new Set()) => {
  if (!org || !changes || !changes.size) return;
  const ids = [...changes.keys()];
  const oids = ids
    .filter((i) => mongoose.Types.ObjectId.isValid(i))
    .map((i) => new mongoose.Types.ObjectId(i));
  const boards = await Board.find({
    organisation: org._id,
    columns: { $elemMatch: { type: 'mirror', 'settings.sourceColumnId': { $in: [...ids, ...oids] } } },
  });
  const next = new Map();
  for (const b of boards) {
    const before = unitSnapshot(b);
    let touched = false;
    for (const c of b.columns || []) {
      if (c.type !== 'mirror' || seen.has(String(c._id))) continue;
      const s = c.settings || {};
      const ch = changes.get(String(s.sourceColumnId));
      if (!ch || !ch.to) continue;
      if (s.format !== 'currency' || !NUMERIC_MIRROR_AGGREGATIONS.includes(s.aggregation || 'first')) continue;
      if (normaliseCurrencyCode(s.currency) !== ch.from) continue;
      c.settings = { ...s, currency: ch.to };
      c.markModified('settings');
      seen.add(String(c._id));
      reconcileMoneyUnits(b, c, org.baseCurrency, { pinFollowing: false });
      touched = true;
    }
    if (!touched) continue;
    await b.save();
    announceBoardChanged(b, org, actorId);
    for (const [id, ch] of unitsMoved(b, before)) next.set(id, ch);
  }
  await followMirrors(org, next, actorId, seen);
};

// ---------------------------------------------------------------------------
// The relabel
// ---------------------------------------------------------------------------

/**
 * Relabel one board's money to `code` — THE relabel, for both callers:
 * `PATCH /api/boards/:id/currency` (one board, by hand) and
 * `relabelFollowingBoards` (every following board, when the workspace moves).
 *
 *   - `Board.currency` becomes `code` (an override) or, with `follow`, null —
 *     the board follows the workspace, and `code` should be the workspace's
 *     unit, which is what following means.
 *   - Every money column the board OWNS (number, formula, payments — anything
 *     with `format: 'currency'` that is not a mirror) is stamped `code`.
 *     Mirrors keep their SOURCE's unit: a CAD figure mirrored from a pipeline
 *     is CAD whatever this board says, and relabelling it would have a reader
 *     in dollars see it converted at the wrong rate.
 *   - The board is saved and announced (`board.changed`), then mirrors on
 *     OTHER boards that still say a moved column's old code follow it
 *     (`followMirrors`). The mirror half is best effort: the relabel itself
 *     has landed by then.
 *
 * `fromBase` is the workspace unit the board was READ in before this — what a
 * code-less money column rendered in, and so what its mirrors inherited. It
 * defaults to the org's current base; the workspace relabel passes the base it
 * is moving away FROM, because by then the org already names the new one.
 *
 * Stored figures are never touched: this relabels, it never converts.
 *
 * @param {import('mongoose').Document} board  a hydrated Board
 * @param {string} code  a catalog code
 * @param {{ org?: object, actorId?: string|null, follow?: boolean, fromBase?: string|null }} [opts]
 * @returns {Promise<{ board, moved: Map, following: boolean, effective: string }>}
 */
const relabelBoardMoney = async (
  board,
  code,
  { org = null, actorId = null, follow = false, fromBase } = {}
) => {
  const unit = normaliseCurrencyCode(code);
  if (!unit) throw new Error(`relabelBoardMoney: ${code} is not a currency we carry`);
  const workspace = org || (await Organisation.findById(board.organisation));
  const readBase = fromBase !== undefined ? fromBase : workspace && workspace.baseCurrency;

  // What each column was in before — a code-less money column rendered in the
  // board's unit, so that is what its mirrors inherited.
  const before = boardCurrencyOf(board, readBase);
  const moved = new Map();
  board.currency = follow ? null : unit;
  for (const col of board.columns || []) {
    if (!isOwnMoneyColumn(col)) continue;
    const from = moneyCodeOf(col) || before;
    if (from && from !== unit) moved.set(String(col._id), { from, to: unit });
    // The STORED value, not the normalised one: a legacy ' cad ' reads as CAD
    // and is still rewritten, so it lands the way exact-match readers expect.
    if (col.settings.currency === unit) continue;
    col.settings = { ...col.settings, currency: unit };
    if (typeof col.markModified === 'function') col.markModified('settings');
  }
  await board.save();

  // Every open tab on this board is now showing the old symbol. There is no
  // board-level subject in the activity log (task, goal, ads budget, group and
  // executive view are the five), so the relabel is announced rather than
  // logged.
  announceBoardChanged(board, workspace, actorId);

  // …and mirrors on OTHER boards reading these columns were stamped with the
  // old code when they were made.
  try {
    await followMirrors(workspace, moved, actorId);
  } catch (followErr) {
    console.error('relabelBoardMoney: mirror follow failed:', followErr && followErr.message);
  }

  return { board, moved, following: !!follow, effective: unit };
};

/** Whether any of the board's own money columns is not stored as `unit`. */
const ownMoneyOutOfStep = (board, unit) =>
  (board.columns || []).some((c) => isOwnMoneyColumn(c) && c.settings.currency !== unit);

/**
 * The workspace currency changed: every board that FOLLOWS it moves too.
 *
 * Relabels — through `relabelBoardMoney`, so mirrors elsewhere follow and open
 * tabs refresh — every board in `org` whose `currency` is null and which has at
 * least one own money column not already stored in the workspace's unit.
 * Override boards are never looked at; following boards already in step are
 * skipped, so running it again finds nothing to do.
 *
 * Bounded and safe: the candidates are found by one query, then each board is
 * re-read and re-checked at its turn (a board an earlier board's mirrors just
 * touched is relabelled as it now is, never from a stale copy) and relabelled
 * ONE AT A TIME. A board that fails is logged and reported in `failed`; it
 * never stops the rest, and the settings change that triggered this has
 * already been saved. Re-saving the workspace currency retries it.
 *
 * Archived boards are included: an archived board that follows still follows,
 * and would otherwise come back from the archive in the old unit.
 *
 * @param {object} org  the workspace, already naming its NEW `baseCurrency`
 * @param {{ actorId?: string|null, fromBase?: string|null }} [opts]
 *   `fromBase` is the currency the workspace was in before the change.
 * @returns {Promise<{ count: number, boardIds: string[], failed: string[] }>}
 */
const relabelFollowingBoards = async (org, { actorId = null, fromBase = null } = {}) => {
  const out = { count: 0, boardIds: [], failed: [] };
  if (!org) return out;
  const unit = workspaceCurrencyOf(org);
  const candidates = await Board.find({
    organisation: org._id,
    // null or absent: both follow.
    currency: null,
    columns: {
      $elemMatch: {
        type: { $ne: 'mirror' },
        'settings.format': 'currency',
        'settings.currency': { $ne: unit },
      },
    },
  })
    .select('_id')
    .sort({ order: 1 })
    .lean();

  for (const { _id } of candidates) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const board = await Board.findById(_id);
      if (!board || !isFollowing(board) || !ownMoneyOutOfStep(board, unit)) continue;
      // eslint-disable-next-line no-await-in-loop
      await relabelBoardMoney(board, unit, {
        org,
        actorId,
        follow: true,
        fromBase: normaliseCurrencyCode(fromBase) || unit,
      });
      out.boardIds.push(String(board._id));
    } catch (err) {
      console.error(`relabelFollowingBoards: board ${_id} failed:`, err && err.message);
      out.failed.push(String(_id));
    }
  }
  out.count = out.boardIds.length;
  return out;
};

// ---------------------------------------------------------------------------
// A new board's unit
// ---------------------------------------------------------------------------

/**
 * What a board created from a TEMPLATE (or blank) is in.
 *
 * It follows the workspace unless the creator explicitly asked for a currency
 * DIFFERENT from it — then that is pinned as the board's override. Asking for
 * the workspace's own code is not an override: the board still follows, so it
 * moves the next time the workspace does, which is what "in the workspace
 * currency" means.
 *
 * `stamp` is the code every template money column is born in (the board's
 * effective unit), `currency` what `Board.currency` is stored as.
 *
 * @param {{ chosen?: string|null, orgBase?: string|null }} opts
 * @returns {{ currency: string|null, stamp: string }}
 */
const planNewBoardCurrency = ({ chosen = null, orgBase = null } = {}) => {
  const workspace = normaliseCurrencyCode(orgBase) || DEFAULT_WORKSPACE_CURRENCY;
  const pick = normaliseCurrencyCode(chosen);
  if (pick && pick !== workspace) return { currency: pick, stamp: pick };
  return { currency: null, stamp: workspace };
};

/**
 * What a board COPIED from another is stored as, given the columns it is about
 * to be born with (already seeded — `seedTemplateColumns(..., { fromBoard: true })`
 * keeps each copied column's own code).
 *
 * The copy follows only when the SOURCE followed and every own money column it
 * carries is in the workspace's unit — then it is exactly a following board.
 * Otherwise it is pinned to the source's effective unit, because its columns
 * say that unit and a following copy would be relabelled out from under them
 * by the next workspace change.
 *
 * @param {{ sourceCurrency?: string|null, sourceEffective?: string|null,
 *           columns?: Array, orgBase?: string|null }} opts
 * @returns {string|null}
 */
const planCopiedBoardCurrency = ({
  sourceCurrency = null,
  sourceEffective = null,
  columns = [],
  orgBase = null,
} = {}) => {
  const workspace = normaliseCurrencyCode(orgBase) || DEFAULT_WORKSPACE_CURRENCY;
  const effective = normaliseCurrencyCode(sourceEffective) || workspace;
  const sourceFollowed = !normaliseCurrencyCode(sourceCurrency);
  const inStep = (Array.isArray(columns) ? columns : [])
    .filter(isOwnMoneyColumn)
    .every((c) => (normaliseCurrencyCode(c.settings.currency) || effective) === workspace);
  return sourceFollowed && inStep ? null : effective;
};

/**
 * What a board from before following existed should be — the migration's
 * answer (scripts/upgradeTemplateBoards.js), for a board whose `currency` is
 * still null. Returns the code to PIN, or null to leave it following.
 *
 *   - its own money columns (the codes they name) are all the workspace's, or
 *     there are none → it follows, which is what null now means;
 *   - they all name one OTHER code → pinned to it, so the board keeps meaning
 *     what it has always rendered in instead of being relabelled by the next
 *     workspace change;
 *   - they disagree → pinned to the first own money column's code (array
 *     order, as `boardCurrencyOf` reads it), as the step always did.
 */
const legacyBoardCurrency = (board, orgBase = null) => {
  const workspace = normaliseCurrencyCode(orgBase) || DEFAULT_WORKSPACE_CURRENCY;
  const codes = (Array.isArray(board && board.columns) ? board.columns : [])
    .filter(isOwnMoneyColumn)
    .map(moneyCodeOf)
    .filter(Boolean);
  const unique = new Set(codes);
  if (unique.size === 0) return null;
  if (unique.size === 1) {
    const [only] = unique;
    return only === workspace ? null : only;
  }
  return codes[0];
};

module.exports = {
  DEFAULT_WORKSPACE_CURRENCY,
  workspaceCurrencyOf,
  isFollowing,
  formulaRefs,
  moneyCodeOf,
  NUMERIC_MIRROR_AGGREGATIONS,
  reconcileMoneyUnits,
  unitSnapshot,
  unitsMoved,
  announceBoardChanged,
  followMirrors,
  relabelBoardMoney,
  relabelFollowingBoards,
  planNewBoardCurrency,
  planCopiedBoardCurrency,
  legacyBoardCurrency,
};
