import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Copy, Check, Link2, RefreshCw, Loader2, Mail, Send, KeyRound, Users, AlertCircle, Plus } from 'lucide-react';
import {
  getBoardPortalConfig,
  saveBoardPortalConfig,
  sendBoardPortalInvite,
  getBoardPortalContacts,
  resendPortalInvite,
} from '../../services/boardService';
import ClientSignInMethodField from './ClientSignInMethodField';

/**
 * ClientPortalModal — manage the shareable client link for a Client Portal
 * BOARD. The board IS the client company, and its groups are that client's
 * SERVICES. Only rendered for board managers (BoardDetailPage gates on
 * canManageAccess); the server enforces it too.
 *
 * ---- THERE IS NOT ALWAYS A LINK TO SHARE ----------------------------------
 *
 * A client board used to mint its link at creation, so this modal could assume
 * one existed. It no longer does: a board with no SERVICES has nothing for a
 * client to look at — the portal renders "Your portal is being set up" and there
 * is no request to raise — so the link is minted by the FIRST SERVICE instead.
 *
 * That gives this modal a third state, which `config.hasServices` is what
 * distinguishes:
 *
 *   hasServices: false  — no link yet. Show what to do, hide the link and the
 *                         invite box. The server refuses both anyway (409
 *                         `PORTAL_NO_SERVICES`); hiding them means nobody has to
 *                         hit that to find out.
 *   portalEnabled: true — live. The ordinary case.
 *   portalEnabled: false — a link exists and was deliberately switched off.
 *
 * Conflating the first two is what would put a dead link back on somebody's
 * clipboard, which is the entire point of the change.
 *
 * Props:
 *   boardId, boardName — the client board being configured
 *   onAddService       — optional; opens the add-a-service modal from the
 *                        empty state, so the fix is one click from the problem
 *   onClose            — () => void
 */
