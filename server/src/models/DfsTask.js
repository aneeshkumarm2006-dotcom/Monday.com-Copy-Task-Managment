const mongoose = require('mongoose');

/**
 * One unit of work posted to DataForSEO, and the ledger of what it cost.
 *
 * ---- Why this is a collection of its own, and not `ConnectorSnapshot` -------
 *
 * The first answer people reach for is "because `partial` is never fresh", and
 * it is wrong. `isFresh` returning false for a `partial` reading is the
 * MECHANISM THE POLLING LOOP DEPENDS ON — if a queued reading were fresh the
 * hourly runner would never come back and the result would never be collected.
 *
 * The real reason is narrower and load-bearing:
 *
 *   A SNAPSHOT IS IDENTIFIED BY `periodKey`, AND `periodKey` CANNOT BE KNOWN
 *   UNTIL THE TASK COMPLETES.
 *
 * `snapshotService.writeSnapshot` computes it as
 * `periodKeyFrom(result.collectedAt, now)`, falling back to today. An open task
 * has no `collectedAt`. So an in-flight marker stored as a snapshot is stored
 * under a key that is GUARANTEED TO BE PROVISIONAL, in a collection whose whole
 * premise is that the key is authoritative — and once per UTC day the task stays
 * open it would mint another one, each outranking the real reading underneath it
 * (the tab sorts `periodKey: -1` and takes the first row).
 *
 * Three more differences follow from that one:
 *
 *   CARDINALITY — one snapshot is up to 200 provider tasks, each with its own
 *     id, its own cost and its own way of failing. See `taskItemSchema`.
 *   SHARED CODE — a `pending` value in `ConnectorSnapshot.status` would be an
 *     enum entry added to a shared schema for one provider's transport, and
 *     `writeSnapshot`'s `{status: {$ne: 'ok'}}` narrowing was reasoned about for
 *     exactly two states.
 *   COST — reposts, `40501`s and abandoned tasks all spend money and produce no
 *     snapshot. The ledger belongs where the money is.
 *
 * ---- The one thing in this design that is actually concurrency-safe ---------
 *
 * `connectorSyncRunner`'s `running` flag is module-level and per-process,
 * `refreshConnectorData` calls `collectSnapshots` directly and bypasses it
 * entirely, and Render can run two instances. The snapshot collection's unique
 * index cannot be the backstop either, because the collision happens at POST
 * time — hours before a snapshot row is written.
 *
 * THE PARTIAL UNIQUE INDEX AT THE BOTTOM OF THIS FILE IS THE ONLY REAL
 * CONCURRENCY CONTROL IN THIS DESIGN. Every writer must rely on the index
 * refusing the second insert, never on having read first and found nothing.
 */

/**
 * One provider task inside one post.
 *
 * ---- Why the per-task detail is embedded rather than a row each -------------
 *
 * The anti-repost gate is a partial UNIQUE index on `(project, kind, variant)`
 * for `state: 'open'`. That index is what makes two processes safe, and it can
 * only hold if there is exactly ONE open row per (project, kind, variant). Two
 * hundred sibling rows sharing those three values would collide with each other
 * on the second insert and the gate would have to be given up.
 *
 * So the row is the JOB — one `task_post` of one keyword list into one market —
 * and the per-task ledger lives here, inside it. That keeps every singular field
 * on the parent singular (`request`, `requestHash`, `estimateUsd`, `periodKey`,
 * `attempt`) and every per-task fact plural, which is exactly how the design
 * describes them.
 *
 * Two hundred items is ~24 KB. `ConnectorSnapshot`'s 16 MB problem comes from
 * SERP BODIES (100-200 KB per keyword at `depth: 100`), which is a phase-3
 * problem and is why `DfsSerpResult` exists. Nothing bulky is ever stored here.
 */
const taskItemSchema = new mongoose.Schema(
  {
    /** The keyword this task buys. Normalised, exactly as it was sent. */
    keyword: { type: String, default: null },

    /**
     * The `tag` we sent and DataForSEO echoes back in `tasks[].data.tag`.
     *
     * The join between "what we asked for" and "what came back". The provider is
     * free to reorder tasks in its response and its `data` echo is the only
     * thing that carries our own reference, so the tag — not the array position
     * — is what maps a returned id onto a keyword.
     */
    tag: { type: String, default: null },

    /**
     * DataForSEO's task id. THE handle on money already spent.
     *
     * With `id` and `cost` and the echoed `tag`, this row can be reconciled
     * against an invoice and a result can be collected, and there is nothing
     * else that can do either. Null only for a task the post refused outright,
     * which is a task that was never charged for.
     */
    externalId: { type: String, default: null },

    /** What this one task cost, per DataForSEO's own per-task attribution. */
    cost: { type: Number, default: 0 },

    /** `20100` on a healthy post. A per-task failure keeps its own code here. */
    statusCode: { type: Number, default: null },
    statusMessage: { type: String, default: '' },

    /**
     * Set by the phase-4 `tasks_ready` sweep BEFORE `task_get` runs.
     *
     * `tasks_ready` is a DESTRUCTIVE READ — an id appears once and is dropped —
     * so an id we fail to persist before crashing is gone from the ready list
     * forever. Persisting first and collecting second is the whole of phase 4.
     */
    readyAt: { type: Date, default: null },

    /** True once this task's result has been read and folded into a snapshot. */
    collected: { type: Boolean, default: false },
  },
  { _id: false }
);

