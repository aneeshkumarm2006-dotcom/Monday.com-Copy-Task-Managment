/**
 * Formatting for the Gmail and WhatsApp skins — see styles/conversations.css.
 *
 * Both skins render on BOTH planes (the external client portal and the team's
 * board tab), and the whole point of copying an interface this closely is that
 * the two sides are indistinguishable. A date that reads "3 Sep" for the client
 * and "Sep 3" for the team would give that away on the first screenshot, so the
 * formats live here once and neither plane owns them.
 *
 * No React and no services: a portal page must be able to import this without
 * dragging `services/api.js` — whose 401 handler deletes a team member's own
 * token — into a page an outside company loads.
 */

/* ---- Gmail ---------------------------------------------------------------- */

/**
 * The date column in a conversation list. Gmail's own three cases: a time for
 * today, "Sep 3" inside this year, and a numeric date beyond it.
 */
export const gmailListDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay =
    d.getDate() === now.getDate() &&
    d.getMonth() === now.getMonth() &&
    d.getFullYear() === now.getFullYear();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  return d.toLocaleDateString([], { year: '2-digit', month: 'numeric', day: 'numeric' });
};

/** The stamp beside a sender inside an open conversation. */
export const gmailStamp = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const opts =
    d.getFullYear() === now.getFullYear()
      ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
      : { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  return d.toLocaleString([], opts);
};

/** The full form, for the `title` on a stamp — Gmail puts the weekday there. */
export const gmailStampLong = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString([], {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
};

/** "(2 hours ago)", the way Gmail trails its stamps. Empty past a week. */
export const gmailAgo = (iso) => {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} ${mins === 1 ? 'minute' : 'minutes'} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.round(hours / 24);
  if (days <= 7) return `${days} ${days === 1 ? 'day' : 'days'} ago`;
  return '';
};

/* ---- WhatsApp ------------------------------------------------------------- */

/** The time inside a bubble. */
export const waClock = (iso) => {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
};

export const dayKey = (iso) => {
  try {
    return new Date(iso).toDateString();
  } catch {
    return '';
  }
};

/** The capsule between days: TODAY, YESTERDAY, then the date. */
export const waDayLabel = (iso) => {
  try {
    const d = new Date(iso);
    const today = new Date();
    const yest = new Date(today);
    yest.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === yest.toDateString()) return 'Yesterday';
    if (d.getFullYear() === today.getFullYear()) {
      return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
    }
    return d.toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' });
  } catch {
    return '';
  }
};

/* ---- files ---------------------------------------------------------------- */

export const formatBytes = (n) => {
  const b = Number(n);
  if (!Number.isFinite(b) || b <= 0) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  const mb = b / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
};

const EXT = (a) => {
  const from = (a?.name || a?.url || '').split('?')[0];
  const dot = from.lastIndexOf('.');
  return dot === -1 ? '' : from.slice(dot + 1).toLowerCase();
};

export const isImageAttachment = (a) =>
  (a?.mime || '').startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(EXT(a));

/**
 * Which coloured square a file gets. Gmail tints by family — red for PDF, green
 * for a sheet, blue for a doc — and that colour is how a chip is recognised
 * before the filename is read.
 */
export const attachmentKind = (a) => {
  const mime = (a?.mime || '').toLowerCase();
  const ext = EXT(a);
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (isImageAttachment(a)) return 'img';
  if (['doc', 'docx', 'rtf', 'odt', 'txt', 'md'].includes(ext) || mime.includes('word')) return 'doc';
  if (['xls', 'xlsx', 'csv', 'ods'].includes(ext) || mime.includes('sheet') || mime.includes('excel')) {
    return 'sheet';
  }
  return 'file';
};

/** The three-letter badge inside that square. */
export const attachmentLabel = (a) => {
  const ext = EXT(a);
  if (ext) return ext.slice(0, 4).toUpperCase();
  return attachmentKind(a).toUpperCase();
};

/** The initial in an avatar circle. */
export const initialOf = (name) => (name || '?').trim().charAt(0).toUpperCase() || '?';
