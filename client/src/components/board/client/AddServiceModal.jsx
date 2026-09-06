import { useEffect, useMemo, useRef, useState } from 'react';
import { Info, Loader2, Plus, Trash2 } from 'lucide-react';
import Modal from '../../ui/Modal';
import Button from '../../ui/Button';
import Input from '../../ui/Input';
import SignInMethodInfoModal from '../SignInMethodInfoModal';
import { EMAIL_RE, MAX_SERVICE_INVITES, serviceKeyOf } from '../../../utils/inviteRows';

/**
 * ADD A SERVICE — and, in the same submission, invite the people at the client
 * who look after it.
 *
 * ---- WHY THE INVITATION LIVES HERE AND NOWHERE EARLIER --------------------
 *
 * A client board used to mint its portal link and email the client the moment
 * the board was created. The client then opened a portal that said "Your portal
 * is being set up" — no service to look at, no request to raise, no chat, no
 * mailbox. The one moment they actually paid attention was spent on an empty
 * room.
 *
 * So the board is now created with no link at all, and THIS is the screen that
 * brings a client portal into existence: naming the first service creates the
 * link, and the addresses typed alongside it are who gets told. `portalActivated`
 * comes back true exactly once per board, on that first submission, which is
 * what the "the client link is now live" line is keyed on.
 *
 * ---- WHY THE EMAILS ARE OPTIONAL ------------------------------------------
 *
 * Two ordinary cases would otherwise be blocked: adding the first service before
 * anyone knows who at the client will look after it, and adding a second service
 * for a client whose people were invited months ago. An empty list still creates
 * the service and still makes the link live; only the mail is conditional. The
 * People tab is where anyone is added afterwards.
 *
 * ---- WHY THIS IS NOT THE INVITE TABLE -------------------------------------
 *
 * `InvitePeopleTable` is the N-services × M-people bulk pane on the People tab,
 * and it REUSES a service the board already has. This is one NEW service, so a
 * name already on the board is a 409 the server raises and this shows inline —
 * the same policy the plain "New group" modal has always had.
 *
 * ---- IT IS MOUNTED ONLY WHILE OPEN ----------------------------------------
 *
 * `BoardDetailPage` renders this behind `groupModalOpen`, so closing it unmounts
 * it and every `useState` initialiser below runs again on the next open. That is
 * deliberate and it is the reset: an effect that blanked the fields on `isOpen`
 * would be a cascading render, and — worse — a reset that can be forgotten.
 * Carrying the last submission's addresses forward is how a second service
 * quietly re-emails people who never asked to hear about it.
 *
 * ---- INVITING IS A SEPARATE CAPABILITY FROM ADDING ------------------------
 *
 * Creating a service needs `group.manage`; handing somebody access to a
 * client's portal needs `canManageAccess` as well, and an `edit` grant confers
 * the first without the second. That person can still add services — the board
 * would otherwise be unusable to them — so `canInvite` hides the invitation
 * half rather than the whole modal, and the parent posts to the plain group
 * endpoint on their behalf.
 *
 * Props:
 *   isOpen, onClose
 *   boardName        — for the "…for Acme Corp" line
 *   existingServices — [{ id, name }] on this board, for the duplicate hint
 *   canInvite        — may this person hand out portal access? Default true.
 *   submitting       — parent-owned, because the parent also updates its store
 *   onSubmit         — async ({ name, invites }) => result | throws
 */

let seq = 0;
const newInvite = () => ({ id: `i${(seq += 1)}`, email: '', authMethod: 'google' });

const methodBtn = (active) => ({
  height: 26,
  padding: '0 9px',
  fontSize: 11.5,
  fontWeight: 600,
  borderRadius: 'var(--radius-md)',
  cursor: 'pointer',
  border: `1.5px solid ${active ? 'var(--color-accent)' : 'var(--color-border)'}`,
  background: active ? 'var(--color-accent-light)' : 'transparent',
  color: active ? 'var(--color-accent-text)' : 'var(--color-text-secondary)',
});

