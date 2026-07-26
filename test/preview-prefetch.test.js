'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');

// Swiping between previews (and ←/→ on the desktop) should land on an image
// that is already in the browser cache.

test('the preview markup and the prefetch share one image-URL resolver', () => {
  assert.ok(renderer.includes('function previewImageURL(item) {'));
  assert.ok(renderer.includes('  const imageURL = previewImageURL(item);\n  if (imageURL) return `<img src="${imageURL}"'),
    'mediaMarkup renders whatever previewImageURL resolves');
  assert.ok(renderer.includes('  const url = previewImageURL(item);\n  if (!url) return;'),
    'the prefetch skips anything the preview would not render as an image');
  // Only one place decides that PSD/TIFF/HEIC/RAW use the generated preview.
  assert.strictEqual((renderer.match(/previewStandInExtensions\.has/g) || []).length, 1);
});

test('opening a preview warms both neighbours, bounded and opt-out aware', () => {
  assert.ok(renderer.includes('    prefetchPreviewNeighbours(id);'), 'openPreview warms the neighbours');
  assert.ok(renderer.includes('  prefetchPreviewImage(items[index + 1]);\n  prefetchPreviewImage(items[index - 1]);'),
    'next first, then previous');
  assert.ok(renderer.includes('if (navigator.connection?.saveData) return;'), 'data-saver opts out');
  assert.ok(renderer.includes('if (Number(item.size) > PREFETCH_MAX_BYTES) return;'), 'huge originals are skipped');
  assert.ok(renderer.includes('while (previewPrefetch.size > PREFETCH_RING) {'), 'the ring is bounded');
  assert.ok(renderer.includes('previewPrefetch.clear();'), 'switching libraries drops the old library\'s images');
});

test('the prefetch ring is small enough to stay cheap', () => {
  const ring = Number(renderer.match(/const PREFETCH_RING = (\d+);/)?.[1]);
  const maxBytes = renderer.match(/const PREFETCH_MAX_BYTES = ([^;]+);/)?.[1];
  assert.ok(ring >= 2 && ring <= 12, `ring size ${ring} should stay small`);
  assert.strictEqual(maxBytes, '48 * 1024 * 1024');
});
