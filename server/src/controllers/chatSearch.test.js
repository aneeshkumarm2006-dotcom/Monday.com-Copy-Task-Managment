const test = require('node:test');
const assert = require('node:assert');

/**
 * Search takes a string typed by a person and puts it in a regular expression.
 *
 * That is two bugs waiting to happen and both are worth pinning down without a
 * database: a search for `c++` must be a SEARCH rather than a crash, and a
 * search for `.*` must find messages containing ".*" rather than every message
 * in the workspace. The second one is the dangerous half — an unescaped
 * wildcard is a query the caller wrote, over rows they were scoped to but did
 * not ask for, and a pathological one is how you take the database down.
 *
 * MIRRORS the escape in `searchMessages` in chatController.js.
 */
const escapeRegex = (q) => q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const matches = (haystack, query) =>
  new RegExp(escapeRegex(query), 'i').test(haystack);

test('an ordinary word matches the way you would expect', () => {
  assert.equal(matches('Budget is pacing 12% over', 'budget'), true);
  assert.equal(matches('Budget is pacing 12% over', 'BUDGET'), true);
  assert.equal(matches('Budget is pacing', 'launch'), false);
});

test('a partial word matches — this is why it is a regex and not $text', () => {
  // A `$text` index only matches whole tokens, so "budg" would find nothing and
  // "budget" would not find "budgets". People type partial words into search
  // boxes, so the scan is the honest trade.
  assert.equal(matches('the budgets are set', 'budget'), true);
  assert.equal(matches('the budgets are set', 'budg'), true);
});

test('regex metacharacters are searched for, not interpreted', () => {
  // The bug: `.*` unescaped matches everything. A search for it must find the
  // messages that literally contain ".*" and nothing else.
  assert.equal(matches('use .* to match all', '.*'), true);
  assert.equal(matches('nothing special here', '.*'), false);

  assert.equal(matches('anything at all', '.'), false);
  assert.equal(matches('end of sentence.', '.'), true);
});

test('a search that would otherwise throw is just a search', () => {
  // Each of these is a SyntaxError as a bare pattern — an unhandled 500 on a
  // perfectly reasonable thing to type.
  for (const q of ['c++', 'a(b', 'x[y', '*', '?', '\\', 'a|b', '{2}']) {
    assert.doesNotThrow(() => new RegExp(escapeRegex(q), 'i'), `${q} should not throw`);
  }
  assert.equal(matches('we shipped it in c++', 'c++'), true);
  assert.equal(matches('func(a(b))', 'a(b'), true);
});

test('an anchor cannot escape the term', () => {
  // `^` unescaped would anchor the match and silently change what the caller
  // asked for.
  assert.equal(matches('hello world', '^hello'), false);
  assert.equal(matches('the ^hello marker', '^hello'), true);
});

test('a nested quantifier cannot be smuggled in', () => {
  // `(a+)+$` against a long non-matching string is catastrophic backtracking —
  // one request that pins a CPU. Escaped, it is a literal nobody has ever
  // written in a message.
  const evil = '(a+)+$';
  const long = 'a'.repeat(60) + '!';
  const started = Date.now();
  assert.equal(matches(long, evil), false);
  assert.ok(Date.now() - started < 100, 'escaped pattern must not backtrack');
});
