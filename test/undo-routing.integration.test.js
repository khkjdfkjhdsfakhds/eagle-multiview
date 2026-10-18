'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

test('⌘Z undoes typing in a focused field, is ignored behind a dialog, and otherwise undoes a delete', { timeout: 30000 }, async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('../test-support/electron-binary.cjs'), ['--disable-logging', require.resolve('../test-support/undo-routing-probe.cjs')], { env, timeout: 25000 });
  const line = stdout.split('\n').find(entry => entry.startsWith('EAGLEMV_UNDO_ROUTING '));
  assert.ok(line, `missing undo routing result: ${stdout}`);
  const result = JSON.parse(line.slice('EAGLEMV_UNDO_ROUTING '.length));
  assert.equal(result.typed, 'abc');
  assert.equal(result.afterUndo, '', 'text undo restores the field');
  assert.deepEqual(result.behindDialog.filter(Boolean), [], 'nothing happens behind an open dialog');
  assert.ok(result.plain.some(text => text.includes('没有可撤销的删除操作')), `grid focus undoes deletes: ${JSON.stringify(result.plain)}`);
});
