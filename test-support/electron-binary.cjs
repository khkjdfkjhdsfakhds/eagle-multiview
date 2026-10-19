'use strict';
// The Electron executable the probes run: what require('electron') returns,
// except on macOS, where it is a cached copy of Electron.app whose Info.plist
// says LSUIElement. An Electron process registers its Dock icon before any JS
// runs, so hiding it from the probe only shortens the flash; an accessory app
// never gets one. Tests require this instead of 'electron', so a plain
// `node --test` keeps the Dock quiet as well as `npm test`.
//
// The copy is an APFS clone (no extra disk) re-signed ad hoc, made once per
// Electron version under node_modules/.cache. Test files run in parallel
// processes, so it is built in a private directory and renamed into place.
// If preparing it fails, the stock Electron is used.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function accessoryElectronDist() {
  if (process.platform !== 'darwin' || process.env.ELECTRON_OVERRIDE_DIST_PATH) return null;
  try {
    const app = path.resolve(require('electron'), '..', '..', '..');
    if (path.basename(app) !== 'Electron.app') return null;
    const { version } = require('electron/package.json');
    const dist = path.join(root, 'node_modules', '.cache', 'eaglemv-test-electron', version);
    if (fs.existsSync(path.join(dist, '.ready'))) return dist;
    const staging = `${dist}.tmp-${process.pid}`;
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    const copy = path.join(staging, 'Electron.app');
    try { execFileSync('cp', ['-cR', app, copy]); }
    catch { fs.rmSync(copy, { recursive: true, force: true }); execFileSync('cp', ['-R', app, copy]); }
    execFileSync('plutil', ['-replace', 'LSUIElement', '-bool', 'YES', path.join(copy, 'Contents', 'Info.plist')]);
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', copy], { stdio: 'ignore' });
    fs.writeFileSync(path.join(staging, '.ready'), `${version}\n`);
    // A leftover without .ready is from an interrupted run; a ready one may
    // have just been renamed in by a parallel test file.
    if (fs.existsSync(dist) && !fs.existsSync(path.join(dist, '.ready'))) fs.rmSync(dist, { recursive: true, force: true });
    try { fs.renameSync(staging, dist); }
    catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      if (!fs.existsSync(path.join(dist, '.ready'))) throw error;
    }
    return dist;
  } catch (error) {
    console.warn(`[electron-binary] 未能准备无 Dock 图标的 Electron，改用原版：${error.message}`);
    return null;
  }
}

const dist = accessoryElectronDist();
// Child test runs and anything else that resolves 'electron' later get it too.
if (dist) process.env.ELECTRON_OVERRIDE_DIST_PATH = dist;
module.exports = dist
  ? path.join(dist, fs.readFileSync(require.resolve('electron/path.txt'), 'utf8'))
  : require('electron');
