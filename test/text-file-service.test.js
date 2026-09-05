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
  // The external Eagle API boundary is simulated only on this synthetic file.
  const replaceFile = async ({ stagedPath }) => {
    await fs.copyFile(stagedPath, filePath);
    return { status: 'saved' };
  };
  return { root, libraryPath, item, filePath, backupRoot, replaceFile };
}

test('saves UTF-8 TXT through the official replacement boundary with a recovery backup', async t => {
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

test('does not directly write a library when the official bridge is missing', async t => {
  const data = await fixture();
  t.after(() => fs.rm(data.root, { recursive: true, force: true }));
  const first = await readText(data);
  await assert.rejects(saveText({ ...data, replaceFile: undefined, content: 'must stay a draft', base: first.fingerprint }), /后台插件/);
  assert.equal((await readText(data)).content, '第一版\n');
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

test('DA-03: simultaneous editors on one baseline get one save and one conflict', async t => {
  const data = await fixture();
  t.after(() => fs.rm(data.root, { recursive: true, force: true }));
  const first = await readText(data);
  let release;
  const firstFinished = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const replaceFile = async request => {
    if (++calls === 1) await new Promise(resolve => setTimeout(resolve, 20));
    else await firstFinished;
    return data.replaceFile(request);
  };
  const a = saveText({ ...data, replaceFile, content: 'writer A', base: first.fingerprint });
  a.finally(release).catch(() => {});
  const b = saveText({ ...data, replaceFile, content: 'writer B', base: first.fingerprint });
  const results = await Promise.all([a, b]);
  assert.deepEqual(results.map(result => result.conflict), [false, true]);
  assert.equal((await readText(data)).content, 'writer A');
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

test('empty content remains an explicit draft and a failed bridge does not poison the save queue', async t => {
  const data = await fixture();
  t.after(() => fs.rm(data.root, { recursive: true, force: true }));
  const first = await readText(data);
  await assert.rejects(saveText({ ...data, content: '', base: first.fingerprint }), /空正文/);
  await assert.rejects(saveText({ ...data, content: 'failed', base: first.fingerprint, replaceFile: async () => { throw new Error('Plugin offline'); } }), /Plugin offline/);
  assert.equal((await readText(data)).content, '第一版\n');
  const saved = await saveText({ ...data, content: 'retry kept', base: first.fingerprint });
  assert.equal(saved.conflict, false);
});

test('preserves an existing UTF-8 BOM and never stages or backs up inside a library', async t => {
  const data = await fixture();
  t.after(() => fs.rm(data.root, { recursive: true, force: true }));
  await fs.writeFile(data.filePath, Buffer.from('\uFEFFfirst', 'utf8'));
  const initial = await readText(data);
  await saveText({ ...data, base: initial.fingerprint, content: 'second' });
  assert.deepEqual(await fs.readFile(data.filePath), Buffer.from('\uFEFFsecond', 'utf8'));
  const current = await readText(data);
  await assert.rejects(saveText({ ...data, base: current.fingerprint, content: 'third', backupRoot: path.join(data.libraryPath, 'bad-backups') }), /备份.*资料库/);
  assert.equal((await readText(data)).content, 'second');
});

test('autosave retains bounded distinct recovery versions outside the library', async t => {
  const data = await fixture();
  t.after(() => fs.rm(data.root, { recursive: true, force: true }));
  let saved;
  for (let i = 0; i < 23; i++) {
    const current = await readText(data);
    saved = await saveText({ ...data, base: current.fingerprint, content: `version ${i}` });
  }
  const backups = await fs.readdir(path.dirname(saved.backupPath));
  assert.equal(backups.length, 20);
  assert.equal(await fs.readFile(saved.backupPath, 'utf8'), 'version 21');
  assert.deepEqual(await fs.readdir(path.join(data.backupRoot, 'staging')), []);
});
