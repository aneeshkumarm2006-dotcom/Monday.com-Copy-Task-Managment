const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000';

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
 * inline — and the only kind `downloadFile` opens directly rather than proxying.
 */
export const isImageAttachment = (attachment) =>
  (attachment?.mime || '').startsWith('image/');

/**
 * Programmatically download a file attachment.
 *
 * Images open in a new tab directly (no auth needed, Cloudinary serves them).
 * All other files (PDFs, docs, zips…) are fetched via the server proxy with
 * the JWT token in the Authorization header, then triggered as a blob download
 * so the browser never tries to navigate to the URL itself.
 */
export const downloadFile = async (url, mime = '', name = 'file') => {
  if (!url) return;

  if (mime.startsWith('image/')) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }

  const token = localStorage.getItem('macan_token');
  // URLSearchParams encodes values automatically — don't pre-encode or it double-encodes
  const params = new URLSearchParams({ url, name });
  const proxyUrl = `${API_BASE}/api/proxy/download?${params}`;

  try {
    const res = await fetch(proxyUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Server returned ${res.status}`);

    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(objectUrl);
  } catch (err) {
    console.error('File download failed:', err);
  }
};
