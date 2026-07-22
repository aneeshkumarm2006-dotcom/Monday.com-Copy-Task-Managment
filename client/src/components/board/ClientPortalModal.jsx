import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Copy, Check, Link2, RefreshCw, Loader2, Lock } from 'lucide-react';
import {
  getGroupPortalConfig,
  saveGroupPortalConfig,
} from '../../services/boardService';

/**
 * ClientPortalModal — manage the shareable client link for one group of a Client
 * Portal board. Mirrors InviteModal's copy-link pattern. Only rendered for board
 * managers (BoardDetailPage gates on canManageAccess); the server enforces it too.
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

const ClientPortalModal = ({ groupId, groupName, onClose }) => {
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState(null);
  const [clientName, setClientName] = useState('');
  const [passcode, setPasscode] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [savedMsg, setSavedMsg] = useState('');
  const [copied, setCopied] = useState(false);

  const load = async () => {
    try {
      const c = await getGroupPortalConfig(groupId);
      setConfig(c);
      setClientName(c.clientName || '');
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

  const save = async (patch, successMsg = 'Saved.') => {
    setSaving(true);
    setError('');
    setSavedMsg('');
    try {
      const c = await saveGroupPortalConfig(groupId, patch);
      setConfig(c);
      setClientName(c.clientName || '');
      setPasscode('');
      setSavedMsg(successMsg);
      setTimeout(() => setSavedMsg(''), 2500);
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

  const handleEnable = async () => {
    if (!passcode.trim()) {
      setError('Set a passcode to share with your client before enabling.');
      return;
    }
    await save(
      { enabled: true, passcode: passcode.trim(), clientName: clientName.trim() },
      'Client link enabled.'
    );
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
          Share a private portal for <strong>{groupName}</strong> so this client can raise issues.
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
              />
            </div>

            {/* Passcode */}
            <div style={{ marginBottom: 16 }}>
              <label style={label}>
                {config?.passcodeSet ? 'Reset passcode (optional)' : 'Passcode'}
              </label>
              <div style={{ ...field, display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px', height: 40 }}>
                <Lock size={14} color="var(--color-text-muted)" />
                <input
                  style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', fontSize: 14, color: 'var(--color-text-primary)' }}
                  value={passcode}
                  onChange={(e) => setPasscode(e.target.value)}
                  placeholder={config?.passcodeSet ? 'Leave blank to keep current' : 'Choose a passcode'}
                  autoComplete="off"
                />
              </div>
            </div>

            {/* Link (once enabled) */}
            {enabled && config?.link && (
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

            {/* Actions */}
            <div className="flex items-center gap-2" style={{ marginTop: 4 }}>
              {!enabled ? (
                <button
                  type="button" onClick={handleEnable} disabled={saving}
                  style={{ flex: 1, height: 40, border: 'none', borderRadius: 'var(--radius-md)', background: 'var(--color-accent)', color: '#FFF', fontSize: 14, fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1 }}
                >
                  {saving ? 'Enabling…' : 'Enable client link'}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => save({
                      clientName: clientName.trim(),
                      ...(passcode.trim() ? { passcode: passcode.trim() } : {}),
                    }, 'Changes saved.')}
                    disabled={saving}
                    style={{ flex: 1, height: 40, border: 'none', borderRadius: 'var(--radius-md)', background: 'var(--color-accent)', color: '#FFF', fontSize: 14, fontWeight: 600, cursor: 'pointer', opacity: saving ? 0.7 : 1 }}
                  >
                    {saving ? 'Saving…' : 'Save changes'}
                  </button>
                  <button
                    type="button" onClick={() => save({ regenerateLink: true }, 'New link generated.')} disabled={saving}
                    title="Generate a new link and invalidate the old one"
                    className="flex items-center gap-1.5"
                    style={{ height: 40, padding: '0 12px', border: '1.5px solid var(--color-border)', borderRadius: 'var(--radius-md)', background: 'transparent', color: 'var(--color-text-secondary)', fontSize: 13, cursor: 'pointer' }}
                  >
                    <RefreshCw size={14} /> Rotate
                  </button>
                  <button
                    type="button" onClick={() => save({ enabled: false }, 'Client link disabled.')} disabled={saving}
                    style={{ height: 40, padding: '0 12px', border: '1.5px solid var(--color-border)', borderRadius: 'var(--radius-md)', background: 'transparent', color: 'var(--color-status-stuck, #dc2626)', fontSize: 13, cursor: 'pointer' }}
                  >
                    Disable
                  </button>
                </>
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
