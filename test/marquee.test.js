'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DRAG_THRESHOLD,
  exceedsThreshold,
  normalizeRect,
  clampRect,
  rectsIntersect,
  hitIds,
  combineSelection,
  sameSelection,
  autoScrollSpeed
} = require('../src/marquee');

test('threshold separates clicks from drags', () => {
  assert.equal(exceedsThreshold(0, 0), false);
  assert.equal(exceedsThreshold(DRAG_THRESHOLD - 1, 0), false);
  assert.equal(exceedsThreshold(-DRAG_THRESHOLD, 0), true);
  assert.equal(exceedsThreshold(0, DRAG_THRESHOLD), true);
  assert.equal(exceedsThreshold(1, 1, 2), false);
  assert.equal(exceedsThreshold(2, 0, 2), true);
});

test('normalizeRect orders corners dragged in any direction', () => {
  assert.deepEqual(normalizeRect(10, 20, 4, 6), { left: 4, top: 6, right: 10, bottom: 20 });
  assert.deepEqual(normalizeRect(4, 6, 10, 20), { left: 4, top: 6, right: 10, bottom: 20 });
});

test('clampRect keeps the rectangle inside the scroll content', () => {
  assert.deepEqual(
    clampRect({ left: -30, top: -5, right: 500, bottom: 900 }, 400, 800),
    { left: 0, top: 0, right: 400, bottom: 800 }
  );
});

test('hitIds selects cards intersecting the rectangle, not merely touching edges', () => {
  const cards = [
    { id: 'a', left: 0, top: 0, right: 100, bottom: 100 },
    { id: 'b', left: 120, top: 0, right: 220, bottom: 100 },
    { id: 'c', left: 0, top: 120, right: 100, bottom: 220 }
  ];
  assert.deepEqual(hitIds({ left: 90, top: 90, right: 130, bottom: 130 }, cards), ['a', 'b', 'c']);
  assert.deepEqual(hitIds({ left: 101, top: 0, right: 119, bottom: 100 }, cards), []);
  // Zero-area edge contact does not count as a hit.
  assert.deepEqual(hitIds({ left: 100, top: 0, right: 120, bottom: 100 }, cards), []);
  assert.deepEqual(hitIds({ left: 0, top: 0, right: 0, bottom: 0 }, cards), []);
});

test('combineSelection replaces without a modifier and unions with one', () => {
  const base = new Set(['x', 'y']);
  assert.deepEqual([...combineSelection(base, ['a'], false)].sort(), ['a']);
  assert.deepEqual([...combineSelection(base, ['a'], true)].sort(), ['a', 'x', 'y']);
  assert.deepEqual([...combineSelection(base, [], true)].sort(), ['x', 'y']);
  assert.equal(combineSelection(new Set(), [], false).size, 0);
});

test('sameSelection compares sets by membership', () => {
  assert.equal(sameSelection(new Set(['a', 'b']), new Set(['b', 'a'])), true);
  assert.equal(sameSelection(new Set(['a']), new Set(['a', 'b'])), false);
  assert.equal(sameSelection(new Set(['a', 'c']), new Set(['a', 'b'])), false);
});

test('autoScrollSpeed ramps near edges, is zero in the middle, silent on tiny viewports', () => {
  assert.equal(autoScrollSpeed(300, 0, 600), 0);
  assert.ok(autoScrollSpeed(5, 0, 600) < 0);
  assert.ok(autoScrollSpeed(595, 0, 600) > 0);
  // Deeper into the edge zone scrolls faster, capped at maxSpeed.
  const shallow = autoScrollSpeed(590, 0, 600, { edge: 28, maxSpeed: 18 });
  const deep = autoScrollSpeed(650, 0, 600, { edge: 28, maxSpeed: 18 });
  assert.ok(deep >= shallow);
  assert.equal(deep, 18);
  assert.equal(autoScrollSpeed(-100, 0, 600, { edge: 28, maxSpeed: 18 }), -18);
  // A viewport smaller than both edge zones never auto-scrolls.
  assert.equal(autoScrollSpeed(10, 0, 40, { edge: 28, maxSpeed: 18 }), 0);
});
