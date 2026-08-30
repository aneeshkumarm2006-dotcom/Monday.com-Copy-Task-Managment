const DfsSerpResult = require('../../../models/DfsSerpResult');
const C = require('./constants');

/**
 * Storing the SERP bodies — the half that is too big for a snapshot.
 *
 * ---- The trap, stated as arithmetic ----------------------------------------
 *
 * One organic item is ~1-2 KB. `depth: 100` is ~100-200 KB per keyword. Two
 * hundred keywords is 20-40 MB — OVER MONGO'S 16 MB DOCUMENT CEILING BY 2x.
 *
 * And the failure is not "the write fails". The write fails AFTER DataForSEO has
 * been paid and AFTER `task_get` has consumed the result, so the sequence is:
 * money out, batch closed, driver throws, reading gone. There is no retry that
 * recovers it, because the money was spent at post time and the collection has
 * already happened.
 *
 * Three defences, in order, and each closes a different door:
 *
 *   1. THE SNAPSHOT NEVER CARRIES ITEMS. `ConnectorSnapshot.data` is the
 *      aggregate — ~80 bytes a keyword, 16 KB for two hundred — and `raw` stays
 *      null, exactly as `ConnectorSnapshot.js` already prescribes for the batched
 *      kinds. That alone takes the 40 MB document off the table.
 *   2. ONE DOCUMENT PER KEYWORD. The ceiling becomes per keyword rather than per
 *      batch, so two hundred keywords is two hundred small documents.
 *   3. THE SIZE IS MEASURED BEFORE THE WRITE. Trimming to render depth makes a
 *      4 MB body arithmetically impossible, and the measurement runs anyway —
 *      because "impossible" is what everybody said about the 16 MB one.
 *
 * ---- Best effort, deliberately ---------------------------------------------
 *
 * Every function here swallows its failures and reports them. The rank is on the
 * snapshot and the snapshot is written by the caller AFTER this runs; a storage
 * failure here must lose the evidence and never the measurement. That asymmetry
 * is the whole reason the two live in different collections.
 */

/**
 * Keep the results a page would draw, and no more.
 *
 * ---- Why the cut is by ORGANIC COUNT and not by array length ----------------
 *
 * The advanced payload interleaves organic results with a dozen other block
 * types — `people_also_ask`, `related_searches`, `ai_overview`, `local_pack`.
 * Slicing the first twenty entries would keep a different number of actual
 * results on every SERP, so a table asking for twenty rows would sometimes get
 * eleven. The walk counts organic items and stops after the twentieth, keeping
 * whatever non-organic blocks sat between them — which is what makes the stored
 * body a picture of the page rather than a list of links.
 *
 * ---- And why we keep 20 of the 100 we paid for ------------------------------
 *
 * Buying a hundred is defensible: `rank_absolute` is only accurate to the depth
 * you bought, and the competitor census, the SERP-feature census and
 * cannibalization detection all fall out of the deep crawl for free — they are
 * computed into the AGGREGATE at collection time and cost nothing to keep.
 * Storing a hundred bodies when the UI draws twenty is not defensible; it is
 * five times the storage for a view nobody opens.
 *
 * @param {Array<Object>} items
 * @param {number} renderDepth
 * @returns {{items: Array<Object>, storedCount: number, returnedCount: number,
 *   truncated: boolean}}
 */
const trimItems = (items, renderDepth = C.SERP_RENDER_DEPTH) => {
  const all = Array.isArray(items) ? items : [];
  const kept = [];
  let organic = 0;

  for (const item of all) {
    if (item && item.type === 'organic') {
      if (organic >= renderDepth) break;
      organic += 1;
    }
    kept.push(item);
  }

  // A tail of non-organic blocks after the last kept organic result is page
  // furniture, not evidence. Dropped so `truncated` means "results were cut"
  // rather than "a related-searches box was cut".
  while (kept.length && kept[kept.length - 1]?.type !== 'organic') kept.pop();

  return {
    items: kept,
    storedCount: kept.length,
    returnedCount: all.length,
    truncated: kept.length < all.length,
  };
};

/**
 * How big this body will be on the wire, in bytes.
 *
 * `Buffer.byteLength` over the serialised array rather than `JSON.stringify().length`,
 * because the ceiling is bytes and `.length` is UTF-16 code units — a SERP full
 * of CJK or emoji is up to three times bigger than its string length suggests,
 * and that is exactly the payload nobody tests with.
 */
const measureBytes = (items) => {
  try {
    return Buffer.byteLength(JSON.stringify(items ?? []), 'utf8');
  } catch {
    // A payload that will not serialise cannot be stored, and reporting it as
    // infinitely large is the reading that makes the caller do the right thing.
    return Number.POSITIVE_INFINITY;
  }
};

/**
 * Fit a body under the ceiling, saying honestly what it cost to get there.
 *
 * Halving rather than dropping one at a time: the loop has to terminate in a
 * bounded number of steps against a payload we did not predict, and log2(20) is
 * five. If even a single item will not fit, the body is stored EMPTY with
 * `oversized: true` — a row that says "there was a reading here and it would not
 * fit" is worth more than no row, and infinitely more than a failed write that
 * loses the measurement too.
 *
 * @returns {{items: Array<Object>, bytes: number, storedCount: number,
 *   truncated: boolean, oversized: boolean}}
 */
