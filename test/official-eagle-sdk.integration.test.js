'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { readText, saveText } = require('../lib/text-file-service');
const { createTextPluginBridge } = require('../lib/text-plugin-bridge');
const { createSaveHandler } = require('../eagle-plugin/text-save-service/save-handler');
const archive = '/Applications/Eagle.app/Contents/Resources/app.asar';

test('local official SDK: client queue → authenticated HTTP → plugin → original replaceFile on synthetic files', { skip: !fs.existsSync(archive) }, async t => {
  const asar = require('../node_modules/.pnpm/@electron+asar@3.4.1/node_modules/@electron/asar');
  const source = asar.extractFile(archive, 'app/js/plugin/model/item.js').toString('utf8');
  console.log('Official Item SDK SHA-256:', crypto.createHash('sha256').update(source).digest('hex'));
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'eaglemv-official-sdk-')));
  const libraryPath = path.join(root, 'Synthetic.library');
  const filePath = path.join(libraryPath, 'images', 'SYNTHETIC.info', 'fixture.txt');
  const backupRoot = path.join(root, 'userdata', 'Text Backups');
  const stagingRoot = path.join(backupRoot, 'staging');
  const directory = path.join(root, 'userdata', 'TXT Bridge');
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, 'original');
  const ipc = new EventEmitter();
  const calls = [];
  ipc.r2r = async (_parent, method, data) => {
    assert.equal(method, 'item.refreshThumbnail', 'Real IPC, selection and activation are never permitted in this fixture');
    calls.push(method);
    const id = typeof data === 'string' ? data : data.itemId;
    setImmediate(() => ipc.emit(`file-thumbnail-success-${id}`, {}, { id }));
    return true;
  };
  const guard = value => {
    assert.ok(path.resolve(String(value)).startsWith(`${root}${path.sep}`), 'SDK path escaped the synthetic test directory');
    return value;
  };
  const safeFs = { existsSync: value => fs.existsSync(guard(value)), statSync: value => fs.statSync(guard(value)), promises: {
    unlink: value => fsp.unlink(guard(value)),
    rename: (from, to) => fsp.rename(guard(from), guard(to)),
    copyFile: (from, to) => fsp.copyFile(guard(from), guard(to))
  } };
  const eagle = { library: { path: libraryPath }, log: { info() {}, error() {} } };
  const sandbox = { module: { exports: {} }, eagle, global: { parentID: 'SYNTHETIC_PARENT' }, console, require: name => {
    if (name === 'electron') return { ipcRenderer: ipc };
    if (name === 'fs') return safeFs;
    if (name === 'path') return path;
    if (name === 'url') return require('node:url');
    throw new Error(`Unexpected SDK dependency: ${name}`);
  } };
  vm.runInNewContext(source, sandbox, { filename: 'official-installed-sdk:item.js' });
  const item = new sandbox.module.exports({ id: 'SYNTHETIC', name: 'fixture', ext: 'txt', tags: [], folders: [], palettes: [] });
  eagle.item = { getById: async id => id === item.id ? item : null };
  const handle = createSaveHandler({ eagle, stagingRoot });
  const bridge = createTextPluginBridge({ directory, stagingRoot, timeoutMs: 5000 });
  t.after(async () => { await bridge.stop(); ipc.removeAllListeners(); await fsp.rm(root, { recursive: true, force: true }); });
  await bridge.start();
  const config = JSON.parse(await fsp.readFile(path.join(directory, 'connection.json'), 'utf8'));
  const url = `http://127.0.0.1:${config.port}`;
  const headers = { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' };
  await fetch(`${url}/next`, { headers });
  const baseline = await readText({ filePath, libraryPath, item });
  const a = saveText({ filePath, libraryPath, item, backupRoot, base: baseline.fingerprint, content: 'first accepted', replaceFile: bridge.replaceFile });
  const b = saveText({ filePath, libraryPath, item, backupRoot, base: baseline.fingerprint, content: 'second must conflict', replaceFile: bridge.replaceFile });
  let job = null;
  for (let i = 0; i < 100 && !job; i++) {
    job = await (await fetch(`${url}/next`, { headers })).json();
    if (!job) await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(job, 'The bridge must deliver the authorized first save');
  const result = await handle(job);
  assert.equal(result.status, 'saved');
  const receipt = await fetch(`${url}/result`, { method: 'POST', headers, body: JSON.stringify({ requestId: job.requestId, leaseId: job.leaseId, result }) });
  assert.equal(receipt.status, 200);
  const [first, second] = await Promise.all([a, b]);
  assert.equal(first.conflict, false);
  assert.equal(second.conflict, true);
  assert.equal(second.current.content, 'first accepted');
  assert.deepEqual(calls, ['item.refreshThumbnail']);
  assert.equal(fs.existsSync(`${filePath}.tmp`), false);
});
