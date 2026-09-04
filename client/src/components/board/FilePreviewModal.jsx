import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  X,
} from 'lucide-react';
import {
  downloadFile,
  fetchAttachmentBlob,
  formatBytes,
  previewKindFor,
} from '../../utils/fileUrl';
import { FileTypeIcon } from './FileTypeIcon';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * FilePreviewModal — a lightbox for attachments, so a screenshot or a PDF can
 * be read without leaving the thread.
 *
 * Before this, every attachment click was a trip out of the app: images opened
 * a new tab and everything else landed in the downloads folder, which is a lot
 * of ceremony to read the two-page PDF a client hung off a request. The viewer
 * keeps the reader in place; the Download button is still there for when they
 * genuinely want the file.
 *
 * Props:
 *   attachments    — the full list the click came from, so ← / → walk it
 *   index          — which one is showing
 *   onIndexChange  — (nextIndex) => void
 *   onClose        — () => void
 *
 * Rendering is per media kind (see `previewKindFor`):
 *   image / video  — straight off the Cloudinary URL; those resource types are
 *                    publicly deliverable and stream without a round trip.
 *   pdf / audio / text
 *                  — fetched as a blob through the authenticated proxy, because
 *                    `raw` uploads are not publicly deliverable.
 *   anything else  — Word, Excel, PowerPoint, archives: the browser has no
 *                    native renderer, so the panel says so and offers Download.
 */
const FilePreviewModal = ({ attachments, index, onIndexChange, onClose }) => {
  const list = Array.isArray(attachments) ? attachments : [];
  const current = list[index] || null;

  const kind = current ? previewKindFor(current) : null;
  const url = current?.url || '';
  const mime = current?.mime || '';
  const label = current?.name || 'attachment';
  const needsFetch = kind === 'pdf' || kind === 'audio' || kind === 'text';

  // What the proxy came back with, tagged with the URL it was fetched for.
  // Tagging is what lets `status` below be derived rather than reset in an
  // effect: the moment the reader hits →, `resolved.url` no longer matches and
  // the panel reads as loading again without a second render pass.
  const [resolved, setResolved] = useState(null);
  const panelRef = useRef(null);
  const objectUrlRef = useRef(null);

  const releaseObjectUrl = () => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  };

  // Pull down the bytes for whichever attachment is showing. Keyed on the URL
  // rather than the index so the list shifting underneath us (a new update
  // arriving over SSE) doesn't silently swap the file being read.
  useEffect(() => {
    if (!needsFetch || !url) return undefined;

    // A `cancelled` flag rather than an AbortController: the fetch lives inside
    // fetchAttachmentBlob, and all this needs is to not setState for a file the
    // reader has already navigated away from.
    let cancelled = false;

    (async () => {
      try {
        const blob = await fetchAttachmentBlob(url, mime, label);
        if (cancelled) return;

        if (kind === 'text') {
          setResolved({ url, status: 'ready', text: await blob.text() });
          return;
        }
        objectUrlRef.current = URL.createObjectURL(blob);
        setResolved({ url, status: 'ready', src: objectUrlRef.current });
      } catch (err) {
        if (cancelled) return;
        console.error('Attachment preview failed:', err);
        setResolved({
          url,
          status: 'error',
          message: "This file couldn't be loaded for preview.",
        });
      }
    })();

    // Runs on unmount and between files, so a blob is never held past the file
    // that needed it.
    return () => {
      cancelled = true;
      releaseObjectUrl();
    };
  }, [url, mime, kind, needsFetch, label]);

  const source = !needsFetch
    ? { status: 'ready', src: url }
    : resolved && resolved.url === url
      ? resolved
      : { status: 'loading' };

  const goTo = useCallback(
    (next) => {
      if (next < 0 || next >= list.length) return;
      onIndexChange?.(next);
    },
    [list.length, onIndexChange]
  );

  // ESC closes, arrows walk the list, Tab stays inside the panel. Capture phase
  // so the arrow keys don't also reach the board behind the overlay.
  useEffect(() => {
    const handleKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose?.();
      } else if (e.key === 'ArrowLeft' && list.length > 1) {
        e.stopPropagation();
        goTo(index - 1);
      } else if (e.key === 'ArrowRight' && list.length > 1) {
        e.stopPropagation();
        goTo(index + 1);
      } else if (e.key === 'Tab') {
        // Same simple trap Modal uses — `aria-modal` promises focus stays put.
        const panel = panelRef.current;
        if (!panel) return;
        const focusable = panel.querySelectorAll(FOCUSABLE_SELECTOR);
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', handleKey, true);
    return () => document.removeEventListener('keydown', handleKey, true);
  }, [goTo, index, list.length, onClose]);

  // Scroll lock, matching Modal's behaviour.
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const t = window.setTimeout(() => panelRef.current?.focus(), 10);
    return () => {
      window.clearTimeout(t);
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  if (!current) return null;

  const handleOverlayMouseDown = (e) => {
    if (e.target === e.currentTarget) onClose?.();
  };

  const node = (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={'Preview: ' + label}
      className="fixed inset-0 flex items-center justify-center px-4 py-4"
      onMouseDown={handleOverlayMouseDown}
      style={{
        // Above everything: the task panel is 100, and the body-portaled
        // pickers that have to escape it (assignee, status, date) are 200. A
        // full-screen viewer with a status dropdown floating over it is worse
        // than no viewer, so this sits clear of the whole stack.
        zIndex: 300,
        background: 'rgba(15, 23, 42, 0.78)',
        animation: 'macan-modal-fade 200ms ease-out',
      }}
    >
      {list.length > 1 && (
        <NavButton
          side="left"
          disabled={index === 0}
          onClick={() => goTo(index - 1)}
        />
      )}

      <div
        ref={panelRef}
        tabIndex={-1}
        className="relative flex w-full flex-col outline-none"
        style={{
          maxWidth: 1040,
          height: 'min(88vh, 900px)',
          background: 'var(--color-bg-surface, #FFFFFF)',
          borderRadius: 'var(--radius-xl)',
          boxShadow: 'var(--shadow-lg)',
          overflow: 'hidden',
          animation: 'macan-modal-scale 200ms ease-out',
        }}
      >
        <PreviewHeader
          attachment={current}
          label={label}
          position={list.length > 1 ? `${index + 1} / ${list.length}` : ''}
          onClose={onClose}
        />

        <div
          className="flex min-h-0 flex-1 items-center justify-center"
          style={{
            background:
              kind === 'image' || kind === 'video'
                ? 'var(--color-bg-subtle, #F3F4F6)'
                : 'var(--color-bg-surface, #FFFFFF)',
            overflow: 'auto',
          }}
        >
          <PreviewBody
            key={url}
            attachment={current}
            kind={kind}
            label={label}
            source={source}
          />
        </div>
      </div>

      {list.length > 1 && (
        <NavButton
          side="right"
          disabled={index === list.length - 1}
          onClick={() => goTo(index + 1)}
        />
      )}

      <style>{`
        @keyframes macan-modal-fade {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        @keyframes macan-modal-scale {
          from { opacity: 0; transform: scale(0.97); }
          to   { opacity: 1; transform: scale(1); }
        }
      `}</style>
    </div>
  );

  return createPortal(node, document.body);
};

