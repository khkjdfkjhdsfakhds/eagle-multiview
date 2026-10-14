'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

async function probe(count) {
  const env = { ...process.env, EAGLEMV_SELECT_ALL_COUNT: String(count) };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('electron'), ['--disable-logging', require.resolve('../test-support/select-all-probe.cjs')], { env, timeout: 25000 });
  const line = stdout.split('\n').find(entry => entry.startsWith('EAGLEMV_SELECT_ALL '));
  assert.ok(line, `missing select all result: ${stdout}`);
  return JSON.parse(line.slice('EAGLEMV_SELECT_ALL '.length));
}

test('⌘A selects the whole view, not just the loaded page', { timeout: 30000 }, async () => {
  const result = await probe(400);
  assert.equal(result.firstPage, 160);
  assert.equal(result.selected, 400);
  assert.match(result.toast, /已全选 400 个素材/);
});

test('⌘A in a view beyond the load cap says how much it selected', { timeout: 30000 }, async () => {
  const result = await probe(3500);
  assert.ok(result.selected >= 3000 && result.selected < 3500, `selected ${result.selected}`);
  assert.equal(result.selected, result.loaded);
  assert.match(result.toast, /已全选前 .* 个素材（当前视图共 3,500 个），超出部分请分批操作/);
});
