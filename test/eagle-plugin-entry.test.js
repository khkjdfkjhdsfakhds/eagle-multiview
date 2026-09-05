'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { readText, saveText } = require('../lib/text-file-service');
const { fixture, waitFor } = require('../test-support/eagle-plugin-entry-fixture.cjs');

async function assertEntrySaves(t, options) {
  const f = await fixture(t, options);
  assert.doesNotThrow(f.load, 'Plugin entry must register before resolving its own modules');
  assert.equal(f.registered, true);
  assert.equal(f.bridge.connected, false, 'No polling before plugin-create');
  f.create();
  await waitFor(() => f.bridge.connected);
  const baseline = await readText({ filePath: f.filePath, libraryPath: f.libraryPath, item: f.item });
  const result = await saveText({
    filePath: f.filePath, libraryPath: f.libraryPath, item: f.item,
    backupRoot: path.join(f.profile, 'Text Backups'), base: baseline.fingerprint,
    content: '入口验收 first save', replaceFile: f.bridge.replaceFile
  });
  assert.equal(result.status, 'saved');
  assert.equal(await fsp.readFile(f.filePath, 'utf8'), '入口验收 first save');
  assert.equal(f.replacements, 1);
  assert.deepEqual(f.errors, []);
}

test('Eagle wrapped loader: plugin-create initializes the entry and serves an authenticated save', async t => {
  await assertEntrySaves(t, { initialPath: true });
});

test('plugin entry also initializes when the host path first arrives with plugin-create', async t => {
  await assertEntrySaves(t, { initialPath: false });
});

test('entry startup failure stays offline, is visible without private details, and can initialize on a fresh create event', async t => {
  let fail = true;
  const f = await fixture(t, { interceptRequire: name => {
    if (fail && name.endsWith('/save-handler.js')) throw new Error('Synthetic private path and token must not be logged');
  } });
  f.load();
  assert.doesNotThrow(() => f.create());
  assert.equal(f.bridge.connected, false);
  assert.equal(f.timerCount, 0);
  assert.equal(f.errors.length, 1);
  assert.match(JSON.stringify(f.errors), /初始化失败/);
  assert.doesNotMatch(JSON.stringify(f.errors), /Synthetic private|token/);
  fail = false;
  f.create();
  await waitFor(() => f.bridge.connected);
  await waitFor(() => f.timerCount === 1);
  for (let i = 0; i < 5; i++) f.create();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.timerCount, 1, 'Repeated lifecycle delivery must not start duplicate polling loops');
  f.unload();
  assert.equal(f.timerCount, 0, 'Unload cancels pending polls');
  f.create();
  assert.equal(f.timerCount, 0, 'A destroyed page cannot be revived by a late create event');
});

test('plugin entry reconnects after candidate bridge port/token rotation without replaying the saved job', async t => {
  const f = await fixture(t);
  f.load(); f.create();
  await waitFor(() => f.bridge.connected);
  const save = async content => {
    const baseline = await readText({ filePath: f.filePath, libraryPath: f.libraryPath, item: f.item });
    return saveText({
      filePath: f.filePath, libraryPath: f.libraryPath, item: f.item,
      backupRoot: path.join(f.profile, 'Text Backups'), base: baseline.fingerprint,
      content, replaceFile: f.bridge.replaceFile
    });
  };
  assert.equal((await save('before restart')).status, 'saved');
  const before = JSON.parse(await fsp.readFile(path.join(f.directory, 'connection.json'), 'utf8'));
  await f.restartBridge();
  const after = JSON.parse(await fsp.readFile(path.join(f.directory, 'connection.json'), 'utf8'));
  assert.notEqual(after.token, before.token);
  await waitFor(() => f.bridge.connected);
  assert.equal(f.replacements, 1, 'Successful work must not replay after host restart');
  assert.equal((await save('after restart')).status, 'saved');
  assert.equal(f.replacements, 2);
  assert.equal(await fsp.readFile(f.filePath, 'utf8'), 'after restart');
});

test('plugin entry unload during discovery never connects or starts a late save', async t => {
  let release;
  let reading = false;
  const pending = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { interceptRequire: name => name === 'node:fs/promises' ? {
    ...fsp,
    readFile: async (...args) => { reading = true; await pending; return fsp.readFile(...args); }
  } : undefined });
  f.load();
  f.create();
  await waitFor(() => reading);
  f.unload();
  release();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(f.bridge.connected, false, 'Unloaded plugin must not lease work after awaited discovery');
  assert.equal(f.replacements, 0);
  assert.equal(f.timerCount, 0);
});

const archive = '/Applications/Eagle.app/Contents/Resources/app.asar';
test('installed Eagle loader wrapper: unchanged first-party entry contract connects and saves synthetic TXT', { skip: !fs.existsSync(archive) }, async t => {
  const asar = require('../node_modules/.pnpm/@electron+asar@3.4.1/node_modules/@electron/asar');
  const source = asar.extractFile(archive, 'app/js/plugin/api.js').toString('utf8');
  const wrapper = source.match(/global\.require = \(args\) => \{[\s\S]*?\n\};/);
  assert.ok(wrapper, 'Installed SDK loader contract must be reviewed if its declaration changes');
  console.log('Official plugin API SHA-256:', crypto.createHash('sha256').update(source).digest('hex'));
  // eagleFS is a lexical binding of the installed wrapper. No library mutation
  // uses it; mutations below are confined to the synthetic official API fixture.
  await assertEntrySaves(t, { wrapper: `const eagleFS = require('fs');\n${wrapper[0]}` });
});
