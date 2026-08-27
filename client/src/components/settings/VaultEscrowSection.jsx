import { useCallback, useEffect, useState } from 'react';
import { Building2, ShieldCheck, TriangleAlert } from 'lucide-react';
import Button from '../ui/Button';
import Input from '../ui/Input';
import Modal from '../ui/Modal';
import Spinner from '../ui/Spinner';
import useToastStore from '../../store/toastStore';
import * as vaultService from '../../services/vaultService';
import {
  buildEscrowBlock,
  deriveKeys,
  MIN_PASSWORD_LENGTH,
  passwordStrength,
  resealEscrowPrivateKey,
} from '../../utils/vaultCrypto';

/**
 * The workspace break-glass key, on the Members page beside the permissions
 * matrix — both are org-wide security settings rather than anybody's preference.
 *
 * WHAT THIS IS FOR. Every board vault has two doors and both live with the
 * people who use that board. When the one person who knew them leaves, the
 * board's production credentials are gone permanently. This is the workspace's
 * answer: one passphrase, held by whoever runs the org, that can open any vault
 * which opted in.
 *
 * The screen is deliberately blunt about the trade, because it is a real
 * widening of the vault's threat model and the person switching it on is the
 * only one positioned to judge it. One passphrase reaching every covered vault
 * is a large blast radius; it is also the entire point.
 *
 * Nothing sensitive is computed anywhere but here: the keypair is generated in
 * this browser and its private half is sealed under the passphrase before the
 * request is made. The server stores a public key and a ciphertext.
 */

