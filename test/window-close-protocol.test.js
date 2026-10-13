'use strict';
// Close/quit protocol between main and a renderer (B4-01, B4-03, H-04),
// driven through the real main module with a fake BrowserWindow.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { loadMain } = require('../test-support/main-data-harness.cjs');

function harness({ dialogResponse = 1 } = {}) {
  const created = [];
  class FakeWindow extends EventEmitter {
    constructor() {
      super();
      this.destroyed = false;
      this.webContents = Object.assign(new EventEmitter(), {
        id: created.length + 1, sent: [], crashed: false,
        send: channel => this.webContents.sent.push(channel),
        isDestroyed: () => this.destroyed,
        isCrashed: () => this.webContents.crashed
      });
      created.push(this);
    }
    loadFile() {}
    isDestroyed() { return this.destroyed; }
    close() {
      if (this.destroyed) return;
      let prevented = false;
      this.emit('close', { preventDefault: () => { prevented = true; } });
      if (!prevented) this.destroy();
    }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit('closed');
    }
  }
  FakeWindow.fromWebContents = contents => created.find(window => window.webContents === contents) || null;
  const dialogs = [];
  const dialog = { showMessageBox: async (_window, options) => { dialogs.push(options); return { response: dialogResponse }; } };
  const main = loadMain(fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-close-')), { BrowserWindow: FakeWindow, dialog });
  main.hub.startPolling = () => {};
  let quits = 0;
  main.app.quit = () => { quits += 1; };
  const quitCancelled = [];
  main.setUpdater({ quitCancelled: () => quitCancelled.push(true) });
  const rpc = (channel, window) => main.rpcRegistry.get(channel)({ sender: window.webContents });
  return { main, created, dialogs, rpc, quitCancelled, quits: () => quits };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('H-04: a renderer that defers the close to save keeps the quit armed and the app quits', async () => {
  const { main, rpc, quits, quitCancelled } = harness();
  const window = main.createWindow();
  main.setQuitting(true);
  window.close();
  assert.equal(window.isDestroyed(), false);
  assert.deepEqual(window.webContents.sent, ['command:request-close']);
  rpc('window:defer-close', window);
  assert.equal(main.getQuitting(), true, 'saving before closing must not cancel the quit');
  rpc('window:confirm-close', window);
  await tick();
  assert.equal(window.isDestroyed(), true);
  assert.equal(quits(), 1);
  assert.deepEqual(quitCancelled, []);
});

test('the renderer refusing the close cancels the pending quit', () => {
  const { main, rpc, quitCancelled } = harness();
  const window = main.createWindow();
  main.setQuitting(true);
  window.close();
  rpc('window:cancel-close', window);
  assert.equal(main.getQuitting(), false);
  assert.equal(quitCancelled.length, 1);
  window.close();
  assert.equal(window.webContents.sent.length, 2, 'a later close asks the renderer again');
});

test('B4-01: a crashed renderer never blocks closing or quitting', async () => {
  const { main, quits } = harness();
  const crashed = main.createWindow();
  crashed.webContents.crashed = true;
  crashed.close();
  assert.equal(crashed.isDestroyed(), true);

  const gone = main.createWindow();
  main.setQuitting(true);
  gone.close();
  assert.equal(gone.isDestroyed(), false);
  gone.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  await tick();
  assert.equal(gone.isDestroyed(), true, 'a close pending when the renderer died completes');
  assert.equal(quits(), 1, 'and the quit continues');
});

test('B4-01: a renderer that never answers gets a force-close prompt', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const forced = harness({ dialogResponse: 0 });
  const hung = forced.main.createWindow();
  hung.close();
  t.mock.timers.tick(5000);
  await tick();
  assert.equal(forced.dialogs.length, 1);
  assert.equal(hung.isDestroyed(), true);

  const waiting = harness({ dialogResponse: 1 });
  const slow = waiting.main.createWindow();
  waiting.main.setQuitting(true);
  slow.close();
  t.mock.timers.tick(5000);
  await tick();
  assert.equal(slow.isDestroyed(), false);
  assert.equal(waiting.main.getQuitting(), false, 'choosing to wait cancels the quit instead of leaving it armed');
  slow.close();
  assert.equal(slow.webContents.sent.length, 2, 'the next close asks again');

  const answered = harness();
  const alive = answered.main.createWindow();
  alive.close();
  answered.rpc('window:defer-close', alive);
  t.mock.timers.tick(5000);
  await tick();
  assert.equal(answered.dialogs.length, 0, 'a renderer that answered is not called unresponsive');
});

test('B4-03: once the close is approved a beforeunload guard cannot cancel it', () => {
  const { main, rpc } = harness();
  const window = main.createWindow();
  let ignored = false;
  window.webContents.emit('will-prevent-unload', { preventDefault: () => { ignored = true; } });
  assert.equal(ignored, false, 'an unapproved unload stays guarded');
  window.close();
  window.webContents.emit('will-prevent-unload', { preventDefault: () => { ignored = true; } });
  assert.equal(ignored, false);
  window.on('close', () => window.webContents.emit('will-prevent-unload', { preventDefault: () => { ignored = true; } }));
  rpc('window:confirm-close', window);
  assert.equal(ignored, true);
});

test('renderer close handler answers first and cancels only on an actual refusal', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
  const start = source.indexOf('window.eagleMV.onRequestClose');
  const handler = source.slice(start, source.indexOf('window.eagleMV.onTrashSelection', start));
  const defer = handler.indexOf('window.eagleMV.deferClose?.();');
  assert.ok(defer >= 0 && defer < handler.indexOf('blockingForegroundOperations()'));
  const save = handler.indexOf('if (state.inspectorDirty) await saveInspector();');
  assert.ok(save > 0, 'a dirty inspector is saved within the pending close');
  assert.equal(handler.slice(handler.indexOf('toast(`${message}'), handler.indexOf('const failedDrafts')).includes('cancelClose'), false,
    'saving the inspector must not cancel the close or the quit');
  const keepDrafts = handler.slice(handler.indexOf('if (!confirm('), handler.indexOf('if (!confirmTextSessionsLeave'));
  assert.ok(keepDrafts.indexOf('cancelClose') > keepDrafts.indexOf('activatePane'), 'drafts cancel only when the user keeps editing');
  assert.equal(handler.includes('approvedWindowClose = false; }, 1000'), false, 'approval is not a one-second timer');
});
