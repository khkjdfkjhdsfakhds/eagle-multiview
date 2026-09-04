'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { assertCleanElectronStderr } = require('../test-support/electron-stderr.cjs');

const execFileAsync = promisify(execFile);

test('sync panes only while previewing; grid selection and mutations stay pane-local', { timeout: 30000 }, async () => {
  const electron = require('electron');
  const runner = require.resolve('../test-support/sync-panes-probe.cjs');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout, stderr } = await execFileAsync(electron, ['--disable-logging', runner], { env, timeout: 25000 });
  assertCleanElectronStderr(assert, stderr, 'sync panes probe');
  const line = stdout.split('\n').find(entry => entry.startsWith('EAGLEMV_SYNC '));
  assert.ok(line, `missing sync panes result: ${stdout}`);
  const result = JSON.parse(line.slice('EAGLEMV_SYNC '.length));

  // Baseline: nothing selected/previewed before the interactions.
  assert.equal(result.before.pane0.preview, null);
  assert.equal(result.before.pane1.preview, null);
  assert.equal(result.before.pane0.selected.length, 0);
  assert.equal(result.before.pane1.selected.length, 0);

  // A touch (pointerType=touch) tap previews the card and the sibling pane
  // follows the same preview.
  assert.equal(result.afterTap.pane0.preview, 'item-2', 'active pane previewed the tapped card');
  assert.equal(result.afterTap.pane1.preview, 'item-2', 'sibling pane synced the touch-tap preview');

  // Pressing next in the active pane advances both panes to the same item.
  assert.equal(result.afterNext.pane0.preview, 'item-3', 'active pane advanced to next preview');
  assert.equal(result.afterNext.pane1.preview, 'item-3', 'sibling pane synced the preview navigation');

  assert.equal(result.afterInitialClose.pane0.preview, null, 'active pane closed its preview');
  assert.equal(result.afterInitialClose.pane1.preview, null, 'sibling pane synced preview close');

  // A plain desktop-style click changes only the active pane. Independent
  // selections are required to compare two items from the same path.
  assert.deepEqual(result.afterDesktopSelect.pane0.selected, ['item-4'], 'active pane selected the clicked card');
  assert.deepEqual(result.afterDesktopSelect.pane1.selected, [], 'sibling pane kept its selection');

  assert.deepEqual(result.afterIndependentSelect.pane0.selected, ['item-4'], 'first pane kept item A selected');
  assert.deepEqual(result.afterIndependentSelect.pane1.selected, ['item-5'], 'second pane independently selected item B');

  assert.equal(result.gridRating.item4, 0, 'grid rating did not broadcast to the sibling selection');
  assert.equal(result.gridRating.item5, 2, 'grid rating applied to the active pane selection');

  assert.equal(result.afterPreviewOpen.pane0.preview, 'item-2', 'sibling pane synced preview open');
  assert.equal(result.afterPreviewOpen.pane1.preview, 'item-2', 'active pane opened preview');
  assert.equal(result.afterPreviewNext.pane0.preview, 'item-3', 'sibling pane synced preview navigation');
  assert.equal(result.afterPreviewNext.pane1.preview, 'item-3', 'active pane advanced preview');
  assert.equal(result.previewRating.pane0, 4, 'shared item state reflected the preview rating');
  assert.equal(result.previewRating.pane1, 4, 'active preview applied the rating');
  assert.equal(result.afterPreviewClose.pane0.preview, null, 'sibling pane synced preview close');
  assert.equal(result.afterPreviewClose.pane1.preview, null, 'active pane closed preview');
  assert.deepEqual(result.afterPreviewClose.pane0.selected, ['item-4'], 'sibling pane retained item A');
  assert.deepEqual(result.afterPreviewClose.pane1.selected, ['item-3'], 'active pane alone selected the final preview item');
});
