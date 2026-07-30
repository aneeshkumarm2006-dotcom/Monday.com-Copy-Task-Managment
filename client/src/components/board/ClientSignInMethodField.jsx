import { useState } from 'react';
import { Info } from 'lucide-react';
import SignInMethodInfoModal from './SignInMethodInfoModal';

/**
 * ClientSignInMethodField — the "is this a Google account or not?" choice shown
 * wherever a team member types a client's email, plus the (i) explainer.
 *
 * Used by both invite surfaces (the new-group modal and ClientPortalModal) so the
 * control and its wording only exist once.
 *
 * The answer isn't cosmetic: 'password' registers the address on the server and
 * is what authorises it to use the portal's password form at all.
 *
 * Props:
 *   value    — 'google' | 'password'
 *   onChange — (next) => void
 *   disabled — optional
 */

const OPTIONS = [
  { value: 'google', label: 'Google account', hint: 'Gmail or Google Workspace' },
  { value: 'password', label: 'Email & password', hint: 'Outlook, Zoho, anything else' },
];

const ClientSignInMethodField = ({ value = 'google', onChange, disabled = false }) => {
  const [infoOpen, setInfoOpen] = useState(false);

  return (
    <div>
      <div className="flex items-center gap-1.5" style={{ marginBottom: 6 }}>
        <span
          className="font-body"
          style={{
            fontSize: 11,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            color: 'var(--color-text-muted)',
          }}
        >
          How they sign in
        </span>
        <button
          type="button"
          onClick={() => setInfoOpen(true)}
          aria-label="About the sign-in options"
          title="Which should I pick?"
          className="flex items-center justify-center rounded-full hover:bg-[color:var(--color-bg-subtle)]"
          style={{
            width: 18, height: 18, border: 'none', background: 'transparent',
            cursor: 'pointer', color: 'var(--color-text-muted)', padding: 0,
          }}
        >
          <Info size={13} />
        </button>
      </div>

      <div role="radiogroup" aria-label="How they sign in" style={{ display: 'flex', gap: 8 }}>
        {OPTIONS.map((opt) => {
          const selected = value === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              onClick={() => onChange?.(opt.value)}
              className="font-body text-left"
              style={{
                flex: 1,
                padding: '9px 11px',
                border: `1.5px solid ${selected ? 'var(--color-accent)' : 'var(--color-border)'}`,
                borderRadius: 'var(--radius-md)',
                background: selected ? 'var(--color-accent-light, #EFF6FF)' : 'transparent',
                cursor: disabled ? 'not-allowed' : 'pointer',
                opacity: disabled ? 0.6 : 1,
                transition: 'border-color 0.15s ease, background 0.15s ease',
              }}
            >
              <span
                style={{
                  display: 'block',
                  fontSize: 13,
                  fontWeight: 600,
                  color: selected ? 'var(--color-accent)' : 'var(--color-text-primary)',
                }}
              >
                {opt.label}
              </span>
              <span
                style={{
                  display: 'block',
                  fontSize: 11.5,
                  marginTop: 1,
                  color: 'var(--color-text-muted)',
                }}
              >
                {opt.hint}
              </span>
            </button>
          );
        })}
      </div>

      {infoOpen && <SignInMethodInfoModal onClose={() => setInfoOpen(false)} />}
    </div>
  );
};

export default ClientSignInMethodField;
