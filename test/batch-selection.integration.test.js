'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

test('batch writes keep a selection changed meanwhile and release their lock before refreshing', { timeout: 30000 }, async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('electron'), ['--disable-logging', require.resolve('../test-support/batch-selection-probe.cjs')], { env, timeout: 25000 });
  const line = stdout.split('\n').find(entry => entry.startsWith('EAGLEMV_BATCH_SELECTION '));
  assert.ok(line, `missing batch selection result: ${stdout}`);
  const result = JSON.parse(line.slice('EAGLEMV_BATCH_SELECTION '.length));
  assert.equal(result.secondStartedDuringRefresh, true, 'a second rating is not blocked by the first one’s refresh');
  assert.deepEqual(result.ratingSelection, ['b'], 'rating A does not pull the selection back from B');
  assert.deepEqual(result.ratingStars, { a: 3, b: 4 });
  assert.equal(result.repeatStar, 5, 'the later of two quick ratings wins');
  assert.deepEqual(result.repeatWrites, [2, 5]);
  assert.deepEqual(result.tagSelection, ['c'], 'adding a tag does not pull the selection back');
  assert.deepEqual(result.trashSelection, ['a'], 'trashing does not clear a selection made meanwhile');
  assert.deepEqual(result.rejected, []);
});