const label = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: 'var(--color-text-muted)',
  marginBottom: 6,
  display: 'block',
};
const field = {
  width: '100%',
  border: '1.5px solid var(--color-border)',
  borderRadius: 'var(--radius-md)',
  padding: '9px 12px',
  fontSize: 14,
  color: 'var(--color-text-primary)',
  background: 'var(--color-bg-input)',
  outline: 'none',
  boxSizing: 'border-box',
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Relative "last seen", short enough for a table cell. */
const timeAgo = (iso) => {
  if (!iso) return '—';
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
};

/**
 * Where a contact is in the join process. Three states the team actually cares
 * about: still outstanding, waiting on the client to pick a password, or in.
 */
const contactState = (c) => {
  if (c.verified) return { label: `Active · ${timeAgo(c.lastSeenAt)}`, color: 'var(--color-success, #16a34a)' };
  if (c.authMethod === 'password' && !c.hasPassword) {
    return { label: 'Password not set', color: 'var(--color-status-stuck, #dc2626)' };
  }
  return { label: 'Invited', color: 'var(--color-text-muted)' };
};

const ClientPortalModal = ({ boardId, boardName, onAddService, onClose }) => {
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState(null);
  const [clientName, setClientName] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const [faqs, setFaqs] = useState([]);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteMethod, setInviteMethod] = useState('google');
  const [contacts, setContacts] = useState([]);
  const [resendingId, setResendingId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [error, setError] = useState('');
  const [savedMsg, setSavedMsg] = useState('');
  const [copied, setCopied] = useState(false);

  const load = async () => {
    try {
      // Both come from the same manage-gated endpoints; the contact list is
      // secondary, so a failure there must not blank the whole modal.
      const [c, people] = await Promise.all([
        getBoardPortalConfig(boardId),
        getBoardPortalContacts(boardId).catch(() => []),
      ]);
      setConfig(c);
      setClientName(c.clientName || '');
      setAnnouncement(c.announcement || '');
      setFaqs(Array.isArray(c.faqs) ? c.faqs : []);
      setContacts(Array.isArray(people) ? people : []);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load portal settings.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardId]);

  const flash = (msg) => {
    setSavedMsg(msg);
    setTimeout(() => setSavedMsg(''), 2500);
  };

  const save = async (patch, successMsg = 'Saved.') => {
    setSaving(true);
    setError('');
    setSavedMsg('');
    try {
      const c = await saveBoardPortalConfig(boardId, patch);
      setConfig(c);
      setClientName(c.clientName || '');
      flash(successMsg);
      return c;
    } catch (err) {
      setError(
        err.code === 'ECONNABORTED'
          ? 'The server took too long to respond. Please try again.'
          : err.response?.data?.error || 'Could not save. Please try again.'
      );
      return null;
    } finally {
      setSaving(false);
    }
  };

  const handleSendInvite = async () => {
    const email = inviteEmail.trim();
    if (!EMAIL_RE.test(email)) {
      setError('Enter a valid email address to send the invitation.');
      return;
    }
    setInviting(true);
    setError('');
    setSavedMsg('');
    try {
      const data = await sendBoardPortalInvite(boardId, email, inviteMethod);
      if (data.portal) setConfig(data.portal);
      if (Array.isArray(data.contacts)) setContacts(data.contacts);
      setInviteEmail('');
      flash(data.message || 'Invitation sent.');
    } catch (err) {
      setError(err.response?.data?.error || 'Could not send the invitation. Please try again.');
    } finally {
      setInviting(false);
    }
  };

  const handleResend = async (contactId) => {
    setResendingId(contactId);
    setError('');
    setSavedMsg('');
    try {
      const data = await resendPortalInvite(boardId, contactId);
      if (Array.isArray(data.contacts)) setContacts(data.contacts);
      flash(data.message || 'Email sent.');
    } catch (err) {
      setError(err.response?.data?.error || 'Could not send the email. Please try again.');
    } finally {
      setResendingId(null);
    }
  };

  const handleCopy = () => {
    if (!config?.link) return;
    navigator.clipboard.writeText(config.link).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const enabled = !!config?.portalEnabled;
  // The server is the authority. `hasServices` comes back on every portal
  // payload precisely so this modal never has to guess from `link` being null —
  // which cannot tell "no service yet" apart from a board loaded without the
  // token projection.
  const hasServices = !!config?.hasServices;

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.4)' }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="relative w-full max-w-[460px] mx-4"
        style={{
          background: 'var(--color-bg-surface, #FFF)',
          borderRadius: 'var(--radius-xl, 12px)',
          boxShadow: 'var(--shadow-md, 0 8px 32px rgba(0,0,0,0.16))',
          padding: 28,
        }}
      >
        <div className="flex items-center justify-between mb-1">
          <h2 className="font-display font-bold" style={{ fontSize: 17, color: 'var(--color-text-primary)', margin: 0 }}>
            Client link
          </h2>
          <button
            type="button" onClick={onClose} aria-label="Close"
            className="flex items-center justify-center rounded-md hover:bg-[color:var(--color-bg-subtle)]"
            style={{ width: 28, height: 28, border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--color-text-secondary)' }}
          >
            <X size={16} />
          </button>
        </div>
        <p className="font-body" style={{ fontSize: 13, color: 'var(--color-text-secondary)', margin: '0 0 20px' }}>
          The portal for <strong>{boardName}</strong> — what the client sees, and who
          can get in. The link exists once this board has a service on it.
        </p>

        {loading ? (
          <div style={{ textAlign: 'center', padding: 24 }}>
            <Loader2 size={22} className="animate-spin" color="var(--color-accent)" />
          </div>
        ) : (
          <>
            {/* Client label */}
            <div style={{ marginBottom: 16 }}>
              <label style={label}>Client name (shown to the client)</label>
              <input
                style={field}
                value={clientName}
                onChange={(e) => setClientName(e.target.value)}
                placeholder={boardName}
                onBlur={() => {
                  if ((clientName.trim() || '') !== (config?.clientName || '')) {
                    save({ clientName: clientName.trim() }, 'Client name saved.');
                  }
                }}
              />
            </div>

            {/* ---- No services yet: there is no link, and that is the point ----
                Shown INSTEAD of the link and the invite box, with the one action
                that fixes it. */}
            {!hasServices && (
              <div
                style={{
                  marginBottom: 16,
                  padding: 14,
                  border: '1px dashed var(--color-border-strong, #C8C5BE)',
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--color-bg-subtle)',
                }}
              >
                <div className="flex items-center gap-1.5" style={{ marginBottom: 6 }}>
                  <AlertCircle size={14} color="var(--color-text-muted)" aria-hidden="true" />
                  <span
                    className="font-body"
                    style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-text-primary)' }}
                  >
                    No link yet
                  </span>
                </div>
                <p
                  className="font-body"
                  style={{
                    fontSize: 12.5,
                    lineHeight: 1.55,
                    color: 'var(--color-text-secondary)',
                    margin: 0,
                  }}
                >
                  This board has no services, so there is nothing for {boardName} to
                  open. Adding the first service creates their portal link and sends
                  their invitation.
                </p>
                {onAddService && (
                  <button
                    type="button"
                    onClick={() => {
                      onClose();
                      onAddService();
                    }}
                    className="font-body flex items-center gap-1.5"
                    style={{
                      marginTop: 10,
                      height: 32,
                      padding: '0 12px',
                      fontSize: 12.5,
                      fontWeight: 600,
                      color: '#FFFFFF',
                      background: 'var(--color-accent)',
                      border: 'none',
                      borderRadius: 'var(--radius-md)',
                      cursor: 'pointer',
                    }}
                  >
                    <Plus size={13} aria-hidden="true" />
                    Add a service
                  </button>
                )}
              </div>
            )}

            {/* Shareable link */}
            {hasServices && config?.link && (
              <div style={{ marginBottom: 16 }}>
                <label style={label}>
                  Shareable link
                  {/* A disabled portal still HAS a link, and it is still
                      copyable — the team may want it on file. But copying it
                      without knowing it is switched off is how a client gets
                      sent a URL that answers 404, so the state is named right
                      where the Copy button is. */}
                  {!enabled && (
                    <span
                      style={{
                        marginLeft: 6,
                        textTransform: 'none',
                        letterSpacing: 0,
                        fontWeight: 600,
                        color: 'var(--color-status-stuck, #dc2626)',
                      }}
                    >
                      · switched off, this link will not open
                    </span>
                  )}
                </label>
                <div style={{ ...field, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Link2 size={14} color="var(--color-text-muted)" />
                  <span className="truncate select-all" style={{ flex: 1, fontSize: 12.5, color: 'var(--color-text-secondary)' }}>
                    {config.link}
                  </span>
                  <button
                    type="button" onClick={handleCopy}
                    className="flex items-center gap-1 shrink-0"
                    style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, color: copied ? '#16a34a' : 'var(--color-accent)' }}
                  >
                    {copied ? <Check size={13} /> : <Copy size={13} />}
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </div>
            )}

            {/* Email an invitation. Hidden until there is a portal to invite
                somebody INTO — the server answers 409 PORTAL_NO_SERVICES
                otherwise, and a form whose only outcome is that error is worse
                than no form. */}
            {hasServices && (
            <div style={{ marginBottom: 16 }}>
              <label style={label}>Email an invitation</label>
              <div style={{ marginBottom: 10 }}>
                <ClientSignInMethodField
                  value={inviteMethod}
                  onChange={setInviteMethod}
                  disabled={inviting}
                />
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ ...field, flex: 1, display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px', height: 40 }}>
                  <Mail size={14} color="var(--color-text-muted)" />
                  <input
                    style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', fontSize: 14, color: 'var(--color-text-primary)' }}
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    placeholder="client@company.com"
                    type="email"
                    autoComplete="off"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleSendInvite();
                    }}
                  />
                </div>
                <button
                  type="button" onClick={handleSendInvite} disabled={inviting}
                  className="flex items-center gap-1.5 shrink-0"
                  style={{ height: 40, padding: '0 14px', border: 'none', borderRadius: 'var(--radius-md)', background: 'var(--color-accent)', color: '#FFF', fontSize: 13, fontWeight: 600, cursor: inviting ? 'not-allowed' : 'pointer', opacity: inviting ? 0.7 : 1 }}
                >
                  <Send size={14} /> {inviting ? 'Sending…' : 'Send'}
                </button>
              </div>
              <p
                className="font-body"
                style={{ fontSize: 11.5, color: 'var(--color-text-muted)', margin: '6px 0 0', lineHeight: 1.5 }}
              >
                {inviteMethod === 'password'
                  ? "They'll get a one-time link to choose a password, then sign in with their email."
                  : "They'll get the portal link and sign in with Google."}
              </p>
            </div>
            )}

            {/* Who's been invited, and how far they've got */}
            {contacts.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <label style={{ ...label, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Users size={12} /> People with access
                </label>
                <div
                  style={{
                    border: '1px solid var(--color-border)',
                    borderRadius: 'var(--radius-md)',
                    overflow: 'hidden',
                  }}
                >
                  {contacts.map((c, i) => {
                    const state = contactState(c);
                    const isPassword = c.authMethod === 'password';
                    return (
                      <div
                        key={c.id}
                        className="flex items-center gap-2"
                        style={{
                          padding: '9px 11px',
                          borderTop: i === 0 ? 'none' : '1px solid var(--color-border)',
                        }}
                      >
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div
                            className="truncate"
                            style={{ fontSize: 13, color: 'var(--color-text-primary)', fontWeight: 500 }}
                            title={c.email}
                          >
                            {c.email}
                          </div>
                          <div
                            className="flex items-center gap-1.5"
                            style={{ fontSize: 11.5, color: state.color, marginTop: 1 }}
                          >
                            {isPassword ? <KeyRound size={11} /> : <Mail size={11} />}
                            <span style={{ color: 'var(--color-text-muted)' }}>
                              {isPassword ? 'Password' : 'Google'}
                            </span>
                            <span style={{ color: 'var(--color-border-strong, #C8C5BE)' }}>·</span>
                            <span>{state.label}</span>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleResend(c.id)}
                          disabled={resendingId === c.id}
                          title={
                            isPassword && c.hasPassword
                              ? 'Email a password reset link'
                              : isPassword
                              ? 'Re-send the set-password link'
                              : 'Re-send the invitation'
                          }
                          className="shrink-0"
                          style={{
                            background: 'none',
                            border: 'none',
                            cursor: resendingId === c.id ? 'wait' : 'pointer',
                            fontSize: 12,
                            fontWeight: 600,
                            color: 'var(--color-accent)',
                            padding: '4px 2px',
                          }}
                        >
                          {resendingId === c.id
                            ? 'Sending…'
                            : isPassword && c.hasPassword
                            ? 'Reset'
                            : 'Resend'}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Announcement banner shown to all clients on this board */}
            <div style={{ marginBottom: 16 }}>
              <label style={label}>Announcement (shown to every client)</label>
              <textarea
                style={{ ...field, minHeight: 58, resize: 'vertical' }}
                value={announcement}
                onChange={(e) => setAnnouncement(e.target.value)}
                placeholder="e.g. We're on reduced hours this Friday — replies may be slower."
                onBlur={() => {
                  if ((announcement.trim() || '') !== (config?.announcement || '')) {
                    save({ announcement: announcement.trim() }, 'Announcement saved.');
                  }
                }}
              />
            </div>

            {/* FAQ / knowledge base */}
            <div style={{ marginBottom: 16 }}>
              <label style={label}>Help &amp; FAQs (shown in the portal)</label>
              {faqs.map((f, i) => (
                <div key={i} style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: 10, marginBottom: 8 }}>
                  <input
                    style={{ ...field, marginBottom: 6 }}
                    placeholder="Question"
                    value={f.q || ''}
                    onChange={(e) => setFaqs((prev) => prev.map((x, j) => (j === i ? { ...x, q: e.target.value } : x)))}
                  />
                  <textarea
                    style={{ ...field, minHeight: 46, resize: 'vertical' }}
                    placeholder="Answer"
                    value={f.a || ''}
                    onChange={(e) => setFaqs((prev) => prev.map((x, j) => (j === i ? { ...x, a: e.target.value } : x)))}
                  />
                  <button
                    type="button"
                    onClick={() => setFaqs((prev) => prev.filter((_, j) => j !== i))}
                    style={{ marginTop: 6, background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, color: 'var(--color-status-stuck, #dc2626)' }}
                  >
                    Remove
                  </button>
                </div>
              ))}
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  onClick={() => setFaqs((prev) => [...prev, { q: '', a: '' }])}
                  style={{ height: 34, padding: '0 12px', border: '1.5px solid var(--color-border)', borderRadius: 'var(--radius-md)', background: 'transparent', color: 'var(--color-text-secondary)', fontSize: 13, cursor: 'pointer' }}
                >
                  + Add FAQ
                </button>
                <button
                  type="button"
                  onClick={() => save({ faqs }, 'FAQs saved.')}
                  disabled={saving}
                  style={{ height: 34, padding: '0 14px', border: 'none', borderRadius: 'var(--radius-md)', background: 'var(--color-accent)', color: '#FFF', fontSize: 13, fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1 }}
                >
                  Save FAQs
                </button>
              </div>
            </div>

            {error && (
              <p className="font-body" style={{ fontSize: 13, color: 'var(--color-status-stuck, #dc2626)', margin: '0 0 14px' }}>
                {error}
              </p>
            )}
            {savedMsg && !error && (
              <p className="font-body" style={{ fontSize: 13, color: 'var(--color-success, #16a34a)', margin: '0 0 14px' }}>
                {savedMsg}
              </p>
            )}

            {/* Link controls. Rotating or enabling a portal with nothing in it
                is refused server-side (409 PORTAL_NO_SERVICES), so the whole row
                waits for the first service. Everything above — the client name,
                the announcement, the FAQ — stays editable meanwhile. */}
            {hasServices && (
            <div className="flex items-center gap-2" style={{ marginTop: 4 }}>
              <button
                type="button" onClick={() => save({ regenerateLink: true }, 'New link generated.')} disabled={saving}
                title="Generate a new link and invalidate the old one"
                className="flex items-center gap-1.5"
                style={{ height: 40, padding: '0 12px', border: '1.5px solid var(--color-border)', borderRadius: 'var(--radius-md)', background: 'transparent', color: 'var(--color-text-secondary)', fontSize: 13, cursor: saving ? 'not-allowed' : 'pointer' }}
              >
                <RefreshCw size={14} /> Rotate link
              </button>
              <div style={{ flex: 1 }} />
              {enabled ? (
                <button
                  type="button" onClick={() => save({ enabled: false }, 'Client link disabled.')} disabled={saving}
                  style={{ height: 40, padding: '0 12px', border: '1.5px solid var(--color-border)', borderRadius: 'var(--radius-md)', background: 'transparent', color: 'var(--color-status-stuck, #dc2626)', fontSize: 13, cursor: 'pointer' }}
                >
                  Disable link
                </button>
              ) : (
                <button
                  type="button" onClick={() => save({ enabled: true }, 'Client link enabled.')} disabled={saving}
                  style={{ height: 40, padding: '0 16px', border: 'none', borderRadius: 'var(--radius-md)', background: 'var(--color-accent)', color: '#FFF', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: saving ? 0.7 : 1 }}
                >
                  Enable link
                </button>
              )}
            </div>
            )}
          </>
        )}
      </div>
    </div>,
    document.body
  );
};

export default ClientPortalModal;
