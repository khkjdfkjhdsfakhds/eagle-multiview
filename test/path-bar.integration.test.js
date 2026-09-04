'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');
const { assertCleanElectronStderr } = require('../test-support/electron-stderr.cjs');

const execFileAsync = promisify(execFile);

test('path bar: the breadcrumb grows to the title size on desktop and web client alike', { timeout: 20000 }, async () => {
  const electron = require('electron');
  const runner = require.resolve('../test-support/path-bar-probe.cjs');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout, stderr } = await execFileAsync(electron, ['--disable-logging', runner], { env, timeout: 18000 });
  assertCleanElectronStderr(assert, stderr, 'path bar runner');
  const line = stdout.split('\n').find(entry => entry.startsWith('EAGLEMV_PATHBAR '));
  assert.ok(line, `missing path bar result: ${stdout}`);
  const result = JSON.parse(line.slice('EAGLEMV_PATHBAR '.length));
  // Both the desktop and the web client enlarge the breadcrumb to the title size.
  assert.equal(result.desktop.crumbFont, result.desktop.titleFont, 'desktop breadcrumb font equals the view title');
  assert.equal(result.web.crumbFont, result.web.titleFont, 'web breadcrumb font equals the view title');
  assert.ok(result.desktop.crumbFont > 9, 'desktop breadcrumb is no longer the tiny 9px size');
  assert.ok(result.desktop.crumbHeight >= 24, 'desktop breadcrumb row is tall enough to read');
  assert.ok(result.web.crumbHeight >= 24, 'web breadcrumb row is tall enough to read');
});

test('path bar enlargement applies universally, outside the 900px phone media gate', () => {
  const styles = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8');
  // The enlargement block must sit in a top-level universal rule (not inside
  // @media (max-width: 900px)), so desktop and wide web clients both get it.
  const topLevel = styles.match(/\.content-pane \.heading-path-row \.breadcrumb\s*\{[^}]*font-size:\s*14px[^}]*\}/s);
  assert.ok(topLevel, 'there is a top-level universal breadcrumb enlargement rule');
  assert.ok(topLevel[0].includes('font-size: 14px'), 'enlarged breadcrumb font-size matches the title');
});
