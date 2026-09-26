import { useMemo, useState } from 'react';
import { Plus, MoreHorizontal, Pin, PanelRightOpen } from 'lucide-react';
import GoalEvidenceMarker from './GoalEvidenceMarker';
import { cellComponentFor } from './columns';
import AddColumnButton from './AddColumnButton';
import BoardCurrencyControl from './BoardCurrencyControl';
import { FormulaEditorModal } from './FormulaEditor';
import { ConnectTargetsModal } from './ConnectTargetsEditor';
import Chip from '../ui/Chip';
import AnchoredPopover from '../ui/AnchoredPopover';
import useBoardStore from '../../store/boardStore';
import useTaskStore from '../../store/taskStore';
import useToastStore from '../../store/toastStore';
import useAuthStore from '../../store/authStore';
import { isTaskPinned } from '../../utils/taskPins';
import { computeSummary, summariesFor, summaryLabel } from '../../utils/columnSummary';
import { columnValue } from '../../utils/columnValues';
import { boardCurrencyOf, currencyOptions } from '../../utils/money';
import { issuedDayOf, ledgerColumns } from '../../utils/ledger';
import { getStatusPalette } from '../../utils/priorityColors';
import {
  DECIMAL_CHOICES,
  cellDisplayValue,
  columnMenuControls,
  decimalsChoiceOf,
  gridNouns,
  gridPermissions,
  gridSlots,
  hasOwnMoney,
  wantsStatusTrack,
  withDecimals,
  withColumnFormat,
} from '../../utils/dataGrid';
import useMoney from '../../hooks/useMoney';

/**
 * Column types whose cell is COMPUTED, never typed: a formula evaluates its
 * siblings, a mirror reads another board. Both render read-only whatever the
 * reader's rights — an editable-looking cell that 400s on every keystroke is
 * worse than one that plainly is not an input.
 */
const COMPUTED_TYPES = new Set(['formula', 'mirror']);

/**
 * DataGrid — the Table view of a flexible-column board, driven by
 * `board.columns` and a flat `tasks` array. Replaces the fixed-column
 * TaskTable for boards that have `useFlexibleColumns: true`, which is every
 * template board (Billing, Budget, Pipeline…) — so this is the Table for all
 * of them, and it has to be a whole one: a row you can open, a status you can
 * change, a row menu, a way to add a row.
 *
 * ---- One slot list, four renderers ----------------------------------------
 *
 * The grid is ONE CSS grid with no per-row container, so a cell's column is
 * decided purely by how many cells came before it. The header, every body row,
 * the "+ Add" row, the summary footer and the phone card are all rendered from
 * the same `gridSlots()` list (utils/dataGrid.js):
 *
 *   col … col(primary) [status] col … trailing
 *
 * A status track or a trailing ⋯ added in one place and forgotten in another
 * shifts every total one column to the left of what it totals; rendering all
 * of them from one list makes that impossible rather than merely unlikely.
 *
 * ---- Every affordance is its handler ---------------------------------------
 *
 * The page owns the StatusMenu, the row actions menu, the row panel / invoice
 * sheet and row creation. The grid only says where a click happened. A
 * handler the host does not pass is an affordance the grid does not draw — no
 * status track without `onStatusClick`, no ⋯ without `onRowMenu`, no open
 * button without `onOpenRow`, no "+ Add" row without `onAddRow` — so an old
 * call site that passes none of them renders exactly the grid it always did.
 *
 * ---- Menus live in a portal ------------------------------------------------
 *
 * The grid scrolls sideways inside `overflow-x: auto`, which makes it clip
 * vertically too, inside a group card that is `overflow: hidden`. The column
 * menu used to be an absolute box in the header cell and, on a group with one
 * invoice, its Currency, Summary and Delete were cut off and unreachable. It is
 * an `AnchoredPopover` now (body portal, `position: fixed`), which closes on a
 * click outside rather than on mouse-leave — mouse-leave closed it the moment
 * a native <select> inside it opened its own dropdown.
 *
 * Props (every one after `readOnly` is optional):
 *   board             current board doc (with `columns`, `statuses`)
 *   tasks             the rows, already filtered to the group and sorted
 *                     pinned-first by BoardDetailPage
 *   personalPins      Set of task ids this user pinned privately
 *   readOnly          legacy switch — the DEFAULT for the can* props below
 *                     when a host leaves them out (see `gridPermissions`)
 *   canEdit           cells are editable
 *   canEditRow(task)  optional: may this viewer edit THIS row? The page's rule
 *                     (edit_any, or edit_assigned on a row they created or are
 *                     on), mirroring the server's `canEditTask`. A row it says
 *                     yes to is editable even without `canEdit`, so a
 *                     contributor can fill in the invoice they just added in
 *                     the Table as well as in the sheet.
 *   canAssignOthers   `task.assign`. False limits person cells to the viewer's
 *                     own name (PersonCell `selfOnlyId`) — the server refuses
 *                     any other delta. Omitted means true.
 *   canCreate         show "+ Add <row>" (with `onAddRow`)
 *   canManageColumns  column menus, "+ add column", the currency chip's
 *                     Change control, and cells' "Set up" (`column.manage`)
 *   canChangeStatus   the status chip is a button (else a plain chip)
 *   onOpenRow(task)             the primary cell's open button
 *   onStatusClick(task, event)  a status chip click — anchor on
 *                               `event.currentTarget`
 *   onRowMenu(task, anchorEl)   the trailing ⋯
 *   onAddRow()                  the "+ Add <row>" row; the host binds the group
 *   showCurrency      render the board-currency chip above the grid when the
 *                     board holds money of its own (default true). The page
 *                     renders one grid PER GROUP, so it passes this for the
 *                     first group only rather than repeating the chip twelve
 *                     times down a billing board.
 */
