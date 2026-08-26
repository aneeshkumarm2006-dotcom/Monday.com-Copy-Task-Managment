const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createMcpClient,
  classifyToolError,
  extractToolResult,
  parseRpcBody,
} = require('./mcpClient');

/**
 * The MCP client's two jobs are auth and failure classification, and both are
 * things that can only be got wrong in production if they are not pinned here.
 *
 * The quota tests carry the most weight. Ubersuggest reports an exhausted quota
 * as an HTTP 200 with `isError: true` and a sentence — never a 429, no
 * Retry-After, no code. If `classifyToolError` drifts, the weekly runner either
 * hammers a wall all day (spending tomorrow's quota to do it) or treats a
 * transient 502 as final and silently skips a week of history.
 */

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

const jsonResponse = (payload, { status = 200 } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => 'application/json' },
  text: async () => JSON.stringify(payload),
});

const rawResponse = (body, { status = 200, contentType = 'application/json' } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => contentType },
  text: async () => body,
});

/** A tools/call result carrying a provider-side error. */
const toolError = (message) =>
  jsonResponse({
    jsonrpc: '2.0',
    id: 2,
    result: { isError: true, content: [{ type: 'text', text: message }] },
  });

/** A tools/call result carrying JSON. */
const toolOk = (payload) =>
  jsonResponse({
    jsonrpc: '2.0',
    id: 2,
    result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
  });

const initOk = () =>
  jsonResponse({
    jsonrpc: '2.0',
    id: 1,
    result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: {} },
  });

/**
 * A session whose refresh is observable. `tokens` is a counter so a test can
 * assert the SECOND request carried the NEW token, not just that refresh ran.
 */
const makeSession = ({ refreshFails = false } = {}) => {
  let token = 'token-1';
  const calls = { refresh: 0, markNeedsReauth: 0 };
  return {
    calls,
    getAccessToken: () => token,
    refresh: async () => {
      calls.refresh += 1;
      if (refreshFails) {
        const err = new Error('refresh token is dead');
        err.needsReauth = true;
        throw err;
      }
      token = 'token-2';
    },
    markNeedsReauth: async () => {
      calls.markNeedsReauth += 1;
    },
  };
};

/**
 * A fetch stub that plays a fixed script and records what it was sent.
 *
 * NOTIFICATIONS are answered 202-with-no-body and do NOT consume a scripted
 * response, exactly as the transport specifies — `notifications/initialized` is
 * fire-and-forget, so a script that had to leave a slot for it would make every
 * test's request indices depend on when an unawaited promise happened to run.
 * `sent` likewise records only requests that expect an answer.
 */
const scriptedFetch = (responses) => {
  const sent = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.id === undefined) {
      return { ok: true, status: 202, headers: { get: () => '' }, text: async () => '' };
    }
    sent.push({ url, init, body });
    const next = responses.shift();
    if (!next) throw new Error('scriptedFetch: ran out of responses');
    if (typeof next === 'function') return next();
    return next;
  };
  fn.sent = sent;
  return fn;
};

/** Every client under test skips the real backoff; the delay is not the point. */
const clientOpts = (fetchImpl) => ({ fetchImpl, retryDelaysMs: [0, 0] });

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

test('the provider quota message classifies as quota, not as a fault', () => {
  // The two forms llms.md documents for an exhausted plan.
  assert.equal(classifyToolError('Error: Ubersuggest 403 / limit reached'), 'quota');
  assert.equal(classifyToolError('Error: daily limit reached'), 'quota');
});

test('the blessed transient failures classify as retryable', () => {
  assert.equal(classifyToolError('Error: report still pending'), 'retryable');
  assert.equal(classifyToolError('Error: 503 Service Unavailable'), 'retryable');
  assert.equal(classifyToolError('Error: the request timed out'), 'retryable');
});

test('an unrecognised failure is fatal, not retried', () => {
  // Deliberate: retrying an unknown failure spends a shared quota to learn
  // nothing. A new retryable message is a change to RETRYABLE_ERROR_PATTERNS.
  assert.equal(classifyToolError('Error: project not found'), 'fatal');
  assert.equal(classifyToolError(''), 'fatal');
  assert.equal(classifyToolError(null), 'fatal');
});

