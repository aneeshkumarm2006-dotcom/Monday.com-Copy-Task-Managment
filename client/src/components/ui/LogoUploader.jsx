import { useEffect, useRef, useState } from 'react';
import { ImagePlus, Trash2, UploadCloud } from 'lucide-react';
import EntityLogo from './EntityLogo';
import Spinner from './Spinner';
import { LOGO_ACCEPT, validateLogoFile } from '../../utils/logoFile';

/**
 * LogoUploader — pick, drop, preview, replace or remove a logo.
 *
 * Shared by the workspace settings, the board's Edit dialog and the logo
 * dialog opened from a board heading or a group header, so choosing a logo
 * feels the same everywhere.
 *
 *   ┌──────────┐  Logo
 *   │  [tile]  │  PNG, JPG, SVG or WEBP · up to 2MB · square works best
 *   └──────────┘  [Upload logo]  [Remove]
 *
 * The tile IS the drop zone and a button — click it, or drag an image onto it.
 * While an upload is in flight the tile shows the picked file straight away
 * (an object URL) under a spinner, so the person sees what they chose rather
 * than waiting on Cloudinary to learn whether they picked the right file.
 *
 * Validation (`utils/logoFile.js`) happens here first, with the same limits the server enforces, so a
 * 9MB photo is refused instantly with a sentence rather than after an upload.
 * The server remains the authority and its message is shown if it refuses.
 *
 * `onUpload(file)` and `onRemove()` are async and should throw on failure; the
 * error's server message (or a fallback) is shown under the buttons.
 */

const errorText = (err, fallback) => err?.response?.data?.error || err?.message || fallback;

const LogoUploader = ({
  value = '',
  name = '',
  color,
  onUpload,
  onRemove,
  disabled = false,
  size = 72,
  label = 'Logo',
  hint = 'PNG, JPG, SVG or WEBP · up to 2MB · square works best',
}) => {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(null); // null | 'upload' | 'remove'
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [pending, setPending] = useState(''); // object URL of the file in flight

  useEffect(() => () => pending && URL.revokeObjectURL(pending), [pending]);

  const locked = disabled || !!busy;

  const handleFile = async (file) => {
    if (!file || locked) return;
    const invalid = validateLogoFile(file);
    if (invalid) {
      setError(invalid);
      return;
    }
    setError('');
    setPending(URL.createObjectURL(file));
    setBusy('upload');
    try {
      await onUpload?.(file);
    } catch (err) {
      setError(errorText(err, "Couldn't upload that logo. Please try again."));
    } finally {
      setBusy(null);
      setPending('');
    }
  };

  const handleRemove = async () => {
    if (locked) return;
    setError('');
    setBusy('remove');
    try {
      await onRemove?.();
    } catch (err) {
      setError(errorText(err, "Couldn't remove the logo. Please try again."));
    } finally {
      setBusy(null);
    }
  };

  const openPicker = () => {
    if (!locked) inputRef.current?.click();
  };

  const shown = pending || value;
  const radius = Math.round(size * 0.22);

  return (
    <div className="flex items-center gap-4">
      <button
        type="button"
        onClick={openPicker}
        disabled={locked}
        onDragOver={(e) => {
          if (locked) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          handleFile(e.dataTransfer?.files?.[0]);
        }}
        aria-label={value ? `Replace ${label.toLowerCase()}` : `Upload ${label.toLowerCase()}`}
        className="group/logo relative shrink-0 flex items-center justify-center focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
        style={{
          width: size,
          height: size,
          borderRadius: radius,
          padding: 0,
          cursor: locked ? 'default' : 'pointer',
          background: shown ? 'transparent' : dragging ? 'var(--color-accent-light)' : 'var(--color-bg-subtle)',
          border: shown
            ? 'none'
            : `1.5px dashed ${dragging ? 'var(--color-accent)' : 'var(--color-border-strong, var(--color-border))'}`,
          boxShadow: shown && dragging ? '0 0 0 3px var(--color-accent-light)' : 'none',
          transition: 'background 120ms ease, border-color 120ms ease, box-shadow 120ms ease',
        }}
      >
        {shown ? (
          <EntityLogo src={shown} name={name} size={size} radius={radius} color={color} />
        ) : (
          <span className="flex flex-col items-center gap-1" style={{ color: dragging ? 'var(--color-accent)' : 'var(--color-text-muted)' }}>
            <ImagePlus size={Math.round(size * 0.3)} aria-hidden="true" />
            {size >= 64 && (
              <span className="font-body" style={{ fontSize: 10.5, fontWeight: 600 }}>
                {dragging ? 'Drop' : 'Add logo'}
              </span>
            )}
          </span>
        )}

        {/* Hover veil over an existing logo: says what a click will do. */}
        {shown && !busy && !disabled && (
          <span
            aria-hidden="true"
            className="absolute inset-0 flex items-center justify-center opacity-0 group-hover/logo:opacity-100 transition-opacity duration-150"
            style={{ borderRadius: radius, background: 'rgba(15, 23, 42, 0.55)', color: '#FFFFFF' }}
          >
            <UploadCloud size={Math.round(size * 0.3)} />
          </span>
        )}

        {busy && (
          <span
            aria-hidden="true"
            className="absolute inset-0 flex items-center justify-center"
            style={{ borderRadius: radius, background: 'rgba(255, 255, 255, 0.7)' }}
          >
            <Spinner size={Math.round(size * 0.3)} />
          </span>
        )}
      </button>

      <div className="min-w-0 flex-1">
        <p className="font-display font-semibold text-[color:var(--color-text-primary)]" style={{ fontSize: 14 }}>
          {label}
        </p>
        <p className="mt-0.5 font-body text-[color:var(--color-text-muted)]" style={{ fontSize: 12 }}>
          {hint}
        </p>
        {!disabled && (
          <div className="mt-2.5 flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={openPicker}
              disabled={locked}
              className="inline-flex items-center gap-1.5 font-body font-semibold text-white bg-accent hover:bg-accent-hover disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
              style={{ height: 30, padding: '0 12px', fontSize: 12.5, borderRadius: 'var(--radius-md)' }}
            >
              <UploadCloud size={14} aria-hidden="true" />
              {busy === 'upload' ? 'Uploading…' : value ? 'Replace' : 'Upload logo'}
            </button>
            {value && (
              <button
                type="button"
                onClick={handleRemove}
                disabled={locked}
                className="inline-flex items-center gap-1.5 font-body font-medium hover:bg-[color:var(--color-bg-subtle)] disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                style={{
                  height: 30,
                  padding: '0 10px',
                  fontSize: 12.5,
                  borderRadius: 'var(--radius-md)',
                  color: 'var(--color-text-secondary)',
                  border: '1px solid var(--color-border)',
                }}
              >
                <Trash2 size={13} aria-hidden="true" />
                {busy === 'remove' ? 'Removing…' : 'Remove'}
              </button>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="mt-2 font-body" style={{ fontSize: 12, color: 'var(--color-status-stuck)' }}>
            {error}
          </p>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={LOGO_ACCEPT}
        className="hidden"
        onChange={(e) => {
          handleFile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
    </div>
  );
};

export default LogoUploader;
