/**
 * Ubersuggest MCP — endpoints and protocol constants.
 *
 * Everything here was verified live against the server rather than taken from
 * the vendor's prose, because the prose is wrong in three places that matter:
 *
 *   - The pricing-page FAQ and Zendesk article 4405444620059 both still say
 *     Ubersuggest has no API. The MCP server shipped 2026-07-17.
 *   - The launch blog says 37 tools and calls the connection read-only. The
 *     manifest has 42, three of which write.
 *   - `llms.md` references an example host `mcp.ubersuggest.com`. That name does
 *     not resolve. The working host is below.
 *
 * The authoritative documentation is `${MCP_ORIGIN}/llms.md` — a machine-readable
 * doc with per-tool parameter AND response-field tables. Prefer it over the blog
 * for anything factual.
 */

const MCP_ORIGIN = 'https://ubersuggest-mcp.neilpatelapi.com';

/** The one MCP endpoint. POST only — GET is 405 by design (no SSE stream). */
const MCP_ENDPOINT = `${MCP_ORIGIN}/mcp`;

/** RFC 8414 discovery. Preferred over the fallbacks below; see oauth.js. */
const DISCOVERY_URL = `${MCP_ORIGIN}/.well-known/oauth-authorization-server`;

/**
 * Fallbacks, used only if discovery is unreachable. Verified 2026-08-25.
 * Discovery is still attempted first so a moved endpoint fixes itself.
 */
const FALLBACK_AUTHORIZATION_ENDPOINT = `${MCP_ORIGIN}/authorize`;
const FALLBACK_TOKEN_ENDPOINT = `${MCP_ORIGIN}/token`;

/**
 * A fixed, PUBLIC client id.
 *
 * The server exposes a `registration_endpoint`, but its dynamic registration is
 * a stub that hands back this same id with an empty secret. So there is nothing
 * to register: `token_endpoint_auth_methods_supported` is `["none"]`, which
 * means no client secret exists and PKCE is the only binding between the
 * redirect and the process that began it.
 */
const CLIENT_ID = 'ubersuggest-mcp';

/**
 * Ubersuggest's own login page, used as an explicit first hop. See the long
 * note on `buildAuthorizeUrl` in oauth.js for why this exists — in short, their
 * authorization server's own login handoff nests the entire authorize URL into
 * a `next=` parameter and re-encodes it on every bounce, so the URL grows
 * geometrically until CloudFront rejects it with a 414. Doing the handoff
 * ourselves keeps it to a single hop.
 *
 * Verified 2026-08-26: `GET /en/login?next=<encoded absolute url>` returns 200
 * and the login page, with no redirect of its own.
 */
const LOGIN_URL = 'https://app.neilpatel.com/en/login';

/**
 * Everything the server offers. We request the lot because the Add-ons tab
 * surfaces every section — positions, keywords, audit, domain, backlinks, brand
 * — and a narrower grant would mean a second consent the first time somebody
 * opens a section we did not anticipate.
 *
 * The server adds `profile` to whatever is requested, so the granted set will
 * differ from this list. Store what comes back, not what was asked for.
 */
const SCOPES = [
  'profile',
  'domain',
  'keywords',
  'serp',
  'backlinks',
  'site_audit',
  'content',
  'projects',
  'utility',
];

/**
 * Tool-result error text that means "quota gone", not "something broke".
 *
 * Ubersuggest reports an exhausted quota as an HTTP 200 carrying
 * `isError: true` — never a 429, with no Retry-After and no structured code. So
 * string-matching the body is the only detection available, and getting it
 * wrong means either retrying into a wall all day or treating a transient blip
 * as a hard stop.
 *
 * ---- Why a bare 403 is NOT in this list any more ---------------------------
 *
 * It used to be, and it cost this integration every reading it was supposed to
 * collect. Verified live on 2026-08-28 against a tier3 account with quota to
 * spare: `traffic_value` answers
 *
 *     Error: HTTP 403 /traffic_value: Request failed with status code 403
 *
 * on EVERY call. That is an endpoint the plan does not carry — a permanent
 * property of one tool, not a workspace that has run out of reports. Matching it
 * as quota set `quotaExhausted`, which is an ACCOUNT-LEVEL STOP: `syncAccount`
 * breaks out of the project loop the moment it sees one. So a single unavailable
 * secondary tool aborted the whole pass, and Traffic, Backlinks and every
 * project after the first silently collected nothing, week after week, while the
 * account reported "no quota left".
 *
 * A 403 is now classified `forbidden` — fatal for the one call, survivable for
 * everything else. Real exhaustion still says "limit reached"; the rate-limit
 * spellings are kept alongside it so a 429 is never mistaken for a blip.
 */
const QUOTA_ERROR_PATTERNS = [
  /limit reached/i,
  /quota/i,
  /\b429\b/,
  /too many requests/i,
];

/**
 * Tool-result error text that means "this account may not call this tool".
 *
 * Distinct from quota on purpose, and the distinction is the whole point: quota
 * stops the ACCOUNT for the run, this stops the CALL. Retrying either is
 * pointless, but only one of them should take the other four kinds down with it.
 */
const FORBIDDEN_ERROR_PATTERNS = [
  /\b403\b/,
  /forbidden/i,
  /not available on (your|this) plan/i,
];

/**
 * Tool-result error text the docs explicitly bless as retryable. Anything else
 * is treated as final — retrying an unknown failure costs quota to learn nothing.
 */
const RETRYABLE_ERROR_PATTERNS = [
  /still pending/i,
  /\b50[234]\b/,
  /timed out/i,
];

/** How long any single HTTP call may take before we give up on it. */
const HTTP_TIMEOUT_MS = 30_000;

module.exports = {
  MCP_ORIGIN,
  MCP_ENDPOINT,
  DISCOVERY_URL,
  FALLBACK_AUTHORIZATION_ENDPOINT,
  FALLBACK_TOKEN_ENDPOINT,
  CLIENT_ID,
  LOGIN_URL,
  SCOPES,
  QUOTA_ERROR_PATTERNS,
  FORBIDDEN_ERROR_PATTERNS,
  RETRYABLE_ERROR_PATTERNS,
  HTTP_TIMEOUT_MS,
};
