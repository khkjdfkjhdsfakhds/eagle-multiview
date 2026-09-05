'use strict';

// Eagle-parity batch 2: the inspector source URL gains open/copy actions.
// Opening goes through a main-process gate that only allows http(s).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

test('inspector URL row offers open and copy buttons', () => {
  assert.ok(html.includes('id="openURLButton"'));
  assert.ok(html.includes('id="copyURLButton"'));
});

test('preload exposes openExternal over IPC', () => {
  assert.ok(preload.includes("openExternal: url => ipcRenderer.invoke('shell:open-external', String(url || ''))"));
});

test('main process only opens real web URLs', () => {
  const start = main.indexOf("handleRPC('shell:open-external'");
  assert.ok(start >= 0);
  const handler = main.slice(start, main.indexOf('\n  });', start));
  assert.ok(handler.includes('/^https?:\\/\\//i.test(url)'));
  assert.ok(handler.includes('shell.openExternal(url)'));
  const guardIndex = handler.indexOf('throw new Error');
  const openIndex = handler.indexOf('shell.openExternal');
  assert.ok(guardIndex >= 0 && guardIndex < openIndex, 'guard must run before opening');
});

test('buttons follow the current URL value and disable when unusable', () => {
  assert.ok(renderer.includes('function updateURLActions()'));
  const fn = renderer.slice(renderer.indexOf('function updateURLActions()'), renderer.indexOf('\n}', renderer.indexOf('function updateURLActions()')));
  assert.ok(fn.includes("openButton.disabled = !/^https?:\\/\\//i.test(url)"));
  assert.ok(fn.includes('copyButton.disabled = !url'));
  assert.ok(renderer.includes("$('#itemURL').addEventListener('input', updateURLActions);"));
  assert.ok(renderer.includes('updateURLActions();\n  resizeAnnotation();'), 'renderInspector must refresh button state');
});

test('open goes through the gate and copy reuses the clipboard bridge', () => {
  const open = renderer.slice(renderer.indexOf("$('#openURLButton').addEventListener"), renderer.indexOf('\n  });', renderer.indexOf("$('#openURLButton').addEventListener")));
  assert.ok(open.includes('window.eagleMV.openExternal('));
  assert.ok(open.includes('toast(`打开来源失败：${error.message}`'), 'main-process gate errors surface as a toast');
  const copy = renderer.slice(renderer.indexOf("$('#copyURLButton').addEventListener"), renderer.indexOf('\n  });', renderer.indexOf("$('#copyURLButton').addEventListener")));
  assert.ok(copy.includes('copyTextWithFeedback(url,'));
  assert.ok(renderer.includes('await window.eagleMV.copyText(text)'));
});
