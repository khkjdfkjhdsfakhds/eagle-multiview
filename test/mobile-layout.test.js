'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'src', 'styles.css'), 'utf8');
const indexHTML = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');

// Phase 1 of web access: compact drawer layout and touch interactions.

test('compact layout turns the side panels into drawers', () => {
  assert.ok(indexHTML.includes('id="drawerBackdrop"'));
  assert.ok(indexHTML.includes('viewport-fit=cover'));
  assert.ok(renderer.includes("window.matchMedia('(max-width: 900px)')"));
  assert.ok(renderer.includes("state.openDrawer = state.openDrawer === panel ? null : panel;"), 'toggle buttons drive drawers in compact mode');
  assert.ok(renderer.includes("$('#drawerBackdrop').addEventListener('click', closeDrawers);"));
  assert.ok(renderer.includes('if (isCompactLayout()) closeDrawers();'), 'navigation closes the drawer');
  assert.ok(styles.includes('body.drawer-sidebar .sidebar'));
  assert.ok(styles.includes('body.drawer-inspector .inspector'));
  assert.ok(styles.includes('@media (max-width: 600px)'));
  assert.ok(styles.includes('grid-auto-rows: minmax(72vh, auto)'), 'panes stack vertically on phones');
});

test('touch pointers tap to preview, long-press to select, and never marquee', () => {
  assert.ok(renderer.includes("if (event.pointerType === 'touch') return;"), 'marquee skips touch pointers');
  assert.ok(renderer.includes('function triggerTouchLongPress(card, paneId, point)'));
  assert.ok(renderer.includes('suppressGridClickUntil = Date.now() + 400;'), 'suppression starts at lift-off');
  assert.ok(renderer.includes('touchLongPressActive || Date.now() < suppressGridClickUntil'), 'native contextmenu swallowed while finger is down');
  assert.ok(renderer.includes('if (Date.now() < suppressGridClickUntil) return;'), 'click after long-press is swallowed');
  const clickHandler = renderer.slice(
    renderer.indexOf("query('#itemGrid').addEventListener('click'"),
    renderer.indexOf("query('#itemGrid').addEventListener('change'")
  );
  assert.ok(renderer.includes("query('#gridScroller').addEventListener('click'"), 'blank-space tap clearing covers the whole scroller');
  assert.ok(renderer.includes("$('#clearSelectionButton').addEventListener('click'"), 'multi-select panel offers an explicit exit for touch');
  assert.ok(clickHandler.includes('openPreview(card.dataset.id)'), 'touch tap opens the preview');
  assert.ok(clickHandler.includes('selectItem(card.dataset.id, true)'), 'tap toggles inside a live selection');
  assert.ok(clickHandler.includes("navigate({ kind: 'folder', id: folder.dataset.openFolder })"), 'touch tap enters folders directly');
});

test('preview modal supports two-finger pinch zoom', () => {
  assert.ok(renderer.includes('const previewPointers = new Map();'));
  assert.ok(renderer.includes('pinchBase = { ...pinchGeometry()'));
  assert.ok(renderer.includes('pinchBase.scale * (current.distance / pinchBase.distance)'));
  assert.ok(styles.includes('.modal-media { touch-action: none; }'));
});
