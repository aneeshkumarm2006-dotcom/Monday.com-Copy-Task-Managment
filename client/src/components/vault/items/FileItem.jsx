import { useRef, useState } from 'react';
import { Download, FileUp, Loader2, Paperclip } from 'lucide-react';
import Input from '../../ui/Input';
import Button from '../../ui/Button';
import { formatBytes, saveBlob } from '../../../utils/fileUrl';
import { decryptFile, encryptFile } from '../../../utils/vaultCrypto';
import * as vaultService from '../../../services/vaultService';
import useVaultStore from '../../../store/vaultStore';
import useToastStore from '../../../store/toastStore';

/**
 * File — an upload that is encrypted BEFORE it leaves the browser.
 *
 * The order of operations is the whole feature, so it is worth spelling out:
 *
 *   pick file → read bytes → AES-GCM in the browser → upload the CIPHERTEXT
 *
 * Cloudinary receives an opaque blob under a random name and stores it as a raw
 * asset. That matters because a Cloudinary delivery URL is public to anyone who
 * holds it — there is no per-request authorisation on the object itself. An
 * unencrypted vault attachment would therefore be one leaked URL away from being
 * world-readable, which is the exact failure this vault exists to prevent.
 *
 * The real filename, MIME type and original size never reach the network in the
 * clear either; they are fields of the item payload, sealed with everything
 * else. What the file row stores in the clear is a URL and the ENCRYPTED byte
 * count.
 *
 * Download is the mirror image: fetch bytes, decrypt locally, hand the browser a
 * Blob with the real name restored.
 */

// Matches the server's multer limit. Checked here too so a 40MB pick fails
// instantly instead of after a full upload and a browser-side encryption pass.
const MAX_BYTES = 25 * 1024 * 1024;