test('quota wins over retryable when a message could read as both', () => {
  // Ordering inside classifyToolError, asserted so a reorder cannot pass.
  assert.equal(classifyToolError('Error: 403 limit reached; timed out'), 'quota');
});

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

test('a JSON body is read as a JSON-RPC message', () => {
  const msg = parseRpcBody('application/json', '{"jsonrpc":"2.0","id":1,"result":{"a":1}}');
  assert.deepEqual(msg.result, { a: 1 });
});

test('an SSE body yields the last frame that carries a result', () => {
  // Ubersuggest documents no SSE stream, but the transport permits one and a
  // client that only understands JSON would break totally the day it appears.
  const body = [
    'event: message',
    'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}',
    '',
    'event: message',
    'data: {"jsonrpc":"2.0","id":2,"result":{"content":[]}}',
    '',
  ].join('\n');
  const msg = parseRpcBody('text/event-stream', body);
  assert.deepEqual(msg.result, { content: [] });
});

test('an unreadable body throws rather than returning undefined', () => {
  assert.throws(() => parseRpcBody('application/json', '<html>502</html>'));
});

// ---------------------------------------------------------------------------
// Result extraction
// ---------------------------------------------------------------------------

test('structuredContent is preferred over the text block', () => {
  const { data } = extractToolResult({
    structuredContent: { projects: [{ id: '1' }] },
    content: [{ type: 'text', text: 'ignored' }],
  });
  assert.deepEqual(data, { projects: [{ id: '1' }] });
});

test('a JSON text block is parsed', () => {
  const { data } = extractToolResult({
    content: [{ type: 'text', text: '[{"id":"7"}]' }],
  });
  assert.deepEqual(data, [{ id: '7' }]);
});

test('a non-JSON text block comes back as a string, not an error', () => {
  // auth_status is documented as exactly this: "Not JSON: 'Logged in as
  // <email> / Tier: <tier>'". Throwing here would fail every mirror refresh.
  const { data } = extractToolResult({
    content: [{ type: 'text', text: 'Logged in as seo@davnoot.com / Tier: enterprise' }],
  });
  assert.equal(data, 'Logged in as seo@davnoot.com / Tier: enterprise');
});

test('an empty result is null rather than a throw', () => {
  assert.deepEqual(extractToolResult({}), { data: null, text: '' });
});

// ---------------------------------------------------------------------------
// callTool — auth
// ---------------------------------------------------------------------------

test('a 401 refreshes once and replays the call with the new token', async () => {
  const session = makeSession();
  const fetchImpl = scriptedFetch([
    initOk(),
    rawResponse('{"error":"invalid_token"}', { status: 401 }),
    toolOk({ projects: [] }),
  ]);

  const client = createMcpClient(session, clientOpts(fetchImpl));
  const { data } = await client.callTool('list_projects', {});

  assert.deepEqual(data, { projects: [] });
  assert.equal(session.calls.refresh, 1);

  // The replay must carry the REFRESHED token. Refreshing and then resending the
  // dead one would 401 forever while looking like it was doing something.
  const replay = fetchImpl.sent[2];
  assert.equal(replay.init.headers.Authorization, 'Bearer token-2');
});

test('a second 401 after refreshing asks for a reconnect instead of looping', async () => {
  const session = makeSession();
  const fetchImpl = scriptedFetch([
    initOk(),
    rawResponse('{}', { status: 401 }),
    rawResponse('{}', { status: 401 }),
  ]);

  const client = createMcpClient(session, clientOpts(fetchImpl));
  await assert.rejects(
    () => client.callTool('list_projects', {}),
    (err) => err.needsReauth === true
  );
  assert.equal(session.calls.refresh, 1);
});

test('a dead refresh grant surfaces as needsReauth', async () => {
  const session = makeSession({ refreshFails: true });
  const fetchImpl = scriptedFetch([initOk(), rawResponse('{}', { status: 401 })]);

  const client = createMcpClient(session, clientOpts(fetchImpl));
  await assert.rejects(
    () => client.callTool('list_projects', {}),
    (err) => err.needsReauth === true
  );
});

// ---------------------------------------------------------------------------
// callTool — quota and retries
// ---------------------------------------------------------------------------

