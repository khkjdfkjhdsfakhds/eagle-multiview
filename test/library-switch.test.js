'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EagleClient } = require('../lib/eagle-client');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('listLibraryHistory hits the history endpoint, keeps real paths, strips trailing slashes', async () => {
  const client = new EagleClient();
  const calls = [];
  client.request = async requestPath => {
    calls.push(requestPath);
    // Eagle's real history mixes plain and trailing-slash forms and can
    // list the same library in both — one row per library after cleanup.
    return ['/tmp/A.library', '', null, 42, '/tmp/B.library/', '/tmp/A.library/'];
  };
  assert.deepEqual(await client.listLibraryHistory(), ['/tmp/A.library', '/tmp/B.library']);
  assert.deepEqual(calls, ['/api/library/history']);

  client.request = async () => ({ not: 'an array' });
  assert.deepEqual(await client.listLibraryHistory(), []);
});

test('switchLibrary posts a normalized path to the official switch endpoint', async () => {
  const client = new EagleClient();
  let seen = null;
  client.request = async (requestPath, options) => {
    seen = { requestPath, options };
    return {};
  };
  // The trailing-slash form from history is rejected by Eagle's switch API.
  await client.switchLibrary('/tmp/B.library/');
  assert.equal(seen.requestPath, '/api/library/switch');
  assert.equal(seen.options.method, 'POST');
  assert.deepEqual(seen.options.body, { libraryPath: '/tmp/B.library' });
});

test('waitForLibrary polls until the target library is loaded, tolerating errors and slashes', async () => {
  const client = new EagleClient();
  const responses = [
    () => { throw new Error('Eagle busy'); },
    () => ({ path: '/tmp/OLD.library' }),
    () => ({ path: '/tmp/NEW.library' })
  ];
  let index = 0;
  client.request = async () => responses[Math.min(index++, responses.length - 1)]();
  assert.equal(await client.waitForLibrary('/tmp/NEW.library/', { timeoutMs: 3000, intervalMs: 10 }), true);
  assert.ok(index >= 3);
});

test('waitForLibrary gives up after the timeout instead of hanging', async () => {
  const client = new EagleClient();
  client.request = async () => ({ path: '/tmp/OLD.library' });
  const started = Date.now();
  assert.equal(await client.waitForLibrary('/tmp/NEW.library', { timeoutMs: 120, intervalMs: 10 }), false);
  assert.ok(Date.now() - started < 2000);
});

test('the switch IPC waits for the load and reconnects the hub', () => {
  const main = read('main.js');
  const start = main.indexOf("ipcMain.handle('library:switch'");
  assert.ok(start >= 0);
  const handler = main.slice(start, start + 900);
  assert.ok(handler.includes('client.switchLibrary(libraryPath)'));
  assert.ok(handler.includes('client.waitForLibrary(libraryPath)'));
  assert.ok(handler.includes('hub.connect()'));
  // Switching to the already-open library must not reload anything; both
  // sides compare normalized so trailing-slash history entries still match.
  assert.ok(handler.includes('EagleClient.normalizeLibraryPath(hub.library?.path) === libraryPath'));
  assert.ok(main.includes("ipcMain.handle('library:history'"));
});

test('the sidebar switcher guards edits, marks the current library, and closes like other popovers', () => {
  const renderer = read('src/renderer.js');
  const html = read('src/index.html');
  assert.ok(html.includes('id="libraryButton"'));
  assert.ok(html.includes('id="libraryPopover"'));
  assert.ok(renderer.includes("runForegroundOperation(`正在切换到「${name}」…`, { key: 'library-switch' }"));
  const switcher = renderer.slice(renderer.indexOf('async function switchToLibrary'), renderer.indexOf('\n}', renderer.indexOf('async function switchToLibrary')));
  assert.ok(switcher.includes('confirmDiscardChanges()'));
  assert.ok(switcher.includes('已经是当前资料库'));
  assert.ok(renderer.includes("event.target.closest('#libraryButton, #libraryPopover')"));
  // The history list keeps the open library visible and checked.
  assert.ok(renderer.includes('library-row-check'));
  assert.ok(renderer.includes('known.unshift'));
});
