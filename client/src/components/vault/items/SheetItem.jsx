import { Plus, Trash2 } from 'lucide-react';
import Input from '../../ui/Input';

/**
 * Sheet — a small grid, for the secrets that are naturally tabular: a set of
 * per-environment API keys, a list of server logins, licence keys by seat.
 *
 * Deliberately not a spreadsheet. No formulas, no types, no sorting, no
 * resizing — every cell is a string. The purpose is to keep twelve related
 * secrets in one encrypted item instead of twelve, and any of those features
 * would be work spent on the part nobody came here for.
 *
 * The whole grid is one payload, so it is one AES-GCM seal. That is why editing
 * a cell rewrites the entire item, and why the grid stays small by design.
 */

const MAX_COLS = 12;
const MAX_ROWS = 200;

/** Pad or trim a row so it matches the column count. */
const fitRow = (row, width) => {
  const out = Array.from({ length: width }, (_, i) => row?.[i] ?? '');
  return out;
};

/** Rows can drift from the header if a payload was written by an older shape. */
const normalise = (payload) => {
  const columns = Array.isArray(payload?.columns) && payload.columns.length
    ? payload.columns
    : ['Name', 'Value'];
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  return { columns, rows: rows.map((r) => fitRow(r, columns.length)) };
};

const cellStyle = {
  border: '1px solid var(--color-border)',
  padding: '6px 8px',
  fontSize: 13,
  verticalAlign: 'top',
};

export const SheetViewer = ({ payload }) => {
  const { columns, rows } = normalise(payload);

  if (rows.length === 0) {
    return (
      <p className="font-body text-sm text-[color:var(--color-text-muted)] italic">
        This sheet has no rows yet.
      </p>
    );
  }

  return (
    // Wide grids scroll inside their own box rather than pushing the panel out.
    <div className="overflow-x-auto" style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)' }}>
      <table className="w-full font-body" style={{ borderCollapse: 'collapse', minWidth: 320 }}>
        <thead>
          <tr>
            {columns.map((col, i) => (
              <th
                key={i}
                scope="col"
                className="text-left font-medium text-[color:var(--color-text-secondary)]"
                style={{ ...cellStyle, background: 'var(--color-bg-subtle)', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.03em' }}
              >
                {col || `Column ${i + 1}`}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) => (
                <td
                  key={c}
                  className="text-[color:var(--color-text-primary)]"
                  style={{
                    ...cellStyle,
                    // Values in a grid are usually keys and hostnames, where
                    // character-level legibility beats prettiness.
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                  }}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export const SheetEditor = ({ payload, onChange }) => {
  const { columns, rows } = normalise(payload);

  const patch = (next) => onChange((prev) => ({ ...prev, ...next }));

  const setCell = (r, c, value) => {
    const next = rows.map((row, i) => (i === r ? row.map((cell, j) => (j === c ? value : cell)) : row));
    patch({ rows: next });
  };

  const setColumn = (c, value) => {
    patch({ columns: columns.map((col, i) => (i === c ? value : col)) });
  };

  const addColumn = () => {
    if (columns.length >= MAX_COLS) return;
    patch({
      columns: [...columns, `Column ${columns.length + 1}`],
      rows: rows.map((r) => [...r, '']),
    });
  };

  const removeColumn = (c) => {
    // Never leave a grid with no columns — there would be nothing to click to
    // get one back.
    if (columns.length <= 1) return;
    patch({
      columns: columns.filter((_, i) => i !== c),
      rows: rows.map((r) => r.filter((_, i) => i !== c)),
    });
  };

  const addRow = () => {
    if (rows.length >= MAX_ROWS) return;
    patch({ rows: [...rows, Array(columns.length).fill('')] });
  };

  const removeRow = (r) => patch({ rows: rows.filter((_, i) => i !== r) });

  return (
    <div className="flex flex-col gap-4">
      <Input
        label="Title"
        value={payload.title}
        onChange={(e) => patch({ title: e.target.value })}
        placeholder="Production API keys by environment"
        required
        autoFocus
      />

      <div>
        <span className="block mb-2 font-body font-medium text-[color:var(--color-text-secondary)] text-xs uppercase tracking-wide">
          Grid
        </span>

        <div className="overflow-x-auto" style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)' }}>
          <table className="w-full font-body" style={{ borderCollapse: 'collapse', minWidth: 320 }}>
            <thead>
              <tr>
                {columns.map((col, c) => (
                  <th key={c} style={{ ...cellStyle, background: 'var(--color-bg-subtle)', padding: 4 }}>
                    <div className="flex items-center gap-1">
                      <input
                        value={col}
                        onChange={(e) => setColumn(c, e.target.value)}
                        aria-label={`Column ${c + 1} name`}
                        className="w-full font-body font-medium text-[12px] bg-transparent focus:outline-none text-[color:var(--color-text-secondary)]"
                        style={{ padding: '4px 4px' }}
                      />
                      {columns.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removeColumn(c)}
                          aria-label={`Delete column ${col || c + 1}`}
                          className="shrink-0 rounded hover:bg-[color:var(--color-bg-subtle)]"
                          style={{ padding: 2, color: 'var(--color-text-muted)' }}
                        >
                          <Trash2 size={12} />
                        </button>
                      )}
                    </div>
                  </th>
                ))}
                <th style={{ ...cellStyle, background: 'var(--color-bg-subtle)', width: 34, padding: 4 }}>
                  <button
                    type="button"
                    onClick={addColumn}
                    disabled={columns.length >= MAX_COLS}
                    aria-label="Add column"
                    title="Add column"
                    className="rounded hover:bg-[color:var(--color-bg-subtle)] disabled:opacity-40"
                    style={{ padding: 4, color: 'var(--color-text-secondary)' }}
                  >
                    <Plus size={14} />
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c} style={{ ...cellStyle, padding: 0 }}>
                      <input
                        value={cell}
                        onChange={(e) => setCell(r, c, e.target.value)}
                        aria-label={`${columns[c] || `Column ${c + 1}`}, row ${r + 1}`}
                        spellCheck={false}
                        autoComplete="off"
                        className="w-full bg-transparent focus:outline-none focus:bg-white text-[color:var(--color-text-primary)]"
                        style={{
                          padding: '7px 8px',
                          fontSize: 13,
                          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                          minWidth: 120,
                        }}
                      />
                    </td>
                  ))}
                  <td style={{ ...cellStyle, padding: 4, textAlign: 'center' }}>
                    <button
                      type="button"
                      onClick={() => removeRow(r)}
                      aria-label={`Delete row ${r + 1}`}
                      className="rounded hover:bg-[color:var(--color-bg-subtle)]"
                      style={{ padding: 4, color: 'var(--color-text-muted)' }}
                    >
                      <Trash2 size={12} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <button
          type="button"
          onClick={addRow}
          disabled={rows.length >= MAX_ROWS}
          className="mt-2 inline-flex items-center gap-1.5 font-body text-[13px] font-medium disabled:opacity-40"
          style={{ color: 'var(--color-accent)' }}
        >
          <Plus size={14} /> Add row
        </button>
      </div>
    </div>
  );
};
