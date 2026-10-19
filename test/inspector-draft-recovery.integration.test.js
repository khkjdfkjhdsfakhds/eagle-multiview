'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

test('inspector draft copies are moved on recovery, skipped when already saved, and can be discarded', { timeout: 30000 }, async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('../test-support/electron-binary.cjs'), ['--disable-logging', require.resolve('../test-support/inspector-draft-recovery-probe.cjs')], { env, timeout: 25000 });
  const line = stdout.split('\n').find(entry => entry.startsWith('EAGLEMV_DRAFT_RECOVERY '));
  assert.ok(line, `missing draft recovery result: ${stdout}`);
  const result = JSON.parse(line.slice('EAGLEMV_DRAFT_RECOVERY '.length));
  assert.equal(result.offered, true);
  assert.equal(result.recovered, 'draft from closed window');
  assert.equal(result.sourceKept, false, 'recovering moves the copy instead of leaving the source to be offered again');
  assert.equal(result.obsoleteOffered, false, 'a copy that matches Eagle is not offered');
  assert.equal(result.obsoleteKept, false, 'and is cleared');
  assert.equal(result.hasDiscard, true, 'the banner offers 丢弃');
  assert.equal(result.discardOffered, true);
  assert.equal(result.discardKept, false);
  assert.equal(result.discardBannerHidden, true);
  assert.equal(result.discardAnnotation, 'eagle note', 'discarding leaves the inspector on Eagle’s values');
});