const dfsTaskSchema = new mongoose.Schema(
  {
    /**
     * REQUIRED, and the reason is `services/orgCascade.js`.
     *
     * That file deletes every connector collection by `organisation`. A row that
     * could carry a null would survive the teardown of the workspace it was
     * bought for, holding a keyword list — competitive intelligence — for an org
     * that no longer exists. It is denormalised off the project rather than
     * joined for exactly that: a cascade cannot afford a lookup.
     */
    organisation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organisation',
      required: true,
    },

    /** The connected DataForSEO account the post was billed against. */
    account: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ConnectorAccount',
      required: true,
    },

    /** The Site this collects for. Half of the anti-repost identity. */
    project: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ConnectorProject',
      required: true,
    },

    /**
     * Carried even though this collection can only ever hold one provider's
     * rows, so a query, a log line or an export never has to infer it from the
     * collection name. Same reasoning as `ConnectorSnapshot.provider`.
     */
    provider: { type: String, default: 'dataforseo' },

    /** The snapshot kind this job will produce — `positions`, `movement`. */
    kind: { type: String, required: true },

    /**
     * `location_code|language_code|device`, from `sites.variantKeyFor`.
     *
     * VERBATIM from that function, never re-spelled here. The variant key is
     * half of the open-task identity, and a second spelling of it is a cache
     * miss on the gate — which against a provider that bills at POST is a second
     * charge for work already paid for.
     */
    variant: { type: String, required: true },

    /** `serp/google/organic/task_post` — the path the money went to. */
    endpoint: { type: String, required: true },

    /**
     * The provider id, for a post that produced EXACTLY ONE task.
     *
     * Null for a keyword batch, which has no single id — the ids live on
     * `items[].externalId`. Unique and SPARSE below, so the nulls do not
     * collide with each other, and so the phase-4 `tasks_ready` join has an
     * exact-match index for the single-task kinds phases 6-8 will add.
     */
    externalId: { type: String, default: null },

    /** The job reference every item's tag is built from. Ours, not theirs. */
    tag: { type: String, default: null },

    /**
     * The request, CANONICAL AND COMPLETE.
     *
     * A repost has to be reproducible WITHOUT RE-READING THE PROJECT, because
     * the project's keyword list may have changed between the post and the
     * expiry — and a "retry" that quietly buys a different basket of keywords is
     * not a retry, it is a second purchase wearing the first one's attempt
     * counter.
     */
    request: { type: mongoose.Schema.Types.Mixed, default: null },

    /** The keyword list as posted. Denormalised out of `request` so it is queryable. */
    keywords: { type: [String], default: [] },

    /**
     * sha256 over the canonical request. READ BY NOTHING TODAY.
     *
     * Two things make it worth computing now anyway. It is what makes a repost
     * PROVABLY identical to the original rather than merely intended to be. And
     * it is the exact value a phase-11 cross-tenant cache would key on, so
     * computing it early turns "should we build that?" into a measurement
     * instead of a guess. It costs one hash per post.
     */
    requestHash: { type: String, default: null },

    /**
     * Where this job is.
     *
     *   reserving — UNREACHABLE from phase 3 onward. See `budgetState` below:
     *               the money phase became a sub-state on this row because a row
     *               inserted as `reserving` is NOT covered by the partial unique
     *               index, so using it as the claim would have let two processes
     *               both insert, both reserve and both post — reintroducing the
     *               double charge through the safety mechanism. The enum value is
     *               kept so a legacy row still loads; nothing writes it.
     *   open      — posted and charged; the result has not arrived.
     *   ready     — `tasks_ready` says the result is waiting (phase 4).
     *   done      — collected and folded into a snapshot.
     *   abandoned — expired without a result; a repost is allowed.
     *   dead      — expired `maxAttempts` times. NO further post. The fetcher
     *               returns `pending` with an actionable note instead.
     *   failed    — the post itself was refused. Nothing is in flight.
     *
     * Only `open` participates in the anti-repost gate, which is what lets a
     * finished job sit in the collection forever as the ledger it is.
     */
    state: {
      type: String,
      enum: ['reserving', 'open', 'ready', 'done', 'abandoned', 'dead', 'failed'],
      default: 'reserving',
      required: true,
    },

    /**
     * Which try this is, and how many there may be.
     *
     * The pair exists because BOTH naive answers are wrong. Never expiring an
     * open row means one dropped task silently suppresses that keyword's
     * collection forever — no error, no gap anybody can see, just a line that
     * stops moving. Expiring and reposting unconditionally means a task
     * DataForSEO will never answer is re-bought every N hours forever, which is
     * strictly worse than the 168-charges-a-week this whole design exists to
     * avoid.
     */
    attempt: { type: Number, default: 1 },
    maxAttempts: { type: Number, default: 3 },

    /**
     * WHERE THE MONEY IS, as opposed to where the work is.
     *
     * ---- Why this is a second field and not a value of `state` --------------
     *
     * Because the claim must stay `state: 'open'`. The partial unique index at
     * the bottom of this file covers `state: 'open'` AND NOTHING ELSE, so a row
     * inserted as `state: 'reserving'` is unprotected — two processes would both
     * insert one, both reserve, both post, and the anti-repost gate would have
     * been bypassed by the mechanism added to make posting safer.
     *
     * So the row asks two orthogonal questions at once:
     *
     *   `state`       — where the WORK is: open, done, abandoned, dead, failed.
     *   `budgetState` — where the MONEY is:
     *       none      — no reservation was ever taken (a job predating phase 3).
     *       reserving — money is held and not yet accounted for. THE STATE THE
     *                   TEN-MINUTE RECONCILER SWEEPS; anything still here after
     *                   a reserve-post-settle sequence that takes seconds is a
     *                   process that died holding a reservation, which shrinks
     *                   the month's budget until it rolls over.
     *       settled   — the reservation became a charge.
     *       released  — the reservation was given back; nothing was bought.
     *
     * A single row therefore carries `state: 'open', budgetState: 'settled'` in
     * the normal case: bought, paid for, waiting on a result.
     */
    budgetState: {
      type: String,
      enum: ['none', 'reserving', 'settled', 'released'],
      default: 'none',
    },

    /** When the reservation was taken. The reconciler's clock. */
    reservedAt: { type: Date, default: null },
    /** When it became a charge, or was given back. */
    settledAt: { type: Date, default: null },

    /** What we expected to pay, at reserve time. Settled against at post time. */
    estimateUsd: { type: Number, default: 0 },
    /** What DataForSEO said it charged, summed from `items[].cost`. */
    costUsd: { type: Number, default: 0 },
    /**
     * The `ConnectorBudget` documents this job holds a reservation against —
     * `{scope, scopeId, periodKey, capUsd}` each, ORG FIRST.
     *
     * A list because a job reserves against an org document AND, when a board
     * has an allocation, a board one; and a crash between reserve and settle has
     * to be able to release both without re-deriving which they were.
     *
     * Written BEFORE the counters are incremented, which is the ordering that
     * makes `ConnectorBudget.reservedUsd` a recomputable cache: the cache's value
     * is defined as the sum over the tasks NAMING a document, so a task must name
     * it before it moves it. Written the other way round, a crash in between
     * leaves a counter nothing can be traced to.
     */
    budgetDocs: { type: [mongoose.Schema.Types.Mixed], default: [] },

    /** The envelope's own verdict on the post. Provider text; render as text. */
    statusCode: { type: Number, default: null },
    statusMessage: { type: String, default: '' },

    postedAt: { type: Date, default: null },
    readyAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },

    /**
     * When an unanswered task stops being worth waiting for.
     *
     * Kept well inside DataForSEO's 3-day `tasks_ready` retention. Past this,
     * the sweep abandons the row and a repost is allowed — or, at
     * `attempt >= maxAttempts`, kills it.
     */
    expiresAt: { type: Date, default: null },

    /**
     * FILLED FROM THE RESULT. NEVER AT POST TIME.
     *
     * The single sentence this whole collection exists for. At post time the
     * only period available is "today", which is a guess that goes wrong for
     * every task posted in the last hour of a UTC day — and a wrong period is
     * not a cosmetic error, it is a snapshot filed under a day it did not
     * happen on, colliding with the real reading for that day on the unique
     * index and being dropped as "the row we already had was better".
     */
    periodKey: { type: String, default: null },

    /**
     * WHERE THE READING CAME FROM. `provider` unless phase 11's shared SERP
     * cache answered it, which it can only do for an organisation named in
     * `DATAFORSEO_SERP_CACHE_ORGS` — empty by default.
     *
     * It exists because a cache-served collection is a real collection with NO
     * MONEY BEHIND IT, and the usage ledger reads this collection to answer
     * "what did this board cost". Counted as a purchase it would report spend
     * that never happened at a per-task cost of zero, which reads as a price cut
     * rather than as a collection nobody paid for; left out of the ledger
     * entirely it would report a board collecting less often than it does. So it
     * is counted, apart, under its own name.
     *
     * A cache-served row is `state: 'done'` at creation and NEVER `open`: `open`
     * is the state the partial unique index covers, and a row that never posted
     * has no business holding the anti-repost claim.
     */
    source: {
      type: String,
      enum: ['provider', 'cache'],
      default: 'provider',
    },

    /** Why a job is `dead`, `failed` or `abandoned`. Shown to a person. */
    note: { type: String, default: '' },

    /** The per-task ledger. See `taskItemSchema` for why it is embedded. */
    items: { type: [taskItemSchema], default: [] },
  },
  { timestamps: true }
);

