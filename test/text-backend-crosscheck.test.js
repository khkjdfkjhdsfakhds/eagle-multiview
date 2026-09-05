'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { readText, saveText } = require('../lib/text-file-service');
const { createTextPluginBridge } = require('../lib/text-plugin-bridge');
const { createSaveHandler } = require('../eagle-plugin/text-save-service/save-handler');
const { TextDraftStore } = require('../lib/text-draft-store');
const candidateIdentity = require('../test-support/candidate-identity.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function bridgeClock() {
  let now = 1000000;
  let nextId = 0;
  const timers = new Map();
  return {
    Date: { now: () => now },
    setTimeout(callback, milliseconds) {
      const id = ++nextId;
      timers.set(id, { callback, due: now + milliseconds });
      return id;
    },
    clearTimeout: id => timers.delete(id),
    advance(milliseconds) {
      const end = now + milliseconds;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        const [id, timer] = next;
        timers.delete(id);
        now = timer.due;
        timer.callback();
      }
      now = end;
    }
  };
}

function bridgeWithClock(clock, options) {
  const file = path.resolve(__dirname, '../lib/text-plugin-bridge.js');
  const context = { require: createRequire(file), module: { exports: {} }, Buffer, ...clock };
  // Only this module's clock is controlled; its HTTP, authentication, queue,
  // lease and reconciliation implementation execute unchanged.
  vm.runInNewContext(syncFs.readFileSync(file, 'utf8'), context, { filename: file });
  return context.module.exports.createTextPluginBridge(options);
}

async function fixture(t, { bridgeTimeoutMs = 500, clock, profileName = candidateIdentity.profile } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaglemv-text-crosscheck-'));
  const profile = path.join(root, 'Library', 'Application Support', profileName);
  const libraryPath = path.join(root, 'synthetic-store');
  const filePath = path.join(libraryPath, 'images', 'I.info', 'document.txt');
  const backupRoot = path.join(profile, 'Text Backups');
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, 'base');
  const item = { id: 'I', ext: 'txt', filePath };
  item.replaceFile = async stage => { await fs.copyFile(stage, filePath); };
  const eagle = { library: { path: libraryPath }, item: { getById: async () => item }, onPluginCreate() {} };
  const bridgeOptions = { directory: path.join(profile, 'TXT Bridge'), stagingRoot: path.join(backupRoot, 'staging'), timeoutMs: bridgeTimeoutMs };
  const bridge = clock ? bridgeWithClock(clock, bridgeOptions) : createTextPluginBridge(bridgeOptions);
  t.after(async () => { await bridge.stop(); await fs.rm(root, { recursive: true, force: true }); });
  await bridge.start();
  const config = JSON.parse(await fs.readFile(path.join(profile, 'TXT Bridge', 'connection.json'), 'utf8'));
  const headers = { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' };
  const baseURL = `http://127.0.0.1:${config.port}`;
  return { root, profile, libraryPath, filePath, backupRoot, item, eagle, bridge, headers, baseURL };
}

function pluginRuntime(f) {
  const file = path.resolve(__dirname, '../eagle-plugin/text-save-service/plugin.js');
  const realRequire = createRequire(file);
  let onCreate;
  const eagle = { ...f.eagle, onPluginCreate: callback => { onCreate = callback; } };
  const context = {
    require(name) {
      if (name === 'node:os') return { homedir: () => f.root };
      if (name === path.join(path.dirname(file), 'save-handler.js')) return { createSaveHandler: options => createSaveHandler({ ...options, timeoutMs: 20 }) };
      return realRequire(name);
    },
    eagle, window: { addEventListener() {} }, module: { exports: {} }, Buffer, console, clearTimeout,
    setTimeout(callback, milliseconds) {
      // The test owns scheduling. Do not leave a real Eagle-like poller alive.
      if (callback.name === 'tick') return 0;
      return setTimeout(callback, milliseconds);
    }
  };
  vm.runInNewContext(syncFs.readFileSync(file, 'utf8') + '\nmodule.exports = { tick };', context, { filename: file });
  const ready = onCreate({ path: path.dirname(file) });
  return { tick: async () => { await ready; await context.module.exports.tick(); } };
}

async function throughPlugin(f, runtime, content, base) {
  let done = false;
  const pending = saveText({ ...f, content, base, ensureLibraryPath: async expected => assert.equal(expected, f.eagle.library.path), replaceFile: request => f.bridge.replaceFile(request) });
  pending.then(() => { done = true; }, () => { done = true; });
  for (let index = 0; index < 100 && !done; index++) { await runtime.tick(); await pause(2); }
  return pending;
}