/* ---- header ---------------------------------------------------------------- */

const PreviewHeader = ({ attachment, label, position, onClose }) => (
  <div
    className="flex shrink-0 items-center gap-3"
    style={{
      height: 56,
      padding: '0 12px 0 16px',
      borderBottom: '1px solid var(--color-border)',
    }}
  >
    <span
      aria-hidden="true"
      style={{ color: 'var(--color-text-secondary)', lineHeight: 0 }}
    >
      <FileTypeIcon mime={attachment.mime || ''} size={16} />
    </span>

    <div className="min-w-0 flex-1">
      <div
        className="font-body"
        style={{
          fontSize: 13.5,
          fontWeight: 600,
          color: 'var(--color-text-primary)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={label}
      >
        {label}
      </div>
      {(attachment.size > 0 || position) && (
        <div
          className="font-body"
          style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 1 }}
        >
          {[formatBytes(attachment.size), position].filter(Boolean).join(' · ')}
        </div>
      )}
    </div>

    <HeaderButton
      label="Open in new tab"
      onClick={() => window.open(attachment.url, '_blank', 'noopener,noreferrer')}
    >
      <ExternalLink size={15} aria-hidden="true" />
    </HeaderButton>
    <HeaderButton
      label={`Download ${label}`}
      title="Download"
      onClick={() => downloadFile(attachment.url, attachment.mime || '', label)}
    >
      <Download size={15} aria-hidden="true" />
    </HeaderButton>
    <HeaderButton label="Close preview" title="Close" onClick={onClose}>
      <X size={17} aria-hidden="true" />
    </HeaderButton>
  </div>
);

const HeaderButton = ({ label, title, onClick, children }) => (
  <button
    type="button"
    onClick={onClick}
    aria-label={label}
    title={title || label}
    className="inline-flex items-center justify-center rounded-md transition-colors hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
    style={{
      width: 32,
      height: 32,
      background: 'transparent',
      border: 'none',
      color: 'var(--color-text-secondary)',
      cursor: 'pointer',
      flexShrink: 0,
    }}
  >
    {children}
  </button>
);

