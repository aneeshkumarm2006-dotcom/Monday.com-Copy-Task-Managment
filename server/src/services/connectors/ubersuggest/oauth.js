const crypto = require('crypto');

const {
  MCP_ENDPOINT,
  DISCOVERY_URL,
  FALLBACK_AUTHORIZATION_ENDPOINT,
  FALLBACK_TOKEN_ENDPOINT,
  CLIENT_ID,
  SCOPES,
  HTTP_TIMEOUT_MS,
} = require('./constants');

/**
 * OAuth 2.1 + PKCE against Ubersuggest's authorization server.
 *
 * The shape of this flow is forced by one fact: the server advertises only
 * `authorization_code` and `refresh_token`. There is NO client_credentials
 * grant, so there is no way to onboard an account without a human clicking
 * through a consent screen once. Everything after that first consent runs
 * unattended on the refresh token — which is why the refresh path below has to
 * be careful about rotation.
 *
 * The client is PUBLIC (`token_endpoint_auth_methods_supported: ["none"]`), so
 * there is no secret to prove who we are. PKCE is the whole of that proof: the
 * verifier never leaves us, only its SHA-256 goes out, and the token endpoint
 * will not exchange a code without the matching original.
 */

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

// Cached for the process lifetime. The endpoints are stable, and re-fetching
// them before every consent would add a network hop to a user-facing click.
let discoveryCache = null;

/**
 * Fetch RFC 8414 metadata, falling back to the verified constants.
 *
 * Discovery is attempted FIRST so a moved endpoint fixes itself without a
 * deploy, and the fallback exists so a discovery blip does not take the connect
 * button down. Having both beats picking one.
 *
 * @returns {Promise<{authorization_endpoint: string, token_endpoint: string}>}
 */
const discover = async () => {
  if (discoveryCache) return discoveryCache;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    let doc;
    try {
      const res = await fetch(DISCOVERY_URL, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`discovery returned ${res.status}`);
      doc = await res.json();
    } finally {
      clearTimeout(timer);
    }

    if (doc && doc.authorization_endpoint && doc.token_endpoint) {
      discoveryCache = {
        authorization_endpoint: doc.authorization_endpoint,
        token_endpoint: doc.token_endpoint,
      };
      return discoveryCache;
    }
    throw new Error('discovery document missing endpoints');
  } catch (err) {
    console.warn(
      `[connectors/ubersuggest] OAuth discovery failed (${err.message}); using verified fallbacks`
    );
    discoveryCache = {
      authorization_endpoint: FALLBACK_AUTHORIZATION_ENDPOINT,
      token_endpoint: FALLBACK_TOKEN_ENDPOINT,
    };
    return discoveryCache;
  }
};

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

/**
 * A fresh PKCE pair.
 *
 * 32 random bytes base64url'd lands at 43 characters, comfortably inside RFC
 * 7636's 43-128 range. S256 rather than `plain` because `plain` would put the
 * verifier itself in the authorization request, and S256 is the only method the
 * server advertises anyway.
 *
 * @returns {{ codeVerifier: string, codeChallenge: string }}
 */
const createPkcePair = () => {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');
  return { codeVerifier, codeChallenge };
};

/** An opaque, single-use CSRF value. The MCP SDK does not check this; we do. */
const createState = () => crypto.randomBytes(24).toString('base64url');

// ---------------------------------------------------------------------------
// Authorization request
// ---------------------------------------------------------------------------

/**
 * Build the URL to send the admin's browser to.
 *
 * @param {Object} args
 * @param {string} args.redirectUri - must match the token request exactly
 * @param {string} args.state
 * @param {string} args.codeChallenge
 * @param {string[]} [args.scopes]
 * @returns {Promise<string>}
 */
const buildAuthorizeUrl = async ({
  redirectUri,
  state,
  codeChallenge,
  scopes = SCOPES,
}) => {
  const discovered = await discover();

  const url = new URL(discovered.authorization_endpoint);
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', scopes.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  // RFC 8707. The server publishes protected-resource metadata, so binding the
  // token to the resource it is for is both supported and free.
  url.searchParams.set('resource', MCP_ENDPOINT);

  return url.toString();
};

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

/**
 * POST to the token endpoint. Shared by the code exchange and the refresh, so
 * the two cannot drift in how they parse a response or report a failure.
 *
 * @param {URLSearchParams} body
 * @returns {Promise<Object>} the raw token response
 */
