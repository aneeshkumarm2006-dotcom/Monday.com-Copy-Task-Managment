import { useEffect, useState } from 'react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import { typeMeta, VAULT_ITEM_ORDER, VAULT_ITEM_TYPES } from './itemTypes';
import useVaultStore from '../../store/vaultStore';
import useToastStore from '../../store/toastStore';

/**
 * Creating an item: pick a type, fill it in, save.
 *
 * Two steps rather than a type dropdown inside one form, because the forms have
 * almost nothing in common — a credential is five fields, a sheet is a grid, a
 * file is an upload. A single form that morphs would leave stale values from the
 * previous shape sitting in state.
 *
 * `fileHandle` is the one thing that travels beside the payload rather than
 * inside it: the Cloudinary handle for an already-uploaded encrypted blob is not
 * a secret and is not sealed, so the FileEditor reports it through
 * `onFileUploaded` instead of smuggling it into the payload the store encrypts.
 */

const VaultNewItemModal = ({ isOpen, boardId, initialType = null, onClose, onCreated }) => {
  const [type, setType] = useState(initialType);
  const [draft, setDraft] = useState(null);
  const [fileHandle, setFileHandle] = useState(null);
  const [saving, setSaving] = useState(false);

  const createItem = useVaultStore((s) => s.createItem);
  const toastError = useToastStore((s) => s.error);
  const toastSuccess = useToastStore((s) => s.success);

  // Reset every time the modal opens, so a cancelled draft never reappears.
  useEffect(() => {
    if (!isOpen) return;
    setType(initialType);
    setDraft(initialType ? typeMeta(initialType).blank() : null);
    setFileHandle(null);
    setSaving(false);
  }, [isOpen, initialType]);

  const choose = (nextType) => {
    setType(nextType);
    setDraft(typeMeta(nextType).blank());
    setFileHandle(null);
  };

  const handleSave = async () => {
    if (!draft?.title?.trim()) {
      toastError('Give this item a title so you can find it again.');
      return;
    }
    if (type === 'file' && !fileHandle) {
      toastError('Choose a file to upload first.');
      return;
    }
    setSaving(true);
    try {
      await createItem(type, draft, fileHandle);
      toastSuccess('Added to the vault.');
      onCreated?.();
      onClose?.();
    } catch (err) {
      toastError(err?.response?.data?.error || 'Could not save this item.');
    } finally {
      setSaving(false);
    }
  };

  const meta = type ? typeMeta(type) : null;
  const Editor = meta?.Editor;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={meta ? `New ${meta.label.toLowerCase()}` : 'What do you want to add?'}
      maxWidth={type === 'sheet' || type === 'doc' ? 720 : 520}
      footer={
        meta ? (
          <>
            <Button variant="secondary" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleSave} disabled={saving}>
              {saving ? 'Encrypting…' : 'Save to vault'}
            </Button>
          </>
        ) : null
      }
    >
      {!meta ? (
        <div className="flex flex-col gap-2">
          {VAULT_ITEM_ORDER.map((key) => {
            const t = VAULT_ITEM_TYPES[key];
            const Icon = t.icon;
            return (
              <button
                key={key}
                type="button"
                onClick={() => choose(key)}
                className="flex items-center gap-3 text-left transition-colors hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color:var(--color-accent)]"
                style={{
                  padding: '12px 14px',
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-md)',
                  background: 'transparent',
                  cursor: 'pointer',
                }}
              >
                <Icon size={18} color="var(--color-accent)" aria-hidden="true" className="shrink-0" />
                <span className="min-w-0">
                  <span className="block font-body font-medium text-[14px] text-[color:var(--color-text-primary)]">
                    {t.label}
                  </span>
                  <span className="block font-body text-xs text-[color:var(--color-text-secondary)]">
                    {t.description}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <Editor
          payload={draft}
          onChange={setDraft}
          boardId={boardId}
          onFileUploaded={setFileHandle}
          minHeight={meta.editorHeight}
        />
      )}
    </Modal>
  );
};

export default VaultNewItemModal;
