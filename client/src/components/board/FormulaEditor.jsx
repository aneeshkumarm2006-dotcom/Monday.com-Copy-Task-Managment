import { useId, useRef, useState } from 'react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import useBoardStore from '../../store/boardStore';
import useToastStore from '../../store/toastStore';
import useMoney from '../../hooks/useMoney';
import { currencyOptions } from '../../utils/money';
import { formulaValue } from '../../utils/columnValues';
import {
  DECIMAL_CHOICES,
  checkFormula,
  formulaDraftOf,
  formulaInputColumns,
  formulaSettingsFrom,
} from '../../utils/dataGrid';

/**
 * FORMULA EDITOR — where a formula column's expression is written.
 *
 * Before this there was nowhere to write one. A formula column could be
 * created from the column picker, but it was sent with no expression, the
 * server refused it, and a Budget board's seeded "Remaining" could never be
 * changed. The obvious billing extension — Balance = Amount − Paid — was
 * impossible.
 *
 * The grammar is the server's (`utils/formula.js` is its client copy):
 * `column.<key>` references, numbers, `+ - * /` and parentheses. Nobody should
 * have to know a column's key, so every column a formula may read is offered
 * as a chip that inserts its reference at the cursor; the check below says
 * what is wrong in the server's own words as the person types; and a preview
 * computes the formula against the first row, so "does this do what I meant"
 * is answered before saving rather than after.
 *
 * `FormulaEditor` is the fields (controlled) — the Add Column flow wraps it
 * with a name. `FormulaEditorModal` is "Edit formula…" from the column menu.
 *
 * Value: { expression, format: 'plain'|'currency'|'percent', currency,
 *          decimals: 'auto'|'0'|'2' }
 */

const OPERATORS = [
  { token: ' + ', label: '+', name: 'plus' },
  { token: ' - ', label: '−', name: 'minus' },
  { token: ' * ', label: '×', name: 'times' },
  { token: ' / ', label: '÷', name: 'divided by' },
  { token: '(', label: '(', name: 'open bracket' },
  { token: ')', label: ')', name: 'close bracket' },
];

const labelStyle = { display: 'block', fontSize: 11, color: 'var(--color-text-muted)', marginBottom: 4 };

const controlStyle = {
  width: '100%',
  padding: '6px 8px',
  fontSize: 13,
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--color-bg-input, var(--color-bg-surface))',
  color: 'var(--color-text-primary)',
};

const chipStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '2px 8px',
  fontSize: 12,
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-full)',
  background: 'var(--color-bg-subtle)',
  color: 'var(--color-text-primary)',
  cursor: 'pointer',
  maxWidth: '100%',
};

