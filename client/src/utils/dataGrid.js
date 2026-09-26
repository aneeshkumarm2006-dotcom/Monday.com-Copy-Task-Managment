/**
 * THE TABLE VIEW OF A FLEXIBLE-COLUMN BOARD — the decisions `DataGrid` makes
 * that are not about pixels.
 *
 * Pure — no React, no DOM, no store — so `node --test` can reach them: which
 * tracks the CSS grid has and in what order, how a column-menu choice becomes
 * the `settings` object the server is sent, what the reader may do, and what
 * a row is called. All of it is the kind of thing that is wrong by one and
 * looks fine — a footer whose cells sit one track to the left of the columns
 * they total, a "Currency" switch that stamps rupees onto a CAD board, a
 * contributor who can create rows everywhere except the Table.
 */

import { evaluateFormula, formulaReferences } from './formula.js';
import { templateDisplay } from './boardTemplateDisplay.js';

/** A row's select checkbox. */
export const SELECT_TRACK = 28;
/** The built-in Status cell — `task.status` against `board.statuses`. */
export const STATUS_TRACK = 130;
/** The trailing slot: "+ add column" in the header, the row ⋯ in the body. */
export const TRAILING_TRACK = 40;
/** A column with no stored width. */
export const DEFAULT_COLUMN_WIDTH = 160;

/** Column types whose value is a number and can therefore carry a display format. */
export const NUMBER_FORMATTABLE = new Set(['number', 'formula', 'mirror']);

/**
 * Column types whose `settings.currency` means something when the format is
 * currency. `payments` is money by definition — the server pins its format —
 * so it gets the Currency and Decimals controls without a Format picker.
 */
export const MONEY_CAPABLE = new Set([...NUMBER_FORMATTABLE, 'payments']);

/** The types a formula may reference — the server's `FORMULA_SOURCE_TYPES`. */
export const FORMULA_SOURCE_TYPES = ['number', 'formula', 'mirror', 'payments'];

export const columnWidth = (col) => {
  const w = Number(col?.width);
  return Number.isFinite(w) && w >= 40 ? w : DEFAULT_COLUMN_WIDTH;
};

/** The board's primary column: the one flagged, else the first. */
export const primaryIndexOf = (columns) => {
  const list = Array.isArray(columns) ? columns : [];
  const i = list.findIndex((c) => c?.isPrimary);
  return i >= 0 ? i : 0;
};

/**
 * Every track of the grid, in order, as `slots` — plus the `template` string
 * and the total `span`.
 *
 *   [select?] col … col(primary) [status?] col … trailing
 *
 * ---- Why the header, the rows and the footer all read THIS list ----------
 *
 * The grid is one CSS grid with no per-row container, so a cell's column is
 * decided purely by how many cells came before it. Adding a status track, a
 * checkbox and a row menu meant three places — header, body, footer — each
 * inserting the same extra cells in the same positions, and the first one to
 * forget shifts every total under the wrong column. Rendering all three from
 * one slot list makes that impossible rather than merely unlikely.
 *
 * The Status track sits right AFTER the primary column because that is where a
 * reader looks next: "INV-012 · Paid". It is not a `board.columns` entry — the
 * billing statuses live on the task (`task.status`), the same field the ledger
 * stamp, the group header's spread bar and the filters read, and a `status`
 * COLUMN would hold a separate value that disagrees with all three.
 */
export const gridSlots = (columns, { selectable = false, showStatus = false } = {}) => {
  const list = Array.isArray(columns) ? columns : [];
  const primaryIndex = primaryIndexOf(list);
  const slots = [];
  if (selectable) slots.push({ kind: 'select', key: '__select', width: SELECT_TRACK });
  list.forEach((column, index) => {
    slots.push({
      kind: 'column',
      key: String(column?._id ?? column?.key ?? index),
      column,
      index,
      primary: index === primaryIndex,
      width: columnWidth(column),
    });
    if (showStatus && index === primaryIndex) {
      slots.push({ kind: 'status', key: '__status', width: STATUS_TRACK });
    }
  });
  // A board with no columns still gets its Status track, so the rows it does
  // have are not status-less just because nobody added a column yet.
  if (showStatus && list.length === 0) slots.push({ kind: 'status', key: '__status', width: STATUS_TRACK });
  slots.push({ kind: 'trailing', key: '__trailing', width: TRAILING_TRACK });
  return {
    slots,
    template: slots.map((s) => `${s.width}px`).join(' '),
    span: slots.length,
    primaryIndex,
  };
};

