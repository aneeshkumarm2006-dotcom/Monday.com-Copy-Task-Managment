const test = require('node:test');
const assert = require('node:assert/strict');

const B = require('./budget');
const ConnectorBudget = require('../../models/ConnectorBudget');

/**
 * The money gate.
 *
 * ---- What is actually being defended here ----------------------------------
 *
 * DataForSEO bills AT POST. There is no refund, no cancel and no "are you sure",
 * so the only place a spending mistake can be prevented is BEFORE the HTTP call
 * — and the only thing standing there is one `findOneAndUpdate`. If that
 * operation is wrong, every other safety in this integration is decoration.
 *
 * The plan writes the wrong version out in full, labelled "WRONG. Do not ship
 * this", because it is the version everybody reaches for:
 *
 *     findOneAndUpdate(
 *       { …key, $expr: { $lte: [{ $add: ['$reservedUsd', estimate] }, '$capUsd'] } },
 *       { $inc: { reservedUsd: estimate } },
 *       { upsert: true, new: true })
 *
 * It fails open twice over, and both failures are asserted below:
 *
 *   `upsert: true` — a FAILED cap check matches no document, so Mongo builds an
 *     insert from the filter's equalities. `$expr` contributes none of them, so
 *     you get a SECOND budget document with a fresh `reservedUsd`: the cap
 *     silently resets and both racers proceed.
 *   `$add` WITHOUT `spentUsd` — a reservation moves to `spentUsd` the moment it
 *     settles, so a guard watching `reservedUsd` alone sees an empty pot after
 *     every settle and a whole month of spend escapes the ceiling.
 *
 * ---- Why the fixture implements the operators rather than mocking the answer -
 *
 * A stub that returned "allowed" or "refused" on demand would pass against both
 * the right implementation and the wrong one, which is the only thing this file
 * is for. So the fake below actually EVALUATES the `$expr` it is handed and
 * actually honours `upsert`, and the assertions are then about arithmetic and
 * about the options object — the two things the driver would have acted on.
 */

// ---------------------------------------------------------------------------
// A ConnectorBudget that behaves like the driver
// ---------------------------------------------------------------------------

const ORG = 'org-1';
const BOARD = 'board-1';
const PERIOD = '2026-08';

const same = (a, b) => String(a) === String(b);

/**
 * Evaluate the one aggregation expression this file's guard uses.
 *
 * Deliberately narrow: `$lte` over `$add` over field paths and literals, and
 * nothing else. A general expression evaluator would be a second implementation
 * to get wrong, and would also happily evaluate a guard that had drifted into a
 * shape Mongo could not run.
 */
const evalExpr = (expr, doc) => {
  const value = (operand) => {
    if (typeof operand === 'number') return operand;
    if (typeof operand === 'string' && operand.startsWith('$')) {
      return Number(doc[operand.slice(1)] || 0);
    }
    if (operand && typeof operand === 'object' && Array.isArray(operand.$add)) {
      return operand.$add.reduce((sum, part) => sum + value(part), 0);
    }
    throw new Error(`the fixture cannot evaluate ${JSON.stringify(operand)}`);
  };

  if (!expr?.$lte) throw new Error('the guard is not an $lte — read the header');
  const [left, right] = expr.$lte;
  return value(left) <= value(right);
};

