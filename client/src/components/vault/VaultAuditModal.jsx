import { useEffect, useState } from 'react';
import Modal from '../ui/Modal';
import Spinner from '../ui/Spinner';
import Avatar from '../ui/Avatar';
import { typeMeta } from './itemTypes';
import * as vaultService from '../../services/vaultService';
import { timeAgo } from '../../utils/dateUtils';

/**
 * Who opened this vault, and when.
 *
 * Readable WITHOUT the vault password, which looks like a hole and is not: the
 * audit trail has nowhere to put a secret. It records an actor, an action, a
 * timestamp and — for item events — which item and what kind, never a title and
 * never a value. See the server's VaultAudit model for why that constraint is
 * enforced by the schema rather than by discipline.
 *
 * Failed unlocks are here too. A run of them is the single most useful thing
 * this screen can tell anyone.
 */

const ACTION_TEXT = {
  'vault.created': () => 'created the vault',
  'vault.unlocked': () => 'unlocked the vault',
  'vault.unlock_failed': () => 'failed to unlock the vault',
  'vault.locked_out': () => 'triggered a lockout after repeated failures',
  'vault.password_changed': () => 'changed the vault password',
  'vault.recovery_used': () => 'opened the vault with the recovery key',
  'item.created': (t) => `added ${article(t)}`,
  'item.updated': (t) => `edited ${article(t)}`,
  'item.deleted': (t) => `deleted ${article(t)}`,
  'item.file_uploaded': () => 'uploaded an encrypted file',
};

/** "a credential" / "an item" — the label comes from the registry, not a copy. */
const article = (type) => {
  if (!type) return 'an item';
  const label = typeMeta(type).label.toLowerCase();
  return `${/^[aeiou]/.test(label) ? 'an' : 'a'} ${label}`;
};

const isFailure = (action) =>
  action === 'vault.unlock_failed' || action === 'vault.locked_out';

const VaultAuditModal = ({ isOpen, boardId, onClose }) => {
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!isOpen || !boardId) return;
    let cancelled = false;
    setEntries(null);
    setError(null);
    vaultService
      .getVaultAudit(boardId)
      .then((rows) => {
        if (!cancelled) setEntries(rows);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err?.response?.data?.error || 'Could not load the vault activity.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, boardId]);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Vault activity" maxWidth={560}>
      {error && (
        <p className="font-body text-sm" style={{ color: 'var(--color-status-stuck)' }}>
          {error}
        </p>
      )}

      {!error && entries === null && (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      )}

      {!error && entries?.length === 0 && (
        <p className="py-6 text-center font-body text-sm text-[color:var(--color-text-muted)]">
          Nothing recorded yet.
        </p>
      )}

      {!error && entries?.length > 0 && (
        <>
          <p className="mb-3 font-body text-xs text-[color:var(--color-text-muted)]">
            Who did what, and when. Never what was in the item.
          </p>
          <ul className="flex flex-col" style={{ maxHeight: '60vh', overflowY: 'auto' }}>
            {entries.map((entry) => {
              const describe = ACTION_TEXT[entry.action];
              return (
                <li
                  key={entry._id}
                  className="flex items-start gap-2.5 py-2.5"
                  style={{ borderBottom: '1px solid var(--color-border)' }}
                >
                  <Avatar user={entry.actor} size={26} />
                  <div className="min-w-0 flex-1">
                    <p className="font-body text-[13.5px] text-[color:var(--color-text-primary)]">
                      <span className="font-medium">
                        {entry.actor?.name || 'Someone'}
                      </span>{' '}
                      <span
                        style={{
                          color: isFailure(entry.action)
                            ? 'var(--color-status-stuck)'
                            : 'var(--color-text-secondary)',
                        }}
                      >
                        {describe ? describe(entry.itemType) : entry.action}
                      </span>
                    </p>
                    <p className="font-body text-xs text-[color:var(--color-text-muted)]">
                      {timeAgo(entry.createdAt)}
                      {entry.ip && ` · ${entry.ip}`}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Modal>
  );
};

export default VaultAuditModal;
