import test from 'node:test';
import assert from 'node:assert/strict';
import { GROUP_COLORS, groupColorAt } from './groupColors.js';

test('cycles through the palette by position', () => {
  assert.equal(groupColorAt(0), GROUP_COLORS[0]);
  assert.equal(groupColorAt(3), GROUP_COLORS[3]);
  assert.equal(groupColorAt(4), GROUP_COLORS[0]);
  assert.equal(groupColorAt(9), GROUP_COLORS[1]);
});

test('never returns undefined, whatever it is handed', () => {
  for (const bad of [-1, -7, 1.7, NaN, undefined, null, 'x', Infinity]) {
    assert.ok(GROUP_COLORS.includes(groupColorAt(bad)), `groupColorAt(${bad}) escaped the palette`);
  }
});

test('every colour is a full hex, because deepFor has to parse it', () => {
  GROUP_COLORS.forEach((c) => assert.match(c, /^#[0-9A-Fa-f]{6}$/));
});
