'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const waterfall = require('../src/waterfall-layout');

test('T-07: columns fit the thumbnail size and stretch to fill the width', () => {
  // (W + gap) / (thumb + gap), at least one, like CSS columns and Eagle.
  assert.deepEqual(waterfall.columnsFor(552, 168), { count: 3, width: 176 });
  assert.equal(waterfall.columnsFor(100, 168).count, 1);
  assert.equal(waterfall.columnsFor(100, 168).width, 100);
  assert.equal(waterfall.columnsFor(1000, 168, 8).count, 5);
});

test('T-07: cards go row by row into the shortest column, leftmost of equals', () => {
  const heights = [0, 0, 0];
  const placed = waterfall.place(heights, [100, 50, 80, 30, 40, 50], 176);
  assert.deepEqual(placed.map(({ column, top }) => [column, top]), [
    [0, 0], [1, 0], [2, 0], // the first row, left to right
    [1, 62], // under the shortest column (50 + gap)
    [2, 92], // now column 2 (80 + gap) is the shortest
    [1, 104] // column 1 (104) is below column 0 (112)
  ]);
  assert.deepEqual(placed.map(({ left }) => left), [0, 188, 376, 188, 376, 188]);
  assert.deepEqual(heights, [112, 166, 144]);
  assert.equal(waterfall.contentHeight(heights), 154);
  // Equal columns: the leftmost wins.
  assert.deepEqual(waterfall.place([20, 10, 10], [5], 100).map(({ column }) => column), [1]);
});

test('T-07: appending continues from the earlier column heights', () => {
  const sizes = [90, 40, 70, 20, 60, 35, 80];
  const whole = waterfall.place([0, 0, 0], sizes, 100);
  const heights = [0, 0, 0];
  const first = waterfall.place(heights, sizes.slice(0, 4), 100);
  const rest = waterfall.place(heights, sizes.slice(4), 100);
  assert.deepEqual([...first, ...rest], whole);
});

test('T-07: an empty grid has no height', () => {
  assert.equal(waterfall.contentHeight([0, 0]), 0);
  assert.equal(waterfall.contentHeight([]), 0);
});

test('D-10: the 瀑布流 manual-order marker splits cards left and right, like the rows', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'manual-order-ui.js'), 'utf8');
  assert.match(source, /const vertical = node\.matches\('\.folder-row'\) \|\| node\.closest\('\.asset-grid\.list'\);/);
});
