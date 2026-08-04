'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'web-shim.js'), 'utf8');

function createHarness({ healthStatus = 200, healthResponse } = {}) {
  const sockets = [];
  const fetches = [];
  const timers = [];
  const windowListeners = new Map();
  const replacements = [];

  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;

    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.CONNECTING;
      sockets.push(this);
    }

    close() {
      this.readyState = FakeWebSocket.CLOSED;
      this.onclose?.();
    }

    hello(clientId) {
      this.readyState = FakeWebSocket.OPEN;
      this.onmessage?.({
        data: JSON.stringify({ channel: 'web:hello', payload: { clientId } })
      });
    }
  }

  const window = {
    addEventListener(type, callback) {
      windowListeners.set(type, callback);
    },
    open() {},
  };
  const context = {
    window,
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
      if (url === '/health/session') {
        return healthResponse || Promise.resolve({ status: healthStatus, json: async () => ({ ok: true }) });
      }
      if (url === '/rpc') {
        return Promise.resolve({ status: 200, json: async () => ({ ok: true, result: true }) });
      }
      throw new Error(`Unexpected fetch ${url}`);
    },
    setTimeout(callback, delay) {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.cleared = true;
    },
    document: {
      body: { appendChild() {} },
      createElement() {
        return { style: {}, addEventListener() {}, remove() {}, click() {} };
      },
      fullscreenElement: null,
    },
    navigator: { clipboard: { writeText: async () => {} } },
    console,
    URLSearchParams,
    FormData,
    Blob,
    Promise,
    Map,
    Set,
    JSON,
  };
  window.window = window;
  vm.runInNewContext(source, context, { filename: 'web-shim.js' });
  return { window, sockets, fetches, timers, windowListeners, replacements };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
}

test('websocket disconnect uses one health probe and reconnect timer, then resynchronizes', async () => {
  const harness = createHarness();
  const statuses = [];
  const invalidations = [];
  harness.window.eagleMV.onStatus(payload => statuses.push(payload));
  harness.window.eagleMV.onQueryInvalidated(payload => invalidations.push(payload));

  assert.equal(harness.sockets.length, 1);
  harness.sockets[0].hello(11);
  harness.sockets[0].close();
  harness.sockets[0].onclose?.();
  await flushPromises();

  const healthCalls = harness.fetches.filter(call => call.url === '/health/session');
  assert.equal(healthCalls.length, 1);
  assert.equal(healthCalls[0].options.method, 'GET');
  const reconnectTimers = harness.timers.filter(timer => timer.delay === 1000 && !timer.cleared);
  assert.equal(reconnectTimers.length, 1);
  assert.equal(statuses.at(-1).connected, false);

  reconnectTimers[0].callback();
  assert.equal(harness.sockets.length, 2);
  harness.sockets[1].hello(12);
  await flushPromises();

  assert.equal(harness.fetches.filter(call => call.url === '/rpc').length, 1);
  assert.equal(statuses.at(-1).connected, true);
  assert.equal(invalidations.at(-1).reason, 'web-reconnected');
});

test('expired websocket session enters login and pagehide invalidates old transport callbacks', async () => {
  const harness = createHarness({ healthStatus: 401 });
  harness.sockets[0].hello(21);
  harness.sockets[0].close();
  await flushPromises();
  assert.deepEqual(harness.replacements, ['/login']);

  harness.windowListeners.get('pagehide')();
  const socketCount = harness.sockets.length;
  harness.windowListeners.get('online')();
  assert.equal(harness.sockets.length, socketCount);
  assert.ok(harness.timers.filter(timer => timer.delay === 1000).every(timer => timer.cleared));
});

test('a health result resolving after pagehide cannot navigate the disposed page', async () => {
  let resolveHealth;
  const healthResponse = new Promise(resolve => {
    resolveHealth = resolve;
  });
  const harness = createHarness({ healthResponse });
  harness.sockets[0].hello(31);
  harness.sockets[0].close();

  harness.windowListeners.get('pagehide')();
  resolveHealth({ status: 401, json: async () => ({ ok: true }) });
  await flushPromises();

  assert.deepEqual(harness.replacements, []);
});
