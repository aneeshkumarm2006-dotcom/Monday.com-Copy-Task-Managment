import api from './api';

/**
 * Ads budgets. Every read comes back with the server's computed pacing state
 * already attached — the client never decides whether a client is on track,
 * because two implementations of a threshold is two answers to the question the
 * whole tab exists to ask.
 *
 * `suppressErrorToast` throughout, matching goalService and trackerService: a
 * 403 or 404 here is meaningful information (no capability, not a tracker
 * board, or the add-on is switched off) and the tab renders the server's own
 * sentence rather than firing a generic toast.
 */

/** The roster: every client on the board, rolled up for one month. */
export const getRoster = async (boardId, monthKey) => {
  const { data } = await api.get(`/api/boards/${boardId}/ads-budget`, {
    params: { month: monthKey },
    suppressErrorToast: true,
  });
  return data;
};

/** One client's month: KPI totals, platforms, and each platform's campaigns. */
export const getClientBudget = async (boardId, groupId, monthKey) => {
  const { data } = await api.get(`/api/boards/${boardId}/ads-budget/${groupId}`, {
    params: { month: monthKey },
    suppressErrorToast: true,
  });
  return data;
};

/**
 * The Budget Activity ledger for one client's month.
 *
 * Its own request rather than part of the read above, deliberately: it walks an
 * activity table and answers a question nobody asks while reading the budget
 * tables. Folding it in would put that work on every open of the tab for the
 * benefit of a panel at the bottom of the page — and, worse, would let a failed
 * ledger read blank the tables.
 */
export const getClientActivity = async (boardId, groupId, { monthKey, cursor, limit } = {}) => {
  const { data } = await api.get(`/api/boards/${boardId}/ads-budget/${groupId}/activity`, {
    params: { month: monthKey, cursor, limit },
    suppressErrorToast: true,
  });
  return data;
};

/**
 * Create a platform row (no `parent`) or a campaign row (`parent` set).
 *
 * A campaign inherits its parent's month and client server-side whatever this
 * sends, so the caller does not have to keep three fields in step.
 */
export const createBudgetRow = async (boardId, payload) => {
  const { data } = await api.post(`/api/boards/${boardId}/ads-budget`, payload, {
    suppressErrorToast: true,
  });
  return data.row;
};

/**
 * A payload touching ONLY `spent` needs the lower `adsBudget.track` rung;
 * anything else needs `adsBudget.manage`. The server decides that from the
 * body — and from whether the value actually moved — so there is nothing to
 * pass here.
 */
export const updateBudgetRow = async (rowId, payload) => {
  const { data } = await api.patch(`/api/ads-budget/${rowId}`, payload, {
    suppressErrorToast: true,
  });
  return data.row;
};

/** Deleting a platform takes its campaigns with it; the count comes back. */
export const deleteBudgetRow = async (rowId) => {
  const { data } = await api.delete(`/api/ads-budget/${rowId}`, {
    suppressErrorToast: true,
  });
  return data;
};

export const reorderBudgetRows = async (boardId, orderedIds) => {
  const { data } = await api.put(`/api/boards/${boardId}/ads-budget/reorder`, { orderedIds });
  return data;
};

/** The add-on's own switch, and the board's currency. `adsBudget.manage`. */
export const setAdsBudgetSettings = async (boardId, settings) => {
  const { data } = await api.put(`/api/boards/${boardId}/ads-budget-settings`, settings, {
    suppressErrorToast: true,
  });
  return data.adsBudget;
};
