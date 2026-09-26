import { test } from 'node:test';
import assert from 'node:assert/strict';

import { placePopover, anchorOffscreen, rectOutside } from './popoverPlacement.js';

const viewport = { width: 1280, height: 800 };
const rect = (top, left, width, height) => ({
  top,
  left,
  width,
  height,
  right: left + width,
  bottom: top + height,
});

test('opens below the anchor, left-aligned, when there is room', () => {
  const p = placePopover({ anchor: rect(100, 200, 20, 20), size: { width: 240, height: 260 }, viewport });
  assert.equal(p.placement, 'bottom');
  assert.equal(p.top, 124); // bottom 120 + gap 4
  assert.equal(p.left, 200);
  assert.equal(p.maxHeight, 260);
});

test("align 'end' lines the right edges up — a menu off a trailing ⋯", () => {
  const p = placePopover({
    anchor: rect(100, 500, 20, 20),
    size: { width: 240, height: 100 },
    viewport,
    align: 'end',
  });
  assert.equal(p.left, 520 - 240);
});

test('flips above when it does not fit below and there is more room above', () => {
  // A one-invoice group near the bottom of the window: the column menu that
  // used to be clipped by the grid now opens upward instead.
  const p = placePopover({ anchor: rect(700, 200, 20, 20), size: { width: 240, height: 300 }, viewport });
  assert.equal(p.placement, 'top');
  assert.equal(p.top, 700 - 4 - 300);
  assert.equal(p.maxHeight, 300);
});

test('stays below and scrolls inside itself when above is even tighter', () => {
  const small = { width: 1280, height: 300 };
  const p = placePopover({ anchor: rect(60, 10, 20, 20), size: { width: 200, height: 500 }, viewport: small });
  assert.equal(p.placement, 'bottom');
  // 300 - 80 - 4 - 8
  assert.equal(p.maxHeight, 208);
  assert.equal(p.top + p.maxHeight, 300 - 8);
});

test('never runs off the right edge, and never narrower than the margin allows', () => {
  const p = placePopover({ anchor: rect(100, 1250, 20, 20), size: { width: 280, height: 100 }, viewport });
  assert.equal(p.left, 1280 - 8 - 280);

  const phone = { width: 320, height: 640 };
  const q = placePopover({ anchor: rect(100, 10, 20, 20), size: { width: 400, height: 100 }, viewport: phone });
  assert.equal(q.width, 320 - 16);
  assert.equal(q.left, 8);
});

test('a maxHeight cap wins over the natural height', () => {
  const p = placePopover({
    anchor: rect(100, 200, 20, 20),
    size: { width: 240, height: 900 },
    viewport,
    maxHeight: 360,
  });
  assert.equal(p.maxHeight, 360);
});

test('anchorOffscreen: only when the anchor has fully left the viewport', () => {
  assert.equal(anchorOffscreen(rect(100, 100, 20, 20), viewport), false);
  assert.equal(anchorOffscreen(rect(-30, 100, 20, 20), viewport), true);
  assert.equal(anchorOffscreen(rect(-10, 100, 20, 20), viewport), false); // partly visible
  assert.equal(anchorOffscreen(rect(810, 100, 20, 20), viewport), true);
  assert.equal(anchorOffscreen(null, viewport), true);
});

test('rectOutside: a header cell scrolled out of the grid is hidden even if on screen', () => {
  const grid = rect(0, 0, 600, 400);
  assert.equal(rectOutside(rect(10, 620, 100, 30), grid), true);
  assert.equal(rectOutside(rect(10, 580, 100, 30), grid), false);
});
