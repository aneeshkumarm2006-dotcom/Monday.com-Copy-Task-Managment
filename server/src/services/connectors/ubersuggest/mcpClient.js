const {
  MCP_ENDPOINT,
  HTTP_TIMEOUT_MS,
  QUOTA_ERROR_PATTERNS,
  RETRYABLE_ERROR_PATTERNS,
} = require('./constants');

/**
 * A minimal Streamable-HTTP MCP client for Ubersuggest.
 *
 * ---- Why this is hand-rolled and not @modelcontextprotocol/sdk -------------
 *
 * The SDK's job is transport negotiation, session resumption and an SSE reader.
 * This server has none of those: it is documented STATELESS, `GET /mcp` is 405
 * by design, there is no session id and no notification stream. What is left of
 * the protocol here is "POST a JSON-RPC envelope, read one JSON-RPC envelope
 * back" — which is the file below, and which does not justify a dependency the
 * deploy would have to install. `oauth.js` next door reaches for bare `fetch`
 * for the same reason.
 *
 * ---- The two failure modes that shape everything ---------------------------
 *
 * 1. AUTH. Every request needs a Bearer token, INCLUDING `initialize`, and an
 *    expired one comes back as an HTTP 401. The provider documents no
 *    access-token lifetime, so there is no proactive refresh to schedule — we
 *    refresh REACTIVELY, once, and retry the call. `session.refresh()` is what
 *    persists the new token; see services/connectors/session.js.
 *
 * 2. QUOTA. An exhausted quota is NOT a 429. It arrives as an HTTP 200 whose
 *    JSON-RPC result carries `isError: true` and a text body like
 *    "Error: ... 403 / limit reached". There is no Retry-After, no structured
 *    code, and no header to key off — string-matching the body is the only
 *    detection that exists. Getting it wrong in one direction retries into a
 *    wall all day and spends the next day's quota doing it; getting it wrong in
 *    the other treats a transient 502 as a hard stop and skips the week.
 *
 * That second one is why `classifyToolError` is a named, tested function rather
 * than an `if` buried in the request path.
 */

/**
 * The protocol revision we speak. Sent on `initialize` and echoed on every
 * subsequent request as `MCP-Protocol-Version`, per the Streamable HTTP binding.
 * The server's answer wins if it names a different one.
 */
const PROTOCOL_VERSION = '2025-06-18';

const CLIENT_INFO = { name: 'davnoot-connectors', version: '1.0.0' };

/** Backoff between retries of a RETRYABLE failure. Two retries, then give up. */
const RETRY_DELAYS_MS = [600, 2_000];

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * One error type, carrying the flags every caller actually branches on. A
 * caller that ignores them still gets a sentence it can log.
 */
class McpCallError extends Error {
  constructor(
    message,
    {
      quotaExhausted = false,
      retryable = false,
      needsReauth = false,
      status = null,
      tool = null,
    } = {}
  ) {
    super(message);
    this.name = 'McpCallError';
    this.quotaExhausted = quotaExhausted;
    this.retryable = retryable;
    this.needsReauth = needsReauth;
    this.status = status;
    this.tool = tool;
  }
}

/**
 * What a tool-level error message means.
 *
 * Order matters: quota is checked FIRST. The provider's quota message is
 * "Error: ... 403 / limit reached", and a 403 is not a thing to retry — but a
 * future message that paired it with a word like "timed out" would otherwise
 * fall into the retryable branch and be hammered.
 *
 * Anything unrecognised is FATAL by choice. Retrying an unknown failure spends
 * a quota shared by the whole workspace to learn nothing.
 *
 * @param {string} text - the tool result's text content
 * @returns {'quota'|'retryable'|'fatal'}
 */
const classifyToolError = (text) => {
  const s = String(text || '');
  if (QUOTA_ERROR_PATTERNS.some((re) => re.test(s))) return 'quota';
  if (RETRYABLE_ERROR_PATTERNS.some((re) => re.test(s))) return 'retryable';
  return 'fatal';
};

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

/**
 * Read one JSON-RPC message out of a response body.
 *
 * The Streamable HTTP binding lets a server answer a POST with EITHER
 * `application/json` or a `text/event-stream` frame sequence, and the choice is
 * the server's to make per request. Ubersuggest documents "no SSE stream" and
 * has only ever answered with JSON — but a client that handles only JSON breaks
 * silently and totally the day that changes, and the SSE branch is six lines.
 * So both.
 *
 * @param {string} contentType
 * @param {string} body
 * @returns {Object} the JSON-RPC message
 */
