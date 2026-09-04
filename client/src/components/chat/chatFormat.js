/**
 * Formatting helpers shared by everything that draws a conversation — the
 * global /chat page and a client board's Chat tab.
 *
 * Lifted verbatim out of `ChatPage.jsx` when the board tab appeared and needed
 * the same "14:36 / Tue / 12 Aug" column. Two copies of a time format is how
 * one screen starts saying "Aug 12" while the one next to it says "12 Aug".
 *
 * No React and no JSX: these are string functions, and keeping them out of a
 * component file is what lets both surfaces import them without dragging a
 * component graph along.
 */

/**
 * ORGANISATION tile colours — a client company, never a person.
 *
 * People are one flat accent circle everywhere in this app, deliberately (see
 * `utils/avatar.js`: the per-person colour hash was deleted on purpose and must
 * not come back). A channel row for a CLIENT is a different thing: the tile
 * stands for a company, several of them sit in one list, and the colour is what
 * makes the list scannable. Pass a company or channel name, never a user's.
 */
const AVATAR_COLORS = ['#2563EB', '#16A34A', '#EA580C', '#7C3AED', '#D97706', '#DC2626'];

export const tileColor = (seed = '') => {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) & 0xffffffff;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
};

export const initialsOf = (name = '') => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return parts
    .slice(0, 2)
    .map((p) => p.charAt(0).toUpperCase())
    .join('');
};

/** "14:36" today, "Tue" this week, "12 Aug" beyond. The mock's right column. */
export const timeShort = (input) => {
  if (!input) return '';
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (d >= startOfToday) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  const days = (startOfToday - d) / 86400000;
  if (days < 6) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
};

/** 'YYYY-MM' for right now in the board's own calendar — what a task or goal
 *  shared in chat today is ABOUT. en-CA formats as YYYY-MM-DD, so slicing is
 *  timezone-correct without a date library. */
export const currentMonthKey = (timezone) => {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || undefined,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .format(new Date())
      .slice(0, 7);
  } catch {
    return new Date().toISOString().slice(0, 7);
  }
};

export const monthLabel = (monthKey) => {
  if (!monthKey) return '';
  const [y, m] = monthKey.split('-').map(Number);
  if (!y || !m) return '';
  return new Date(y, m - 1, 1).toLocaleDateString([], { month: 'long' }).toUpperCase();
};
