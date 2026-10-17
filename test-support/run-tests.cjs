'use strict';
// `npm test`: node --test --test-force-exit, with the Electron probes kept out
// of the Dock. Extra arguments pass through, e.g.
//   npm test -- test/style-polish.integration.test.js
//
// On macOS an Electron process registers its Dock icon before any JS runs,
// so hiding it from the probe only shortens the flash. Instead the probes run
// a cached copy of Electron.app whose Info.plist says LSUIElement (an
// accessory app from the first instant), selected through the electron
// package's ELECTRON_OVERRIDE_DIST_PATH. The copy is an APFS clone (no extra
// disk) re-signed ad hoc, made once per Electron version under
// node_modules/.cache. If preparing it fails, the no-dock.cjs preload still
// hides the icon right after start.
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function accessoryElectronDist() {
  if (process.platform !== 'darwin' || process.env.ELECTRON_OVERRIDE_DIST_PATH) return null;
  try {
    const executable = require('electron');
    const app = path.resolve(executable, '..', '..', '..');
    if (path.basename(app) !== 'Electron.app') return null;
    const { version } = require('electron/package.json');
    const dist = path.join(root, 'node_modules', '.cache', 'eaglemv-test-electron', version);
    const ready = path.join(dist, '.ready');
    if (fs.existsSync(ready)) return dist;
    fs.rmSync(dist, { recursive: true, force: true });
    fs.mkdirSync(dist, { recursive: true });
    const copy = path.join(dist, 'Electron.app');
    try { execFileSync('cp', ['-cR', app, copy]); }
    catch { fs.rmSync(copy, { recursive: true, force: true }); execFileSync('cp', ['-R', app, copy]); }
    execFileSync('plutil', ['-replace', 'LSUIElement', '-bool', 'YES', path.join(copy, 'Contents', 'Info.plist')]);
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', copy], { stdio: 'ignore' });
    fs.writeFileSync(ready, `${version}\n`);
    return dist;
  } catch (error) {
    console.warn(`[run-tests] 未能准备无 Dock 图标的 Electron，改用启动后隐藏：${error.message}`);
    return null;
  }
}

const env = { ...process.env };
const dist = accessoryElectronDist();
if (dist) env.ELECTRON_OVERRIDE_DIST_PATH = dist;
// NODE_OPTIONS splits on spaces unless quoted; the project path has one.
const preload = path.join(__dirname, 'no-dock.cjs');
env.NODE_OPTIONS = [process.env.NODE_OPTIONS, `--require "${preload}"`].filter(Boolean).join(' ');

const child = spawn(process.execPath, ['--test', '--test-force-exit', ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('exit', (code, signal) => process.exit(signal ? 1 : code));
