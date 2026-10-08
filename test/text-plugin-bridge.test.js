'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createTextPluginBridge } = require('../lib/text-plugin-bridge');

test('only an authenticated local plugin leases a save once and returns its matching result', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaglemv-bridge-'));
  const bridge = createTextPluginBridge({ directory: root, stagingRoot: path.join(root, 'staging'), timeoutMs: 500 });
  t.after(async () => { await bridge.stop(); await fs.rm(root, { recursive: true, force: true }); });
  await bridge.start();
  const config = JSON.parse(await fs.readFile(path.join(root, 'connection.json'), 'utf8'));
  const url = `http://127.0.0.1:${config.port}`;
  assert.equal((await fetch(`${url}/next`)).status, 401);
  const headers = { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' };
  assert.equal((await fetch(`${url}/next`, { headers })).status, 200);
  const save = bridge.replaceFile({ id: 'I', libraryPath: '/fixture.library', stagedPath: path.join(root, 'staging', 'one.txt'), base: { hash: 'old' }, outputHash: 'new' });
  const job = await (await fetch(`${url}/next`, { headers })).json();
  assert.equal(job.id, 'I');
  assert.equal(await (await fetch(`${url}/next`, { headers })).json(), null);
  const response = await fetch(`${url}/result`, { method: 'POST', headers, body: JSON.stringify({ requestId: job.requestId, leaseId: job.leaseId, result: { status: 'written_pending_refresh' } }) });
  assert.equal(response.status, 200);
  assert.equal((await save).status, 'written_pending_refresh');
  assert.equal((await fetch(`${url}/next`, { headers: { ...headers, origin: 'https://unrelated.example' } })).status, 403);
});

test('the Eagle plugin can ask MultiView to open the current foreground view', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaglemv-bridge-open-'));
  let opened = 0;
  const bridge = createTextPluginBridge({ directory: root, stagingRoot: path.join(root, 'staging'), openCurrentView: async () => { opened++; return { ok: true }; } });
  t.after(async () => { await bridge.stop(); await fs.rm(root, { recursive: true, force: true }); });
  await bridge.start();
  const config = JSON.parse(await fs.readFile(path.join(root, 'connection.json'), 'utf8'));
  const headers = { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' };
  const response = await fetch(`http://127.0.0.1:${config.port}/open-current`, { method: 'POST', headers, body: '{}' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(opened, 1);
});

test('the Eagle plugin can read the foreground MultiView view it should follow', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaglemv-bridge-view-'));
  let reads = 0;
  const bridge = createTextPluginBridge({ directory: root, stagingRoot: path.join(root, 'staging'),
    currentView: async () => { reads++; return { ok: true, libraryPath: '/fixture.library', view: { kind: 'folder', id: 'F' } }; } });
  t.after(async () => { await bridge.stop(); await fs.rm(root, { recursive: true, force: true }); });
  await bridge.start();
  const config = JSON.parse(await fs.readFile(path.join(root, 'connection.json'), 'utf8'));
  const url = `http://127.0.0.1:${config.port}/current-view`;
  assert.equal((await fetch(url)).status, 401, 'the view is never readable without the plugin token');
  const response = await fetch(url, { headers: { authorization: `Bearer ${config.token}` } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, libraryPath: '/fixture.library', view: { kind: 'folder', id: 'F' } });
  assert.equal(reads, 1);
  assert.equal(await fetch(url, { headers: { authorization: `Bearer ${config.token}`, origin: 'https://unrelated.example' } }).then(r => r.status), 403);
});

test('without a MultiView window the follow request reports itself unavailable', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaglemv-bridge-noview-'));
  const bridge = createTextPluginBridge({ directory: root, stagingRoot: path.join(root, 'staging') });
  t.after(async () => { await bridge.stop(); await fs.rm(root, { recursive: true, force: true }); });
  await bridge.start();
  const config = JSON.parse(await fs.readFile(path.join(root, 'connection.json'), 'utf8'));
  const response = await fetch(`http://127.0.0.1:${config.port}/current-view`, { headers: { authorization: `Bearer ${config.token}` } });
  assert.equal(response.status, 503);
});

test('the host answers both bridge directions from the same foreground window snapshot', async () => {
  const main = await fs.readFile(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(main.includes('openCurrentView: async () => {'), 'the plugin can still bring MultiView forward');
  assert.ok(main.includes('currentView: async () => {'), 'the plugin can read the view Eagle should follow');
  assert.ok(main.includes('const front = await foregroundMultiViewView();'), 'both directions share the foreground lookup');
  assert.ok(main.includes('windowRouter.lastLive()'), 'the lookup falls back to the most recent live window');
});

test('a leased timeout is not resubmitted while an eventual result is still unknown', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaglemv-bridge-timeout-'));
  const bridge = createTextPluginBridge({ directory: root, stagingRoot: path.join(root, 'staging'), timeoutMs: 30 });
  t.after(async () => { await bridge.stop(); await fs.rm(root, { recursive: true, force: true }); });
  await bridge.start();
  const config = JSON.parse(await fs.readFile(path.join(root, 'connection.json'), 'utf8'));
  const url = `http://127.0.0.1:${config.port}`;
  const headers = { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' };
  await fetch(`${url}/next`, { headers });
  const request = { id: 'I', libraryPath: '/fixture.library', stagedPath: path.join(root, 'staging', 'one.txt') };
  const save = bridge.replaceFile(request);
  const rejection = assert.rejects(save, /回执超时/);
  const job = await (await fetch(`${url}/next`, { headers })).json();
  await rejection;
  await assert.rejects(bridge.replaceFile(request), /上次 TXT 保存结果/);
  const late = await fetch(`${url}/result`, { method: 'POST', headers, body: JSON.stringify({ requestId: job.requestId, leaseId: job.leaseId, result: { status: 'saved' } }) });
  assert.equal(late.status, 409, 'a timed-out lease cannot satisfy a newer read-only reconciliation');
  await new Promise(resolve => setTimeout(resolve, 35));
  const reconcile = await (await fetch(`${url}/next`, { headers })).json();
  assert.equal(reconcile.operation, 'reconcile');
  assert.notEqual(reconcile.leaseId, job.leaseId);
  await fetch(`${url}/result`, { method: 'POST', headers, body: JSON.stringify({ requestId: reconcile.requestId, leaseId: reconcile.leaseId, result: { status: 'saved' } }) });
  assert.equal(await (await fetch(`${url}/next`, { headers })).json(), null);
});
