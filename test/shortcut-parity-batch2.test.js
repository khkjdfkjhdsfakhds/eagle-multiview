'use strict';

// Eagle-parity batch 2: F2 renames the single selection; Space toggles
// video/audio playback inside the preview and opens the first selected
// item even when several are selected.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
const keydownStart = renderer.indexOf("document.addEventListener('keydown'", renderer.indexOf('function bindEvents()'));
const keydown = renderer.slice(keydownStart, renderer.indexOf('\n  });', keydownStart));

// F2 reaches the same rename as ⌘R: one item, a selected folder card, the
// focused folder row or the current folder (B3-11).
test('F2 renames like Cmd+R outside text fields and the preview', () => {
  const index = keydown.indexOf("event.key === 'F2'");
  assert.ok(index >= 0);
  const line = keydown.slice(keydown.lastIndexOf('if (', index), keydown.indexOf('{', index));
  assert.ok(line.includes('!editable'));
  assert.ok(line.includes('!previewOpen'));
  assert.ok(!line.includes('state.selected.size === 1'));
  assert.ok(line.includes("event.key.toLowerCase() === 'r'"), 'F2 and Cmd+R share one branch');
  const branch = keydown.slice(index, index + 300);
  assert.ok(branch.includes('requestRenameSelection()'));
});

test('space toggles media playback in the preview and still closes stills', () => {
  const index = keydown.indexOf("$('#modalMedia video, #modalMedia audio')");
  assert.ok(index >= 0, 'preview space branch must look for playing media');
  const branch = keydown.slice(keydown.lastIndexOf('if (', index), index + 300);
  assert.ok(branch.includes('media.paused ? media.play().catch(() => {}) : media.pause()'));
  assert.ok(branch.includes('else closePreview()'));
});

test('space opens the first selected item even for multi-selections', () => {
  const index = keydown.indexOf('firstSelectedInViewOrder()');
  assert.ok(index >= 0);
  const condition = keydown.slice(keydown.lastIndexOf('else if (', index), index);
  assert.ok(condition.includes('state.selected.size)'), 'must fire for any non-empty selection');
  assert.ok(!condition.includes('state.selected.size === 1'));
  // The helper scans once with the shared view comparator instead of sorting.
  const helperStart = renderer.indexOf('function firstSelectedInViewOrder()');
  const helper = renderer.slice(helperStart, renderer.indexOf('\n}', helperStart));
  assert.ok(helper.includes('compareItemsForView(item, first) < 0'));
  assert.ok(!helper.includes('sortedItems()'));
});