/**
 * A column's settings after its Format is changed.
 *
 * Switching TO currency stamps a unit when the column has none, and that unit
 * is the BOARD's (`boardCurrencyOf`) — never the workspace's. A CAD billing
 * board in an INR workspace grew ₹ columns the other way, one beside the other,
 * which is the exact "the board is CAD but it shows rupees" complaint.
 * A column that already carries a code keeps it: somebody chose it.
 *
 * `boardCurrency` null stamps nothing, and the server then stamps its own
 * resolution of the same chain — honest, rather than inventing a unit here.
 */
export const withFormat = (settings, format, boardCurrency = null) => {
  const s = { ...(settings || {}), format };
  if (format === 'currency' && !s.currency && boardCurrency) s.currency = boardCurrency;
  return s;
};

/**
 * `withFormat` for a whole column — what the header menu's Format select saves.
 *
 * A MIRROR never takes this board's unit: its figures are its SOURCE board's,
 * so it sends no code and the server's `inheritMirrorFormat` fills in the
 * source's. Stamping this board's would label INR figures CA$ and convert them
 * at the CAD rate.
 */
export const withColumnFormat = (col, format, boardCurrency = null) =>
  withFormat(col?.settings, format, col?.type === 'mirror' ? null : boardCurrency);

/** The Decimals choices the column menu offers. `auto` stores nothing. */
export const DECIMAL_CHOICES = [
  { value: 'auto', label: 'Auto' },
  { value: '0', label: '0 — whole units' },
  { value: '2', label: '2 — cents / paise' },
];

/** A column's current Decimals choice as the select's value. */
export const decimalsChoiceOf = (settings) => {
  const d = settings?.decimals;
  return typeof d === 'number' && Number.isInteger(d) && d >= 0 ? String(d) : 'auto';
};

/**
 * A column's settings after a Decimals choice.
 *
 * 'auto' REMOVES the key rather than storing null or 'auto': an absent
 * `decimals` is what the formatters read as "whole stays whole, anything else
 * gets two" for a typed figure, and a stored null would be one more shape
 * every reader had to know about.
 */
export const withDecimals = (settings, choice) => {
  const { decimals: _drop, ...rest } = settings || {};
  if (choice === 'auto' || choice === '' || choice == null) return rest;
  const n = Number(choice);
  return Number.isInteger(n) && n >= 0 && n <= 4 ? { ...rest, decimals: n } : rest;
};

/** Does this column carry a currency right now? */
export const isMoneyColumn = (col) =>
  !!col && MONEY_CAPABLE.has(col.type) && (col.type === 'payments' || col.settings?.format === 'currency');

/**
 * Does this board hold money of its OWN — a money column that is not a mirror?
 *
 * What decides whether the grid shows the board-currency chip. A mirror's unit
 * belongs to the board it reads from (`isOwnMoneyColumn` in `utils/money.js`
 * draws the same line for "what unit is this board"), so a board whose only
 * money is mirrored from elsewhere has nothing for the chip to relabel, and
 * offering "Change currency" there would be offering a control that does
 * nothing a reader could see.
 */
export const hasOwnMoney = (columns) =>
  (Array.isArray(columns) ? columns : []).some((c) => isMoneyColumn(c) && c.type !== 'mirror');

