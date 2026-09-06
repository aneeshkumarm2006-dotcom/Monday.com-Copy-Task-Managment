import { useId, useMemo, useState } from 'react';
import { Check, ClipboardPaste, Info, Plus, Trash2, X } from 'lucide-react';
import { SegmentedControl } from '../../ui/FormControls';
import SignInMethodInfoModal from '../SignInMethodInfoModal';
import {
  MAX_ROWS,
  isBlankRow,
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
 *
 *      The corollary is `pending`: a row that succeeded is on screen but out of
 *      the batch. Nothing downstream refuses a second invitation for someone
 *      already invited — the server mails them again — so the only thing
 *      standing between a success and a re-send is this table not offering it.
 */

/**
 * Catalog + free text. There is no combobox primitive in the repo — `Dropdown`
 * cannot accept a typed value and `SelectField` wraps it — so this is an input
 * with a native `<datalist>`. That buys the browser's own accessible
 * type-and-filter behaviour for a fraction of the code a hand-rolled popover
 * would cost, and, importantly, it CANNOT BE CLIPPED: the invite table sits in a
 * card with its own overflow, where an absolutely-positioned panel would be cut
 * off at the card's edge.
 *
 * The `<datalist>` itself is rendered ONCE for the whole table, below, and every
 * row only points at it by id. One element per row is one DOM id repeated N
 * times, and `list=` resolves to whichever copy comes first — so per-row option
 * filtering would silently serve row one's list to all of them.
 */
const ServiceInput = ({ value, onChange, listId, isNew, disabled, error }) => (
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
        border: `1px solid ${error ? '#DC2626' : 'var(--color-border)'}`,
        background: disabled ? 'var(--color-bg-subtle)' : 'var(--color-bg-input)',
        color: 'var(--color-text-primary)',
      }}
    />
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

  /**
   * AN INVITED ROW IS OUT OF THE BATCH. It is still on screen — that is how you
   * see what worked — but it is not in the plan, not in the button's count and
   * not in the payload. Sending the whole table again after a success re-mails
   * every client who was just invited: the server has no idempotence guard, it
   * reports an existing contact as `invited` and posts the email a second time.
   */
  const pending = useMemo(() => rows.filter((r) => r.status !== 'done'), [rows]);

  const plan = useMemo(
    () => planInvites(pending, { services, existingEmails }),
    [pending, services, existingEmails]
  );

  // Rows planInvites folded into an earlier row's single email. Legitimate — one
  // person, several services — but the summary names the address and not the
  // rows, which is no help at all in a table of 25.
  const dupeIds = useMemo(() => new Set(plan.duplicateRowIds), [plan]);

  const patch = (id, p) => setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...p } : r)));
  const remove = (id) => setRows((prev) => (prev.length > 1 ? prev.filter((r) => r.id !== id) : prev));

  const failedRows = rows.filter((r) => r.status === 'failed');
  const hasResults = rows.some((r) => r.status);

  const submit = async (subset = null) => {
    const target = subset || pending.filter((r) => !isBlankRow(r));
    if (!target.length) return;
    const payload = target.map((r) => ({
      service: r.service,
      email: r.email,
      authMethod: r.authMethod,
    }));
    setBanner('');
    setSkipped([]);
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
      // The cap has to REPORT what it removed, for the same reason a line with
      // no address is reported rather than dropped: pasting 40 people, getting
      // 25 rows and no word about the other 15 means sending the batch believing
      // the whole list went out.
      const kept = rows.filter((r) => r.service.trim() || r.email.trim());
      const merged = [...kept, ...parsed];
      const dropped = Math.max(0, merged.length - MAX_ROWS);
      setRows(merged.slice(0, MAX_ROWS));
      setBanner(
        dropped > 0
          ? `${dropped} more row${dropped === 1 ? '' : 's'} would not fit — this table holds `
            + `${MAX_ROWS}. Send this batch, then paste the rest.`
          : ''
      );
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

      {/* One list for every row's `list=`. See the note on ServiceInput. */}
      <datalist id={`${idPrefix}-svc`}>
        {options.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>

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
          // One message under the row, but the red border goes on the field the
          // message is actually about.
          const errorIn = plan.rowErrorFields[row.id] || {};
          const dupe = dupeIds.has(row.id);
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
                listId={`${idPrefix}-svc`}
                isNew={isNew}
                disabled={done}
                error={!!errorIn.service}
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
                  border: `1px solid ${
                    errorIn.email ? '#DC2626' : dupe ? '#B45309' : 'var(--color-border)'
                  }`,
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

              {(error || row.message || dupe) && (
                <p
                  className="font-body sm:col-span-5"
                  style={{
                    fontSize: 11.5,
                    color:
                      row.status === 'failed' || error
                        ? '#DC2626'
                        : dupe && !row.message
                          ? '#B45309'
                          : 'var(--color-text-muted)',
                  }}
                >
                  {error
                    || row.message
                    || 'Same person as a row above — they get one email listing every service.'}
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
            : plan.uniqueEmails.length
              ? `Send ${plan.uniqueEmails.length} invitation${
                plan.uniqueEmails.length === 1 ? '' : 's'
              }`
              : 'Send invitations'}
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
            onClick={() => {
              // Everything the last batch put on screen goes with it. Leaving
              // "Could not send the invitations." above two blank rows reads as
              // a failure of the batch that has not been sent yet, and there is
              // no other way to clear it.
              setRows([newRow(), newRow()]);
              setBanner('');
              setSkipped([]);
            }}
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
