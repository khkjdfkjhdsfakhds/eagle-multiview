'use strict';

// Eagle-parity batch 2: sidebar folders show Eagle's folder color as a dot
// on the icon and a lock badge for password folders; navigation into a
// locked folder is refused (the Eagle API cannot unlock them).

const test = require('node:test');
const assert = require('node:assert/strict');

// T-06: these used to be assertions on the source text, which a broken
// render (P6-01) passed; the probe now checks what the sidebar shows.
test('P6-01: folder colours, lock badges and the locked-folder guard in the real sidebar', { timeout: 30000 }, async () => {
  const { execFile } = require('node:child_process');
  const { promisify } = require('node:util');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('../test-support/electron-binary.cjs'), ['--disable-logging', require.resolve('../test-support/folder-color-probe.cjs')], { env, timeout: 25000 });
  const line = stdout.split('\n').find(entry => entry.startsWith('EAGLEMV_FOLDER_COLOR '));
  assert.ok(line, `missing folder colour result: ${stdout}`);
  const result = JSON.parse(line.slice('EAGLEMV_FOLDER_COLOR '.length));
  assert.match(result.value, /^#[0-9a-f]{6}$/);
  assert.equal(result.hex, '#123456');
  assert.equal(result.shortHex, '#abc', 'the legacy color field and short hex still work');
  for (const name of ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'pink', 'gray']) assert.match(result.named[name], /^#[0-9a-f]{6}$/, `named colour ${name}`);
  assert.equal(result.named.RED, result.named.red, 'named colours ignore case');
  assert.equal(result.named.teal, '', 'an unknown name shows no dot');
  assert.equal(result.named[''], '');
  assert.ok(result.dot, 'the sidebar row shows a colour dot');
  assert.ok(result.dotRows >= 2, 'the tree row and the quick-access row both show the dot');
  assert.equal(result.lockBadge, true, 'a password folder shows the lock badge');
  assert.equal(result.plainHasLock, false);
  assert.equal(result.entered, false, 'a locked folder cannot be entered');
  assert.equal(result.stayed, true);
  assert.equal(result.historyKept, true, 'the refused navigation leaves history alone');
  assert.match(result.toast, /已加密.*Eagle API 限制/);
});
