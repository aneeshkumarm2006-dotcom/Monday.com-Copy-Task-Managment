import { DEFAULT_WINDOW } from './deliveryTrackers';

/**
 * Per-board view preferences for the Delivery tab, in localStorage.
 *
 * These are view preferences, not data. There is no reason to spend a
 * round-trip or a schema field on "I collapsed a section", and keeping them
 * client-side makes them per-user by construction — one person's collapse state
 * can never leak into someone else's view. The cost of losing them (a new
 * browser) is one drag and two clicks.
 *
 * What is NOT here, deliberately: the trackers themselves and the manual
 * confirmations. Those are the commitments and the evidence — everyone must see
 * identical values or the dashboard means nothing.
 *
 * Key shape mirrors the existing `board:groupSortCompletedLast:<boardId>`.
 */

const KEY = (boardId) => `board:delivery:prefs:${boardId}`;

export const DEFAULT_PREFS = {
  order: [], // tracker ids; anything unknown falls to the end
  collapsed: {}, // trackerId -> bool
  windows: {}, // trackerId -> '4w' | '12m' | …
  views: {}, // trackerId -> 'grid' | 'list'
  density: 'comfortable', // 'comfortable' | 'compact'
  hideUntracked: false,
};

export const loadPrefs = (boardId) => {
  if (!boardId) return { ...DEFAULT_PREFS };
  try {
    const raw = window.localStorage.getItem(KEY(boardId));
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_PREFS };
    // Merge over the defaults so a pref added in a later release does not come
    // back undefined for everyone who already has a stored blob.
    return {
      ...DEFAULT_PREFS,
      ...parsed,
      collapsed: { ...parsed.collapsed },
      windows: { ...parsed.windows },
      views: { ...parsed.views },
      order: Array.isArray(parsed.order) ? parsed.order : [],
    };
  } catch {
    // Corrupt JSON, disabled storage, private mode — a broken preference must
    // never stop the dashboard rendering.
    return { ...DEFAULT_PREFS };
  }
};

export const savePrefs = (boardId, prefs) => {
  if (!boardId) return;
  try {
    window.localStorage.setItem(KEY(boardId), JSON.stringify(prefs));
  } catch {
    /* Storage full or unavailable — preferences are not worth surfacing an error. */
  }
};

/** The window preset for a tracker, falling back to its cadence's default. */
export const windowFor = (prefs, tracker) =>
  prefs.windows?.[tracker._id] || DEFAULT_WINDOW[tracker.cadence?.type] || '4w';

/** The trackers in the user's chosen order; unknown ids keep server order at the end. */
export const orderTrackers = (trackers, order = []) => {
  if (!Array.isArray(order) || order.length === 0) return trackers;
  const rank = new Map(order.map((id, i) => [String(id), i]));
  return [...trackers].sort((a, b) => {
    const ra = rank.has(String(a._id)) ? rank.get(String(a._id)) : Number.MAX_SAFE_INTEGER;
    const rb = rank.has(String(b._id)) ? rank.get(String(b._id)) : Number.MAX_SAFE_INTEGER;
    return ra - rb;
  });
};
