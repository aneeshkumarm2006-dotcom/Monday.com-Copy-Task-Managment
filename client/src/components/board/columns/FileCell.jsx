import { useRef, useState } from 'react';
import { Plus, X, Loader2 } from 'lucide-react';
import { cellWrapperStyle, boardIdOf } from './cellShared';
import { FileTypeIcon } from '../FileTypeIcon';
import FilePreviewModal from '../FilePreviewModal';
import { uploadBoardFile } from '../../../services/boardService';
import useToastStore from '../../../store/toastStore';

/**
 * FileCell — the files held in a `file` column: open, add, remove.
 *
 * ---- Where a file column's files live --------------------------------------
 *
 * In `columnValues[column._id]`, as `[{ url, name, mime, size, publicId }]`.
 * The cell reads that list and writes it back whole through `onChange` (the
 * grid's `setColumnValue`). Uploads go through `uploadBoardFile`, the same
 * board-scoped store the ledger's drop-to-create uses, so a PDF added here and
 * one dropped on the ledger are the same kind of thing.
 *
 * NOT the task panel's Files tab. That tab is `task.attachments`, a separate
 * store — this cell's old comment said uploads happened there, which is why a
 * user-added "Payment receipt" column could never hold a file.
 *
 * Removing a file here deletes it: the server destroys a file column's dropped
 * assets once the save lands, so the × asks first.
 */

const TOO_LARGE = 'Too large — the limit is 25 MB.';

const iconButtonStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'transparent',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
  color: 'inherit',
};

const FileCell = ({ value, column, task, readOnly, onChange }) => {
  const files = Array.isArray(value) ? value.filter((f) => f && typeof f === 'object') : [];
  const [previewIndex, setPreviewIndex] = useState(null);
  const [uploading, setUploading] = useState(0);
  const inputRef = useRef(null);
  const toastError = useToastStore((s) => s.error);

  const boardId = boardIdOf(task);
  const editable = !readOnly && typeof onChange === 'function';
  const canUpload = editable && !!boardId;
  const label = column?.name || 'File';

  const upload = async (list) => {
    const picked = Array.from(list || []);
    if (picked.length === 0 || !boardId) return;
    setUploading(picked.length);
    const stored = [];
    // One at a time: a folder of receipts should not open a dozen parallel
    // uploads, and a failure part-way keeps the files that DID land.
    for (const file of picked) {
      try {
        stored.push(await uploadBoardFile(boardId, file));
      } catch (err) {
        const message =
          err?.response?.status === 413 || err?.code === 'LIMIT_FILE_SIZE'
            ? TOO_LARGE
            : err?.response?.data?.error || 'Upload failed.';
        toastError(`${file.name}: ${message}`);
      } finally {
        setUploading((n) => Math.max(0, n - 1));
      }
    }
    if (stored.length > 0) onChange([...files, ...stored]);
  };

  const remove = (i) => {
    const f = files[i];
    const name = f?.name || 'this file';
    if (!window.confirm(`Remove "${name}" from ${label}? The file will be deleted.`)) return;
    onChange(files.filter((_, j) => j !== i));
  };

  return (
    <div style={{ ...cellWrapperStyle, gap: 4, flexWrap: 'wrap', minWidth: 0 }}>
      {files.length === 0 && !canUpload && <span style={{ color: 'var(--color-text-muted)' }}>—</span>}

      {files.map((f, i) => {
        const name = f.name || 'File';
        return (
          <span
            key={f.publicId || f.url || i}
            className="inline-flex items-center"
            style={{
              gap: 2,
              maxWidth: '100%',
              minWidth: 0,
              padding: '2px 4px 2px 6px',
              fontSize: 12,
              background: 'var(--color-bg-subtle)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--color-text-primary)',
            }}
          >
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setPreviewIndex(i);
              }}
              title={`Open ${name}`}
              aria-label={`Open ${name}`}
              className="hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--color-accent)]"
              style={{ ...iconButtonStyle, gap: 4, minWidth: 0, maxWidth: '100%' }}
            >
              <span style={{ color: 'var(--color-text-muted)', display: 'inline-flex', flexShrink: 0 }}>
                <FileTypeIcon mime={f.mime || ''} size={12} />
              </span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
            </button>
            {editable && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  remove(i);
                }}
                aria-label={`Remove ${name}`}
                title="Remove"
                className="hover:text-[color:var(--color-status-stuck)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--color-accent)]"
                style={{ ...iconButtonStyle, width: 16, height: 16, color: 'var(--color-text-muted)', flexShrink: 0 }}
              >
                <X size={11} aria-hidden="true" />
              </button>
            )}
          </span>
        );
      })}

      {canUpload && (
        <>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              inputRef.current?.click();
            }}
            disabled={uploading > 0}
            aria-label={uploading > 0 ? `Uploading to ${label}` : `Add a file to ${label}`}
            title={uploading > 0 ? 'Uploading…' : 'Add a file'}
            className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--color-accent)]"
            style={{
              ...iconButtonStyle,
              width: 22,
              height: 22,
              flexShrink: 0,
              border: '1px dashed var(--color-border-strong)',
              borderRadius: '50%',
              color: 'var(--color-text-muted)',
              cursor: uploading > 0 ? 'progress' : 'pointer',
            }}
          >
            {uploading > 0 ? (
              <Loader2 size={12} className="animate-spin" aria-hidden="true" />
            ) : (
              <Plus size={12} aria-hidden="true" />
            )}
          </button>
          <input
            ref={inputRef}
            type="file"
            multiple
            hidden
            tabIndex={-1}
            onChange={(e) => {
              const list = e.target.files;
              upload(list);
              // Cleared so choosing the same file again still fires a change.
              e.target.value = '';
            }}
          />
        </>
      )}

      {previewIndex !== null && files[previewIndex] && (
        <FilePreviewModal
          attachments={files}
          index={previewIndex}
          onIndexChange={setPreviewIndex}
          onClose={() => setPreviewIndex(null)}
        />
      )}
    </div>
  );
};

export default FileCell;
