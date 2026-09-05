'use strict';
// Public IPC handlers in the real main module, with Electron and networking
// disabled. Only the test's own temporary userData is accessible.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const ROOT = path.resolve(__dirname, '..');
function loadMain(root, { dialog = {} } = {}) {
  const app = new EventEmitter();
  Object.assign(app, { getPath: () => root, setPath() {}, setName() {}, getName: () => 'Review fixture', requestSingleInstanceLock: () => true, whenReady: () => ({ then() {} }), quit() {} });
  const electron = { app, dialog, protocol: { registerSchemesAsPrivileged() {} }, BrowserWindow: { fromWebContents: () => null }, ipcMain: { on() {}, handle() {} } };
  const realRequire = createRequire(path.join(ROOT, 'main.js'));
  const context = { require: name => name === 'electron' ? electron : realRequire(name), module: { exports: {} }, __dirname: ROOT,
    process: { on() {}, platform: 'darwin', pid: process.pid, env: {} }, console, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, structuredClone, URL, Buffer };
  const expose = '\nmodule.exports = { setupIPC, rpcRegistry, hub, client, setTagColor, getTagColors, hydrateSupplementalItems, getSupplementalItemStore, ' +
    'setWebServer: value => { webServer = value; }, setWaitForImportedFile: value => { waitForImportedFile = value; }, ' +
    'addFakeWindow: value => windows.add(value), getQuitting: () => quitting };';
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8') + expose, context, { filename: path.join(ROOT, 'main.js') });
  const result = context.module.exports;
  result.setupIPC();
  result.client.request = async () => { throw new Error('TEST BLOCKED UNMOCKED NETWORK'); };
  result.client.appInfo = async () => ({ version: 'fixture' });
  return { ...result, app };
}
module.exports = { loadMain };