const fitToCeiling = (trimmed, { maxBytes = C.MAX_SERP_DOC_BYTES } = {}) => {
  let items = trimmed.items;
  let bytes = measureBytes(items);
  let { truncated } = trimmed;

  while (bytes > maxBytes && items.length > 1) {
    items = items.slice(0, Math.floor(items.length / 2));
    bytes = measureBytes(items);
    truncated = true;
  }

  if (bytes > maxBytes) {
    return { items: [], bytes: 0, storedCount: 0, truncated: true, oversized: true };
  }

  return {
    items,
    bytes,
    storedCount: items.length,
    truncated: truncated || items.length < trimmed.returnedCount,
    oversized: false,
  };
};

/** 90 days out, or null for a body somebody has pinned. */
const expiryFor = (now, { pinned = false, retentionDays = C.SERP_RETENTION_DAYS } = {}) =>
  pinned ? null : new Date(now.getTime() + retentionDays * 86_400_000);

/**
 * Store one collection's SERP bodies, one document per keyword.
 *
 * ---- Why the write is an upsert on the measurement, not on the task ---------
 *
 * The unique key is `(project, kind, variant, periodKey, keyword)` — the
 * MEASUREMENT — rather than `(task, keyword)`. Two attempts of the same job are
 * two tasks and one measurement, and phase 4's `tasks_ready` is a destructive
 * read whose repair path is to `task_get` ids that may already have been
 * collected. Results live thirty days, so the same body can legitimately arrive
 * twice. Keyed on the measurement, the second delivery rewrites one row; keyed
 * on the task, it doubles the collection.
 *
 * @param {Object} args
 * @param {Array<Object>} args.bodies - `{keyword, items, itemTypes, collectedAt}`,
 *   already trimmed by `pollJob`
 * @returns {Promise<{written: number, skipped: number, oversized: number,
 *   maxBytes: number}>}
 */
const storeSerpBodies = async ({
  project,
  job,
  kind,
  variant,
  periodKey,
  bodies,
  now = new Date(),
  maxBytes = C.MAX_SERP_DOC_BYTES,
  renderDepth = C.SERP_RENDER_DEPTH,
}) => {
  const summary = { written: 0, skipped: 0, oversized: 0, maxBytes: 0 };

  if (!periodKey || !Array.isArray(bodies) || !bodies.length) return summary;

  for (const body of bodies) {
    if (!body?.keyword) {
      summary.skipped += 1;
      continue;
    }

    /**
     * `pollJob` trims on the way in, so this is normally a no-op — and it runs
     * anyway, because this function is the one place that has to be true on its
     * own. A caller that hands over an untrimmed body must not be able to write
     * a 200 KB document by forgetting.
     */
    const trimmed =
      body.trimmed && Array.isArray(body.items)
        ? {
            items: body.items,
            storedCount: body.items.length,
            returnedCount: body.returnedCount ?? body.items.length,
            truncated: !!body.truncated,
          }
        : trimItems(body.items, renderDepth);

    const fitted = fitToCeiling(trimmed, { maxBytes });
    summary.maxBytes = Math.max(summary.maxBytes, fitted.bytes);
    if (fitted.oversized) summary.oversized += 1;

    try {
      // eslint-disable-next-line no-await-in-loop
      await DfsSerpResult.updateOne(
        {
          project: project._id,
          kind: kind.key,
          variant,
          periodKey,
          keyword: body.keyword,
        },
        {
          $set: {
            organisation: project.organisation,
            account: project.account || null,
            project: project._id,
            task: job?._id || null,
            provider: 'dataforseo',
            kind: kind.key,
            variant,
            periodKey,
            keyword: body.keyword,
            collectedAt: body.collectedAt || null,
            purchasedDepth: kind.depth ?? null,
            renderDepth,
            returnedCount: trimmed.returnedCount,
            storedCount: fitted.storedCount,
            truncated: fitted.truncated,
            items: fitted.items,
            itemTypes: Array.isArray(body.itemTypes) ? body.itemTypes : [],
            bytes: fitted.bytes,
            oversized: fitted.oversized,
            expiresAt: expiryFor(now),
          },
        },
        { upsert: true }
      );
      summary.written += 1;
    } catch (err) {
      if (err?.code === 11000) {
        // A concurrent collector wrote the same measurement. The row that exists
        // is the same body under the same key.
        summary.skipped += 1;
        continue;
      }
      /**
       * Logged and swallowed. The rank is on the snapshot the caller is about to
       * write, and losing the evidence must never take the measurement with it.
       */
      summary.skipped += 1;
      console.warn(
        `[connectors/dataforseo] could not store the SERP body for "${body.keyword}": ${err.message}`
      );
    }
  }

  return summary;
};

module.exports = {
  trimItems,
  measureBytes,
  fitToCeiling,
  expiryFor,
  storeSerpBodies,
};