const NavButton = ({ side, disabled, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    aria-label={side === 'left' ? 'Previous file' : 'Next file'}
    className="hidden items-center justify-center rounded-full transition-opacity sm:inline-flex"
    style={{
      width: 40,
      height: 40,
      flexShrink: 0,
      margin: side === 'left' ? '0 12px 0 0' : '0 0 0 12px',
      background: 'rgba(255, 255, 255, 0.14)',
      border: 'none',
      color: '#FFFFFF',
      cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.25 : 1,
    }}
  >
    {side === 'left' ? (
      <ChevronLeft size={20} aria-hidden="true" />
    ) : (
      <ChevronRight size={20} aria-hidden="true" />
    )}
  </button>
);

/* ---- body ------------------------------------------------------------------ */

const PreviewBody = ({ attachment, kind, label, source }) => {
  if (kind === null) {
    return (
      <Fallback
        attachment={attachment}
        label={label}
        message="This file type can't be previewed in the browser."
      />
    );
  }

  if (source.status === 'loading') {
    return (
      <div
        className="font-body"
        style={{ fontSize: 13, color: 'var(--color-text-muted)' }}
      >
        Loading preview…
      </div>
    );
  }

  if (source.status === 'error') {
    return (
      <Fallback attachment={attachment} label={label} message={source.message} />
    );
  }

  if (kind === 'image') {
    return <ImagePreview src={source.src} label={label} />;
  }

  if (kind === 'video') {
    return (
      <video
        src={source.src}
        controls
        style={{ maxWidth: '100%', maxHeight: '100%', display: 'block' }}
      />
    );
  }

  if (kind === 'audio') {
    return (
      <div style={{ padding: 32, width: '100%', maxWidth: 520 }}>
        <audio src={source.src} controls style={{ width: '100%' }} />
      </div>
    );
  }

  if (kind === 'pdf') {
    return (
      <iframe
        src={source.src}
        title={label}
        style={{ width: '100%', height: '100%', border: 'none' }}
      />
    );
  }

  // text
  return (
    <pre
      style={{
        margin: 0,
        padding: 20,
        width: '100%',
        height: '100%',
        overflow: 'auto',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 12.5,
        lineHeight: 1.55,
        color: 'var(--color-text-primary)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      {source.text}
    </pre>
  );
};

/**
 * A screenshot is usually pasted at full monitor width, so it arrives scaled to
 * fit and unreadable in the corner that matters. Clicking swaps to 1:1 and lets
 * the surrounding container scroll. State lives here, and PreviewBody is keyed
 * by URL, so paging to the next file starts fitted again.
 */
const ImagePreview = ({ src, label }) => {
  const [zoomed, setZoomed] = useState(false);

  return (
    <img
      src={src}
      alt={label}
      onClick={() => setZoomed((z) => !z)}
      style={{
        display: 'block',
        cursor: zoomed ? 'zoom-out' : 'zoom-in',
        ...(zoomed
          ? { maxWidth: 'none', maxHeight: 'none' }
          : { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }),
      }}
    />
  );
};

/**
 * The honest dead end: a .docx, an .xlsx, a zip, or a file the proxy couldn't
 * reach. Says why there's nothing to look at and puts the download one click
 * away, rather than showing an empty frame.
 */
const Fallback = ({ attachment, label, message }) => (
  <div
    className="flex flex-col items-center text-center"
    style={{ padding: 40, gap: 12 }}
  >
    <span
      aria-hidden="true"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 56,
        height: 56,
        borderRadius: 'var(--radius-md)',
        background: 'var(--color-bg-subtle, #F3F4F6)',
        color: 'var(--color-text-secondary)',
      }}
    >
      <FileTypeIcon mime={attachment.mime || ''} size={24} />
    </span>
    <p
      className="font-body"
      style={{ margin: 0, fontSize: 13, color: 'var(--color-text-secondary)' }}
    >
      {message}
    </p>
    <button
      type="button"
      onClick={() => downloadFile(attachment.url, attachment.mime || '', label)}
      className="font-body inline-flex items-center gap-2 rounded-md transition-colors hover:opacity-90"
      style={{
        padding: '8px 14px',
        fontSize: 13,
        fontWeight: 600,
        color: '#FFFFFF',
        background: 'var(--color-accent)',
        border: 'none',
        cursor: 'pointer',
      }}
    >
      <Download size={14} aria-hidden="true" />
      Download
    </button>
  </div>
);

export default FilePreviewModal;
