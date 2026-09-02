/**
 * `import.meta.env?` rather than `import.meta.env.` — one character, and it is
 * what lets the export modules that import `saveBlob` be loaded by the plain
 * `node --test` runner the client suite uses. Vite always defines `env`, so this
 * changes nothing in the app; outside Vite it is undefined and the bare access
 * throws at module load, taking every importer down with it.
 */
const API_BASE = import.meta.env?.VITE_API_BASE_URL || 'http://localhost:5000';

/** "1.4 MB" — empty string for a missing or zero size, so callers can render it raw. */
export const formatBytes = (bytes) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
};

/**
 * Does this attachment get a thumbnail? Images are the only kind we can show
 * inline in a list row — everything else gets a type icon.
 */
export const isImageAttachment = (attachment) =>
  (attachment?.mime || '').startsWith('image/');

/** Lowercased extension without the dot, or '' when the name carries none. */
const extensionOf = (name = '') => {
  const lower = String(name).toLowerCase();
  const dot = lower.lastIndexOf('.');
  return dot > 0 ? lower.slice(dot + 1) : '';
};

// Plain-text-ish files we render in a <pre>. Kept as an explicit list because
// a browser's idea of "text" is broader than what is pleasant to read raw.
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log',
  'xml', 'yml', 'yaml', 'html', 'css', 'js', 'jsx', 'ts', 'tsx', 'sql',
]);

/**
 * Which preview surface can show this file *inside the app*, or null when the
 * browser has nothing native to render it with (Word, Excel, PowerPoint, zips).
 *
 * Extension is consulted as well as MIME because legacy attachment rows were
 * stored without a `mime` at all, and some browsers hand us a bare
 * `application/octet-stream` for a perfectly ordinary PDF.
 */
export const previewKindFor = (attachment) => {
  const mime = (attachment?.mime || '').toLowerCase();
  const ext = extensionOf(attachment?.name || '');

  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (mime.startsWith('text/') || mime === 'application/json') return 'text';
  if (!mime && TEXT_EXTENSIONS.has(ext)) return 'text';
  return null;
};

/** True when clicking the row should open the viewer rather than download. */
export const isPreviewable = (attachment) => previewKindFor(attachment) !== null;

/**
 * Hand a Blob to the browser as a download.
 *
 * The anchor-click dance is the only way to name a downloaded blob, and it has
 * to revoke the object URL afterwards or the blob is pinned in memory for the
 * life of the document. Split out so locally-generated files (the board
 * activity export's CSV and PDF) and proxied attachments share one copy of it.
 */
export const saveBlob = (blob, name = 'download') => {
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(objectUrl);
};

/**
 * Pull an attachment's bytes down through the server proxy.
 *
 * Everything non-image goes this way rather than straight at the Cloudinary
 * URL: `raw` uploads (PDFs, docs, audio) sit behind delivery restrictions the
 * browser can't satisfy, and the proxy signs the URL server-side. It also
 * carries the JWT, so this is app-plane only — the client portal has its own
 * token scope and must not call it.
 *
 * The blob is re-tagged with the attachment's own MIME when Cloudinary's
 * Content-Type disagrees: a PDF served as `application/octet-stream` makes an
 * <iframe> offer a download instead of rendering the document.
 */
export const fetchAttachmentBlob = async (url, mime = '', name = 'file') => {
  const token = localStorage.getItem('macan_token');
  // URLSearchParams encodes values automatically — don't pre-encode or it double-encodes
  const params = new URLSearchParams({ url, name });

  const res = await fetch(`${API_BASE}/api/proxy/download?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Server returned ${res.status}`);

  const blob = await res.blob();
  if (mime && blob.type !== mime) return blob.slice(0, blob.size, mime);
  return blob;
};

/**
 * Programmatically download a file attachment.
 *
 * Fetched through the proxy so the saved file keeps its real name — a plain
 * link to a cross-origin Cloudinary URL ignores the `download` attribute and
 * saves whatever public_id the upload was given. Opening the raw URL is the
 * last-resort fallback if the proxy itself fails.
 */
export const downloadFile = async (url, mime = '', name = 'file') => {
  if (!url) return;

  try {
    saveBlob(await fetchAttachmentBlob(url, mime, name), name);
  } catch (err) {
    console.error('File download failed:', err);
    window.open(url, '_blank', 'noopener,noreferrer');
  }
};
