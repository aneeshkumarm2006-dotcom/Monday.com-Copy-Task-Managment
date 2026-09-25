const { test } = require('node:test');
const assert = require('node:assert');

const { shouldContinueSavedScan } = require('./chatController');

/**
 * The saved list's paging decision.
 *
 * `GET /api/chat/saved` used to apply `.limit(100)` to the raw SavedMessage
 * query and only then drop the rows whose channel the caller may no longer
 * read, or whose message has since been deleted. That made every unreadable
 * bookmark cost a slot in the page: a person whose hundred newest bookmarks
 * all sat in a deleted board opened Saved to an empty list, with older, valid
 * bookmarks stranded just past the cap.
 *
 * The handler now pages and caps what survives the filter. This function is
 * the decision that makes that terminate, and these tests pin its three exits:
 * a full page, an exhausted collection, and the scan ceiling that bounds a
 * bookmark list which is mostly unreadable.
 *
 * Pure — it takes counts and returns a boolean.
 */

const PAGE = 300;
const LIMIT = 100;
const MAX = 1500;

// ---------------------------------------------------------------------------
// The ordinary exit: we have a full page of renderable rows.
// ---------------------------------------------------------------------------

test('stops once the page is full', () => {
  assert.strictEqual(
    shouldContinueSavedScan({ kept: LIMIT, scanned: PAGE, lastPageSize: PAGE }),
    false
  );
});

test('stops when more than a full page was collected', () => {
  // The caller breaks out of its inner loop at the limit, but a defensive
  // `>=` here means an overshoot can never ask for another page.
  assert.strictEqual(
    shouldContinueSavedScan({ kept: LIMIT + 5, scanned: PAGE, lastPageSize: PAGE }),
    false
  );
});

test('keeps going while the page is short and rows remain', () => {
  // 300 rows read, only 40 of them renderable: exactly the case the old code
  // got wrong by returning 40 rows and calling it a full list.
  assert.strictEqual(
    shouldContinueSavedScan({ kept: 40, scanned: PAGE, lastPageSize: PAGE }),
    true
  );
});

test('keeps going when the filter dropped everything', () => {
  assert.strictEqual(
    shouldContinueSavedScan({ kept: 0, scanned: PAGE, lastPageSize: PAGE }),
    true
  );
});

// ---------------------------------------------------------------------------
// The exhausted-collection exit: a short page means there is nothing after it.
// ---------------------------------------------------------------------------

test('stops on a short page even with an unfilled list', () => {
  assert.strictEqual(
    shouldContinueSavedScan({ kept: 12, scanned: 120, lastPageSize: 120 }),
    false
  );
});

test('stops on an empty page', () => {
  // The handler breaks before asking in this case, but a zero-length page must
  // never be read as "maybe there is more".
  assert.strictEqual(
    shouldContinueSavedScan({ kept: 0, scanned: PAGE, lastPageSize: 0 }),
    false
  );
});

// ---------------------------------------------------------------------------
// The ceiling: a bookmark list that is mostly unreadable must still terminate.
// ---------------------------------------------------------------------------

test('stops at the scan ceiling rather than walking the whole collection', () => {
  assert.strictEqual(
    shouldContinueSavedScan({ kept: 3, scanned: MAX, lastPageSize: PAGE }),
    false
  );
});

test('stops once the ceiling is passed', () => {
  assert.strictEqual(
    shouldContinueSavedScan({ kept: 3, scanned: MAX + PAGE, lastPageSize: PAGE }),
    false
  );
});

test('does not stop one page short of the ceiling', () => {
  assert.strictEqual(
    shouldContinueSavedScan({ kept: 3, scanned: MAX - PAGE, lastPageSize: PAGE }),
    true
  );
});

// ---------------------------------------------------------------------------
// Precedence: a full page wins over every other signal.
// ---------------------------------------------------------------------------

test('a full page stops the scan even below the ceiling', () => {
  assert.strictEqual(
    shouldContinueSavedScan({ kept: LIMIT, scanned: PAGE, lastPageSize: PAGE }),
    false
  );
});

// ---------------------------------------------------------------------------
// The thresholds are parameters, so a caller with a different page size gets
// the same reasoning rather than a second copy of it.
// ---------------------------------------------------------------------------

test('honours caller-supplied thresholds', () => {
  assert.strictEqual(
    shouldContinueSavedScan({
      kept: 4,
      scanned: 10,
      lastPageSize: 10,
      pageSize: 10,
      limit: 5,
      maxScan: 50,
    }),
    true
  );
  assert.strictEqual(
    shouldContinueSavedScan({
      kept: 5,
      scanned: 10,
      lastPageSize: 10,
      pageSize: 10,
      limit: 5,
      maxScan: 50,
    }),
    false
  );
});