const FormulaEditor = ({
  columns,
  selfKey = null,
  sampleTask = null,
  value,
  onChange,
  boardCurrency = null,
  disabled = false,
  autoFocus = false,
}) => {
  const money = useMoney();
  const textRef = useRef(null);
  const hintId = useId();
  const errorId = useId();
  const v = value || { expression: '', format: 'plain', currency: '', decimals: 'auto' };
  const inputs = formulaInputColumns(columns, selfKey);
  const expression = v.expression || '';
  const check = checkFormula(expression, columns, selfKey);
  const showError = expression.trim() !== '' && check.error;

  const set = (patch) => onChange?.({ ...v, ...patch });

  /** Insert `token` at the caret (or over the selection), and put the caret after it. */
  const insert = (token) => {
    const el = textRef.current;
    const start = el ? el.selectionStart ?? expression.length : expression.length;
    const end = el ? el.selectionEnd ?? expression.length : expression.length;
    const next = expression.slice(0, start) + token + expression.slice(end);
    set({ expression: next });
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      const caret = start + token.length;
      el.setSelectionRange(caret, caret);
    });
  };

  // The preview: the formula as it would compute on the first row, through the
  // same evaluator and the same formatter the cell will use.
  const settings = formulaSettingsFrom({}, v);
  let preview = null;
  if (check.ok && sampleTask) {
    const probe = { _id: '__formula_preview', key: selfKey || '__formula_preview', type: 'formula', settings };
    const result = formulaValue(sampleTask, probe, columns);
    const missing = (check.refs || [])
      .map((k) => inputs.find((c) => c.key === k))
      .filter(Boolean)
      .map((c) => c.name);
    preview =
      result === null
        ? `Empty on the first row — it needs a value in ${missing.join(', ') || 'every column it uses'}.`
        : `First row${sampleTask.name ? ` (${sampleTask.name})` : ''}: ${money.column(result, settings, null, boardCurrency)}`;
  }

  return (
    <div>
      <label style={labelStyle} htmlFor={`${hintId}-expr`}>
        Formula
      </label>
      <textarea
        id={`${hintId}-expr`}
        ref={textRef}
        rows={2}
        value={expression}
        onChange={(e) => set({ expression: e.target.value })}
        disabled={disabled}
        spellCheck={false}
        autoFocus={autoFocus}
        maxLength={500}
        placeholder="column.amount - column.paid"
        aria-describedby={`${hintId} ${showError ? errorId : ''}`.trim()}
        aria-invalid={showError ? true : undefined}
        style={{
          ...controlStyle,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontSize: 12,
          resize: 'vertical',
          marginBottom: 6,
          borderColor: showError ? 'var(--color-status-stuck)' : 'var(--color-border)',
        }}
      />

      {inputs.length > 0 ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }} aria-label="Insert a column">
          {inputs.map((c) => (
            <button
              key={c._id || c.key}
              type="button"
              disabled={disabled}
              onClick={() => insert(`column.${c.key}`)}
              title={`Insert column.${c.key}`}
              aria-label={`Insert ${c.name}`}
              className="hover:bg-[color:var(--color-accent-light)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--color-accent)]"
              style={chipStyle}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
            </button>
          ))}
        </div>
      ) : (
        <p style={{ margin: '0 0 6px', fontSize: 12, color: 'var(--color-text-muted)' }}>
          Add a Number or Payments column first — a formula adds up other number columns.
        </p>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
        {OPERATORS.map((op) => (
          <button
            key={op.name}
            type="button"
            disabled={disabled}
            onClick={() => insert(op.token)}
            aria-label={`Insert ${op.name}`}
            className="hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--color-accent)]"
            style={{ ...chipStyle, background: 'transparent', minWidth: 26, justifyContent: 'center', fontWeight: 600 }}
          >
            {op.label}
          </button>
        ))}
      </div>
      <p id={hintId} style={{ margin: '0 0 8px', fontSize: 11, color: 'var(--color-text-muted)' }}>
        Numbers, + − × ÷ and brackets. A row with an empty input shows no result.
      </p>

      {showError && (
        <p id={errorId} role="alert" style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--color-status-stuck)' }}>
          {check.error}
        </p>
      )}
      {preview && (
        <p
          aria-live="polite"
          style={{
            margin: '0 0 10px',
            padding: '6px 8px',
            fontSize: 12,
            borderRadius: 'var(--radius-sm)',
            background: 'var(--color-bg-subtle)',
            color: 'var(--color-text-secondary)',
          }}
        >
          {preview}
        </p>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: v.format === 'currency' ? '1fr 1fr' : '1fr', gap: 8 }}>
        <label style={{ minWidth: 0 }}>
          <span style={labelStyle}>Show as</span>
          <select
            value={v.format || 'plain'}
            disabled={disabled}
            onChange={(e) => {
              const format = e.target.value;
              set({ format, ...(format === 'currency' && !v.currency && boardCurrency ? { currency: boardCurrency } : {}) });
            }}
            style={controlStyle}
          >
            <option value="plain">Plain number</option>
            <option value="currency">Currency</option>
            <option value="percent">Percent</option>
          </select>
        </label>
        {v.format === 'currency' && (
          <label style={{ minWidth: 0 }}>
            <span style={labelStyle}>Currency</span>
            <select
              value={v.currency || boardCurrency || ''}
              disabled={disabled}
              onChange={(e) => set({ currency: e.target.value })}
              style={controlStyle}
            >
              {!v.currency && !boardCurrency && <option value="">Board default</option>}
              {currencyOptions().map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <label style={{ display: 'block', marginTop: 8 }}>
        <span style={labelStyle}>Decimals</span>
        <select
          value={v.decimals || 'auto'}
          disabled={disabled}
          onChange={(e) => set({ decimals: e.target.value })}
          style={controlStyle}
        >
          {DECIMAL_CHOICES.map((d) => (
            <option key={d.value} value={d.value}>
              {d.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
};

/**
 * "Edit formula…" — the column menu's editor for an existing formula column.
 * Mounted only while open, so it starts from the column's saved settings.
 */
export const FormulaEditorModal = ({ boardId, column, columns, sampleTask = null, boardCurrency = null, onClose }) => {
  const updateColumn = useBoardStore((s) => s.updateColumn);
  const toastSuccess = useToastStore((s) => s.success);
  const [value, setValue] = useState(() => formulaDraftOf(column?.settings, boardCurrency));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const check = checkFormula(value.expression, columns, column?.key || null);

  const save = async () => {
    if (!check.ok || !boardId || !column?._id) return;
    setSaving(true);
    setError('');
    try {
      await updateColumn(boardId, column._id, { settings: formulaSettingsFrom(column.settings, value) });
      toastSuccess(`${column.name || 'Formula'} updated.`);
      onClose?.();
    } catch (err) {
      // The server validates too, and its reason is the one to show.
      setError(err?.response?.data?.error || 'Could not save the formula.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={`Edit formula — ${column?.name || 'Formula'}`}
      maxWidth={480}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button size="sm" onClick={save} disabled={saving || !check.ok}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <FormulaEditor
        columns={columns}
        selfKey={column?.key || null}
        sampleTask={sampleTask}
        value={value}
        onChange={setValue}
        boardCurrency={boardCurrency}
        disabled={saving}
        autoFocus
      />
      {error && (
        <p role="alert" style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--color-status-stuck)' }}>
          {error}
        </p>
      )}
    </Modal>
  );
};

export default FormulaEditor;
