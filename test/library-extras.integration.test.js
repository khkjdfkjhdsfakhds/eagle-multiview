'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

test('reloading library extras keeps orders ready, survives a failed read, and ignores stale loads', { timeout: 30000 }, async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('../test-support/electron-binary.cjs'), ['--disable-logging', require.resolve('../test-support/library-extras-probe.cjs')], { env, timeout: 25000 });
  const line = stdout.split('\n').find(entry => entry.startsWith('EAGLEMV_LIBRARY_EXTRAS '));
  assert.ok(line, `missing library extras result: ${stdout}`);
  const result = JSON.parse(line.slice('EAGLEMV_LIBRARY_EXTRAS '.length));
  assert.equal(result.readyAtStart, true);
  assert.equal(result.readyDuringReload, true, 'manual orders stay usable while the same library reloads');
  assert.equal(result.pinsAfterFailure, result.pinsAtStart, 'a failed pin read keeps the pins on screen');
  assert.equal(result.colorsAfterReload, '{"red":"#ff0000"}');
  assert.equal(result.pinsAfterRace, '{"new":{"i":1}}', 'an older, slower load does not overwrite a newer one');
  assert.equal(result.readsForFourRequests, 2, 'requests during a load fold into one more read');
  assert.equal(result.colorsFromBroadcast, '{"blue":"#0000ff"}');
  assert.equal(result.readsForColorBroadcast, 0, 'a colour broadcast applies its own table');
});
