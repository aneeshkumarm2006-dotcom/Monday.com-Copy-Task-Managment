import { useState } from 'react';
import { Download, Eye } from 'lucide-react';
import {
  downloadFile,
  formatBytes,
  isImageAttachment,
  isPreviewable,
} from '../../utils/fileUrl';
import { FileTypeIcon } from './FileTypeIcon';
import FilePreviewModal from './FilePreviewModal';

// Re-exported for the modules that have always imported it from here.
export { FileTypeIcon };

/**
 * AttachmentList — read-only files hanging off a message or a client request.
 *
 * Rendered the same way the Files tab renders them, deliberately: a client's
 * screenshot used to arrive in the thread as a bare filename chip, which reads
 * as a footnote rather than as the thing they are actually showing you. Images
 * get a real thumbnail; everything else keeps the icon + name + size row.
 *
 * Clicking a row opens FilePreviewModal rather than leaving the app — the
 * arrows in there walk this list, so a five-screenshot update reads as one
 * pass. Files the browser can't render (Word, Excel, archives) have no viewer
 * to open, so they download on click as they always did. The Download button
 * on the row is unconditional either way.
 *
 * Props:
 *   attachments — [{ url, name, mime, size }]
 *   compact     — smaller thumbnails, for dense thread cards
 */
const AttachmentList = ({ attachments, compact = false }) => {
  const list = Array.isArray(attachments) ? attachments : [];
  const [previewIndex, setPreviewIndex] = useState(null);

  if (list.length === 0) return null;

  const thumb = compact ? 56 : 72;

  return (
    <>
      <ul
        className="flex flex-col"
        style={{ listStyle: 'none', margin: '10px 0 0', padding: 0, gap: 6 }}
      >
        {list.map((a, i) => (
          <li key={a._id || `${a.url}-${i}`}>
            <AttachmentRow
              attachment={a}
              thumb={thumb}
              onPreview={() => setPreviewIndex(i)}
            />
          </li>
        ))}
      </ul>

      {previewIndex !== null && (
        <FilePreviewModal
          attachments={list}
          index={previewIndex}
          onIndexChange={setPreviewIndex}
          onClose={() => setPreviewIndex(null)}
        />
      )}
    </>
  );
};

const AttachmentRow = ({ attachment, thumb, onPreview }) => {
  const image = isImageAttachment(attachment);
  const label = attachment.name || 'attachment';
  const previewable = isPreviewable(attachment);

  const handleDownload = () =>
    downloadFile(attachment.url, attachment.mime || '', label);

  // One click handler for the whole row: preview when there's something to
  // look at, download when there isn't.
  const handleOpen = previewable ? onPreview : handleDownload;

  return (
    <div
      className="flex items-center gap-3"
      style={{
        padding: 8,
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-md)',
        background: 'var(--color-bg-surface, #FFFFFF)',
      }}
    >
      <button
        type="button"
        onClick={handleOpen}
        aria-label={previewable ? `Preview ${label}` : `Download ${label}`}
        title={previewable ? `Preview ${label}` : `Download ${label}`}
        style={{
          flexShrink: 0,
          lineHeight: 0,
          padding: 0,
          border: 'none',
          background: 'none',
          cursor: 'pointer',
        }}
      >
        {image ? (
          <img
            src={attachment.url}
            alt={label}
            loading="lazy"
            style={{
              width: thumb,
              height: thumb,
              objectFit: 'cover',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--color-border)',
              display: 'block',
              background: 'var(--color-bg-subtle, #F3F4F6)',
            }}
          />
        ) : (
          <span
            aria-hidden="true"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 36,
              height: 36,
              borderRadius: 'var(--radius-sm)',
              background: 'var(--color-bg-subtle, #F3F4F6)',
              color: 'var(--color-text-secondary)',
            }}
          >
            <FileTypeIcon mime={attachment.mime || ''} size={16} />
          </span>
        )}
      </button>

      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={handleOpen}
          className="font-body text-left transition-colors hover:text-[color:var(--color-accent)]"
          style={{
            fontSize: 12.5,
            fontWeight: 600,
            color: 'var(--color-text-primary)',
            background: 'none',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
            display: 'block',
            width: '100%',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={label}
        >
          {label}
        </button>
        {attachment.size > 0 && (
          <div
            className="font-body"
            style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 2 }}
          >
            {formatBytes(attachment.size)}
          </div>
        )}
      </div>

      {previewable && (
        <IconButton label={`Preview ${label}`} title="Preview" onClick={onPreview}>
          <Eye size={13} aria-hidden="true" />
        </IconButton>
      )}
      <IconButton
        label={`Download ${label}`}
        title="Download"
        onClick={handleDownload}
      >
        <Download size={13} aria-hidden="true" />
      </IconButton>
    </div>
  );
};

const IconButton = ({ label, title, onClick, children }) => (
  <button
    type="button"
    onClick={onClick}
    aria-label={label}
    title={title}
    className="inline-flex items-center justify-center rounded transition-colors hover:bg-[color:var(--color-bg-subtle)]"
    style={{
      width: 26,
      height: 26,
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

export default AttachmentList;
