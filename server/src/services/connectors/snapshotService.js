const ConnectorAccount = require('../../models/ConnectorAccount');
const ConnectorProject = require('../../models/ConnectorProject');
const ConnectorSnapshot = require('../../models/ConnectorSnapshot');
const BoardConnector = require('../../models/BoardConnector');
const { openSession } = require('./session');
const { getConnector } = require('./index');

/**
 * Collect snapshots. The generic half.
 *
 * ---- What "generic" means here and why it is worth the discipline ----------
 *
 * Nothing in this file names Ubersuggest, a tool, or a kind. It asks the
 * registry for a descriptor, reads `descriptor.kinds`, calls
 * `descriptor.fetch(kind, ctx)` and stores what comes back. Everything
 * provider-shaped — which tools a kind spends, what a payload means, how a
 * variant is spelled — lives inside the provider directory.
 *
 * That is the same split `projectMirror.js` already made, and it is what makes
 * the Ads-board connector a new directory rather than a second runner. The
 * moment this file gains an `if (provider === …)` the seam is gone.
 *
 * ---- The four outcomes, and why they are not the same -----------------------
 *
 *   QUOTA EXHAUSTED — stop this ACCOUNT for this run and record it. It is not a
 *     fault and not retryable: report limits reset daily, credits monthly, and
 *     retrying spends nothing but time. Critically it stops the account, not the
 *     run — the pool is plural and each account has its own quota.
 *
 *   NEEDS REAUTH — stop this account and flag it. The refresh grant is dead;
 *     every further call this week returns the same 401 and only a human with a
 *     browser can fix it.
 *
 *   ANYTHING ELSE — record against the one (project, kind) that failed and KEEP
 *     GOING. A week where 3 of 200 subjects failed is a successful sync with 3
 *     gaps. Collapsing that into a thrown error would discard 197 readings to
 *     report 3, and next week's run would have nothing to compare against.
 *
 * ---- The fourth outcome: PENDING -------------------------------------------
 *
 * A provider that ASKS FOR WORK NOW and COLLECTS IT LATER — one that posts a
 * task and polls for it, or one that has hit a spend ceiling this operator set —
 * has a fourth answer to give: "nothing is wrong, and nothing is ready".
 *
 * It cannot be an error. `syncAccount` copies the first error into
 * `ConnectorAccount.lastSyncReport.error`, so an operator would read "queued at
 * the provider" as a permanent account failure and go looking for a broken
 * credential.
 *
 * It cannot be a snapshot either, and that is the load-bearing half. A snapshot
 * is IDENTIFIED by its `periodKey`, and `periodKey` comes from the reading's own
 * `collectedAt` — which an unfinished request does not have. Storing an
 * in-flight marker means storing it under today's date as a guess, in a
 * collection whose entire premise is that the key is authoritative. The next day
 * it writes a second guess; the read sorts `periodKey: -1` and takes the first
 * row, so the newer empty one outranks the older real one; `trend` gains holes;
 * and every dependant starves on a `null` body.
 *
 * So `result.status === 'pending'` writes NOTHING, feeds NOTHING, and is counted
 * as `queued` rather than as `ok` or `failed`. Generic, and it names no
 * provider — an in-flight REQUEST is the provider's own problem to record, in
 * the provider's own collection, where its identity does not need a date.
 *
 * ---- What is never written -------------------------------------------------
 *
 * A failure never becomes a snapshot row. It would have to claim a periodKey,
 * and the only one available for a failure is today's — which would then squat
 * in the slot the real reading needs when the provider recovers, and the unique
 * index would keep the good data out. Failures live on the run report.
 */

/** `YYYY-MM-DD`, UTC. */
const dayKey = (date) => new Date(date).toISOString().slice(0, 10);

/**
 * Which day a reading belongs to.
 *
 * The provider's own collection time wins wherever it gives one — that is the
 * authoritative moment the SERP was read, and keying off it is what makes two
 * polls in the same week resolve to one data point instead of two.
 *
 * Note this deliberately does NOT use `utils/tzDay.js`. That file is the board's
 * month/day contract and is resolved in the BOARD's timezone; a snapshot period
 * is a fact about the provider, not about whoever is looking at it, and running
 * it through a board timezone would give the same reading two different periods
 * on two different boards.
 *
 * @param {Date|string|null} collectedAt
 * @param {Date} now
 * @returns {string}
 */
