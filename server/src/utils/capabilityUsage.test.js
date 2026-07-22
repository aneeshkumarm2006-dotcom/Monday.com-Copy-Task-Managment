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
