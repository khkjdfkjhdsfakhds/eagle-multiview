'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

test('folder copy is offered from the context menu and every copy asks first (F-03)', { timeout: 30000 }, async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('../test-support/electron-binary.cjs'), ['--disable-logging', require.resolve('../test-support/folder-copy-confirm-probe.cjs')], { env, timeout: 25000 });
  const line = stdout.split('\n').find(entry => entry.startsWith('EAGLEMV_FOLDER_COPY_CONFIRM '));
  assert.ok(line, `missing folder copy result: ${stdout}`);
  const result = JSON.parse(line.slice('EAGLEMV_FOLDER_COPY_CONFIRM '.length));
  assert.equal(result.menuEntry, '复制文件夹…');
  assert.equal(result.excludesSubtree, true, 'the picker leaves out the folder and its descendants');
  assert.equal(result.defaultTarget, '', 'the default destination is the source folder’s own parent');
  assert.match(result.summary, /2 个文件夹、3 个素材/);
  assert.equal(result.copiedBeforeConfirm, 0);
  assert.deepEqual(result.menuPayload, { sourceId: 'mv-folder', parentId: 'eagle-folder', libraryPath: '/tmp/EagleMV-UI-Test.library' });
  assert.equal(result.edgeFeedback, 'vertical-before');
  assert.match(result.edgeText, /放在“Eagle 文件夹”之前/);
  assert.deepEqual(result.edgePayload, { sourceId: 'mv-folder', parentId: null, libraryPath: '/tmp/EagleMV-UI-Test.library', anchorId: 'eagle-folder', position: 'before' });
});
