'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { loadMain } = require('../test-support/main-data-harness.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaglemv-export-binding-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const libraries = Object.fromEntries(['A', 'B'].map(name => [name, path.join(root, `${name}.library`)]));
  for (const [name, library] of Object.entries(libraries)) {
    for (const id of ['SAME', 'SECOND']) {
      const dir = path.join(library, 'images', `${id}.info`);
      await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, `${id}.txt`), `${name}:${id}`);
    }
  }
  let active = 'A', lookupCalls = 0;
  const dialog = { showOpenDialog: async () => ({ canceled: false, filePaths: [path.join(root, 'export')] }) };
  const main = loadMain(path.join(root, 'user-data'), { dialog });
  main.hub.library = { path: libraries.A, folders: [] };
  main.client.libraryInfo = async () => ({ path: libraries[active], folders: [] });
  main.client.getItem = async id => { lookupCalls++; return { id, name: id, ext: 'txt' }; };
  main.client.fileURLForItem = async (item, library) => pathToFileURL(path.join(library, 'images', `${item.id}.info`, `${item.id}.txt`)).href;
  const selectLibrary = (name, publish = true) => { active = name; if (publish) main.hub.publishLibrarySnapshot({ path: libraries[name], folders: [] }); };
  const invoke = ids => main.rpcRegistry.get('items:export')({ sender: { id: 1 } }, { ids, libraryPath: libraries.A });
  return { root, libraries, main, dialog, selectLibrary, invoke, get lookupCalls() { return lookupCalls; } };
}

async function traceWrites(operation) {
  const originals = { mkdir: fs.mkdir, copyFile: fs.copyFile }, calls = [];
  fs.mkdir = async (...args) => { calls.push({ method: 'mkdir', args }); return originals.mkdir(...args); };
  fs.copyFile = async (...args) => { calls.push({ method: 'copyFile', args }); return originals.copyFile(...args); };
  try { return { result: await operation().catch(error => error), calls }; }
  finally { Object.assign(fs, originals); }
}

for (const target of ['library-B', 'outside']) test(`export fixes its source library before the dialog; a switch rejects ${target} without directory creation or copying`, async t => {
  const f = await fixture(t);
  f.dialog.showOpenDialog = async () => {
    f.selectLibrary('B');
    return { canceled: false, filePaths: [target === 'library-B' ? f.libraries.B : path.join(f.root, 'outside')] };
  };
  const { result, calls } = await traceWrites(() => f.invoke(['SAME']));
  assert.equal(result.code, 'LIBRARY_CHANGED');
  assert.equal(f.lookupCalls, 0);
  assert.deepEqual(calls, []);
  await assert.rejects(fs.stat(path.join(f.libraries.B, 'SAME.txt')), error => error.code === 'ENOENT');
  await assert.rejects(fs.stat(path.join(f.root, 'outside')), error => error.code === 'ENOENT');
});

test('export cancels when native Eagle switches while the hub still shows the previous library', async t => {
  const f = await fixture(t);
  f.dialog.showOpenDialog = async () => { f.selectLibrary('B', false); return { canceled: false, filePaths: [f.libraries.B] }; };
  const { result, calls } = await traceWrites(() => f.invoke(['SAME']));
  assert.equal(result.code, 'LIBRARY_CHANGED'); assert.deepEqual(calls, []);
});

test('multi-ID resolution cannot export its early old-library subset after a later ID crosses libraries', async t => {
  const f = await fixture(t);
  f.main.client.getItem = async id => {
    if (id === 'SECOND') { await new Promise(resolve => setImmediate(resolve)); f.selectLibrary('B'); }
    return { id, name: id, ext: 'txt' };
  };
  const { result, calls } = await traceWrites(() => f.invoke(['SAME', 'SECOND']));
  assert.equal(result.code, 'LIBRARY_CHANGED'); assert.deepEqual(calls, []);
  await assert.rejects(fs.stat(path.join(f.root, 'export')), error => error.code === 'ENOENT');
});

