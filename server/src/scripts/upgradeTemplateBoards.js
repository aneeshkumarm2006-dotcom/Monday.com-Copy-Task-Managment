/**
 * upgradeTemplateBoards.js
 *
 * Brings boards created from a template BEFORE the billing/currency fixes up to
 * what a board created today looks like. New boards need none of this; it exists
 * only for the ones already in the database.
 *
 * WHAT IT DOES, per template / flexible board:
 *
 *   1. ROLES — every template board: stamps `settings.role` ('dueDate' /
 *      'assignee') onto the template columns it still has, matched by key AND
 *      type, where the column states no role of its own. `utils/columnRoles.js`
 *      already falls back to the template for such a column, so this changes no
 *      answer today; it makes the role a fact the column carries, so it
 *      survives the board's template being renamed or retired. Skipped when
 *      another column on the board already claims that role explicitly.
 *
 *   2. BILLING
 *      a. adds the Payments column when the board has no payments-type column,
 *         right after Amount and in Amount's currency (later columns shift one
 *         place right);
 *      b. opens the board on the Ledger: `defaultView` 'table' → 'ledger'. The
 *         template has said 'ledger' since the ledger shipped, but boards made
 *         before that still store 'table' and open on a grid with no status;
 *      c. converts the Client column from `connect_boards` to the `client` type
 *         (a pick among the workspace's client boards). Only while EVERY cell
 *         in it is empty — nobody could fill it, which is why it is changing —
 *         and only while nothing depends on it being a connect column: no mirror
 *         reads through it, and no other column is already of type `client`.
 *         One linked row anywhere and the column is left exactly as it is.
 *
 *   3. DECIMALS — every template board: clears `decimals: 0` from the template's
 *      money columns (billing, budget, pipeline, expenses — every column the
 *      template marks `format: 'currency'`, matched by key AND type). The old
 *      templates pinned it on all of them, which rendered 1,234.50 as 1,235.
 *
 *   4. CURRENCY — where `Board.currency` is unset. Unset now MEANS the board
 *      follows the workspace currency (and is relabelled when it changes), so
 *      the step decides whether that is true of this board
 *      (services/boardCurrency.js `legacyBoardCurrency`):
 *        - every own money column's code is the workspace's, or it has none →
 *          left null: it FOLLOWS the workspace ("follows workspace INR");
 *        - they all name one OTHER code → pinned to it ("currency pinned USD"),
 *          so the next workspace change cannot relabel figures typed in it;
 *        - they disagree → pinned to the first own money column's code, as
 *          this step always did.
 *      A board that already names a currency (an override) is left alone.
 *
 *   5. TITLES — every flexible board: a task whose primary (title) column is
 *      empty gets its `name` copied in. The two are now kept in step on every
 *      write; rows written before that only ever had the name.
 *
 *   6. DUE DATE / OWNER — every flexible board: where the task's legacy
 *      `dueDate` / `assignedTo` is empty but its role column holds a value, the
 *      legacy field is filled from the column. Those fields are what the
 *      filters, My Work and the due digest read, and on template boards they
 *      were never synced — an invoice 24 days late had, to them, no due date.
 *      Owners are copied only if they are still in the workspace AND can open
 *      the board (`resolveAccess`, the rule `validateAssignees` applies to every
 *      live write): person cells used to accept any id, and the due digest
 *      mails whoever is in `assignedTo` without checking, so a former member or
 *      somebody locked out of a private board would start getting its invoices.
 *
 *   7. REVISION — with --apply, stamps `Board.templateRevision` to
 *      `TEMPLATE_REVISION` once the board is done, whether or not it needed
 *      anything. A board at that revision is SKIPPED on every later run. Without
 *      the stamp, idempotency only held while nobody touched the board: delete
 *      the Payments column after the first run and a second run put it back.
 *      New boards are stamped at creation, so they are skipped from birth.
 *
 * And, as its own pass over EVERY board (not only template ones — tracker boards
 * are where the add-on lives, and they are usually born blank):
 *
 *   8. ADS BUDGET — `adsBudget.currency: 'USD'` on an add-on that is not
 *      switched on and has no rows is reset to null. That 'USD' is the old
 *      schema default Mongoose wrote onto every board, not anybody's choice, and
 *      left in place it beat the switch-on stamp — the tab opened in dollars on
 *      a rupee or CAD board. An add-on that is on, or holds rows, keeps its
 *      USD: there it may be a choice, and it already labels entered figures.
 *      Not revision-gated: it matches nothing once done, so it is idempotent
 *      on its own terms.
 *
 * WHAT IT NEVER DOES: convert or relabel money, overwrite a value somebody set,
 * or touch a legacy field that already holds something. Every step only fills
 * what is missing, so a second run finds nothing to do — and with the revision
 * stamp, a second run does not even look.
 *
 * Writes are surgical (`$set` on one array element via arrayFilters, per-task
 * `updateOne` in a bulkWrite), never a whole-document save: a save would run the
 * board's invariants over data that may predate them and refuse the write, and
 * a whole-array `$set` would race with anybody editing the board meanwhile.
 * Boards AND tasks are written with `timestamps: false`, so a backfill does not
 * make every row look recently edited, nor reshuffle board lists that sort on
 * `updatedAt`.
 *
 * Run from the server directory:
 *     node src/scripts/upgradeTemplateBoards.js [--board <boardId>] [--apply]
 *     npm run migrate:template-boards -- [--apply]
 *
 * Dry run by DEFAULT — it prints what it would do and writes nothing unless you
 * pass --apply.
 */