/**
 * What the grid lets THIS reader do, from the host's props.
 *
 * ---- Why the explicit props win over `readOnly` ---------------------------
 *
 * The grid used to take one switch, `readOnly`, and the page passed
 * `readOnly={!canEdit}` — the `edit` rung. That was the whole ladder collapsed
 * into one bit, and it is the bug BoardDetailPage's own comment on
 * `canCreateTasks` describes: a member on the `contribute` rung holds
 * `task.create` and `task.change_status` but not `task.edit_any`, so with
 * `readOnly` as a veto they could neither add a row nor change a status, both
 * of which the server would happily accept. So each capability is its own
 * prop, and a prop that is given is the answer. `readOnly` is only the
 * DEFAULT for the ones a host leaves out — which is exactly what the old call
 * site (`readOnly` alone) meant, so it keeps working unchanged.
 *
 *   edit           cells are editable                 (default: !readOnly)
 *   create         the "+ Add <row>" row              (default: edit)
 *   manageColumns  column menus and "+ add column"    (default: !readOnly)
 *   changeStatus   the status chip is a button        (default: edit)
 */
export const gridPermissions = ({
  readOnly = false,
  canEdit,
  canCreate,
  canManageColumns,
  canChangeStatus,
} = {}) => {
  const given = (v) => v !== undefined && v !== null;
  const edit = given(canEdit) ? !!canEdit : !readOnly;
  return {
    edit,
    create: given(canCreate) ? !!canCreate : edit,
    manageColumns: given(canManageColumns) ? !!canManageColumns : !readOnly,
    changeStatus: given(canChangeStatus) ? !!canChangeStatus : edit,
  };
};

/**
 * Does the grid get a Status track?
 *
 * Only when there is something to show AND somewhere for a click to go. A
 * board with no statuses would render a column of identical grey "Not
 * started" chips; a host that passes no `onStatusClick` has no StatusMenu to
 * open. The status itself lives on the task (see `gridSlots`), so a board
 * that has statuses is enough — no column is needed.
 */
export const wantsStatusTrack = (board, onStatusClick) =>
  typeof onStatusClick === 'function' &&
  Array.isArray(board?.statuses) &&
  board.statuses.length > 0;

/**
 * What the grid calls a row: "No invoices yet", "Add invoice".
 *
 * From the board's template display (`boardTemplateDisplay.js`), which is
 * NAMING ONLY — a board with no template, or one whose template has since left
 * the registry, gets "item" rather than a blank.
 */
export const gridNouns = (board) => {
  const [one, many] = templateDisplay(board).rowNoun;
  return { one, many, empty: `No ${many} yet`, add: `Add ${one}` };
};

const blankCell = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

/**
 * The value a cell renders.
 *
 * The primary (title) column is a text cell the server keeps in step with
 * `task.name` — a write to it renames the task, and creating or renaming a
 * task mirrors the name into it. A row written BEFORE that sync existed has an
 * empty title cell and a perfectly good name, and a Table whose Invoice column
 * is blank beside a Ledger that shows "INV-004" is the same row contradicting
 * itself. So an empty primary text cell falls back to the name.
 *
 * `lead_name` is the legacy CRM migration's title column and keeps its old
 * rule — the name first — unchanged.
 */
export const cellDisplayValue = (task, column, raw, isPrimary = false) => {
  if (column?.key === 'lead_name') return task?.name || raw;
  if (isPrimary && column?.type === 'text' && blankCell(raw) && task?.name) return task.name;
  return raw;
};

/**
 * Which controls a column's header menu offers, by type.
 *
 *   format    Plain / Currency / Percent — number-ish columns only. A rating is
 *             not offered it: stars are not currency, and offering the choice
 *             invites somebody to make them so.
 *   currency  the unit — any column that is money right now, which includes a
 *   decimals  payments column (money by definition) without a Format picker.
 *   formula   "Edit formula…" — where a formula's expression is written.
 *   connect   "Connected boards…" — which boards a connect column links to;
 *             without it a template's connect column is a dead end.
 *
 * The host still gates the whole menu on `column.manage`.
 */
export const columnMenuControls = (col) => {
  const type = col?.type;
  const money = isMoneyColumn(col);
  return {
    format: NUMBER_FORMATTABLE.has(type),
    currency: money,
    decimals: money,
    formula: type === 'formula',
    connect: type === 'connect_boards',
  };
};

/**
 * The columns a formula on this board may reference: numeric ones, never the
 * formula itself. `selfKey` is the formula's own key when editing one.
 */
