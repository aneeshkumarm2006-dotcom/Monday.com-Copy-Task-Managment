/**
 * driveLinks.js — detect and classify Google Drive / Docs URLs so the Updates
 * feed can render them as an icon + title chip instead of a raw link.
 *
 * The heavy lifting (fetching the human title) happens server-side via the
 * link-preview proxy; here we only recognise a URL and pick its file type so
 * the right icon and a sensible fallback label can be shown immediately, even
 * before (or without) a title.
 */

// Matches any Google Docs/Drive URL sitting inside a larger run of text. Stops
// at whitespace so a trailing space + mention in the same text node is left
// alone. `g` so callers can split a text node on every occurrence.
export const DRIVE_URL_REGEX =
  /https?:\/\/(?:docs|drive|sheets|slides|forms)\.google\.com\/[^\s]+/gi;

// Per-type presentation. `type` is stable; the chip maps it to a lucide icon.
const TYPE_LABELS = {
  doc: 'Google Doc',
  sheet: 'Google Sheet',
  slide: 'Google Slides',
  form: 'Google Form',
  folder: 'Drive folder',
  file: 'Drive file',
};

/**
 * Classify a Google URL. Returns null when the string is not a recognised
 * Drive/Docs URL, otherwise { type, id, url, label }.
 */
export const parseDriveUrl = (raw) => {
  if (typeof raw !== 'string') return null;
  const url = raw.trim();
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  if (!/\.google\.com$/.test(host) && host !== 'google.com') return null;

  const path = parsed.pathname;
  let type = null;
  if (/\/document\//.test(path)) type = 'doc';
  else if (/\/spreadsheets\//.test(path) || host === 'sheets.google.com') type = 'sheet';
  else if (/\/presentation\//.test(path) || host === 'slides.google.com') type = 'slide';
  else if (/\/forms\//.test(path) || host === 'forms.google.com') type = 'form';
  else if (/\/drive\/folders\//.test(path)) type = 'folder';
  else if (host === 'drive.google.com' && (/\/file\//.test(path) || parsed.searchParams.has('id')))
    type = 'file';

  if (!type) return null;

  // Best-effort document id — used only as a cache key / dedup hint.
  const idMatch = path.match(/\/d\/([^/]+)/) || path.match(/\/folders\/([^/?]+)/);
  const id = idMatch ? idMatch[1] : parsed.searchParams.get('id') || url;

  return { type, id, url, label: TYPE_LABELS[type] || 'Google Drive' };
};

/** Convenience predicate. */
export const isDriveUrl = (raw) => parseDriveUrl(raw) !== null;

/**
 * A short, readable fallback derived from the URL alone — shown while the real
 * title loads or when it can't be fetched (e.g. a private doc).
 */
export const driveFallbackLabel = (raw) => {
  const info = parseDriveUrl(raw);
  return info ? info.label : raw;
};
