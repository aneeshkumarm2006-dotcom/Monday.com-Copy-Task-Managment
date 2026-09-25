const { FX_PROVIDERS } = require('../../utils/money');
const frankfurter = require('./providers/frankfurter');
const exchangeRateApi = require('./providers/exchangeRateApi');

/**
 * THE PROVIDER REGISTRY — who we can ask about exchange rates.
 *
 * Two entries, and the second one earns its place by keeping the seam honest.
 * A registry with one implementation is an abstraction nobody has tested: the
 * two here disagree about response shape (an array of pairs versus a
 * `conversion_rates` map), about how failures are reported (HTTP status versus
 * an `error-type` field on a 200) and about whether a credential is needed at
 * all — so anything that works against both is genuinely provider-agnostic.
 *
 * Mirrors `FX_PROVIDERS` in `utils/money.js`, which is what the Organisation
 * schema validates against. `checkRegistry` below is the tripwire that says the
 * two agree, in the same spirit as `services/connectors/index.js`.
 */
const PROVIDERS = {
  [frankfurter.key]: frankfurter,
  [exchangeRateApi.key]: exchangeRateApi,
};

/** The provider a workspace has chosen, falling back to the keyless default. */
const getProvider = (key) => PROVIDERS[key] || frankfurter;

/**
 * Throw at startup if the catalog and the registry have drifted.
 *
 * A code in `FX_PROVIDERS` with no module here is a provider the settings
 * screen will happily let somebody select and that can then never be asked
 * anything — a setting that silently does nothing. Better to refuse to boot.
 */
const checkRegistry = () => {
  for (const key of FX_PROVIDERS) {
    if (!PROVIDERS[key]) {
      throw new Error(`fx: "${key}" is offered in utils/money.js but has no provider module`);
    }
  }
  for (const key of Object.keys(PROVIDERS)) {
    if (!FX_PROVIDERS.includes(key)) {
      throw new Error(`fx: provider "${key}" exists but is not offered in utils/money.js`);
    }
  }
  return true;
};

module.exports = { PROVIDERS, getProvider, checkRegistry };
