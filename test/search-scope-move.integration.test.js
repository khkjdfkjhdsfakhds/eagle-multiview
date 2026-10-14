'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

test('moving or removing folder search results leaves the whole searched subtree', { timeout: 30000 }, async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('electron'), ['--disable-logging', require.resolve('../test-support/search-scope-move-probe.cjs')], { env, timeout: 25000 });
  const line = stdout.split('\n').find(entry => entry.startsWith('EAGLEMV_SEARCH_SCOPE '));
  assert.ok(line, `missing search scope result: ${stdout}`);
  const result = JSON.parse(line.slice('EAGLEMV_SEARCH_SCOPE '.length));
  assert.deepEqual(result.listed, ['c', 'd', 'e', 'f', 'g', 'h', 'k', 'p'], 'folder search lists the subtree');
  assert.deepEqual(result.removable, { c: false, d: true }, 'remove-only is offered when the item stays filed outside the subtree');
  assert.deepEqual(result.folders, {
    p: ['parent'],
    c: ['target'],
    d: ['outside', 'target'],
    e: ['outside'],
    f: ['target'],
    h: ['target'],
    k: ['child'],
    g: ['child']
  });
  assert.equal(result.keptInView, true, 'moving within the searched subtree keeps the result listed');
  assert.deepEqual(result.scope, ['child', 'deep', 'parent']);
  assert.deepEqual(result.dropScope, ['child', 'deep', 'parent'], 'cross-pane drop takes the source pane scope');
  assert.deepEqual(result.plainScope, ['parent'], 'plain browsing only leaves the open folder');
});
