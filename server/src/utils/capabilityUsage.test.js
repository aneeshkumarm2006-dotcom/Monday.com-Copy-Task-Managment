/**
 * capabilityUsage.test.js — the typo guard.
 *
 * Every capability is a bare string passed to `can('…')`. A typo does not throw,
 * does not warn, and does not fail a build: it just returns false, forever, for
 * everyone. That is a permission bug that looks exactly like correct fail-closed
 * behaviour, which is the worst kind to hunt.
 *
 * So: scan the source for every capability-shaped string literal actually passed
 * to can()/requireCapability(), and assert each one exists in the catalog.
 *
 * Also loads every module in the app, which catches the class of error that the
 * migration kept producing — a controller importing a symbol that no longer
 * exists, or a circular require.
 *
 * Run from the server directory:
 *     node --test src/utils/capabilityUsage.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { ALL_CAPABILITIES } = require('./capabilities');

const SRC = path.join(__dirname, '..');
const KNOWN = new Set(ALL_CAPABILITIES);

/** Every .js file under src/, excluding tests. */
const walk = (dir) => {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
      out.push(full);
    }
  }
  return out;
};

const FILES = walk(SRC);

test('every capability passed to can()/requireCapability() exists in the catalog', () => {
  // Matches: can('x.y')  ctx.can('x.y')  access.can('x.y')
  //          requireCapability(ctx, 'x.y')  requireCapability('x.y')
  const patterns = [
    /\bcan\(\s*'([a-z_]+\.[a-z_]+)'/g,
    /requireCapability\(\s*(?:[A-Za-z_.]+\s*,\s*)?'([a-z_]+\.[a-z_]+)'/g,
  ];

  const bad = [];
  for (const file of FILES) {
    const src = fs.readFileSync(file, 'utf8');
    for (const pattern of patterns) {
      for (const m of src.matchAll(pattern)) {
        const cap = m[1];
        if (!KNOWN.has(cap)) {
          bad.push(`${path.relative(SRC, file)}: can('${cap}') — not a capability`);
        }
      }
    }
  }

  assert.deepEqual(
    bad,
    [],
    `Unknown capability string(s) — these silently deny forever:\n  ${bad.join('\n  ')}`
  );
});

test('every capability in the catalog is actually used somewhere', () => {
  // The inverse smell: a capability nobody enforces is a checkbox in the matrix
  // that does nothing, which is worse than no checkbox at all — it is a promise
  // the server does not keep.
  const corpus = FILES.filter((f) => !f.includes('capabilities.js'))
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n');

  const unused = ALL_CAPABILITIES.filter((cap) => !corpus.includes(`'${cap}'`));

  assert.deepEqual(
    unused,
    [],
    `Capability declared but never enforced anywhere:\n  ${unused.join('\n  ')}`
  );
});

test('every module loads — no dangling imports or cycles', () => {
  const failed = [];
  for (const file of FILES) {
    // Skipped, and none of them carry permission logic:
    //   config/       — passport throws without Google OAuth env vars
    //   routes/auth   — requires config/passport transitively, same reason
    //   routes/portal — requires config/passport (client Google sign-in), same reason
    //   scripts/      — migrations connect to Mongo and RUN on import
    //   app/server    — boot the whole express app
    if (file.includes(`config${path.sep}`)) continue;
    if (file.includes(`scripts${path.sep}`)) continue;
    if (file.endsWith(`routes${path.sep}auth.js`)) continue;
    if (file.endsWith(`routes${path.sep}portal.js`)) continue;
    if (file.endsWith('app.js') || file.endsWith('server.js')) continue;
    try {
      require(file);
    } catch (err) {
      failed.push(`${path.relative(SRC, file)}: ${err.message}`);
    }
  }
  assert.deepEqual(failed, [], `Modules failed to load:\n  ${failed.join('\n  ')}`);
});

// ---------------------------------------------------------------------------
// goal.create — the rung between reporting a result and rewriting a target
// ---------------------------------------------------------------------------

const capsFor = (level) => new Set(require('./capabilities').capabilitiesForLevel(level));

test('goal.create is conferred by contribute, so the default board rung can add goals', () => {
  const caps = require('./capabilities');
  assert.ok(
    capsFor('contribute').has('goal.create'),
    'contribute must confer goal.create — it is the default publicDefaultLevel, '
    + 'and without it an executive can report a result but not write down a target'
  );
  assert.ok(capsFor('edit').has('goal.create'), 'edit must confer it too');
  assert.ok(!capsFor('view').has('goal.create'), 'view must not');
  assert.ok(!capsFor('comment').has('goal.create'), 'comment must not');
  // The point of the split: adding is NOT rewriting anyone's.
  assert.ok(
    !capsFor('contribute').has('goal.manage'),
    'contribute must NOT confer goal.manage — reshaping anyone\'s goal stays on edit'
  );
  assert.ok(capsFor('edit').has('goal.manage'));
  assert.ok(caps.BOARD_SCOPED.has('goal.create'), 'must be board-scoped like its siblings');
});

/**
 * Board-scoping a capability no rung confers strips it from everyone but the
 * board's creator — the trap capabilities.js warns about beside BOARD_SCOPED.
 */
test('every board-scoped goal capability is conferred by some rung', () => {
  const caps = require('./capabilities');
  const conferred = new Set();
  for (const level of caps.BOARD_LEVELS) {
    for (const c of caps.capabilitiesForLevel(level)) conferred.add(c);
  }
  for (const c of [...caps.BOARD_SCOPED].filter((k) => k.startsWith('goal.'))) {
    assert.ok(conferred.has(c), `${c} is board-scoped but no rung confers it`);
  }
});

test('the roles that could track goals can now also add them', () => {
  const caps = require('./capabilities');
  for (const role of caps.SYSTEM_ROLES) {
    const p = role.permissions || [];
    if (!p.includes('goal.track')) continue;
    assert.ok(
      p.includes('goal.create'),
      `${role.name} can fill in a goal's result but cannot add one — the two travel together`
    );
  }
});

// ---------------------------------------------------------------------------
// IMPLIED_CAPABILITIES — the table that keeps stored roles honest
// ---------------------------------------------------------------------------

test('every capability named in the implication table is a real capability', () => {
  // Same trap as the typo guard above, one level deeper: a misspelt key here
  // implies nothing, silently, for everyone.
  const { IMPLIED_CAPABILITIES } = require('./capabilities');
  for (const [holder, implied] of Object.entries(IMPLIED_CAPABILITIES)) {
    assert.ok(KNOWN.has(holder), `${holder} implies things but is not a capability`);
    for (const c of implied) {
      assert.ok(KNOWN.has(c), `${holder} implies ${c}, which is not a capability`);
      assert.notEqual(c, holder, `${holder} must not imply itself`);
    }
  }
});

test('expandImplied terminates, and only ever adds', () => {
  const { expandImplied, ALL_CAPABILITIES: all } = require('./capabilities');
  // A cycle in the table would spin the fixed-point loop forever; the whole
  // catalog at once is the worst case and must still come back unchanged.
  const everything = expandImplied(all);
  assert.equal(everything.size, all.length, 'the full catalog implies nothing new');

  const one = expandImplied(['goal.manage']);
  assert.ok(one.has('goal.manage'), 'the input survives');
  assert.ok(one.has('goal.create'));
  assert.equal(expandImplied([]).size, 0, 'nothing in, nothing out');
});

test('an implied capability is conferred by the same board rung as its holder', () => {
  // The expansion happens on the ORG layer only. If a rung conferred
  // `goal.manage` without also conferring what it implies, the AND would strip
  // the implication straight back out and this fix would look like it worked
  // everywhere except the board.
  const caps = require('./capabilities');
  for (const [holder, implied] of Object.entries(caps.IMPLIED_CAPABILITIES)) {
    for (const level of caps.BOARD_LEVELS) {
      const set = caps.capabilitiesForLevel(level);
      if (!set.has(holder)) continue;
      for (const c of implied) {
        assert.ok(set.has(c), `${level} confers ${holder} but not ${c}, which it implies`);
      }
    }
  }
});
