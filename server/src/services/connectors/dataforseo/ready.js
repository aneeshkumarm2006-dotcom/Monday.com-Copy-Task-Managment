const DfsTask = require('../../../models/DfsTask');
const C = require('./constants');

/**
 * `tasks_ready` — one free call per account that replaces N `task_get`s.
 *
 * ---- What this buys ---------------------------------------------------------
 *
 * A 200-keyword Site polled every ten minutes is 1,200 `task_get` calls an hour
 * against a queue that answers in five minutes. `tasks_ready` answers "which of
 * your tasks are finished" in ONE call for the whole account, so the polling
 * loop becomes: ask once, then fetch only what was named. That is what makes a
 * ten-minute collection cron affordable, and the ten-minute cron is what takes
 * median latency from ~30 minutes to ~5.
 *
 * ---- THE ORDERING, WHICH IS THE WHOLE PHASE ---------------------------------
 *
 * `tasks_ready` IS A DESTRUCTIVE READ. An id appears on it exactly once and is
 * then dropped — there is no acknowledgement, no cursor, and no way to ask
 * again. So the only safe sequence is:
 *
 *   1. read `tasks_ready`;
 *   2. PERSIST `readyAt` onto the matching `DfsTask` items IN ONE `bulkWrite`,
 *      INCLUDING ids that match nothing;
 *   3. and only then `task_get`.
 *
 * An id read in step 1 and lost to a crash before step 2 is gone from the ready
 * list forever. Not "delayed" — gone. The result itself survives for thirty days,
 * so the loss is recoverable, but only by a mechanism that does not depend on the
 * announcement: see `READY_GRACE_HOURS` and `isPollable` below. Everything in
 * this file is arranged so that the durable write happens before the first byte
 * of collection.
 *
 * "Including ids that match nothing" is not a detail either. Filtering the list
 * down to ids we recognise means READING FIRST, and a read that fails, races, or
 * simply lags a concurrent post drops ids that were successfully announced. The
 * bulkWrite carries one operation per announced id and lets Mongo decide what
 * matched; the count that did not match is a REPORT, taken afterwards, and never
 * a filter taken before.
 *
 * ---- Why the job's `state` is not moved to `'ready'` ------------------------
 *
 * `DfsTask.state` has a `'ready'` value and this file deliberately never writes
 * it. THE PARTIAL UNIQUE INDEX COVERS `state: 'open'` AND NOTHING ELSE, so a job
 * moved to `'ready'` leaves the anti-repost gate: the next `fetch` finds no open
 * job, falls through to branch 3, and buys the whole batch again — for a job
 * whose results are sitting free on the other end. The announcement is recorded
 * on the ITEM (`items[].readyAt`) precisely so the row can carry it without
 * leaving the state the gate protects. Same reason `state: 'reserving'` is
 * unreachable.
 */

const READY_GRACE_MS = C.READY_GRACE_HOURS * 3_600_000;

/**
 * The ids `tasks_ready` just announced.
 *
 * The envelope is the usual one — `tasks[]`, each with a `result[]` — and the
 * ROWS are what carry the task ids. Defensive about every level of it: a shape
 * we did not expect must degrade to "nothing was announced", which costs a grace
 * window, rather than throw, which would take the whole collection pass with it.
 *
 * @param {Object} answer - a `client.call` result
 * @returns {Array<{id: string, tag: string|null, endpoint: string|null}>}
 */
const readReadyRows = (answer) => {
  const out = [];
  const seen = new Set();

  for (const task of Array.isArray(answer?.tasks) ? answer.tasks : []) {
    const rows = Array.isArray(task?.result) ? task.result : [];
    for (const row of rows) {
      const id = typeof row?.id === 'string' ? row.id.trim() : '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        tag: typeof row?.tag === 'string' ? row.tag : null,
        endpoint: typeof row?.endpoint === 'string' ? row.endpoint : null,
      });
      if (out.length >= C.MAX_READY_IDS) return out;
    }
  }

  return out;
};

