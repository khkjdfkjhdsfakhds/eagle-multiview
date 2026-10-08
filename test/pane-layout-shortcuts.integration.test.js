'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

test('Command+1 through Command+4 choose the matching column count without stealing editor keys', { timeout: 20000 }, async () => {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('electron'), ['--disable-logging', require.resolve('../test-support/interaction-regression-probe.cjs'), '--scenario=paneCountShortcuts'], { env, timeout: 18000 });
  const line = stdout.split('\n').find(row => row.startsWith('INTERACTION_AUDIT '));
  assert.ok(line, stdout);
  const result = JSON.parse(line.slice(18));
  assert.ok(!result.error, result.error);
  assert.deepEqual(result.result.layouts, [
    { layout: 'single', count: 1 }, { layout: 'vertical2', count: 2 },
    { layout: 'vertical3', count: 3 }, { layout: 'vertical4', count: 4 }
  ]);
  assert.equal(result.result.editingLayout, 'vertical4');
  assert.equal(result.result.guardedLayout, 'vertical4');
  assert.equal(result.result.final, 'single');
});
