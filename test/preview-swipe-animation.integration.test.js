'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { assertCleanElectronStderr } = require('../test-support/electron-stderr.cjs');

const execFileAsync = promisify(execFile);

test('swiping the preview drags the neighbour in beside it, photo-album style', { timeout: 30000 }, async () => {
  const electron = require('../test-support/electron-binary.cjs');
  const runner = require.resolve('../test-support/preview-swipe-probe.cjs');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout, stderr } = await execFileAsync(electron, ['--disable-logging', runner], { env, timeout: 25000 });
  assertCleanElectronStderr(assert, stderr, 'preview swipe probe');
  const line = stdout.split('\n').find(entry => entry.startsWith('EAGLEMV_SWIPE '));
  assert.ok(line, `missing preview swipe result: ${stdout}`);
  const result = JSON.parse(line.slice('EAGLEMV_SWIPE '.length));
  const slot = result.width + 24;

  assert.equal(result.dragLeft.image, 'translateX(-100px)', 'the image follows the finger');
  assert.match(result.dragLeft.peek.src, /item-4/, 'dragging left brings in the next item');
  assert.equal(result.dragLeft.peek.transform, `translateX(${slot - 100}px)`, 'the next item rides in from the right edge');
  assert.match(result.dragRight.peek.src, /item-2/, 'dragging back right brings in the previous item');
  assert.equal(result.dragRight.peek.transform, `translateX(${100 - slot}px)`, 'the previous item rides in from the left edge');

  assert.deepEqual(result.springBack, { preview: 'item-3', image: '', peek: false }, 'a short slow drag springs back');

  assert.equal(result.flickMid.preview, 'item-3', 'the item switches only after the slide');
  assert.equal(result.flickMid.peek, true, 'the neighbour stays on screen while sliding in');
  assert.equal(result.flickMid.animations, 1, 'the current image is sliding out');
  assert.equal(result.flick, 'item-4', 'a quick flick turns one page');
  assert.equal(result.far, 'item-5', 'a long drag turns one page');

  assert.deepEqual(result.frozen, { preview: 'item-6', peek: false }, 'a stalled animation still finishes the turn');
  assert.deepEqual(result.endDrag, { image: 'translateX(-70px)', peek: false }, 'past the last item the drag rubber-bands with nothing to show');
  assert.deepEqual(result.end, { preview: 'item-6', image: '' }, 'and springs back without turning');
});
