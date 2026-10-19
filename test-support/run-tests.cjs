'use strict';
// `npm test`: node --test --test-force-exit, with the Electron probes kept out
// of the Dock. Extra arguments pass through, e.g.
//   npm test -- test/style-polish.integration.test.js
//
// Probes run the LSUIElement copy of Electron.app that electron-binary.cjs
// prepares (it also sets ELECTRON_OVERRIDE_DIST_PATH, inherited here), so a
// full run puts no Dock icon up. If preparing it fails, the no-dock.cjs
// preload still hides the icon right after start.
const { spawn } = require('node:child_process');
const path = require('node:path');

require('./electron-binary.cjs');

const env = { ...process.env };
// NODE_OPTIONS splits on spaces unless quoted; the project path has one.
const preload = path.join(__dirname, 'no-dock.cjs');
env.NODE_OPTIONS = [process.env.NODE_OPTIONS, `--require "${preload}"`].filter(Boolean).join(' ');

const child = spawn(process.execPath, ['--test', '--test-force-exit', ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('exit', (code, signal) => process.exit(signal ? 1 : code));
