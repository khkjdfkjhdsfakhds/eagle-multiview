'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');

test('a change left pending by a failed sync gets its own timer (H-06)', () => {
  const drain = renderer.match(/async function drainLibraryChanges\(\) \{[\s\S]*?\n\}/)[0];
  assert.match(drain, /const leftover = pendingLibraryChange;\s*pendingLibraryChange = null;\s*if \(leftover\) scheduleLibraryChange\(leftover\);/);
});

test('startup retries only the connection, on one chained timer (H-05)', () => {
  const start = renderer.slice(renderer.indexOf('let connection;'), renderer.indexOf('async function finishStartup'));
  assert.doesNotMatch(start, /setInterval/);
  assert.match(start, /const retry = \(\) => setTimeout\(/);
  assert.match(renderer, /async function finishStartup\(\{ app, library, hubInstance \}\)/);
});

test('own TXT saves and a reconnecting web client are recognised as this window (H-07, H-09)', () => {
  assert.match(renderer, /JSON\.stringify\(payload\.fingerprint\) === JSON\.stringify\(session\.fingerprint\)\) continue;/);
  assert.match(renderer, /onIdentityChanged\?\.\(windowId => \{ if \(windowId\) state\.windowId = windowId; \}\)/);
});

test('real renderer: Cmd+0 actual size, recent search, slideshow select, F2 on a folder card', { timeout: 30000 }, async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('../test-support/electron-binary.cjs'), ['--disable-logging', require.resolve('../test-support/renderer-polish-probe.cjs')], { env, timeout: 25000, maxBuffer: 4 * 1024 * 1024 });
  assert.match(stdout, /RENDERER_POLISH_OK/);
});
