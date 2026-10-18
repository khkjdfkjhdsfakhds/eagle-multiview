'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { DataHub } = require('../lib/data-hub');

test('H-02: every hub process stamps its snapshots with its own instance id', async () => {
  const fake = () => ({ appInfo: async () => ({}), libraryInfo: async () => ({ path: '/L.library' }), folderTree: async () => [] });
  const first = new DataHub(fake()), second = new DataHub(fake());
  assert.ok(first.instanceId && first.instanceId !== second.instanceId);
  const events = [];
  first.on('library-changed', payload => events.push(payload));
  const connected = await first.connect({ notify: true });
  assert.equal(events[0].hubInstance, first.instanceId);
  assert.equal(connected.hubInstance, first.instanceId);
  assert.equal(connected.revision, events[0].revision);
});

test('H-02: a page that outlived a host restart applies the restarted host snapshots', { timeout: 30000 }, async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('../test-support/electron-binary.cjs'), ['--disable-logging', require.resolve('../test-support/hub-restart-probe.cjs')], { env, timeout: 25000 });
  const line = stdout.split('\n').find(entry => entry.startsWith('EAGLEMV_HUB_RESTART '));
  assert.ok(line, `missing hub restart result: ${stdout}`);
  assert.deepEqual(JSON.parse(line.slice('EAGLEMV_HUB_RESTART '.length)), { first: true, staleIgnored: true, restarted: true });
});
