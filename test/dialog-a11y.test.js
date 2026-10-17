'use strict';
// P3 dialog and accessibility details (F-06, F-09, F-11, F-13, W-09, W-12).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('toasts are announced, the search box is labelled, popovers are not fake menus (F-13)', () => {
  const html = read('src/index.html');
  assert.match(html, /<div id="toast" class="toast hidden" role="status" aria-live="polite"><\/div>/);
  assert.match(html, /<input id="searchInput" type="search" aria-label="搜索"/);
  assert.match(html, /id="libraryPopover"[^>]*role="dialog"/);
  assert.match(html, /id="paneLayoutPopover"[^>]*role="dialog"/);
});

test('the update window exposes its progress and lets the error be copied (F-11)', () => {
  const html = read('src/update.html');
  assert.match(html, /id="bar" role="progressbar"[^>]*aria-valuemin="0" aria-valuemax="100"/);
  assert.match(html, /\.sub\.error \{[^}]*user-select: text;/);
  assert.match(read('src/update.js'), /other\.disabled = true;/);
});

test('closing a ready update means 稍后 and closing an offer lets it remind again (F-09)', () => {
  const main = read('main.js');
  assert.match(main, /controller\.state\.phase === 'ready'\) controller\.requestInstall\(\{ relaunch: false \}\);/);
  assert.match(main, /controller\.state\.phase === 'available'\) controller\.setState\(\{ phase: 'idle' \}\);/);
});

test('the move-folder dialog starts in search and Return submits (F-06)', () => {
  const ui = read('src/feature-ui.js');
  assert.match(ui, /event\.key === 'Enter' && !event\.isComposing\) \{ event\.preventDefault\(\); submit\.click\(\); \}/);
  assert.match(ui, /search\.focus\(\);/);
});

test('the web toolbar avoids the iOS safe area and touch devices hide key hints (W-09, W-12)', () => {
  const css = read('src/styles.css');
  assert.match(css, /body\.web-client \.toolbar \{\s*padding-top: max\(7px, env\(safe-area-inset-top\)\);/);
  assert.match(css, /@media \(hover: none\) and \(pointer: coarse\) \{\s*body\.web-client kbd \{ display: none; \}/);
});
