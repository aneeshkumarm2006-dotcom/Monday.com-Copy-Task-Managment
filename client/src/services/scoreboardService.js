import api from './api';

/**
 * The People scoreboard — one month of a tracker board, per person.
 *
 * Every number arrives already computed. The client sorts and renders; it never
 * recomputes a score, for the same reason goalService says so: two
 * implementations of a scoring rule is the same class of bug as two
 * implementations of a permission rule, and here the rule has to agree with two
 * other tabs at once.
 *
 * `suppressErrorToast`, matching goalService and trackerService — a 403 or 404
 * is meaningful information (not a tracker board; no capability) and the tab
 * renders the server's own sentence instead of firing a generic toast.
 */
export const getScoreboard = async (boardId, monthKey) => {
  const { data } = await api.get(`/api/boards/${boardId}/scoreboard`, {
    params: { month: monthKey },
    suppressErrorToast: true,
  });
  return data.scoreboard;
};

export default { getScoreboard };