const AddServiceModal = ({
  isOpen,
  onClose,
  boardName = '',
  existingServices = [],
  canInvite = true,
  submitting = false,
  onSubmit,
}) => {
  const [name, setName] = useState('');
  const [invites, setInvites] = useState(() => [newInvite()]);
  const [error, setError] = useState('');
  const [rowErrors, setRowErrors] = useState({});
  const [infoOpen, setInfoOpen] = useState(false);
  const nameRef = useRef(null);

  /**
   * Modal moves focus to the first focusable thing in its panel 10ms after it
   * opens, and that is the header's close button — so `autoFocus` on the name
   * field is set and then undone before anyone sees it, leaving Enter or Space
   * on an opened modal dismissing it instead of typing a name. Focusing after
   * Modal has had its turn is the fix available from this side; the durable one
   * is an `initialFocusRef` prop on Modal itself.
   */
  useEffect(() => {
    if (!isOpen) return undefined;
    const t = window.setTimeout(() => nameRef.current?.focus(), 40);
    return () => window.clearTimeout(t);
  }, [isOpen]);

  const existingKeys = useMemo(
    () => new Set(existingServices.map((s) => serviceKeyOf(s.name)).filter(Boolean)),
    [existingServices]
  );

  const nameKey = serviceKeyOf(name);
  const nameTaken = !!nameKey && existingKeys.has(nameKey);

  // Filled-in addresses only. A blank row is a row the user has not got to yet,
  // which is why the form can be submitted with one sitting there.
  //
  // Empty when this person may not invite, so the button label, the validation
  // and the submitted payload all follow from this one expression rather than
  // each remembering to check the capability.
  const filled = useMemo(
    () => (canInvite ? invites.filter((i) => i.email.trim()) : []),
    [canInvite, invites]
  );
  const invalid = filled.filter((i) => !EMAIL_RE.test(i.email.trim()));
  // The server dedupes too, but a red line under a row that the button then
  // ignores is worse than no line: two red states, one blocking and one not,
  // and no way to tell which is holding the form. So this blocks as well.
  const duplicates = useMemo(() => {
    const seen = new Set();
    const dupes = new Set();
    filled.forEach((i) => {
      const e = i.email.trim().toLowerCase();
      if (seen.has(e)) dupes.add(e);
      seen.add(e);
    });
    return dupes;
  }, [filled]);

  const patch = (id, p) => setInvites((prev) => prev.map((i) => (i.id === id ? { ...i, ...p } : i)));
  const remove = (id) =>
    setInvites((prev) => (prev.length > 1 ? prev.filter((i) => i.id !== id) : [newInvite()]));

  const submit = async (e) => {
    e?.preventDefault?.();
    if (submitting) return;

    const trimmed = name.trim();
    if (!trimmed) {
      setError('Service name is required.');
      return;
    }
    if (nameTaken) {
      setError(`This board already has a service called “${trimmed}”.`);
      return;
    }
    if (invalid.length) {
      setError('Fix the highlighted email addresses, or clear them.');
      setRowErrors(Object.fromEntries(invalid.map((i) => [i.id, true])));
      return;
    }
    if (duplicates.size) {
      setError('The same address is on more than one row. Remove the duplicates.');
      setRowErrors(
        Object.fromEntries(
          filled
            .filter((i) => duplicates.has(i.email.trim().toLowerCase()))
            .map((i) => [i.id, true])
        )
      );
      return;
    }

    setError('');
    setRowErrors({});
    try {
      await onSubmit({
        name: trimmed,
        invites: filled.map((i) => ({
          email: i.email.trim(),
          authMethod: i.authMethod,
        })),
      });
    } catch (err) {
      // The server answers `{ error }` and, for a field-level problem,
      // `{ errors: [{ field, message }] }`. Prefer the specific one.
      const data = err?.response?.data;
      setError(
        data?.errors?.[0]?.message ||
          data?.error ||
          'Could not add that service. Please try again.'
      );
    }
  };

  const count = filled.length;

  return (
    <>
      <Modal
        isOpen={isOpen}
        /*
         * No `onClose` at all while the request is in flight, rather than a
         * no-op standing in for it. A no-op is still a truthy function, so Modal
         * kept rendering the X at full opacity with its hover state while
         * Escape, the overlay and the button all did nothing — for up to the 30s
         * the create-and-email request is allowed. Dropping the prop removes the
         * control instead of faking it, which is what the disabled Cancel button
         * next to it has always done.
         */
        onClose={submitting ? undefined : onClose}
        closeOnOverlayClick={!submitting}
        title="Add a service"
        footer={
          <>
            <Button variant="secondary" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            <Button variant="primary" onClick={submit} disabled={submitting}>
              {submitting ? (
                <span className="flex items-center gap-1.5">
                  <Loader2 size={13} className="animate-spin" aria-hidden="true" />
                  {count ? 'Adding & inviting…' : 'Adding…'}
                </span>
              ) : count ? (
                `Add service & invite ${count}`
              ) : (
                'Add service'
              )}
            </Button>
          </>
        }
      >
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Input
              label="Service name"
              required
              placeholder="e.g. SEO, Meta Ads, Web Development"
              value={name}
              onChange={(e) => setName(e.target.value)}
              ref={nameRef}
            />
            <p
              className="font-body"
              style={{ fontSize: 11.5, lineHeight: 1.55, color: 'var(--color-text-muted)' }}
            >
              One of the things you deliver{boardName ? ` for ${boardName}` : ''}. It gets its
              own requests, chat and mailbox, and the client sees it in their portal.
            </p>
            {nameTaken && (
              <p
                className="font-body"
                style={{ fontSize: 11.5, color: 'var(--color-status-stuck, #dc2626)' }}
              >
                This board already has a service with that name.
              </p>
            )}
          </div>

          {canInvite && (
          <div
            className="flex flex-col gap-2"
            style={{
              borderTop: '1px solid var(--color-border)',
              paddingTop: 14,
            }}
          >
            <div className="flex items-center gap-1.5">
              <span
                className="font-body"
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  color: 'var(--color-text-muted)',
                }}
              >
                Invite the client&rsquo;s people
              </span>
              <button
                type="button"
                onClick={() => setInfoOpen(true)}
                aria-label="About the sign-in options"
                title="Which sign-in should I pick?"
                className="flex items-center justify-center rounded-full hover:bg-[color:var(--color-bg-subtle)]"
                style={{
                  width: 18,
                  height: 18,
                  border: 'none',
                  background: 'transparent',
                  cursor: 'pointer',
                  color: 'var(--color-text-muted)',
                  padding: 0,
                }}
              >
                <Info size={13} aria-hidden="true" />
              </button>
            </div>

            <p
              className="font-body"
              style={{ fontSize: 11.5, lineHeight: 1.55, color: 'var(--color-text-muted)' }}
            >
              They each get one email with the portal link. Optional &mdash; leave it blank
              and add people later from the People tab.
            </p>

            {invites.map((row) => {
              const email = row.email.trim();
              const bad = !!email && !EMAIL_RE.test(email);
              const dupe = !!email && duplicates.has(email.toLowerCase());
              return (
                <div key={row.id} className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <input
                      type="email"
                      value={row.email}
                      onChange={(e) => {
                        patch(row.id, { email: e.target.value });
                        if (rowErrors[row.id]) {
                          setRowErrors((prev) => {
                            const next = { ...prev };
                            delete next[row.id];
                            return next;
                          });
                        }
                      }}
                      placeholder="name@client.com"
                      aria-label="Client email"
                      autoComplete="off"
                      className="font-body flex-1"
                      style={{
                        minWidth: 180,
                        height: 34,
                        padding: '0 10px',
                        fontSize: 13,
                        borderRadius: 'var(--radius-md)',
                        border: `1.5px solid ${
                          bad || rowErrors[row.id]
                            ? 'var(--color-status-stuck, #dc2626)'
                            : 'var(--color-border)'
                        }`,
                        background: 'var(--color-bg-input)',
                        color: 'var(--color-text-primary)',
                        outline: 'none',
                      }}
                    />

                    <div
                      role="radiogroup"
                      aria-label="How they sign in"
                      className="flex items-center gap-1 shrink-0"
                    >
                      <button
                        type="button"
                        role="radio"
                        aria-checked={row.authMethod === 'google'}
                        onClick={() => patch(row.id, { authMethod: 'google' })}
                        style={methodBtn(row.authMethod === 'google')}
                      >
                        Google
                      </button>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={row.authMethod === 'password'}
                        onClick={() => patch(row.id, { authMethod: 'password' })}
                        style={methodBtn(row.authMethod === 'password')}
                      >
                        Password
                      </button>
                    </div>

                    <button
                      type="button"
                      onClick={() => remove(row.id)}
                      aria-label="Remove this person"
                      title="Remove"
                      className="flex items-center justify-center shrink-0 rounded-md hover:bg-[color:var(--color-bg-subtle)]"
                      style={{
                        width: 28,
                        height: 28,
                        border: 'none',
                        background: 'transparent',
                        cursor: 'pointer',
                        color: 'var(--color-text-muted)',
                      }}
                    >
                      <Trash2 size={13} aria-hidden="true" />
                    </button>
                  </div>
                  {(bad || dupe) && (
                    <p
                      className="font-body"
                      style={{ fontSize: 11, color: 'var(--color-status-stuck, #dc2626)' }}
                    >
                      {bad ? 'That is not an email address.' : 'This address is already on the list.'}
                    </p>
                  )}
                </div>
              );
            })}

            {invites.length < MAX_SERVICE_INVITES && (
              <button
                type="button"
                onClick={() => setInvites((prev) => [...prev, newInvite()])}
                className="font-body flex items-center gap-1.5 self-start"
                style={{
                  height: 30,
                  padding: '0 10px',
                  fontSize: 12,
                  fontWeight: 600,
                  color: 'var(--color-text-secondary)',
                  border: '1.5px dashed var(--color-border-strong)',
                  borderRadius: 'var(--radius-md)',
                  background: 'transparent',
                  cursor: 'pointer',
                }}
              >
                <Plus size={12} aria-hidden="true" />
                Add another person
              </button>
            )}
          </div>
          )}

          {!canInvite && (
            <p
              className="font-body"
              style={{
                fontSize: 11.5,
                lineHeight: 1.55,
                color: 'var(--color-text-muted)',
                borderTop: '1px solid var(--color-border)',
                paddingTop: 12,
                margin: 0,
              }}
            >
              Inviting the client&rsquo;s people needs permission to manage this
              board&rsquo;s access. Ask a board manager to send the invitations from
              the People tab &mdash; the service itself is yours to add.
            </p>
          )}

          {error && (
            <p
              className="font-body"
              style={{ fontSize: 12.5, color: 'var(--color-status-stuck, #dc2626)', margin: 0 }}
            >
              {error}
            </p>
          )}

          {/* Hidden submit so <Enter> submits the form */}
          <button type="submit" className="hidden" aria-hidden="true" />
        </form>
      </Modal>

      {infoOpen && <SignInMethodInfoModal onClose={() => setInfoOpen(false)} />}
    </>
  );
};

export default AddServiceModal;
