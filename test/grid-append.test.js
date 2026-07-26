'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { appendableTailCount } = require('../src/pane-state');

const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
const cssSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8');

const items = ids => ids.map(id => ({ id }));

test('appendableTailCount accepts only strict-prefix growth', () => {
  assert.equal(appendableTailCount(['a', 'b'], items(['a', 'b', 'c', 'd'])), 2);
  assert.equal(appendableTailCount(['a'], items(['a', 'b'])), 1);
  // Same length means an in-place change (rating, rename): full rebuild.
  assert.equal(appendableTailCount(['a', 'b'], items(['a', 'b'])), -1);
  // Shrink, reorder, or divergent prefix: full rebuild.
  assert.equal(appendableTailCount(['a', 'b'], items(['a'])), -1);
  assert.equal(appendableTailCount(['a', 'b'], items(['b', 'a', 'c'])), -1);
  assert.equal(appendableTailCount(['a', 'x'], items(['a', 'b', 'c'])), -1);
  // Empty or missing rendered list: nothing to append onto.
  assert.equal(appendableTailCount([], items(['a'])), -1);
  assert.equal(appendableTailCount(null, items(['a'])), -1);
  assert.equal(appendableTailCount(['a'], null), -1);
});

test('renderGrid appends lazy-load pages instead of rebuilding the whole grid', () => {
  const start = rendererSource.indexOf('function renderGrid');
  const body = rendererSource.slice(start, rendererSource.indexOf('\nfunction itemCardMarkup', start));
  // The fast path is guarded by scroll preservation, an unchanged pre-grid
  // section, an unchanged view-mode class, and the prefix check.
  assert.ok(body.includes('appendableTailCount('));
  assert.ok(body.includes('_gridPrefix === gridPrefixHTML'));
  assert.ok(body.includes("insertAdjacentHTML('beforeend'"));
  assert.ok(body.includes('preserveScroll && grid'));
  // Both paths hydrate through the shared helper.
  assert.ok(rendererSource.includes('function hydrateGridCards'));
  assert.equal(body.match(/hydrateGridCards\(/g).length, 2);
});

test('off-screen thumbnails skip layout and paint via content-visibility', () => {
  const rule = cssSource.match(/^\.thumb-wrap\s*\{([^}]+)\}/m)?.[1] || '';
  assert.match(rule, /content-visibility:\s*auto/);
  // Sizing must stay style-driven for the geometry to remain exact.
  assert.match(rule, /aspect-ratio:\s*var\(--item-aspect\)/);
});
