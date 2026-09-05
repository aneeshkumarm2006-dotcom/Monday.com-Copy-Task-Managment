import { useCallback, useEffect, useState } from 'react';
import { Mail, RefreshCw } from 'lucide-react';
import InvitePeopleTable from './InvitePeopleTable';
import {
  getBoardPortalContacts,
  resendPortalInvite,
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
  const [submitting, setSubmitting] = useState(false);
  const [resendingId, setResendingId] = useState(null);
  const currentOrg = useOrgStore((s) => s.currentOrg);
  const toast = useToastStore.getState();

  const load = useCallback(async () => {
    try {
      const res = await getBoardPortalContacts(boardId);
      setContacts(res?.contacts || res || []);
    } catch {
      setContacts([]);
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
          People with access ({contacts.length})
        </h2>

        {loading ? (
          <p className="font-body" style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}>
            Loading…
          </p>
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
                    <button
                      type="button"
                      onClick={() => resend(c.id)}
                      disabled={resendingId === c.id}
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
