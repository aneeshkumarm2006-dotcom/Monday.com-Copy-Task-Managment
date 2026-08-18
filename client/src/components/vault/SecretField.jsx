import { useEffect, useState } from 'react';
import { Check, Copy, Eye, EyeOff, ExternalLink } from 'lucide-react';
import { copySecret, CLEAR_AFTER_MS } from '../../utils/vaultClipboard';
import useVaultStore from '../../store/vaultStore';

/**
 * One read-only field of a vault item.
 *
 * Masked by default, because the most common way a password leaks is not an
 * attacker — it is a colleague behind you, or a screen share. Revealing is one
 * click and re-masks itself after a while, so a revealed secret cannot be left
 * on screen by walking away.
 *
 * Copy goes through `copySecret`, which takes the value back out of the
 * clipboard afterwards (see utils/vaultClipboard.js for why that matters and
 * why it checks before wiping).
 */

const REVEAL_MS = 30_000;

/**
 * Make a stored URL safe to hand to an anchor.
 *
 * People type "dashboard.stripe.com", not "https://dashboard.stripe.com". A bare
 * host in an href is a RELATIVE path, so the link would navigate this
 * single-page app to a nonexistent route — and because leaving the tab unmounts
 * the vault, it would also lock it. Prefixing https:// is the fix.
 *
 * Everything that is not http(s) returns null and renders no link at all, which
 * is what keeps a `javascript:` URL stored in an item from becoming a clickable
 * script.
 */
const safeHref = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
};

const SecretField = ({
  label,
  value,
  secret = false,
  href = false,
  multiline = false,
}) => {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const touch = useVaultStore((s) => s.touch);

  // Re-mask on a timer. Also re-masks when the value changes underneath (the
  // user edited the item), so an edit never silently exposes the new value.
  useEffect(() => {
    setRevealed(false);
  }, [value]);

  useEffect(() => {
    if (!revealed) return undefined;
    const t = setTimeout(() => setRevealed(false), REVEAL_MS);
    return () => clearTimeout(t);
  }, [revealed]);

  useEffect(() => {
    if (!copied) return undefined;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  if (!value) return null;

  const handleCopy = async () => {
    touch();
    const ok = await copySecret(value);
    if (ok) setCopied(true);
    else setRevealed(true); // clipboard refused — let them select it by hand
  };

  const handleReveal = () => {
    touch();
    setRevealed((r) => !r);
  };

  const shown = secret && !revealed ? '•'.repeat(Math.min(value.length, 24)) : value;
  const link = href ? safeHref(value) : null;

  return (
    <div className="mb-4">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span
          className="font-body font-medium text-[color:var(--color-text-secondary)] text-xs uppercase tracking-wide"
        >
          {label}
        </span>
        <div className="flex items-center gap-1">
          {secret && (
            <button
              type="button"
              onClick={handleReveal}
              aria-label={revealed ? `Hide ${label}` : `Show ${label}`}
              title={revealed ? 'Hide' : 'Show'}
              className="inline-flex items-center justify-center rounded transition-colors hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color:var(--color-accent)]"
              style={{ width: 26, height: 26, color: 'var(--color-text-secondary)' }}
            >
              {revealed ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          )}
          <button
            type="button"
            onClick={handleCopy}
            aria-label={`Copy ${label}`}
            title={
              secret
                ? `Copy — the clipboard clears itself after ${Math.round(CLEAR_AFTER_MS / 1000)}s`
                : 'Copy'
            }
            className="inline-flex items-center justify-center rounded transition-colors hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color:var(--color-accent)]"
            style={{
              width: 26,
              height: 26,
              color: copied ? 'var(--color-status-done)' : 'var(--color-text-secondary)',
            }}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
          {link && (
            <a
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Open ${label}`}
              title="Open"
              className="inline-flex items-center justify-center rounded transition-colors hover:bg-[color:var(--color-bg-subtle)]"
              style={{ width: 26, height: 26, color: 'var(--color-text-secondary)' }}
            >
              <ExternalLink size={14} />
            </a>
          )}
        </div>
      </div>

      <div
        className={[
          'font-body text-[14px] text-[color:var(--color-text-primary)] px-3 py-2.5',
          multiline ? 'whitespace-pre-wrap' : 'truncate',
        ].join(' ')}
        style={{
          background: 'var(--color-bg-subtle)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-md)',
          // A revealed secret in a proportional font invites `l`/`I`/`1` and
          // `0`/`O` transcription errors. Monospace only while it is visible.
          fontFamily: secret && revealed ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : undefined,
          letterSpacing: secret && !revealed ? '0.1em' : undefined,
          minHeight: 40,
        }}
      >
        {shown}
      </div>

      {copied && secret && (
        <p className="mt-1 font-body text-xs text-[color:var(--color-text-muted)]">
          Copied. The clipboard clears itself in {Math.round(CLEAR_AFTER_MS / 1000)} seconds.
        </p>
      )}
    </div>
  );
};

export default SecretField;
