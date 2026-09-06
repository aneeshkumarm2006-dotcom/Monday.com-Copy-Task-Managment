const test = require('node:test');
const assert = require('node:assert');

const { MAX_ROWS, planInvites } = require('./portalBatchInvite');

/**
 * The dedupe rule, which IS the batch-invite feature.
 *
 * This is the only place it gets a test that runs in `npm test`: everything
 * around it needs a database, and the rule itself does not. The scenario in the
 * first two tests is verbatim the one the feature was asked for — an agency
 * running four disciplines for one client, where two of them share a manager.
 */

const asha = 'asha@acme.com';
const raj = 'raj@acme.com';

test('four rows, ONE address: one contact holding all four services', () => {
  const plan = planInvites([
    { service: 'SEO', email: asha },
    { service: 'Meta Ads', email: asha },
    { service: 'Google Ads', email: asha },
    { service: 'Web Development', email: asha },
  ]);

  assert.strictEqual(plan.ok, true, JSON.stringify(plan.errors));
  assert.strictEqual(plan.services.length, 4, 'four groups should be created');
  assert.strictEqual(plan.contacts.length, 1, 'one address means ONE email');
  assert.deepStrictEqual(plan.contacts[0].slugs, [
    'seo',
    'meta-ads',
    'google-ads',
    'web-development',
  ]);
  assert.deepStrictEqual(plan.contacts[0].rowIndexes, [0, 1, 2, 3]);
});

test('four rows, FOUR addresses: four contacts with one service each', () => {
  const plan = planInvites([
    { service: 'SEO', email: 'a@acme.com' },
    { service: 'Meta Ads', email: 'b@acme.com' },
    { service: 'Google Ads', email: 'c@acme.com' },
    { service: 'Web Development', email: 'd@acme.com' },
  ]);

  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.services.length, 4);
  assert.strictEqual(plan.contacts.length, 4, 'four addresses means FOUR emails');
  for (const c of plan.contacts) assert.strictEqual(c.slugs.length, 1);
});

test('the mixed case: three services to one person, one to another', () => {
  const plan = planInvites([
    { service: 'SEO', email: asha },
    { service: 'Meta Ads', email: asha },
    { service: 'Google Ads', email: raj },
    { service: 'Web Development', email: asha },
  ]);

  assert.strictEqual(plan.contacts.length, 2);
  const byEmail = Object.fromEntries(plan.contacts.map((c) => [c.email, c.slugs]));
  assert.deepStrictEqual(byEmail[asha], ['seo', 'meta-ads', 'web-development']);
  assert.deepStrictEqual(byEmail[raj], ['google-ads']);
});

test('addresses are matched case- and whitespace-insensitively', () => {
  const plan = planInvites([
    { service: 'SEO', email: '  Asha@Acme.com ' },
    { service: 'Meta Ads', email: 'asha@acme.com' },
    { service: 'Google Ads', email: 'ASHA@ACME.COM' },
  ]);

  assert.strictEqual(plan.contacts.length, 1, 'one person, however they typed it');
  assert.strictEqual(plan.contacts[0].email, asha, 'stored lowercased');
  assert.strictEqual(plan.contacts[0].slugs.length, 3);
});

test('service names differing only in case are ONE service, first casing wins', () => {
  const plan = planInvites([
    { service: 'SEO', email: asha },
    { service: 'seo', email: raj },
    { service: '  Seo  ', email: 'c@acme.com' },
  ]);

  assert.strictEqual(plan.services.length, 1);
  assert.strictEqual(plan.services[0].slug, 'seo');
  assert.strictEqual(plan.services[0].name, 'SEO', 'the FIRST spelling survives');
  assert.deepStrictEqual(plan.services[0].rowIndexes, [0, 1, 2]);
  assert.strictEqual(plan.contacts.length, 3, 'one service, still three people');
});

test('password beats google when one address appears with both, and warns', () => {
  const plan = planInvites([
    { service: 'SEO', email: asha, authMethod: 'google' },
    { service: 'Meta Ads', email: asha, authMethod: 'password' },
  ]);

  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.contacts[0].authMethod, 'password',
    'someone who needs a password needs it whichever row asked');
  assert.strictEqual(plan.warnings.length, 1);
  assert.match(plan.warnings[0], /asha@acme\.com/);
  assert.match(plan.warnings[0], /password/i);

  // ...and in the other order, so it is not an artefact of which row came first.
  const reversed = planInvites([
    { service: 'SEO', email: asha, authMethod: 'password' },
    { service: 'Meta Ads', email: asha, authMethod: 'google' },
  ]);
  assert.strictEqual(reversed.contacts[0].authMethod, 'password');
  assert.strictEqual(reversed.warnings.length, 1);
});

test('a consistent sign-in method produces NO warning', () => {
  const plan = planInvites([
    { service: 'SEO', email: asha, authMethod: 'password' },
    { service: 'Meta Ads', email: asha, authMethod: 'password' },
  ]);
  assert.deepStrictEqual(plan.warnings, []);
  assert.strictEqual(plan.contacts[0].authMethod, 'password');
});

