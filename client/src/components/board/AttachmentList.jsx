import {
  Download,
  File as FileIcon,
  FileText,
  FileImage,
  FileVideo,
  FileAudio,
  FileArchive,
} from 'lucide-react';
import { downloadFile, formatBytes, isImageAttachment } from '../../utils/fileUrl';

/**
 * FileTypeIcon — a Lucide glyph chosen from the file's MIME type, falling back
 * to a generic file icon when the mime is missing or unrecognised.
 *
 * A component rather than a `pickIcon(mime)` helper on purpose: returning a
 * component from a function and rendering it as `<Icon />` declares a fresh
 * component on every render, which remounts it and loses its state.
 */
export const FileTypeIcon = ({ mime = '', size = 16 }) => {
  if (mime.startsWith('image/')) return <FileImage size={size} />;
  if (mime.startsWith('video/')) return <FileVideo size={size} />;
  if (mime.startsWith('audio/')) return <FileAudio size={size} />;
  if (mime === 'application/pdf') return <FileText size={size} />;
  if (
    mime.includes('zip') ||
    mime.includes('rar') ||
    mime.includes('tar') ||
    mime.includes('7z')
  ) {
    return <FileArchive size={size} />;
  }
  if (mime.startsWith('text/') || mime.includes('document') || mime.includes('word')) {
    return <FileText size={size} />;
  }
  return <FileIcon size={size} />;
};

/**
 * AttachmentList — read-only files hanging off a message or a client request.
 *
 * Rendered the same way the Files tab renders them, deliberately: a client's
 * screenshot used to arrive in the thread as a bare filename chip, which reads
 * as a footnote rather than as the thing they are actually showing you. Images
 * get a real thumbnail that opens full size; everything else keeps the icon +
 * name + size row and downloads through the proxy.
 *
 * Props:
 *   attachments — [{ url, name, mime, size }]
 *   compact     — smaller thumbnails, for dense thread cards
 */
const AttachmentList = ({ attachments, compact = false }) => {
  const list = Array.isArray(attachments) ? attachments : [];
  if (list.length === 0) return null;

  const thumb = compact ? 56 : 72;

  return (
    <ul
      className="flex flex-col"
      style={{ listStyle: 'none', margin: '10px 0 0', padding: 0, gap: 6 }}
    >
      {list.map((a, i) => (
        <li key={a._id || `${a.url}-${i}`}>
          <AttachmentRow attachment={a} thumb={thumb} />
        </li>
      ))}
    </ul>
  );
};

const AttachmentRow = ({ attachment, thumb }) => {
  const image = isImageAttachment(attachment);
  const label = attachment.name || 'attachment';
  const handleDownload = () =>
    downloadFile(attachment.url, attachment.mime || '', label);

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
      {image ? (
        <a
          href={attachment.url}
          target="_blank"
          rel="noopener noreferrer"
          title={`Open ${label}`}
          style={{ flexShrink: 0, lineHeight: 0 }}
        >
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
        </a>
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
            flexShrink: 0,
          }}
        >
          <FileTypeIcon mime={attachment.mime || ''} size={16} />
        </span>
      )}

      <div className="min-w-0 flex-1">
        {image ? (
          <a
            href={attachment.url}
            target="_blank"
            rel="noopener noreferrer"
            className="font-body transition-colors hover:text-[color:var(--color-accent)]"
            style={{
              fontSize: 12.5,
              fontWeight: 600,
              color: 'var(--color-text-primary)',
              textDecoration: 'none',
              display: 'block',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={label}
          >
            {label}
          </a>
        ) : (
          <button
            type="button"
            onClick={handleDownload}
            className="font-body transition-colors hover:text-[color:var(--color-accent)] text-left"
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
        )}
        {attachment.size > 0 && (
          <div
            className="font-body"
            style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 2 }}
          >
            {formatBytes(attachment.size)}
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={handleDownload}
        aria-label={`Download ${label}`}
        title="Download"
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
        <Download size={13} aria-hidden="true" />
      </button>
    </div>
  );
};

export default AttachmentList;
