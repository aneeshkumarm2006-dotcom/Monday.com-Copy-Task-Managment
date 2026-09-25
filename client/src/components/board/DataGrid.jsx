import { useMemo, useState } from 'react';
import { Plus, MoreHorizontal, Pin } from 'lucide-react';
import GoalEvidenceMarker from './GoalEvidenceMarker';
import { cellComponentFor } from './columns';
import AddColumnButton from './AddColumnButton';
import useBoardStore from '../../store/boardStore';
import useTaskStore from '../../store/taskStore';
import useToastStore from '../../store/toastStore';
import useOrgStore from '../../store/orgStore';
import { isTaskPinned } from '../../utils/taskPins';
import { computeSummary, summariesFor, summaryLabel } from '../../utils/columnSummary';
import { columnValue } from '../../utils/columnValues';
import { CURRENCIES } from '../../utils/numberFormat';
import useMoney from '../../hooks/useMoney';

/**
 * Column types whose values are numbers, and can therefore carry a display
 * format. `rating` is excluded on purpose — stars are not currency, and
 * offering the choice invites somebody to make them so.
 */
const NUMBER_FORMATTABLE = new Set(['number', 'formula', 'mirror']);

/**
 * DataGrid — generic grid driven by `board.columns` and a flat `tasks`
 * array. Replaces the fixed-column TaskTable for boards that have
 * `useFlexibleColumns: true`.
 *
 * Layout: CSS Grid with one column per `board.columns[i].width`. The header
 * row carries the column name + a chevron menu (rename / width / delete).
 * Each body row is a task; cells render via the cellComponentFor registry.
 *
 * Props:
 *   board        — current board doc (with `columns`)
 *   tasks        — array of tasks to render (already filtered to the right
 *                  group, and already sorted pinned-first by BoardDetailPage)
 *   personalPins — Set of task ids this user pinned privately
 *   readOnly     — disables every cell + hides the AddColumn button
 *
 * Note: this grid has no row action menu, so pinning can only be *shown* here,
 * not toggled. Pins are set from the fixed-column TaskTable.
 */
