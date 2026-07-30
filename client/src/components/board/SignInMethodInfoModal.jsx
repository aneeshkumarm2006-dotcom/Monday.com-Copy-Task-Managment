import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, Info } from 'lucide-react';

/**
 * SignInMethodInfoModal — the "what does Google vs password actually mean?"
 * explainer behind the (i) next to the client sign-in choice.
 *
 * Deliberately NOT built on components/ui/Modal: that renders its overlay at
 * z-50, and one of this popup's two parents (ClientPortalModal) hand-rolls its
 * own overlay at z-[200], so a nested ui/Modal would open BEHIND it. This one
 * sits at z-[300] and so works from either parent.
 *
 * Props: onClose — () => void
 */

const heading = {
  fontSize: 13.5,
  fontWeight: 700,
  color: 'var(--color-text-primary)',
  margin: '0 0 4px',
};
const body = {
  fontSize: 13,
  lineHeight: 1.6,
  color: 'var(--color-text-secondary)',
  margin: 0,
};
const block = {
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-md)',
  padding: '12px 14px',
  marginBottom: 10,
};

const SignInMethodInfoModal = ({ onClose }) => {
  const panelRef = useRef(null);

  // Both parents that open this are themselves dialogs listening for Escape on
  // `document` in the BUBBLE phase. Capturing here means we see the key first,
  // so Escape closes this popup instead of the modal underneath it.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    panelRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center px-4"
      style={{ background: 'rgba(0,0,0,0.4)' }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="How your client signs in"
        className="relative w-full max-w-[460px] outline-none"
        style={{
          background: 'var(--color-bg-surface, #FFF)',
          borderRadius: 'var(--radius-xl, 12px)',
          boxShadow: 'var(--shadow-lg, 0 12px 40px rgba(0,0,0,0.18))',
          padding: 24,
          maxHeight: 'calc(100vh - 2rem)',
          overflowY: 'auto',
        }}
      >
        <div className="flex items-start justify-between mb-1">
          <div className="flex items-center gap-2">
            <Info size={16} color="var(--color-accent)" />
            <h2
              className="font-display font-bold"
              style={{ fontSize: 16, color: 'var(--color-text-primary)', margin: 0 }}
            >
              How your client signs in
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex items-center justify-center rounded-md hover:bg-[color:var(--color-bg-subtle)]"
            style={{
              width: 28, height: 28, border: 'none', background: 'transparent',
              cursor: 'pointer', color: 'var(--color-text-secondary)', flexShrink: 0,
            }}
          >
            <X size={16} />
          </button>
        </div>

        <p className="font-body" style={{ ...body, margin: '0 0 16px' }}>
          Choose how this person gets into their portal. You can change it later by inviting them
          again.
        </p>

        <div style={block}>
          <p className="font-body" style={heading}>Google account</p>
          <p className="font-body" style={body}>
            Best when their address ends in <strong>@gmail.com</strong>, or their company runs on
            Google Workspace. They click "Continue with Google" and they're in — nothing to
            remember, nothing to reset.
          </p>
          <p
            className="font-body"
            style={{ ...body, marginTop: 8, fontStyle: 'italic', color: 'var(--color-text-muted)' }}
          >
            Not sure? If they email you from Gmail, or a Google Doc you shared has ever opened for
            them, they're on Google.
          </p>
        </div>

        <div style={block}>
          <p className="font-body" style={heading}>Email &amp; password</p>
          <p className="font-body" style={body}>
            For clients on Outlook, Zoho, a company mail server, or anything else. We email them a
            one-time link to choose their own password. After that they sign in with their email
            and that password, and can reset it themselves.
          </p>
        </div>

        <p
          className="font-body"
          style={{
            fontSize: 12.5,
            lineHeight: 1.6,
            color: 'var(--color-text-muted)',
            margin: '14px 0 0',
          }}
        >
          Both give exactly the same access. Picking the wrong one isn't permanent — just invite
          them again with the other option.
        </p>
      </div>
    </div>,
    document.body
  );
};

export default SignInMethodInfoModal;
