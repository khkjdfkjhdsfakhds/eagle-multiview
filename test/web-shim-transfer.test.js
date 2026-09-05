'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/web-shim.js'), 'utf8');

function harness({ clipboard, fetchImpl } = {}) {
  const nodes = [];
  const clicks = [];
  const fetches = [];
  const previous = { focus() { previous.focused = true; } };
  const document = { activeElement: previous, body: { appendChild() {} }, createElement(tag) {
    const events = {};
    const node = { tag, children: [], style: {}, append(...children) { this.children.push(...children); },
      setAttribute() {}, addEventListener(type, fn) { events[type] = fn; },
      dispatch(type, event = {}) { events[type]?.({ preventDefault() {}, ...event }); },
      focus() {}, select() { this.selected = true; }, showModal() { this.open = true; },
      remove() { this.removed = true; }, click() { clicks.push(node); } };
    nodes.push(node); return node;
  } };
  const window = { addEventListener() {}, open() {} };
  const replacements = [];
  vm.runInNewContext(source, { window, document, navigator: { clipboard },
    location: { protocol: 'http:', host: 'fixture', replace(url) { replacements.push(url); } },
    WebSocket: class { static CONNECTING = 0; static OPEN = 1; readyState = 0; },
    fetch(url, options) { fetches.push({ url, options }); return fetchImpl?.(url, options); },
    setTimeout() { return 1; }, clearTimeout() {}, AbortController, console, URLSearchParams });
  return { bridge: window.eagleMV, nodes, clicks, fetches, replacements, previous };
}

test('UW-03: download waits for preparation and reports the actual manifest count', async () => {
  let release;
  const h = harness({ fetchImpl: () => new Promise(resolve => { release = resolve; }) });
  const pending = h.bridge.exportFiles({ ids: ['one', 'two', 'one'], libraryPath: '/fixture' });
  assert.equal(h.clicks.length, 0);
  assert.equal(h.fetches[0].url, '/export/prepare');
  release({ status: 200, json: async () => ({ ok: true, count: 2, missing: 0, url: '/export?token=fixture' }) });
  const result = await pending;
  assert.equal(result.count, 2);
  assert.equal(h.clicks[0].href, '/export?token=fixture');
  assert.equal(h.clicks.length, 1);
});

test('UW-03: failed preparation never triggers a download or reports success', async () => {
  for (const status of [400, 401, 404, 503]) {
    const h = harness({ fetchImpl: async () => ({ status, json: async () => ({ ok: false, message: '准备失败' }) }) });
    await assert.rejects(h.bridge.exportFiles({ ids: ['one'] }), /失败|过期/);
    assert.equal(h.clicks.length, 0);
    if (status === 401) assert.deepEqual(h.replacements, ['/login']);
  }
  const h = harness({ fetchImpl: async () => { throw new Error('offline'); } });
  await assert.rejects(h.bridge.exportFiles({ ids: ['one'] }));
  assert.equal(h.clicks.length, 0);
});

test('UW-02: HTTP and denied clipboard offer selectable text without claiming automatic success', async () => {
  for (const clipboard of [undefined, { writeText: async () => { throw new Error('denied'); } }]) {
    const h = harness({ clipboard });
    let settled = false;
    const pending = h.bridge.copyText('one\ntwo').then(result => { settled = true; return result; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    const text = h.nodes.find(node => node.tag === 'textarea');
    assert.equal(text.value, 'one\ntwo');
    assert.equal(text.selected, true);
    assert.equal(h.nodes.find(node => node.tag === 'dialog').open, true);
    h.nodes.find(node => node.textContent === '已手动复制').dispatch('click');
    assert.equal(await pending, true);
    assert.equal(h.previous.focused, true);
  }
});

test('UW-02: secure clipboard handles empty text and fallback cancel is not success', async () => {
  const copied = [];
  const secure = harness({ clipboard: { writeText: async text => copied.push(text) } });
  assert.equal(await secure.bridge.copyText(''), true);
  assert.deepEqual(copied, ['']);
  assert.equal(secure.nodes.length, 0);
  const fallback = harness();
  const pending = fallback.bridge.copyText('notes');
  await Promise.resolve();
  fallback.nodes.find(node => node.tag === 'dialog').dispatch('cancel');
  await assert.rejects(pending, /取消/);
});

test('Web TXT draft persistence forwards library-bound payloads to the host contract', async () => {
  const h = harness({ fetchImpl: async () => ({ status: 200, json: async () => ({ ok: true, result: { stored: true } }) }) });
  const data = { libraryPath: '/fixture', id: 'TXT', draftId: 'session', revision: 3, content: 'draft', base: { sha256: 'fixture' } };
  for (const [name, method] of [['putTextDraft', 'put'], ['getTextDraft', 'get'], ['listTextDrafts', 'list'], ['removeTextDraft', 'remove']]) {
    assert.equal((await h.bridge[name](data)).stored, true);
    const request = h.fetches.at(-1);
    assert.equal(request.url, '/rpc');
    assert.deepEqual(JSON.parse(request.options.body), { method: `text-draft:${method}`, args: [data] });
  }
});
