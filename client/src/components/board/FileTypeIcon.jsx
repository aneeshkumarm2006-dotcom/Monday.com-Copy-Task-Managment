import {
  File as FileIcon,
  FileText,
  FileImage,
  FileVideo,
  FileAudio,
  FileArchive,
} from 'lucide-react';

/**
 * FileTypeIcon — a Lucide glyph chosen from the file's MIME type, falling back
 * to a generic file icon when the mime is missing or unrecognised.
 *
 * A component rather than a `pickIcon(mime)` helper on purpose: returning a
 * component from a function and rendering it as `<Icon />` declares a fresh
 * component on every render, which remounts it and loses its state.
 *
 * Lives in its own module rather than in AttachmentList because
 * FilePreviewModal needs it too, and AttachmentList imports the modal — sharing
 * it from there would close an import cycle.
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

export default FileTypeIcon;