const DataGrid = ({ board, tasks = [], personalPins = null, readOnly = false }) => {
  const [headerMenu, setHeaderMenu] = useState(null); // { columnId, anchor }
  const [renamingId, setRenamingId] = useState(null);
  const [renameDraft, setRenameDraft] = useState('');
  const setColumnValue = useBoardStore((s) => s.setColumnValue);
  const updateColumn = useBoardStore((s) => s.updateColumn);
  // What a money column is born in. The workspace's currency, not a constant —
  // this used to be a hardcoded 'INR', which is why an agency billing in
  // dollars had to fix every money column by hand.
  const baseCurrency = useOrgStore((s) => s.currency?.baseCurrency) || 'INR';
  const money = useMoney();
  const deleteColumn = useBoardStore((s) => s.deleteColumn);
  const updateTaskLocal = useTaskStore((s) => s.updateTask);
  const toastError = useToastStore((s) => s.error);

  const columns = useMemo(
    () => (board?.columns || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0)),
    [board?.columns]
  );

  // Does any column ask for a summary? Checked once so an ordinary task board
  // — where none do — renders no footer row at all rather than a row of blanks.
  const hasSummaries = useMemo(
    () => columns.some((c) => c.settings?.summary && c.settings.summary !== 'none'),
    [columns]
  );

  // CSS grid template — last column is the "+ add column" cell.
  const gridTemplate = useMemo(() => {
    const colDefs = columns.map((c) => `${c.width || 160}px`);
    return [...colDefs, '40px'].join(' ');
  }, [columns]);

  const onCellChange = async (task, column, value) => {
    try {
      const updated = await setColumnValue(task._id, column._id, value);
      if (updated) updateTaskLocal(updated);
    } catch (err) {
      const message = err?.response?.data?.errors?.[0]?.message || err?.message || 'Update failed';
      toastError(message);
    }
  };

  // One shared reader, so the grid and the summaries under it can never
  // disagree about where a value lives — they did, and every footer read 0.
  const valueFor = (task, columnId) => columnValue(task, columnId) ?? null;

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
    setHeaderMenu(null);
  };

  if (columns.length === 0) {
    return (
      <div style={{ padding: 24, textAlign: 'center', color: 'var(--color-text-muted)' }}>
        No columns yet. {!readOnly && <AddColumnButton boardId={board._id} board={board} />}
      </div>
    );
  }

  return (
    <>
    {/* Desktop / tablet (≥768px): the scrollable spreadsheet grid (unchanged). */}
    <div className="hidden md:block" style={{ width: '100%', overflowX: 'auto' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: gridTemplate,
          minWidth: 'fit-content',
        }}
      >
        {/* Header row */}
        {columns.map((col) => (
          <div
            key={col._id}
            style={{
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
              position: 'relative',
            }}
          >
            {renamingId === col._id ? (
              <input
                value={renameDraft}
                autoFocus
                onChange={(e) => setRenameDraft(e.target.value)}
                onBlur={() => handleRenameCommit(col._id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleRenameCommit(col._id);
                  if (e.key === 'Escape') setRenamingId(null);
                }}
                style={{
                  flex: 1,
                  background: 'transparent',
                  border: '1px solid var(--color-accent)',
                  padding: '2px 4px',
                  fontSize: 11,
                  fontWeight: 600,
                  color: 'var(--color-text-primary)',
                }}
              />
            ) : (
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {col.name}
                {col.isPrimary && (
                  <span style={{ marginLeft: 4, opacity: 0.6 }} title="Primary column">
                    *
                  </span>
                )}
              </span>
            )}
            {!readOnly && (
              <button
                type="button"
                onClick={(e) =>
                  setHeaderMenu(
                    headerMenu?.columnId === col._id
                      ? null
                      : { columnId: col._id, anchor: e.currentTarget }
                  )
                }
                style={{
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  padding: 2,
                  color: 'var(--color-text-muted)',
                }}
                aria-label={`Column actions for ${col.name}`}
              >
                <MoreHorizontal size={12} />
              </button>
            )}
            {headerMenu?.columnId === col._id && (
              <div
                style={{
                  position: 'absolute',
                  top: '100%',
                  right: 0,
                  zIndex: 30,
                  background: 'var(--color-bg-elevated)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-md)',
                  boxShadow: 'var(--shadow-md)',
                  padding: 4,
                  minWidth: 168,
                }}
                onMouseLeave={() => setHeaderMenu(null)}
              >
                <button
                  type="button"
                  style={menuItemStyle}
                  onClick={() => {
                    setRenamingId(col._id);
                    setRenameDraft(col.name);
                    setHeaderMenu(null);
                  }}
                >
                  Rename
                </button>
                <button
                  type="button"
                  style={menuItemStyle}
                  onClick={() => {
                    const w = Number(window.prompt('Column width in px', String(col.width || 160)));
                    if (Number.isFinite(w) && w >= 40 && w <= 1000) {
                      updateColumn(board._id, col._id, { width: w }).catch((err) =>
                        toastError(err?.response?.data?.error || 'Width update failed')
                      );
                    }
                    setHeaderMenu(null);
                  }}
                >
                  Change width
                </button>
                {/* Format — number-ish columns only. The stored value stays a
                    plain number; this only decides what it looks like, which
                    is why it lives in settings rather than changing the type. */}
                {NUMBER_FORMATTABLE.has(col.type) && (
                  <label style={{ ...menuItemStyle, display: 'block', cursor: 'default' }}>
                    <span style={{ display: 'block', fontSize: 10, color: 'var(--color-text-muted)', marginBottom: 3 }}>
                      Format
                    </span>
                    <select
                      value={col.settings?.format || 'plain'}
                      onChange={(e) => {
                        const format = e.target.value;
                        updateColumn(board._id, col._id, {
                          settings: {
                            ...(col.settings || {}),
                            format,
                            // Pin a currency the first time one is chosen, so
                            // the cell does not render in whatever the list
                            // happens to have first. The workspace's own
                            // currency, because that is what a column on a
                            // board in this workspace is overwhelmingly likely
                            // to hold.
                            ...(format === 'currency' && !col.settings?.currency
                              ? { currency: baseCurrency }
                              : {}),
                          },
                        }).catch((err) =>
                          toastError(err?.response?.data?.error || 'Could not change the format')
                        );
                        setHeaderMenu(null);
                      }}
                      style={{ width: '100%', fontSize: 12, padding: '3px 4px' }}
                    >
                      <option value="plain">Plain number</option>
                      <option value="currency">Currency</option>
                      <option value="percent">Percent</option>
                    </select>
                  </label>
                )}

                {NUMBER_FORMATTABLE.has(col.type) && col.settings?.format === 'currency' && (
                  <label style={{ ...menuItemStyle, display: 'block', cursor: 'default' }}>
                    <span style={{ display: 'block', fontSize: 10, color: 'var(--color-text-muted)', marginBottom: 3 }}>
                      Currency
                    </span>
                    <select
                      value={col.settings?.currency || baseCurrency}
                      onChange={(e) => {
                        updateColumn(board._id, col._id, {
                          settings: { ...(col.settings || {}), currency: e.target.value },
                        }).catch((err) =>
                          toastError(err?.response?.data?.error || 'Could not change the currency')
                        );
                        setHeaderMenu(null);
                      }}
                      style={{ width: '100%', fontSize: 12, padding: '3px 4px' }}
                    >
                      {CURRENCIES.map((c) => (
                        <option key={c.code} value={c.code}>
                          {c.symbol} {c.code}
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                {/* Summary — what the footer under this column adds up to. The
                    options depend on the type: you can sum a number and count a
                    checkbox, and offering the wrong one is offering a footer
                    that reads NaN. */}
                <label style={{ ...menuItemStyle, display: 'block', cursor: 'default' }}>
                  <span style={{ display: 'block', fontSize: 10, color: 'var(--color-text-muted)', marginBottom: 3 }}>
                    Summary
                  </span>
                  <select
                    value={col.settings?.summary || 'none'}
                    onChange={(e) => {
                      updateColumn(board._id, col._id, {
                        settings: { ...(col.settings || {}), summary: e.target.value },
                      }).catch((err) =>
                        toastError(err?.response?.data?.error || 'Could not change the summary')
                      );
                      setHeaderMenu(null);
                    }}
                    style={{ width: '100%', fontSize: 12, padding: '3px 4px' }}
                  >
                    {summariesFor(col.type).map((sum) => (
                      <option key={sum.key} value={sum.key}>
                        {sum.label}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  disabled={col.isPrimary}
                  style={{
                    ...menuItemStyle,
                    color: col.isPrimary ? 'var(--color-text-muted)' : '#DC2626',
                    cursor: col.isPrimary ? 'not-allowed' : 'pointer',
                  }}
                  onClick={() => handleDelete(col)}
                >
                  Delete
                </button>
              </div>
            )}
          </div>
        ))}
        {/* Add-column anchor at the end of the header row */}
        <div
          style={{
            padding: '4px 6px',
            borderBottom: '1px solid var(--color-border)',
            background: 'var(--color-bg-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {!readOnly && <AddColumnButton boardId={board._id} board={board} />}
        </div>

        {/* Body rows */}
        {tasks.map((task, ri) => (
          <Row
            key={task._id}
            columns={columns}
            task={task}
            ri={ri}
            onChange={onCellChange}
            valueFor={valueFor}
            readOnly={readOnly}
            pinned={isTaskPinned(task, personalPins)}
            board={board}
          />
        ))}
        {tasks.length === 0 && (
          <div
            style={{
              gridColumn: `1 / span ${columns.length + 1}`,
              padding: '24px 12px',
              color: 'var(--color-text-muted)',
              fontSize: 13,
              textAlign: 'center',
            }}
          >
            No tasks yet.
          </div>
        )}

        {/* Summary row — the number under a column, per group.
            Rendered only when at least one column asks for one, so an ordinary
            task board grows no extra row. It is part of the same CSS grid as
            the rows above so the cells line up with their columns without a
            second width calculation to keep in step. */}
        {hasSummaries && tasks.length > 0 && (
          <>
            {columns.map((col) => {
              const result = computeSummary(tasks, col);
              const label = summaryLabel(tasks, col);
              return (
                <div
                  key={`sum-${col._id}`}
                  style={{
                    padding: '6px 10px',
                    borderTop: '1px solid var(--color-border-strong)',
                    background: 'var(--color-bg-subtle)',
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
                        {/* `raw` counts (filled / empty / checked) are counts of
                            ROWS, not values in the column's own unit — running
                            them through the currency formatter would print
                            "₹3" for three receipts. */}
                        {result.raw
                          ? result.value.toLocaleString()
                          : money.column(result.value, col.settings)}
                      </span>
                    </>
                  )}
                </div>
              );
            })}
            <div
              style={{
                borderTop: '1px solid var(--color-border-strong)',
                background: 'var(--color-bg-subtle)',
              }}
            />
          </>
        )}
      </div>
    </div>

    {/* Mobile (<768px): the spreadsheet grid can't fit, so each task becomes a
        stacked card with one "column name → cell" row per column. Reuses the
        exact same cell renderers as the grid. */}
    <div className="md:hidden flex flex-col gap-3">
      {tasks.length === 0 ? (
        <div
          style={{
            padding: '24px 12px',
            color: 'var(--color-text-muted)',
            fontSize: 13,
            textAlign: 'center',
          }}
        >
          No tasks yet.
        </div>
      ) : (
        tasks.map((task) => (
          <MobileCard
            key={task._id}
            columns={columns}
            task={task}
            valueFor={valueFor}
            onChange={onCellChange}
            readOnly={readOnly}
          />
        ))
      )}
      {!readOnly && (
        <div className="flex items-center gap-2 pt-1">
          <AddColumnButton boardId={board._id} board={board} />
          <span className="font-body" style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
            Add column
          </span>
        </div>
      )}
    </div>
    </>
  );
};

/**
 * MobileCard — a single task rendered as a vertical "field list" for the
 * <768px breakpoint. Each column becomes a label + cell row; the cell is the
 * same component used in the desktop grid so editing behaves identically.
 */
const MobileCard = ({ columns, task, valueFor, onChange, readOnly }) => (
  <div
    style={{
      background: 'var(--color-bg-surface)',
      border: '1px solid var(--color-border)',
      borderRadius: 'var(--radius-md)',
      boxShadow: 'var(--shadow-card)',
      padding: '4px 14px',
    }}
  >
    {columns.map((col, idx) => {
      const Cell = cellComponentFor(col.type);
      const value =
        col.key === 'lead_name'
          ? (task.name || valueFor(task, col._id))
          : valueFor(task, col._id);
      return (
        <div
          key={col._id}
          className="flex items-center gap-3"
          style={{
            padding: '8px 0',
            minHeight: 40,
            borderBottom:
              idx === columns.length - 1
                ? 'none'
                : '1px solid var(--color-border)',
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
            {col.name}
            {col.isPrimary && (
              <span style={{ marginLeft: 4, opacity: 0.6 }} title="Primary column">*</span>
            )}
          </span>
          <div className="min-w-0 flex-1 flex items-stretch">
            <Cell
              value={value}
              column={col}
              task={task}
              readOnly={readOnly || col.type === 'formula'}
              onChange={(v) => onChange(task, col, v)}
            />
          </div>
        </div>
      );
    })}
  </div>
);

const Row = ({ columns, task, ri, onChange, valueFor, readOnly, pinned = false, board = null }) => {
  const stripe = ri % 2 === 1 ? 'var(--color-bg-subtle)' : 'transparent';
  return (
    <>
      {columns.map((col, ci) => {
        const Cell = cellComponentFor(col.type);
        const value = col.key === 'lead_name' ? (task.name || valueFor(task, col._id)) : valueFor(task, col._id);
        return (
          <div
            key={col._id}
            style={{
              borderBottom: '1px solid var(--color-border)',
              background: stripe,
              minHeight: 36,
              display: 'flex',
              alignItems: 'stretch',
            }}
          >
            {/* Pinned rows sit at the top of the group — say why, once, in the
                first column. This grid has no row menu, so it's display-only. */}
            {ci === 0 && pinned && (
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
            same first-column slot, so a board's evidence reads identically
            whichever grid it happens to render through. */}
            {ci === 0 && (
              <span className="inline-flex items-center shrink-0" style={{ paddingLeft: 6 }}>
                <GoalEvidenceMarker task={task} board={board} />
              </span>
            )}
            <Cell
              value={value}
              column={col}
              task={task}
              readOnly={readOnly || col.type === 'formula'}
              onChange={(v) => onChange(task, col, v)}
            />
          </div>
        );
      })}
      <div
        style={{
          borderBottom: '1px solid var(--color-border)',
          background: stripe,
        }}
      />
    </>
  );
};

const menuItemStyle = {
  display: 'block',
  width: '100%',
  padding: '6px 10px',
  fontSize: 12,
  textAlign: 'left',
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  color: 'var(--color-text-primary)',
  borderRadius: 'var(--radius-sm)',
};

export default DataGrid;