export const FileViewer = ({ payload, item }) => {
  const [busy, setBusy] = useState(false);
  const vaultKey = useVaultStore((s) => s.vaultKey);
  const touch = useVaultStore((s) => s.touch);
  const toastError = useToastStore((s) => s.error);

  const handleDownload = async () => {
    if (!item?.file?.url || !vaultKey) return;
    touch();
    setBusy(true);
    try {
      const encrypted = await vaultService.fetchVaultBlob(item.file.url);
      const plain = await decryptFile(encrypted, vaultKey);
      saveBlob(
        new Blob([plain], { type: payload.mime || 'application/octet-stream' }),
        payload.filename || 'download'
      );
    } catch (err) {
      // A GCM failure here means the bytes do not match the key — a truncated
      // upload, or a blob from a vault whose key was replaced. Either way the
      // honest message is "this cannot be opened", not "download failed".
      console.error('Vault file download failed:', err);
      toastError(
        err?.name === 'OperationError'
          ? 'This file could not be decrypted. It may be damaged.'
          : 'Could not download this file.'
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div
        className="flex items-center gap-3 p-3 mb-4"
        style={{
          background: 'var(--color-bg-subtle)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-md)',
        }}
      >
        <Paperclip size={18} color="var(--color-text-muted)" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="font-body text-[14px] text-[color:var(--color-text-primary)] truncate">
            {payload.filename || 'Encrypted file'}
          </p>
          <p className="font-body text-xs text-[color:var(--color-text-muted)]">
            {[payload.mime, formatBytes(payload.size)].filter(Boolean).join(' · ') ||
              'Encrypted'}
          </p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          icon={busy ? Loader2 : Download}
          onClick={handleDownload}
          disabled={busy || !vaultKey}
        >
          {busy ? 'Decrypting…' : 'Download'}
        </Button>
      </div>

      {payload.notes && (
        <p className="font-body text-sm text-[color:var(--color-text-secondary)] whitespace-pre-wrap">
          {payload.notes}
        </p>
      )}
    </div>
  );
};

/**
 * The edit view.
 *
 * `onFileUploaded` is how the encrypted blob's handle reaches the item that is
 * about to be created — the payload carries only what gets sealed, so the
 * cleartext handle travels beside it rather than inside it.
 *
 * Replacing the blob on an existing item is deliberately not offered. The row
 * points at one Cloudinary object; swapping it would orphan the old one and
 * leave a window where the item names a file it cannot open. Delete and re-add
 * is one more click and cannot half-succeed.
 */
export const FileEditor = ({ payload, onChange, onFileUploaded, boardId, existing }) => {
  const inputRef = useRef(null);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);

  const vaultKey = useVaultStore((s) => s.vaultKey);
  const vaultToken = useVaultStore((s) => s.vaultToken);
  const touch = useVaultStore((s) => s.touch);
  // The upload talks to the service directly rather than through a store action,
  // because it needs progress the store has no use for. `guarded` is how it
  // still shares the rule that a lapsed vault token locks the vault.
  const guarded = useVaultStore((s) => s.guarded);

  const handlePick = async (e) => {
    const file = e.target.files?.[0];
    // Clear immediately so picking the same file twice still fires a change.
    e.target.value = '';
    if (!file || !vaultKey) return;

    if (file.size > MAX_BYTES) {
      setError(`That file is too big. The limit is ${formatBytes(MAX_BYTES)}.`);
      return;
    }

    setError(null);
    touch();
    setProgress(0);
    try {
      const bytes = await file.arrayBuffer();
      const sealed = await encryptFile(bytes, vaultKey);
      const handle = await guarded(() =>
        vaultService.uploadVaultBlob(boardId, vaultToken, sealed, setProgress)
      );

      onFileUploaded?.(handle);
      onChange((prev) => ({
        ...prev,
        // Default the title to the filename only when the user has not typed
        // one — re-picking a file should not silently rewrite their title.
        title: prev.title || file.name,
        filename: file.name,
        mime: file.type || 'application/octet-stream',
        size: file.size,
      }));
    } catch (err) {
      console.error('Vault file upload failed:', err);
      setError(err?.response?.data?.error || 'Could not upload that file.');
    } finally {
      setProgress(null);
    }
  };

  const hasFile = !!payload.filename;

  return (
    <div className="flex flex-col gap-4">
      <Input
        label="Title"
        value={payload.title}
        onChange={(e) => onChange((prev) => ({ ...prev, title: e.target.value }))}
        placeholder="Signed contract, recovery codes…"
        required
      />

      <div>
        <span className="block mb-2 font-body font-medium text-[color:var(--color-text-secondary)] text-xs uppercase tracking-wide">
          File
        </span>

        {existing ? (
          <p
            className="font-body text-sm text-[color:var(--color-text-secondary)] p-3"
            style={{
              background: 'var(--color-bg-subtle)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
            }}
          >
            <Paperclip size={14} className="inline mr-1.5 -mt-0.5" aria-hidden="true" />
            {payload.filename}
            <span className="block mt-1 text-xs text-[color:var(--color-text-muted)]">
              The file itself cannot be swapped. Delete this item and add a new one
              to replace it.
            </span>
          </p>
        ) : (
          <>
            <input
              ref={inputRef}
              type="file"
              onChange={handlePick}
              className="sr-only"
              aria-label="Choose a file to encrypt and upload"
            />
            <Button
              variant="secondary"
              icon={progress === null ? FileUp : Loader2}
              onClick={() => inputRef.current?.click()}
              disabled={progress !== null}
            >
              {progress === null
                ? hasFile
                  ? 'Choose a different file'
                  : 'Choose a file'
                : `Encrypting and uploading… ${progress}%`}
            </Button>

            {hasFile && progress === null && (
              <p className="mt-2 font-body text-sm text-[color:var(--color-text-primary)]">
                <Paperclip size={14} className="inline mr-1.5 -mt-0.5" aria-hidden="true" />
                {payload.filename}
                <span className="text-[color:var(--color-text-muted)]">
                  {' '}
                  · {formatBytes(payload.size)}
                </span>
              </p>
            )}
            <p className="mt-2 font-body text-xs text-[color:var(--color-text-muted)]">
              Encrypted in your browser before it is uploaded. Maximum{' '}
              {formatBytes(MAX_BYTES)}.
            </p>
          </>
        )}

        {error && (
          <p
            className="mt-2 font-body text-sm"
            style={{ color: 'var(--color-status-stuck)' }}
          >
            {error}
          </p>
        )}
      </div>

      <Input
        label="Notes"
        value={payload.notes}
        onChange={(e) => onChange((prev) => ({ ...prev, notes: e.target.value }))}
        placeholder="What this file is, and who needs it"
        multiline
        rows={3}
      />
    </div>
  );
};