const postToken = async (body) => {
  const discovered = await discover();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

  let res;
  let text;
  try {
    res = await fetch(discovered.token_endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
      signal: controller.signal,
    });
    text = await res.text();
  } catch (err) {
    throw new Error(
      `Could not reach Ubersuggest to complete sign-in: ${err.message}`
    );
  } finally {
    clearTimeout(timer);
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(
      `Ubersuggest returned an unreadable token response (HTTP ${res.status})`
    );
  }

  if (!res.ok || json.error) {
    // OAuth error responses are provider-controlled text. Log the detail, but
    // the caller decides what a user sees — `error_description` must never be
    // rendered straight into a page.
    const detail = json.error_description || json.error || `HTTP ${res.status}`;
    const err = new Error(`Ubersuggest rejected the request: ${detail}`);
    err.oauthError = json.error || null;
    err.status = res.status;
    throw err;
  }

  if (!json.access_token) {
    throw new Error('Ubersuggest returned no access token');
  }

  return json;
};

/**
 * Normalise a token response into what we store.
 *
 * `expires_in` is honoured IF PRESENT, and nothing is assumed when it is absent.
 * The provider documents no access-token lifetime anywhere, so a hardcoded guess
 * would either refresh constantly or let calls 401 in production. A null
 * `expiresAt` means "refresh reactively on 401", which the MCP client does
 * regardless.
 *
 * @param {Object} raw
 * @param {Object} [previous] - the token set being replaced, if any
 */
const normaliseTokens = (raw, previous = null) => ({
  accessToken: raw.access_token,
  // Refresh tokens may rotate, and the provider does not document whether they
  // do. Keep a new one when offered and fall back to the old one when not — a
  // silent drop here would strand the account at the next refresh.
  refreshToken: raw.refresh_token || (previous && previous.refreshToken) || null,
  tokenType: raw.token_type || 'Bearer',
  scopes:
    typeof raw.scope === 'string'
      ? raw.scope.split(/\s+/).filter(Boolean)
      : (previous && previous.scopes) || [],
  expiresAt:
    typeof raw.expires_in === 'number'
      ? new Date(Date.now() + raw.expires_in * 1000).toISOString()
      : null,
  obtainedAt: new Date().toISOString(),
});

/**
 * Exchange an authorization code for tokens.
 *
 * @param {Object} args
 * @param {string} args.code
 * @param {string} args.codeVerifier - the PKCE original
 * @param {string} args.redirectUri - must equal the one used at /authorize
 * @returns {Promise<Object>} normalised token set
 */
const exchangeCode = async ({ code, codeVerifier, redirectUri }) => {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: CLIENT_ID, // no secret: this is a public client
    code_verifier: codeVerifier,
  });
  return normaliseTokens(await postToken(body));
};

/**
 * Trade a refresh token for a fresh access token.
 *
 * @param {Object} tokens - the stored, normalised token set
 * @returns {Promise<Object>} a new normalised token set
 */
const refreshTokens = async (tokens) => {
  if (!tokens || !tokens.refreshToken) {
    const err = new Error(
      'This Ubersuggest account has no refresh token; it must be reconnected.'
    );
    err.needsReauth = true;
    throw err;
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
    client_id: CLIENT_ID,
  });

  try {
    return normaliseTokens(await postToken(body), tokens);
  } catch (err) {
    // `invalid_grant` is the standard "this refresh token is dead" — revoked at
    // the provider, expired, or rotated out from under us. That is a reconnect,
    // not a retry, and the distinction is what stops the weekly runner hammering
    // a dead account forever.
    if (err.oauthError === 'invalid_grant' || err.status === 400) {
      err.needsReauth = true;
    }
    throw err;
  }
};

/**
 * Is this token set worth using as-is? Unknown expiry counts as usable — see
 * normaliseTokens.
 *
 * @param {Object} tokens
 * @param {number} [skewMs] - refresh this far ahead of the stated expiry
 */
const isAccessTokenFresh = (tokens, skewMs = 60_000) => {
  if (!tokens || !tokens.accessToken) return false;
  if (!tokens.expiresAt) return true;
  return new Date(tokens.expiresAt).getTime() - skewMs > Date.now();
};

module.exports = {
  discover,
  createPkcePair,
  createState,
  buildAuthorizeUrl,
  exchangeCode,
  refreshTokens,
  isAccessTokenFresh,
  normaliseTokens,
};