const periodKeyFrom = (collectedAt, now = new Date()) => {
  if (collectedAt) {
    const d = new Date(collectedAt);
    if (!Number.isNaN(d.getTime())) return dayKey(d);
  }
  return dayKey(now);
};

/**
 * Is an existing snapshot recent enough to skip re-fetching?
 *
 * Two rules, and the second is the one that matters:
 *
 *   - an `ok` reading inside the provider's own cadence is skipped. Ubersuggest
 *     collects rankings WEEKLY on every plan, so polling daily returns
 *     byte-identical data and spends a shared quota to do it.
 *   - a `partial` reading is NEVER fresh. It is a crawl that had not finished or
 *     a report that timed out, and the whole reason to come back is that there
 *     is more of it now.
 *
 * @param {Object|null} existing
 * @param {number} intervalHours
 * @param {Date} now
 * @returns {boolean}
 */
const isFresh = (existing, intervalHours, now = new Date()) => {
  if (!existing) return false;
  if (existing.status !== 'ok') return false;
  const at = existing.fetchedAt || existing.updatedAt;
  if (!at) return false;
  const ageMs = now.getTime() - new Date(at).getTime();
  return ageMs < Math.max(0, intervalHours) * 3_600_000;
};

/**
 * A cadence somebody ASKED for, or null meaning "no opinion".
 *
 * One place to say what a usable override is, because there are two of them —
 * a board row read from the database, and whatever `intervalHoursFor` hands
 * back — and a 0, a NaN or a negative from either one would make every kind
 * permanently stale and turn the hourly tick into an hourly spend. Falling back
 * is always safe; trusting the number is not.
 *
 * @param {any} value
 * @returns {number|null}
 */
const askedInterval = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

/**
 * Work out what to fetch for one project, without fetching anything.
 *
 * Pure, and separated for exactly that reason — this is where quota is decided,
 * and "did we correctly skip the thing we already have" is a property worth
 * asserting without a network or a database.
 *
 * @param {Object} args
 * @param {Object} args.project - a ConnectorProject row
 * @param {Array<Object>} args.kinds - resolved kind descriptors, in dependency order
 * @param {Function} args.variantsFor - `(kindKey, project) => { variants, skipped }`
 * @param {Map<string, Object>} args.latest - `${kind}|${variant}` → newest snapshot
 * @param {number} args.intervalHours - the connector-wide default; a kind may
 *   override it with its own `intervalHours`
 * @param {boolean} [args.force] - an explicit button press ignores freshness
 * @param {Date} [args.now]
 * @returns {{ todo: Array<{kind: Object, variant: Object, existing: Object|null}>,
 *   skipped: Array<Object> }}
 */
const planProjectWork = ({
  project,
  kinds,
  variantsFor,
  latest,
  intervalHours,
  force = false,
  now = new Date(),
}) => {
  const todo = [];
  const skipped = [];

  for (const kind of kinds) {
    // A kind that needs a field this project does not carry is skipped BEFORE a
    // call is made. The audit and domain tools take a domain and know nothing
    // about projects, so a mirrored project with no domain on it can only ever
    // take a fatal error from them — and a fatal error costs the same quota as
    // a successful call.
    if (kind.requires && !project[kind.requires]) {
      skipped.push({
        kind: kind.key,
        variant: 'default',
        reason: `needs a ${kind.requires}`,
      });
      continue;
    }

    const { variants, skipped: droppedVariants } = variantsFor(kind.key, project);
    if (droppedVariants > 0) {
      // Logged rather than silent. A cap that nobody can see reads as "we
      // covered everything" when it did not.
      skipped.push({
        kind: kind.key,
        variant: 'default',
        reason: `${droppedVariants} further location(s) not polled`,
      });
    }

    for (const variant of variants) {
      const key = `${kind.key}|${variant.key}`;
      const existing = latest.get(key) || null;

      /**
       * Per-kind cadence, resolved HERE rather than inside `isFresh`.
       *
       * One provider does not have one cadence. A rank census that is bought at
       * depth 100 belongs on a weekly clock; the same provider's movement check
       * belongs on a daily one; a backlink profile barely moves in a month. A
       * single number per descriptor forces all of them onto the fastest, and
       * for a provider that bills per call that is the difference between one
       * charge a week and seven.
       *
       * `isFresh` stays PURE and stays two-argument. It answers "is this row
       * younger than N hours", which is a fact about the row; WHICH N applies is
       * a policy decision belonging to the planner, and the whole reason the
       * planner is separated out is that quota decisions are asserted here.
       */
      const kindInterval = kind.intervalHours ?? intervalHours;

      if (!force && isFresh(existing, kindInterval, now)) {
        skipped.push({ kind: kind.key, variant: variant.key, reason: 'already current' });
        continue;
      }
      // `existing` travels with the item so the fetcher can see it. A provider
      // billed per call needs to answer "is it worth asking again", and rebuilding
      // this map inside the provider would mean a second query per fetch for
      // something already in hand — it was built and thrown away before this.
      todo.push({ kind, variant, existing });
    }
  }

  return { todo, skipped };
};

