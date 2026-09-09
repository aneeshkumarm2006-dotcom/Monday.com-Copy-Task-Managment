import test from 'node:test';
import assert from 'node:assert';

import { chipStyle, isFilled, CHIP_VARIANTS, TABLE_VARIANT } from './chipStyle.js';
import {
  PRIORITY_COLORS,
  STATUS_COLORS,
  getColorPair,
  whiteTextContrast,
  MIN_WHITE_CONTRAST,
} from './priorityColors.js';

/**
 * One rule, and it is the whole reason this file is separate from the component:
 * anything that paints WHITE text must paint it on `deep`.
 *
 * `solid` is a 600-step. It clears 4.5:1 for the red and the grey and fails for
 * the amber and the green — so a variant reaching for the wrong token would
 * ship two readable statuses and two unreadable ones, and look perfectly fine
 * in a screenshot of the first two.
 */

const PALETTES = [
  ...Object.entries(PRIORITY_COLORS),
  ...Object.entries(STATUS_COLORS),
  ['user-violet', getColorPair('#7C3AED')],
  ['user-yellow', getColorPair('#FFFF00')],
  ['user-monday-orange', getColorPair('#FDAB3D')],
];

test('a filled chip is always readable, for every palette', () => {
  for (const [name, palette] of PALETTES) {
    const style = chipStyle(palette, 'fill');
    assert.equal(style.color, '#FFFFFF', `${name} fill should use white text`);
    const ratio = whiteTextContrast(style.background);
    assert.ok(
      ratio >= MIN_WHITE_CONTRAST,
      `${name} fill is ${style.background} → ${ratio.toFixed(2)}:1`
    );
  }
});

test('fill paints deep, never solid', () => {
  // The specific mistake this guards. Stated as identity rather than as a
  // contrast check, so it fails on the two hues where solid happens to pass.
  for (const [name, palette] of PALETTES) {
    const style = chipStyle(palette, 'fill');
    assert.equal(style.background, palette.deep, `${name} fill did not use deep`);
  }
});

test('a palette with no deep falls back darker, not lighter', () => {
  // Legacy rows and anything constructed by hand. Falling back to `solid` would
  // quietly reintroduce the failure; `text` is the darker of the two.
  const style = chipStyle({ bg: '#FFFBEB', text: '#B45309', solid: '#D97706' }, 'fill');
  assert.equal(style.background, '#B45309');
  assert.ok(whiteTextContrast(style.background) >= MIN_WHITE_CONTRAST);
  // And with nothing at all it still produces something white can sit on.
  assert.ok(whiteTextContrast(chipStyle({}, 'fill').background) >= MIN_WHITE_CONTRAST);
});

test('only fill uses white text', () => {
  // Every other form sits on a pale ground, where white would vanish.
  for (const variant of CHIP_VARIANTS) {
    const style = chipStyle(PRIORITY_COLORS.medium, variant);
    if (variant === 'fill') assert.equal(style.color, '#FFFFFF');
    else assert.notEqual(style.color, '#FFFFFF', `${variant} must not use white text`);
  }
});

test('the pill is unchanged, because everything outside a table still uses it', () => {
  // My Work, the dashboard, kanban cards, the ledger, the portal, notifications.
  // If this drifts, every one of those surfaces changes without being designed.
  const style = chipStyle(PRIORITY_COLORS.critical, 'pill');
  assert.equal(style.background, PRIORITY_COLORS.critical.bg);
  assert.equal(style.color, PRIORITY_COLORS.critical.text);
  assert.equal(style.borderRadius, 'var(--radius-full)');
  // An unknown variant must land here too, not render an invisible chip.
  assert.deepEqual(chipStyle(PRIORITY_COLORS.critical, 'nonsense'), style);
  assert.deepEqual(chipStyle(PRIORITY_COLORS.critical), style);
});

test('tint carries the full-strength colour on its edge', () => {
  // The edge is what makes four priorities read as a scale. Without it they are
  // four pale rectangles.
  const style = chipStyle(PRIORITY_COLORS.high, 'tint');
  assert.ok(style.borderLeft.includes(PRIORITY_COLORS.high.solid));
  assert.equal(style.background, PRIORITY_COLORS.high.bg);
  assert.equal(style.color, PRIORITY_COLORS.high.deep, 'tint text must be the deep step');
});

test('fill and tint fill their cell; the inline forms do not', () => {
  // A colour-first cell that leaves a white margin is just a big pill.
  for (const v of ['fill', 'tint']) {
    const s = chipStyle(STATUS_COLORS.done, v);
    assert.equal(s.width, '100%', `${v} must span the cell`);
    assert.equal(s.height, '100%');
    assert.equal(s.borderRadius, 0, `${v} must not round inside a grid`);
  }
  // `edge`, `pill` and `tag` size to their content. Anything with width:100% and
  // height:100% collapses inside an auto-height menu row, which is exactly what
  // `edge` exists to avoid.
  for (const v of ['pill', 'tag', 'edge']) {
    const s = chipStyle(STATUS_COLORS.done, v);
    assert.equal(s.width, undefined, `${v} must not stretch`);
    assert.equal(s.height, undefined, `${v} must not claim a parent height`);
  }
});

test('edge is tint that fits in a menu', () => {
  // Same colours, different box. If these drift, the priority menu and the
  // priority cell stop looking like the same control.
  const cell = chipStyle(PRIORITY_COLORS.high, 'tint');
  const menu = chipStyle(PRIORITY_COLORS.high, 'edge');
  assert.equal(menu.background, cell.background);
  assert.equal(menu.color, cell.color);
  assert.equal(menu.borderLeft, cell.borderLeft);
});

test('each family knows which form it takes in a table', () => {
  assert.deepEqual(TABLE_VARIANT, { status: 'fill', priority: 'tint', label: 'tag' });
  assert.equal(isFilled('fill'), true);
  assert.equal(isFilled('tint'), false);
});