export const formulaInputColumns = (columns, selfKey = null) =>
  (Array.isArray(columns) ? columns : []).filter(
    (c) => c && c.key && FORMULA_SOURCE_TYPES.includes(c.type) && c.key !== selfKey
  );

/** Connect columns that actually point somewhere — what a Mirror can read from. */
export const connectColumnsWithTargets = (columns) =>
  (Array.isArray(columns) ? columns : []).filter(
    (c) =>
      c?.type === 'connect_boards' &&
      Array.isArray(c.settings?.targetBoardIds) &&
      c.settings.targetBoardIds.length > 0
  );

const FORMULA_MAX_LENGTH = 500;
const PRIMES = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47];

/**
 * Is `expression` a formula the server will accept on this board?
 *
 * The client copy of `validateFormulaExpression`'s rules, run as the person
 * types so the editor can say what is wrong BEFORE a round trip — the server
 * still validates, and its message is shown if it disagrees. Returns
 * `{ ok: true, refs }` or `{ error }` in the server's wording.
 *
 * The syntax probe stands every reference in for a DIFFERENT prime rather than
 * the server's all-ones: `column.a / (column.b - column.a)` is a sound formula
 * that divides by zero when both inputs are 1, and `evaluateFormula` (which
 * returns null rather than throwing) cannot tell that apart from a typo.
 */
export const checkFormula = (expression, columns, selfKey = null) => {
  if (typeof expression !== 'string' || !expression.trim()) {
    return { error: 'A formula needs an expression, like column.amount - column.paid.' };
  }
  if (expression.length > FORMULA_MAX_LENGTH) return { error: 'That formula is too long.' };

  const byKey = new Map((Array.isArray(columns) ? columns : []).filter(Boolean).map((c) => [c.key, c]));
  const refs = formulaReferences(expression);
  for (const key of refs) {
    if (selfKey && key === selfKey) return { error: 'A formula cannot refer to itself.' };
    const col = byKey.get(key);
    if (!col) return { error: `The formula refers to "column.${key}", which is not a column on this board.` };
    if (!FORMULA_SOURCE_TYPES.includes(col.type)) {
      return { error: `"${col.name}" is not a number column, so a formula cannot use it.` };
    }
  }

  const probe = Object.fromEntries(refs.map((k, i) => [k, PRIMES[i % PRIMES.length] + Math.floor(i / PRIMES.length)]));
  if (evaluateFormula(expression, probe) === null) {
    return { error: 'That formula is not valid. Use numbers, + - * / ( ) and column.<key> references.' };
  }
  return { ok: true, refs };
};

const NUMBER_FORMATS_FOR_FORMULA = ['plain', 'currency', 'percent'];

/**
 * A formula column's settings from the editor's fields.
 *
 * The editor holds `decimals` as the select's string ('auto' / '0' / '2'), and
 * a currency only means something when the format is currency — a Plain
 * formula keeps whatever code it had (harmless, and it survives a switch back)
 * but is never stamped with a new one.
 */
export const formulaSettingsFrom = (base, { expression, format, currency, decimals } = {}) => {
  const fmt = NUMBER_FORMATS_FOR_FORMULA.includes(format) ? format : 'plain';
  let s = { ...(base || {}), expression: typeof expression === 'string' ? expression.trim() : '', format: fmt };
  if (fmt === 'currency' && currency) s.currency = currency;
  s = withDecimals(s, decimals);
  return s;
};

/**
 * The formula editor's starting fields for an existing column, or a new one.
 *
 * `currency` pre-fills with the BOARD's so switching a new formula to Currency
 * lands in the unit its inputs are in; it is only stored when the format is
 * currency (see `formulaSettingsFrom`).
 */
export const formulaDraftOf = (settings, boardCurrency = null, fallbackFormat = 'plain') => ({
  expression: typeof settings?.expression === 'string' ? settings.expression : '',
  format: NUMBER_FORMATS_FOR_FORMULA.includes(settings?.format) ? settings.format : fallbackFormat,
  currency: settings?.currency || boardCurrency || '',
  decimals: decimalsChoiceOf(settings),
});
