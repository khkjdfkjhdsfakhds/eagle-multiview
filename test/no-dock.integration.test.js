'use strict';
// `npm test` preloads test-support/no-dock.cjs so Electron probes run as
// accessory apps: no Dock icon per probe during a full run.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const root = path.join(__dirname, '..');

test('npm test runs node --test through the no-Dock runner', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.test, 'node test-support/run-tests.cjs');
  const runner = fs.readFileSync(path.join(root, 'test-support', 'run-tests.cjs'), 'utf8');
  assert.match(runner, /'--test', '--test-force-exit'/);
  assert.match(runner, /--require "\$\{preload\}"/, 'the preload path is quoted: the project path contains a space');
  assert.match(runner, /'LSUIElement', '-bool', 'YES'/);
  assert.match(runner, /env\.ELECTRON_OVERRIDE_DIST_PATH = dist;/);
});

// Hiding the icon from JS only shortens the flash: the Dock entry is made
// before any script runs. Under npm test the probes use an Electron.app copy
// marked LSUIElement, so there is no entry at all.
test('under npm test the probes run an Electron marked LSUIElement', { skip: (process.platform !== 'darwin' || !process.env.ELECTRON_OVERRIDE_DIST_PATH) && 'only under npm test on macOS' }, () => {
  const app = path.resolve(require('electron'), '..', '..', '..');
  const value = require('node:child_process').execFileSync('plutil', ['-extract', 'LSUIElement', 'raw', path.join(app, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();
  assert.equal(value, 'true');
});

test('an Electron probe started with the preload shows no Dock icon', { skip: process.platform !== 'darwin' && 'Dock is macOS only', timeout: 30000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-no-dock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'probe.cjs');
  fs.writeFileSync(script, `const { app } = require('electron');
app.setPath('userData', ${JSON.stringify(path.join(dir, 'data'))});
app.whenReady().then(() => { console.log('DOCK_VISIBLE=' + app.dock.isVisible()); app.quit(); });`);
  const env = { ...process.env, NODE_OPTIONS: `--require "${path.join(root, 'test-support', 'no-dock.cjs')}"` };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('electron'), ['--disable-logging', script], { env, timeout: 25000 });
  assert.match(stdout, /DOCK_VISIBLE=false/);
});