test('a dialog that switches away and back invalidates its old operation epoch', async t => {
  const f = await fixture(t);
  f.dialog.showOpenDialog = async () => {
    f.selectLibrary('B'); f.selectLibrary('A');
    return { canceled: false, filePaths: [path.join(f.root, 'export')] };
  };
  const { result, calls } = await traceWrites(() => f.invoke(['SAME']));
  assert.equal(result.code, 'LIBRARY_CHANGED'); assert.deepEqual(calls, []);
});

test('normal export keeps both selected A files and cancel performs no writes', async t => {
  const f = await fixture(t);
  const result = await f.invoke(['SAME', 'SECOND']);
  assert.equal(result.count, 2); assert.equal(result.missing, 0); assert.equal(result.canceled, false);
  assert.deepEqual(new Set(await Promise.all(result.files.map(file => fs.readFile(file, 'utf8')))), new Set(['A:SAME', 'A:SECOND']));
  f.dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  const cancelled = await traceWrites(() => f.invoke(['SAME']));
  assert.equal(cancelled.result.canceled, true); assert.deepEqual(cancelled.calls, []);
});

test('a switch during destination canonicalization is caught before mkdir', async t => {
  const f = await fixture(t), original = fs.realpath, destination = path.join(f.root, 'export');
  fs.realpath = async (...args) => {
    if (args[0] === destination) f.selectLibrary('B');
    return original(...args);
  };
  let observation;
  try { observation = await traceWrites(() => f.invoke(['SAME'])); }
  finally { fs.realpath = original; }
  assert.equal(observation.result.code, 'LIBRARY_CHANGED'); assert.deepEqual(observation.calls, []);
  await assert.rejects(fs.stat(destination), error => error.code === 'ENOENT');
});

test('a switch after resolving sources but before the actual copy prevents that copy', async t => {
  const f = await fixture(t), original = fs.access;
  fs.access = async (...args) => {
    const result = await original(...args);
    if (String(args[0]).includes(`${path.sep}SAME.info${path.sep}`)) f.selectLibrary('B');
    return result;
  };
  let observation;
  try { observation = await traceWrites(() => f.invoke(['SAME'])); }
  finally { fs.access = original; }
  assert.equal(observation.result.code, 'LIBRARY_CHANGED');
  assert.equal(observation.calls.filter(call => call.method === 'copyFile').length, 0);
  assert.deepEqual(await fs.readdir(path.join(f.root, 'export')), []);
});

for (const failure of ['library-switch', 'disk-error']) test(`an export that stops after its first success reports the preserved partial output: ${failure}`, async t => {
  const f = await fixture(t), original = fs.copyFile;
  let copies = 0;
  fs.copyFile = async (...args) => {
    copies++;
    if (failure === 'disk-error' && copies === 2) { const error = new Error('synthetic disk full'); error.code = 'ENOSPC'; throw error; }
    const result = await original(...args);
    if (failure === 'library-switch' && copies === 1) f.selectLibrary('B');
    return result;
  };
  let result;
  try { result = await f.invoke(['SAME', 'SECOND']).catch(error => error); }
  finally { fs.copyFile = original; }
  assert.equal(result.code, failure === 'library-switch' ? 'LIBRARY_CHANGED' : 'ENOSPC');
  assert.match(result.message, /已导出 1 个.*剩余已停止/);
  assert.equal(result.partial?.count, 1);
  assert.equal(result.partial?.requested, 2);
  assert.equal(result.partial?.files.length, 1);
  assert.equal(await fs.readFile(result.partial.files[0], 'utf8'), 'A:SAME');
  assert.equal(copies, failure === 'library-switch' ? 1 : 2);
  assert.deepEqual(await fs.readdir(path.join(f.root, 'export')), ['SAME.txt']);
  for (const [name, library] of Object.entries(f.libraries)) {
    for (const id of ['SAME', 'SECOND']) assert.equal(await fs.readFile(path.join(library, 'images', `${id}.info`, `${id}.txt`), 'utf8'), `${name}:${id}`);
  }
});
