'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

test('⌘Z undoes typing in a focused field, is ignored behind a dialog, and otherwise runs the last notice\'s 撤销 once', { timeout: 30000 }, async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('../test-support/electron-binary.cjs'), ['--disable-logging', require.resolve('../test-support/undo-routing-probe.cjs')], { env, timeout: 25000 });
  const line = stdout.split('\n').find(entry => entry.startsWith('EAGLEMV_UNDO_ROUTING '));
  assert.ok(line, `missing undo routing result: ${stdout}`);
  const result = JSON.parse(line.slice('EAGLEMV_UNDO_ROUTING '.length));
  assert.equal(result.typed, 'abc');
  assert.equal(result.afterUndo, '', 'text undo restores the field');
  assert.deepEqual(result.behindDialog, [], 'nothing happens behind an open dialog');
  assert.deepEqual(result.afterPlain, ['typing'], 'otherwise ⌘Z runs the 撤销 of the last notice');
  assert.deepEqual(result.afterSecond, ['typing'], 'Eagle keeps one undo; a second ⌘Z does nothing');
  assert.deepEqual(result.afterReplaced, ['typing'], 'a later notice takes the undo\'s place');
  assert.equal(result.linkText, '撤销');
  assert.equal(result.clickable, 'auto');
  assert.deepEqual(result.afterLink, ['typing', 'link']);
  assert.equal(result.hiddenAfterLink, true);
  assert.deepEqual(result.final, ['typing', 'link'], 'an expired undo does nothing');
});
