/**
 * Client-side month-key helpers.
 *
 * A month key is the string 'YYYY-MM'. Everything here is PURE STRING MATH —
 * comparison, formatting a key the server already sent, checking a URL param
 * looks sane.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO: work out what month it is. That
 * depends on the board's timezone, and there is no timezone-aware day math on
 * the client — `utils/dateUtils.js` is entirely local-time with no zone
 * parameter, and the server's `tzDay.js` explicitly bans the tempting
 * `.toISOString().slice(0, 7)` one-liner because it is the UTC month and is
 * wrong everywhere except UTC.
 *
 * So: the server sends the month list, the labels, and which key is current.
 * The client picks from that list. If you find yourself reaching for
 * `new Date().getMonth()` here, the answer you want is already in the
 * `/months` response.
 */

const MONTH_KEY_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Does this look like a month key? Used to sanity-check a URL param. */
export const isMonthKey = (value) => typeof value === 'string' && MONTH_KEY_RE.test(value);

/** Lexical comparison is chronological for month keys, by construction. */
export const compareMonthKeys = (a, b) => (a === b ? 0 : a < b ? -1 : 1);

/**
 * Fallback label for a month key the server did not send one for — a stale
 * bookmark, mostly. The server's label is always preferred when present.
 */
const MONTH_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

export const formatMonthKey = (monthKey) => {
  if (!isMonthKey(monthKey)) return '';
  const year = monthKey.slice(0, 4);
  const month = parseInt(monthKey.slice(5, 7), 10);
  return `${MONTH_SHORT[month - 1]} ${year}`;
};

/** Find a month entry from a `/months` response by key. */
export const findMonth = (months, key) =>
  (months || []).find((m) => m.key === key) || null;

// --- Per-board remembered month -------------------------------------------
// The URL is the source of truth (see useBoardMonths); this is only the seed
// used when the URL carries no `?month=`. Same key convention as the existing
// `board:groupSortCompletedLast:<id>` and `board:delivery:prefs:<id>`.

const STORAGE_KEY = 'board:month:';

export const readStoredMonth = (boardId) => {
  if (!boardId) return null;
  try {
    const raw = localStorage.getItem(`${STORAGE_KEY}${boardId}`);
    return isMonthKey(raw) ? raw : null;
  } catch {
    return null;
  }
};

export const writeStoredMonth = (boardId, monthKey) => {
  if (!boardId || !isMonthKey(monthKey)) return;
  try {
    localStorage.setItem(`${STORAGE_KEY}${boardId}`, monthKey);
  } catch {
    // Private browsing, quota, a locked-down profile — remembering the month is
    // a convenience, never a requirement. The URL still holds the real answer.
  }
};
