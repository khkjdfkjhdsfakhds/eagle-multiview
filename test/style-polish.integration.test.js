'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8');

test('styles define the colours they use and drop the dead toolbar rules (P7-32, P7-33)', () => {
  const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map(match => match[1]));
  const used = new Set([...css.matchAll(/var\((--[\w-]+)/g)].map(match => match[1]));
  // Custom properties set inline by the renderer.
  const runtime = ['--thumb', '--tag-color', '--depth', '--item-aspect', '--metadata-zoom', '--folder-color', '--sidebar-width', '--inspector-width', '--stack-index'];
  const missing = [...used].filter(name => !defined.has(name) && !runtime.includes(name) && !new RegExp('var\\(' + name + ',').test(css));
  assert.deepEqual(missing, []);
  for (const dead of ['.new-window-main', '.new-window-menu-button', '.sort-dir-button', '.mini-button', '.toolbar-spacer', '#newWindowButton']) {
    assert.ok(!css.includes(dead), dead + ' is still styled');
  }
  assert.match(css, /\.danger-button:hover/);
  assert.doesNotMatch(css, /#8f9acd/, 'the purple tag-remove colour is gone');
});

test('real renderer: 10px floor, 4.5:1 secondary text, keyboard ring, 24px hit box, reduced motion', { timeout: 30000 }, async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('../test-support/electron-binary.cjs'), ['--disable-logging', require.resolve('../test-support/style-polish-probe.cjs')], { env, timeout: 25000, maxBuffer: 4 * 1024 * 1024 });
  assert.match(stdout, /STYLE_POLISH_OK/);
});
