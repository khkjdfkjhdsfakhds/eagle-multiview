'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const gestures = require('../src/grid-gestures.js');

const root = path.join(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'src', 'styles.css'), 'utf8');
const indexHTML = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');

test('pull offset resists the finger and stops before the banner leaves the pane', () => {
  assert.strictEqual(gestures.pullOffset(0), 0);
  assert.strictEqual(gestures.pullOffset(-40), 0, 'upward drags never pull');
  assert.strictEqual(gestures.pullOffset(40), 20, 'the banner travels half the finger distance');
  assert.strictEqual(gestures.pullOffset(400), gestures.PULL_MAX, 'a long drag saturates');
  assert.strictEqual(gestures.pullOffset(Number.NaN), 0);
});

test('pull arms exactly at the trigger distance', () => {
  assert.strictEqual(gestures.pullArmed(gestures.PULL_TRIGGER - 1), false);
  assert.strictEqual(gestures.pullArmed(gestures.PULL_TRIGGER), true);
  // The trigger has to be reachable before the offset saturates, or the
  // gesture could never fire.
  assert.ok(gestures.PULL_TRIGGER <= gestures.PULL_MAX);
  assert.strictEqual(gestures.pullArmed(Number.NaN), false);
});

test('pull opacity fades in and clamps', () => {
  assert.strictEqual(gestures.pullOpacity(0), 0);
  assert.strictEqual(gestures.pullOpacity(13), .5);
  assert.strictEqual(gestures.pullOpacity(26), 1);
  assert.strictEqual(gestures.pullOpacity(90), 1);
});

test('thumbnail size clamps to the slider bounds and rounds to whole pixels', () => {
  assert.strictEqual(gestures.clampThumbnailSize(10), gestures.THUMB_MIN);
  assert.strictEqual(gestures.clampThumbnailSize(9999), gestures.THUMB_MAX);
  assert.strictEqual(gestures.clampThumbnailSize(168.4), 168);
  assert.strictEqual(gestures.clampThumbnailSize('200'), 200);
  assert.strictEqual(gestures.clampThumbnailSize(undefined), gestures.THUMB_DEFAULT);
  // The slider in index.html is the other half of this contract.
  assert.ok(indexHTML.includes(`min="${gestures.THUMB_MIN}" max="${gestures.THUMB_MAX}" value="${gestures.THUMB_DEFAULT}"`));
});

test('keyboard thumbnail step moves by THUMB_STEP and clamps to the same bounds', () => {
  assert.ok(Number.isInteger(gestures.THUMB_STEP) && gestures.THUMB_STEP > 0);
  assert.strictEqual(gestures.stepThumbnailSize(gestures.THUMB_DEFAULT, 1), gestures.THUMB_DEFAULT + gestures.THUMB_STEP);
  assert.strictEqual(gestures.stepThumbnailSize(gestures.THUMB_DEFAULT, -1), gestures.THUMB_DEFAULT - gestures.THUMB_STEP);
  assert.strictEqual(gestures.stepThumbnailSize(gestures.THUMB_MAX, 1), gestures.THUMB_MAX, 'plus never exceeds the max');
  assert.strictEqual(gestures.stepThumbnailSize(gestures.THUMB_MIN, -1), gestures.THUMB_MIN, 'minus never drops below the min');
});

test('pinch scales thumbnails with the finger spread', () => {
  assert.strictEqual(gestures.pinchThumbnailSize(120, 100, 200), 240, 'spreading doubles the size');
  assert.strictEqual(gestures.pinchThumbnailSize(240, 200, 100), 120, 'closing halves it');
  assert.strictEqual(gestures.pinchThumbnailSize(168, 100, 100), 168, 'holding still keeps the size');
  assert.strictEqual(gestures.pinchThumbnailSize(168, 0, 200), 168, 'a degenerate start spread is a no-op');
  assert.strictEqual(gestures.pinchThumbnailSize(168, 100, 0), 168, 'a degenerate live spread is a no-op');
  assert.strictEqual(gestures.pinchThumbnailSize(250, 100, 400), gestures.THUMB_MAX, 'the result stays clamped');
});