const stubBudgets = () => {
  const rows = [];
  /** Every call, so the SHAPE of the operation can be asserted, not only its effect. */
  const calls = { updateOne: [], findOneAndUpdate: [] };

  const keyOf = (f) =>
    [f.organisation, f.provider, f.scope, f.scopeId, f.periodKey].map(String).join('|');
  const find = (f) => rows.find((r) => same(keyOf(r), keyOf(f))) || null;

  const apply = (row, update) => {
    for (const [k, v] of Object.entries(update.$set || {})) row[k] = v;
    for (const [k, v] of Object.entries(update.$inc || {})) row[k] = (row[k] || 0) + v;
  };

  const originals = {
    updateOne: ConnectorBudget.updateOne,
    findOneAndUpdate: ConnectorBudget.findOneAndUpdate,
    findOne: ConnectorBudget.findOne,
  };

  ConnectorBudget.updateOne = async (filter, update, opts = {}) => {
    calls.updateOne.push({ filter, update, opts });
    const row = find(filter);
    if (!row) {
      if (!opts.upsert) return { acknowledged: true, matchedCount: 0 };
      const created = {
        organisation: filter.organisation,
        provider: filter.provider,
        scope: filter.scope,
        scopeId: filter.scopeId,
        periodKey: filter.periodKey,
        reservedUsd: 0,
        spentUsd: 0,
        releasedUsd: 0,
        capUsd: 0,
        ...(update.$setOnInsert || {}),
      };
      apply(created, { $set: update.$set, $inc: update.$inc });
      rows.push(created);
      return { acknowledged: true, upsertedCount: 1 };
    }
    apply(row, update);
    return { acknowledged: true, matchedCount: 1 };
  };

  ConnectorBudget.findOneAndUpdate = (filter, update, opts = {}) => {
    calls.findOneAndUpdate.push({ filter, update, opts });

    const { $expr, ...key } = filter;
    let row = find(key);

    const passes = row ? evalExpr($expr, row) : false;

    if (!passes && opts.upsert) {
      /**
       * THE FAILURE MODE THE TWO-STEP SPLIT EXISTS TO PREVENT, reproduced
       * exactly. A failed `$expr` matches nothing, so an upserting update
       * inserts from the filter's equalities — and a second row for the same
       * period is a second, empty ceiling.
       */
      row = {
        ...key,
        reservedUsd: 0,
        spentUsd: 0,
        releasedUsd: 0,
        capUsd: 0,
      };
      apply(row, update);
      rows.push(row);
      const created = { ...row };
      return { lean: async () => created, then: (r) => Promise.resolve(created).then(r) };
    }

    if (!passes) {
      return { lean: async () => null, then: (r) => Promise.resolve(null).then(r) };
    }

    apply(row, update);
    const value = { ...row };
    return { lean: async () => value, then: (r) => Promise.resolve(value).then(r) };
  };

  ConnectorBudget.findOne = (filter) => {
    const value = find(filter);
    return { lean: async () => value, then: (r) => Promise.resolve(value).then(r) };
  };

  return {
    rows,
    calls,
    restore: () => Object.assign(ConnectorBudget, originals),
  };
};

const orgScope = (capUsd = 5) => ({
  organisation: ORG,
  provider: 'dataforseo',
  scope: 'org',
  scopeId: ORG,
  periodKey: PERIOD,
  capUsd,
});

const boardScope = (capUsd = 2) => ({
  organisation: ORG,
  provider: 'dataforseo',
  scope: 'board',
  scopeId: BOARD,
  periodKey: PERIOD,
  capUsd,
});

// ---------------------------------------------------------------------------
// 1. The two-step separation
// ---------------------------------------------------------------------------

test('the guarded reserve NEVER upserts — that is what makes null mean one thing', async () => {
  const db = stubBudgets();
  try {
    await B.ensureBudget(orgScope(5));
    // Spend the cap, then ask for more. The refusal must produce NO document.
    await B.reserve({ ...orgScope(5), estimateUsd: 5 });
    const refused = await B.reserve({ ...orgScope(5), estimateUsd: 0.01 });

    assert.equal(refused, null, 'a refusal is a null');
    assert.equal(db.rows.length, 1, 'AND NOT A SECOND BUDGET DOCUMENT');

    // The proof is on the call itself, not only on the outcome: a future edit
    // that added `upsert: true` back would still pass a behavioural assertion
    // against a fixture that did not honour it.
    for (const call of db.calls.findOneAndUpdate) {
      assert.notEqual(
        call.opts?.upsert,
        true,
        'upsert on the guarded update is the failure this whole file is about'
      );
    }
  } finally {
    db.restore();
  }
});

test('creating the period is idempotent and carries no cap logic', async () => {
  const db = stubBudgets();
  try {
    await B.ensureBudget(orgScope(5));
    await B.reserve({ ...orgScope(5), estimateUsd: 3 });
    // A second pass in the same month calls ensure again.
    await B.ensureBudget(orgScope(5));

    assert.equal(db.rows.length, 1);
    assert.equal(
      db.rows[0].reservedUsd,
      3,
      '$setOnInsert must not reset a counter that is already holding money'
    );

    for (const call of db.calls.updateOne) {
      assert.equal(
        JSON.stringify(call.filter).includes('$expr'),
        false,
        'the existence step carries no guard, which is why its E11000 is unambiguous'
      );
    }
  } finally {
    db.restore();
  }
});

test('a concurrent creator winning the race is swallowed; any other error is not', async () => {
  const db = stubBudgets();
  const original = ConnectorBudget.updateOne;
  try {
    ConnectorBudget.updateOne = async () => {
      const err = new Error('E11000 duplicate key error');
      err.code = 11000;
      throw err;
    };
    await B.ensureBudget(orgScope(5)); // must not throw

    ConnectorBudget.updateOne = async () => {
      throw new Error('the disk is on fire');
    };
    await assert.rejects(() => B.ensureBudget(orgScope(5)), /disk is on fire/);
  } finally {
    ConnectorBudget.updateOne = original;
    db.restore();
  }
});

