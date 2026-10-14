'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

test('a pane opened by a split uses the remembered sort of its folder', { timeout: 30000 }, async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('electron'), ['--disable-logging', require.resolve('../test-support/new-pane-sort-probe.cjs')], { env, timeout: 25000 });
  const line = stdout.split('\n').find(entry => entry.startsWith('EAGLEMV_NEW_PANE_SORT '));
  assert.ok(line, `missing new pane sort result: ${stdout}`);
  const panes = JSON.parse(line.slice('EAGLEMV_NEW_PANE_SORT '.length));
  assert.equal(panes.length, 2);
  for (const pane of panes) assert.deepEqual(pane, { view: 'mv-folder', sort: 'name', sortDir: 'desc' });
});