const VaultEscrowSection = ({ orgId }) => {
  const [state, setState] = useState(null); // server meta, or null while loading
  const [error, setError] = useState(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [rotateOpen, setRotateOpen] = useState(false);

  const toastSuccess = useToastStore((s) => s.success);

  const refresh = useCallback(async () => {
    if (!orgId) return;
    try {
      setState(await vaultService.getOrgEscrow(orgId));
      setError(null);
    } catch (err) {
      setError(err?.response?.data?.error || 'Could not load the workspace recovery key.');
    }
  }, [orgId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (error) {
    return (
      <p className="font-body text-sm" style={{ color: 'var(--color-status-stuck)' }}>
        {error}
      </p>
    );
  }

  if (!state) {
    return (
      <div className="flex justify-center py-6">
        <Spinner />
      </div>
    );
  }

  return (
    <section
      className="p-4 md:p-5"
      style={{
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-lg)',
        background: 'var(--color-bg-surface, transparent)',
      }}
    >
      <div className="flex items-start gap-3">
        <Building2
          size={20}
          color="var(--color-accent)"
          aria-hidden="true"
          className="shrink-0 mt-0.5"
        />
        <div className="min-w-0 flex-1">
          <h2 className="font-display font-semibold text-[16px] text-[color:var(--color-text-primary)]">
            Workspace recovery key
          </h2>
          <p className="mt-1 font-body text-sm text-[color:var(--color-text-secondary)]">
            A last resort for board vaults. If the person who knew a vault&rsquo;s
            password leaves and its recovery key is lost, this is the only way the
            contents come back.
          </p>
        </div>
      </div>

      {state.exists ? (
        <>
          <div
            className="mt-4 p-3 font-body text-sm"
            style={{
              background: 'var(--color-bg-subtle)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
              color: 'var(--color-text-secondary)',
            }}
          >
            <p className="flex items-center gap-1.5 font-medium text-[color:var(--color-text-primary)]">
              <ShieldCheck size={15} color="var(--color-status-done)" aria-hidden="true" />
              Set up and active
            </p>
            <p className="mt-1">
              Covering{' '}
              <strong>
                {state.vaultsCovered} vault{state.vaultsCovered === 1 ? '' : 's'}
              </strong>
              . New vaults are offered this cover when they are created; existing
              ones can turn it on from their own Vault tab.
            </p>
          </div>

          {state.canManage && (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={() => setRotateOpen(true)}>
                Change the passphrase
              </Button>
            </div>
          )}

          <p className="mt-3 font-body text-xs text-[color:var(--color-text-muted)]">
            The passphrase cannot be reset or looked up. Losing it loses only the
            break-glass path — every vault still opens with its own password.
          </p>
        </>
      ) : (
        <>
          <div
            className="mt-4 p-3 font-body text-sm"
            style={{
              background: 'var(--color-bg-subtle)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
              color: 'var(--color-text-secondary)',
            }}
          >
            <p className="flex items-center gap-1.5 font-medium text-[color:var(--color-text-primary)]">
              <TriangleAlert size={15} color="var(--color-text-muted)" aria-hidden="true" />
              Not set up
            </p>
            <p className="mt-1">
              Without it, a vault whose password and recovery key are both lost is
              gone for good — which may be exactly what you want.
            </p>
          </div>

          {state.canManage && (
            <div className="mt-3">
              <Button size="sm" variant="primary" onClick={() => setSetupOpen(true)}>
                Set up a workspace recovery key
              </Button>
            </div>
          )}
        </>
      )}

      <EscrowPassphraseModal
        isOpen={setupOpen}
        mode="create"
        orgId={orgId}
        kdf={null}
        onClose={() => setSetupOpen(false)}
        onDone={() => {
          toastSuccess('Workspace recovery key created.');
          refresh();
        }}
      />

      <EscrowPassphraseModal
        isOpen={rotateOpen}
        mode="rotate"
        orgId={orgId}
        kdf={state.kdf}
        onClose={() => setRotateOpen(false)}
        onDone={() => {
          toastSuccess('Workspace recovery passphrase changed.');
          refresh();
        }}
      />
    </section>
  );
};

/**
 * One modal for both create and rotate — they differ only in whether the OLD
 * passphrase is asked for, and in which crypto helper runs.
 *
 * Rotation re-seals the SAME keypair under the new passphrase, which is what
 * keeps every already-covered vault working. Minting a fresh keypair would
 * quietly orphan all of them.
 */
const EscrowPassphraseModal = ({ isOpen, mode, orgId, kdf, onClose, onDone }) => {
  const [current, setCurrent] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const isRotate = mode === 'rotate';

  useEffect(() => {
    if (!isOpen) return;
    setCurrent('');
    setPassphrase('');
    setConfirm('');
    setError(null);
    setBusy(false);
  }, [isOpen]);

  const strength = passwordStrength(passphrase);
  const tooShort = passphrase.length > 0 && passphrase.length < MIN_PASSWORD_LENGTH;
  const mismatch = confirm.length > 0 && confirm !== passphrase;
  const canSubmit =
    passphrase.length >= MIN_PASSWORD_LENGTH &&
    confirm === passphrase &&
    (!isRotate || current.length > 0) &&
    !busy;

  const handleSubmit = async (e) => {
    e?.preventDefault?.();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      if (isRotate) {
        // Two round trips, and necessarily so: re-sealing the key requires
        // opening it first, and only this browser can. The server releases the
        // sealed key against a proof rather than on the plain GET, so the
        // passphrase has to be derived once before it can be used.
        const { proof } = await deriveKeys(current, kdf.salt, {
          iterations: kdf.iterations,
        });
        const unsealed = await vaultService.unsealOrgEscrow(orgId, proof);
        const payload = await resealEscrowPrivateKey(
          unsealed.wrappedPrivateKey,
          current,
          unsealed.kdf,
          passphrase
        );
        await vaultService.changeEscrowPassphrase(orgId, payload);
      } else {
        await vaultService.createOrgEscrow(orgId, await buildEscrowBlock(passphrase));
      }
      setCurrent('');
      setPassphrase('');
      setConfirm('');
      onDone?.();
      onClose?.();
    } catch (err) {
      setError(
        err?.response?.data?.error || err?.message || 'Could not save the passphrase.'
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={isRotate ? 'Change the workspace passphrase' : 'Set up a workspace recovery key'}
      maxWidth={520}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleSubmit} disabled={!canSubmit}>
            {busy ? 'Working…' : isRotate ? 'Change passphrase' : 'Create'}
          </Button>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {!isRotate && (
          <div
            className="p-3 font-body text-sm"
            style={{
              background: 'var(--color-bg-subtle)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
              color: 'var(--color-text-secondary)',
            }}
          >
            <p className="font-medium text-[color:var(--color-text-primary)] mb-1.5">
              Read this before choosing it
            </p>
            <ul className="list-disc pl-5 space-y-1">
              <li>
                It opens <strong>every vault in the workspace</strong> that has
                opted in — a far wider reach than any single vault password.
              </li>
              <li>
                It is never emailed and cannot be reset. Losing it loses only this
                break-glass path, not any vault.
              </li>
              <li>Keep it offline, and separate from the vault passwords it backs up.</li>
            </ul>
          </div>
        )}

        {isRotate && (
          <Input
            label="Current workspace passphrase"
            masked
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            placeholder="••••••••••"
            autoComplete="off"
            required
            autoFocus
          />
        )}

        <div>
          <Input
            label={isRotate ? 'New workspace passphrase' : 'Workspace passphrase'}
            masked
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder="A long passphrase, kept offline"
            error={tooShort ? `At least ${MIN_PASSWORD_LENGTH} characters.` : undefined}
            required
            autoFocus={!isRotate}
          />
          {passphrase && !tooShort && (
            <p className="mt-1 font-body text-xs text-[color:var(--color-text-muted)]">
              {strength.label} — {strength.hint}
            </p>
          )}
        </div>

        <Input
          label="Confirm passphrase"
          masked
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="Type it again"
          error={mismatch ? 'These do not match.' : undefined}
          required
        />

        {isRotate && (
          <p className="font-body text-xs text-[color:var(--color-text-muted)]">
            The recovery key itself does not change, so every vault already
            covered stays covered. Only the passphrase that opens it changes.
          </p>
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

        <button type="submit" className="sr-only" tabIndex={-1} aria-hidden="true" />
      </form>
    </Modal>
  );
};

export default VaultEscrowSection;
