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
