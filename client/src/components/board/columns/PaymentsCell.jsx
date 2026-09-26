import { useId, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { cellWrapperStyle, formatDate } from './cellShared';
import AnchoredPopover from '../../ui/AnchoredPopover';
import useMoney from '../../../hooks/useMoney';
import useAuthStore from '../../../store/authStore';
import { currencyByCode } from '../../../utils/money';
import { paymentsOf, paymentsTotal, makePayment, todayKey } from '../../../utils/payments';

/**
 * PaymentsCell — the money that has come in against a row, and when.
 *
 * The cell reads as the TOTAL received and how many receipts make it up
 * ("CA$1,500 · 2"); clicking it opens the receipts themselves, each with its
 * date and method, and a form to record another. The value is the list
 * (`utils/payments.js` has why it is a list and not a number), so the total can
 * never drift from the receipts it claims to sum, and a mistaken entry is
 * removed on its own instead of by retyping a running figure.
 *
 * ---- Which currency ---------------------------------------------------------
 *
 * The column's own `settings.currency`, else the board's (`currency` prop),
 * else the workspace's — the same chain `NumberCell` uses. Amounts are TYPED in
 * that unit whatever the reader has chosen to display, and the form says which
 * one; a converted amount typed back would be a rate-dependent guess at what
 * somebody meant.
 *
 * The total converts at the latest rate, like any column total. Each receipt in
 * the list converts at ITS OWN date: a payment received in March is a March
 * figure, the same rule the ledger follows for an invoice's issue date.
 */

/** Suggestions, not a list to pick from — a method is free text on the server. */
const METHODS = ['Bank transfer', 'Card', 'Cash', 'Cheque', 'UPI', 'PayPal', 'Stripe', 'Wire'];

const fieldStyle = {
  width: '100%',
  padding: '6px 8px',
  fontSize: 13,
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--color-bg-input, var(--color-bg-surface))',
  color: 'var(--color-text-primary)',
  minWidth: 0,
};

const smallLabel = {
  display: 'block',
  fontSize: 11,
  color: 'var(--color-text-muted)',
  marginBottom: 3,
};

const PaymentsCell = ({ value, column, readOnly, onChange, currency = null }) => {
  const money = useMoney();
  const userId = useAuthStore((s) => s.user?._id || null);
  const [anchor, setAnchor] = useState(null);
  // A write is in flight. Every add or remove is built from `value`, the last
  // SAVED list, and the host only updates it once the server answers — so a
  // second receipt recorded before the first reply was built without the
  // first, and the server stored [old, second]: the first receipt gone, with
  // no message, and the total and the auto-Paid decision wrong with it. One
  // write at a time; the form waits.
  const [pending, setPending] = useState(false);
  const wrapperRef = useRef(null);
  const commit = async (next) => {
    if (pending || !onChange) return false;
    setPending(true);
    try {
      await onChange(next);
      return true;
    } finally {
      setPending(false);
    }
  };
  const settings = column?.settings || {};
  // Payments are money by definition — the server pins `format: 'currency'` —
  // so the formatter is always handed a currency format, even for a legacy
  // column saved before that rule.
  const moneySettings = { ...settings, format: 'currency' };
  const editable = !readOnly && typeof onChange === 'function';

  const list = paymentsOf(value);
  const total = paymentsTotal(value);
  const source = settings.currency || currency || money.baseCurrency || null;
  const label = column?.name || 'Payments';

  const shownTotal = list.length ? money.column(total, moneySettings, null, currency) : '';
  const summary = list.length
    ? `${shownTotal} received in ${list.length} ${list.length === 1 ? 'payment' : 'payments'}`
    : 'no payments recorded';

  const face = (
    <>
      {list.length === 0 ? (
        <span style={{ color: 'var(--color-text-muted)' }}>{editable ? 'Add' : '—'}</span>
      ) : (
        <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{shownTotal}</span>
          <span style={{ color: 'var(--color-text-muted)' }}> · {list.length}</span>
        </span>
      )}
    </>
  );

  return (
    <div ref={wrapperRef} style={{ position: 'relative', width: '100%' }}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setAnchor((a) => (a ? null : wrapperRef.current));
        }}
        aria-haspopup="dialog"
        aria-expanded={!!anchor}
        aria-label={`${label}: ${summary}${editable ? ' — open to record a payment' : ''}`}
        className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--color-accent)] focus-visible:outline-offset-[-2px]"
        style={{
          ...cellWrapperStyle,
          justifyContent: 'flex-end',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          minWidth: 0,
        }}
      >
        {face}
      </button>

      {anchor && (
        <AnchoredPopover
          anchorEl={anchor}
          onClose={() => setAnchor(null)}
          align="end"
          width={300}
          maxHeight={440}
          padding={10}
          ariaLabel={`${label} for this row`}
          initialFocus={editable}
        >
          <PaymentsPanel
            list={list}
            total={total}
            label={label}
            settings={moneySettings}
            source={source}
            currency={currency}
            money={money}
            editable={editable}
            busy={pending}
            onRemove={(id) => commit(list.filter((p) => p.id !== id))}
            onAdd={(entry) => commit([...list, makePayment({ ...entry, by: userId })])}
          />
        </AnchoredPopover>
      )}
    </div>
  );
};

