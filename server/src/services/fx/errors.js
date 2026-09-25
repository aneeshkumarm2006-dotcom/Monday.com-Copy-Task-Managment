/**
 * What a provider throws.
 *
 * Shaped after `services/connectors/dataforseo/client.js`'s error, and for the
 * same reason: a caller has to be able to tell three things apart that all
 * arrive as an exception —
 *
 *   `retryable`   the provider or the network had a moment, ask again later
 *   `needsConfig` we asked wrongly or with a bad credential, and asking again
 *                 will fail identically until somebody changes a setting
 *   everything else, which is a bug on our side
 *
 * The distinction is what stops the refresh runner hammering a free endpoint
 * with a request that cannot succeed, and what lets the Currency settings
 * screen say "your key was rejected" instead of "something went wrong".
 */
class FxError extends Error {
  constructor(message, { provider, httpStatus, cause, retryable = false, needsConfig = false } = {}) {
    super(message);
    this.name = 'FxError';
    this.provider = provider || null;
    this.httpStatus = httpStatus || null;
    this.cause = cause || null;
    this.retryable = retryable;
    this.needsConfig = needsConfig;
  }

  /**
   * What the Currency settings screen shows.
   *
   * Deliberately the message ONLY — never `cause`, which can carry a URL, and a
   * provider URL can carry the API key in its path.
   */
  toDisplay() {
    return this.message;
  }
}

module.exports = { FxError };
