'use strict';

// Eagle-parity batch 2: wheel zoom anchors on the cursor and continued
// zooming keeps the pan instead of snapping the image back to centre.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');

test('zoom mode keeps the current pan while fit/actual recenter', () => {
  const start = renderer.indexOf('function setPreviewZoom(mode');
  assert.ok(start >= 0);
  const fn = renderer.slice(start, renderer.indexOf('\n}', start));
  assert.ok(fn.includes("const keepPan = mode === 'zoom';"));
  assert.ok(fn.includes('x: keepPan ? state.previewZoom.x : 0'));
  assert.ok(fn.includes('y: keepPan ? state.previewZoom.y : 0'));
});

test('changePreviewZoom applies the cursor-anchor formula only when the scale moves', () => {
  const start = renderer.indexOf('function changePreviewZoom(delta, anchor = null)');
  assert.ok(start >= 0);
  const fn = renderer.slice(start, renderer.indexOf('\n}', start));
  assert.ok(fn.includes('if (anchor && next !== previous)'), 'clamped zoom at min/max must not shift the pan');
  assert.ok(fn.includes('const ratio = next / previous;'));
  assert.ok(fn.includes('state.previewZoom.x = anchor.x - ratio * (anchor.x - state.previewZoom.x);'));
  assert.ok(fn.includes('state.previewZoom.y = anchor.y - ratio * (anchor.y - state.previewZoom.y);'));
});

test('wheel zoom measures the anchor from the container centre', () => {
  const start = renderer.indexOf("$('#modalMedia').addEventListener('wheel'");
  assert.ok(start >= 0);
  const handler = renderer.slice(start, renderer.indexOf('passive: false', start));
  assert.ok(handler.includes('getBoundingClientRect()'));
  assert.ok(handler.includes('event.clientX - box.left - box.width / 2'));
  assert.ok(handler.includes('event.clientY - box.top - box.height / 2'));
  assert.ok(handler.includes('changePreviewZoom(event.deltaY < 0 ? .15 : -.15, anchor)'));
});

test('the anchor formula is mathematically fixed-point at the cursor', () => {
  // Simulate: image point under the cursor must stay put through a zoom step.
  let zoom = { scale: 1, x: 40, y: -20 };
  const anchor = { x: 120, y: 80 };
  const next = 1.6;
  const ratio = next / zoom.scale;
  const pointUnderCursorBefore = { u: (anchor.x - zoom.x) / zoom.scale, v: (anchor.y - zoom.y) / zoom.scale };
  zoom = {
    scale: next,
    x: anchor.x - ratio * (anchor.x - zoom.x),
    y: anchor.y - ratio * (anchor.y - zoom.y)
  };
  const screenX = zoom.x + pointUnderCursorBefore.u * zoom.scale;
  const screenY = zoom.y + pointUnderCursorBefore.v * zoom.scale;
  assert.ok(Math.abs(screenX - anchor.x) < 1e-9);
  assert.ok(Math.abs(screenY - anchor.y) < 1e-9);
});