const mongoose = require('mongoose');
const Board = require('../models/Board');
const Task = require('../models/Task');
const Organisation = require('../models/Organisation');
const AdsBudget = require('../models/AdsBudget');
const BoardConnection = require('../models/BoardConnection');
const { templateByKey, TEMPLATE_REVISION } = require('../utils/boardTemplates');
const { roleColumn } = require('../utils/columnRoles');
const { normaliseCurrencyCode, boardCurrencyOf, isMoneyColumn, isOwnMoneyColumn } = require('../utils/money');
const { resolveAccess } = require('../utils/permissions');
const { legacyBoardCurrency, DEFAULT_WORKSPACE_CURRENCY } = require('../services/boardCurrency');

const TITLE_MAX = 500; // the text column's own limit (utils/columnTypes.js)

/** The Ads Budget add-on's old schema default — see step 8. */
const LEGACY_ADS_CURRENCY = 'USD';

const idStr = (v) => (v == null ? '' : String(v));

/** A key not yet used on this board: `base`, else `base_2`, `base_3`… */
const freeKey = (columns, base) => {
  const taken = new Set(columns.map((c) => c.key));
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}_${i}`)) i += 1;
  return `${base}_${i}`;
};

/** Board writes never bump `updatedAt` — see the header. */
const writeBoard = (filter, update, options = {}) =>
  Board.updateOne(filter, update, { ...options, timestamps: false });

/**
 * Whether a `connect_boards` cell holds nothing. Anything that is not the
 * serializer's empty shape (`{ links: [] }`, or no value at all) counts as
 * FULL — an unexpected shape is somebody's data until proven otherwise.
 */
const isEmptyConnectValue = (value) => {
  if (value == null) return true;
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  return value.links == null || (Array.isArray(value.links) && value.links.length === 0);
};

/**
 * A fresh per-board summary. One shape for every board the script reports on,
 * whichever pass found the work.
 */
const blankSummary = (board) => ({
  boardId: idStr(board._id),
  name: board.name,
  templateKey: board.templateKey || null,
  roles: [],
  paymentsAdded: null,
  defaultView: null,
  clientConverted: false,
  clientKept: null,
  decimalsCleared: [],
  currencyPinned: null,
  // The workspace code a board with no currency of its own was left to FOLLOW
  // — reported, not a write (nothing changes), so it never makes a board
  // "upgraded" on its own.
  currencyFollows: null,
  titles: 0,
  dueDates: 0,
  owners: 0,
  ownersDropped: 0,
  adsBudgetCurrencyCleared: false,
});

/**
 * Whether a summary records a CHANGE. `clientKept` and `ownersDropped` are
 * reasons something was deliberately NOT done, so on their own they do not make
 * a board "upgraded" — but they are still printed when it is.
 */
const hasWork = (s) =>
  !!(
    s.roles.length
    || s.paymentsAdded
    || s.defaultView
    || s.clientConverted
    || s.decimalsCleared.length
    || s.currencyPinned
    || s.titles
    || s.dueDates
    || s.owners
    || s.adsBudgetCurrencyCleared
  );

const describeSummary = (s) => {
  const parts = [];
  if (s.roles.length) parts.push(`roles ${s.roles.join(', ')}`);
  if (s.paymentsAdded) parts.push(`+Payments column (${s.paymentsAdded})`);
  if (s.defaultView) parts.push(`opens on ${s.defaultView}`);
  if (s.clientConverted) parts.push('Client column → client type');
  if (s.clientKept) parts.push(`Client column kept (${s.clientKept})`);
  if (s.decimalsCleared.length) parts.push(`decimals unpinned on ${s.decimalsCleared.join(', ')}`);
  if (s.currencyPinned) parts.push(`currency pinned ${s.currencyPinned}`);
  if (s.currencyFollows) parts.push(`follows workspace ${s.currencyFollows}`);
  if (s.titles) parts.push(`${s.titles} title(s)`);
  if (s.dueDates) parts.push(`${s.dueDates} due date(s)`);
  if (s.owners) parts.push(`${s.owners} owner(s)`);
  if (s.ownersDropped) parts.push(`${s.ownersDropped} owner id(s) skipped — not a member with access`);
  if (s.adsBudgetCurrencyCleared) parts.push(`Ads Budget legacy ${LEGACY_ADS_CURRENCY} cleared`);
  return parts.join(' · ');
};

/**
 * Plan (and with `apply`, perform) the upgrade for every matching board.
 * Assumes a live mongoose connection. Returns one summary per board that had
 * anything to do.
 *
 * @param {{ apply?: boolean, boardId?: string|null, log?: Function }} [opts]
 */
const upgradeTemplateBoards = async ({ apply = false, boardId = null, log = console.log } = {}) => {
  // Refuse rather than run without the marker: a run that cannot stamp is a run
  // that will re-add, on the next run, every column somebody deleted since.
  if (!Number.isInteger(TEMPLATE_REVISION) || TEMPLATE_REVISION < 1) {
    throw new Error('utils/boardTemplates.js exports no TEMPLATE_REVISION; refusing to upgrade without it.');
  }
  if (!Board.schema.path('templateRevision')) {
    throw new Error('Board has no templateRevision field; refusing to upgrade without it.');
  }

  const scope = { $or: [{ templateKey: { $ne: null } }, { useFlexibleColumns: true }] };
  if (boardId) scope._id = boardId;
  const current = { ...scope, templateRevision: { $gte: TEMPLATE_REVISION } };
  const filter = { ...scope, templateRevision: { $not: { $gte: TEMPLATE_REVISION } } };

  const [boards, upToDate] = await Promise.all([
    Board.find(filter)
      .select(
        'name templateKey useFlexibleColumns columns currency defaultView organisation '
          + 'visibility publicDefaultLevel createdBy memberAccess'
      )
      .lean(),
    Board.countDocuments(current),
  ]);

  log(`\n${apply ? '' : '[DRY RUN] '}Upgrading ${boards.length} template / flexible board(s) to revision ${TEMPLATE_REVISION}`);
  if (upToDate) log(`${upToDate} board(s) already at revision ${TEMPLATE_REVISION} — skipped`);
  log('');

  // What the owner filter and the currency pin need to know about each org,
  // fetched once per org rather than once per board.
  const orgs = new Map();
  const orgOf = async (orgId) => {
    const k = idStr(orgId);
    if (!orgs.has(k)) {
      const org = orgId
        ? await Organisation.findById(orgId)
            .select('baseCurrency admin admins members roles memberRoles')
            .lean()
        : null;
      orgs.set(k, org || null);
    }
    return orgs.get(k);
  };

  const summaries = [];
  let stamped = 0;

  for (const board of boards) {
    // A working copy of the columns, updated as steps are planned, so step 6
    // resolves roles against what step 1 is about to write.
    const columns = (board.columns || []).map((c) => ({ ...c, settings: { ...(c.settings || {}) } }));
    const tpl = board.templateKey ? templateByKey(board.templateKey) : null;
    const org = await orgOf(board.organisation);
    const orgBase = (org && org.baseCurrency) || null;
    const s = blankSummary(board);

    // ---- 1. roles -----------------------------------------------------------
    if (tpl) {
      for (const tcol of tpl.columns) {
        const role = tcol.settings && tcol.settings.role;
        if (!role) continue;
        const col = columns.find((c) => c.key === tcol.key && c.type === tcol.type);
        if (!col || col.settings.role) continue;
        if (columns.some((c) => c !== col && c.settings.role === role)) continue;
        s.roles.push(`${col.key}→${role}`);
        col.settings.role = role;
        if (apply) {
          await writeBoard(
            { _id: board._id },
            { $set: { 'columns.$[c].settings.role': role } },
            { arrayFilters: [{ 'c._id': col._id }] }
          );
        }
      }
    }

    // ---- 2. billing ---------------------------------------------------------
    if (board.templateKey === 'billing') {
      // ---- 2a. payments ----
      // Amount by the rule the ledger uses: the template's key, else the first
      // money column that is this board's OWN — a mirror's figures are its
      // source board's, never this invoice's amount.
      const amount =
        columns.find((c) => c.key === 'amount' && c.type === 'number') || columns.find(isOwnMoneyColumn) || null;

      if (!columns.some((c) => c.type === 'payments')) {
        const currency =
          normaliseCurrencyCode(amount && amount.settings.currency)
          || boardCurrencyOf(board, orgBase);
        const order = amount
          ? (Number(amount.order) || 0) + 1
          : Math.max(-1, ...columns.map((c) => Number(c.order) || 0)) + 1;
        const column = {
          _id: new mongoose.Types.ObjectId(),
          key: freeKey(columns, 'payments'),
          name: 'Payments',
          type: 'payments',
          width: 150,
          isPrimary: false,
          order,
          settings: { format: 'currency', ...(currency ? { currency } : {}), summary: 'sum' },
        };
        s.paymentsAdded = currency || '(no currency)';
        if (apply) {
          if (amount) {
            await writeBoard(
              { _id: board._id },
              { $inc: { 'columns.$[later].order': 1 } },
              { arrayFilters: [{ 'later.order': { $gte: order } }] }
            );
          }
          await writeBoard({ _id: board._id }, { $push: { columns: column } });
        }
        columns.push(column);
      }

      // ---- 2b. default view ----
      // Only the old default. A board somebody deliberately set to open on
      // stages or a calendar made a choice; 'table' on a billing board is what
      // the template said before the ledger existed.
      if (board.defaultView === 'table') {
        s.defaultView = 'ledger';
        if (apply) {
          await writeBoard({ _id: board._id, defaultView: 'table' }, { $set: { defaultView: 'ledger' } });
        }
      }

      // ---- 2c. client column ----
      const clientCol = columns.find((c) => c.key === 'client' && c.type === 'connect_boards');
      if (clientCol) {
        const colId = clientCol._id;
        const path = `columnValues.${idStr(colId)}`;
        let kept = null;

        if (columns.some((c) => c.type === 'client')) {
          kept = 'the board already has a client column';
        } else if (
          columns.some((c) => c.type === 'mirror' && idStr(c.settings.sourceConnectColumnId) === idStr(colId))
        ) {
          kept = 'a mirror column reads through it';
        } else if (
          await Board.exists({
            columns: {
              $elemMatch: { type: 'mirror', 'settings.sourceColumnId': { $in: [colId, idStr(colId)] } },
            },
          })
        ) {
          kept = 'a mirror on another board reads it';
        } else {
          // EVERY task, personal ones included: a single link anywhere is a
          // value this conversion would destroy.
          const cells = await Task.find({ board: board._id, [path]: { $exists: true, $ne: null } })
            .select(path)
            .lean();
          const filled = cells.filter((t) => !isEmptyConnectValue(t.columnValues && t.columnValues[idStr(colId)]));
          if (filled.length) kept = `${filled.length} row(s) hold a link`;
        }

        if (kept) {
          s.clientKept = kept;
        } else {
          s.clientConverted = true;
          const settings = clientCol.settings.summary !== undefined ? { summary: clientCol.settings.summary } : {};
          if (apply) {
            // Cells first, then the column: a crash between the two leaves an
            // empty connect column (harmless) rather than a client column
            // holding `{ links: [] }`, which is not a client value. The filter
            // re-checks emptiness so a link made since the check above survives.
            await Task.updateMany(
              { board: board._id, [path]: { $exists: true }, [`${path}.links.0`]: { $exists: false } },
              { $unset: { [path]: '' } },
              { timestamps: false }
            );
            await writeBoard(
              { _id: board._id },
              { $set: { 'columns.$[c].type': 'client', 'columns.$[c].settings': settings } },
              { arrayFilters: [{ 'c._id': colId, 'c.type': 'connect_boards' }] }
            );
            // The column no longer points at another board, so neither may its
            // edge — the same cleanup a type change or delete performs
            // (columnController `removeBoardConnection`), or mirror invalidation
            // would keep firing for a connection that no longer exists.
            await BoardConnection.deleteOne({ fromBoardId: board._id, fromColumnId: colId });
          }
          clientCol.type = 'client';
          clientCol.settings = settings;
        }
      }
    }

    // ---- 3. decimals --------------------------------------------------------
    if (tpl) {
      for (const tcol of tpl.columns) {
        if (!isMoneyColumn(tcol)) continue;
        const col = columns.find((c) => c.key === tcol.key && c.type === tcol.type);
        if (!col || col.settings.decimals !== 0) continue;
        s.decimalsCleared.push(col.key);
        delete col.settings.decimals;
        if (apply) {
          await writeBoard(
            { _id: board._id },
            { $unset: { 'columns.$[a].settings.decimals': '' } },
            { arrayFilters: [{ 'a._id': col._id }] }
          );
        }
      }
    }

    // ---- 4. currency --------------------------------------------------------
    if (!normaliseCurrencyCode(board.currency)) {
      // From the board as it was READ, so the answer is the unit it has been
      // rendering in — nothing above adds a money column in a new unit.
      const code = legacyBoardCurrency(board, orgBase);
      if (code) {
        s.currencyPinned = code;
        if (apply) {
          await writeBoard({ _id: board._id, currency: board.currency ?? null }, { $set: { currency: code } });
        }
      } else {
        // Already what a following board is: null, in the workspace's unit.
        s.currencyFollows = normaliseCurrencyCode(orgBase) || DEFAULT_WORKSPACE_CURRENCY;
      }
    }

    if (board.useFlexibleColumns) {
      const base = { isPersonal: { $ne: true }, board: board._id };

      // ---- 5. titles --------------------------------------------------------
      const primary = columns.find((c) => c.isPrimary);
      if (primary && primary.type === 'text') {
        const path = `columnValues.${idStr(primary._id)}`;
        const rows = await Task.find({
          ...base,
          name: { $nin: [null, ''] },
          $or: [{ [path]: { $exists: false } }, { [path]: null }, { [path]: '' }],
        })
          .select('_id name')
          .lean();
        const ops = rows
          .map((t) => ({ t, title: String(t.name).trim().slice(0, TITLE_MAX) }))
          .filter(({ title }) => title)
          .map(({ t, title }) => ({
            updateOne: { filter: { _id: t._id }, update: { $set: { [path]: title } }, timestamps: false },
          }));
        s.titles = ops.length;
        if (apply && ops.length) await Task.bulkWrite(ops);
      }

      const view = { ...board, columns };

      // ---- 6a. due date -----------------------------------------------------
      const dueCol = roleColumn(view, 'dueDate');
      if (dueCol) {
        const path = `columnValues.${idStr(dueCol._id)}`;
        const rows = await Task.find({ ...base, dueDate: null, [path]: { $exists: true, $nin: [null, ''] } })
          .select(`_id ${path}`)
          .lean();
        const ops = [];
        for (const t of rows) {
          const raw = t.columnValues && t.columnValues[idStr(dueCol._id)];
          const when = new Date(raw);
          if (Number.isNaN(when.getTime())) continue;
          ops.push({
            updateOne: { filter: { _id: t._id }, update: { $set: { dueDate: when } }, timestamps: false },
          });
        }
        s.dueDates = ops.length;
        if (apply && ops.length) await Task.bulkWrite(ops);
      }

      // ---- 6b. owner --------------------------------------------------------
      const ownerCol = roleColumn(view, 'assignee');
      if (ownerCol) {
        const path = `columnValues.${idStr(ownerCol._id)}`;
        const rows = await Task.find({
          ...base,
          $or: [{ assignedTo: { $exists: false } }, { assignedTo: { $size: 0 } }],
          [`${path}.0`]: { $exists: true },
        })
          .select(`_id ${path}`)
          .lean();
        // Membership AND access, decided once per person per board.
        const memberIds = new Set(((org && org.members) || []).map((m) => idStr(m && (m._id || m))));
        const allowed = new Map();
        const mayOwn = (id) => {
          if (!allowed.has(id)) {
            allowed.set(id, !!org && memberIds.has(id) && resolveAccess(board, org, id).canRead);
          }
          return allowed.get(id);
        };
        const ops = [];
        for (const t of rows) {
          const raw = t.columnValues && t.columnValues[idStr(ownerCol._id)];
          const valid = [...new Set((Array.isArray(raw) ? raw : []).map(idStr))].filter((id) =>
            mongoose.Types.ObjectId.isValid(id)
          );
          const ids = valid.filter(mayOwn);
          s.ownersDropped += valid.length - ids.length;
          if (ids.length === 0) continue;
          ops.push({
            updateOne: {
              filter: { _id: t._id },
              update: { $set: { assignedTo: ids.map((id) => new mongoose.Types.ObjectId(id)) } },
              timestamps: false,
            },
          });
        }
        s.owners = ops.length;
        if (apply && ops.length) await Task.bulkWrite(ops);
      }
    }

    // ---- 7. revision --------------------------------------------------------
    // Every board this run visited, not only the ones that needed something: a
    // board with nothing to do today is exactly the one whose Payments column,
    // deleted tomorrow, a later run must not put back. Last, so a run that dies
    // halfway through a board leaves it unstamped and the next run finishes it.
    if (apply) {
      await writeBoard({ _id: board._id }, { $set: { templateRevision: TEMPLATE_REVISION } });
      stamped += 1;
    }

    if (hasWork(s)) {
      summaries.push(s);
    } else if (s.clientKept || s.ownersDropped || s.currencyFollows) {
      // Nothing to change, but something deliberately NOT changed that the
      // person running this should hear about before --apply — including that
      // the board follows the workspace, so the next workspace currency change
      // relabels it.
      log(`${s.name}  [${s.templateKey || 'flexible'}]  nothing to change · ${describeSummary(s)}`);
    }
  }

  // ---- 8. ads budget (every board) ------------------------------------------
  const adsFilter = {
    'adsBudget.currency': LEGACY_ADS_CURRENCY,
    'adsBudget.enabled': { $ne: true },
  };
  if (boardId) adsFilter._id = boardId;
  const adsCandidates = await Board.find(adsFilter).select('name templateKey').lean();
  if (adsCandidates.length) {
    const withRows = new Set(
      (await AdsBudget.distinct('board', { board: { $in: adsCandidates.map((b) => b._id) } })).map(idStr)
    );
    const clear = adsCandidates.filter((b) => !withRows.has(idStr(b._id)));
    if (apply && clear.length) {
      // The filter is repeated on the write, so an add-on switched on (or
      // given a currency) since the read above is left alone.
      await Board.updateMany(
        { ...adsFilter, _id: { $in: clear.map((b) => b._id) } },
        { $set: { 'adsBudget.currency': null } },
        { timestamps: false }
      );
    }
    for (const b of clear) {
      let s = summaries.find((x) => x.boardId === idStr(b._id));
      if (!s) {
        s = blankSummary(b);
        summaries.push(s);
      }
      s.adsBudgetCurrencyCleared = true;
    }
  }

  for (const s of summaries) {
    log(`${s.name}  [${s.templateKey || 'flexible'}]  ${describeSummary(s)}`);
  }

  log(`\n${apply ? 'Upgraded' : 'Would upgrade'} ${summaries.length} board(s)`);
  if (apply && stamped) log(`Stamped ${stamped} board(s) at revision ${TEMPLATE_REVISION}; later runs skip them.`);
  if (!apply && summaries.length) log('Re-run with --apply to write.\n');
  return summaries;
};

module.exports = { upgradeTemplateBoards, isEmptyConnectValue };

// Run only when invoked directly, so a test (or anything else) can require the
// function without connecting to the database named in server/.env.
if (require.main === module) {
  require('dotenv').config();
  const connectDB = require('../config/db');
  require('../models'); // register all schemas

  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const boardFlagIndex = args.indexOf('--board');
  const boardId = boardFlagIndex !== -1 ? args[boardFlagIndex + 1] : null;

  (async () => {
    await connectDB();
    await upgradeTemplateBoards({ apply, boardId });
    await mongoose.disconnect();
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
