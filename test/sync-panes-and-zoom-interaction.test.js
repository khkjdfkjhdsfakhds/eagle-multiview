'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');

test('paneLayoutPopover has sync-panes checkbox and higher z-index than preview modal', () => {
  assert.ok(html.includes('id="syncPanesCheckbox"'), 'HTML must include syncPanesCheckbox');
  assert.ok(styles.includes('.pane-layout-popover {\n  position: absolute;\n  z-index: 80;'), 'paneLayoutPopover must have high z-index (80)');
  assert.ok(styles.includes('.toolbar {\n  position: relative;\n  z-index: 50;'), 'toolbar must have z-index 50');
});

test('preview image uses grab/grabbing cursor and removes zoom-in cursor and dblclick listener', () => {
  assert.ok(!renderer.includes("'zoom-in'"), 'zoom-in magnifying cursor must be removed');
  assert.ok(!renderer.includes("modalMedia.addEventListener('dblclick'"), 'dblclick zoom listener on modalMedia must be removed');
  assert.ok(!renderer.includes("$('#modalMedia').addEventListener('dblclick'"), 'global dblclick zoom listener must be removed');
  assert.ok(styles.includes('cursor: grab;'), 'preview-image must default to grab cursor');
  assert.ok(styles.includes('cursor: grabbing;'), 'preview-image active/dragging must use grabbing cursor');
});

test('preview image disables native dragging and removes click-to-close background listener', () => {
  assert.ok(!renderer.includes("previewModal.addEventListener('click'"), 'pane previewModal click listener must be removed');
  assert.ok(!renderer.includes("$('#previewModal').addEventListener('click'"), 'global previewModal click listener must be removed');
  assert.ok(renderer.includes('image.setAttribute(\'draggable\', \'false\')'), 'image must have draggable=false');
  assert.ok(renderer.includes("image.addEventListener('dragstart', event => event.preventDefault())"), 'dragstart must be prevented');
  assert.ok(styles.includes('-webkit-user-drag: none;'), 'styles must set -webkit-user-drag: none');
});

test('syncPanes keeps grid arrow selection pane-local while preview navigation still syncs', () => {
  assert.ok(renderer.includes('function broadcastPaneAction('), 'broadcastPaneAction helper must exist');
  assert.ok(!renderer.includes('broadcastPaneAction(() => moveCardFocus(event.key))'), 'grid Arrow keys must stay pane-local');
  assert.ok(renderer.includes('broadcastPaneAction(pane => { if (pane.previewId) movePreview('), 'Arrow keys in preview must broadcast');
  assert.ok(renderer.includes('broadcastPaneAction(pane => {\n      if (pane.previewId) closePreview('), 'closePreview must broadcast close to sibling panes');
  assert.ok(renderer.includes('localStorage.setItem(\'eaglemv.syncPanes\''), 'syncPanes state must persist to localStorage');
});
