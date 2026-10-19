'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

async function probe(count, extra = {}) {
  const env = { ...process.env, ...extra, EAGLEMV_SELECT_ALL_COUNT: String(count) };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('../test-support/electron-binary.cjs'), ['--disable-logging', require.resolve('../test-support/select-all-probe.cjs')], { env, timeout: 25000 });
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

test('⌘A beyond the load cap selects the rest of the view by id (P6-02)', { timeout: 30000 }, async () => {
  const result = await probe(3500);
  assert.ok(result.loaded >= 3000 && result.loaded < 3500, `loaded ${result.loaded}`);
  assert.equal(result.selected, 3500);
  assert.match(result.toast, /已全选 3,500 个素材/);
  assert.equal(result.count, '3,500');
  assert.match(result.meta, /3\.4 MB/);
  assert.equal(result.summaryRequests, 1);
});

test('⌘A falls back to the loaded range when the view cannot be listed', { timeout: 30000 }, async () => {
  const result = await probe(3500, { EAGLEMV_SELECT_ALL_NO_IDS: '1' });
  assert.ok(result.selected >= 3000 && result.selected < 3500, `selected ${result.selected}`);
  assert.equal(result.selected, result.loaded);
  assert.match(result.toast, /已全选前 .* 个素材（当前视图共 3,500 个），超出部分请分批操作/);
});

test('a batch after ⌘A writes every id of the view and keeps them selected', { timeout: 40000 }, async () => {
  const result = await probe(3500, { EAGLEMV_SELECT_ALL_RATE: '1' });
  assert.equal(result.mutated, 3500);
  assert.equal(result.afterRate, 3500);
  assert.match(result.rateToast, /已设置为 3 星/);
});
