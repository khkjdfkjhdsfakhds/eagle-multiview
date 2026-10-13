'use strict';
// B4-02: app windows refuse every permission request except fullscreen and
// sanitized clipboard writes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { permissionAllowed, installPermissionPolicy } = require('../lib/permission-policy');

test('B4-02: only fullscreen and sanitized clipboard writes are granted', () => {
  assert.equal(permissionAllowed('fullscreen'), true);
  assert.equal(permissionAllowed('clipboard-sanitized-write'), true);
  for (const permission of ['media', 'geolocation', 'notifications', 'clipboard-read', 'openExternal', 'midi', 'pointerLock', 'unknown']) {
    assert.equal(permissionAllowed(permission), false, permission);
  }
  let handler = null;
  installPermissionPolicy({ setPermissionRequestHandler: fn => { handler = fn; } });
  const answers = [];
  handler(null, 'notifications', granted => answers.push(granted));
  handler(null, 'fullscreen', granted => answers.push(granted));
  assert.deepEqual(answers, [false, true]);
});

test('B4-02: the main process installs the policy before the first window', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const install = source.indexOf('installPermissionPolicy(session.defaultSession)');
  assert.ok(install > 0, 'policy installed on the default session');
  assert.ok(install < source.indexOf('createWindow(null);', install), 'before the first window opens');
});

test('B4-02: a real page is refused notifications and location', { timeout: 30000 }, async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('electron'), ['--disable-logging', require.resolve('../test-support/permission-policy-probe.cjs')], { env, timeout: 25000 });
  const line = stdout.split('\n').find(entry => entry.startsWith('EAGLEMV_PERMISSIONS '));
  assert.ok(line, `missing permission result: ${stdout}`);
  assert.deepEqual(JSON.parse(line.slice('EAGLEMV_PERMISSIONS '.length)), { notifications: 'denied', geolocation: 'denied' });
});
