'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { assertCleanElectronStderr } = require('../test-support/electron-stderr.cjs');

const execFileAsync = promisify(execFile);

async function runProbe() {
  const electron = require('electron');
  const runner = require.resolve('../test-support/review-bugfixes-probe.cjs');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout, stderr } = await execFileAsync(electron, ['--disable-logging', runner], { env, timeout: 25000 });
  assertCleanElectronStderr(assert, stderr, 'review bugfixes probe');
  const line = stdout.split('\n').find(entry => entry.startsWith('EAGLEMV_REVIEW_FIXES '));
  assert.ok(line, `missing review fixes result: ${stdout}`);
  return JSON.parse(line.slice('EAGLEMV_REVIEW_FIXES '.length));
}

test('adding a tag keeps the current multi-selection', { timeout: 30000 }, async () => {
  const result = await runProbe();
  assert.deepEqual(result.beforeTag, ['item-1', 'item-2']);
  assert.deepEqual(result.afterTag, ['item-1', 'item-2']);
  assert.deepEqual(result.afterContextTag, ['item-1', 'item-2'], 'context-menu tag keeps selection');
  assert.deepEqual(result.afterPasteTag, ['item-1', 'item-2'], 'pasted tags keep selection');
  assert.deepEqual(result.afterPartialTag, ['item-2'], 'partial failure selects only the failed item');
  assert.deepEqual(result.afterFilteredTag, [], 'items that leave a filtered view do not remain ghost-selected');
});

test('grid arrows use an endpoint without an anchor and the focused card during multi-select', { timeout: 30000 }, async () => {
  const result = await runProbe();
  assert.deepEqual(result.noSelectionRight, ['item-1'], 'right starts at the first card');
  assert.deepEqual(result.noSelectionLeft, ['pdf-1'], 'left starts at the last card');
  assert.deepEqual(result.noSelectionDown, ['item-1'], 'down starts at the first card');
  assert.deepEqual(result.noSelectionUp, ['pdf-1'], 'up starts at the last card');
  assert.deepEqual(result.multiFocusRight, ['item-4'], 'multi-select continues from the focused card');
  assert.deepEqual(result.multiWithoutFocusRight, ['item-1'], 'multi-select without a focused card uses the directional endpoint');
});

test('only image preview consumes the wheel event', { timeout: 30000 }, async () => {
  const result = await runProbe();
  assert.equal(result.imageWheelAllowed, false, 'image wheel is consumed for zooming');
  assert.notEqual(result.wheelDebug.imageWheel.before.scale, result.wheelDebug.imageWheel.scaleAfter, 'image wheel changes zoom');
  assert.equal(result.textWheelAllowed, true, 'TXT keeps native scrolling');
  assert.equal(result.pdfWheelAllowed, true, 'PDF keeps native scrolling');
});

test('external files dropped on folder cards and tree rows import into that folder', { timeout: 30000 }, async () => {
  const result = await runProbe();
  assert.deepEqual(result.imports.map(call => ({ folderId: call.folderId, paths: call.paths })), [
    { folderId: 'target-folder', paths: ['/tmp/card.png'] },
    { folderId: 'target-folder', paths: ['/tmp/tree.png'] },
    { folderId: 'target-folder', paths: [{ name: 'web.png', type: 'image/png', size: 42 }] },
    { folderId: 'target-folder', paths: ['/tmp/pane.png'] }
  ]);
  assert.deepEqual(result.hovers, {
    cardHover: { dropEffect: 'copy', highlighted: true },
    treeHover: { dropEffect: 'copy', highlighted: true },
    webFileHover: { dropEffect: 'copy', highlighted: true }
  });
});
