'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');

// Swiping between previews (and ←/→ on the desktop) should land on an image
// that is already in the browser cache.

test('the preview markup and the prefetch share one image-URL resolver', () => {
  assert.ok(renderer.includes('function previewImageSource(item) {'));
  assert.ok(renderer.includes('  const imageURL = previewImageURL(item);\n  if (imageURL) return `<img src="${imageURL}"'),
    'mediaMarkup renders whatever previewImageURL resolves');
  assert.ok(renderer.includes('  const source = previewImageSource(item);\n  if (!source) return;'),
    'the prefetch skips anything the preview would not render as an image');
  // Only one place decides that PSD/TIFF/HEIC/RAW use the generated preview.
  assert.strictEqual((renderer.match(/previewStandInExtensions\.has/g) || []).length, 1);
});

test('the size guard measures what is actually downloaded', () => {
  // A 780 MB PSD's preview is Eagle's small generated image, not the PSD, so
  // gating stand-in previews on item.size would skip exactly the items whose
  // preview is slowest to produce.
  assert.ok(renderer.includes("if (source.kind === 'original' && Number(item.size) > PREFETCH_MAX_BYTES) return;"));
  assert.ok(renderer.includes("return { kind: 'original', url: mediaURL('original', item.id) };"));
  assert.ok(renderer.includes("return { kind: 'preview', url: mediaURL('preview', item.id) };"));
});

test('opening a preview warms both neighbours, bounded and opt-out aware', () => {
  assert.ok(renderer.includes('    prefetchPreviewNeighbours(id);'), 'openPreview warms the neighbours');
  assert.ok(renderer.includes('  prefetchPreviewImage(items[index + 1]);\n  prefetchPreviewImage(items[index - 1]);'),
    'next first, then previous');
  assert.ok(renderer.includes('if (navigator.connection?.saveData) return;'), 'data-saver opts out');
  assert.ok(renderer.includes('while (previewPrefetch.size > PREFETCH_RING) {'), 'the ring is bounded');
  assert.ok(renderer.includes('previewPrefetch.clear();'), 'switching libraries drops the old library\'s images');
});

test('the prefetch ring is small enough to stay cheap', () => {
  const ring = Number(renderer.match(/const PREFETCH_RING = (\d+);/)?.[1]);
  const maxBytes = renderer.match(/const PREFETCH_MAX_BYTES = ([^;]+);/)?.[1];
  assert.ok(ring >= 2 && ring <= 12, `ring size ${ring} should stay small`);
  assert.strictEqual(maxBytes, '48 * 1024 * 1024');
});

test('a missing image degrades to a message instead of a broken glyph', () => {
  // Eagle can hold an index entry whose file is gone, and text files have no
  // generated thumbnail at all.
  assert.ok(renderer.includes("image.addEventListener('error', () => {"), 'the preview image has an error path');
  assert.ok(renderer.includes('无法读取这个素材的图像'));
  assert.ok(renderer.includes("if (token !== state.previewToken || !image.isConnected) return;"),
    'a stale failure must not overwrite a newer preview');
  assert.ok(renderer.includes("image.addEventListener('error', () => image.closest('.thumb-wrap')?.classList.add('thumb-missing')"),
    'grid thumbnails mark themselves instead of sitting at opacity 0 forever');
  assert.ok(renderer.includes('if (image.complete && image.naturalWidth > 0) image.classList.add('),
    'a cached failure is not mistaken for a cached success');
  // Replacing the failed image must not take the swipe with it: the gesture
  // belongs to whatever occupies the image slot, placeholder included.
  assert.ok(renderer.includes("if (!$('#previewModal').classList.contains('image-gesture')) return;"));
  assert.ok(renderer.includes("if (!image || state.previewZoom.mode === 'fit') {\n        swipeSession ="));
});
