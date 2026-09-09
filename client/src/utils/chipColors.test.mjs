import test from 'node:test';
import assert from 'node:assert';

import {
  PRIORITY_COLORS,
  STATUS_COLORS,
  getColorPair,
  deepFor,
  whiteTextContrast,
  MIN_WHITE_CONTRAST,
} from './priorityColors.js';

/**
 * THE COLOUR-FIRST CELL PUTS WHITE TEXT ON A FILLED BACKGROUND.
 *
 * Which makes "is this dark enough to write on" a property that has to hold for
 * every colour in the app — including the ones people invent, since a label's
 * colour is picked by whoever made the label. Hand-picking hex values covers
 * the eight built-in ones and nothing else, so `deepFor` computes it and these
 * assertions are what stop it drifting.
 *
 * monday.com ships white on `#FDAB3D` at roughly 2.3:1. That is the thing worth
 * not copying, and the reason this file exists.
 */

const families = [...Object.entries(PRIORITY_COLORS), ...Object.entries(STATUS_COLORS)];

test('every built-in family has a deep fill that white text can sit on', () => {
  for (const [key, entry] of families) {
    assert.ok(entry.deep, `${key} has no deep fill`);
    const ratio = whiteTextContrast(entry.deep);
    assert.ok(
      ratio >= MIN_WHITE_CONTRAST,
      `${key} deep ${entry.deep} gives white text ${ratio.toFixed(2)}:1`
    );
  }
});

test('deep is a genuinely different value from solid, because solid is not enough', () => {
  // The claim the design rests on: the existing 600-step clears 4.5:1 for the
  // red and the grey but NOT for the amber or the orange, so `deep` could not
  // simply reuse `solid`. If this ever stops being true the extra token can go.
  assert.ok(whiteTextContrast(PRIORITY_COLORS.medium.solid) < MIN_WHITE_CONTRAST);
  assert.ok(whiteTextContrast(PRIORITY_COLORS.high.solid) < MIN_WHITE_CONTRAST);
  assert.ok(whiteTextContrast(STATUS_COLORS.done.solid) < MIN_WHITE_CONTRAST);
});

test('deepFor makes any colour safe to write white on', () => {
  // Including the ones monday ships, the ones a person might pick from a colour
  // wheel, and the pathological ends.
  const awkward = [
    '#FDAB3D', // monday's orange — 2.3:1 as shipped
    '#00C875', // monday's green
    '#C4C4C4', // monday's grey
    '#FFFF00', // pure yellow, the worst case for white text
    '#FFFFFF', // white on white
    '#7CFC00', // lawn green
    '#000000', // already black
    '#2563EB', // Macan's accent
  ];
  for (const hex of awkward) {
    const ratio = whiteTextContrast(deepFor(hex));
    assert.ok(
      ratio >= MIN_WHITE_CONTRAST,
      `deepFor(${hex}) → ${deepFor(hex)} gives only ${ratio.toFixed(2)}:1`
    );
  }
});

test('a colour that already passes is left alone', () => {
  // Darkening something that is already dark enough would drain every deliberate
  // colour choice toward black over time. Compared case-insensitively: `toHex`
  // normalises to lowercase, which is the same colour and not an alteration.
  for (const hex of ['#B91C1C', '#15803D', '#000000', '#4B5563']) {
    assert.equal(
      deepFor(hex).toLowerCase(),
      hex.toLowerCase(),
      `${hex} was darkened even though it already passes`
    );
  }
});

test('the least distance that fixes it, not the safest possible', () => {
  // Yellow has to travel a long way; a mid blue barely moves. Both must land
  // just past the line rather than at black.
  const yellow = deepFor('#FFFF00');
  assert.ok(whiteTextContrast(yellow) >= MIN_WHITE_CONTRAST);
  assert.ok(
    whiteTextContrast(yellow) < MIN_WHITE_CONTRAST + 1.5,
    `overshot: ${whiteTextContrast(yellow).toFixed(2)}:1 — the colour is being drained`
  );
});

test('garbage input falls back rather than throwing', () => {
  // Label colours come from the database and have been null before.
  for (const bad of [null, undefined, '', 'not-a-colour', '#ZZZ', 42, {}]) {
    const out = deepFor(bad);
    assert.ok(typeof out === 'string' && out.startsWith('#'), `deepFor(${String(bad)})`);
    assert.ok(whiteTextContrast(out) >= MIN_WHITE_CONTRAST);
  }
  assert.equal(whiteTextContrast(null), 0);
});

test('a user-chosen label colour gets all four steps', () => {
  const pair = getColorPair('#7C3AED');
  for (const k of ['bg', 'text', 'solid', 'deep']) {
    assert.ok(pair[k], `getColorPair is missing ${k}`);
  }
  assert.equal(pair.solid, '#7c3aed');
  assert.ok(whiteTextContrast(pair.deep) >= MIN_WHITE_CONTRAST);
});

test('contrast is computed, not guessed', () => {
  // Two anchors from the WCAG definition, so a broken luminance formula cannot
  // pass this file by accident.
  assert.ok(Math.abs(whiteTextContrast('#000000') - 21) < 0.1, 'white on black is 21:1');
  assert.ok(Math.abs(whiteTextContrast('#FFFFFF') - 1) < 0.01, 'white on white is 1:1');
});
