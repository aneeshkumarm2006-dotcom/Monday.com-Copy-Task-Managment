import { useCallback, useEffect, useState } from 'react';
import { Building2, History, KeyRound, Lock, Plus, ShieldOff } from 'lucide-react';
import Button from '../ui/Button';
import Spinner from '../ui/Spinner';
import EmptyState from '../ui/EmptyState';
import VaultSetup from './VaultSetup';
import VaultLockScreen from './VaultLockScreen';
import VaultItemList from './VaultItemList';
import VaultItemDetail from './VaultItemDetail';
import VaultNewItemModal from './VaultNewItemModal';
import VaultPasswordModal from './VaultPasswordModal';
import VaultAuditModal from './VaultAuditModal';
import VaultEscrowModal from './VaultEscrowModal';
import useVaultStore from '../../store/vaultStore';
import { getVaultMeta } from '../../services/vaultService';
import { cancelSecretClear } from '../../utils/vaultClipboard';

/**
 * The Vault tab — four states, resolved in this order:
 *
 *   loading    → fetching the vault's public metadata
 *   no vault   → the setup screen (or an explanation, without `vault.manage`)
 *   locked     → the password prompt
 *   unlocked   → the item list
 *
 * AUTO-LOCK lives here, and it is three separate mechanisms because they cover
 * three different ways a vault is left open:
 *
 *   - unmount → lock. Switching tabs, opening another board, closing the page.
 *     The cleanup below is what makes "navigating away locks it" true.
 *   - idle timer in the store → five minutes with no vault interaction.
 *   - the server token's own 15-minute expiry, as the backstop for both.
 *
 * The board id is checked against the store's on every render. An unlock belongs
 * to ONE board, and a stale one from a previous board must never be treated as
 * this board being open.
 */