/**
 * Store one reading.
 *
 * The interesting case is the second one. When a period already holds a
 * FINISHED reading and this run produced a partial one — a crawl restarted, a
 * rank report that timed out on the retry — the finished row must win. That is
 * done with the filter rather than with a read-then-write, because two app
 * instances waking on the same cron minute would both read "nothing better
 * here" and both write. Narrowing the filter means the loser's upsert becomes an
 * insert, collides with the unique index, and is caught below as "the row we
 * already had was better", which is the correct outcome rather than an error.
 *
 * @returns {Promise<{written: boolean, periodKey: string|null, pending: boolean}>}
 */
const writeSnapshot = async ({
  project,
  provider,
  kind,
  variant,
  result,
  actorId = null,
  now = new Date(),
}) => {
  /**
   * The `pending` sentinel — see this file's header.
   *
   * Checked BEFORE a period is computed, deliberately. `periodKeyFrom` falls
   * back to today for anything without a `collectedAt`, so reaching the line
   * below would mint a plausible, wrong, authoritative-looking key for a reading
   * that does not exist yet. There is no correct answer to return here, which is
   * why the answer is `null` and not a date.
   *
   * NOT an entry in `ConnectorSnapshot.status`. That enum was reasoned about for
   * exactly two states, `writeSnapshot`'s `{$ne: 'ok'}` narrowing depends on
   * that, and a third value for one provider's transport is the shared-schema
   * change this seam exists to avoid.
   */
  if (result.status === 'pending') {
    return { written: false, periodKey: null, pending: true };
  }

  const periodKey = periodKeyFrom(result.collectedAt, now);
  const status = result.status === 'partial' ? 'partial' : 'ok';

  const filter = {
    project: project._id,
    kind: kind.key,
    variant: variant.key,
    periodKey,
  };
  // A partial reading may only land where nothing better is already sitting.
  if (status === 'partial') filter.status = { $ne: 'ok' };

  try {
    await ConnectorSnapshot.updateOne(
      filter,
      {
        // Everything under `$set`, including the four identity fields. They are
        // already equalities in the filter, so an insert would derive them
        // anyway — but naming them explicitly means the write does not depend on
        // how the driver builds an upsert's insert document, and the partial
        // branch's filter is NOT four equalities (it carries a `$ne` on status).
        $set: {
          organisation: project.organisation,
          account: project.account,
          project: project._id,
          provider,
          kind: kind.key,
          variant: variant.key,
          periodKey,
          collectedAt: result.collectedAt || null,
          subject:
            kind.subject === 'domain'
              ? `domain:${project.domain || ''}`
              : `project:${project.externalId}`,
          data: result.data ?? null,
          raw: result.raw ?? null,
          status,
          note: result.note || '',
          fetchedAt: now,
          fetchedBy: actorId || null,
        },
      },
      { upsert: true }
    );
    return { written: true, periodKey, pending: false };
  } catch (err) {
    if (err?.code === 11000) {
      // Either a concurrent run got there first, or the narrowed filter above
      // refused to downgrade a finished reading. Both mean the row that exists
      // is at least as good as the one we had.
      return { written: false, periodKey, pending: false };
    }
    throw err;
  }
};

/**
 * Collect everything one project needs.
 *
 * Kinds are walked IN ORDER inside one project rather than one kind across
 * every project, and that is a quota decision rather than a stylistic one: a
 * report subject is free for the rest of the day once it has been paid for, and
 * three domain-subject kinds naming the same domain in the same pass cost one
 * report between them. Spread across three days they cost three.
 *
 * @returns {Promise<Object>} a per-project report; throws only for the two
 *   account-level stop conditions
 */