const DataGrid = ({
  board,
  tasks = [],
  personalPins = null,
  readOnly = false,
  canEdit,
  canEditRow = null,
  canAssignOthers = true,
  canCreate,
  canManageColumns,
  canChangeStatus,
  onOpenRow,
  onStatusClick,
  onRowMenu,
  onAddRow,
  showCurrency = true,
}) => {
  const [headerMenu, setHeaderMenu] = useState(null); // { columnId, anchor }
  const [renamingId, setRenamingId] = useState(null);
  const [renameDraft, setRenameDraft] = useState('');
  // The column-menu editors that need more room than a popover: 'formula'
  // (FormulaEditorModal) and 'connect' (ConnectTargetsModal).
  const [editor, setEditor] = useState(null); // { kind, columnId }
  const [adding, setAdding] = useState(false);
  const setColumnValue = useBoardStore((s) => s.setColumnValue);
  const updateColumn = useBoardStore((s) => s.updateColumn);
  const deleteColumn = useBoardStore((s) => s.deleteColumn);
  const updateTaskLocal = useTaskStore((s) => s.updateTask);
  const toastError = useToastStore((s) => s.error);
  const money = useMoney();
  const selfId = useAuthStore((s) => (s.user?._id ? String(s.user._id) : null));

  const perms = gridPermissions({ readOnly, canEdit, canCreate, canManageColumns, canChangeStatus });
  /** Whether the viewer may edit `task`'s cells — the grid-wide rung, or this row's own rule. */
  const rowEditable = (task) =>
    perms.edit || (!readOnly && typeof canEditRow === 'function' && !!canEditRow(task));

  /**
   * The unit a money column with no code of its own is in, and what a column
   * switched to Currency is stamped with: the BOARD's (`boardCurrencyOf` —
   * board, else its first money column, else the workspace). This used to be
   * `workspace currency || 'INR'`, and that literal was a live source of a ₹
   * column on a CAD board: an explicit client-stamped code bypasses the
   * server's own board-currency stamp. Null while nothing is known yet, in
   * which case nothing is stamped and the server resolves the same chain.
   */
  const boardCurrency = boardCurrencyOf(board, money.baseCurrency);
  const nouns = gridNouns(board);
  // Which column dates a row for a converted figure's rate (billing's
  // "issued"). Resolved once per board, then read per row.
  const ledgerCols = useMemo(() => ledgerColumns(board), [board]);

  const columns = useMemo(
    () => (board?.columns || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0)),
    [board?.columns]
  );

  const showStatus = wantsStatusTrack(board, onStatusClick);
  const layout = useMemo(() => gridSlots(columns, { showStatus }), [columns, showStatus]);
  const primaryColumn = layout.slots.find((s) => s.kind === 'column' && s.primary)?.column || null;

  // Does any column ask for a summary? Checked once so an ordinary task board
  // — where none do — renders no footer row at all rather than a row of blanks.
  const hasSummaries = useMemo(
    () => columns.some((c) => c.settings?.summary && c.settings.summary !== 'none'),
    [columns]
  );

  const canAddRow = typeof onAddRow === 'function' && perms.create;
  const showCurrencyChip = showCurrency && hasOwnMoney(columns);

  const onCellChange = async (task, column, value) => {
    try {
      const updated = await setColumnValue(task._id, column._id, value);
      if (updated) updateTaskLocal(updated);
    } catch (err) {
      const message = err?.response?.data?.errors?.[0]?.message || err?.response?.data?.error || err?.message || 'Update failed';
      toastError(message);
    }
  };

  /**
   * "+ Add invoice". Held while the host's create is in flight so a
   * double-click is one row, not two — the host's handler is a POST and an
   * open, and nothing else stops the second click.
   */
  const handleAddRow = async () => {
    if (!canAddRow || adding) return;
    setAdding(true);
    try {
      await onAddRow();
    } catch {
      // The host toasts its own failure; this only has to let go of the lock.
    } finally {
      setAdding(false);
    }
  };

  /** What a row is called in an accessible name: its title, else the noun. */
  const rowTitle = (task) => {
    if (task?.name) return task.name;
    const raw = primaryColumn ? columnValue(task, primaryColumn._id) : null;
    return typeof raw === 'string' && raw.trim() ? raw.trim() : nouns.one;
  };

  /**
   * One cell, for the desktop row and the phone card alike — the extras every
   * cell may use (see `columns/cellShared.js`): the board's columns for a
   * formula to compute, the board's currency for a code-less money column, the
   * row's issued day for a converted figure's rate, and `canManage` so a cell
   * can offer "Set up" instead of a dead end.
   */
  const renderCell = (task, col, isPrimary, on) => {
    const Cell = cellComponentFor(col.type);
    const raw = columnValue(task, col._id) ?? null;
    return (
      <Cell
        value={cellDisplayValue(task, col, raw, isPrimary)}
        column={col}
        task={task}
        columns={board.columns}
        currency={boardCurrency}
        on={on}
        canManage={perms.manageColumns}
        readOnly={!rowEditable(task) || COMPUTED_TYPES.has(col.type)}
        selfOnlyId={canAssignOthers ? null : selfId}
        onChange={(v) => onCellChange(task, col, v)}
      />
    );
  };

  const statusChip = (task, variant) => {
    const value = task.status || 'not_started';
    const clickable = perms.changeStatus && typeof onStatusClick === 'function';
    const label = getStatusPalette(board, value).label;
    return (
      <Chip
        type="status"
        variant={variant}
        value={value}
        board={board}
        onClick={clickable ? (e) => onStatusClick(task, e) : undefined}
        aria-label={clickable ? `Status: ${label}. Change the status of ${rowTitle(task)}` : undefined}
        aria-haspopup={clickable ? 'listbox' : undefined}
      />
    );
  };

  const ctx = {
    slots: layout.slots,
    board,
    ledgerCols,
    personalPins,
    nouns,
    renderCell,
    statusChip,
    rowTitle,
    onOpenRow: typeof onOpenRow === 'function' ? onOpenRow : null,
    onRowMenu: typeof onRowMenu === 'function' ? onRowMenu : null,
  };

  const handleRenameCommit = async (columnId) => {
    const next = renameDraft.trim();
    if (!next) {
      setRenamingId(null);
      return;
    }
    try {
      await updateColumn(board._id, columnId, { name: next });
    } catch (err) {
      toastError(err?.response?.data?.error || 'Rename failed');
    }
    setRenamingId(null);
  };

  const handleDelete = async (column) => {
    if (column.isPrimary) {
      toastError('The primary column cannot be deleted');
      return;
    }
    if (!window.confirm(`Delete column "${column.name}"? Existing values will be cleared.`)) return;
    try {
      await deleteColumn(board._id, column._id);
    } catch (err) {
      toastError(err?.response?.data?.error || 'Delete failed');
    }
  };

  /** Save a column's settings from the menu, and close it. */
  const saveSettings = (col, settings, failure) => {
    updateColumn(board._id, col._id, { settings }).catch((err) =>
      toastError(err?.response?.data?.error || failure)
    );
    setHeaderMenu(null);
  };

  /**
   * Close the menu, THEN run something that blocks the page (a confirm, a
   * prompt). Deferred a tick so the popover has actually gone — otherwise it
   * sits frozen on screen under the browser's dialog.
   */
  const closeThen = (fn) => {
    setHeaderMenu(null);
    setTimeout(fn, 0);
  };

  const menuColumn = headerMenu ? columns.find((c) => c._id === headerMenu.columnId) || null : null;
  const editorColumn = editor ? columns.find((c) => c._id === editor.columnId) || null : null;

  if (columns.length === 0) {
    return (
      <div style={{ padding: 24, textAlign: 'center', color: 'var(--color-text-muted)' }}>
        No columns yet. {perms.manageColumns && <AddColumnButton boardId={board._id} board={board} />}
      </div>
    );
  }

  const renderColumnMenu = (col) => {
    const controls = columnMenuControls(col);
    const currencyValue = col.settings?.currency || boardCurrency || '';
    return (
      <>
        <MenuButton
          onClick={() => {
            setRenamingId(col._id);
            setRenameDraft(col.name);
            setHeaderMenu(null);
          }}
        >
          Rename
        </MenuButton>
        <MenuButton
          onClick={() =>
            closeThen(() => {
              const w = Number(window.prompt('Column width in px', String(col.width || 160)));
              if (Number.isFinite(w) && w >= 40 && w <= 1000) {
                updateColumn(board._id, col._id, { width: w }).catch((err) =>
                  toastError(err?.response?.data?.error || 'Width update failed')
                );
              }
            })
          }
        >
          Change width
        </MenuButton>

        {/* The two editors a column's type needs and a popover cannot hold:
            a formula's expression (with its column chips and live preview),
            and which boards a connect column links to. Without the second, a
            template's connect column is seeded pointing nowhere and stays a
            dead end. */}
        {controls.formula && (
          <MenuButton
            onClick={() => {
              setHeaderMenu(null);
              setEditor({ kind: 'formula', columnId: col._id });
            }}
          >
            Edit formula…
          </MenuButton>
        )}
        {controls.connect && (
          <MenuButton
            onClick={() => {
              setHeaderMenu(null);
              setEditor({ kind: 'connect', columnId: col._id });
            }}
          >
            Connected boards…
          </MenuButton>
        )}

        {/* Format — number-ish columns only. The stored value stays a plain
            number; this only decides what it looks like, which is why it lives
            in settings rather than changing the type. Switching TO currency
            stamps the BOARD's unit when the column has none (`withFormat`) —
            except on a MIRROR, whose figures are its SOURCE board's: it sends
            no code, and the server's `inheritMirrorFormat` fills in the
            source's. Stamping this board's would label INR figures CA$. */}
        {controls.format && (
          <MenuSelect
            label="Format"
            value={col.settings?.format || 'plain'}
            onChange={(format) =>
              saveSettings(col, withColumnFormat(col, format, boardCurrency), 'Could not change the format')
            }
          >
            <option value="plain">Plain number</option>
            <option value="currency">Currency</option>
            <option value="percent">Percent</option>
          </MenuSelect>
        )}

        {/* Currency — any column that is money right now, payments included.
            It RELABELS: the stored numbers are not converted. Shows the
            column's own code, else the board's — the unit it renders in. */}
        {controls.currency && (
          <MenuSelect
            label="Currency"
            value={currencyValue}
            onChange={(currency) =>
              saveSettings(col, { ...(col.settings || {}), currency }, 'Could not change the currency')
            }
          >
            {!currencyValue && (
              <option value="" disabled>
                Choose a currency
              </option>
            )}
            {currencyOptions().map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </MenuSelect>
        )}

        {controls.decimals && (
          <MenuSelect
            label="Decimals"
            value={decimalsChoiceOf(col.settings)}
            onChange={(choice) =>
              saveSettings(col, withDecimals(col.settings, choice), 'Could not change the decimals')
            }
          >
            {DECIMAL_CHOICES.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </MenuSelect>
        )}

        {/* Summary — what the footer under this column adds up to. The options
            depend on the type: you can sum a number and count a checkbox, and
            offering the wrong one is offering a footer that reads NaN. */}
        <MenuSelect
          label="Summary"
          value={col.settings?.summary || 'none'}
          onChange={(summary) =>
            saveSettings(col, { ...(col.settings || {}), summary }, 'Could not change the summary')
          }
        >
          {summariesFor(col.type).map((sum) => (
            <option key={sum.key} value={sum.key}>
              {sum.label}
            </option>
          ))}
        </MenuSelect>

        <MenuButton
          disabled={col.isPrimary}
          danger
          title={col.isPrimary ? 'The primary column cannot be deleted' : undefined}
          onClick={() => closeThen(() => handleDelete(col))}
        >
          Delete
        </MenuButton>
      </>
    );
  };

  const headerCell = (slot) => {
    if (slot.kind === 'status') {
      return (
        <div key={slot.key} style={headerCellStyle}>
          <span style={{ flex: 1 }}>Status</span>
        </div>
      );
    }
    if (slot.kind === 'trailing') {
      // Add-column anchor at the end of the header row.
      return (
        <div key={slot.key} style={{ ...headerCellStyle, padding: '4px 6px', justifyContent: 'center' }}>
          {perms.manageColumns && <AddColumnButton boardId={board._id} board={board} />}
        </div>
      );
    }
    if (slot.kind !== 'column') return <div key={slot.key} style={headerCellStyle} />;

    const col = slot.column;
    const open = headerMenu?.columnId === col._id;
    return (
      <div key={slot.key} style={headerCellStyle}>
        {renamingId === col._id ? (
          <input
            value={renameDraft}
            autoFocus
            aria-label={`Rename column ${col.name}`}
            onChange={(e) => setRenameDraft(e.target.value)}
            onBlur={() => handleRenameCommit(col._id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRenameCommit(col._id);
              if (e.key === 'Escape') setRenamingId(null);
            }}
            style={{
              flex: 1,
              minWidth: 0,
              background: 'transparent',
              border: '1px solid var(--color-accent)',
              padding: '2px 4px',
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--color-text-primary)',
            }}
          />
        ) : (
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {col.name}
            {col.isPrimary && (
              <span style={{ marginLeft: 4, opacity: 0.6 }} title="Primary column">
                *
              </span>
            )}
          </span>
        )}
        {perms.manageColumns && (
          <button
            type="button"
            onClick={(e) => setHeaderMenu(open ? null : { columnId: col._id, anchor: e.currentTarget })}
            aria-label={`Column actions for ${col.name}`}
            aria-haspopup="dialog"
            aria-expanded={open}
            className="shrink-0 inline-flex items-center justify-center rounded transition-colors hover:bg-[color:var(--color-border)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--color-accent)]"
            style={{ border: 'none', cursor: 'pointer', padding: 2, color: 'var(--color-text-muted)' }}
          >
            <MoreHorizontal size={12} aria-hidden="true" />
          </button>
        )}
      </div>
    );
  };

  const footerCell = (slot) => {
    if (slot.kind !== 'column') return <div key={`sum-${slot.key}`} style={footerCellStyle} />;
    const col = slot.column;
    // `board.columns` so a formula column can find its inputs — without it a
    // "Remaining" formula has no values and totals nothing.
    const result = computeSummary(tasks, col, board.columns);
    const label = summaryLabel(tasks, col, board.columns);
    return (
      <div
        key={`sum-${slot.key}`}
        style={{
          ...footerCellStyle,
          padding: '6px 10px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          justifyContent: 'center',
          minHeight: 40,
        }}
      >
        {result && (
          <>
            <span
              style={{
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: '0.07em',
                textTransform: 'uppercase',
                color: 'var(--color-text-muted)',
                lineHeight: 1.2,
              }}
            >
              {label}
            </span>
            <span
              style={{
                fontSize: 13,
                fontWeight: 700,
                color: 'var(--color-text-primary)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {/* `raw` counts (filled / empty / checked) are counts of ROWS,
                  not values in the column's own unit — running them through
                  the currency formatter would print "₹3" for three receipts.
                  A money total is in the column's code, else the BOARD's. */}
              {result.raw
                ? result.value.toLocaleString()
                : money.column(result.value, col.settings, null, boardCurrency)}
            </span>
          </>
        )}
      </div>
    );
  };

  // "+ Add invoice" / "No invoices yet". Pinned to the left edge of the
  // scroll area so a wide board does not scroll them out of sight.
  const addRowButton = (
    <button
      type="button"
      onClick={handleAddRow}
      disabled={adding}
      className="inline-flex items-center gap-1.5 font-body rounded transition-colors hover:text-[color:var(--color-accent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--color-accent)] disabled:opacity-60"
      style={{
        fontSize: 13,
        color: 'var(--color-text-muted)',
        border: 'none',
        padding: '8px 12px',
        cursor: adding ? 'progress' : 'pointer',
      }}
    >
      <Plus size={14} aria-hidden="true" />
      {adding ? 'Adding…' : nouns.add}
    </button>
  );

  return (
    <>
      {/* The unit this board's money is in, said where the money is — and,
          for `column.manage`, the one-click way to change it. */}
      {showCurrencyChip && (
        <div className="flex items-center justify-end" style={{ padding: '6px 10px 4px' }}>
          <BoardCurrencyControl board={board} canManage={perms.manageColumns} compact />
        </div>
      )}

      {/* Desktop / tablet (≥768px): the scrollable spreadsheet grid. */}
      <div className="hidden md:block" style={{ width: '100%', overflowX: 'auto' }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: layout.template,
            minWidth: 'fit-content',
          }}
        >
          {/* Header row */}
          {layout.slots.map(headerCell)}

          {/* Body rows */}
          {tasks.map((task, ri) => (
            <Row key={task._id} task={task} ri={ri} ctx={ctx} />
          ))}
          {tasks.length === 0 && (
            <div style={{ gridColumn: '1 / -1' }}>
              <div
                className="font-body"
                style={{
                  position: 'sticky',
                  left: 0,
                  display: 'inline-block',
                  padding: '20px 12px',
                  color: 'var(--color-text-muted)',
                  fontSize: 13,
                }}
              >
                {nouns.empty}
              </div>
            </div>
          )}

          {canAddRow && (
            <div style={{ gridColumn: '1 / -1', borderBottom: '1px solid var(--color-border)' }}>
              <div style={{ position: 'sticky', left: 0, display: 'inline-block' }}>{addRowButton}</div>
            </div>
          )}

          {/* Summary row — the number under a column, per group. Rendered only
              when at least one column asks for one, so an ordinary task board
              grows no extra row. Part of the same CSS grid, built from the same
              slots, so each total sits under the column it totals. */}
          {hasSummaries && tasks.length > 0 && layout.slots.map(footerCell)}
        </div>
      </div>

      {/* Mobile (<768px): the spreadsheet grid can't fit, so each task becomes a
          stacked card with one "column name → cell" row per slot. Reuses the
          exact same cell renderers as the grid. */}
      <div className="md:hidden flex flex-col gap-3">
        {tasks.length === 0 ? (
          <div
            className="font-body"
            style={{
              padding: '24px 12px',
              color: 'var(--color-text-muted)',
              fontSize: 13,
              textAlign: 'center',
            }}
          >
            {nouns.empty}
          </div>
        ) : (
          tasks.map((task) => <MobileCard key={task._id} task={task} ctx={ctx} />)
        )}
        {(canAddRow || perms.manageColumns) && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {canAddRow && addRowButton}
            {perms.manageColumns && (
              <span className="inline-flex items-center gap-2">
                <AddColumnButton boardId={board._id} board={board} />
                <span className="font-body" style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                  Add column
                </span>
              </span>
            )}
          </div>
        )}
      </div>

      {menuColumn && headerMenu?.anchor && (
        <AnchoredPopover
          anchorEl={headerMenu.anchor}
          onClose={() => setHeaderMenu(null)}
          align="end"
          width={220}
          maxHeight={460}
          padding={4}
          ariaLabel={`Column settings — ${menuColumn.name}`}
          initialFocus
        >
          {renderColumnMenu(menuColumn)}
        </AnchoredPopover>
      )}

      {editor?.kind === 'formula' && editorColumn && (
        <FormulaEditorModal
          boardId={board._id}
          column={editorColumn}
          columns={board.columns}
          sampleTask={tasks[0] || null}
          boardCurrency={boardCurrency}
          onClose={() => setEditor(null)}
        />
      )}
      {editor?.kind === 'connect' && editorColumn && (
        <ConnectTargetsModal boardId={board._id} column={editorColumn} onClose={() => setEditor(null)} />
      )}
    </>
  );
};

