'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'web-shim.js'), 'utf8');
const keyboardPlatform = require('../src/keyboard-platform.js');

// The web client has no application menu, so ⌘/Ctrl+Z (the desktop 编辑 → 撤销
// accelerator) is bound by the shim itself.
function loadShim(nav) {
  const keydown = [];
  const document = {
    body: { appendChild() {} },
    createElement() { return { style: {}, addEventListener() {}, remove() {}, click() {} }; },
    addEventListener(type, callback) { if (type === 'keydown') keydown.push(callback); },
    removeEventListener(type, callback) {
      const index = keydown.indexOf(callback);
      if (type === 'keydown' && index >= 0) keydown.splice(index, 1);
    },
    fullscreenElement: null,
  };
  const window = { addEventListener() {}, open() {}, EagleMVKeyboardPlatform: keyboardPlatform };
  window.window = window;
  class FakeWebSocket { static CONNECTING = 0; static OPEN = 1; static CLOSED = 3; close() {} }
  vm.runInNewContext(source, {
    window, document, navigator: nav, console, URLSearchParams, FormData, Blob, Promise, Map, Set, JSON,
    location: { protocol: 'http:', host: 'host.test', replace() {} },
    WebSocket: FakeWebSocket,
    fetch: () => new Promise(() => {}),
    setTimeout: () => 0,
    clearTimeout() {},
  }, { filename: 'web-shim.js' });
  const press = init => {
    const event = {
      key: 'z', code: 'KeyZ', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
      repeat: false, isComposing: false, defaultPrevented: false, target: { closest: () => null },
      ...init,
      preventDefault() { this.defaultPrevented = true; },
    };
    for (const listener of [...keydown]) listener(event);
    return event.defaultPrevented;
  };
  return { eagleMV: window.eagleMV, press, keydown };
}

const ANDROID = { userAgent: 'Mozilla/5.0 (Linux; Android 16; Pad) AppleWebKit/537.36 Chrome/140 Safari/537.36', platform: 'Linux armv8l' };
const MAC = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel' };

test('Ctrl+Z undoes the last delete on Android, outside text fields only', () => {
  const { eagleMV, press, keydown } = loadShim(ANDROID);
  let undos = 0;
  const unsubscribe = eagleMV.onUndoDelete(() => { undos += 1; });

  assert.equal(press({ ctrlKey: true }), true);
  assert.equal(undos, 1);
  // Meta is not the primary key off Apple platforms; modified variants and
  // auto-repeat are not undo either.
  for (const init of [{ metaKey: true }, { ctrlKey: true, shiftKey: true }, { ctrlKey: true, altKey: true },
    { ctrlKey: true, repeat: true }, { ctrlKey: true, isComposing: true }, {}]) {
    assert.equal(press(init), false, JSON.stringify(init));
  }
  // A focused text field keeps its own text undo.
  assert.equal(press({ ctrlKey: true, target: { closest: selector => (/textarea/.test(selector) ? {} : null) } }), false);
  assert.equal(undos, 1);

  unsubscribe();
  assert.equal(keydown.length, 0);
  press({ ctrlKey: true });
  assert.equal(undos, 1);
});

test('⌘Z undoes the last delete on macOS browsers while Ctrl+Z does not', () => {
  const { eagleMV, press } = loadShim(MAC);
  let undos = 0;
  eagleMV.onUndoDelete(() => { undos += 1; });
  assert.equal(press({ ctrlKey: true }), false);
  assert.equal(press({ metaKey: true }), true);
  assert.equal(undos, 1);
});
