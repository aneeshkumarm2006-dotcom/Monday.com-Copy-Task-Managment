import { useId, useMemo, useState } from 'react';
import { Check, ClipboardPaste, Info, Plus, Trash2, X } from 'lucide-react';
import { SegmentedControl } from '../../ui/FormControls';
import SignInMethodInfoModal from '../SignInMethodInfoModal';
import {
  MAX_ROWS,
  newRow,
  parsePastedInvites,
  planInvites,
  mergeResults,
  serviceKeyOf,
} from '../../../utils/inviteRows';

/**
 * The multi-row invite table.
 *
 * A FULL PANE, not a modal. The old single-email box lived in a 460px overlay;
 * an editable N-row table in that space is exactly the mess this redesign is
 * removing.
 *
 * Two things here are deliberate and worth not "simplifying" later:
 *
 *   1. THE PREVIEW LINE. It names the services about to be created, the count
 *      reused, and — by address — anyone who appears on more than one row. "One
 *      email for four services" is the most surprising thing about this feature,
 *      and finding out afterwards means having already worried about spamming a
 *      client.
 *
 *   2. THE TABLE IS NEVER CLEARED ON SUBMIT. Results are painted onto the rows
 *      by index; successes go read-only and failures stay editable, because the
 *      fix for a failure is almost always a typo in the row that failed.
 */

/**
 * Catalog + free text. There is no combobox primitive in the repo — `Dropdown`
 * cannot accept a typed value and `SelectField` wraps it — so this is an input
 * with a native `<datalist>`. That buys the browser's own accessible
 * type-and-filter behaviour for a fraction of the code a hand-rolled popover
 * would cost, and, importantly, it CANNOT BE CLIPPED: the invite table sits in a
 * card with its own overflow, where an absolutely-positioned panel would be cut
 * off at the card's edge.
 */
const ServiceInput = ({ value, onChange, catalog, listId, isNew, disabled }) => (
  <div className="relative flex items-center gap-1.5 min-w-0">
    <input
      type="text"
      value={value}
      list={listId}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      placeholder="e.g. SEO"
      aria-label="Service"
      className="font-body w-full min-w-0"
      style={{
        height: 32,
        padding: '0 8px',
        fontSize: 13,
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--color-border)',
        background: disabled ? 'var(--color-bg-subtle)' : 'var(--color-bg-input)',
        color: 'var(--color-text-primary)',
      }}
    />
    <datalist id={listId}>
      {catalog.map((c) => (
        <option key={c} value={c} />
      ))}
    </datalist>
    {isNew && (
      <span
        className="font-body shrink-0"
        title="This will create a new service"
        style={{
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: '0.05em',
          padding: '2px 5px',
          borderRadius: 4,
          background: 'var(--color-accent-light)',
          color: 'var(--color-accent-text)',
        }}
      >
        NEW
      </span>
    )}
  </div>
);

