import { useState } from 'react';
import { Building2, ShieldCheck } from 'lucide-react';
import Button from '../ui/Button';
import Input from '../ui/Input';
import Switch from '../ui/Switch';
import RecoveryKeyCard from './RecoveryKeyCard';
import useVaultStore from '../../store/vaultStore';
import { MIN_PASSWORD_LENGTH, passwordStrength } from '../../utils/vaultCrypto';

/**
 * First run — choosing the vault password.
 *
 * The screen leads with what makes this password different from every other one
 * the user has typed into this app, because that difference is the entire
 * feature and getting it wrong is unrecoverable:
 *
 *   - it is not their login password,
 *   - it cannot be reset by email,
 *   - nobody, including us, can look it up.
 *
 * Saying that plainly BEFORE the field, rather than in a warning afterwards, is
 * deliberate. Someone who reads it after choosing has already chosen.
 */

const STRENGTH_COLOR = [
  'var(--color-status-stuck)',
  'var(--color-status-stuck)',
  'var(--color-status-working)',
  'var(--color-status-done)',
];

const VaultSetup = ({ boardId, boardName, escrow, onDone }) => {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [withRecovery, setWithRecovery] = useState(true);
  // Default ON when the workspace has a break-glass key. The org already made
  // the deliberate choice to have one; a vault silently opting out of it is how
  // escrow ends up protecting nothing. Visible and switchable either way.
  const [withEscrow, setWithEscrow] = useState(true);
  const [error, setError] = useState(null);
  const [recoveryKey, setRecoveryKey] = useState(null);

  const setup = useVaultStore((s) => s.setup);
  const loading = useVaultStore((s) => s.loading);

  const orgHasEscrow = !!escrow?.orgHasEscrow;
  const strength = passwordStrength(password);
  const tooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH;
  const mismatch = confirm.length > 0 && confirm !== password;
  const canSubmit =
    password.length >= MIN_PASSWORD_LENGTH && confirm === password && !loading;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    try {
      const { recoveryKey: key } = await setup(boardId, password, {
        withRecovery,
        escrowPublicKey: orgHasEscrow && withEscrow ? escrow.publicKey : null,
      });
      // Wipe the fields the moment they are no longer needed. React keeps the
      // old strings alive until GC either way, but leaving a password sitting in
      // a mounted input is a different order of carelessness.
      setPassword('');
      setConfirm('');
      if (key) setRecoveryKey(key);
      else onDone?.();
    } catch (err) {
      setError(err?.response?.data?.error || err?.message || 'Could not create the vault.');
    }
  };

  // The recovery key is shown after the vault exists, on its own, with nothing
  // else to click. It is the one screen in this flow that cannot be revisited.
  if (recoveryKey) {
    return (
      <div className="max-w-[560px] mx-auto py-8">
        <RecoveryKeyCard
          recoveryKey={recoveryKey}
          boardName={boardName}
          onConfirm={() => {
            setRecoveryKey(null);
            onDone?.();
          }}
          confirmLabel="Open the vault"
        />
      </div>
    );
  }

  return (
    <div className="max-w-[520px] mx-auto py-8">
      <div className="flex flex-col items-center text-center mb-6">
        <ShieldCheck size={40} strokeWidth={1.5} color="var(--color-accent)" aria-hidden="true" />
        <h2 className="mt-3 font-display font-semibold text-[19px] text-[color:var(--color-text-primary)]">
          Set up this board&rsquo;s vault
        </h2>
        <p className="mt-2 font-body text-sm text-[color:var(--color-text-secondary)]">
          One password, shared by everyone who needs the board&rsquo;s credentials.
          Everything inside is encrypted in your browser — we only ever store the
          encrypted result.
        </p>
      </div>

      <div
        className="p-4 mb-6 font-body text-sm"
        style={{
          background: 'var(--color-bg-subtle)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-md)',
          color: 'var(--color-text-secondary)',
        }}
      >
        <p className="font-medium text-[color:var(--color-text-primary)] mb-1.5">
          Before you choose it
        </p>
        <ul className="list-disc pl-5 space-y-1">
          <li>This is not your login password. Do not reuse it.</li>
          <li>There is no &ldquo;forgot password&rdquo; email. That is the point.</li>
          <li>
            Lose it and the contents are unrecoverable, unless you keep the
            recovery key below.
          </li>
        </ul>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div>
          <Input
            label="Vault password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="A long passphrase you can remember"
            autoComplete="new-password"
            error={tooShort ? `At least ${MIN_PASSWORD_LENGTH} characters.` : undefined}
            required
            autoFocus
          />
          {password && !tooShort && (
            <div className="mt-2 flex items-center gap-2">
              <div
                className="flex-1"
                style={{ height: 4, borderRadius: 2, background: 'var(--color-border)' }}
              >
                <div
                  style={{
                    height: 4,
                    borderRadius: 2,
                    width: `${((strength.score + 1) / 4) * 100}%`,
                    background: STRENGTH_COLOR[strength.score],
                    transition: 'width 150ms',
                  }}
                />
              </div>
              <span
                className="font-body text-xs font-medium shrink-0"
                style={{ color: STRENGTH_COLOR[strength.score] }}
              >
                {strength.label}
              </span>
            </div>
          )}
          {password && !tooShort && (
            <p className="mt-1 font-body text-xs text-[color:var(--color-text-muted)]">
              {strength.hint}
            </p>
          )}
        </div>

        <Input
          label="Confirm password"
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="Type it again"
          autoComplete="new-password"
          error={mismatch ? 'These do not match.' : undefined}
          required
        />

        <div
          className="flex items-start gap-3 p-3"
          style={{
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
          }}
        >
          <div className="pt-0.5">
            <Switch
              checked={withRecovery}
              onChange={setWithRecovery}
              label="Create a recovery key"
            />
          </div>
          <div>
            <p className="font-body text-sm font-medium text-[color:var(--color-text-primary)]">
              Create a recovery key
            </p>
            <p className="mt-0.5 font-body text-xs text-[color:var(--color-text-secondary)]">
              {withRecovery
                ? 'Shown once, on the next screen. Keep it offline — anyone holding it can open the vault.'
                : 'Off: if the password is lost, the contents are gone permanently. There is no other way in.'}
            </p>
          </div>
        </div>

        {orgHasEscrow && (
          <div
            className="flex items-start gap-3 p-3"
            style={{
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
            }}
          >
            <div className="pt-0.5">
              <Switch
                checked={withEscrow}
                onChange={setWithEscrow}
                label="Cover this vault with the workspace recovery key"
              />
            </div>
            <div>
              <p className="font-body text-sm font-medium text-[color:var(--color-text-primary)] flex items-center gap-1.5">
                <Building2 size={14} aria-hidden="true" />
                Cover this vault with the workspace recovery key
              </p>
              <p className="mt-0.5 font-body text-xs text-[color:var(--color-text-secondary)]">
                {withEscrow
                  ? 'Someone holding the workspace recovery passphrase can open this vault if the password and recovery key are both lost. You do not need that passphrase yourself to switch this on.'
                  : 'Off: if this password and its recovery key are both lost, nobody in the workspace can get the contents back.'}
              </p>
            </div>
          </div>
        )}

        {error && (
          <p className="font-body text-sm" style={{ color: 'var(--color-status-stuck)' }}>
            {error}
          </p>
        )}

        <Button type="submit" variant="primary" disabled={!canSubmit}>
          {loading ? 'Creating the vault…' : 'Create vault'}
        </Button>
        {loading && (
          <p className="text-center font-body text-xs text-[color:var(--color-text-muted)]">
            Deriving the encryption key. This takes a moment on purpose — it is
            what makes guessing expensive.
          </p>
        )}
      </form>
    </div>
  );
};

export default VaultSetup;
