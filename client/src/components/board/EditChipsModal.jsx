import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Star } from 'lucide-react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import useBoardStore from '../../store/boardStore';
import useTaskStore from '../../store/taskStore';
import useToastStore from '../../store/toastStore';

/**
 * EditChipsModal — admin-only modal for editing one of a board's chip
 * vocabularies. `kind` picks which:
 *
 *   <EditChipsModal kind="labels"    boardId={id} ... />   task labels
 *   <EditChipsModal kind="statuses"  boardId={id} ... />   task statuses
 *   <EditChipsModal kind="groupTags" boardId={id} ... />   group tags (extra feature)
 *
 * All three are the same editor over a different collection, so `KINDS` holds
 * everything that actually differs — the board field, the store actions, and the
 * copy — and the component below stays generic.
 *
 * The board doc is read from useBoardStore so it stays in sync with
 * optimistic updates triggered elsewhere (StatusMenu, LabelPicker, etc.).
 *
 * Each row has:
 *   - color swatch (HTML <input type="color">)
 *   - name input
 *   - star button (statuses only — marks the row as the default status)
 *   - delete button (statuses only: blocked for the default)
 *
 * Adds, renames, recolors, and deletes are persisted immediately via
 * boardStore actions; no per-modal save button.
 */
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const isValidHex = (v) => typeof v === 'string' && HEX_RE.test(v.trim());
const DEFAULT_NEW_COLOR = '#6B7280';

/** Everything that differs between the three vocabularies. */
const KINDS = {
  labels: {
    field: 'labels',
    title: 'Edit Labels',
    addPlaceholder: 'New label name…',
    deleteTitle: 'Delete label?',
    noun: 'label',
    deleteEffect: 'It will be removed from every task on this board.',
    add: (s) => s.addLabel,
    update: (s) => s.updateLabel,
    remove: (s) => s.deleteLabel,
  },
  statuses: {
    field: 'statuses',
    title: 'Edit Statuses',
    addPlaceholder: 'New status name…',
    deleteTitle: 'Delete status?',
    noun: 'status',
    deleteEffect:
      'Tasks currently using this status will be moved to the default status.',
    add: (s) => s.addStatus,
    update: (s) => s.updateStatusChip,
    remove: (s) => s.deleteStatus,
  },
  groupTags: {
    field: 'groupTags',
    title: 'Edit Group Tags',
    addPlaceholder: 'New tag name…',
    deleteTitle: 'Delete group tag?',
    noun: 'tag',
    deleteEffect: 'It will be removed from every group on this board.',
    add: (s) => s.addGroupTag,
    update: (s) => s.updateGroupTag,
    remove: (s) => s.deleteGroupTag,
  },
};

