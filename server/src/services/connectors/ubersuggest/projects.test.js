const test = require('node:test');
const assert = require('node:assert/strict');

const {
  listProjects,
  describeAccount,
  unwrapProjectList,
  normaliseProject,
  normaliseLocations,
  countOf,
} = require('./projects');

/**
 * These tests exist because the project tools are the ONE part of `llms.md` with
 * no response table. Every other tool documents its fields; the Projects section
 * says only "Returns the raw Ubersuggest API payload for this report (fields
 * defined by the backend)".
 *
 * So the normaliser is written against plausible spellings rather than a known
 * schema, and these cases are the specification of what "plausible" was taken to
 * mean. When the first authenticated call lands and the real shape is on record,
 * this file is where it gets pinned — add the observed shape as a case, do not
 * replace the tolerance with it.
 */

const stubClient = (result) => () => ({ callTool: async () => result });

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

test('the project array is found whatever it is wrapped in', () => {
  const rows = [{ id: '1' }];
  assert.deepEqual(unwrapProjectList(rows), rows);
  assert.deepEqual(unwrapProjectList({ projects: rows }), rows);
  assert.deepEqual(unwrapProjectList({ data: rows }), rows);
  assert.deepEqual(unwrapProjectList({ results: rows }), rows);
  // One level deeper — a shape this API uses elsewhere.
  assert.deepEqual(unwrapProjectList({ data: { projects: rows } }), rows);
});

test('an envelope with no list in it is empty, not an error', () => {
  assert.deepEqual(unwrapProjectList(null), []);
  assert.deepEqual(unwrapProjectList('nope'), []);
  assert.deepEqual(unwrapProjectList({ message: 'no projects' }), []);
});

// ---------------------------------------------------------------------------
// One project
// ---------------------------------------------------------------------------

test('a project is read through the documented snake_case spellings', () => {
  // `project_id`, `loc_id`, `lang` and `has_brand` are the spellings the
  // DOCUMENTED tools use, so they are the ones tried first.
  const project = normaliseProject({
    project_id: 5512,
    domain: 'davnoot.com',
    title: 'Davnoot',
    has_brand: true,
    keywords: { 'seo agency': [{ lang: 'en', loc_id: 2840 }] },
    competitors: { 'rival.com': [{ lang: 'en', loc_id: 2840 }] },
    locations: [{ loc_id: 2840, lang: 'en', label: 'United States' }],
  });

  assert.equal(project.externalId, '5512'); // a string even when sent a number
  assert.equal(project.domain, 'davnoot.com');
  assert.equal(project.name, 'Davnoot');
  assert.equal(project.hasBrand, true);
  assert.equal(project.keywordCount, 1);
  assert.equal(project.competitorCount, 1);
  assert.deepEqual(project.locations, [
    { locId: 2840, lang: 'en', label: 'United States' },
  ]);
});

test('camelCase spellings are accepted behind the snake_case ones', () => {
  const project = normaliseProject({
    projectId: 'abc',
    website: 'example.com',
    projectName: 'Example',
    hasBrand: true,
    keywordCount: 40,
  });
  assert.equal(project.externalId, 'abc');
  assert.equal(project.domain, 'example.com');
  assert.equal(project.name, 'Example');
  assert.equal(project.hasBrand, true);
  assert.equal(project.keywordCount, 40);
});

test('an untitled project falls back to its domain, then to its id', () => {
  // One Ubersuggest project is one domain, and the provider titles it after the
  // domain by default — so the domain is the name a human recognises.
  assert.equal(normaliseProject({ id: '1', domain: 'a.com' }).name, 'a.com');
  assert.equal(normaliseProject({ id: '9' }).name, '9');
});

test('a project with no id is dropped', () => {
  // Unaddressable: nothing downstream could ever fetch for it, so mirroring it
  // would put an unmappable row in the picker.
  assert.equal(normaliseProject({ domain: 'a.com' }), null);
  assert.equal(normaliseProject(null), null);
  assert.equal(normaliseProject('nonsense'), null);
});