test('authMethod defaults to google when absent', () => {
  const plan = planInvites([{ service: 'SEO', email: asha }]);
  assert.strictEqual(plan.contacts[0].authMethod, 'google');
});

/**
 * A DEFAULT IS NOT A CHOICE.
 *
 * The write side uses this flag to decide whether it may change how somebody
 * already signs in. Getting it wrong is not a cosmetic bug: a defaulted 'google'
 * landing on a client who has set a password locks them out of the portal
 * permanently, and every recovery path answers reassuringly while doing nothing.
 * See `upsertContactRow`.
 */
test('a row that names no sign-in method is DEFAULTED, not chosen', () => {
  const plan = planInvites([{ service: 'SEO', email: asha }]);
  assert.strictEqual(plan.contacts[0].authMethodExplicit, false);
});

test('a row that names one IS a choice, whichever one it names', () => {
  assert.strictEqual(
    planInvites([{ service: 'SEO', email: asha, authMethod: 'google' }]).contacts[0]
      .authMethodExplicit,
    true
  );
  assert.strictEqual(
    planInvites([{ service: 'SEO', email: asha, authMethod: 'password' }]).contacts[0]
      .authMethodExplicit,
    true
  );
});

test('one explicit row among several makes the whole person a choice', () => {
  const plan = planInvites([
    { service: 'SEO', email: asha },
    { service: 'Meta Ads', email: asha, authMethod: 'password' },
  ]);
  assert.strictEqual(plan.contacts[0].authMethodExplicit, true);
  assert.strictEqual(plan.contacts[0].authMethod, 'password');

  // ...and the other order, so it is not an artefact of which row came first.
  const reversed = planInvites([
    { service: 'SEO', email: asha, authMethod: 'password' },
    { service: 'Meta Ads', email: asha },
  ]);
  assert.strictEqual(reversed.contacts[0].authMethodExplicit, true);
});

test('a sign-in method nobody can use is not a choice either', () => {
  const plan = planInvites([{ service: 'SEO', email: asha, authMethod: 'carrier-pigeon' }]);
  assert.strictEqual(plan.ok, false, 'the batch is refused whole');
  assert.strictEqual(plan.contacts[0].authMethodExplicit, false);
  assert.strictEqual(plan.contacts[0].authMethod, 'google');
});

test('a bad row reports its INDEX, so the UI can mark that table row', () => {
  const plan = planInvites([
    { service: 'SEO', email: asha },
    { service: 'Meta Ads', email: 'not-an-email' },
    { service: '', email: raj },
    { service: 'SEO', email: raj, authMethod: 'carrier-pigeon' },
  ]);

  assert.strictEqual(plan.ok, false);
  const byIndex = {};
  for (const e of plan.errors) (byIndex[e.index] ||= []).push(e.field);
  assert.deepStrictEqual(byIndex[1], ['email']);
  assert.deepStrictEqual(byIndex[2], ['service']);
  assert.deepStrictEqual(byIndex[3], ['authMethod']);
  assert.strictEqual(byIndex[0], undefined, 'the good row reports nothing');
});

test('a service name with nothing sluggable in it is refused, not stored empty', () => {
  const plan = planInvites([{ service: '!!!', email: asha }]);
  assert.strictEqual(plan.ok, false);
  assert.strictEqual(plan.errors[0].field, 'service');
});

test('an empty or oversized batch is refused whole', () => {
  assert.strictEqual(planInvites([]).ok, false);
  assert.strictEqual(planInvites(null).ok, false);
  assert.strictEqual(planInvites(undefined).ok, false);
  assert.strictEqual(planInvites('rows').ok, false);

  const tooMany = Array.from({ length: MAX_ROWS + 1 }, (_, i) => ({
    service: 'SEO',
    email: `p${i}@acme.com`,
  }));
  const plan = planInvites(tooMany);
  assert.strictEqual(plan.ok, false);
  assert.match(plan.errors[0].message, /Too many rows/);

  // ...and exactly at the cap is fine.
  assert.strictEqual(planInvites(tooMany.slice(0, MAX_ROWS)).ok, true);
});

test('validation is ALL-OR-NOTHING: one bad row yields no plan at all', () => {
  // Half-applying a table the user is still editing leaves them unable to tell
  // which rows landed, and re-submitting would then double the ones that did.
  const plan = planInvites([
    { service: 'SEO', email: asha },
    { service: 'Meta Ads', email: 'nope' },
  ]);
  assert.strictEqual(plan.ok, false);
  assert.ok(plan.errors.length > 0);
});

test('rows are tolerated when null or missing fields, without throwing', () => {
  const plan = planInvites([null, {}, { service: 'SEO' }, { email: asha }]);
  assert.strictEqual(plan.ok, false);
  assert.ok(plan.errors.length >= 4);
});

test('a per-row colour is carried for the service that mints the catalog entry', () => {
  const plan = planInvites([{ service: 'SEO', email: asha, color: '#123456' }]);
  assert.strictEqual(plan.services[0].color, '#123456');
  // ...and a blank one stays null so colorForSlug decides.
  assert.strictEqual(planInvites([{ service: 'SEO', email: asha, color: '  ' }]).services[0].color, null);
});