const InvitePeopleTable = ({
  services = [],
  catalog = [],
  existingEmails = [],
  submitting = false,
  onSubmit,
}) => {
  const [rows, setRows] = useState(() => [newRow(), newRow()]);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [skipped, setSkipped] = useState([]);
  const [infoOpen, setInfoOpen] = useState(false);
  const [banner, setBanner] = useState('');
  // useId, not a random string: the datalist id must be stable across renders
  // and unique if two of these ever mount at once.
  const idPrefix = useId();

  const options = useMemo(() => {
    const names = new Set([...services.map((s) => s.name), ...catalog]);
    return [...names].filter(Boolean).sort((a, b) => a.localeCompare(b));
  }, [services, catalog]);

  const existingKeys = useMemo(
    () => new Set(services.map((s) => serviceKeyOf(s.name)).filter(Boolean)),
    [services]
  );

  const plan = useMemo(
    () => planInvites(rows, { services, existingEmails }),
    [rows, services, existingEmails]
  );

  const patch = (id, p) => setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...p } : r)));
  const remove = (id) => setRows((prev) => (prev.length > 1 ? prev.filter((r) => r.id !== id) : prev));

  const failedRows = rows.filter((r) => r.status === 'failed');
  const hasResults = rows.some((r) => r.status);

  const submit = async (subset = null) => {
    const target = subset || rows;
    const payload = target.map((r) => ({
      service: r.service,
      email: r.email,
      authMethod: r.authMethod,
    }));
    setBanner('');
    try {
      const res = await onSubmit(payload);
      // Index-aligned with what we just sent, so paint onto THOSE rows.
      const painted = mergeResults(target, res?.rows || []);
      const byId = new Map(painted.map((r) => [r.id, r]));
      setRows((prev) => prev.map((r) => byId.get(r.id) || r));
      const warn = (res?.warnings || []).join(' ');
      if (warn) setBanner(warn);
    } catch (err) {
      const message =
        err?.response?.data?.errors?.[0]?.message
        || err?.response?.data?.error
        || 'Could not send the invitations.';
      setRows((prev) =>
        prev.map((r) =>
          target.some((t) => t.id === r.id) ? { ...r, status: 'failed', message } : r
        )
      );
      setBanner(message);
    }
  };

  const applyPaste = () => {
    const { rows: parsed, skipped: bad } = parsePastedInvites(pasteText, {
      catalog: options,
      defaultService: services[0]?.name || '',
    });
    if (parsed.length) {
      setRows((prev) => {
        const kept = prev.filter((r) => r.service.trim() || r.email.trim());
        return [...kept, ...parsed].slice(0, MAX_ROWS);
      });
    }
    setSkipped(bad);
    setPasteText('');
    setPasteOpen(false);
  };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2
          className="font-body uppercase"
          style={{
            fontSize: 9.5,
            fontWeight: 700,
            letterSpacing: '0.07em',
            color: 'var(--color-text-muted)',
          }}
        >
          Invite
        </h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPasteOpen((v) => !v)}
            className="font-body flex items-center gap-1.5"
            style={{
              height: 28,
              padding: '0 9px',
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--color-text-secondary)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
              background: 'transparent',
            }}
          >
            <ClipboardPaste size={12} aria-hidden="true" />
            Paste a list
          </button>
          <button
            type="button"
            onClick={() => setInfoOpen(true)}
            aria-label="About sign-in methods"
            className="flex items-center justify-center rounded-md hover:bg-[color:var(--color-bg-subtle)]"
            style={{ width: 26, height: 26 }}
          >
            <Info size={14} color="var(--color-text-muted)" aria-hidden="true" />
          </button>
        </div>
      </div>

      {pasteOpen && (
        <div
          className="flex flex-col gap-2 p-3"
          style={{
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--color-bg-subtle)',
          }}
        >
          <textarea
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            rows={4}
            placeholder={'asha@acme.com, SEO\nraj@acme.com, Meta Ads'}
            aria-label="Paste a list of people"
            className="font-body w-full"
            style={{
              padding: 8,
              fontSize: 12.5,
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--color-border)',
              background: 'var(--color-bg-input)',
              resize: 'vertical',
            }}
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={applyPaste}
              className="font-body"
              style={{
                height: 28,
                padding: '0 10px',
                fontSize: 12,
                fontWeight: 600,
                color: '#FFFFFF',
                background: 'var(--color-accent)',
                borderRadius: 'var(--radius-md)',
              }}
            >
              Add rows
            </button>
            <span className="font-body" style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>
              One per line. Email, then the service.
            </span>
          </div>
        </div>
      )}

      {skipped.length > 0 && (
        <p
          className="font-body flex items-start gap-1.5"
          style={{ fontSize: 12, color: '#B45309' }}
        >
          <X size={13} aria-hidden="true" className="shrink-0 mt-0.5" />
          {skipped.length} line{skipped.length === 1 ? '' : 's'} had no email address and
          {skipped.length === 1 ? ' was' : ' were'} skipped.
        </p>
      )}

      {/* The table. Header hidden below sm, where each row stacks. */}
      <div
        className="flex flex-col"
        style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)' }}
      >
        <div
          className="font-body uppercase hidden sm:grid px-3"
          style={{
            gridTemplateColumns: '1fr 1.2fr 150px 30px 24px',
            gap: 8,
            height: 30,
            alignItems: 'center',
            fontSize: 9.5,
            fontWeight: 700,
            letterSpacing: '0.06em',
            color: 'var(--color-text-muted)',
            borderBottom: '1px solid var(--color-border)',
          }}
        >
          <span>Service</span>
          <span>Email</span>
          <span>Sign-in</span>
          <span />
          <span />
        </div>

        {rows.map((row, i) => {
          const key = serviceKeyOf(row.service);
          const isNew = !!key && !existingKeys.has(key);
          const error = plan.rowErrors[row.id];
          const done = row.status === 'done';
          return (
            <div
              key={row.id}
              className="grid grid-cols-1 sm:grid-cols-[1fr_1.2fr_150px_30px_24px] gap-2 sm:gap-2 px-3 py-2 items-center"
              style={{
                borderTop: i === 0 ? 'none' : '1px solid var(--color-border)',
                background: done ? 'var(--color-bg-subtle)' : 'transparent',
                opacity: done ? 0.72 : 1,
              }}
            >
              <ServiceInput
                value={row.service}
                onChange={(v) => patch(row.id, { service: v, status: null, message: '' })}
                catalog={options}
                listId={`${idPrefix}-svc`}
                isNew={isNew}
                disabled={done}
              />

              <input
                type="email"
                value={row.email}
                disabled={done}
                onChange={(e) => patch(row.id, { email: e.target.value, status: null, message: '' })}
                placeholder="name@company.com"
                aria-label="Email"
                className="font-body w-full min-w-0"
                style={{
                  height: 32,
                  padding: '0 8px',
                  fontSize: 13,
                  borderRadius: 'var(--radius-md)',
                  border: `1px solid ${error ? '#DC2626' : 'var(--color-border)'}`,
                  background: done ? 'var(--color-bg-subtle)' : 'var(--color-bg-input)',
                }}
              />

              <SegmentedControl
                options={[
                  { value: 'google', label: 'Google' },
                  { value: 'password', label: 'Password' },
                ]}
                value={row.authMethod}
                disabled={done}
                onChange={(v) => patch(row.id, { authMethod: v })}
              />

              <button
                type="button"
                onClick={() => remove(row.id)}
                aria-label="Remove row"
                disabled={rows.length === 1}
                className="flex items-center justify-center rounded-md hover:bg-[color:var(--color-bg-subtle)] disabled:opacity-30"
                style={{ width: 28, height: 28 }}
              >
                <Trash2 size={14} color="var(--color-text-muted)" aria-hidden="true" />
              </button>

              <span className="flex items-center justify-center" style={{ width: 22 }}>
                {row.status === 'done' && (
                  <Check size={15} color="#059669" aria-label="Invited" />
                )}
                {row.status === 'failed' && (
                  <span title={row.message} style={{ color: '#DC2626', fontWeight: 700 }}>
                    !
                  </span>
                )}
              </span>

              {(error || row.message) && (
                <p
                  className="font-body sm:col-span-5"
                  style={{
                    fontSize: 11.5,
                    color: row.status === 'failed' || error ? '#DC2626' : 'var(--color-text-muted)',
                  }}
                >
                  {error || row.message}
                </p>
              )}
            </div>
          );
        })}
      </div>

      <button
        type="button"
        onClick={() => setRows((prev) => (prev.length >= MAX_ROWS ? prev : [...prev, newRow()]))}
        disabled={rows.length >= MAX_ROWS}
        className="font-body flex items-center gap-1.5 self-start disabled:opacity-40"
        style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--color-accent)' }}
      >
        <Plus size={13} aria-hidden="true" />
        Add row
      </button>

      {plan.summary && (
        <p
          className="font-body"
          style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', lineHeight: 1.55 }}
        >
          {plan.summary}
        </p>
      )}

      {banner && (
        <p className="font-body" style={{ fontSize: 12.5, color: '#B45309' }}>
          {banner}
        </p>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => submit()}
          disabled={!plan.ok || submitting}
          className="font-body disabled:opacity-40"
          style={{
            height: 34,
            padding: '0 14px',
            fontSize: 13,
            fontWeight: 600,
            color: '#FFFFFF',
            background: 'var(--color-accent)',
            borderRadius: 'var(--radius-md)',
          }}
        >
          {submitting
            ? 'Sending…'
            : `Send ${plan.uniqueEmails.length || ''} invitation${
              plan.uniqueEmails.length === 1 ? '' : 's'
            }`}
        </button>

        {failedRows.length > 0 && (
          <button
            type="button"
            onClick={() => submit(failedRows)}
            disabled={submitting}
            className="font-body"
            style={{
              height: 34,
              padding: '0 12px',
              fontSize: 12.5,
              fontWeight: 600,
              color: 'var(--color-text-secondary)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
              background: 'transparent',
            }}
          >
            Retry {failedRows.length} failed row{failedRows.length === 1 ? '' : 's'}
          </button>
        )}

        {hasResults && (
          <button
            type="button"
            onClick={() => setRows([newRow(), newRow()])}
            className="font-body"
            style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}
          >
            Start a new batch
          </button>
        )}
      </div>

      {infoOpen && <SignInMethodInfoModal onClose={() => setInfoOpen(false)} />}
    </section>
  );
};

export default InvitePeopleTable;
