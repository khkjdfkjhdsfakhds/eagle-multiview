'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'web-shim.js'), 'utf8');

function uploadResponse(result = {}) {
  return Promise.resolve({
    status: 200,
    json: async () => ({
      ok: true,
      result: { count: 1, ready: 1, ids: [], rejected: [], ...result }
    })
  });
}

function createHarness({ fetchImpl = () => uploadResponse() } = {}) {
  const fetches = [];
  const inputs = [];
  const timers = [];
  const replacements = [];
  const windowListeners = new Map();

  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;

    constructor() {
      this.readyState = FakeWebSocket.CONNECTING;
    }

    close() {
      this.readyState = FakeWebSocket.CLOSED;
    }
  }

  const document = {
    body: { appendChild() {} },
    fullscreenElement: null,
    createElement(tagName) {
      if (tagName !== 'input') {
        return { style: {}, addEventListener() {}, remove() {}, click() {} };
      }
      const listeners = new Map();
      const input = {
        files: [],
        style: {},
        addEventListener(type, callback) {
          listeners.set(type, callback);
        },
        remove() {},
        click() {},
        dispatch(type) {
          listeners.get(type)?.();
        }
      };
      inputs.push(input);
      return input;
    }
  };

  const window = {
    addEventListener(type, callback) {
      windowListeners.set(type, callback);
    },
    focus() {},
    open() {}
  };
  const context = {
    window,
    document,
    location: {
      protocol: 'http:',
      host: 'current.example.test',
      replace(url) {
        replacements.push(url);
      }
    },
    WebSocket: FakeWebSocket,
    fetch(url, options = {}) {
      fetches.push({ url, options });
      return fetchImpl(url, options, fetches.length - 1);
    },
    setTimeout(callback, delay) {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.cleared = true;
    },
    AbortController,
    console,
    URLSearchParams,
    Promise,
    Map,
    Set,
    JSON,
  };
  window.window = window;
  vm.runInNewContext(source, context, { filename: 'web-shim.js' });
  return { window, inputs, fetches, timers, replacements, windowListeners };
}

async function selectFiles(harness, importPromise, files) {
  assert.equal(harness.inputs.length, 1);
  harness.inputs[0].files = files;
  harness.inputs[0].dispatch('change');
  return importPromise;
}

test('file picker supports one selected file and uploads the raw File body', async () => {
  const harness = createHarness({
    fetchImpl: () => uploadResponse({ ids: ['ONE'] })
  });
  const file = { name: 'one.png', marker: 'raw-file-body' };

  const resultPromise = harness.window.eagleMV.importItems({
    folderId: 'F1',
    libraryPath: '/library',
    multiple: false
  });
  const result = await selectFiles(harness, resultPromise, [file]);

  assert.equal(harness.inputs[0].type, 'file');
  assert.equal(harness.inputs[0].multiple, false);
  assert.equal(harness.fetches.length, 1);
  assert.equal(harness.fetches[0].options.body, file);
  assert.equal(harness.fetches[0].options.method, 'POST');
  assert.match(harness.fetches[0].url, /^\/upload\?/);
  assert.deepEqual(result.ids, ['ONE']);
});

test('file picker supports multiple selected files and uploads them in order', async () => {
  const harness = createHarness({
    fetchImpl: (_url, _options, index) => uploadResponse({ ids: [`ID${index + 1}`] })
  });
  const files = [{ name: 'one.png' }, { name: 'two.mov' }];

  const resultPromise = harness.window.eagleMV.importItems({ multiple: true });
  const result = await selectFiles(harness, resultPromise, files);

  assert.equal(harness.inputs[0].multiple, true);
  assert.deepEqual(harness.fetches.map(call => call.options.body), files);
  assert.deepEqual(result.ids, ['ID1', 'ID2']);
  assert.equal(result.count, 2);
});

test('canceling the file picker returns canceled without starting an upload', async () => {
  const harness = createHarness();

  const resultPromise = harness.window.eagleMV.importItems({ multiple: true });
  assert.equal(harness.inputs.length, 1);
  harness.inputs[0].dispatch('cancel');

  assert.deepEqual(await resultPromise, { canceled: true });
  assert.equal(harness.fetches.length, 0);
});

test('a single-file server failure is returned as one rejected upload', async () => {
  const harness = createHarness({
    fetchImpl: () => Promise.resolve({
      status: 200,
      json: async () => ({ ok: false, message: 'Eagle 拒绝导入' })
    })
  });

  const result = await harness.window.eagleMV.importItems({ paths: [{ name: 'bad.png' }] });

  assert.equal(result.count, 0);
  assert.equal(result.ready, 0);
  assert.deepEqual(result.rejected, [{ path: 'bad.png', message: 'Eagle 拒绝导入' }]);
  assert.equal(harness.fetches.length, 1);
});

test('a 401 stops the remaining batch immediately and enters login', async () => {
  const harness = createHarness({
    fetchImpl: () => Promise.resolve({
      status: 401,
      json: async () => ({ ok: false, message: '未登录' })
    })
  });
  const files = [{ name: 'first.png' }, { name: 'must-not-upload.png' }];

  const result = await harness.window.eagleMV.importItems({ paths: files });

  assert.equal(harness.fetches.length, 1);
  assert.deepEqual(harness.replacements, ['/login']);
  assert.equal(result.count, 0);
  assert.deepEqual(result.rejected, [{ path: 'first.png', message: '登录已过期' }]);
});

test('a disconnected upload reports an uncertain result and never replays the batch', async () => {
  const harness = createHarness({
    fetchImpl: () => Promise.reject(new TypeError('Failed to fetch'))
  });
  const files = [{ name: 'unknown.png' }, { name: 'must-not-upload.png' }];

  const result = await harness.window.eagleMV.importItems({ paths: files });
  harness.windowListeners.get('online')();
  await Promise.resolve();

  assert.equal(harness.fetches.length, 1);
  assert.equal(result.count, 0);
  assert.match(result.rejected[0].message, /结果可能不确定/);
  assert.match(result.rejected[0].message, /连接中断/);
});

test('an upload timeout aborts once, reports an uncertain result, and does not continue', async () => {
  const harness = createHarness({
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    })
  });
  const resultPromise = harness.window.eagleMV.importItems({
    paths: [{ name: 'slow.mov' }, { name: 'must-not-upload.mov' }]
  });
  const uploadTimer = harness.timers.find(timer => timer.delay >= 60_000 && timer.delay !== 10_000);
  assert.ok(uploadTimer, 'upload must have an explicit timeout');

  uploadTimer.callback();
  const result = await resultPromise;

  assert.equal(harness.fetches.length, 1);
  assert.match(result.rejected[0].message, /上传超时/);
  assert.match(result.rejected[0].message, /结果可能不确定/);
});

test('pagehide abandons an in-flight upload and a rebuilt shim does not restore it', async () => {
  const harness = createHarness({
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('page disposed')));
    })
  });
  const resultPromise = harness.window.eagleMV.importItems({ paths: [{ name: 'in-flight.png' }] });

  harness.windowListeners.get('pagehide')();
  const result = await resultPromise;
  const rebuilt = createHarness();

  assert.equal(harness.fetches.length, 1);
  assert.match(result.rejected[0].message, /结果可能不确定/);
  assert.equal(rebuilt.fetches.length, 0, 'new WebView/shim instances must not restore upload requests');
});
