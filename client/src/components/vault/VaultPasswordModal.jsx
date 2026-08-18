import { useEffect, useState } from 'react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import Input from '../ui/Input';
import Switch from '../ui/Switch';
import RecoveryKeyCard from './RecoveryKeyCard';
import useVaultStore from '../../store/vaultStore';
import useToastStore from '../../store/toastStore';
import { MIN_PASSWORD_LENGTH, passwordStrength } from '../../utils/vaultCrypto';

/**
 * Changing the vault password — in practice, the offboarding screen. Somebody
 * left the team, so the shared password stops being shared with them.
 *
 * The reassurance on this screen is true and worth stating: nothing inside is
 * re-encrypted. Items are sealed with the vault key, and only the vault key's
 * WRAPPER changes. So this is instant on a vault of five items or five hundred,
 * and there is no half-migrated state it can leave behind.
 *
 * It doubles as the forced step after a recovery-key unlock. In that mode the
 * "current" secret is the recovery key, the modal cannot be dismissed, and the
 * copy says why: the vault is open right now and would be shut for good next
 * time without a new password.
 */

/**
 * What to ask for, per door. A vault opened through the recovery key or the
 * workspace escrow key still has to re-prove SOMETHING before its password
 * changes — just not the password, which by definition nobody has.
 */
const CURRENT_SECRET = {
  password: {
    label: 'Current vault password',
    type: 'password',
    placeholder: '••••••••••',
    opened: 'its password',
  },
  recovery: {
    label: 'Recovery key',
    type: 'text',
    placeholder: 'A1B2C3-D4E5F6-…',
    opened: 'its recovery key',
  },
  escrow: {
    label: 'Workspace recovery passphrase',
    type: 'password',
    placeholder: '••••••••••',
    opened: "the workspace's recovery key",
  },
};

const VaultPasswordModal = ({ isOpen, boardId, boardName, forced = false, onClose, onChanged }) => {
  const [currentSecret, setCurrentSecret] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [rotateRecovery, setRotateRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [newRecoveryKey, setNewRecoveryKey] = useState(null);

  const changePassword = useVaultStore((s) => s.changePassword);
  const session = useVaultStore((s) => s.session);
  const toastSuccess = useToastStore((s) => s.success);

  // Which door is holding this session decides what we must ask them to re-prove.
  // A vault opened by recovery key or by the workspace escrow key cannot be
  // asked for a password nobody knows any more.
  const kind = session?.kind || 'password';
  const viaAlternate = kind !== 'password';
  const current = CURRENT_SECRET[kind] || CURRENT_SECRET.password;

  useEffect(() => {
    if (!isOpen) return;
    setCurrentSecret('');
    setPassword('');
    setConfirm('');
    // Coming in through a non-password door means the recovery key was either
    // just used, or is lost. Either way default to minting a fresh one.
    setRotateRecovery(viaAlternate);
    setError(null);
    setNewRecoveryKey(null);
    setBusy(false);
  }, [isOpen, viaAlternate]);

  const strength = passwordStrength(password);
  const tooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH;
  const mismatch = confirm.length > 0 && confirm !== password;
  const canSubmit =
    currentSecret.trim().length > 0 &&
    password.length >= MIN_PASSWORD_LENGTH &&
    confirm === password &&
    !busy;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const { recoveryKey } = await changePassword(boardId, password, {
        currentSecret,
        rotateRecovery,
      });
      setCurrentSecret('');
      setPassword('');
      setConfirm('');
      onChanged?.();
      if (recoveryKey) {
        setNewRecoveryKey(recoveryKey);
      } else {
        toastSuccess('Vault password changed.');
        onClose?.();
      }
    } catch (err) {
      setError(err?.response?.data?.error || err?.message || 'Could not change the password.');
    } finally {
      setBusy(false);
    }
  };

  // The new recovery key takes over the modal, exactly as at setup: shown once,
  // dismissable only once it has been copied or downloaded.
  if (newRecoveryKey) {
    return (
      <Modal
        isOpen={isOpen}
        onClose={() => {}}
        title="Your new recovery key"
        maxWidth={520}
        closeOnOverlayClick={false}
      >
        <RecoveryKeyCard
          recoveryKey={newRecoveryKey}
          boardName={boardName}
          onConfirm={() => {
            setNewRecoveryKey(null);
            toastSuccess('Vault password changed.');
            onClose?.();
          }}
          confirmLabel="Done"
        />
      </Modal>
    );
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={forced ? () => {} : onClose}
      closeOnOverlayClick={!forced}
      title={forced ? 'Set a new vault password' : 'Change the vault password'}
      maxWidth={480}
      footer={
        <>
          {!forced && (
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
          )}
          <Button variant="primary" onClick={handleSubmit} disabled={!canSubmit}>
            {busy ? 'Changing…' : 'Change password'}
          </Button>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <p className="font-body text-sm text-[color:var(--color-text-secondary)]">
          {forced ? (
            <>
              You opened this vault with {current.opened}, so nobody knows its
              password any more. Choose a new one now — the vault is open at this
              moment and would stay shut afterwards without it.
            </>
          ) : (
            <>
              Everyone who uses this vault will need the new password. Nothing
              inside is re-encrypted, so this is instant however much it holds.
            </>
          )}
        </p>

        <Input
          label={current.label}
          type={current.type}
          value={currentSecret}
          onChange={(e) => setCurrentSecret(e.target.value)}
          placeholder={current.placeholder}
          autoComplete="off"
          spellCheck={false}
          required
          autoFocus
        />

        <div>
          <Input
            label="New vault password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="A long passphrase you can remember"
            autoComplete="new-password"
            error={tooShort ? `At least ${MIN_PASSWORD_LENGTH} characters.` : undefined}
            required
          />
          {password && !tooShort && (
            <p className="mt-1 font-body text-xs text-[color:var(--color-text-muted)]">
              {strength.label} — {strength.hint}
            </p>
          )}
        </div>

        <Input
          label="Confirm new password"
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="Type it again"
          autoComplete="new-password"
          error={mismatch ? 'These do not match.' : undefined}
          required
        />

        <div className="flex items-start gap-3">
          <div className="pt-0.5">
            <Switch
              checked={rotateRecovery}
              onChange={setRotateRecovery}
              label="Also issue a new recovery key"
            />
          </div>
          <div>
            <p className="font-body text-sm font-medium text-[color:var(--color-text-primary)]">
              Also issue a new recovery key
            </p>
            <p className="mt-0.5 font-body text-xs text-[color:var(--color-text-secondary)]">
              {rotateRecovery
                ? 'The old recovery key stops working. Shown once, on the next screen.'
                : 'The existing recovery key keeps working — it opens the vault regardless of the password. Turn this on if it may have leaked, or if the person leaving had a copy.'}
            </p>
          </div>
        </div>

        {error && (
          <p className="font-body text-sm" style={{ color: 'var(--color-status-stuck)' }} role="alert">
            {error}
          </p>
        )}

        {/* Lets Enter submit the form without a second visible button. */}
        <button type="submit" className="sr-only" tabIndex={-1} aria-hidden="true" />
      </form>
    </Modal>
  );
};

export default VaultPasswordModal;
