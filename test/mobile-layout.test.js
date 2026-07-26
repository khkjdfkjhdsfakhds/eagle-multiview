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

test('preview swipes: horizontal switches, downward closes, videos play inline', () => {
  assert.ok(renderer.includes('swipeSession = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY };'));
  assert.ok(renderer.includes('movePreview(dx < 0 ? 1 : -1);'), 'horizontal swipe switches items');
  assert.ok(renderer.includes('if (dy > 90 && dy > Math.abs(dx) * 1.4) {'), 'downward swipe closes');
  assert.ok(renderer.includes('controls autoplay playsinline'), 'videos stay inline on iOS');
});

test('a compact selection shows the bottom strip and a single way to clear', () => {
  assert.ok(indexHTML.includes('id="selectionBar"'));
  assert.ok(indexHTML.includes('id="selectionBarPreview"'));
  assert.ok(indexHTML.includes('id="selectionBarDetails"'));
  assert.ok(renderer.includes('function renderSelectionBar()'));
  assert.ok(renderer.includes('const visible = isCompactLayout() && count > 0;'), 'the strip is compact-only');
  assert.ok(renderer.includes('function renderInspector() {\n  renderSelectionBar();'), 'every selection change repaints it');
  assert.ok(renderer.includes('  renderSelectionBar();\n}'), 'so does rotating in or out of compact mode');
  assert.ok(renderer.includes("$('#selectionBarDetails').addEventListener('click', () => {\n    state.openDrawer = 'inspector';"));
  assert.ok(styles.includes('body.selection-bar-open .grid-scroller'), 'the grid clears the strip');
  assert.ok(styles.includes('@media (min-width: 901px) { .selection-bar { display: none; } }'));
  // Clearing a selection lives in one place, used by the panel button, the
  // strip button and the blank-space tap.
  assert.ok(renderer.includes('function clearSelection() {'));
  assert.ok(renderer.includes("$('#clearSelectionButton').addEventListener('click', clearSelection);"));
  assert.ok(renderer.includes("$('#selectionBarClear').addEventListener('click', clearSelection);"));
  assert.ok(renderer.includes('    clearSelection();\n  });'), 'the blank-space tap routes through it too');
});

test('preview modal supports two-finger pinch zoom', () => {
  assert.ok(renderer.includes('const previewPointers = new Map();'));
  assert.ok(renderer.includes('pinchBase = { ...pinchGeometry()'));
  assert.ok(renderer.includes('pinchBase.scale * (current.distance / pinchBase.distance)'));
  assert.ok(styles.includes('.modal-media { touch-action: none; }'));
});