test('TXT crosscheck: actual plugin polling protocol completes service → loopback → official API boundary → readback', async t => {
  const f = await fixture(t), runtime = pluginRuntime(f);
  await runtime.tick();
  assert.equal(f.bridge.connected, true);
  const initial = await readText(f);
  const result = await throughPlugin(f, runtime, '中文正文\nsecond line', initial.fingerprint);
  assert.equal(result.status, 'saved');
  assert.equal((await readText(f)).content, '中文正文\nsecond line');
  assert.equal(await fs.readFile(result.backupPath, 'utf8'), 'base');
  assert.deepEqual(await fs.readdir(path.join(f.backupRoot, 'staging')), []);
});

test('TXT candidate identity: the unified Review plugin never connects to the retired Features profile or adopts its draft', async t => {
  const oldIdentity = { profile: 'eagle-multiview-features-20260905' };
  assert.notEqual(candidateIdentity.profile, oldIdentity.profile);
  const f = await fixture(t, { profileName: oldIdentity.profile });
  const connectionPath = path.join(f.profile, 'TXT Bridge', 'connection.json');
  const draftPath = path.join(f.profile, 'old-draft-fixture.json');
  await fs.writeFile(draftPath, '{"content":"old features draft"}');
  const before = await fs.readFile(connectionPath, 'utf8');
  const runtime = pluginRuntime(f);
  await runtime.tick();
  assert.equal(f.bridge.connected, false);
  assert.equal(await fs.readFile(connectionPath, 'utf8'), before);
  assert.equal(await fs.readFile(draftPath, 'utf8'), '{"content":"old features draft"}');
  assert.equal(await fs.readFile(f.filePath, 'utf8'), 'base');
});

test('TXT candidate identity: a copied old-profile staging binding is rejected even under the current connection filename', async t => {
  const f = await fixture(t);
  const connectionPath = path.join(f.profile, 'TXT Bridge', 'connection.json');
  const connection = JSON.parse(await fs.readFile(connectionPath, 'utf8'));
  connection.stagingRoot = path.join(f.root, 'Library', 'Application Support', 'eagle-multiview-features-20260905', 'Text Backups', 'staging');
  await fs.writeFile(connectionPath, JSON.stringify(connection));
  const runtime = pluginRuntime(f);
  await runtime.tick();
  assert.equal(f.bridge.connected, false);
  assert.equal(await fs.readFile(f.filePath, 'utf8'), 'base');
});

test('TXT crosscheck: confirmed content with a missing refresh event still permits the next revision to save', async t => {
  const f = await fixture(t), runtime = pluginRuntime(f);
  f.item.replaceFile = async stage => { await fs.copyFile(stage, f.filePath); await new Promise(() => {}); };
  await runtime.tick();
  const initial = await readText(f);
  const first = await throughPlugin(f, runtime, 'first revision', initial.fingerprint);
  assert.equal(first.status, 'written_pending_refresh');
  const next = await throughPlugin(f, runtime, 'second revision', first.fingerprint);
  assert.equal(next.conflict, false);
  assert.equal((await readText(f)).content, 'second revision');
});

test('TXT crosscheck: stale or cross-library requests leave both the original and stored draft intact', async t => {
  const f = await fixture(t), runtime = pluginRuntime(f);
  await runtime.tick();
  const initial = await readText(f), store = new TextDraftStore(path.join(f.profile, 'Text Drafts'));
  const identity = { libraryPath: f.libraryPath, id: 'I', draftId: 'one-pane', revision: 1 };
  await store.put({ ...identity, content: 'my draft', base: initial.fingerprint });
  await fs.writeFile(f.filePath, 'external revision');
  const result = await throughPlugin(f, runtime, 'my draft', initial.fingerprint);
  assert.equal(result.conflict, true); assert.equal((await store.get(identity)).content, 'my draft');
  assert.equal((await readText(f)).content, 'external revision');
});

test('TXT crosscheck: bridge stop/restart clears an unknown lease without replaying its old job', async t => {
  const f = await fixture(t);
  await fetch(`${f.baseURL}/next`, { headers: f.headers });
  const request = { id: 'I', libraryPath: f.libraryPath, stagedPath: path.join(f.backupRoot, 'staging', 'candidate.txt') };
  const pending = f.bridge.replaceFile(request).catch(error => error);
  const job = await (await fetch(`${f.baseURL}/next`, { headers: f.headers })).json();
  assert.equal(job.id, 'I');
  await f.bridge.stop(); assert.match((await pending).message, /连接已关闭/);
  await f.bridge.start();
  const config = JSON.parse(await fs.readFile(path.join(f.profile, 'TXT Bridge', 'connection.json'), 'utf8'));
  const response = await fetch(`http://127.0.0.1:${config.port}/next`, { headers: { authorization: `Bearer ${config.token}` } });
  assert.equal(await response.json(), null);
  assert.equal(await fs.readFile(f.filePath, 'utf8'), 'base');
});

