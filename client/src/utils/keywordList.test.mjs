import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normaliseKeyword,
  splitKeywordText,
  operatorsIn,
  keywordsWithOperators,
  mergeKeywords,
} from './keywordList.js';

/**
 * The browser's preview of what the server will accept.
 *
 * What is being pinned is AGREEMENT WITH THE SERVER, not behaviour in its own
 * right: `dataforseo/sites.js` `readKeywords` normalises, deduplicates and
 * refuses operators, and every case below is one this preview must reach the
 * same conclusion about. Where they disagree, the count in front of the person
 * pasting stops describing the bill they are about to authorise.
 */

test('a keyword is folded exactly the way the server folds it', () => {
  assert.equal(normaliseKeyword('  Best   CRM  '), 'best crm');
  assert.equal(normaliseKeyword('BEST\tCRM'), 'best crm');
  assert.equal(normaliseKeyword(null), '');
});

test('a paste splits on newlines, commas AND tabs', () => {
  /**
   * The three places people paste from: a text file, a spreadsheet column and a
   * CSV. A splitter that only knew newlines would read a whole CSV row as one
   * two-hundred-character keyword, which the server then refuses for length
   * with a sentence about a keyword nobody typed.
   */
  assert.deepEqual(splitKeywordText('a\nb,c\td'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(splitKeywordText('a\n\n\nb'), ['a', 'b'], 'blank lines are not keywords');
  assert.deepEqual(splitKeywordText(''), []);
});

test('adding is lossy, and says so', () => {
  const out = mergeKeywords(['best crm'], 'Best CRM\nseo audit\nseo audit');
  assert.deepEqual(out.keywords, ['best crm', 'seo audit']);
  assert.equal(out.added, 1);
  assert.equal(
    out.duplicate,
    2,
    'the differently-cased repeat AND the exact repeat both count — Google is case-insensitive'
  );
});

test('merging never mutates the list it was given', () => {
  const before = ['a'];
  mergeKeywords(before, 'b');
  assert.deepEqual(before, ['a']);
});

test('operators are found anywhere in the keyword, not just at the front', () => {
  assert.deepEqual(operatorsIn('site:acme.com pricing'), ['site:']);
  assert.deepEqual(operatorsIn('best crm'), []);

  // They STACK, which is why the refusal is absolute rather than a surcharge.
  assert.equal(operatorsIn('site:acme.com intitle:pricing').length, 2);
});

test('the flagged list is what the wizard refuses to continue past', () => {
  const flagged = keywordsWithOperators(['best crm', 'site:acme.com', 'seo audit']);
  assert.deepEqual(flagged, ['site:acme.com']);
  assert.deepEqual(keywordsWithOperators([]), []);
  assert.deepEqual(keywordsWithOperators(null), []);
});