// ---------------------------------------------------------------------------
// 2. The `$expr` must count settled spend
// ---------------------------------------------------------------------------

test('the guard compares reserved + spent + estimate, so settled money cannot escape', async () => {
  const db = stubBudgets();
  try {
    await B.ensureBudget(orgScope(5));

    // Reserve $4.50 and settle it. `reservedUsd` returns to zero.
    await B.reserve({ ...orgScope(5), estimateUsd: 4.5 });
    await B.settle({ ...orgScope(5), estimateUsd: 4.5, actualUsd: 4.5 });
    assert.equal(db.rows[0].reservedUsd, 0);
    assert.equal(db.rows[0].spentUsd, 4.5);

    // A guard watching `reservedUsd` alone now sees an EMPTY POT and would allow
    // another $5 — $9.50 against a $5 cap, and the same again next hour.
    const tooMuch = await B.reserve({ ...orgScope(5), estimateUsd: 1 });
    assert.equal(tooMuch, null, 'settled spend still counts against the ceiling');

    const fits = await B.reserve({ ...orgScope(5), estimateUsd: 0.5 });
    assert.ok(fits, 'and what genuinely fits is still allowed through');
  } finally {
    db.restore();
  }
});

test('the guard names all three terms — asserted on the expression, not the outcome', async () => {
  const db = stubBudgets();
  try {
    await B.ensureBudget(orgScope(5));
    await B.reserve({ ...orgScope(5), estimateUsd: 1 });

    const [{ filter }] = db.calls.findOneAndUpdate;
    const add = filter.$expr.$lte[0].$add;

    assert.ok(add.includes('$reservedUsd'), 'money promised');
    assert.ok(add.includes('$spentUsd'), 'MONEY ALREADY TAKEN — the term that is easy to omit');
    assert.ok(add.includes(1), 'and what is being asked for now');
    assert.equal(filter.$expr.$lte[1], '$capUsd');
  } finally {
    db.restore();
  }
});

// ---------------------------------------------------------------------------
// 3. Settle is unguarded on purpose
// ---------------------------------------------------------------------------

test('settle records an overshoot rather than refusing it — the money is already gone', async () => {
  const db = stubBudgets();
  try {
    await B.ensureBudget(orgScope(5));
    await B.reserve({ ...orgScope(5), estimateUsd: 4 });

    // DataForSEO charged more than the price book predicted. Refusing to write
    // that down would not un-spend it; it would only mean the ledger no longer
    // knows what the account is worth.
    await B.settle({ ...orgScope(5), estimateUsd: 4, actualUsd: 6.25 });

    assert.equal(db.rows[0].reservedUsd, 0);
    assert.equal(db.rows[0].spentUsd, 6.25, 'the overshoot is RECORDED');
    assert.ok(db.rows[0].spentUsd > db.rows[0].capUsd, 'and it is over the cap, honestly');

    // And the NEXT reserve is the one that stops.
    assert.equal(await B.reserve({ ...orgScope(5), estimateUsd: 0.01 }), null);
  } finally {
    db.restore();
  }
});

// ---------------------------------------------------------------------------
// 4. Two documents, no transaction
// ---------------------------------------------------------------------------

test('a board refusal rolls the ORG reservation back — compensation, not a transaction', async () => {
  const db = stubBudgets();
  try {
    const scopes = [orgScope(100), boardScope(2)];

    const first = await B.reserveAll({ scopes, estimateUsd: 1.5 });
    assert.equal(first.ok, true);

    // The board has $0.50 left; the org has $98.50.
    const second = await B.reserveAll({ scopes, estimateUsd: 1.5 });
    assert.equal(second.ok, false);
    assert.equal(second.blocked.scope, 'board');

    const org = db.rows.find((r) => r.scope === 'org');
    const board = db.rows.find((r) => r.scope === 'board');

    assert.equal(
      org.reservedUsd,
      1.5,
      "THE ORG'S MONEY WENT BACK — an over-allocated board must not be able to " +
        "shrink every other board's budget by failing repeatedly"
    );
    assert.equal(board.reservedUsd, 1.5);
    assert.equal(org.releasedUsd, 1.5, 'and the rollback is recorded rather than silent');
  } finally {
    db.restore();
  }
});

