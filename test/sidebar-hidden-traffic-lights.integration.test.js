'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

test('collapsed desktop sidebar keeps the toolbar clear of macOS traffic lights at every desktop width', { timeout: 60000 }, async () => {
  const electron = require('electron');
  const runner = require.resolve('../test-support/sidebar-hidden-traffic-lights-probe.cjs');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await execFileAsync(electron, ['--disable-logging', runner], { env, timeout: 50000 });
  const line = stdout.split('\n').find(entry => entry.startsWith('EAGLEMV_SIDEBAR_HIDDEN '));
  assert.ok(line, `missing sidebar-hidden probe result: ${stdout}`);
  const results = JSON.parse(line.slice('EAGLEMV_SIDEBAR_HIDDEN '.length));

  for (const result of results) {
    assert.equal(result.sidebarHidden, true, `${result.width}px did not collapse the sidebar`);
    assert.ok(result.searchLeft >= 80, `${result.width}px search starts at ${result.searchLeft}px and overlaps the macOS traffic lights`);
  }
});
