import { useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { cellComponentFor, TextCell } from './columns';
import { cellWrapperStyle } from './columns/cellShared';
import useBoardStore from '../../store/boardStore';
import useTaskStore from '../../store/taskStore';
import useToastStore from '../../store/toastStore';
import useMoney from '../../hooks/useMoney';
import { columnValue } from '../../utils/columnValues';
import { boardCurrencyOf } from '../../utils/money';
import { paymentsOf, paymentsTotal } from '../../utils/payments';

/**
 * ColumnFieldList — one task's flexible-column values as a labelled field list.
 *
 * The row of a DataGrid turned on its side: every board column becomes a
 * "label | cell" pair, and the cell is the SAME component the grid renders
 * (`cellComponentFor`), so a value reads and edits identically in the table,
 * on a phone card and in the task panel. Written for the task panel on a
 * flexible board — where an invoice's Amount, Due, Owner and PDF used to be
 * invisible — but it knows nothing about invoices and can sit anywhere a task
 * and its board are in hand.
 *
 * WRITES GO CELL BY CELL, THROUGH `setColumnValue`.
 * Not through the panel's `onUpdateTask`: that path patches optimistically with
 * `{ ...prev, ...payload }`, and a payload of `{ columnValues: { [one]: v } }`
 * REPLACES the whole map — every other field on the row would blank until the
 * server answered. `setColumnValue` returns the server's populated task, and
 * `onPatched` hands it to whoever owns the row (the board page's task store).
 *
 * Props:
 *   board         the board doc (its `columns` are the source, and every cell
 *                 gets them too — a formula needs its siblings to compute)
 *   task          the task being shown
 *   columns       optional explicit column list, in place of `board.columns`
 *   readOnly      every cell read-only (formula and mirror always are)
 *   onPatched     (updatedTask) => void, after a successful write; defaults to
 *                 the task store's `updateTask`
 *   exclude       column ids / keys to skip, or a predicate (col) => boolean.
 *                 The primary column is always skipped: it IS the task name,
 *                 which the panel already shows as its title.
 *   on            the record's day for currency conversion ('YYYY-MM-DD') —
 *                 pass the ledger's issued day so the panel and tile agree
 *   collapseAfter show this many fields, then a "Show N more" toggle. Null
 *                 shows everything.
 *   canManage     the viewer holds `column.manage` — handed to every cell, so an
 *                 unconfigured Connect column offers them "Set up" here as it
 *                 does in the Table, rather than "Not connected".
 */

/** Types that are computed, never typed. */
const COMPUTED = new Set(['formula', 'mirror']);

/**
 * Types whose cell draws a meaningful picture of "nothing" (an unticked box,
 * zero stars, an empty link picker), so a read-only empty value still renders
 * the cell rather than the dash.
 */
const DRAWS_ITS_OWN_EMPTY = new Set(['checkbox', 'rating', 'connect_boards', 'formula', 'mirror']);

const isBlank = (v) =>
  v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

const Dash = () => (
  <div style={{ ...cellWrapperStyle, color: 'var(--color-text-muted)' }}>—</div>
);

/**
 * A payments column before the client has a cell for it: the receipts' total,
 * read-only. Without this the registry's TextCell fallback would be handed an
 * array of objects and take the whole panel down with it.
 */
const PaymentsSummary = ({ value, column, on, currency }) => {
  const money = useMoney();
  const list = paymentsOf(value);
  if (list.length === 0) return <Dash />;
  return (
    <div style={{ ...cellWrapperStyle, gap: 6 }}>
      <span>{money.column(paymentsTotal(value), column?.settings, on, currency)}</span>
      <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
        · {list.length} {list.length === 1 ? 'payment' : 'payments'}
      </span>
    </div>
  );
};

/**
 * Any other type the registry does not know yet. A scalar prints as itself;
 * anything structured prints a dash rather than "[object Object]".
 */
const UnknownValue = ({ value }) => {
  if (typeof value === 'string' || typeof value === 'number') {
    return (
      <div style={cellWrapperStyle}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {String(value)}
        </span>
      </div>
    );
  }
  return <Dash />;
};

const ColumnFieldList = ({
  board,
  task,
  columns = null,
  readOnly = false,
  onPatched = null,
  exclude = null,
  on = null,
  collapseAfter = null,
  canManage = false,
}) => {
  const money = useMoney();
  // `${taskId}:${columnId}` of the writes in flight. Keyed by task too, so a
  // save still running when the panel moves to another row cannot dim a field
  // on the new one.
  const [saving, setSaving] = useState(() => new Set());
  const [expanded, setExpanded] = useState(false);

  const boardColumns = board?.columns;
  const fields = useMemo(() => {
    const source = Array.isArray(columns)
      ? columns
      : Array.isArray(boardColumns)
        ? boardColumns
        : [];
    const skip =
      typeof exclude === 'function'
        ? exclude
        : (col) =>
            Array.isArray(exclude) &&
            exclude.some(
              (x) => x !== null && x !== undefined && (String(x) === String(col._id) || x === col.key)
            );
    return source
      .filter((c) => c && !c.isPrimary && !skip(c))
      .slice()
      .sort((a, b) => (a.order || 0) - (b.order || 0));
  }, [columns, boardColumns, exclude]);

  // The unit a money column with no code of its own is in: the board's, then
  // the workspace's. Same chain the grid and the ledger resolve.
  const currency = boardCurrencyOf(board, money.baseCurrency);
  const taskId = task?._id || null;

  if (!task || fields.length === 0) return null;

  const handleChange = async (col, value) => {
    if (readOnly || !taskId) return;
    const key = `${taskId}:${col._id}`;
    setSaving((s) => new Set(s).add(key));
    try {
      const updated = await useBoardStore.getState().setColumnValue(taskId, col._id, value);
      if (updated) {
        if (onPatched) onPatched(updated);
        else useTaskStore.getState().updateTask(updated);
      }
    } catch (err) {
      const data = err?.response?.data;
      useToastStore
        .getState()
        .error(
          data?.error ||
            data?.errors?.[0]?.message ||
            `Couldn’t save ${col.name || 'that field'}. Please try again.`
        );
    } finally {
      setSaving((s) => {
        const next = new Set(s);
        next.delete(key);
        return next;
      });
    }
  };

  // Collapse only when it hides at least two fields — "Show 1 more field" is a
  // click that costs more than the row it saves.
  const limit =
    Number.isInteger(collapseAfter) && collapseAfter > 0 && fields.length > collapseAfter + 1
      ? collapseAfter
      : null;
  const visible = limit && !expanded ? fields.slice(0, limit) : fields;

  /**
   * Escape inside a field's editor cancels THAT edit, and stops there.
   *
   * The cells cancel on Escape, but they do not stop the key — and the task
   * panel closes on any Escape that reaches `document`. So backing out of a
   * half-typed amount would also throw away the whole panel. React dispatches
   * from the root container, which the native event reaches BEFORE document,
   * so stopping it here is enough. Only for text-entry targets: Escape with
   * nothing being edited still closes the panel as it always has.
   */
  const keepEscapeInEditor = (e) => {
    if (e.key !== 'Escape') return;
    const t = e.target;
    const tag = t?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) {
      e.stopPropagation();
    }
  };

  return (
    <div className="flex flex-col gap-1.5" onKeyDown={keepEscapeInEditor}>
      <dl className="flex flex-col gap-1.5" style={{ margin: 0 }}>
        {visible.map((col) => {
          const Cell = cellComponentFor(col.type);
          // The registry falls back to TextCell for a type it has not shipped;
          // that cell renders its value as text, which for an array of objects
          // is a crash, so an unknown type gets a read-only rendering instead.
          const known = Cell !== TextCell || col.type === 'text';
          const cellReadOnly = readOnly || COMPUTED.has(col.type) || !known;
          const value = columnValue(task, col) ?? null;
          const busy = saving.has(`${taskId}:${col._id}`);
          const editable = !cellReadOnly;

          let body;
          if (!known) {
            body =
              col.type === 'payments' ? (
                <PaymentsSummary value={value} column={col} on={on} currency={currency} />
              ) : (
                <UnknownValue value={value} />
              );
          } else if (cellReadOnly && isBlank(value) && !DRAWS_ITS_OWN_EMPTY.has(col.type)) {
            // A read-only empty text/date/number cell renders nothing at all,
            // which in a form reads as a broken row rather than "not set".
            body = <Dash />;
          } else {
            body = (
              <Cell
                value={value}
                column={col}
                task={task}
                columns={boardColumns}
                currency={currency}
                on={on}
                readOnly={cellReadOnly}
                canManage={canManage}
                onChange={(v) => handleChange(col, v)}
              />
            );
          }

          return (
            <div
              key={col._id}
              className="flex flex-col gap-0.5 sm:flex-row sm:items-start sm:gap-3"
            >
              <dt
                className="font-body truncate sm:w-[120px] sm:shrink-0 sm:pt-2"
                title={col.name}
                style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-text-muted)' }}
              >
                {col.name}
              </dt>
              <dd
                aria-busy={busy || undefined}
                className={[
                  'min-w-0 w-full sm:flex-1 sm:max-w-[320px] flex items-stretch transition-colors duration-150',
                  // An editable field looks like one — a filled input box —
                  // because the cells themselves are bare until clicked, and an
                  // empty bare cell is invisible. The border steps aside while
                  // the cell's own focused input draws its accent outline.
                  editable
                    ? 'border border-[color:var(--color-border)] bg-[color:var(--color-bg-input)] hover:border-[color:var(--color-border-strong)] focus-within:border-transparent'
                    : '',
                ].join(' ')}
                style={{
                  margin: 0,
                  position: 'relative',
                  borderRadius: 'var(--radius-sm)',
                  opacity: busy ? 0.6 : 1,
                }}
              >
                {body}
              </dd>
            </div>
          );
        })}
      </dl>

      {limit && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="self-start inline-flex items-center gap-1 font-body transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
          style={{
            padding: '3px 6px',
            margin: '0 -6px',
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--color-accent)',
            background: 'transparent',
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            cursor: 'pointer',
          }}
        >
          {expanded
            ? 'Show fewer fields'
            : `Show ${fields.length - limit} more ${fields.length - limit === 1 ? 'field' : 'fields'}`}
          <ChevronDown
            size={13}
            aria-hidden="true"
            style={{
              transform: expanded ? 'rotate(180deg)' : 'none',
              transition: 'transform 150ms ease',
            }}
          />
        </button>
      )}
    </div>
  );
};

export default ColumnFieldList;
