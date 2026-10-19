'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

test('⌘C in the preview copies the viewed item', { timeout: 30000 }, async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('../test-support/electron-binary.cjs'), ['--disable-logging', require.resolve('../test-support/preview-copy-probe.cjs')], { env, timeout: 25000 });
  const line = stdout.split('\n').find(entry => entry.startsWith('EAGLEMV_PREVIEW_COPY '));
  assert.ok(line, `missing preview copy result: ${stdout}`);
  const result = JSON.parse(line.slice('EAGLEMV_PREVIEW_COPY '.length));
  assert.deepEqual(result.paged, ['b'], 'select A, page the preview to B: ⌘C copies B');
  assert.deepEqual(result.unselected, ['c'], 'a preview opened with nothing selected still copies');
  assert.deepEqual(result.grid, ['a'], 'outside the preview ⌘C copies the selection');
});