/**
 * THE ANTI-REPOST GATE.
 *
 * ---- Why the key contains no date ------------------------------------------
 *
 * Keying an open task on `periodKey` looks natural and double-charges every task
 * posted in the last hour of a UTC day: posted Monday 23:50 under `2026-08-31`,
 * the 00:17 tick looks up `2026-09-01`, misses, and posts the whole batch again.
 * That is ~4% of all posts, permanently, plus two tasks racing into one snapshot
 * row. The identity is `(project, kind, variant)` and nothing else.
 *
 * ---- Why it is an INDEX and not a read-then-write ---------------------------
 *
 * Because the read-then-write has no atomicity anywhere in this system to lean
 * on. Two processes both find no open row, both post, and both are charged; the
 * unique index instead lets exactly one insert win and answers the loser with
 * E11000, which the caller reads as "somebody else already posted this" and
 * turns into a `pending`. Same technique `ConnectorProject` already uses for
 * `(provider, group)`.
 *
 * Partial on `state: 'open'` so a finished job stays in the collection as the
 * cost ledger it is, and a hundred `done` rows for one keyword list never
 * conflict.
 */
dfsTaskSchema.index(
  { project: 1, kind: 1, variant: 1 },
  { unique: true, partialFilterExpression: { state: 'open' } }
);