const EditChipsModal = ({ isOpen, onClose, boardId, kind = 'labels' }) => {
  const spec = KINDS[kind] || KINDS.labels;
  // Statuses alone carry a default flag, so they alone get the star column and
  // the "can't delete the default" rule.
  const isStatuses = spec.field === 'statuses';

  const board = useBoardStore((s) => s.getBoardById(boardId));
  const addChip = useBoardStore(spec.add);
  const updateChip = useBoardStore(spec.update);
  const deleteChip = useBoardStore(spec.remove);
  const updateStatusChip = useBoardStore((s) => s.updateStatusChip);
  // Deleting a group tag detaches it server-side from every group; mirror that
  // in the cached groups so no header is left holding a dead id.
  const detachGroupTag = useTaskStore((s) => s.detachGroupTag);

  const toastError = useToastStore((s) => s.error);

  const collection = useMemo(() => {
    const list = board?.[spec.field];
    if (!Array.isArray(list)) return [];
    return [...list].sort((a, b) => (a.order || 0) - (b.order || 0));
  }, [board, spec.field]);

  // Local draft buffer so name/color edits don't fire a network call on
  // every keystroke. Flushed onBlur.
  const [drafts, setDrafts] = useState({});
  useEffect(() => {
    setDrafts({});
  }, [isOpen, kind, boardId]);

  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(DEFAULT_NEW_COLOR);
  const [submitting, setSubmitting] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);

  const draftFor = (id, field) => {
    const d = drafts[id];
    return d && Object.prototype.hasOwnProperty.call(d, field) ? d[field] : null;
  };

  const setDraft = (id, field, value) => {
    setDrafts((prev) => ({
      ...prev,
      [id]: { ...(prev[id] || {}), [field]: value },
    }));
  };

  const clearDraft = (id, field) => {
    setDrafts((prev) => {
      const next = { ...prev };
      if (next[id]) {
        const { [field]: _ignored, ...rest } = next[id];
        next[id] = rest;
        if (Object.keys(next[id]).length === 0) delete next[id];
      }
      return next;
    });
  };

  const flushField = async (item, field) => {
    const draft = draftFor(item._id, field);
    if (draft === null) return;
    const original = item[field];
    if (draft === original) {
      clearDraft(item._id, field);
      return;
    }
    if (field === 'name' && !draft.trim()) {
      clearDraft(item._id, field);
      return;
    }
    if (field === 'color' && !isValidHex(draft)) {
      clearDraft(item._id, field);
      return;
    }
    try {
      const payload = { [field]: field === 'name' ? draft.trim() : draft };
      await updateChip(boardId, item._id, payload);
      clearDraft(item._id, field);
    } catch (err) {
      console.error('Failed to update chip:', err);
      toastError(err?.response?.data?.error || 'Failed to save changes');
      clearDraft(item._id, field);
    }
  };

  const handleAdd = async (e) => {
    e?.preventDefault?.();
    const trimmed = newName.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      const color = isValidHex(newColor) ? newColor : DEFAULT_NEW_COLOR;
      await addChip(boardId, { name: trimmed, color });
      setNewName('');
      setNewColor(DEFAULT_NEW_COLOR);
    } catch (err) {
      console.error('Failed to add chip:', err);
      toastError(err?.response?.data?.error || 'Failed to add');
    } finally {
      setSubmitting(false);
    }
  };

  const handleMarkDefault = async (statusId) => {
    try {
      await updateStatusChip(boardId, statusId, { isDefault: true });
    } catch (err) {
      console.error('Failed to mark default:', err);
      toastError(err?.response?.data?.error || 'Failed to update default');
    }
  };

  const handleDeleteConfirmed = async () => {
    if (!pendingDelete) return;
    const item = pendingDelete;
    setPendingDelete(null);
    try {
      await deleteChip(boardId, item._id);
      if (spec.field === 'groupTags') detachGroupTag(item._id);
    } catch (err) {
      console.error('Failed to delete:', err);
      toastError(err?.response?.data?.error || 'Failed to delete');
    }
  };

  return (
    <>
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={spec.title}
      maxWidth={520}
      footer={
        <Button variant="secondary" onClick={onClose}>Done</Button>
      }
    >
      <div className="flex flex-col gap-2">
        {collection.length === 0 ? (
          <p
            className="font-body"
            style={{
              fontSize: 13,
              color: 'var(--color-text-muted)',
              textAlign: 'center',
              padding: '12px 0',
            }}
          >
            None yet — add one below.
          </p>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {collection.map((item) => {
              const nameDraft = draftFor(item._id, 'name');
              const colorDraft = draftFor(item._id, 'color');
              const displayName = nameDraft != null ? nameDraft : item.name;
              const displayColor = colorDraft != null ? colorDraft : item.color;
              const isDefault = isStatuses && item.isDefault;
              return (
                <li
                  key={item._id}
                  className="flex items-center gap-2"
                  style={{
                    padding: '6px 0',
                    borderBottom: '1px solid var(--color-border)',
                  }}
                >
                  <input
                    type="color"
                    value={isValidHex(displayColor) ? displayColor : DEFAULT_NEW_COLOR}
                    onChange={(e) => setDraft(item._id, 'color', e.target.value)}
                    onBlur={() => flushField(item, 'color')}
                    aria-label={`${item.name} color`}
                    style={{
                      width: 32,
                      height: 28,
                      border: '1px solid var(--color-border-strong)',
                      borderRadius: 'var(--radius-sm)',
                      padding: 0,
                      cursor: 'pointer',
                      background: 'transparent',
                    }}
                  />
                  <input
                    type="text"
                    value={displayName}
                    onChange={(e) => setDraft(item._id, 'name', e.target.value)}
                    onBlur={() => flushField(item, 'name')}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        e.currentTarget.blur();
                      }
                    }}
                    aria-label={`${item.name} name`}
                    className="flex-1 font-body focus:outline-none"
                    style={{
                      fontSize: 14,
                      height: 32,
                      padding: '0 10px',
                      border: '1.5px solid var(--color-border)',
                      borderRadius: 'var(--radius-md)',
                      color: 'var(--color-text-primary)',
                    }}
                  />
                  {isStatuses && (
                    <button
                      type="button"
                      onClick={() => !isDefault && handleMarkDefault(item._id)}
                      disabled={isDefault}
                      aria-label={isDefault ? 'Default status' : 'Mark as default'}
                      title={isDefault ? 'Default status' : 'Mark as default'}
                      className="flex items-center justify-center rounded-md transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
                      style={{
                        width: 28,
                        height: 28,
                        background: 'transparent',
                        border: 'none',
                        cursor: isDefault ? 'default' : 'pointer',
                        color: isDefault
                          ? 'var(--color-accent)'
                          : 'var(--color-text-muted)',
                      }}
                    >
                      <Star size={14} fill={isDefault ? 'currentColor' : 'none'} aria-hidden="true" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setPendingDelete(item)}
                    disabled={isDefault}
                    aria-label={`Delete ${item.name}`}
                    className="flex items-center justify-center rounded-md transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)] disabled:opacity-30 disabled:cursor-not-allowed"
                    style={{
                      width: 28,
                      height: 28,
                      background: 'transparent',
                      border: 'none',
                      cursor: isDefault ? 'not-allowed' : 'pointer',
                      color: 'var(--color-text-muted)',
                    }}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <form
          onSubmit={handleAdd}
          className="flex items-center gap-2"
          style={{ marginTop: 8 }}
        >
          <input
            type="color"
            value={newColor}
            onChange={(e) => setNewColor(e.target.value)}
            aria-label="New chip color"
            style={{
              width: 32,
              height: 28,
              border: '1px solid var(--color-border-strong)',
              borderRadius: 'var(--radius-sm)',
              padding: 0,
              cursor: 'pointer',
              background: 'transparent',
            }}
          />
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={spec.addPlaceholder}
            aria-label="New chip name"
            className="flex-1 font-body focus:outline-none"
            style={{
              fontSize: 14,
              height: 32,
              padding: '0 10px',
              border: '1.5px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
              color: 'var(--color-text-primary)',
            }}
          />
          <Button
            type="submit"
            variant="primary"
            size="sm"
            icon={Plus}
            disabled={!newName.trim() || submitting}
          >
            Add
          </Button>
        </form>
      </div>
    </Modal>

    <Modal
      isOpen={!!pendingDelete}
      onClose={() => setPendingDelete(null)}
      title={spec.deleteTitle}
      footer={
        <>
          <Button variant="secondary" onClick={() => setPendingDelete(null)}>
            Cancel
          </Button>
          <Button variant="danger" onClick={handleDeleteConfirmed}>
            Delete
          </Button>
        </>
      }
    >
      <p
        className="font-body"
        style={{ fontSize: 14, color: 'var(--color-text-secondary)' }}
      >
        Delete the {spec.noun}{' '}
        <strong style={{ color: 'var(--color-text-primary)' }}>
          {pendingDelete?.name}
        </strong>
        ? {spec.deleteEffect}
      </p>
    </Modal>
    </>
  );
};

export default EditChipsModal;
