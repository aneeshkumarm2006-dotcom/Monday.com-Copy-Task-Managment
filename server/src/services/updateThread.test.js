/**
 * updateThread.test.js — the TipTap → text half of the update thread export.
 *
 * `bodyText` is a mirror the COMPOSER sends; it is not derived from the stored
 * document, so any row written before it existed, or by a client that skipped
 * it, has only the document. For those rows this walk is the whole message, and
 * the two nodes with no text children (a mention, a Drive chip) are exactly the
 * ones a naive walk drops in silence — the message still exports, one name
 * shorter.
 *
 * `buildTaskThreads` itself is a query and is not covered here.
 *
 * Run from the server directory:
 *     node --test src/services/updateThread.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { textFromDoc, messageText } = require('./updateThread');

const doc = (...content) => ({ type: 'doc', content });
const para = (...content) => ({ type: 'paragraph', content });
const text = (t) => ({ type: 'text', text: t });

test('paragraphs become lines', () => {
  const body = doc(para(text('First point')), para(text('Second point')));
  assert.strictEqual(textFromDoc(body).trim(), 'First point\nSecond point');
});

test('a mention keeps the name it displayed', () => {
  const body = doc(para(
    text('over to '),
    { type: 'mention', attrs: { id: 'u1', label: 'Ann Smith' } },
    text(' please')
  ));
  assert.strictEqual(textFromDoc(body).trim(), 'over to @Ann Smith please');
});

test('a Drive chip exports its URL', () => {
  const url = 'https://docs.google.com/document/d/abc/edit';
  const body = doc(para(text('brief: '), { type: 'driveChip', attrs: { href: url } }));
  assert.strictEqual(textFromDoc(body).trim(), `brief: ${url}`);
});

test('list items are one line each', () => {
  const body = doc({
    type: 'bulletList',
    content: [
      { type: 'listItem', content: [para(text('alpha'))] },
      { type: 'listItem', content: [para(text('beta'))] },
    ],
  });
  // The item and the paragraph inside it both break, hence the blank line —
  // collapsed by messageText, which is what the export actually calls.
  assert.strictEqual(
    messageText({ body }),
    'alpha\n\nbeta'
  );
});

test('a hard break stays a break', () => {
  const body = doc(para(text('one'), { type: 'hardBreak' }, text('two')));
  assert.strictEqual(textFromDoc(body).trim(), 'one\ntwo');
});

test('the plain-text mirror wins when it has content', () => {
  const body = doc(para(text('the document')));
  assert.strictEqual(messageText({ bodyText: 'the mirror', body }), 'the mirror');
});

test('an empty mirror falls through to the document', () => {
  const body = doc(para(text('the document')));
  assert.strictEqual(messageText({ bodyText: '   ', body }), 'the document');
});

test('a message with neither is empty, not a crash', () => {
  assert.strictEqual(messageText({ bodyText: '', body: null }), '');
  assert.strictEqual(textFromDoc(undefined), '');
});
