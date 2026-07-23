'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { readText, saveText } = require('../lib/text-file-service');

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaglemv-text-'));
  const libraryPath = path.join(root, 'Mock.library');
  const item = { id: 'ITEM1', name: '说明', ext: 'txt' };
  const infoDir = path.join(libraryPath, 'images', `${item.id}.info`);
  const filePath = path.join(infoDir, '说明.txt');
  const backupRoot = path.join(root, 'backups');
  await fs.mkdir(infoDir, { recursive: true });
  await fs.writeFile(filePath, '第一版\n', 'utf8');
  return { root, libraryPath, item, filePath, backupRoot };
}

test('reads and atomically saves UTF-8 TXT with a recovery backup', async t => {
  const data = await fixture();
  t.after(() => fs.rm(data.root, { recursive: true, force: true }));
  const first = await readText(data);
  assert.equal(first.content, '第一版\n');
  const saved = await saveText({ ...data, content: '第二版\n', base: first.fingerprint });
  assert.equal(saved.conflict, false);
  assert.equal(await fs.readFile(data.filePath, 'utf8'), '第二版\n');
  assert.equal(await fs.readFile(saved.backupPath, 'utf8'), '第一版\n');
  assert.equal((await fs.readdir(path.dirname(data.filePath))).some(name => name.includes('.eaglemv-')), false);
});

test('detects another window changing the TXT before save', async t => {
  const data = await fixture();
  t.after(() => fs.rm(data.root, { recursive: true, force: true }));
  const first = await readText(data);
  await fs.writeFile(data.filePath, '外部修改\n', 'utf8');
  const result = await saveText({ ...data, content: '当前窗口修改\n', base: first.fingerprint });
  assert.equal(result.conflict, true);
  assert.equal(result.current.content, '外部修改\n');
  assert.equal(await fs.readFile(data.filePath, 'utf8'), '外部修改\n');
});

test('refuses non-TXT and paths outside the current Eagle library', async t => {
  const data = await fixture();
  t.after(() => fs.rm(data.root, { recursive: true, force: true }));
  await assert.rejects(() => readText({ ...data, item: { ...data.item, ext: 'md' } }), /仅支持编辑 TXT/);
  const outside = path.join(data.root, 'outside.txt');
  await fs.writeFile(outside, 'no', 'utf8');
  await assert.rejects(() => readText({ ...data, filePath: outside }), /不在当前 Eagle 资料库/);
});

test('refuses binary or oversized files', async t => {
  const data = await fixture();
  t.after(() => fs.rm(data.root, { recursive: true, force: true }));
  await fs.writeFile(data.filePath, Buffer.from([65, 0, 66]));
  await assert.rejects(() => readText(data), /二进制/);
  await fs.writeFile(data.filePath, '123456', 'utf8');
  await assert.rejects(() => readText({ ...data, maxBytes: 4 }), /超过/);
});