test('spread measures the distance between the first two touches', () => {
  assert.strictEqual(gestures.spread([{ clientX: 0, clientY: 0 }, { clientX: 3, clientY: 4 }]), 5);
  assert.strictEqual(gestures.spread([{ clientX: 0, clientY: 0 }]), 0, 'one finger has no spread');
  assert.strictEqual(gestures.spread(null), 0);
});

test('the grid binds pull-to-refresh and pinch resize to native touch events', () => {
  assert.ok(indexHTML.includes('<script src="grid-gestures.js"></script>'), 'the module ships to the renderer and the web client');
  assert.ok(indexHTML.indexOf('grid-gestures.js') < indexHTML.indexOf('renderer.js'), 'it loads before the renderer reads it');
  assert.ok(renderer.includes('bindGridTouchGestures(paneId, scroller, cancelLongPress);'));
  assert.ok(renderer.includes("scroller.addEventListener('touchmove'"), 'touch events, not pointer events');
  assert.ok(renderer.includes('{ passive: false }'), 'touchmove can preventDefault');
  assert.ok(renderer.includes("refresh({ reset: true, preserveScroll: false, paneId })"), 'an armed pull reloads from the top');
  assert.ok(renderer.includes('suppressTouchClickUntil = Date.now() + 400;'), 'a pull is not a blank-space tap');
  assert.ok(styles.includes('.grid-scroller { touch-action: pan-y; }'), 'pinch-zoom belongs to the grid, scrolling stays native');
  assert.ok(styles.includes('.pull-refresh {'));
});

test('every thumbnail-size driver goes through the shared clamp', () => {
  assert.ok(renderer.includes('function applyThumbnailSize(size, { persist = true } = {}) {'));
  assert.ok(renderer.includes('const clamped = gestures.clampThumbnailSize(size);'));
  assert.ok(renderer.includes("$('#sizeSlider').addEventListener('input', event => applyThumbnailSize(event.target.value));"));
  assert.ok(renderer.includes('applyThumbnailSize(thumbnailSize, { persist: false })'), 'restore on launch reuses it');
  // Nothing may poke --thumb behind applyThumbnailSize's back.
  const pokes = renderer.match(/setProperty\('--thumb'/g) || [];
  assert.strictEqual(pokes.length, 1, 'only applyThumbnailSize writes --thumb');
});

test('Cmd/Ctrl +/- drive the middle-grid thumbnail size, not whole-window zoom', () => {
  // The shortcuts route through the same applyThumbnailSize path as the slider,
  // so the toolbar slider stays in sync, and the side columns are untouched.
  assert.ok(renderer.includes("event.code === 'Equal' || event.code === 'NumpadAdd'"));
  assert.ok(renderer.includes("event.code === 'Minus' || event.code === 'NumpadSubtract'"));
  assert.ok(renderer.includes("event.code === 'Digit0' || event.code === 'Numpad0'"));
  assert.ok(renderer.includes('changeThumbnailSize(1)'));
  assert.ok(renderer.includes('changeThumbnailSize(-1)'));
  assert.ok(renderer.includes('resetThumbnailSize()'));
  assert.ok(renderer.includes('gestures.stepThumbnailSize(currentThumbnailSize(), direction)'), 'the shortcut uses the shared step function');
  // The old whole-window zoom plumbing is fully removed.
  for (const dead of ['setUIZoom', 'changeUIZoom', 'restoreUIZoom', 'setZoomFactor', 'UI_ZOOM_MIN', 'UI_ZOOM_MAX', 'UI_ZOOM_STEP', 'eaglemv.uiZoom', "hasCapability('uiZoom')"]) {
    assert.ok(!renderer.includes(dead), `renderer 不应再残留 ${dead}`);
  }
});