test('the raw payload is kept verbatim on every project', () => {
  // The whole point of doing this phase first. A field the normaliser failed to
  // anticipate must be recoverable without re-syncing every account.
  const raw = { id: '1', domain: 'a.com', something_we_did_not_predict: [1, 2, 3] };
  assert.deepEqual(normaliseProject(raw).raw, raw);
});

// ---------------------------------------------------------------------------
// Counts and locales
// ---------------------------------------------------------------------------

test('a count reads an array, a keyed map, or a number already counted', () => {
  // create_project documents `keywords` as a MAP of phrase to locales, so the
  // map branch is the documented shape rather than a hypothetical one.
  assert.equal(countOf(['a', 'b']), 2);
  assert.equal(countOf({ a: [], b: [], c: [] }), 3);
  assert.equal(countOf(17), 17);
  assert.equal(countOf(null), null);
  assert.equal(countOf('twelve'), null);
});

test('locales are de-duplicated by (locId, lang)', () => {
  // project_position_info filters by ONE lang/location pair and refuses any
  // combination the project does not track, so duplicates would offer phase 3 a
  // choice that is not really a choice.
  const out = normaliseLocations([
    { loc_id: 2840, lang: 'en' },
    { loc_id: 2840, lang: 'en' },
    { loc_id: 2840, lang: 'es' },
  ]);
  assert.equal(out.length, 2);
});

test('a bare location id is still a location', () => {
  assert.deepEqual(normaliseLocations([2840]), [
    { locId: 2840, lang: null, label: '2840' },
  ]);
});

test('locations keyed by id rather than listed still resolve', () => {
  const out = normaliseLocations({ us: { loc_id: 2840, lang: 'en', name: 'US' } });
  assert.deepEqual(out, [{ locId: 2840, lang: 'en', label: 'US' }]);
});

// ---------------------------------------------------------------------------
// listProjects
// ---------------------------------------------------------------------------

test('listProjects normalises, de-duplicates, and hands back the raw payload', async () => {
  const payload = {
    projects: [
      { id: '1', domain: 'a.com' },
      { id: '1', domain: 'a.com' }, // the provider guarantees no uniqueness
      { id: '2', domain: 'b.com' },
      { domain: 'c.com' }, // no id — dropped
    ],
  };

  const { projects, raw } = await listProjects(
    {},
    { clientFactory: stubClient({ data: payload, text: '' }) }
  );

  assert.deepEqual(
    projects.map((p) => p.externalId),
    ['1', '2']
  );
  // The whole listing is returned too, so a caller can record what arrived
  // rather than only what we understood of it.
  assert.deepEqual(raw, payload);
});

test('an account with no projects lists as empty rather than throwing', async () => {
  const { projects } = await listProjects(
    {},
    { clientFactory: stubClient({ data: { projects: [] }, text: '' }) }
  );
  assert.deepEqual(projects, []);
});

// ---------------------------------------------------------------------------
// describeAccount
// ---------------------------------------------------------------------------

test('auth_status is parsed out of the plain sentence it documents', async () => {
  // "Not JSON: 'Logged in as <email> / Tier: <tier>'" — llms.md is explicit.
  const identity = await describeAccount(
    {},
    {
      clientFactory: stubClient({
        data: 'Logged in as seo@davnoot.com / Tier: enterprise',
        text: 'Logged in as seo@davnoot.com / Tier: enterprise',
      }),
    }
  );
  assert.equal(identity.externalEmail, 'seo@davnoot.com');
  assert.equal(identity.tier, 'enterprise');
});

test('auth_status is also read if it ever starts returning JSON', async () => {
  const identity = await describeAccount(
    {},
    { clientFactory: stubClient({ data: { email: 'a@b.com', tier: 'pro' }, text: '' }) }
  );
  assert.equal(identity.externalEmail, 'a@b.com');
  assert.equal(identity.tier, 'pro');
});

test('an unrecognised auth_status sentence yields nulls, not a throw', async () => {
  // Not knowing the email is cosmetic. Failing a refresh over it is not.
  const identity = await describeAccount(
    {},
    { clientFactory: stubClient({ data: 'Not logged in', text: 'Not logged in' }) }
  );
  assert.equal(identity.externalEmail, null);
  assert.equal(identity.tier, null);
});
