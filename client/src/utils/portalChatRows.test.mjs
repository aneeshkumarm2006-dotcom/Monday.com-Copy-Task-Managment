import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeMessages, streamsOfMode } from './portalChatRows.js';

/**
 * The portal receives every message twice by design — once over SSE, once on
 * the next poll — so de-duplication is the normal path through `mergeMessages`,
 * not an edge case. These assert the properties that make the duplicate
 * invisible rather than the implementation that currently achieves it.
 */

const at = (iso) => ({ createdAt: iso });

test('the same message arriving twice renders once', () => {
  const first = mergeMessages([], [{ id: 'a', ...at('2026-09-04T10:00:00Z') }]);
  const again = mergeMessages(first, [{ id: 'a', ...at('2026-09-04T10:00:00Z') }]);
  assert.equal(again.length, 1);
});

test('a polled copy MERGES onto a streamed one rather than replacing it', () => {
  // The list endpoint computes `replyCount`; a stream frame does not carry it.
  // A naive replace would blank the count every time a message arrived live —
  // the reply link would flicker away and come back on the next poll.
  const streamed = [{ id: 'a', bodyText: 'hi', replyCount: 3, ...at('2026-09-04T10:00:00Z') }];
  const merged = mergeMessages(streamed, [
    { id: 'a', bodyText: 'hi', ...at('2026-09-04T10:00:00Z') },
  ]);
  assert.equal(merged[0].replyCount, 3, 'replyCount was lost by the merge');
});

test('incoming values win on the fields it does carry', () => {
  const merged = mergeMessages(
    [{ id: 'a', bodyText: 'draft', ...at('2026-09-04T10:00:00Z') }],
    [{ id: 'a', bodyText: 'edited', editedAt: 'x', ...at('2026-09-04T10:00:00Z') }]
  );
  assert.equal(merged[0].bodyText, 'edited');
  assert.equal(merged[0].editedAt, 'x');
});

test('the result is ordered oldest-first regardless of arrival order', () => {
  // The API pages newest-first; the pane renders oldest-first. A message that
  // arrives late but was written earlier — a slow poll landing after a stream
  // frame — must still sort into its place, not onto the end.
  const merged = mergeMessages(
    [{ id: 'b', ...at('2026-09-04T12:00:00Z') }],
    [
      { id: 'c', ...at('2026-09-04T13:00:00Z') },
      { id: 'a', ...at('2026-09-04T11:00:00Z') },
    ]
  );
  assert.deepEqual(merged.map((m) => m.id), ['a', 'b', 'c']);
});

test('neither input is mutated', () => {
  const prev = [{ id: 'a', ...at('2026-09-04T10:00:00Z') }];
  const incoming = [{ id: 'b', ...at('2026-09-04T11:00:00Z') }];
  mergeMessages(prev, incoming);
  assert.equal(prev.length, 1);
  assert.equal(incoming.length, 1);
});

test('null, undefined and id-less rows are survivable', () => {
  // Both call sites can fire before the first load resolves.
  assert.deepEqual(mergeMessages(null, null), []);
  assert.deepEqual(mergeMessages(undefined, undefined), []);
  assert.equal(mergeMessages([], [{ bodyText: 'no id' }]).length, 0);
});

// ---------------------------------------------------------------------------
// streamsOfMode — which tabs exist at all
// ---------------------------------------------------------------------------

const channels = {
  workstreams: [
    {
      id: 'g1',
      name: 'Ads',
      surfaces: [
        { id: 'c1', mode: 'chat', unread: 2 },
        { id: 'c2', mode: 'mail', unread: 0 },
      ],
    },
    { id: 'g2', name: 'SEO', surfaces: [{ id: 'c3', mode: 'chat', unread: 5 }] },
    { id: 'g3', name: 'Web', surfaces: [] },
  ],
};

test('a mode returns only the workstreams that HAVE that surface', () => {
  assert.deepEqual(streamsOfMode(channels, 'chat').map((w) => w.name), ['Ads', 'SEO']);
  // Only Ads has a mailbox — SEO must not appear with an undefined surface.
  assert.deepEqual(streamsOfMode(channels, 'mail').map((w) => w.name), ['Ads']);
});

test('a workstream with NO surfaces is dropped, not shown empty', () => {
  // The client cannot create a surface — only the team can — so an empty row
  // would be a dead tab with no way to ask for a live one.
  assert.equal(streamsOfMode(channels, 'chat').some((w) => w.name === 'Web'), false);
});

test('each row carries the surface itself, so the caller needs no second lookup', () => {
  assert.equal(streamsOfMode(channels, 'chat')[0].surface.id, 'c1');
});

test('an absent payload yields no tabs rather than throwing', () => {
  assert.deepEqual(streamsOfMode(null, 'chat'), []);
  assert.deepEqual(streamsOfMode({}, 'chat'), []);
  assert.deepEqual(streamsOfMode({ workstreams: [] }, 'chat'), []);
});

test('a mode nobody has yields nothing', () => {
  assert.deepEqual(streamsOfMode(channels, 'carrier-pigeon'), []);
});

