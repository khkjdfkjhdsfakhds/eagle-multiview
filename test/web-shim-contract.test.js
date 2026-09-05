'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Drift guard for the web client: every window.eagleMV member the Electron
// preload exposes must exist in the web shim (and vice versa), every channel
// the shim calls must be registered and web-exposed in main.js, and the
// renderer must mint media addresses only through mediaURL().

const root = path.join(__dirname, '..');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const shim = fs.readFileSync(path.join(root, 'src', 'web-shim.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8');
const indexHTML = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');

function memberNames(source, opener, indent) {
  const start = source.indexOf(opener);
  assert.ok(start >= 0, `找不到 ${opener}`);
  const body = source.slice(start);
  const names = new Set();
  // Top-level object members at exactly the given indent (deeper levels are
  // nested objects like capabilities and must not count).
  const pattern = new RegExp(`^ {${indent}}(?! )([A-Za-z][A-Za-z0-9]*):`, 'gm');
  for (const match of body.matchAll(pattern)) names.add(match[1]);
  return names;
}

const preloadMembers = memberNames(preload, "contextBridge.exposeInMainWorld('eagleMV', {", 2);
const shimMembers = memberNames(shim, 'window.eagleMV = {', 4);

test('web shim implements exactly the preload surface', () => {
  const missing = [...preloadMembers].filter(name => !shimMembers.has(name));
  const extra = [...shimMembers].filter(name => !preloadMembers.has(name));
  assert.deepEqual(missing, [], `web-shim.js 缺少 preload 方法：${missing.join(', ')}`);
  assert.deepEqual(extra, [], `web-shim.js 多出 preload 没有的方法：${extra.join(', ')}`);
  // Guard against the extractor silently matching nothing.
  assert.ok(preloadMembers.size > 80, `提取到的 preload 成员过少（${preloadMembers.size}）`);
});

function registeredChannels() {
  const channels = new Set();
  for (const match of main.matchAll(/(?:handleRPC|onRPC)\('([^']+)'/g)) channels.add(match[1]);
  return channels;
}

function hostOnlyChannels() {
  const start = main.indexOf('const HOST_ONLY_CHANNELS = new Set([');
  assert.ok(start >= 0);
  const body = main.slice(start, main.indexOf(']);', start));
  return new Set([...body.matchAll(/'([^']+)'/g)].map(match => match[1]));
}

test('every channel the web shim calls is registered and web-exposed', () => {
  const registered = registeredChannels();
  const hostOnly = hostOnlyChannels();
  const shimChannels = [...shim.matchAll(/(?:invoke|send)\('([^']+)'/g)].map(match => match[1]);
  assert.ok(shimChannels.length > 40, `shim RPC 通道过少（${shimChannels.length}）`);
  for (const channel of shimChannels) {
    assert.ok(registered.has(channel), `shim 调用了未注册的通道：${channel}`);
    assert.ok(!hostOnly.has(channel), `shim 调用了 host-only 通道：${channel}`);
  }
});

test('host-only channels are all real registered channels', () => {
  const registered = registeredChannels();
  for (const channel of hostOnlyChannels()) {
    assert.ok(registered.has(channel), `HOST_ONLY_CHANNELS 引用了不存在的通道：${channel}`);
  }
});

test('registry helpers bridge to ipcMain instead of recursing', () => {
  // A blanket ipcMain→helper rename once turned these into self-calls that
  // blew the stack on the first registration.
  const helper = main.slice(main.indexOf('function handleRPC'), main.indexOf('async function invokeWebRPC'));
  assert.ok(helper.includes('ipcMain.handle(channel, handler);'));
  assert.ok(helper.includes('ipcMain.on(channel, handler);'));
  assert.ok(!/function handleRPC[^]*?handleRPC\(channel/.test(helper), 'handleRPC 不得自递归');
  assert.ok(!/function onRPC[^]*?onRPC\(channel/.test(helper), 'onRPC 不得自递归');
});

test('preload invoke channels not in the shim are declared host-only', () => {
  // Channels the desktop preload reaches over IPC but the shim replaces with
  // local behavior must be fenced off from the web RPC endpoint. hub:identity
  // is the one deliberate exception: the shim answers it locally with the
  // WebSocket-assigned client id, while the RPC channel stays harmless.
  const locallyBridged = new Set(['hub:identity']);
  const hostOnly = hostOnlyChannels();
  const shimChannels = new Set([...shim.matchAll(/(?:invoke|send)\('([^']+)'/g)].map(match => match[1]));
  const preloadChannels = [...preload.matchAll(/ipcRenderer\.(?:invoke|send)\('([^']+)'/g)].map(match => match[1]);
  for (const channel of preloadChannels) {
    assert.ok(shimChannels.has(channel) || hostOnly.has(channel) || locallyBridged.has(channel),
      `通道 ${channel}：既没有被 web shim 桥接，也没有声明为 host-only——新增 IPC 时必须二选一`);
  }
});

test('capability tables agree between preload and the shim', () => {
  const extract = source => {
    const start = source.indexOf('capabilities: {');
    assert.ok(start >= 0);
    const body = source.slice(start, source.indexOf('}', start));
    return [...body.matchAll(/([A-Za-z][A-Za-z0-9]*):\s*(true|false)/g)];
  };
  const preloadCapabilities = extract(preload);
  const shimCapabilities = extract(shim);
  assert.deepEqual(shimCapabilities.map(match => match[1]).sort(), preloadCapabilities.map(match => match[1]).sort());
  assert.ok(preloadCapabilities.every(match => match[2] === 'true'), '桌面版能力应全为 true');
  // importLocal is true on the web too: imports go through the /upload
  // pipeline (file picker, drops, pastes) instead of host paths.
  const webTrueAllowed = new Set(['importLocal', 'export', 'customThumbnail']);
  for (const [, name, value] of shimCapabilities) {
    assert.equal(value === 'true', webTrueAllowed.has(name), `web 能力 ${name} 期望 ${webTrueAllowed.has(name) ? 'true' : 'false'}`);
  }
  assert.ok(preloadCapabilities.length >= 10);
});

test('renderer mints media addresses only through mediaURL()', () => {
  assert.ok(!/["'`]eaglemv:\/\/|src="eaglemv:/.test(renderer), 'renderer 不应再出现 eaglemv:// 字符串字面量');
  assert.ok(renderer.includes("const mediaURL = (kind, id) => window.eagleMV.mediaURL(kind, id)"));
  assert.ok(preload.includes('eaglemv://${kind}/'), 'preload 铸造协议地址');
  assert.ok(shim.includes('/media/'), 'shim 铸造同源媒体地址');
});

test('desktop index.html never loads the web shim directly', () => {
  assert.ok(!indexHTML.includes('web-shim'), 'web-shim 只能由 web 服务器注入');
  assert.ok(shim.includes('if (window.eagleMV) return;'), 'shim 对桌面 preload 让位');
});

test('renderer guards host-bound entry points behind capabilities', () => {
  for (const anchor of [
    "hasCapability('nativeDrag')",
    "hasCapability('finder')",
    "hasCapability('openDefault')",
    "hasCapability('clipboardFiles')",
    "hasCapability('copyPath')",
    "hasCapability('importLocal')",
    "hasCapability('export')",
    "hasCapability('share')",
    "hasCapability('openOther')",
    "hasCapability('webAccess')"
  ]) {
    assert.ok(renderer.includes(anchor), `renderer 缺少能力守卫：${anchor}`);
  }
  assert.ok(renderer.includes("hideWithout('customThumbnail', '#customThumbnailButton')"));
});

test('websocket recovery probes the read-only session health endpoint without replaying RPC writes', () => {
  assert.ok(shim.includes("fetch('/health/session', {"));
  assert.ok(shim.includes("method: 'GET'"));
  assert.ok(!shim.includes("fetch('/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })"));
  assert.ok(shim.includes('let reconnectTimer = null;'));
  assert.ok(shim.includes('let healthProbe = null;'));
  assert.ok(shim.includes("window.addEventListener('online'"));
  assert.ok(shim.includes("window.addEventListener('pagehide'"));
});