/**
 * The `tasks_ready` join, for the single-task kinds.
 *
 * Unique so a re-delivered id cannot produce a second row, SPARSE so the batch
 * rows — which have no single id, only `items[].externalId` — do not all
 * collide on null.
 */
dfsTaskSchema.index({ externalId: 1 }, { unique: true, sparse: true });

/**
 * The batch counterpart of the index above.
 *
 * `tasks_ready` hands back individual task ids with no indication of which post
 * they came from, so the sweep can only find a batch row THROUGH its items. Not
 * unique: an id appears in exactly one row, but enforcing that across a multikey
 * path buys nothing the post path does not already guarantee.
 */
dfsTaskSchema.index({ 'items.externalId': 1 });

/** The expiry sweep: everything open, ordered by when it stops being worth waiting for. */
dfsTaskSchema.index({ state: 1, expiresAt: 1 });

/** Everything in flight on one account — the operator's question, and phase 4's. */
dfsTaskSchema.index({ account: 1, state: 1 });

/**
 * The tab's "queued" count: `countDocuments({ project, state: 'open' })`.
 *
 * The one thing a separate collection loses is the snapshot row's ability to say
 * "queued", and this index is what buys it back for one extra query — keeping
 * intact the rule that THE READ ENDPOINT NEVER CONTACTS A PROVIDER.
 */
dfsTaskSchema.index({ project: 1, state: 1 });

/**
 * THE RECONCILER'S SWEEP: every task still holding money it never accounted for.
 *
 * A reserve-post-settle sequence takes seconds, so this index is expected to
 * select nothing on almost every run — which is exactly why it has to be an
 * index. It is scanned every pass and the collection grows forever, so the
 * cheapest possible answer to "is anything stuck?" is the one that gets to keep
 * running unattended.
 */
dfsTaskSchema.index({ budgetState: 1, reservedAt: 1 });

/**
 * The recompute: every live reservation against one budget document.
 *
 * Multikey on `budgetDocs.scopeId`, which is the selective half — one org id
 * against a collection holding every org's tasks. The `$elemMatch` that uses it
 * cannot be expressed as dotted equalities, because those match ACROSS array
 * elements and would count a row whose org entry names a different workspace.
 */
dfsTaskSchema.index({ 'budgetDocs.scopeId': 1, budgetState: 1 });

/** `services/orgCascade.js` deletes by this and nothing else. */
dfsTaskSchema.index({ organisation: 1 });

module.exports = mongoose.model('DfsTask', dfsTaskSchema);
