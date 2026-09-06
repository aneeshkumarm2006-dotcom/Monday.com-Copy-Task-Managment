import { useCallback, useEffect, useState } from 'react';
import { Mail, RefreshCw, RotateCw, UserMinus } from 'lucide-react';
import InvitePeopleTable from './InvitePeopleTable';
import {
  getBoardPortalContacts,
  resendPortalInvite,
  revokePortalContact,
  sendBoardPortalInvites,
} from '../../../services/boardService';
import { getServiceCatalog } from '../../../services/orgService';
import useOrgStore from '../../../store/orgStore';
import useToastStore from '../../../store/toastStore';

/**
 * People with access to this client's portal, and the table that invites them.
 *
 * The roster shows WHICH SERVICES each contact was invited on. That is
 * labelling, not permission — every contact can see every service on the board —
 * but without it the team loses the (service, email) pairing they typed the
 * moment they hit send, which is the only record of who to chase about what.
 */

const stateOf = (c) => {
  if (c.authMethod === 'password' && !c.hasPassword) return { label: 'Password not set', tone: '#B45309' };
  if (c.verified || c.lastSeenAt) return { label: 'Active', tone: '#059669' };
  return { label: 'Invited', tone: 'var(--color-text-muted)' };
};

const ago = (iso) => {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
};

