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

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const SignInMethodInfoModal = ({ onClose }) => {
  const panelRef = useRef(null);

  // Every parent that opens this is itself a dialog listening on `document` in
  // the BUBBLE phase. Capturing here means we see the key first, so Escape
  // closes this popup instead of the modal underneath it — and Tab is trapped
  // here rather than by the parent, whose own trap measures against ITS panel:
  // this popup lives in a different portal subtree, so the parent's first/last
  // checks never match and Tab would walk into the form its overlay is hiding.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      e.stopPropagation();
      // getClientRects() is the display:none filter — a hidden control must not
      // become a trap boundary, or Tab silently escapes through it.
      const focusable = Array.from(panel.querySelectorAll(FOCUSABLE_SELECTOR)).filter(
        (el) => el.getClientRects().length > 0
      );
      if (focusable.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      // The panel itself holds focus on open (tabIndex -1), and Shift+Tab from
      // there would walk backwards into the dialog this overlay is covering, so
      // it counts as outside.
      if (!panel.contains(active) || active === panel) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  // Focus in on mount, back to the (i) button on unmount. Kept in its own
  // mount-only effect: every caller passes an inline `onClose`, so the effect
  // above re-runs on each parent render and restoring focus there would yank it
  // out of this popup mid-read.
  useEffect(() => {
    const previouslyFocused = document.activeElement;
    panelRef.current?.focus();
    return () => {
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
        previouslyFocused.focus();
      }
    };
  }, []);

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