const parseRpcBody = (contentType, body) => {
  const isEventStream = /text\/event-stream/i.test(contentType || '');

  if (!isEventStream) {
    try {
      return JSON.parse(body);
    } catch {
      throw new McpCallError('Ubersuggest returned a response we could not read.');
    }
  }

  // SSE: take the LAST `data:` payload that carries a result or an error.
  // Earlier frames on the stream are progress notifications, which have no `id`
  // and are not the answer to anything.
  let found = null;
  for (const line of String(body).split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    try {
      const msg = JSON.parse(payload);
      if (msg && (msg.result !== undefined || msg.error !== undefined)) found = msg;
    } catch {
      // A partial frame. Ignore it rather than failing the whole call.
    }
  }
  if (!found) {
    throw new McpCallError('Ubersuggest sent an event stream with no result in it.');
  }
  return found;
};

/**
 * Flatten a tool result into something storable.
 *
 * Three shapes, in order of preference:
 *
 *   - `structuredContent` — present from protocol 2025-06-18 onward when a tool
 *     declares an output schema. Already an object; take it.
 *   - text content that parses as JSON — the Ubersuggest tools return "the raw
 *     Ubersuggest API payload", serialised into a text block.
 *   - text content that does NOT parse — `auth_status` is documented as exactly
 *     this ("Not JSON: 'Logged in as <email> / Tier: <tier>'"), so a parse
 *     failure here is a valid answer rather than a fault, and must not throw.
 *
 * @param {Object} result - the JSON-RPC `result` of a tools/call
 * @returns {{ data: any, text: string }}
 */
