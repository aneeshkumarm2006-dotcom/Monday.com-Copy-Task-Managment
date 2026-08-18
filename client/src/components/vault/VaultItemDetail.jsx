import { useState } from 'react';
import { ChevronLeft, Pencil, Trash2, TriangleAlert } from 'lucide-react';
import Button from '../ui/Button';
import Modal from '../ui/Modal';
import { typeMeta } from './itemTypes';
import useVaultStore from '../../store/vaultStore';
import useToastStore from '../../store/toastStore';
import { timeAgo } from '../../utils/dateUtils';

/**
 * One vault item: read it, edit it, delete it.
 *
 * Edits are explicit — an Edit button, then Save — rather than the debounced
 * autosave the Notes panel uses. Two reasons, and neither is taste:
 *
 *   1. Every save re-encrypts the WHOLE payload and replaces the row. Autosaving
 *      that on each keystroke means a stream of full-item writes.
 *   2. A half-typed API key silently persisted is a credential that looks
 *      present and does not work, which is worse than one that is obviously
 *      unsaved.
 *
 * `draft` is separate from the stored payload so cancelling really discards.
 */

const VaultItemDetail = ({ item, canManage, boardId, onBack, onDeleted }) => {
  const meta = typeMeta(item?.type);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const updateItem = useVaultStore((s) => s.updateItem);
  const deleteItem = useVaultStore((s) => s.deleteItem);
  const touch = useVaultStore((s) => s.touch);
  const toastError = useToastStore((s) => s.error);
  const toastSuccess = useToastStore((s) => s.success);

  // No reset-on-item-change effect here: VaultTab keys this component on the
  // item id, so a different selection is a different component instance and the
  // draft is discarded by unmounting rather than by an effect chasing it.
  if (!item) return null;

  const startEdit = () => {
    touch();
    setDraft({ ...meta.blank(), ...(item.payload || {}) });
    setEditing(true);
  };

  const handleSave = async () => {
    if (!draft?.title?.trim()) {
      toastError('Give this item a title so you can find it again.');
      return;
    }
    setSaving(true);
    try {
      await updateItem(item._id, draft);
      setEditing(false);
      setDraft(null);
      toastSuccess('Saved.');
    } catch (err) {
      toastError(err?.response?.data?.error || 'Could not save this item.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    try {
      await deleteItem(item._id);
      setConfirmDelete(false);
      toastSuccess('Deleted.');
      onDeleted?.();
    } catch (err) {
      toastError(err?.response?.data?.error || 'Could not delete this item.');
    }
  };

  const Icon = meta.icon;
  const Viewer = meta.Viewer;
  const Editor = meta.Editor;

  return (
    <div className="flex flex-col min-h-0 h-full">
      {/* Header */}
      <div
        className="flex items-start gap-2 pb-3 mb-4"
        style={{ borderBottom: '1px solid var(--color-border)' }}
      >
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to the list"
          className="md:hidden shrink-0 rounded hover:bg-[color:var(--color-bg-subtle)]"
          style={{ padding: 6, color: 'var(--color-text-secondary)' }}
        >
          <ChevronLeft size={18} />
        </button>

        <Icon
          size={18}
          color="var(--color-text-muted)"
          aria-hidden="true"
          className="shrink-0 mt-0.5 hidden md:block"
        />

        <div className="min-w-0 flex-1">
          <h3 className="font-display font-semibold text-[16px] text-[color:var(--color-text-primary)] break-words">
            {item.broken ? 'Could not be decrypted' : meta.heading(item.payload || {})}
          </h3>
          <p className="mt-0.5 font-body text-xs text-[color:var(--color-text-muted)]">
            {meta.label}
            {item.updatedAt && ` · edited ${timeAgo(item.updatedAt)}`}
            {item.lastEditedBy?.name && ` by ${item.lastEditedBy.name}`}
          </p>
        </div>

        {canManage && !editing && (
          <div className="flex items-center gap-1 shrink-0">
            {!item.broken && (
              <button
                type="button"
                onClick={startEdit}
                aria-label="Edit this item"
                title="Edit"
                className="rounded hover:bg-[color:var(--color-bg-subtle)]"
                style={{ padding: 6, color: 'var(--color-text-secondary)' }}
              >
                <Pencil size={16} />
              </button>
            )}
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              aria-label="Delete this item"
              title="Delete"
              className="rounded hover:bg-[color:var(--color-bg-subtle)]"
              style={{ padding: 6, color: 'var(--color-status-stuck)' }}
            >
              <Trash2 size={16} />
            </button>
          </div>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-y-auto pb-4">
        {item.broken ? (
          // Kept and labelled rather than hidden — see the store's loadItems for
          // why an undecryptable row is shown at all.
          <div
            className="flex items-start gap-2 p-3 font-body text-sm"
            style={{
              background: 'var(--color-bg-subtle)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
              color: 'var(--color-text-secondary)',
            }}
          >
            <TriangleAlert
              size={16}
              color="var(--color-status-stuck)"
              aria-hidden="true"
              className="shrink-0 mt-0.5"
            />
            <span>
              This item will not open with the current vault key. It was most
              likely written under an older key. Its contents cannot be recovered
              — you can delete it.
            </span>
          </div>
        ) : editing ? (
          <Editor
            payload={draft}
            onChange={setDraft}
            boardId={boardId}
            existing
            minHeight={meta.editorHeight}
          />
        ) : (
          <Viewer payload={item.payload || {}} item={item} />
        )}
      </div>

      {editing && (
        <div
          className="flex items-center justify-end gap-2 pt-3 shrink-0"
          style={{ borderTop: '1px solid var(--color-border)' }}
        >
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setEditing(false);
              setDraft(null);
            }}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      )}

      <Modal
        isOpen={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete this item?"
        maxWidth={420}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={handleDelete}>
              Delete
            </Button>
          </>
        }
      >
        <p className="font-body text-sm text-[color:var(--color-text-secondary)]">
          {item.broken
            ? 'This item cannot be decrypted, so there is nothing to lose by removing it.'
            : 'This cannot be undone. The encrypted contents are removed for everyone.'}
        </p>
      </Modal>
    </div>
  );
};

export default VaultItemDetail;
