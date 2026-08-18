import { useState } from 'react';
import { Building2, KeyRound, Lock } from 'lucide-react';
import Button from '../ui/Button';
import Input from '../ui/Input';
import useVaultStore from '../../store/vaultStore';

/**
 * The lock screen.
 *
 * Up to three doors, and only ever ONE on screen at a time: the vault password,
 * or — each behind a deliberate extra click — this vault's one-time recovery
 * key, or the workspace break-glass key. Offering them together would invite
 * someone to burn a one-time recovery key on a password they merely mistyped.
 *
 * Failures render inline here rather than as a toast, which is why the service
 * sets `suppressErrorToast`: a wrong password is an expected outcome on this
 * screen, not a system error, and the answer belongs next to the field the user
 * is already looking at.
 */

/** Per-door copy, so the three modes cannot drift in what they promise. */
const DOORS = {
  password: {
    lead: 'Enter the vault password. It is not your login password.',
    label: 'Vault password',
  },
  recovery: {
    lead: 'Enter the recovery key you saved when the vault was created.',
    label: 'Recovery key',
  },
  escrow: {
    lead:
      'Enter the workspace recovery passphrase. This is the organisation’s ' +
      'break-glass key, not this board’s password.',
    label: 'Workspace recovery passphrase',
  },
};

const VaultLockScreen = ({ boardId, meta, onUnlocked }) => {
  const [mode, setMode] = useState('password'); // 'password' | 'recovery' | 'escrow'
  const [secret, setSecret] = useState('');

  const unlock = useVaultStore((s) => s.unlock);
  const recover = useVaultStore((s) => s.recover);
  const escrowRecover = useVaultStore((s) => s.escrowRecover);
  const loading = useVaultStore((s) => s.loading);
  const error = useVaultStore((s) => s.error);

  const isRecovery = mode === 'recovery';
  const isEscrow = mode === 'escrow';
  const door = DOORS[mode];

  // Both alternate doors need `vault.manage`: they are administrative acts, not
  // another way to read a vault you were already entitled to read.
  const canRecovery = !!meta?.hasRecovery && !!meta?.canManage;
  const canEscrow = !!meta?.escrow?.enabled && !!meta?.canManage;

  // One field, retyped per mode. Switching doors clears it — a password left in
  // the box would otherwise be submitted as a recovery key and burn an attempt
  // against the lockout counter.
  const switchTo = (next) => {
    setMode(next);
    setSecret('');
    useVaultStore.setState({ error: null });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (loading) return;

    let ok;
    if (isEscrow) ok = await escrowRecover(boardId, secret, meta);
    else if (isRecovery) ok = await recover(boardId, secret, meta);
    else ok = await unlock(boardId, secret, meta);

    if (ok) {
      setSecret('');
      onUnlocked?.();
    }
  };

  const canSubmit = secret.trim().length > 0;

  return (
    <div className="max-w-[420px] mx-auto py-12">
      <div className="flex flex-col items-center text-center mb-6">
        <div
          className="flex items-center justify-center"
          style={{
            width: 52,
            height: 52,
            borderRadius: 'var(--radius-lg)',
            background: 'var(--color-accent-light)',
          }}
        >
          <Lock size={24} strokeWidth={1.75} color="var(--color-accent)" aria-hidden="true" />
        </div>
        <h2 className="mt-3 font-display font-semibold text-[18px] text-[color:var(--color-text-primary)]">
          This vault is locked
        </h2>
        <p className="mt-1.5 font-body text-sm text-[color:var(--color-text-secondary)]">
          {door.lead}
        </p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {isRecovery ? (
          <Input
            label={door.label}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder="A1B2C3-D4E5F6-…"
            autoComplete="off"
            spellCheck={false}
            multiline
            rows={2}
            // Dashes, spaces and case are all stripped before the key is used,
            // so however it was written down will do.
            helperText="Dashes, spaces and capitals do not matter."
            required
            autoFocus
          />
        ) : (
          <Input
            label={door.label}
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder="••••••••••"
            autoComplete="off"
            required
            autoFocus
          />
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

        <Button type="submit" variant="primary" disabled={!canSubmit || loading}>
          {loading ? 'Unlocking…' : 'Unlock'}
        </Button>

        {loading && (
          <p className="text-center font-body text-xs text-[color:var(--color-text-muted)]">
            Deriving the key — this takes a moment by design.
          </p>
        )}
      </form>

      <div className="mt-6 flex flex-col items-center gap-2 text-center">
        {mode !== 'password' && (
          <button
            type="button"
            onClick={() => switchTo('password')}
            className="inline-flex items-center gap-1.5 font-body text-[13px] font-medium hover:underline"
            style={{ color: 'var(--color-accent)' }}
          >
            <Lock size={14} aria-hidden="true" />
            Use the vault password instead
          </button>
        )}

        {canRecovery && !isRecovery && (
          <button
            type="button"
            onClick={() => switchTo('recovery')}
            className="inline-flex items-center gap-1.5 font-body text-[13px] font-medium hover:underline"
            style={{ color: 'var(--color-accent)' }}
          >
            <KeyRound size={14} aria-hidden="true" />
            Use this vault&rsquo;s recovery key
          </button>
        )}

        {canEscrow && !isEscrow && (
          <button
            type="button"
            onClick={() => switchTo('escrow')}
            className="inline-flex items-center gap-1.5 font-body text-[13px] font-medium hover:underline"
            style={{ color: 'var(--color-accent)' }}
          >
            <Building2 size={14} aria-hidden="true" />
            Use the workspace recovery key
          </button>
        )}

        {!canRecovery && !canEscrow && (
          <p className="font-body text-xs text-[color:var(--color-text-muted)]">
            {meta?.hasRecovery || meta?.escrow?.enabled
              ? 'Someone who can manage this vault can open it another way.'
              : 'This vault has no recovery key. The password is the only way in.'}
          </p>
        )}
      </div>
    </div>
  );
};

export default VaultLockScreen;