test('the org is reserved FIRST and released LAST', async () => {
  const db = stubBudgets();
  try {
    await B.reserveAll({ scopes: [orgScope(100), boardScope(100)], estimateUsd: 1 });
    const order = db.calls.findOneAndUpdate.map((c) => c.filter.scope);
    assert.deepEqual(order, ['org', 'board'], 'the real ceiling is taken first');
  } finally {
    db.restore();
  }
});

test('an org refusal never even asks the board', async () => {
  const db = stubBudgets();
  try {
    const out = await B.reserveAll({
      scopes: [orgScope(0.5), boardScope(100)],
      estimateUsd: 1,
    });
    assert.equal(out.ok, false);
    assert.equal(out.blocked.scope, 'org');
    assert.equal(
      db.rows.some((r) => r.scope === 'board' && r.reservedUsd > 0),
      false
    );
  } finally {
    db.restore();
  }
});

// ---------------------------------------------------------------------------
// 5. `reservedUsd` is a recomputable cache
// ---------------------------------------------------------------------------

test('recomputeReserved rewrites the counter from an authoritative sum', async () => {
  const db = stubBudgets();
  try {
    await B.ensureBudget(orgScope(100));
    await B.reserve({ ...orgScope(100), estimateUsd: 7 });

    // A process died holding $7 and the row that held it has been swept. The
    // counter is now a lie, and the field is documented as a CACHE precisely so
    // that this is a repair rather than an inconsistency nobody can resolve.
    await B.recomputeReserved({ ...orgScope(100), outstandingUsd: 0 });
    assert.equal(db.rows[0].reservedUsd, 0);
    assert.ok(db.rows[0].lastRecomputeAt instanceof Date);

    // A negative sum is a bug upstream, and clamping is the failure mode that
    // does not hand a caller a budget with more money than its cap.
    await B.recomputeReserved({ ...orgScope(100), outstandingUsd: -3 });
    assert.equal(db.rows[0].reservedUsd, 0);
  } finally {
    db.restore();
  }
});

test('release gives money back and says so', async () => {
  const db = stubBudgets();
  try {
    await B.ensureBudget(orgScope(10));
    await B.reserve({ ...orgScope(10), estimateUsd: 4 });
    await B.release({ ...orgScope(10), estimateUsd: 4 });

    assert.equal(db.rows[0].reservedUsd, 0);
    assert.equal(db.rows[0].releasedUsd, 4);
    assert.equal(db.rows[0].spentUsd, 0, 'a release is not a charge');
  } finally {
    db.restore();
  }
});

// ---------------------------------------------------------------------------
// 6. The month key, and display
// ---------------------------------------------------------------------------

test('the period is a UTC MONTH, and the last hour of the month stays in it', () => {
  assert.equal(B.monthKeyFor(new Date('2026-08-31T23:59:59Z')), '2026-08');
  assert.equal(B.monthKeyFor(new Date('2026-09-01T00:00:00Z')), '2026-09');
  assert.equal(B.monthKeyFor(new Date('2026-01-05T12:00:00Z')), '2026-01', 'zero-padded');
});

test('describeBudget is arithmetic for a person, never a gate', async () => {
  const db = stubBudgets();
  try {
    await B.ensureBudget(orgScope(100));
    await B.reserve({ ...orgScope(100), estimateUsd: 20 });
    await B.settle({ ...orgScope(100), estimateUsd: 20, actualUsd: 18 });
    await B.reserve({ ...orgScope(100), estimateUsd: 12 });

    const shown = await B.describeBudget(orgScope(100));
    assert.equal(shown.spentUsd, 18);
    assert.equal(shown.reservedUsd, 12);
    assert.equal(shown.committedUsd, 30);
    assert.equal(shown.remainingUsd, 70);
    assert.equal(shown.usedPct, 30);

    assert.equal(await B.describeBudget(boardScope(1)), null, 'no row is not a zero budget');
  } finally {
    db.restore();
  }
});

test('money is rounded to the millionth, which is the unit DataForSEO bills in', async () => {
  const db = stubBudgets();
  try {
    await B.ensureBudget(orgScope(100));
    // 200 keywords x depth 100 x $0.0006 lands on a value floating point will
    // otherwise carry a tail on, and a cap comparison against a tail is a cap
    // that is off by a fraction of a cent in an unpredictable direction.
    await B.reserve({ ...orgScope(100), estimateUsd: 0.1 + 0.2 });
    assert.equal(db.rows[0].reservedUsd, 0.3);
  } finally {
    db.restore();
  }
});