/**
 * The primary cell's "open" button — the row's panel, or the invoice sheet on a
 * ledger board (the host decides). Revealed on row hover or focus so a dense
 * grid is not a column of icons; always shown where there is no hover.
 */
const OpenRowButton = ({ task, title, onOpen, always = false }) => (
  <button
    type="button"
    onClick={() => onOpen(task)}
    aria-label={`Open ${title}`}
    title="Open"
    className={[
      'shrink-0 self-center inline-flex items-center justify-center rounded-md transition-opacity duration-150',
      'hover:bg-[color:var(--color-border)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--color-accent)]',
      always
        ? ''
        : 'opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-100',
    ].join(' ')}
    style={{ width: 26, height: 26, marginRight: 4, border: 'none', padding: 0, cursor: 'pointer', color: 'var(--color-text-secondary)' }}
  >
    <PanelRightOpen size={14} aria-hidden="true" />
  </button>
);

/** The trailing ⋯ — the host's row actions menu, anchored on this button. */
const RowMenuButton = ({ task, title, onMenu }) => (
  <button
    type="button"
    onClick={(e) => onMenu(task, e.currentTarget)}
    aria-label={`More actions for ${title}`}
    aria-haspopup="menu"
    className="inline-flex items-center justify-center rounded-md transition-colors duration-150 hover:bg-[color:var(--color-border)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
    style={{ width: 28, height: 28, border: 'none', padding: 0, cursor: 'pointer' }}
  >
    <MoreHorizontal size={16} color="var(--color-text-secondary)" aria-hidden="true" />
  </button>
);