const extractToolResult = (result) => {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const text = blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');

  if (
    result &&
    result.structuredContent !== undefined &&
    result.structuredContent !== null
  ) {
    return { data: result.structuredContent, text };
  }

  if (text) {
    try {
      return { data: JSON.parse(text), text };
    } catch {
      return { data: text, text };
    }
  }

  return { data: null, text: '' };
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

/**
 * Bind an MCP client to one authenticated account.
 *
 * @param {Object} session - from services/connectors/session.js
 * @param {() => string} session.getAccessToken
 * @param {() => Promise<void>} session.refresh - refreshes AND persists
 * @param {Object} [opts]
 * @param {typeof fetch} [opts.fetchImpl] - injected by the tests
 * @param {number[]} [opts.retryDelaysMs] - injected by the tests, which assert
 *   that a retry HAPPENS and have no interest in waiting out the backoff
 * @returns {{ callTool: Function, initialize: Function }}
 */
const createMcpClient = (
  session,
  { fetchImpl = fetch, retryDelaysMs = RETRY_DELAYS_MS } = {}
) => {
  // Negotiated once per client. The server is stateless, so this establishes
  // nothing on its side — it settles the protocol revision and nothing else,
  // which is why a failure here is a warning rather than a thrown error.
  let protocolVersion = PROTOCOL_VERSION;
  let initialized = false;

  /**
   * One HTTP round trip. Refreshes and retries exactly once on a 401 — a second
   * 401 after a fresh token means the grant is dead rather than stale, and
   * looping on it is how a weekly runner hammers a revoked account forever.
   */
  const post = async (payload, { allowRefresh = true } = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

    let res;
    let body;
    try {
      res = await fetchImpl(MCP_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.getAccessToken()}`,
          'Content-Type': 'application/json',
          // Both, per the Streamable HTTP binding — the server picks.
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': protocolVersion,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      body = await res.text();
    } catch (err) {
      // A timeout, or a DNS/socket failure. Transient by nature, so the caller
      // may retry it — unlike a refusal, which is an answer.
      throw new McpCallError(`Could not reach Ubersuggest: ${err.message}`, {
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 401) {
      if (!allowRefresh) {
        throw new McpCallError(
          'Ubersuggest rejected this account. It needs to be reconnected.',
          { needsReauth: true, status: 401 }
        );
      }
      // Reactive refresh: the provider documents no token lifetime, so a 401 is
      // the only signal there is. `session.refresh()` persists the new token and
      // throws with `needsReauth` when the refresh grant itself is dead.
      await session.refresh();
      return post(payload, { allowRefresh: false });
    }

    if (res.status >= 500) {
      throw new McpCallError(`Ubersuggest is unavailable (HTTP ${res.status}).`, {
        retryable: true,
        status: res.status,
      });
    }

    if (!res.ok) {
      throw new McpCallError(
        `Ubersuggest refused the request (HTTP ${res.status}).`,
        { status: res.status }
      );
    }

    // A NOTIFICATION has no reply: the transport answers 202 with an empty body.
    // Reading that as a malformed response would make every `initialized` look
    // like a failure in the logs.
    if (res.status === 202 || res.status === 204 || !body) return null;

    const msg = parseRpcBody(res.headers?.get?.('content-type') || '', body);

    if (msg.error) {
      const detail = msg.error.message || `JSON-RPC error ${msg.error.code}`;
      const err = new McpCallError(`Ubersuggest returned an error: ${detail}`);
      err.rpcCode = msg.error.code;
      // Some stateless servers still insist on a handshake first. If that is
      // what this is, `callTool` re-initialises and tries once more.
      err.needsInitialize = /initializ/i.test(detail);
      throw err;
    }

    return msg.result;
  };

  /**
   * The MCP handshake. Best effort: this server is documented stateless, so
   * there is nothing for it to remember, and a failure here should not take
   * down a call that would otherwise have worked.
   */
  const initialize = async () => {
    try {
      const result = await post({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: CLIENT_INFO,
        },
      });
      if (result && typeof result.protocolVersion === 'string') {
        protocolVersion = result.protocolVersion;
      }
      initialized = true;
      // Fire and forget: a notification has no reply, and on a stateless server
      // it changes nothing. Sent because the spec says to send it.
      post({ jsonrpc: '2.0', method: 'notifications/initialized' }).catch(() => {});
    } catch (err) {
      // A dead grant must still surface — that is not a handshake problem.
      if (err.needsReauth) throw err;
      console.warn(
        `[connectors/ubersuggest] MCP initialize failed (${err.message}); continuing without it`
      );
      initialized = true;
    }
  };

  /**
   * Call one tool.
   *
   * @param {string} name
   * @param {Object} [args]
   * @param {Object} [opts]
   * @param {number} [opts.retries] - retries for RETRYABLE failures only
   * @returns {Promise<{ data: any, text: string }>}
   * @throws {McpCallError} carrying `.quotaExhausted`, `.retryable` or `.needsReauth`
   */
  const callTool = async (
    name,
    args = {},
    { retries = retryDelaysMs.length } = {}
  ) => {
    if (!initialized) await initialize();

    let attempt = 0;
    let reinitialised = false;

    for (;;) {
      let result;
      try {
        result = await post({
          jsonrpc: '2.0',
          // A fresh id per attempt. The server is stateless and answers one
          // message per request, so this is bookkeeping, not correlation.
          id: attempt + 2,
          method: 'tools/call',
          params: { name, arguments: args },
        });
      } catch (err) {
        if (err.needsInitialize && !reinitialised) {
          reinitialised = true;
          initialized = false;
          await initialize();
          continue;
        }
        if (err.retryable && attempt < retries) {
          await sleep(retryDelaysMs[attempt]);
          attempt += 1;
          continue;
        }
        err.tool = name;
        throw err;
      }

      // HTTP 200, a well-formed envelope — and possibly still a failure. This
      // is the quota path, and the only one there is.
      if (result && result.isError) {
        const { text } = extractToolResult(result);
        const kind = classifyToolError(text);

        if (kind === 'quota') {
          throw new McpCallError(
            'Ubersuggest has no quota left on this account. Report limits reset daily and credits monthly.',
            { quotaExhausted: true, tool: name }
          );
        }
        if (kind === 'retryable' && attempt < retries) {
          await sleep(retryDelaysMs[attempt]);
          attempt += 1;
          continue;
        }
        throw new McpCallError(
          // The provider's own sentence, trimmed. It is the only account of what
          // went wrong that exists. It is provider-controlled text, so callers
          // render it as text and never as markup.
          text
            ? `Ubersuggest: ${text.slice(0, 300)}`
            : `Ubersuggest could not run "${name}".`,
          { retryable: kind === 'retryable', tool: name }
        );
      }

      return extractToolResult(result);
    }
  };

  return { callTool, initialize };
};

module.exports = {
  createMcpClient,
  classifyToolError,
  extractToolResult,
  parseRpcBody,
  McpCallError,
  PROTOCOL_VERSION,
};
