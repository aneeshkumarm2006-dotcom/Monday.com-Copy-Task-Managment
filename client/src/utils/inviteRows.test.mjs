import test from 'node:test';
import assert from 'node:assert';

import {
  MAX_ROWS,
  newRow,
  serviceKeyOf,
  parsePastedInvites,
  planInvites,
  mergeResults,
} from './inviteRows.js';

/**
 * The invite table's logic, tested without a DOM.
 *
 * `serviceKeyOf` MUST agree with `serviceSlug` in
 * server/src/utils/serviceCatalog.js — they are a hand-maintained mirror pair,
 * like the two copies of chatSurfaces. When they disagree the preview promises
 * one thing and the server does another, which is worse than no preview.
 */

test('serviceKeyOf matches the server slug rule', () => {
  assert.strictEqual(serviceKeyOf('Meta Ads'), 'meta-ads');
  assert.strictEqual(serviceKeyOf('meta ads'), 'meta-ads');
  assert.strictEqual(serviceKeyOf('  META   ADS  '), 'meta-ads');
  assert.strictEqual(serviceKeyOf('SEO'), 'seo');
  assert.strictEqual(serviceKeyOf('!!!'), null);
  assert.strictEqual(serviceKeyOf(''), null);
});

test('the preview MAKES THE DEDUPE VISIBLE before anything is sent', () => {
  const rows = [
    newRow({ service: 'SEO', email: 'asha@acme.com' }),
    newRow({ service: 'Meta Ads', email: 'asha@acme.com' }),
    newRow({ service: 'Google Ads', email: 'raj@acme.com' }),
  ];
  const plan = planInvites(rows, { services: [] });

  assert.strictEqual(plan.ok, true);
  assert.deepStrictEqual(plan.servicesToCreate, ['SEO', 'Meta Ads', 'Google Ads']);
  assert.strictEqual(plan.uniqueEmails.length, 2);
  assert.match(plan.summary, /emails 2 people/);
  assert.match(plan.summary, /asha@acme\.com is on 2 rows/);
  assert.match(plan.summary, /every service/);
});

test('an existing service is reported as reused, not created again', () => {
  const rows = [newRow({ service: 'seo', email: 'a@x.com' })];
  const plan = planInvites(rows, { services: [{ name: 'SEO' }] });
  assert.deepStrictEqual(plan.servicesToCreate, []);
  assert.strictEqual(plan.servicesReused, 1);
  assert.match(plan.summary, /uses 1 you already have/);
});

test('a returning contact is flagged as additive, not replacing', () => {
  const rows = [newRow({ service: 'SEO', email: 'asha@acme.com' })];
  const plan = planInvites(rows, { services: [], existingEmails: ['ASHA@acme.com'] });
  assert.match(plan.summary, /already ha[sv]/);
  assert.match(plan.summary, /added to what they already had/);
});

test('bad rows are named by row id and block the batch', () => {
  const good = newRow({ service: 'SEO', email: 'a@x.com' });
  const badEmail = newRow({ service: 'SEO', email: 'nope' });
  const noService = newRow({ service: '', email: 'b@x.com' });

  const plan = planInvites([good, badEmail, noService], { services: [] });
  assert.strictEqual(plan.ok, false);
  assert.strictEqual(plan.rowErrors[good.id], undefined);
  assert.match(plan.rowErrors[badEmail.id], /email/i);
  assert.match(plan.rowErrors[noService.id], /service/i);
});

test('an empty table is not submittable', () => {
  assert.strictEqual(planInvites([], { services: [] }).ok, false);
});

test('a table over the cap is not submittable', () => {
  const rows = Array.from({ length: MAX_ROWS + 1 }, (_, i) =>
    newRow({ service: 'SEO', email: `p${i}@x.com` })
  );
  assert.strictEqual(planInvites(rows, { services: [] }).ok, false);
  assert.strictEqual(planInvites(rows.slice(0, MAX_ROWS), { services: [] }).ok, true);
});

test('pasting accepts the shapes people actually paste', () => {
  const { rows, skipped } = parsePastedInvites(
    [
      'a@acme.com',
      'b@acme.com, Meta Ads',
      'SEO\tc@acme.com',
      'Dana Quinn <d@acme.com>',
      'e@acme.com;Google Ads;password',
      'this line has no address',
      '',
    ].join('\n'),
    { catalog: ['SEO', 'Meta Ads', 'Google Ads'], defaultService: 'SEO' }
  );

  assert.strictEqual(rows.length, 5);
  assert.deepStrictEqual(
    rows.map((r) => r.email),
    ['a@acme.com', 'b@acme.com', 'c@acme.com', 'd@acme.com', 'e@acme.com']
  );
  assert.strictEqual(rows[0].service, 'SEO', 'falls back to the default service');
  assert.strictEqual(rows[1].service, 'Meta Ads');
  assert.strictEqual(rows[2].service, 'SEO');
  assert.strictEqual(rows[4].authMethod, 'password');
  assert.deepStrictEqual(skipped, ['this line has no address']);
});

test('pasting fuzzy-matches a service to the catalog casing', () => {
  const { rows } = parsePastedInvites('a@x.com, meta ads', { catalog: ['Meta Ads'] });
  assert.strictEqual(rows[0].service, 'Meta Ads', 'adopts the catalog spelling');
});

test('a skipped line is REPORTED, never silently dropped', () => {
  const { rows, skipped } = parsePastedInvites('garbage\nmore garbage', {});
  assert.strictEqual(rows.length, 0);
  assert.strictEqual(skipped.length, 2);
});

test('results are painted back by index, and failures stay editable', () => {
  const rows = [
    newRow({ service: 'SEO', email: 'a@x.com' }),
    newRow({ service: 'Meta Ads', email: 'b@x.com' }),
  ];
  const merged = mergeResults(rows, [
    { index: 0, outcome: 'invited', serviceCreated: true, error: null },
    { index: 1, outcome: 'failed', serviceCreated: false, error: 'Mail bounced.' },
  ]);

  assert.strictEqual(merged[0].status, 'done');
  assert.strictEqual(merged[0].message, 'Service created');
  assert.strictEqual(merged[1].status, 'failed');
  assert.strictEqual(merged[1].message, 'Mail bounced.');
  // The row keeps its typed values, so the fix is one edit away.
  assert.strictEqual(merged[1].email, 'b@x.com');
});

test('a shorter result list leaves the extra rows untouched', () => {
  const rows = [newRow({ email: 'a@x.com' }), newRow({ email: 'b@x.com' })];
  const merged = mergeResults(rows, [{ index: 0, outcome: 'invited' }]);
  assert.strictEqual(merged[1].status, null);
});