const ClientPeoplePanel = ({ boardId, services = [], canManage, onServicesChanged }) => {
  const [contacts, setContacts] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [resendingId, setResendingId] = useState(null);
  const [revokingId, setRevokingId] = useState(null);
  const currentOrg = useOrgStore((s) => s.currentOrg);
  const toast = useToastStore.getState();

  // A FAILED roster load is not an empty roster. The two used to collapse into
  // one another here, so a 403 — which is what this endpoint answers for
  // everyone without manage access, and the People row is reachable by anyone —
  // rendered as "Nobody has been invited yet". That is a factual lie about who
  // can open the client's portal, and the reasonable response to it is to
  // re-invite people who are already there.
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getBoardPortalContacts(boardId);
      setContacts(res?.contacts || res || []);
      setLoadError('');
    } catch (err) {
      setContacts([]);
      setLoadError(
        err?.response?.status === 403
          ? 'Only board managers can see who has access to this portal.'
          : err?.response?.data?.error || 'Could not load who has access to this portal.'
      );
    } finally {
      setLoading(false);
    }
  }, [boardId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!currentOrg?._id) return;
    getServiceCatalog(currentOrg._id)
      .then((res) => setCatalog((res?.services || []).map((s) => s.name)))
      // The catalog only powers a dropdown's suggestions. Failing it must not
      // stop anyone typing a service name by hand.
      .catch(() => setCatalog([]));
  }, [currentOrg?._id]);

  const submit = async (rows) => {
    setSubmitting(true);
    try {
      const res = await sendBoardPortalInvites(boardId, rows);
      setContacts(res?.roster || []);
      // A successful send proves the roster is readable, so an error left over
      // from a failed load must not keep covering it.
      setLoadError('');
      const created = (res?.services || []).filter((s) => s.created).length;
      if (created) {
        toast.success(`${created} service${created === 1 ? '' : 's'} added to this board.`);
        onServicesChanged?.();
      }
      return res;
    } finally {
      setSubmitting(false);
    }
  };

  const resend = async (contactId) => {
    setResendingId(contactId);
    try {
      await resendPortalInvite(boardId, contactId);
      toast.success('Invitation sent again.');
      load();
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Could not resend that invitation.');
    } finally {
      setResendingId(null);
    }
  };

  // Removing a contact ENDS THEIR ACCESS — the contact row is what the portal
  // matches a returning Google account against, so deleting it signs them out
  // and refuses the next sign-in. The confirm names the address because the
  // mistake this fixes is a typo, and a typo is only visible when you read it.
  const revoke = async (contact) => {
    const ok = window.confirm(
      `Remove ${contact.email} from this client's portal?\n\n`
      + 'They lose access immediately — any session they have open stops working '
      + 'and their invitation link will no longer sign them in. Inviting them '
      + 'again later is the only way back.'
    );
    if (!ok) return;
    setRevokingId(contact.id);
    try {
      const roster = await revokePortalContact(boardId, contact.id);
      setContacts(roster || []);
      setLoadError('');
      toast.success(`${contact.email} no longer has access.`);
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Could not remove that person.');
    } finally {
      setRevokingId(null);
    }
  };

  return (
    <div className="flex flex-col gap-7" style={{ maxWidth: 860 }}>
      {canManage && (
        <InvitePeopleTable
          services={services}
          catalog={catalog}
          existingEmails={contacts.map((c) => c.email)}
          submitting={submitting}
          onSubmit={submit}
        />
      )}

      <section className="flex flex-col gap-2">
        <h2
          className="font-body uppercase"
          style={{
            fontSize: 9.5,
            fontWeight: 700,
            letterSpacing: '0.07em',
            color: 'var(--color-text-muted)',
          }}
        >
          {/* No number while the list is unread or unreadable: "(0)" beside a
              heading is read as a fact, and it is the same false fact the empty
              state used to tell. */}
          People with access{loading || loadError ? '' : ` (${contacts.length})`}
        </h2>

        {loading ? (
          <p className="font-body" style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}>
            Loading…
          </p>
        ) : loadError ? (
          <div
            className="flex flex-col items-start gap-2 p-4 bg-surface"
            style={{
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-lg)',
            }}
          >
            <p className="font-body" style={{ fontSize: 12.5, fontWeight: 600 }}>
              {loadError}
            </p>
            <p
              className="font-body"
              style={{ fontSize: 11.5, color: 'var(--color-text-muted)', lineHeight: 1.55 }}
            >
              This is not the same as nobody having access &mdash; the list could not
              be read, so do not invite anyone again on the strength of it.
            </p>
            <button
              type="button"
              onClick={load}
              className="font-body flex items-center gap-1.5"
              style={{
                height: 28,
                padding: '0 9px',
                fontSize: 11.5,
                fontWeight: 600,
                color: 'var(--color-text-secondary)',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-md)',
                background: 'transparent',
              }}
            >
              <RotateCw size={11} aria-hidden="true" />
              Try again
            </button>
          </div>
        ) : contacts.length === 0 ? (
          <p className="font-body" style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}>
            Nobody has been invited yet.
          </p>
        ) : (
          <div
            className="flex flex-col bg-surface"
            style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)' }}
          >
            {contacts.map((c, i) => {
              const st = stateOf(c);
              return (
                <div
                  key={c.id}
                  className="flex items-center gap-3 px-4 py-2.5 flex-wrap"
                  style={{ borderTop: i === 0 ? 'none' : '1px solid var(--color-border)' }}
                >
                  <div className="flex flex-col min-w-0 flex-1" style={{ minWidth: 180 }}>
                    <span
                      className="font-body truncate"
                      style={{ fontSize: 13, fontWeight: 600 }}
                      title={c.email}
                    >
                      {c.email}
                    </span>
                    <span
                      className="font-body"
                      style={{ fontSize: 11, color: 'var(--color-text-muted)' }}
                    >
                      {c.authMethod === 'password' ? 'Password' : 'Google'} · {st.label}
                      {c.lastSeenAt ? ` · ${ago(c.lastSeenAt)}` : ''}
                    </span>
                  </div>

                  <div className="flex items-center gap-1 flex-wrap min-w-0">
                    {(c.services || []).length === 0 ? (
                      <span
                        className="font-body"
                        style={{ fontSize: 11, color: 'var(--color-text-muted)' }}
                      >
                        no service noted
                      </span>
                    ) : (
                      c.services.map((s) => (
                        <span
                          key={s.id}
                          className="font-body"
                          style={{
                            fontSize: 10.5,
                            fontWeight: 600,
                            padding: '2px 7px',
                            borderRadius: 999,
                            background: 'var(--color-bg-subtle)',
                            color: 'var(--color-text-secondary)',
                          }}
                        >
                          {s.name}
                        </span>
                      ))
                    )}
                  </div>

                  <span
                    aria-hidden="true"
                    className="shrink-0"
                    style={{ width: 7, height: 7, borderRadius: 999, background: st.tone }}
                  />

                  {canManage && (
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => resend(c.id)}
                        disabled={resendingId === c.id || revokingId === c.id}
                        className="font-body flex items-center gap-1.5 shrink-0 disabled:opacity-40"
                        style={{
                          height: 28,
                          padding: '0 9px',
                          fontSize: 11.5,
                          fontWeight: 600,
                          color: 'var(--color-text-secondary)',
                          border: '1px solid var(--color-border)',
                          borderRadius: 'var(--radius-md)',
                          background: 'transparent',
                        }}
                      >
                        {c.authMethod === 'password' && c.hasPassword ? (
                          <RefreshCw size={11} aria-hidden="true" />
                        ) : (
                          <Mail size={11} aria-hidden="true" />
                        )}
                        {c.authMethod === 'password' && c.hasPassword ? 'Reset' : 'Resend'}
                      </button>
                      <button
                        type="button"
                        onClick={() => revoke(c)}
                        disabled={revokingId === c.id}
                        title={`Remove ${c.email} — they lose access immediately`}
                        className="font-body flex items-center gap-1.5 shrink-0 disabled:opacity-40"
                        style={{
                          height: 28,
                          padding: '0 9px',
                          fontSize: 11.5,
                          fontWeight: 600,
                          color: 'var(--color-status-stuck, #DC2626)',
                          border: '1px solid var(--color-border)',
                          borderRadius: 'var(--radius-md)',
                          background: 'transparent',
                        }}
                      >
                        <UserMinus size={11} aria-hidden="true" />
                        {revokingId === c.id ? 'Removing…' : 'Remove'}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <p
          className="font-body"
          style={{ fontSize: 11.5, color: 'var(--color-text-muted)', lineHeight: 1.55 }}
        >
          Everyone here shares one portal link and can open every service on this
          board. The services listed against a person are what they were invited
          for — they decide who gets told about what, not what anyone can see.
        </p>
      </section>
    </div>
  );
};

export default ClientPeoplePanel;