const PaymentsPanel = ({ list, total, label, settings, source, currency, money, editable, busy = false, onRemove, onAdd }) => {
  const [confirmId, setConfirmId] = useState(null);
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(() => todayKey());
  const [method, setMethod] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const listId = useId();
  const symbol = currencyByCode(source)?.symbol || source || '';

  const submit = (e) => {
    e.preventDefault();
    if (busy) return;
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) {
      setError('Enter an amount greater than zero.');
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setError('Pick the date it was received.');
      return;
    }
    onAdd({ amount: n, date, method, note });
    setAmount('');
    setMethod('');
    setNote('');
    setError('');
  };

  return (
    <div style={{ fontSize: 13 }}>
      <div className="flex items-baseline justify-between" style={{ marginBottom: 8, gap: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--color-text-muted)' }}>
          {label}
        </span>
        <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
          {list.length ? money.column(total, settings, null, currency) : ''}
        </span>
      </div>

      {list.length === 0 ? (
        <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--color-text-muted)' }}>
          No payments recorded yet.
        </p>
      ) : (
        <ul style={{ listStyle: 'none', margin: '0 0 8px', padding: 0 }}>
          {list.map((p) => (
            <li
              key={p.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 0',
                borderBottom: '1px solid var(--color-border)',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="flex items-baseline justify-between" style={{ gap: 8 }}>
                  <span style={{ color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>
                    {formatDate(p.date) || '—'}
                  </span>
                  <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                    {money.column(p.amount, settings, p.date || null, currency)}
                  </span>
                </div>
                {(p.method || p.note) && (
                  <div
                    style={{ fontSize: 11, color: 'var(--color-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    title={[p.method, p.note].filter(Boolean).join(' — ')}
                  >
                    {[p.method, p.note].filter(Boolean).join(' — ')}
                  </div>
                )}
              </div>
              {editable &&
                (confirmId === p.id ? (
                  <span className="inline-flex items-center" style={{ gap: 4, flexShrink: 0 }}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setConfirmId(null);
                        onRemove(p.id);
                      }}
                      className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--color-accent)]"
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        padding: '2px 6px',
                        border: 'none',
                        borderRadius: 'var(--radius-sm)',
                        background: 'var(--color-status-stuck)',
                        color: '#fff',
                        cursor: 'pointer',
                      }}
                    >
                      Remove
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmId(null)}
                      className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--color-accent)]"
                      style={{
                        fontSize: 11,
                        padding: '2px 6px',
                        border: '1px solid var(--color-border)',
                        borderRadius: 'var(--radius-sm)',
                        background: 'transparent',
                        color: 'var(--color-text-secondary)',
                        cursor: 'pointer',
                      }}
                    >
                      Keep
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmId(p.id)}
                    aria-label={`Remove the payment of ${money.column(p.amount, settings, p.date || null, currency)} on ${formatDate(p.date)}`}
                    title="Remove this payment"
                    className="hover:text-[color:var(--color-status-stuck)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--color-accent)]"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: 22,
                      height: 22,
                      flexShrink: 0,
                      border: 'none',
                      background: 'transparent',
                      color: 'var(--color-text-muted)',
                      cursor: 'pointer',
                      borderRadius: 'var(--radius-sm)',
                    }}
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
                ))}
            </li>
          ))}
        </ul>
      )}

      {editable && (
        <form onSubmit={submit} noValidate>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
            <label style={{ minWidth: 0 }}>
              <span style={smallLabel}>Amount{source ? ` (${source})` : ''}</span>
              <span className="flex items-center" style={{ gap: 4 }}>
                {symbol ? (
                  <span aria-hidden="true" style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                    {symbol}
                  </span>
                ) : null}
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="any"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  data-autofocus
                  style={{ ...fieldStyle, textAlign: 'right' }}
                />
              </span>
            </label>
            <label style={{ minWidth: 0 }}>
              <span style={smallLabel}>Received on</span>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                style={fieldStyle}
              />
            </label>
          </div>
          <label style={{ display: 'block', marginBottom: 8 }}>
            <span style={smallLabel}>Method</span>
            <input
              type="text"
              list={listId}
              maxLength={40}
              value={method}
              onChange={(e) => setMethod(e.target.value)}
              placeholder="Bank transfer, card…"
              style={fieldStyle}
            />
            <datalist id={listId}>
              {METHODS.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </label>
          <label style={{ display: 'block', marginBottom: 8 }}>
            <span style={smallLabel}>Note</span>
            <input
              type="text"
              maxLength={200}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Optional"
              style={fieldStyle}
            />
          </label>
          {error && (
            <p role="alert" style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--color-status-stuck)' }}>
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={busy}
            aria-busy={busy || undefined}
            className="inline-flex items-center justify-center hover:bg-accent-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
            style={{
              width: '100%',
              gap: 6,
              height: 32,
              fontSize: 13,
              fontWeight: 600,
              border: 'none',
              borderRadius: 'var(--radius-md)',
              background: 'var(--color-accent)',
              color: '#fff',
              cursor: busy ? 'progress' : 'pointer',
              opacity: busy ? 0.6 : 1,
            }}
          >
            <Plus size={14} aria-hidden="true" />
            {busy ? 'Saving…' : 'Record payment'}
          </button>
        </form>
      )}
    </div>
  );
};

export default PaymentsCell;