const VaultTab = ({ boardId, boardName }) => {
  const [meta, setMeta] = useState(null);
  const [metaError, setMetaError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [newItemOpen, setNewItemOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [escrowOpen, setEscrowOpen] = useState(false);

  const items = useVaultStore((s) => s.items);
  const storeBoardId = useVaultStore((s) => s.boardId);
  const vaultKey = useVaultStore((s) => s.vaultKey);
  const canManage = useVaultStore((s) => s.canManage);
  const needsPasswordReset = useVaultStore((s) => s.needsPasswordReset);
  const loadingItems = useVaultStore((s) => s.loading);
  const lock = useVaultStore((s) => s.lock);

  // An unlock is only this board's unlock.
  const unlocked = !!vaultKey && storeBoardId === boardId;

  const refreshMeta = useCallback(async () => {
    if (!boardId) return;
    setMetaError(null);
    try {
      setMeta(await getVaultMeta(boardId));
    } catch (err) {
      setMeta(null);
      setMetaError(err?.response?.data?.error || "Could not check this board's vault.");
    }
  }, [boardId]);

  useEffect(() => {
    setMeta(null);
    setSelectedId(null);
    refreshMeta();
  }, [refreshMeta]);

  // Lock on the way out. This is the "navigating away from the tab" rule from
  // the design — the board page unmounts this component when `view` changes, so
  // one cleanup covers tab switches, board switches and leaving the page.
  useEffect(
    () => () => {
      cancelSecretClear();
      useVaultStore.getState().lock();
    },
    []
  );

  // A recovery unlock leaves the vault open with no password anyone knows. Push
  // the change-password screen immediately and give it no way out.
  useEffect(() => {
    if (unlocked && needsPasswordReset) setPasswordOpen(true);
  }, [unlocked, needsPasswordReset]);

  // Derived, not synchronised. An id pointing at a deleted item simply resolves
  // to null and the pane falls back to its empty state — no effect needed to
  // "keep it valid", which would only add a render pass to reach the same place.
  const selected = items.find((i) => i._id === selectedId) || null;

  // ---- loading / error ----------------------------------------------------

  if (metaError) {
    return (
      <div className="mt-6">
        <EmptyState icon={ShieldOff} title="Vault unavailable" description={metaError} />
      </div>
    );
  }

  if (!meta) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size="lg" />
      </div>
    );
  }

  // ---- no vault yet -------------------------------------------------------

  if (!meta.exists) {
    if (!meta.canManage) {
      return (
        <div className="mt-6">
          <EmptyState
            icon={ShieldOff}
            title="No vault on this board"
            description="Someone who can manage this board needs to set one up first."
          />
        </div>
      );
    }
    return (
      <VaultSetup
        boardId={boardId}
        boardName={boardName}
        escrow={meta.escrow}
        onDone={refreshMeta}
      />
    );
  }

  // ---- locked -------------------------------------------------------------

  if (!unlocked) {
    return (
      <VaultLockScreen
        boardId={boardId}
        meta={meta}
        onUnlocked={() => {
          // The password may have been rotated by someone else since this tab
          // loaded its metadata; re-read it so the recovery affordance and the
          // "changed" timestamp are current.
          refreshMeta();
        }}
      />
    );
  }

  // ---- unlocked -----------------------------------------------------------

  return (
    <div className="mt-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="inline-flex items-center gap-1.5 font-body text-xs font-medium shrink-0"
            style={{
              height: 26,
              padding: '0 10px',
              borderRadius: 9999,
              background: 'var(--color-status-done-bg)',
              color: 'var(--color-status-done)',
            }}
          >
            Unlocked
          </span>
          <span className="font-body text-xs text-[color:var(--color-text-muted)] truncate">
            Locks itself when you leave this tab, or after five idle minutes.
          </span>
        </div>

        <div className="flex-1" />

        {canManage && (
          <Button size="sm" variant="primary" icon={Plus} onClick={() => setNewItemOpen(true)}>
            New
          </Button>
        )}
        {canManage && (
          <Button
            size="sm"
            variant="secondary"
            icon={History}
            onClick={() => setAuditOpen(true)}
          >
            Activity
          </Button>
        )}
        {canManage && (
          <Button
            size="sm"
            variant="secondary"
            icon={KeyRound}
            onClick={() => setPasswordOpen(true)}
          >
            Password
          </Button>
        )}
        {canManage && meta.escrow?.orgHasEscrow && (
          <Button
            size="sm"
            variant="secondary"
            icon={Building2}
            onClick={() => setEscrowOpen(true)}
          >
            {meta.escrow.enabled ? 'Workspace key: on' : 'Workspace key: off'}
          </Button>
        )}
        <Button size="sm" variant="secondary" icon={Lock} onClick={lock}>
          Lock
        </Button>
      </div>

      {/* Master / detail. Stacks on mobile: the list gives way to the item, and
          the detail's back arrow returns — the Notes panel's behaviour, in a
          layout that can afford both columns on a desktop. */}
      <div
        className="flex flex-col md:flex-row gap-4"
        style={{ minHeight: 420 }}
      >
        <div
          className={[
            selected ? 'hidden md:flex' : 'flex',
            'flex-col md:w-[320px] md:shrink-0',
          ].join(' ')}
          style={{
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            padding: 10,
            maxHeight: 620,
          }}
        >
          {loadingItems && items.length === 0 ? (
            <div className="flex justify-center py-8">
              <Spinner />
            </div>
          ) : (
            <VaultItemList
              items={items}
              selectedId={selectedId}
              onSelect={(item) => setSelectedId(item._id)}
            />
          )}
        </div>

        <div
          className={[selected ? 'flex' : 'hidden md:flex', 'flex-1 min-w-0 flex-col'].join(' ')}
          style={{
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            padding: 16,
            maxHeight: 620,
          }}
        >
          {selected ? (
            <VaultItemDetail
              // Keyed so picking a different item REMOUNTS the pane. That is
              // what discards a half-finished draft; without it an edit in
              // progress would follow the user onto the next item and overwrite
              // it on save.
              key={selected._id}
              item={selected}
              canManage={canManage}
              boardId={boardId}
              onBack={() => setSelectedId(null)}
              onDeleted={() => setSelectedId(null)}
            />
          ) : (
            <EmptyState
              icon={KeyRound}
              title={items.length ? 'Pick an item' : 'This vault is empty'}
              description={
                items.length
                  ? 'Choose something on the left to read it.'
                  : canManage
                    ? 'Add a credential, a note, a sheet or a file. Everything is encrypted in your browser first.'
                    : 'Nothing has been added to this vault yet.'
              }
              actionLabel={!items.length && canManage ? 'Add the first item' : undefined}
              onAction={!items.length && canManage ? () => setNewItemOpen(true) : undefined}
            />
          )}
        </div>
      </div>

      <VaultNewItemModal
        isOpen={newItemOpen}
        boardId={boardId}
        onClose={() => setNewItemOpen(false)}
        onCreated={() => {}}
      />

      <VaultPasswordModal
        isOpen={passwordOpen}
        boardId={boardId}
        boardName={boardName}
        forced={needsPasswordReset}
        onClose={() => setPasswordOpen(false)}
        onChanged={refreshMeta}
      />

      <VaultAuditModal
        isOpen={auditOpen}
        boardId={boardId}
        onClose={() => setAuditOpen(false)}
      />

      <VaultEscrowModal
        isOpen={escrowOpen}
        boardId={boardId}
        escrow={meta.escrow}
        onClose={() => setEscrowOpen(false)}
        onChanged={refreshMeta}
      />
    </div>
  );
};

export default VaultTab;
