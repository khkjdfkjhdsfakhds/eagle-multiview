'use strict';

// Regression coverage for the 2026-07-26 Eagle-parity batch 1:
// number-key rating, grid star overlay, dominant-color palette, labeled
// file info, Chromium PDF plugin, and video/audio Range forwarding.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8');
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

test('number keys 0-5 set the selection rating like Eagle', () => {
  const start = renderer.indexOf('document.addEventListener(\'keydown\'');
  assert.ok(start >= 0);
  const handler = renderer.slice(start, renderer.indexOf('\n  });', start));
  // digit branch guarded against text fields, preview, and modifier keys
  assert.match(handler, /\/\^\[0-5\]\$\/\.test\(event\.key\)/);
  assert.ok(handler.includes('setSelectionRating({ ids: [...state.selected], rating: Number(event.key) })'));
  // must not fire while typing in an input or during preview
  const idx = handler.indexOf('/^[0-5]$/');
  const line = handler.slice(handler.lastIndexOf('if (', idx), idx);
  assert.ok(line.includes('!editable') && line.includes('!previewOpen'));
  assert.ok(line.includes('!event.metaKey') || line.includes('!primaryKey'));
});

test('grid cards render a star overlay only when rated', () => {
  assert.ok(renderer.includes("Number(item.star) > 0 ? `<span class=\"card-stars\""));
  assert.match(styles, /\.card-stars\s*\{/);
});

test('inspector renders a dominant-color palette from item.palettes', () => {
  assert.ok(renderer.includes('function renderItemPalette(item)'));
  assert.ok(renderer.includes('renderItemPalette(item);'));
  assert.ok(renderer.includes("item.palettes"));
  // swatch carries a copyable hex and is wired to clipboard
  assert.ok(renderer.includes('class="palette-swatch"'));
  assert.ok(renderer.includes("window.eagleMV.copyText(swatch.dataset.color)"));
  assert.match(html, /id="itemPalette"/);
  assert.match(styles, /\.palette-swatch\s*\{/);
});

test('file-info rows are labeled (格式/大小/尺寸/修改日期)', () => {
  assert.ok(renderer.includes('<em>格式</em>'));
  assert.ok(renderer.includes('<em>尺寸</em>'));
  assert.ok(renderer.includes('<em>修改日期</em>'));
});

test('PDF preview enables the Chromium plugin viewer', () => {
  const start = main.indexOf('webPreferences: {');
  const block = main.slice(start, main.indexOf('}', start));
  assert.match(block, /plugins:\s*true/);
});

test('media protocol forwards Range so video/audio can seek', () => {
  assert.ok(main.includes("const range = request.headers.get('Range');"));
  assert.ok(main.includes('net.fetch(fileURL, range ? { headers: { Range: range } } : undefined)'));
});
