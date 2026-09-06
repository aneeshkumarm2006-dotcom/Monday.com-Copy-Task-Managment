import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/**
 * Modal — centered panel over a 40% dark overlay.
 * See Macan_Design.md Section 6.13.
 *
 * Props: isOpen, onClose, title, children, footer, maxWidth (default 480)
 *
 * Behaviour:
 *   - ESC closes — the TOPMOST open Modal only, so a stacked pair does not
 *     collapse on one press
 *   - Click on overlay closes
 *   - Focus trap within the panel
 *   - Initial focus goes to `[data-autofocus]`, or to whatever inside the panel
 *     already claimed focus (an `autoFocus` field), before it falls back to the
 *     first control
 *   - Scroll lock on <body> while open
 *   - Scale (0.95 → 1) + fade-in 200ms on open
 */

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * The selector matches controls that are not on screen — a `className="hidden"`
 * submit button, anything inside a collapsed section. Left in, one of those
 * becomes the trap's `first`/`last` boundary and Tab escapes past a boundary the
 * user can never reach. getClientRects() is empty for display:none, present for
 * everything that is actually laid out (fixed positioning included, which is why
 * this is not an offsetParent check).
 */
const visibleFocusable = (panel) =>
  Array.from(panel.querySelectorAll(FOCUSABLE_SELECTOR)).filter(
    (el) => el.getClientRects().length > 0
  );

/**
 * Open modals, oldest first. Escape is handled on `document` in the bubble
 * phase, and stopPropagation there cannot stop a sibling listener on the same
 * node — that needs stopImmediatePropagation, which would also silence unrelated
 * app-level keydown listeners. So stacked modals agree among themselves instead:
 * only the last one opened answers Escape, and only it traps Tab.
 */
const openModalStack = [];

const Modal = ({
  isOpen,
  onClose,
  title,
  children,
  footer,
  maxWidth = 480,
  closeOnOverlayClick = true,
  ariaLabel,
}) => {
  const panelRef = useRef(null);
  const previouslyFocusedRef = useRef(null);
  const stackTokenRef = useRef(null);

  // Take a place on the stack for as long as this modal is open. Keyed on
  // `isOpen` alone: the ESC effect below re-runs whenever `onClose` changes
  // identity (most callers pass an inline arrow), and re-pushing there would let
  // a re-rendering modal underneath claim the top spot.
  useEffect(() => {
    if (!isOpen) return undefined;
    const token = {};
    stackTokenRef.current = token;
    openModalStack.push(token);
    return () => {
      const i = openModalStack.indexOf(token);
      if (i !== -1) openModalStack.splice(i, 1);
      stackTokenRef.current = null;
    };
  }, [isOpen]);

  // ESC to close
  useEffect(() => {
    if (!isOpen) return undefined;

    const handleKey = (e) => {
      // Only the topmost modal answers the keyboard; see openModalStack.
      if (openModalStack[openModalStack.length - 1] !== stackTokenRef.current) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose?.();
      } else if (e.key === 'Tab') {
        // Simple focus trap
        const panel = panelRef.current;
        if (!panel) return;
        const focusable = visibleFocusable(panel);
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose]);

  // Scroll lock + initial focus management
  useEffect(() => {
    if (!isOpen) return undefined;

    previouslyFocusedRef.current = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Move focus inside the modal — unless something in there already asked for
    // it. The header renders before the body, so `focusable[0]` is the close X
    // whenever `onClose` is passed; taking it unconditionally blurred any
    // autoFocus'd field 10ms after it was focused and opened the dialog with the
    // caret on its own dismiss control. A field that claimed focus keeps it;
    // `[data-autofocus]` is the way to name one explicitly.
    const t = window.setTimeout(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const requested = panel.querySelector('[data-autofocus]');
      if (requested) {
        requested.focus();
        return;
      }
      const active = document.activeElement;
      if (active && active !== panel && panel.contains(active)) return;
      const focusable = visibleFocusable(panel);
      (focusable[0] || panel).focus();
    }, 10);

    return () => {
      window.clearTimeout(t);
      document.body.style.overflow = previousOverflow;
      if (
        previouslyFocusedRef.current &&
        typeof previouslyFocusedRef.current.focus === 'function'
      ) {
        previouslyFocusedRef.current.focus();
      }
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const handleOverlayMouseDown = (e) => {
    if (!closeOnOverlayClick) return;
    // Only close if the click actually originated on the overlay itself
    if (e.target === e.currentTarget) {
      onClose?.();
    }
  };

  const node = (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel || title || 'Dialog'}
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      onMouseDown={handleOverlayMouseDown}
      style={{
        background: 'var(--color-overlay)',
        animation: 'macan-modal-fade 200ms ease-out',
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="relative w-full bg-white outline-none flex flex-col"
        style={{
          maxWidth,
          maxHeight: 'calc(100vh - 2rem)',
          borderRadius: 'var(--radius-xl)',
          boxShadow: 'var(--shadow-lg)',
          animation: 'macan-modal-scale 200ms ease-out',
        }}
      >
        {/* Header */}
        {(title || onClose) && (
          <div
            className="flex items-center justify-between px-6 shrink-0"
            style={{
              height: 60,
              borderBottom: '1px solid var(--color-border)',
            }}
          >
            {title && (
              <h2
                className="font-display font-semibold text-[color:var(--color-text-primary)]"
                style={{ fontSize: 18 }}
              >
                {title}
              </h2>
            )}
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close dialog"
                className="flex items-center justify-center rounded-md transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
                style={{ width: 32, height: 32 }}
              >
                <X size={18} color="var(--color-text-secondary)" aria-hidden="true" />
              </button>
            )}
          </div>
        )}

        {/* Body */}
        <div className="px-6 py-5 flex-1 min-h-0 overflow-y-auto">{children}</div>

        {/* Footer */}
        {footer && (
          <div
            className="flex items-center justify-end gap-3 px-6 shrink-0"
            style={{
              height: 68,
              borderTop: '1px solid var(--color-border)',
            }}
          >
            {footer}
          </div>
        )}
      </div>

      <style>{`
        @keyframes macan-modal-fade {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        @keyframes macan-modal-scale {
          from { opacity: 0; transform: scale(0.95); }
          to   { opacity: 1; transform: scale(1); }
        }
      `}</style>
    </div>
  );

  return createPortal(node, document.body);
};

export default Modal;
