'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');
const { assertCleanElectronStderr } = require('../test-support/electron-stderr.cjs');

const execFileAsync = promisify(execFile);

test('zoom feedback: list rows follow --thumb and the size readout badge appears then auto-hides', { timeout: 20000 }, async () => {
  const electron = require('electron');
  const runner = require.resolve('../test-support/zoom-feedback-probe.cjs');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout, stderr } = await execFileAsync(electron, ['--disable-logging', runner], { env, timeout: 18000 });
  assertCleanElectronStderr(assert, stderr, 'zoom feedback runner');
  const line = stdout.split('\n').find(entry => entry.startsWith('EAGLEMV_ZOOM_FEEDBACK '));
  assert.ok(line, `missing zoom feedback result: ${stdout}`);
  const result = JSON.parse(line.slice('EAGLEMV_ZOOM_FEEDBACK '.length));
  assert.equal(result.defaultWidth, 42, 'list thumb is 42px at the default --thumb');
  assert.equal(result.grownWidth, 55, 'list thumb grows with --thumb (220px -> 55px)');
  assert.equal(result.afterPlus.thumb, 180, 'Cmd+plus grows the thumb');
  assert.equal(result.afterPlus.badgeVisible, true, 'Cmd+plus shows the size readout');
  assert.equal(result.afterReset.thumb, 168, 'Cmd+0 resets to the default');
  assert.equal(result.afterReset.badgeVisible, true, 'Cmd+0 shows the size readout');
  assert.equal(result.autoHidden, true, 'the readout badge auto-hides after inactivity');
});

test('list view reuses --thumb instead of a fixed 42px thumbnail', () => {
  const styles = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8');
  assert.ok(styles.includes('calc(var(--thumb) * 0.25)'), 'list rows/thumbnails scale with --thumb');
  assert.ok(!/asset-grid\.list \.item-card \{[^}]*grid-template-columns: 42px/.test(styles), 'no hard-coded 42px list column');
});
