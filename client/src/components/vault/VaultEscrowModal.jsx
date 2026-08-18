import { useEffect, useState } from 'react';
import { Building2, TriangleAlert } from 'lucide-react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import Input from '../ui/Input';
import useVaultStore from '../../store/vaultStore';
import useToastStore from '../../store/toastStore';

/**
 * Cover this vault with the workspace break-glass key, or stop covering it.
 *
 * TURNING IT ON asks for the vault password even though the vault is already
 * open, and that is deliberate. Producing the escrow wrap needs raw VK, and the
 * store's copy is non-extractable by design — so it has to be re-derived from
 * the password. Which is the right bar anyway: adding a SECOND way into a vault
 * should cost proof that you hold the first.
 *
 * The reassuring half, and it is worth saying on screen: switching this on does
 * NOT require the workspace passphrase. Sealing to the org needs only its public
 * key. A board owner can protect their vault against their own forgetfulness
 * without being handed the key to everyone else's.
 *
 * TURNING IT OFF asks for nothing. It removes a way in rather than adding one,
 * and a board's own administrators may always decline the workspace key.
 */

const VaultEscrowModal = ({ isOpen, boardId, escrow, onClose, onChanged }) => {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const setEscrow = useVaultStore((s) => s.setEscrow);
  const session = useVaultStore((s) => s.session);
  const toastSuccess = useToastStore((s) => s.success);

  const enabled = !!escrow?.enabled;
  const stale = !!escrow?.stale;

  useEffect(() => {
    if (!isOpen) return;
    setPassword('');
    setError(null);
    setBusy(false);
  }, [isOpen]);

  // Whatever door is holding this session is what has to be re-proved — the same
  // rule the password change follows.
  const secretLabel =
    session?.kind === 'recovery'
      ? 'Recovery key'
      : session?.kind === 'escrow'
        ? 'Workspace recovery passphrase'
        : 'Vault password';

  const apply = async (next) => {
    setBusy(true);
    setError(null);
    try {
      await setEscrow(boardId, {
        enabled: next,
        currentSecret: password,
        publicKey: escrow?.publicKey,
      });
      setPassword('');
      onChanged?.();
      toastSuccess(
        next
          ? 'This vault is now covered by the workspace recovery key.'
          : 'The workspace recovery key no longer covers this vault.'
      );
      onClose?.();
    } catch (err) {
      setError(err?.response?.data?.error || err?.message || 'Could not change this.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Workspace recovery key"
      maxWidth={480}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          {enabled && !stale ? (
            <Button variant="danger" onClick={() => apply(false)} disabled={busy}>
              {busy ? 'Removing…' : 'Stop covering this vault'}
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={() => apply(true)}
              disabled={busy || !password.trim()}
            >
              {busy ? 'Sealing…' : 'Cover this vault'}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-2">
          <Building2
            size={18}
            color="var(--color-accent)"
            aria-hidden="true"
            className="shrink-0 mt-0.5"
          />
          <p className="font-body text-sm text-[color:var(--color-text-secondary)]">
            {enabled && !stale ? (
              <>
                This vault is covered. Someone holding the workspace recovery
                passphrase can open it if this board&rsquo;s password and recovery
                key are both lost.
              </>
            ) : (
              <>
                Covering this vault lets someone holding the workspace recovery
                passphrase open it if this board&rsquo;s password and recovery key
                are both lost. You do <strong>not</strong> need that passphrase
                yourself to switch this on.
              </>
            )}
          </p>
        </div>

        {stale && (
          <div
            className="flex items-start gap-2 p-3 font-body text-sm"
            style={{
              background: 'var(--color-status-working-bg)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
              color: 'var(--color-text-secondary)',
            }}
          >
            <TriangleAlert
              size={16}
              color="var(--color-status-working)"
              aria-hidden="true"
              className="shrink-0 mt-0.5"
            />
            <span>
              This vault was sealed to an older workspace key that no longer
              exists, so the cover does not work. Re-seal it below.
            </span>
          </div>
        )}

        {(!enabled || stale) && (
          <>
            <Input
              label={secretLabel}
              type={session?.kind === 'recovery' ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••"
              autoComplete="off"
              spellCheck={false}
              helperText="Needed to re-derive this vault's key so it can be sealed to the workspace."
              required
              autoFocus
            />
            <p
              className="font-body text-xs"
              style={{ color: 'var(--color-text-muted)' }}
            >
              Worth knowing before you switch it on: the workspace passphrase
              opens every vault that has been covered, so its reach is the whole
              organisation rather than this one board.
            </p>
          </>
        )}

        {error && (
          <p
            className="font-body text-sm"
            style={{ color: 'var(--color-status-stuck)' }}
            role="alert"
          >
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
};

export default VaultEscrowModal;
