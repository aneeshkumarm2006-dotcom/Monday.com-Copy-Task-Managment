import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Copy, Check, Link2, RefreshCw, Loader2, Mail, Send } from 'lucide-react';
import {
  getGroupPortalConfig,
  saveGroupPortalConfig,
  sendGroupInvite,
} from '../../services/boardService';

/**
 * ClientPortalModal — manage the shareable client link for one group of a Client
 * Portal board. The link is minted when the group is created, so this modal is
 * about SHARING it: copy the link, or email an invitation. Only rendered for
 * board managers (BoardDetailPage gates on canManageAccess); the server enforces
 * it too.
 *
 * Props:
 *   groupId, groupName — the group being configured
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

const ClientPortalModal = ({ groupId, groupName, onClose }) => {
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState(null);
  const [clientName, setClientName] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const [faqs, setFaqs] = useState([]);
  const [inviteEmail, setInviteEmail] = useState('');
  const [saving, setSaving] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [error, setError] = useState('');
  const [savedMsg, setSavedMsg] = useState('');
  const [copied, setCopied] = useState(false);

  const load = async () => {
    try {
      const c = await getGroupPortalConfig(groupId);
      setConfig(c);
      setClientName(c.clientName || '');
      setAnnouncement(c.announcement || '');
      setFaqs(Array.isArray(c.faqs) ? c.faqs : []);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load portal settings.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId]);

  const flash = (msg) => {
    setSavedMsg(msg);
    setTimeout(() => setSavedMsg(''), 2500);
  };

  const save = async (patch, successMsg = 'Saved.') => {
    setSaving(true);
    setError('');
    setSavedMsg('');
    try {
      const c = await saveGroupPortalConfig(groupId, patch);
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
      const data = await sendGroupInvite(groupId, email);
      if (data.portal) setConfig(data.portal);
      setInviteEmail('');
      flash(data.message || 'Invitation sent.');
    } catch (err) {
      setError(err.response?.data?.error || 'Could not send the invitation. Please try again.');
    } finally {
      setInviting(false);
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
          Share the portal for <strong>{groupName}</strong> so this client can raise issues — copy the link or email an invitation.
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
                placeholder={groupName}
                onBlur={() => {
                  if ((clientName.trim() || '') !== (config?.clientName || '')) {
                    save({ clientName: clientName.trim() }, 'Client name saved.');
                  }
                }}
              />
            </div>

            {/* Shareable link */}
            {config?.link && (
              <div style={{ marginBottom: 16 }}>
                <label style={label}>Shareable link</label>
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

            {/* Email an invitation */}
            <div style={{ marginBottom: 16 }}>
              <label style={label}>Email an invitation</label>
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
            </div>

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

            {/* Link controls */}
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
          </>
        )}
      </div>
    </div>,
    document.body
  );
};

export default ClientPortalModal;
