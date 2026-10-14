'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

test('Esc closes popovers and panels innermost first without dropping the selection', { timeout: 30000 }, async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('electron'), ['--disable-logging', require.resolve('../test-support/escape-surfaces-probe.cjs')], { env, timeout: 25000 });
  const line = stdout.split('\n').find(entry => entry.startsWith('EAGLEMV_ESCAPE_SURFACES '));
  assert.ok(line, `missing escape result: ${stdout}`);
  const result = JSON.parse(line.slice('EAGLEMV_ESCAPE_SURFACES '.length));
  assert.equal(result.filterOpened, true);
  assert.deepEqual(result.filter, { open: false, selected: ['a'] }, 'Esc on the filter button closes the panel, not the selection');
  assert.equal(result.managerOpened, true);
  assert.deepEqual(result.afterFirstEsc, { manager: false, filter: true }, 'the tag colour manager closes before its filter panel');
  assert.deepEqual(result.afterSecondEsc, { filter: false });
  assert.equal(result.layoutOpened, true);
  assert.deepEqual(result.layout, { open: false, expanded: 'false' });
  assert.deepEqual(result.library, { open: false, expanded: 'false' });
  assert.deepEqual(result.selectionKept, ['a']);
  assert.deepEqual(result.selectionAfterPlainEsc, [], 'with nothing open Esc still clears the selection');
});
