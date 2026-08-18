import { useState } from 'react';
import { AlertTriangle, Check, Copy, Download } from 'lucide-react';
import Button from '../ui/Button';
import { saveBlob } from '../../utils/fileUrl';

/**
 * The one-time recovery key, shown once.
 *
 * "Once" is literal and not a UI convention: the key is generated in the
 * browser, used immediately to wrap VK, and then exists only in this component's
 * props. It was never sent anywhere and cannot be re-derived. Navigate away
 * without saving it and the recovery path for this vault is gone — the vault
 * still works, but its only escape hatch is closed.
 *
 * The card is therefore blunt about that, and the confirm button stays disabled
 * until the user has actually copied or downloaded it. A checkbox saying "I have
 * saved this" is easier to click than to mean.
 */

const RecoveryKeyCard = ({ recoveryKey, boardName, onConfirm, confirmLabel = 'I have saved it' }) => {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(recoveryKey);
      setCopied(true);
      setSaved(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Insecure origin or a denied permission. The key is on screen in a
      // selectable block, so this is a degraded path rather than a dead end.
      setSaved(true);
    }
  };

  const handleDownload = () => {
    const body = [
      `Vault recovery key${boardName ? ` — ${boardName}` : ''}`,
      '',
      recoveryKey,
      '',
      'This is the ONLY way back into this vault if the vault password is lost.',
      'It was shown once and is not stored anywhere. Keep it somewhere safe and',
      'offline. Anyone holding it can open the vault.',
      '',
      `Generated ${new Date().toISOString().slice(0, 10)}`,
      '',
    ].join('\n');
    saveBlob(
      new Blob([body], { type: 'text/plain' }),
      `vault-recovery-key${boardName ? `-${boardName.replace(/[^\w-]+/g, '-').toLowerCase()}` : ''}.txt`
    );
    setSaved(true);
  };

  return (
    <div
      className="p-4"
      style={{
        background: 'var(--color-bg-subtle)',
        border: '1.5px solid var(--color-border-strong)',
        borderRadius: 'var(--radius-md)',
      }}
    >
      <div className="flex items-start gap-2 mb-3">
        <AlertTriangle
          size={18}
          color="var(--color-status-working)"
          aria-hidden="true"
          className="shrink-0 mt-0.5"
        />
        <div>
          <h4 className="font-display font-semibold text-[15px] text-[color:var(--color-text-primary)]">
            Save your recovery key now
          </h4>
          <p className="mt-1 font-body text-sm text-[color:var(--color-text-secondary)]">
            You will not see it again. If the vault password is ever lost, this is
            the only way back in — without it the contents are gone permanently.
          </p>
        </div>
      </div>

      <code
        className="block select-all p-3 mb-3 text-[color:var(--color-text-primary)]"
        style={{
          background: '#FFFFFF',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-sm)',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: 13,
          lineHeight: 1.7,
          wordBreak: 'break-all',
        }}
      >
        {recoveryKey}
      </code>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          icon={copied ? Check : Copy}
          onClick={handleCopy}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button size="sm" variant="secondary" icon={Download} onClick={handleDownload}>
          Download
        </Button>
        <div className="flex-1" />
        <Button size="sm" variant="primary" onClick={onConfirm} disabled={!saved}>
          {confirmLabel}
        </Button>
      </div>

      {!saved && (
        <p className="mt-2 font-body text-xs text-[color:var(--color-text-muted)]">
          Copy or download the key to continue.
        </p>
      )}
    </div>
  );
};

export default RecoveryKeyCard;
