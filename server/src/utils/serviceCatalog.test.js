const test = require('node:test');
const assert = require('node:assert');

const {
  MAX_SERVICE_NAME,
  SERVICE_PALETTE,
  normaliseServiceName,
  serviceSlug,
  colorForSlug,
} = require('./serviceCatalog');

/**
 * The slug rule is the whole idempotency of the service catalog: the
 * `(organisation, slug)` unique index can only collapse "Meta Ads" and
 * "meta ads" into one entry if they slug the same, and nothing else in the
 * codebase is allowed to produce a slug. So these are the tests that stop the
 * catalog filling up with near-duplicates.
 */

test('names that differ only in case or spacing are ONE service', () => {
  const spellings = ['Meta Ads', 'meta ads', 'META ADS', '  Meta   Ads  ', 'meta-ads', 'Meta  -  Ads'];
  const slugs = new Set(spellings.map(serviceSlug));
  assert.strictEqual(slugs.size, 1, `expected one slug, got ${[...slugs].join(', ')}`);
  assert.strictEqual([...slugs][0], 'meta-ads');
});

test('slugging is stable for the services this was built for', () => {
  assert.strictEqual(serviceSlug('SEO'), 'seo');
  assert.strictEqual(serviceSlug('Google Ads'), 'google-ads');
  assert.strictEqual(serviceSlug('Web Development'), 'web-development');
  assert.strictEqual(serviceSlug('Email Marketing'), 'email-marketing');
});

test('a name with nothing sluggable in it returns null, not an empty string', () => {
  // The caller must refuse these. An empty string would be a legal value for a
  // `required` field and would key every punctuation-only name to one entry.
  for (const raw of ['', '   ', '!!!', '---', '???', '\t\n', '@#$%^&*()']) {
    assert.strictEqual(serviceSlug(raw), null, `expected null for ${JSON.stringify(raw)}`);
  }
});

test('non-strings are refused rather than coerced', () => {
  for (const raw of [undefined, null, 42, {}, [], true]) {
    assert.strictEqual(serviceSlug(raw), null);
    assert.strictEqual(normaliseServiceName(raw), '');
  }
});

test('the clamp trims AFTER slicing, so a cut never leaves a trailing space', () => {
  // Slicing at 60 can land in the middle of a gap. Without the second trim this
  // returns "aaa… " and reads as a different name from the same one typed short.
  const name = `${'a'.repeat(MAX_SERVICE_NAME - 2)}  bb`;
  const out = normaliseServiceName(name);
  assert.strictEqual(out, 'a'.repeat(MAX_SERVICE_NAME - 2));
  assert.strictEqual(out, out.trim());
  assert.ok(out.length <= MAX_SERVICE_NAME);
});

test('a name longer than the cap still slugs, and stays within the cap', () => {
  const out = serviceSlug('S'.repeat(200));
  assert.strictEqual(out.length, MAX_SERVICE_NAME);
});

test('MAX_SERVICE_NAME matches the group-name cap it feeds', () => {
  // A service name BECOMES a group name. If these ever diverge, a catalog entry
  // is accepted and then silently truncated by resolveGroupName.
  const groupController = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'controllers', 'groupController.js'),
    'utf8'
  );
  const m = groupController.match(/MAX_GROUP_NAME\s*=\s*(\d+)/);
  assert.ok(m, 'could not find MAX_GROUP_NAME in groupController.js');
  assert.strictEqual(Number(m[1]), MAX_SERVICE_NAME);
});

test('colorForSlug is deterministic and always a palette member', () => {
  for (const slug of ['seo', 'meta-ads', 'google-ads', 'web-development', 'x', '']) {
    const a = colorForSlug(slug);
    assert.strictEqual(a, colorForSlug(slug), 'same slug must give the same colour');
    assert.ok(SERVICE_PALETTE.includes(a), `${a} is not in the palette`);
  }
  assert.ok(SERVICE_PALETTE.includes(colorForSlug(undefined)));
  assert.ok(SERVICE_PALETTE.includes(colorForSlug(null)));
});

test('the palette is all distinct 6-digit hex', () => {
  assert.strictEqual(new Set(SERVICE_PALETTE).size, SERVICE_PALETTE.length);
  for (const c of SERVICE_PALETTE) assert.match(c, /^#[0-9A-F]{6}$/);
});
