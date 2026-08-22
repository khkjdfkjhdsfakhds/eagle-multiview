'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');
const { assertCleanElectronStderr } = require('../test-support/electron-stderr.cjs');

const execFileAsync = promisify(execFile);

test('path bar: the web client grows the breadcrumb to the title size; the desktop stays small', { timeout: 20000 }, async () => {
  const electron = require('electron');
  const runner = require.resolve('../test-support/path-bar-probe.cjs');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout, stderr } = await execFileAsync(electron, ['--disable-logging', runner], { env, timeout: 18000 });
  assertCleanElectronStderr(assert, stderr, 'path bar runner');
  const line = stdout.split('\n').find(entry => entry.startsWith('EAGLEMV_PATHBAR '));
  assert.ok(line, `missing path bar result: ${stdout}`);
  const result = JSON.parse(line.slice('EAGLEMV_PATHBAR '.length));
  // Desktop keeps the compact breadcrumb.
  assert.equal(result.desktop.crumbFont, 9, 'desktop breadcrumb stays at 9px');
  assert.equal(result.desktop.crumbHeight, 18, 'desktop breadcrumb row stays 18px tall');
  // Web client enlarges the breadcrumb to match the view title.
  assert.equal(result.web.crumbFont, result.web.titleFont, 'web breadcrumb font equals the view title');
  assert.ok(result.web.crumbFont > result.desktop.crumbFont, 'web breadcrumb is larger than desktop');
  assert.ok(result.web.crumbHeight > result.desktop.crumbHeight, 'web breadcrumb row is taller for a touch target');
});

test('path bar enlargement lives outside the 900px phone media gate so it applies on wide tablets too', () => {
  const styles = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8');
  // The enlargement block must sit in a top-level body.web-client rule (not
  // inside @media (max-width: 900px)), so wide web clients also get a touch target.
  const topLevel = styles.match(/body\.web-client \.content-pane \.heading-path-row \.breadcrumb\s*\{[^}]*font-size:\s*14px[^}]*\}/s);
  assert.ok(topLevel, 'there is a top-level body.web-client breadcrumb enlargement rule');
  assert.ok(topLevel[0].includes('font-size: 14px'), 'enlarged breadcrumb font-size matches the title');
});
