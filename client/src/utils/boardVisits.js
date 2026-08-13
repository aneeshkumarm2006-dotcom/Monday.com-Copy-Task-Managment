/**
 * Recently-visited boards — the ordering behind the dashboard's "Recent Boards"
 * card.
 *
 * "Visited" is personal and device-local, so it lives in localStorage rather
 * than on the board: two people opening the same board do not reorder each
 * other's dashboard. Same contract as the personal half of `taskPins.js`.
 *
 * The log is keyed per organisation. Board ids are globally unique, so a single
 * bucket would work, but scoping keeps each org's list bounded and stops a
 * board you can no longer see from occupying a slot after an org switch.
 *
 * Nothing here writes to the server, and nothing prunes ids for deleted boards:
 * an entry only matters when it matches a board the API just returned, so a
 * stale id is inert. The cap is what keeps the list from growing forever.
 */

/** localStorage key prefix. The organisation id is appended. */
export const BOARD_VISITS_KEY = 'dashboard:recentBoards:';

/**
 * How many visits to remember per org. The card shows 5; the extra depth means
 * a board you opened a while back still outranks one you have never opened,
 * instead of falling off the moment you visit five others.
 */
export const VISIT_LOG_LIMIT = 20;

/**
 * Read this org's visit log, most-recently-visited first.
 *
 * Returns `[]` on any storage or parse failure (private mode, quota, a
 * hand-edited value), which degrades the card to the server's own ordering
 * rather than breaking the dashboard.
 */
export const loadBoardVisits = (orgId) => {
  if (!orgId) return [];
  try {
    const raw = localStorage.getItem(BOARD_VISITS_KEY + orgId);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e) => e && typeof e.id === 'string');
  } catch {
    return [];
  }
};

/**
 * Record a visit: move `boardId` to the head of the org's log, stamped now.
 *
 * Idempotent per board — re-recording an existing board re-stamps and re-heads
 * it rather than appending a duplicate, so an effect that fires twice (or a
 * remount) cannot inflate the log.
 */
export const recordBoardVisit = (orgId, boardId) => {
  if (!orgId || !boardId) return;
  try {
    const next = [
      { id: boardId, at: Date.now() },
      ...loadBoardVisits(orgId).filter((e) => e.id !== boardId),
    ].slice(0, VISIT_LOG_LIMIT);
    localStorage.setItem(BOARD_VISITS_KEY + orgId, JSON.stringify(next));
  } catch {
    /* ignore storage failures (private mode, quota) */
  }
};

/**
 * Rank lookup: board id → position in the visit log (0 = most recent).
 * Ids absent from the log are simply absent from the map.
 */
export const visitRanks = (visits) => {
  const ranks = new Map();
  (visits || []).forEach((e, i) => {
    if (!ranks.has(e.id)) ranks.set(e.id, i);
  });
  return ranks;
};

/**
 * Stable partition into [visited…, never-visited…].
 *
 * Visited boards are ordered most-recent-first. Everything else keeps the
 * relative order it arrived in — which is the server's `order asc, updatedAt
 * desc` — so the untouched tail still reflects your My Boards arrangement.
 *
 * Never mutates the input, and returns the original array when there is nothing
 * to reorder, preserving referential equality for downstream memos.
 */
export const sortByRecentlyVisited = (boards, visits) => {
  if (!Array.isArray(boards) || boards.length === 0) return boards;
  const ranks = visitRanks(visits);
  if (ranks.size === 0) return boards;

  const visited = [];
  const rest = [];
  for (const b of boards) {
    if (ranks.has(b?._id)) visited.push(b);
    else rest.push(b);
  }
  if (visited.length === 0) return boards;

  visited.sort((a, b) => ranks.get(a._id) - ranks.get(b._id));
  return visited.concat(rest);
};
