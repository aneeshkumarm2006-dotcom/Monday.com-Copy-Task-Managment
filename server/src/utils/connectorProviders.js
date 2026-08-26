/**
 * The external services a tracker board can pull data from.
 *
 * This list is the single source of truth and is IMPORTED by the model rather
 * than retyped there. `utils/boardTypes.js` and `models/Board.js` each carry
 * their own copy of the board-type enum and have already drifted — the file's
 * header comment still says `monthly` where the value is `tracker`. One copy,
 * so that cannot happen here.
 *
 * Adding a provider is an entry here plus a directory under
 * `services/connectors/`. Nothing else in the app should ever name a provider.
 *
 * Keys are PERSISTED on ConnectorAccount documents, so renaming one is a
 * migration, not a refactor — the same rule the capability keys carry.
 */
const CONNECTOR_PROVIDERS = ['ubersuggest'];

const CONNECTOR_PROVIDER_SET = new Set(CONNECTOR_PROVIDERS);

/** @param {string} key @returns {boolean} */
const isConnectorProvider = (key) => CONNECTOR_PROVIDER_SET.has(key);

/**
 * Human labels, for error messages and the Add-ons catalog. Kept here rather
 * than in the client so the server can name a provider in a 400 without the two
 * disagreeing about its spelling.
 */
const CONNECTOR_PROVIDER_LABELS = {
  ubersuggest: 'Ubersuggest',
};

/** @param {string} key @returns {string} */
const connectorProviderLabel = (key) => CONNECTOR_PROVIDER_LABELS[key] || key;

module.exports = {
  CONNECTOR_PROVIDERS,
  isConnectorProvider,
  connectorProviderLabel,
};