/**
 * MobileCard — a single task rendered as a vertical "field list" for the
 * <768px breakpoint, from the same slots as the desktop row. Each column slot
 * becomes a label + cell row, the status slot a "Status" row. The select and
 * trailing slots have no row of their own: a card needs no track alignment,
 * so the row's actions (open, ⋯) sit on the title row where a thumb finds them.
 */
const MobileCard = ({ task, ctx }) => {
  const on = issuedDayOf(task, ctx.ledgerCols);
  const title = ctx.rowTitle(task);
  const visible = ctx.slots.filter((s) => s.kind === 'column' || s.kind === 'status');
  return (
    <div
      style={{
        background: 'var(--color-bg-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-card)',
        padding: '4px 14px',
      }}
    >
      {visible.map((slot, idx) => {
        const isStatus = slot.kind === 'status';
        const col = slot.column;
        return (
          <div
            key={slot.key}
            className="flex items-center gap-3"
            style={{
              padding: '8px 0',
              minHeight: 40,
              borderBottom: idx === visible.length - 1 ? 'none' : '1px solid var(--color-border)',
            }}
          >
            <span
              className="font-body"
              style={{
                flex: '0 0 38%',
                fontSize: 11,
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                color: 'var(--color-text-secondary)',
              }}
            >
              {isStatus ? 'Status' : col.name}
              {!isStatus && col.isPrimary && (
                <span style={{ marginLeft: 4, opacity: 0.6 }} title="Primary column">*</span>
              )}
            </span>
            <div className="min-w-0 flex-1 flex items-stretch">
              {isStatus ? (
                <span className="inline-flex items-center">{ctx.statusChip(task, 'pill')}</span>
              ) : (
                ctx.renderCell(task, col, slot.primary, on)
              )}
            </div>
            {slot.primary && (ctx.onOpenRow || ctx.onRowMenu) && (
              <span className="shrink-0 inline-flex items-center gap-1">
                {ctx.onOpenRow && <OpenRowButton task={task} title={title} onOpen={ctx.onOpenRow} always />}
                {ctx.onRowMenu && <RowMenuButton task={task} title={title} onMenu={ctx.onRowMenu} />}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
};

/**
 * One desktop row: a cell per slot. Wrapped in a `display: contents` element so
 * the cells stay direct grid items (the track alignment above depends on it)
 * while the row still has ONE element to hover — which is what reveals the
 * open button anywhere along the row, not only over the title.
 */
const Row = ({ task, ri, ctx }) => {
  const stripe = ri % 2 === 1 ? 'var(--color-bg-subtle)' : 'transparent';
  const base = {
    borderBottom: '1px solid var(--color-border)',
    background: stripe,
    minHeight: 36,
    display: 'flex',
    alignItems: 'stretch',
  };
  const on = issuedDayOf(task, ctx.ledgerCols);
  const title = ctx.rowTitle(task);
  const pinned = isTaskPinned(task, ctx.personalPins);

  return (
    <div className="group/row" style={{ display: 'contents' }}>
      {ctx.slots.map((slot) => {
        if (slot.kind === 'status') {
          return (
            <div key={slot.key} style={base}>
              {ctx.statusChip(task, 'fill')}
            </div>
          );
        }
        if (slot.kind === 'trailing') {
          return (
            <div key={slot.key} style={{ ...base, alignItems: 'center', justifyContent: 'center' }}>
              {ctx.onRowMenu && <RowMenuButton task={task} title={title} onMenu={ctx.onRowMenu} />}
            </div>
          );
        }
        if (slot.kind !== 'column') return <div key={slot.key} style={base} />;

        const col = slot.column;
        return (
          <div key={slot.key} style={base}>
            {/* Pinned rows sit at the top of the group — say why, once, on the
                row's title. */}
            {slot.primary && pinned && (
              <span
                className="inline-flex items-center shrink-0"
                title="Pinned to the top of this group"
                style={{ color: 'var(--color-accent)', paddingLeft: 6 }}
              >
                <Pin size={12} fill="currentColor" aria-hidden="true" />
                <span className="sr-only">Pinned to top</span>
              </span>
            )}
            {/* Tracker boards: same marker the classic grid shows, in the
                same title slot, so a board's evidence reads identically
                whichever grid it happens to render through. */}
            {slot.primary && (
              <span className="inline-flex items-center shrink-0" style={{ paddingLeft: 6 }}>
                <GoalEvidenceMarker task={task} board={ctx.board} />
              </span>
            )}
            <div className="min-w-0 flex-1 flex items-stretch">
              {ctx.renderCell(task, col, slot.primary, on)}
            </div>
            {slot.primary && ctx.onOpenRow && (
              <OpenRowButton task={task} title={title} onOpen={ctx.onOpenRow} />
            )}
          </div>
        );
      })}
    </div>
  );
};

/** A column-menu command. Hover and focus paint a row, like every other menu. */
const MenuButton = ({ children, onClick, disabled = false, danger = false, title }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    title={title}
    className="block w-full text-left rounded transition-colors enabled:hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[color:var(--color-accent)]"
    style={{
      padding: '6px 10px',
      fontSize: 12,
      border: 'none',
      cursor: disabled ? 'not-allowed' : 'pointer',
      color: disabled
        ? 'var(--color-text-muted)'
        : danger
          ? 'var(--color-status-stuck, #DC2626)'
          : 'var(--color-text-primary)',
    }}
  >
    {children}
  </button>
);

/** A labelled select inside the column menu. */
const MenuSelect = ({ label, value, onChange, children }) => (
  <label style={{ display: 'block', padding: '6px 10px', fontSize: 12, cursor: 'default' }}>
    <span style={{ display: 'block', fontSize: 10, color: 'var(--color-text-muted)', marginBottom: 3 }}>
      {label}
    </span>
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{ width: '100%', fontSize: 12, padding: '3px 4px' }}
    >
      {children}
    </select>
  </label>
);

const headerCellStyle = {
  padding: '8px 10px',
  borderBottom: '1px solid var(--color-border)',
  background: 'var(--color-bg-subtle)',
  fontSize: 11,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  color: 'var(--color-text-secondary)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 4,
  minWidth: 0,
};

const footerCellStyle = {
  borderTop: '1px solid var(--color-border-strong)',
  background: 'var(--color-bg-subtle)',
};

export default DataGrid;
