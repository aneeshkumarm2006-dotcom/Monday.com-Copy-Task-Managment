const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.CONNECTOR_MASTER_KEY_V1 = crypto.randomBytes(32).toString('base64');

const { closureForDeletedSite } = require('./connectorController');

/**
 * What a Site delete does to work that is still in flight.
 *
 * Deleting a `ConnectorProject` used to leave every `DfsTask` that named it
 * `state: 'open'` forever - no TTL, no sweeper that can reach it once the
 * project is gone, and invisible to the Usage screen, which reads only the
 * board's live projects. `closureForDeletedSite` is the decision that fixes it,
 * and these tests pin the two halves of that decision: that the row is CLOSED
 * rather than deleted, and that the terminal state it is closed into is chosen
 * by `postedAt` - the fact of the charge - rather than written the same way for
 * every row.
 *
 * Pure, so the whole surface is a plain object in and a plain object out.
 */

// ---------------------------------------------------------------------------
// A posted row: money already left the meter
// ---------------------------------------------------------------------------

test('a posted job is closed as dead, not failed', () => {
  // `failed` means the post itself was refused and nothing is in flight, which
  // would bury a real charge. `dead` is the terminal "no further post" verdict
  // on work that was genuinely bought.
  const closure = closureForDeletedSite({ postedAt: new Date('2026-09-19T10:00:00Z') });
  assert.equal(closure.state, 'dead');
});

test('a posted job says the result was paid for and will not be collected', () => {
  const closure = closureForDeletedSite({ postedAt: new Date('2026-09-19T10:00:00Z') });
  assert.match(closure.note, /site was deleted/i);
  assert.match(closure.note, /charged for/i);
});

// ---------------------------------------------------------------------------
// An unposted claim: the row exists, the purchase never happened
// ---------------------------------------------------------------------------

test('an unposted claim is closed as failed', () => {
  // Same word the reservation reconciler writes for a claim that expired before
  // its post completed, and for the same reason: nothing is in flight.
  const closure = closureForDeletedSite({ postedAt: null });
  assert.equal(closure.state, 'failed');
});

test('an unposted claim says nothing was bought', () => {
  const closure = closureForDeletedSite({ postedAt: null });
  assert.match(closure.note, /Nothing was bought/i);
});

test('a row with no postedAt field at all is treated as unposted', () => {
  // A legacy row predating the reservation phase carries no post time. Reading
  // the absence as "posted" would report a charge that never happened.
  assert.equal(closureForDeletedSite({}).state, 'failed');
});

// ---------------------------------------------------------------------------
// The shape itself
// ---------------------------------------------------------------------------

test('every closure is a real terminal state with a note a person can read', () => {
  for (const job of [{ postedAt: new Date() }, { postedAt: null }]) {
    const closure = closureForDeletedSite(job);
    // `abandoned` is deliberately not among these: it means a repost is allowed,
    // and there is no site left to repost for.
    assert.ok(['dead', 'failed'].includes(closure.state));
    assert.ok(closure.note.length > 0);
  }
});

test('the closure never touches budgetState', () => {
  // The ten-minute reconciler sweeps on `budgetState` alone and owns releasing a
  // reservation. A second copy of that decision here would race it.
  for (const job of [{ postedAt: new Date() }, { postedAt: null }]) {
    assert.deepEqual(Object.keys(closureForDeletedSite(job)).sort(), ['note', 'state']);
  }
});

test('the two closures are distinguishable — one value for both would lose the charge', () => {
  const posted = closureForDeletedSite({ postedAt: new Date() });
  const unposted = closureForDeletedSite({ postedAt: null });
  assert.notEqual(posted.state, unposted.state);
  assert.notEqual(posted.note, unposted.note);
});