test('an exhausted quota is a hard stop: flagged, and never retried', async () => {
  const session = makeSession();
  const fetchImpl = scriptedFetch([
    initOk(),
    toolError('Error: Ubersuggest 403 / limit reached'),
  ]);

  const client = createMcpClient(session, clientOpts(fetchImpl));
  await assert.rejects(
    () => client.callTool('list_projects', {}),
    (err) => err.quotaExhausted === true && err.tool === 'list_projects'
  );

  // initialize + one attempt. A retry here would spend the next quota window.
  assert.equal(fetchImpl.sent.length, 2);
});

test('a retryable tool error is retried and can succeed', async () => {
  const session = makeSession();
  const fetchImpl = scriptedFetch([
    initOk(),
    toolError('Error: timed out; report still pending'),
    toolOk({ projects: [{ id: '1' }] }),
  ]);

  const client = createMcpClient(session, clientOpts(fetchImpl));
  const { data } = await client.callTool('project_position_info', {});
  assert.deepEqual(data, { projects: [{ id: '1' }] });
});

test('retries are bounded, and the last failure is what surfaces', async () => {
  const session = makeSession();
  const fetchImpl = scriptedFetch([
    initOk(),
    toolError('Error: 503'),
    toolError('Error: 503'),
    toolError('Error: 503'),
  ]);

  const client = createMcpClient(session, clientOpts(fetchImpl));
  await assert.rejects(
    () => client.callTool('site_audit', {}),
    (err) => err.retryable === true && /503/.test(err.message)
  );
  // initialize + 1 attempt + 2 retries, and then it stops.
  assert.equal(fetchImpl.sent.length, 4);
});

test('a fatal tool error is not retried', async () => {
  const session = makeSession();
  const fetchImpl = scriptedFetch([initOk(), toolError('Error: project not found')]);

  const client = createMcpClient(session, clientOpts(fetchImpl));
  await assert.rejects(
    () => client.callTool('get_project', {}),
    (err) => err.quotaExhausted === false && err.retryable === false
  );
  assert.equal(fetchImpl.sent.length, 2);
});

test('an HTTP 5xx is retryable, an HTTP 4xx is not', async () => {
  const session = makeSession();
  const five = scriptedFetch([
    initOk(),
    rawResponse('boom', { status: 502 }),
    toolOk({ ok: true }),
  ]);
  const client5 = createMcpClient(session, clientOpts(five));
  assert.deepEqual((await client5.callTool('list_projects', {})).data, { ok: true });

  const four = scriptedFetch([initOk(), rawResponse('nope', { status: 404 })]);
  const client4 = createMcpClient(makeSession(), clientOpts(four));
  await assert.rejects(
    () => client4.callTool('list_projects', {}),
    (err) => err.retryable === false && err.status === 404
  );
});

// ---------------------------------------------------------------------------
// callTool — protocol
// ---------------------------------------------------------------------------

test('a failed handshake does not block the call it was for', async () => {
  // The server is documented stateless, so initialize establishes nothing and a
  // failure there must not take down a tools/call that would have worked.
  const session = makeSession();
  const fetchImpl = scriptedFetch([
    rawResponse('nope', { status: 400 }),
    toolOk({ projects: [] }),
  ]);

  const client = createMcpClient(session, clientOpts(fetchImpl));
  assert.deepEqual((await client.callTool('list_projects', {})).data, { projects: [] });
});

test('the handshake happens once, not per call', async () => {
  const session = makeSession();
  const fetchImpl = scriptedFetch([initOk(), toolOk({ a: 1 }), toolOk({ b: 2 })]);

  const client = createMcpClient(session, clientOpts(fetchImpl));
  await client.callTool('list_projects', {});
  await client.callTool('auth_status', {});

  const initCount = fetchImpl.sent.filter((s) => s.body.method === 'initialize').length;
  assert.equal(initCount, 1);
});

test('the tool name and arguments go out in the MCP envelope', async () => {
  const session = makeSession();
  const fetchImpl = scriptedFetch([initOk(), toolOk({})]);

  const client = createMcpClient(session, clientOpts(fetchImpl));
  await client.callTool('project_position_info', { project_id: '42' });

  const call = fetchImpl.sent[1].body;
  assert.equal(call.method, 'tools/call');
  assert.equal(call.params.name, 'project_position_info');
  assert.deepEqual(call.params.arguments, { project_id: '42' });
  // Both content types, per the Streamable HTTP binding — the server picks.
  assert.match(fetchImpl.sent[1].init.headers.Accept, /text\/event-stream/);
});
