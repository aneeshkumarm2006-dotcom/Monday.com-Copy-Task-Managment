import api from './api';

/**
 * Exchange rates, for the browser.
 *
 * Not under `/api/orgs/:id` and not in `orgService`, because the rates are not
 * the workspace's: `FxSnapshot` is global on purpose — a rate is a public fact,
 * so one row serves everybody and the browser should not re-fetch an identical
 * table every time somebody switches workspace.
 */

/** `{ base, displayCurrencies, snapshots: [{ dayKey, rates }], asOf }`. */
export const listRates = async () => {
  const { data } = await api.get('/api/fx/rates');
  return data;
};

/**
 * Fetch rates right now, using this workspace's provider and credential.
 *
 * The one rate call that IS per-workspace, which is why it lives on the org
 * route behind `org.manage_settings`. For somebody who has just pasted an API
 * key and wants to know it works before walking away.
 */
export const refreshRates = async (orgId) => {
  const { data } = await api.post(`/api/orgs/${orgId}/currency/refresh`);
  return data;
};