/**
 * Write the announcement down. ONE `bulkWrite`, before anything is collected.
 *
 * ---- Why `readyAt` lands on the item and not on the row ---------------------
 *
 * A job is up to 200 provider tasks and they finish at different times, so
 * "this job is ready" is not a fact that exists — "this task is ready" is. The
 * row-level `readyAt` is written once, by `closeJob`, from the provider's own
 * result datetime; overwriting it here would replace a measurement with an
 * observation.
 *
 * The value stored is OUR clock, not `date_posted` from the announcement. That
 * field is when the task was POSTED, which we already know, and the announcement
 * carries no completion time at all. What this timestamp means is "the moment we
 * learned there was something to collect", which is exactly what the poll gate
 * needs and is not a claim about when the SERP was crawled — that stays the
 * provider's `datetime`, parsed in `pollJob`.
 *
 * The array filter also carries `readyAt: null`, so a re-announced id keeps its
 * FIRST timestamp. Results live thirty days and the same id can legitimately be
 * seen twice across a repair; the earliest sighting is the true one.
 *
 * @param {Object} args
 * @param {Array<{id: string}>} args.rows
 * @param {Date} args.now
 * @returns {Promise<{announced: number, matched: number, unmatched: number}>}
 */
const persistReady = async ({ rows, now }) => {
  const ids = (Array.isArray(rows) ? rows : []).map((r) => r.id).filter(Boolean);
  if (!ids.length) return { announced: 0, matched: 0, unmatched: 0 };

  /**
   * One operation per ANNOUNCED id — never per RECOGNISED id.
   *
   * There is no read in front of this. Two shapes of row can own an id: a batch
   * job carries them on `items[]`, and a single-task kind (phases 6-8) carries
   * one on the row itself. `$or` covers both in one operation, and the array
   * filter is a no-op on a row that has no items.
   */
  const ops = ids.map((id) => ({
    updateOne: {
      filter: { $or: [{ 'items.externalId': id }, { externalId: id }] },
      update: { $set: { 'items.$[it].readyAt': now } },
      arrayFilters: [{ 'it.externalId': id, 'it.readyAt': null }],
    },
  }));

  // `ordered: false` so one id that cannot be written does not abandon the rest
  // of the announcement — every id in this list is perishable.
  const res = await DfsTask.bulkWrite(ops, { ordered: false });

  const matched = Number(res?.matchedCount ?? res?.result?.nMatched ?? 0);
  const unmatched = Math.max(0, ids.length - matched);

  if (unmatched) {
    /**
     * An announced id we hold no row for. Worth a line, and never worth
     * throwing over.
     *
     * The account is shared across every workspace, so this is not "another
     * tenant's task" — every task on it is ours. It means a post whose response
     * we failed to persist, or a row deleted by an org cascade while its task
     * was still in flight. Either way the money is already spent and the only
     * useful thing to do about it is say so.
     */
    console.warn(
      `[connectors/dataforseo] tasks_ready announced ${unmatched} id(s) matching no ` +
        'open job — a post whose ids were never recorded, or a cascaded workspace.'
    );
  }

  return { announced: ids.length, matched, unmatched };
};

/**
 * One account's ready set, read and made durable.
 *
 * Memoised by the CALLER through `client.runOnce('tasks-ready', …)`, which is
 * the same seam the reservation reconciler uses and which is already scoped to
 * exactly what we want: one account, one pass. Memoising it here would need
 * this module to hold state keyed by account, which is the thing the client
 * already is.
 *
 * Returns null — never throws — when the read itself failed. Null is meaningful:
 * `isPollable` reads it as "no announcement channel this pass" and falls back to
 * polling everything, which is precisely phase 3's behaviour. A `tasks_ready`
 * outage must cost calls, never data.
 *
 * @returns {Promise<{ids: Set<string>, announced: number, matched: number,
 *   unmatched: number}|null>}
 */
const sweepReady = async ({ client, now = new Date() }) => {
  let answer;
  try {
    answer = await client.call(C.ENDPOINT_SERP_TASKS_READY, null, { method: 'GET' });
  } catch (err) {
    // The two account-level stops still have to travel: a spent balance or a
    // dead credential is not something to shrug at and poll around.
    if (err?.quotaExhausted || err?.needsReauth) throw err;
    console.warn(`[connectors/dataforseo] tasks_ready failed: ${err.message}`);
    return null;
  }

  const rows = readReadyRows(answer);

  // THE DURABLE WRITE, BEFORE ANY COLLECTION. If this throws, the ids are lost
  // from the list — so it is allowed to throw, loudly, rather than be swallowed
  // into a pass that then reads them and drops them.
  const persisted = await persistReady({ rows, now });

  return { ids: new Set(rows.map((r) => r.id)), ...persisted };
};

/** Warned about once per process, not once per account per pass. */
let warnedAboutErrorsEndpoint = false;