for (const written of [false, true]) test(`TXT crosscheck: ${written ? 'lost result receipt' : 'plugin restart before execution'} is reconciled read-only and permits a fresh save`, async t => {
  const clock = bridgeClock();
  const f = await fixture(t, { bridgeTimeoutMs: 30, clock });
  await fetch(`${f.baseURL}/next`, { headers: f.headers });
  const base = (await readText(f)).fingerprint, stagedPath = path.join(f.backupRoot, 'staging', 'lost.txt');
  await fs.mkdir(path.dirname(stagedPath), { recursive: true }); await fs.writeFile(stagedPath, 'lost request');
  const request = { id: 'I', libraryPath: f.libraryPath, stagedPath, base, outputHash: crypto.createHash('sha256').update('lost request').digest('hex') };
  const pending = f.bridge.replaceFile(request).catch(error => error);
  const job = await (await fetch(`${f.baseURL}/next`, { headers: f.headers })).json();
  assert.equal(job.operation, 'replace');
  if (written) {
    const save = createSaveHandler({ eagle: f.eagle, stagingRoot: path.dirname(stagedPath) });
    assert.equal((await save(job)).status, 'saved');
    // Simulate all result receipts being lost; the bridge never sees success.
  }
  clock.advance(30);
  assert.match((await pending).message, /回执超时/);
  await fs.unlink(stagedPath);
  const restarted = pluginRuntime(f);
  clock.advance(35); await restarted.tick();
  assert.equal((await readText(f)).content, written ? 'lost request' : 'base', 'reconciliation never executes an old write');
  const current = (await readText(f)).fingerprint;
  const next = await throughPlugin(f, restarted, 'fresh request', current);
  assert.equal(next.conflict, false); assert.equal((await readText(f)).content, 'fresh request');
});

test('TXT crosscheck: a truly unfinished write remains gated across reconciliation, then recovers after completion', async t => {
  const f = await fixture(t, { bridgeTimeoutMs: 60 }), runtime = pluginRuntime(f);
  let release, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  f.item.replaceFile = async stage => {
    calls++;
    // Read the authorized candidate first; a bridge timeout may clean staging
    // while an already-started SDK transaction is still completing.
    const candidate = await fs.readFile(stage); await gate; await fs.writeFile(f.filePath, candidate);
  };
  await runtime.tick();
  const initial = (await readText(f)).fingerprint;
  const first = await throughPlugin(f, runtime, 'pending first', initial).catch(error => error);
  assert.match(first.message, /待确认|待核对|进行/); assert.equal(calls, 1);
  await pause(65); await runtime.tick();
  const blocked = await throughPlugin(f, runtime, 'must not race', initial).catch(error => error);
  assert.match(blocked.message, /上次 TXT 保存结果/); assert.equal(calls, 1); assert.equal((await readText(f)).content, 'base');
  release(); await pause(65); await runtime.tick();
  const current = (await readText(f)).fingerprint;
  const next = await throughPlugin(f, runtime, 'after recovery', current);
  assert.equal(next.conflict, false); assert.equal(calls, 2); assert.equal((await readText(f)).content, 'after recovery');
});

test('TXT crosscheck: a surviving SDK temporary file blocks fresh-session reconciliation even when the new hash matches', { timeout: 10000 }, async t => {
  // The 30 ms lease is deliberately short to exercise expiry, not to impose
  // a disk/HTTP performance SLA on the unrelated full-suite workload.
  const clock = bridgeClock();
  const f = await fixture(t, { bridgeTimeoutMs: 30, clock });
  await fetch(`${f.baseURL}/next`, { headers: f.headers });
  const base = (await readText(f)).fingerprint, stagedPath = path.join(f.backupRoot, 'staging', 'temporary.txt');
  await fs.mkdir(path.dirname(stagedPath), { recursive: true }); await fs.writeFile(stagedPath, 'new bytes');
  const request = { id: 'I', libraryPath: f.libraryPath, stagedPath, base, outputHash: crypto.createHash('sha256').update('new bytes').digest('hex') };
  const pending = f.bridge.replaceFile(request).catch(error => error);
  const leased = await (await fetch(`${f.baseURL}/next`, { headers: f.headers })).json();
  assert.equal(leased.operation, 'replace');
  await fs.writeFile(`${f.filePath}.tmp`, 'base'); await fs.writeFile(f.filePath, 'new bytes');
  clock.advance(30);
  assert.match((await pending).message, /回执超时/);
  await fs.unlink(stagedPath);
  const runtime = pluginRuntime(f);
  clock.advance(30); await runtime.tick();
  await assert.rejects(f.bridge.replaceFile(request), /上次 TXT 保存结果/);
  // Only the synthetic SDK finishes its own transaction; the product
  // reconciliation path never renames/deletes a library temporary file.
  await fs.unlink(`${f.filePath}.tmp`);
  clock.advance(30); await runtime.tick();
  const next = await throughPlugin(f, runtime, 'after SDK cleanup', (await readText(f)).fingerprint);
  assert.equal(next.conflict, false); assert.equal((await readText(f)).content, 'after SDK cleanup');
});
