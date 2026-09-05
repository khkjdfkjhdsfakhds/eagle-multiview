'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createTextPluginBridge } = require('../lib/text-plugin-bridge');
const candidateIdentity = require('./candidate-identity.cjs');

const pluginPath = path.resolve(__dirname, '../eagle-plugin/text-save-service');
const entry = fs.readFileSync(path.join(pluginPath, 'plugin.js'), 'utf8');

// Match Eagle's public loader contract: its wrapper delegates relative modules
// to the SDK module, not the plugin script. The optional installed-source test
// supplies the first-party wrapper unchanged rather than copying it here.
const loaderContract = `global.require = args => {
  if (args === 'electron') return {};
  if (args === 'fs' || args === 'original-fs') return require('fs');
  const modulePath = eagle?.plugin?.path + '/node_modules/' + args;
  if (eagle?.plugin?.path && require('fs').existsSync(modulePath)) return require(modulePath);
  return require(args);
};`;

async function waitFor(predicate, message = 'Plugin entry did not become ready') {
  const deadline = Date.now() + 4000;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function fixture(t, { wrapper = loaderContract, initialPath = true, interceptRequire } = {}) {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'eaglemv-plugin-entry-')));
  const profile = path.join(root, 'Library', 'Application Support', candidateIdentity.profile);
  const stagingRoot = path.join(profile, 'Text Backups', 'staging');
  const directory = path.join(profile, 'TXT Bridge');
  const libraryPath = path.join(root, 'Synthetic.library');
  const filePath = path.join(libraryPath, 'images', 'ENTRY.info', 'entry.txt');
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.mkdir(stagingRoot, { recursive: true });
  await fsp.writeFile(filePath, 'original');
  let bridge = createTextPluginBridge({ directory, stagingRoot, timeoutMs: 3000 });
  await bridge.start();
  const callbacks = {};
  const events = {};
  const errors = [];
  let replacements = 0;
  const item = { id: 'ENTRY', ext: 'txt', filePath, replaceFile: async staged => {
    if (!staged.startsWith(`${stagingRoot}${path.sep}`)) throw new Error('Fixture staging boundary');
    replacements++;
    await fsp.copyFile(staged, filePath);
  } };
  const eagle = {
    plugin: initialPath ? { path: pluginPath } : undefined,
    library: { path: libraryPath }, item: { getById: async id => id === item.id ? item : null },
    onPluginCreate: callback => { callbacks.create = callback; },
    log: { error: value => errors.push(value) }
  };
  const timers = new Set();
  const hostRequire = createRequire(path.join(root, 'Eagle.app', 'app', 'js', 'plugin', 'api.js'));
  const lexicalRequire = name => {
    if (interceptRequire) {
      const intercepted = interceptRequire(name);
      if (intercepted !== undefined) return intercepted;
    }
    if (name === 'node:os') return { homedir: () => root };
    return hostRequire(name);
  };
  const context = vm.createContext({
    eagle, lexicalRequire, Buffer, TextDecoder,
    console: { error: (...args) => errors.push(args), log() {} },
    window: { addEventListener: (name, callback) => { events[name] = callback; } },
    setTimeout: (callback, delay) => {
      const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay);
      timers.add(timer);
      return timer;
    },
    clearTimeout: timer => { timers.delete(timer); clearTimeout(timer); }
  });
  context.global = context;
  vm.runInContext(`(function(require) { ${wrapper}\n})(lexicalRequire);`, context);
  t.after(async () => {
    events.beforeunload?.();
    for (const timer of timers) clearTimeout(timer);
    await bridge.stop();
    await fsp.rm(root, { recursive: true, force: true });
  });
  return {
    root, profile, stagingRoot, directory, libraryPath, filePath, item, eagle, errors,
    get bridge() { return bridge; },
    restartBridge: async () => {
      await bridge.stop();
      bridge = createTextPluginBridge({ directory, stagingRoot, timeoutMs: 3000 });
      await bridge.start();
    },
    load: () => vm.runInContext(entry, context, { filename: 'Eagle TXT plugin.js' }),
    create: (plugin = { path: pluginPath }) => { eagle.plugin = plugin; return callbacks.create?.(plugin); },
    unload: () => events.beforeunload?.(),
    get registered() { return typeof callbacks.create === 'function'; },
    get replacements() { return replacements; },
    get timerCount() { return timers.size; }
  };
}

module.exports = { fixture, waitFor };