const syncProject = async ({
  session,
  connector,
  client,
  project,
  kinds,
  intervalHours,
  range,
  force = false,
  actorId = null,
  now = new Date(),
}) => {
  const report = {
    projectId: String(project._id),
    name: project.name || project.domain || project.externalId,
    ok: 0,
    failed: 0,
    skipped: 0,
    written: 0,
    /**
     * Asked for, not yet available — see the `pending` sentinel in this file's
     * header. Counted SEPARATELY from all three of the others on purpose:
     *
     *   `ok`      would claim a reading exists;
     *   `failed`  would put "queued" in front of an operator as a fault;
     *   `skipped` already means "we did not need to ask", which is the opposite.
     *
     * Without it a pass that did nothing but poll reports 0/0/0 and reads as a
     * dead connector.
     */
    queued: 0,
    errors: [],
    notes: [],
  };

  const rows = await ConnectorSnapshot.find({ project: project._id })
    .select('kind variant status fetchedAt')
    .sort({ fetchedAt: -1 })
    .lean();

  // Newest first, so the first row seen for a key is the newest.
  const latest = new Map();
  for (const row of rows) {
    const key = `${row.kind}|${row.variant}`;
    if (!latest.has(key)) latest.set(key, row);
  }

  const { todo, skipped } = planProjectWork({
    project,
    kinds,
    variantsFor: connector.variantsFor,
    latest,
    intervalHours,
    force,
    now,
  });

  report.skipped = skipped.length;
  for (const s of skipped) {
    if (s.reason !== 'already current') {
      report.notes.push(`${s.kind}: ${s.reason}`);
    }
  }

  /**
   * What earlier kinds in THIS pass produced, for the kinds that declare a
   * dependency. `keyword_metrics` reads its keyword list out of `positions`
   * rather than spending a second report to enumerate the same thing.
   *
   * Keyed by kind only, not by variant: a dependant is fetched once per variant
   * of its own and takes whichever reading of its dependency shares that
   * variant, falling back to any of them.
   */
  const produced = new Map();

  /**
   * A dependency's result — from this pass if it ran, otherwise from the last
   * snapshot we stored for it.
   *
   * The stored fallback is not an optimisation, it closes a real hole. Freshness
   * is decided per (kind, variant), so the two halves of a dependency pair can
   * drift apart: if `positions` succeeds and `keyword_metrics` fails in the same
   * pass, the next hour finds positions FRESH and therefore not re-fetched — and
   * without this, metrics would be skipped for "positions did not run" every
   * hour until positions went stale again a week later. Reading the stored
   * keyword list costs a database query and no quota at all.
   *
   * @returns {Promise<any|null>}
   */
  const dependencyData = async (depKey, variantKey) => {
    const inPass = produced.get(depKey);
    if (inPass) return inPass.get(variantKey) || [...inPass.values()][0] || null;

    // The matching variant first. Then any of them: a project's tracked keyword
    // list is the same in every market, and the locale only decides whose
    // volumes get asked for — so a US reading is a perfectly good source for a
    // UK metrics fetch, and refusing it would leave the section empty for no
    // gain.
    const exact = await ConnectorSnapshot.findOne({
      project: project._id,
      kind: depKey,
      variant: variantKey,
    })
      .select('data')
      .sort({ fetchedAt: -1 })
      .lean();
    if (exact?.data) return exact.data;

    const any = await ConnectorSnapshot.findOne({ project: project._id, kind: depKey })
      .select('data')
      .sort({ fetchedAt: -1 })
      .lean();
    return any?.data ?? null;
  };

  for (const { kind, variant, existing } of todo) {
    const previous = {};
    let missingDep = null;
    for (const dep of kind.dependsOn) {
      // eslint-disable-next-line no-await-in-loop
      const data = await dependencyData(dep, variant.key);
      // A dependant run against nothing would write an empty snapshot that then
      // looks current for a week — worse than not running it.
      if (!data) {
        missingDep = dep;
        break;
      }
      previous[dep] = data;
    }
    if (missingDep) {
      report.skipped += 1;
      report.notes.push(`${kind.key}: skipped, no ${missingDep} to work from`);
      continue;
    }

    let result;
    try {
      // eslint-disable-next-line no-await-in-loop
      result = await connector.fetch(kind.key, {
        session,
        client,
        project,
        variant,
        range,
        previous,
        /**
         * The newest stored reading for this exact (kind, variant), and whether
         * a human asked for this.
         *
         * The planner already decided this is worth fetching — it is not fresh.
         * These two exist for the provider that has a SECOND, stricter opinion
         * about the same question: one billed per call can be stale by the
         * cadence and still not worth a charge, and it is the only party that
         * knows what the call costs.
         *
         * `force` is passed rather than inferred, because "not fresh" and "a
         * person pressed Refresh" are different facts and the provider needs
         * both — refusing a human is a different answer from refusing a cron.
         * A provider that has no opinion ignores both and behaves exactly as
         * before.
         */
        existing: existing || null,
        force,
      });
    } catch (err) {
      // The two account-level stops. Re-thrown so the caller can end this
      // account's run rather than grinding through every remaining project to
      // collect the same error each time.
      if (err.quotaExhausted || err.needsReauth) throw err;

      report.failed += 1;
      report.errors.push(`${kind.key}: ${err.message}`);
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    const { written, pending } = await writeSnapshot({
      project,
      provider: connector.name,
      kind,
      variant,
      result,
      actorId,
      now,
    });

    if (pending) {
      // Nothing was stored, so nothing may be counted as collected and nothing
      // may be offered to a dependant — a dependant handed a queued kind's empty
      // body would write an empty snapshot that then looks current for a week,
      // which is strictly worse than not running it.
      report.queued += 1;
      // The note is the only thing a person can see about an in-flight request,
      // so it survives even though the row did not.
      if (result.note) report.notes.push(`${kind.key}: ${result.note}`);
      continue;
    }

    report.ok += 1;
    if (written) report.written += 1;
    if (result.note) report.notes.push(`${kind.key}: ${result.note}`);

    if (!produced.has(kind.key)) produced.set(kind.key, new Map());
    produced.get(kind.key).set(variant.key, result.data);
  }

  await ConnectorProject.updateOne(
    { _id: project._id },
    { $set: { lastFetchedAt: now } }
  );

  return report;
};

/**
 * Collect for every project on one account.
 *
 * Never throws for a provider failure — the pool is plural, and one account
 * being out of quota says nothing about the next one. The two stop conditions
 * end THIS account and are reported on it.
 *
 * @returns {Promise<Object>} the per-account report
 */
const syncAccount = async ({
  account,
  projects,
  kindsFor,
  /**
   * How often THIS project should be polled, in hours, or null for the
   * descriptor's own default.
   *
   * A sibling of `kindsFor` and deliberately the same shape: both answer a
   * question about one project that only the caller can answer, because both are
   * resolved from `BoardConnector` rows and this file must not know that boards
   * exist. Optional — a caller with no per-project opinion omits it and every
   * project runs on the descriptor's cadence, exactly as before.
   */
  intervalHoursFor = null,
  range,
  force = false,
  actorId = null,
  now = new Date(),
}) => {
  const report = {
    accountId: String(account._id),
    label: account.label,
    ok: 0,
    failed: 0,
    skipped: 0,
    written: 0,
    queued: 0,
    quotaExhausted: false,
    needsReauth: false,
    error: '',
    projects: [],
  };

  const connector = getConnector(account.provider);
  if (!connector || typeof connector.fetch !== 'function') {
    report.error = `${account.provider} cannot collect data yet.`;
    return report;
  }

  let session;
  try {
    session = await openSession(account);
  } catch (err) {
    report.needsReauth = !!err.needsReauth;
    report.error = err.message;
    return report;
  }

  // ONE client for the whole account, so the MCP handshake happens once rather
  // than once per tool call. The server is stateless so this establishes nothing
  // at the other end — it settles the protocol revision and saves a round trip
  // per call, which across 15 projects × 5 kinds is not nothing.
  const client = connector.createClient
    ? connector.createClient(session)
    : undefined;

  const defaultIntervalHours = connector.syncIntervalHours ?? 168;

  for (const project of projects) {
    /**
     * Resolved INSIDE the loop, because it is a property of the project rather
     * than of the account: two projects on one account can be mapped to boards
     * that asked for different cadences, and hoisting this would give the whole
     * account whichever one happened to be first.
     *
     * Falsy or nonsensical values fall back rather than being trusted — a 0 or a
     * negative here would make every kind permanently stale and turn the hourly
     * tick into an hourly spend.
     */
    const intervalHours =
      askedInterval(intervalHoursFor ? intervalHoursFor(project) : null) ??
      defaultIntervalHours;

    let projectReport;
    try {
      // eslint-disable-next-line no-await-in-loop
      projectReport = await syncProject({
        session,
        connector,
        client,
        project,
        kinds: kindsFor(project),
        intervalHours,
        range,
        force,
        actorId,
        now,
      });
    } catch (err) {
      if (err.quotaExhausted) {
        report.quotaExhausted = true;
        report.error = report.error || err.message;
        break;
      }
      if (err.needsReauth) {
        report.needsReauth = true;
        report.error = report.error || err.message;
        // eslint-disable-next-line no-await-in-loop
        await session.markNeedsReauth();
        break;
      }
      // A project-level failure that is not one of the two stops. Record and
      // carry on to the next project.
      report.failed += 1;
      report.error = report.error || err.message;
      continue;
    }

    report.projects.push(projectReport);
    report.ok += projectReport.ok;
    report.failed += projectReport.failed;
    report.skipped += projectReport.skipped;
    report.written += projectReport.written;
    report.queued += projectReport.queued;
    if (!report.error && projectReport.errors.length) {
      [report.error] = projectReport.errors;
    }
  }

  await ConnectorAccount.updateOne(
    { _id: account._id },
    {
      $set: {
        lastSyncAt: now,
        lastSyncReport: {
          at: now,
          ok: report.ok,
          failed: report.failed,
          skipped: report.skipped,
          queued: report.queued,
          error: report.error || '',
          quotaExhausted: report.quotaExhausted,
        },
      },
    }
  );

  return report;
};

/**
 * Collect for a set of projects, grouped back onto the accounts that own them.
 *
 * The grouping is the point: credentials, quota and the stop conditions are all
 * per ACCOUNT, so a list of projects has to be re-sorted into accounts before
 * anything is fetched, or one account's exhausted quota would be discovered
 * once per project instead of once.
 *
 * @param {Object} args
 * @param {string} args.provider
 * @param {Array<Object>} args.projects - ConnectorProject rows
 * @param {(project: Object) => Array<Object>} args.kindsFor
 * @param {((project: Object) => number|null)} [args.intervalHoursFor]
 * @param {Object} [args.range]
 * @param {boolean} [args.force]
 * @param {string|null} [args.actorId]
 * @returns {Promise<{accounts: Array<Object>, ok: number, failed: number,
 *   written: number, queued: number, quotaExhausted: boolean}>}
 */
const collectSnapshots = async ({
  provider,
  projects,
  kindsFor,
  intervalHoursFor = null,
  range,
  force = false,
  actorId = null,
  now = new Date(),
}) => {
  const byAccount = new Map();
  for (const project of projects) {
    const key = String(project.account);
    if (!byAccount.has(key)) byAccount.set(key, []);
    byAccount.get(key).push(project);
  }

  const accounts = await ConnectorAccount.find({
    _id: { $in: [...byAccount.keys()] },
    provider,
    status: { $ne: 'revoked' },
  })
    .sort({ label: 1 })
    .lean();

  const reports = [];
  for (const account of accounts) {
    // Sequential. These accounts often share one Ubersuggest plan's quota, and
    // running them concurrently turns "we ran out partway through" into
    // "several calls raced past the limit and we cannot say which landed".
    reports.push(
      // eslint-disable-next-line no-await-in-loop
      await syncAccount({
        account,
        projects: byAccount.get(String(account._id)) || [],
        kindsFor,
        intervalHoursFor,
        range,
        force,
        actorId,
        now,
      })
    );
  }

  return {
    accounts: reports,
    ok: reports.reduce((s, r) => s + r.ok, 0),
    failed: reports.reduce((s, r) => s + r.failed, 0),
    skipped: reports.reduce((s, r) => s + r.skipped, 0),
    written: reports.reduce((s, r) => s + r.written, 0),
    queued: reports.reduce((s, r) => s + r.queued, 0),
    quotaExhausted: reports.some((r) => r.quotaExhausted),
    needsReauth: reports.some((r) => r.needsReauth),
  };
};

/**
 * The projects one board's connector is responsible for.
 *
 * MAPPED PROJECTS ONLY. An agency's Ubersuggest account holds projects for
 * clients who are not on this board and prospects who are not clients at all;
 * polling those weekly would spend a shared quota on domains nobody looks at.
 * A specific unmapped project can still be pulled on demand — see the
 * controller's `project` argument.
 *
 * @param {string} boardId
 * @param {string} provider
 * @returns {Promise<Array<Object>>}
 */
const projectsForBoard = (boardId, provider) =>
  ConnectorProject.find({
    board: boardId,
    provider,
    group: { $ne: null },
  })
    .sort({ name: 1 })
    .lean();

/**
 * Every (board, project) the unattended run should cover.
 *
 * Driven by `BoardConnector` rather than by the project rows, because
 * enablement is the switch a user actually operates: turning the connector off
 * for a board must stop the runner without discarding a single mapping or
 * snapshot, and inferring "enabled" from "something is mapped" would take that
 * away.
 *
 * A project mapped to two boards — which the unique index permits, since it is
 * unique on (provider, group) rather than on the project — is collected ONCE.
 * The kinds are unioned so neither board loses a section.
 *
 * The cadence is resolved the matching way, as a MIN across the same boards, and
 * the consequence is worth naming rather than discovering: the eager board's
 * cadence is subsidised by the frugal one, because there is one collection and
 * it has to satisfy the board that asked for the most. That is fine while
 * budgets are per organisation. It stops being fine the day anyone bills per
 * board. A board with no opinion contributes nothing to the min and falls back
 * to the descriptor's own default.
 *
 * @param {string} provider
 * @returns {Promise<Array<{project: Object, kinds: string[],
 *   intervalHours: number|null}>>}
 */
const scheduleForProvider = async (provider) => {
  const enabled = await BoardConnector.find({ provider, enabled: true })
    // `intervalHours` is a board's optional override. A deployment whose
    // BoardConnector rows do not carry one yet reads `undefined` everywhere,
    // which is exactly "no opinion" and leaves every project on the descriptor's
    // cadence.
    .select('board kinds intervalHours')
    .lean();
  if (!enabled.length) return [];

  const kindsByBoard = new Map(
    enabled.map((row) => [String(row.board), row.kinds || []])
  );
  const intervalByBoard = new Map(
    enabled.map((row) => [String(row.board), askedInterval(row.intervalHours)])
  );

  const projects = await ConnectorProject.find({
    provider,
    board: { $in: [...kindsByBoard.keys()] },
    group: { $ne: null },
    // A project that vanished at the provider keeps its history but has nothing
    // left to collect — every call for it would be a fatal error.
    missing: { $ne: true },
  })
    .sort({ name: 1 })
    .lean();

  const byProject = new Map();
  for (const project of projects) {
    const key = String(project._id);
    const boardKinds = kindsByBoard.get(String(project.board)) || [];
    const boardInterval = intervalByBoard.get(String(project.board)) ?? null;
    if (!byProject.has(key)) {
      byProject.set(key, {
        project,
        kinds: new Set(boardKinds),
        intervalHours: boardInterval,
      });
      // An empty selection means "everything the provider offers", so a board
      // that narrowed cannot take a section away from a board that did not.
      if (!boardKinds.length) byProject.get(key).all = true;
      continue;
    }
    const entry = byProject.get(key);
    if (!boardKinds.length) entry.all = true;
    boardKinds.forEach((k) => entry.kinds.add(k));
    if (boardInterval !== null) {
      entry.intervalHours =
        entry.intervalHours === null
          ? boardInterval
          : Math.min(entry.intervalHours, boardInterval);
    }
  }

  return [...byProject.values()].map((e) => ({
    project: e.project,
    kinds: e.all ? [] : [...e.kinds],
    intervalHours: e.intervalHours,
  }));
};

module.exports = {
  collectSnapshots,
  syncAccount,
  syncProject,
  writeSnapshot,
  projectsForBoard,
  scheduleForProvider,
  // Pure, and exported because they are what the tests assert on.
  planProjectWork,
  periodKeyFrom,
  isFresh,
  askedInterval,
  dayKey,
};