/**
 * The other half of the repair pair: ids DataForSEO failed on.
 *
 * ---- Why a success feed alone is not enough --------------------------------
 *
 * `tasks_ready` lists finished tasks. A task that ERRORED inside DataForSEO
 * never appears there, so a gate built only on the ready set holds its
 * `task_get` until the grace window expires — two hours to find out about a
 * failure the provider already knew about. `{api}/errors` is free and names
 * those ids, so sweeping it beside `tasks_ready` closes the failure path to the
 * same ten minutes as the success path.
 *
 * It is used ONLY to mark the id pollable. The verdict still comes from
 * `task_get`, which returns the real status code — this feed decides WHEN to
 * ask, never WHAT the answer was. That keeps one source of truth for a task's
 * outcome and makes a wrong guess here cost a free call.
 *
 * ---- The uncertainty, carried rather than laundered -------------------------
 *
 * DataForSEO's own documentation of this response is thin and inconsistent
 * across API families: some rows carry `id`, some only an `http_url` with the id
 * in the path. Both are read, neither is required, and a shape that yields
 * nothing yields nothing — the grace window is still underneath. The endpoint
 * may also simply not be enabled for an account, which is warned about once per
 * process rather than once per account per pass.
 *
 * @returns {Promise<{applied: number, ids: Set<string>}>}
 */
const sweepErrors = async ({ client, now = new Date() }) => {
  const empty = { applied: 0, ids: new Set() };

  let answer;
  try {
    answer = await client.call(C.ENDPOINT_SERP_ERRORS, [
      { limit: C.MAX_READY_IDS, offset: 0 },
    ]);
  } catch (err) {
    if (err?.quotaExhausted || err?.needsReauth) throw err;
    if (!warnedAboutErrorsEndpoint) {
      warnedAboutErrorsEndpoint = true;
      console.warn(
        `[connectors/dataforseo] ${C.ENDPOINT_SERP_ERRORS} is unavailable ` +
          `(${err.message}); failed tasks will surface on the ${C.READY_GRACE_HOURS}h ` +
          'grace poll instead.'
      );
    }
    return empty;
  }

  const ids = new Set();
  for (const task of Array.isArray(answer?.tasks) ? answer.tasks : []) {
    for (const row of Array.isArray(task?.result) ? task.result : []) {
      const direct = typeof row?.id === 'string' ? row.id.trim() : '';
      if (direct) {
        ids.add(direct);
        continue;
      }
      // `.../task_get/advanced/07281045-1535-0066-0000-…` — the id is the last
      // segment, and a UUID-shaped one is the only thing worth reading out of a
      // URL we did not build.
      const url = typeof row?.http_url === 'string' ? row.http_url : '';
      const tail = url.split('?')[0].split('/').filter(Boolean).pop() || '';
      if (/^[0-9a-f-]{20,}$/i.test(tail)) ids.add(tail);
    }
  }

  if (!ids.size) return empty;

  const persisted = await persistReady({ rows: [...ids].map((id) => ({ id })), now });
  return { applied: persisted.matched, ids };
};

/**
 * May this item be asked about yet?
 *
 * The four ways an item earns a `task_get`, and none of them is "the provider
 * told us in this exact pass":
 *
 *   NO ANNOUNCEMENT CHANNEL (`readySet` null) — the read failed. Poll
 *     everything; this is phase 3's behaviour and it is always correct, just
 *     expensive.
 *   ALREADY PERSISTED (`item.readyAt`) — announced in THIS pass or an earlier
 *     one. This is the clause that makes the destructive read survivable: the
 *     announcement was consumed once and written down once, and every later
 *     pass reads it off the row.
 *   ANNOUNCED IN THIS PASS — belt to the persisted braces. The row in hand may
 *     have been loaded before the sweep ran.
 *   GRACE EXPIRED — the announcement never came, or came and was lost. Results
 *     live thirty days; asking directly costs nothing and is the only thing
 *     standing between a lost free announcement and a re-purchase.
 *
 * @param {Object} item - a `DfsTask.items[]` entry
 * @param {Object} args
 * @param {Set<string>|null} [args.readySet]
 * @param {Object} args.job
 * @param {Date} args.now
 * @param {number} [args.graceMs]
 * @returns {boolean}
 */
const isPollable = (item, { readySet = null, job, now, graceMs = READY_GRACE_MS }) => {
  if (!item?.externalId || item.collected) return false;
  if (!readySet) return true;
  if (item.readyAt) return true;
  if (readySet.has(item.externalId)) return true;

  const postedAt = job?.postedAt ? new Date(job.postedAt).getTime() : null;
  if (!postedAt) return true; // a job with no post time is not a job to wait on
  return now.getTime() - postedAt >= graceMs;
};

module.exports = {
  READY_GRACE_MS,
  readReadyRows,
  persistReady,
  sweepReady,
  sweepErrors,
  isPollable,
};
